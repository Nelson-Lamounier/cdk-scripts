#!/usr/bin/env npx tsx
/**
 * CloudFormation Import Rescue — Pre-Deploy Safety Net
 *
 * Detects stacks stuck in UPDATE_ROLLBACK_COMPLETE with orphaned resources
 * (resources that were CREATE'd during a failed update, then left behind
 * by the rollback). Imports them via `cdk import` so the next deploy
 * can proceed cleanly.
 *
 * Runs as a pre-deploy step — if the stack is healthy, exits 0 immediately.
 *
 * Supported resource types:
 *   - AWS::EC2::SecurityGroup (lookup by GroupName)
 *
 * Usage:
 *   npx tsx infra/scripts/ci/cfn-import-rescue.ts Base-development kubernetes development \
 *     --region eu-west-1
 *
 * Exit codes:
 *   0 = no rescue needed, or rescue succeeded
 *   1 = rescue attempted but failed (blocks deployment)
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { parseArgs } from 'util';

import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  type StackEvent,
} from '@aws-sdk/client-cloudformation';
import {
  EC2Client,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { emitAnnotation, writeSummary } from '../utils/github.js';
import logger from '../utils/logger.js';

import { runCdk, getCdkProjectRoot } from '../shared/exec.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    region: {
      type: 'string',
      default: process.env.AWS_REGION ?? 'eu-west-1',
    },
  },
});

const [stackName, projectId, environment] = positionals as [
  string,
  string,
  string,
];
const region = values.region!;

if (!stackName || !projectId || !environment) {
  console.error(
    'Usage: cfn-import-rescue.ts <stack-name> <project> <environment> [--region <region>]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stack statuses that indicate a rollback-stuck state requiring rescue. */
const RESCUABLE_STATUSES = [
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
];

/** Resource types we know how to look up physical IDs for. */
const SUPPORTED_RESOURCE_TYPES: Record<string, string> = {
  'AWS::EC2::SecurityGroup': 'GroupId',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrphanedResource {
  /** CloudFormation logical resource ID (e.g. K8sControlPlaneSg8E8E29E8) */
  logicalId: string;
  /** CloudFormation resource type (e.g. AWS::EC2::SecurityGroup) */
  resourceType: string;
  /** The status reason from the failed event */
  reason: string;
  /** Physical resource ID once resolved */
  physicalId?: string;
}

// ---------------------------------------------------------------------------
// 1. Check stack status
// ---------------------------------------------------------------------------

/**
 * Check if the stack is in a rescuable state.
 * Returns the stack status, or null if the stack doesn't exist.
 */
async function getStackStatus(
  cfn: CloudFormationClient,
): Promise<string | null> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    return response.Stacks?.[0]?.StackStatus ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Find orphaned resources from stack events
// ---------------------------------------------------------------------------

/**
 * Scan recent stack events for CREATE_FAILED with "already exists" messages.
 * These indicate resources that were orphaned during a rollback.
 */
async function findOrphanedResources(
  cfn: CloudFormationClient,
): Promise<OrphanedResource[]> {
  const orphaned: OrphanedResource[] = [];
  const seen = new Set<string>();

  let nextToken: string | undefined;

  // Paginate through all events (most recent first)
  do {
    const response = await cfn.send(
      new DescribeStackEventsCommand({
        StackName: stackName,
        NextToken: nextToken,
      }),
    );

    for (const event of response.StackEvents ?? []) {
      if (isOrphanedCreateEvent(event) && !seen.has(event.LogicalResourceId!)) {
        seen.add(event.LogicalResourceId!);
        orphaned.push({
          logicalId: event.LogicalResourceId!,
          resourceType: event.ResourceType!,
          reason: event.ResourceStatusReason ?? '',
        });
      }
    }

    nextToken = response.NextToken;

    // Limit pagination — only look at recent events (first 200)
    if (orphaned.length > 0 && !nextToken) break;
  } while (nextToken);

  return orphaned;
}

/**
 * Determine if a stack event represents an orphaned resource.
 *
 * Matches: CREATE_FAILED with "already exists" in the reason,
 * for resource types we can resolve.
 */
function isOrphanedCreateEvent(event: StackEvent): boolean {
  if (event.ResourceStatus !== 'CREATE_FAILED') return false;
  if (!event.LogicalResourceId || !event.ResourceType) return false;
  if (!SUPPORTED_RESOURCE_TYPES[event.ResourceType]) return false;

  const reason = (event.ResourceStatusReason ?? '').toLowerCase();
  return reason.includes('already exists');
}

// ---------------------------------------------------------------------------
// 3. Resolve physical resource IDs
// ---------------------------------------------------------------------------

/**
 * Look up the physical ID for an orphaned EC2 Security Group by extracting
 * the group name from the CloudFormation event reason message.
 */
async function resolveSecurityGroupId(
  ec2: EC2Client,
  resource: OrphanedResource,
): Promise<string | undefined> {
  // Extract the SG name from the reason.
  // Pattern: "Security Group with <name> already exists"
  const match = resource.reason.match(
    /Security Group with (.+?) already exists/i,
  );
  if (!match) return undefined;

  const sgName = match[1];

  try {
    const response = await ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: [sgName] }],
      }),
    );

    const sg = response.SecurityGroups?.[0];
    return sg?.GroupId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not look up SG "${sgName}": ${message}`);
    return undefined;
  }
}

/**
 * Resolve physical IDs for all orphaned resources.
 */
async function resolvePhysicalIds(
  ec2: EC2Client,
  resources: OrphanedResource[],
): Promise<void> {
  for (const resource of resources) {
    switch (resource.resourceType) {
      case 'AWS::EC2::SecurityGroup':
        resource.physicalId = await resolveSecurityGroupId(ec2, resource);
        break;
      default:
        logger.warn(
          `Unsupported resource type for import: ${resource.resourceType}`,
        );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Write resource mapping and run cdk import
// ---------------------------------------------------------------------------

/**
 * Build and write the cdk import resource mapping file.
 *
 * Format:
 * ```json
 * {
 *   "LogicalId": { "GroupId": "sg-xxx" }
 * }
 * ```
 */
async function writeResourceMapping(
  resources: OrphanedResource[],
): Promise<string> {
  const mapping: Record<string, Record<string, string>> = {};

  for (const resource of resources) {
    if (!resource.physicalId) continue;

    const idKey = SUPPORTED_RESOURCE_TYPES[resource.resourceType];
    if (!idKey) continue;

    mapping[resource.logicalId] = { [idKey]: resource.physicalId };
  }

  const cdkOutDir = join(getCdkProjectRoot(), 'cdk.out');
  await mkdir(cdkOutDir, { recursive: true });
  const mappingPath = join(cdkOutDir, 'cfn-import-map.json');
  await writeFile(mappingPath, JSON.stringify(mapping, null, 2));

  return mappingPath;
}

/**
 * Run `cdk import` to adopt orphaned resources into the stack.
 */
async function runCdkImport(mappingPath: string): Promise<boolean> {
  const args = [
    'import',
    stackName,
    '--resource-mapping',
    mappingPath,
    '--force',
    '-c',
    `project=${projectId}`,
    '-c',
    `environment=${environment}`,
  ];

  logger.info(`Running: npx cdk ${args.join(' ')}`);

  const result = await runCdk(args);
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// 5. Build GitHub Step Summary
// ---------------------------------------------------------------------------

function buildSummary(
  status: string,
  resources: OrphanedResource[],
  importSucceeded: boolean | null,
): string {
  const lines: string[] = [
    '## 🔧 CloudFormation Import Rescue',
    '',
    `**Stack**: \`${stackName}\``,
    `**Status**: \`${status}\``,
    '',
  ];

  if (resources.length === 0) {
    lines.push('✅ No orphaned resources detected — no rescue needed.');
    return lines.join('\n');
  }

  lines.push(
    `Found **${resources.length}** orphaned resource(s) to import:`,
    '',
    '| Logical ID | Type | Physical ID |',
    '|------------|------|-------------|',
  );

  for (const r of resources) {
    lines.push(
      `| \`${r.logicalId}\` | \`${r.resourceType}\` | \`${r.physicalId ?? 'unresolved'}\` |`,
    );
  }

  lines.push('');

  if (importSucceeded === true) {
    lines.push('✅ **Import succeeded** — stack is ready for deployment.');
  } else if (importSucceeded === false) {
    lines.push(
      '❌ **Import failed** — manual intervention required. See logs above.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`CloudFormation Import Rescue — ${stackName}`);

  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  // 1. Check stack status
  logger.task('Checking stack status...');
  const status = await getStackStatus(cfn);

  if (!status) {
    logger.info('Stack does not exist — skipping rescue.');
    return;
  }

  logger.keyValue('Stack status', status);

  if (!RESCUABLE_STATUSES.includes(status)) {
    logger.success(
      `Stack is in ${status} — no rescue needed.`,
    );
    return;
  }

  logger.warn(`Stack is in ${status} — scanning for orphaned resources...`);

  // 2. Find orphaned resources
  logger.task('Scanning stack events for orphaned resources...');
  let orphaned: OrphanedResource[];
  try {
    orphaned = await findOrphanedResources(cfn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not scan stack events: ${message}`);
    logger.info(
      'This is likely due to a large number of stack events exceeding the XML parser limit. ' +
      'Skipping rescue — deployment will proceed and may self-heal.',
    );
    writeSummary(buildSummary(status, [], null));
    return;
  }

  if (orphaned.length === 0) {
    logger.info('No orphaned resources found in stack events.');
    writeSummary(buildSummary(status, orphaned, null));
    return;
  }

  logger.info(`Found ${orphaned.length} orphaned resource(s):`);
  for (const r of orphaned) {
    logger.listItem(`${r.logicalId} (${r.resourceType})`);
  }

  // 3. Resolve physical IDs
  logger.task('Resolving physical resource IDs...');
  await resolvePhysicalIds(ec2, orphaned);

  const resolved = orphaned.filter((r) => r.physicalId);
  const unresolved = orphaned.filter((r) => !r.physicalId);

  for (const r of resolved) {
    logger.success(`${r.logicalId} → ${r.physicalId}`);
  }
  for (const r of unresolved) {
    logger.warn(`${r.logicalId} — could not resolve physical ID`);
  }

  if (resolved.length === 0) {
    logger.error('No resources could be resolved — cannot proceed with import.');
    writeSummary(buildSummary(status, orphaned, false));
    emitAnnotation(
      'error',
      `Stack ${stackName} has orphaned resources but physical IDs could not be resolved`,
    );
    process.exit(1);
  }

  // 4. Write mapping and run import
  logger.task('Writing resource mapping...');
  const mappingPath = await writeResourceMapping(resolved);
  logger.success(`Wrote mapping to ${mappingPath}`);

  logger.task('Running cdk import...');
  const importSucceeded = await runCdkImport(mappingPath);

  // 5. Write summary
  writeSummary(buildSummary(status, orphaned, importSucceeded));

  if (!importSucceeded) {
    logger.error('cdk import failed — deployment will be blocked.');
    emitAnnotation(
      'error',
      `Stack ${stackName}: cdk import failed for orphaned resources`,
    );
    process.exit(1);
  }

  logger.blank();
  logger.success(
    `Imported ${resolved.length} orphaned resource(s) — stack is ready for deployment.`,
  );
  emitAnnotation(
    'notice',
    `Stack ${stackName}: rescued ${resolved.length} orphaned resource(s) via cdk import`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
