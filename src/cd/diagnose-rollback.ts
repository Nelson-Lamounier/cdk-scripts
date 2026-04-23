#!/usr/bin/env npx tsx
/**
 * Diagnose & Rollback — Error-Handling Hook
 *
 * Single post-failure hook that operates in two modes selected by `--mode`:
 *
 * **diagnose** (default):
 *   Queries CloudFormation for failed events and current stack status.
 *   Writes diagnostics to console, GitHub Actions annotations, and
 *   $GITHUB_STEP_SUMMARY. Always exits 0 (diagnostic-only — never masks
 *   the real deployment failure).
 *
 *   Usage:
 *     npx tsx diagnose-rollback.ts <stack-name> --mode diagnose [--region <region>]
 *
 * **rollback**:
 *   Rolls back a CloudFormation stack to its previous state when post-deploy
 *   verification or smoke tests fail. Uses the SDK v3 waiter for exponential
 *   backoff. Writes results to $GITHUB_STEP_SUMMARY and $GITHUB_OUTPUT.
 *
 *   Usage:
 *     npx tsx diagnose-rollback.ts <stack-name> --mode rollback [--region <region>]
 *
 * Exit codes:
 *   diagnose mode: 0 always
 *   rollback mode: 0 = success/skipped, 1 = failure
 */

import { parseArgs } from 'util';

import {
  CloudFormationClient,
  DescribeStacksCommand,
  RollbackStackCommand,
  paginateDescribeStackEvents,
  waitUntilStackRollbackComplete,
} from '@aws-sdk/client-cloudformation';
import {
  emitAnnotation,
  setOutput,
  writeSummary,
} from '../utils/github.js';
import logger from '../utils/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    mode: { type: 'string', default: 'diagnose' },
    region: { type: 'string', default: process.env.AWS_REGION ?? 'eu-west-1' },
  },
});

const [stackName] = positionals;
const mode = values.mode as 'diagnose' | 'rollback';
const region = values.region!;

if (!stackName) {
  console.error(
    'Usage: diagnose-rollback.ts <stack-name> --mode diagnose|rollback [--region <region>]',
  );
  process.exit(mode === 'diagnose' ? 0 : 1);
}

// =============================================================================
// AWS Client
// =============================================================================
const cfn = new CloudFormationClient({ region });

// =============================================================================
// Shared Helpers
// =============================================================================

/** Query the current CloudFormation stack status. */
async function getStackStatus(): Promise<{ status: string; reason: string }> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const stack = response.Stacks?.[0];
    return {
      status: stack?.StackStatus ?? 'NOT_FOUND',
      reason: stack?.StackStatusReason ?? '',
    };
  } catch {
    return { status: 'NOT_FOUND', reason: 'Stack not found or deleted' };
  }
}

// =============================================================================
// Mode: diagnose
// =============================================================================

/** CloudFormation statuses that indicate a resource failure. */
const FAILURE_STATUSES = new Set([
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
]);

interface FailedEvent {
  logicalId: string;
  resourceType: string;
  status: string;
  reason: string;
  timestamp: string;
}

/** Fetch all failed stack events using the AWS SDK v3 paginator. */
async function getFailedEvents(): Promise<FailedEvent[]> {
  const events: FailedEvent[] = [];

  try {
    const paginator = paginateDescribeStackEvents(
      { client: cfn },
      { StackName: stackName },
    );

    for await (const page of paginator) {
      for (const e of page.StackEvents ?? []) {
        if (FAILURE_STATUSES.has(e.ResourceStatus ?? '')) {
          events.push({
            logicalId: e.LogicalResourceId ?? 'Unknown',
            resourceType: e.ResourceType ?? 'Unknown',
            status: e.ResourceStatus ?? 'Unknown',
            reason: e.ResourceStatusReason ?? 'No reason provided',
            timestamp: e.Timestamp?.toISOString() ?? 'Unknown',
          });
        }
      }
    }
  } catch (err) {
    logger.warn(`Could not fetch stack events: ${(err as Error).message}`);
  }

  return events;
}

/** Build diagnostic summary markdown from failure events. */
function buildDiagnosticSummary(
  events: FailedEvent[],
  stackStatus: { status: string; reason: string },
): string {
  const lines: string[] = [];

  lines.push('### ❌ CloudFormation Failed Resources');
  lines.push('');

  if (events.length > 0) {
    lines.push('| Resource | Type | Status | Reason |');
    lines.push('|----------|------|--------|--------|');
    for (const e of events) {
      lines.push(
        `| \`${e.logicalId}\` | ${e.resourceType} | ${e.status} | ${e.reason} |`,
      );
    }
  } else {
    lines.push(
      'No failed CloudFormation events found (stack may have rolled back).',
    );
  }

  lines.push('');
  lines.push(`**Current stack status**: \`${stackStatus.status}\``);
  if (stackStatus.reason) {
    lines.push(`**Reason**: ${stackStatus.reason}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** Main entry for diagnose mode. */
async function runDiagnose(): Promise<void> {
  logger.header(`Diagnose CloudFormation Failure — ${stackName}`);
  logger.keyValue('Stack', stackName);
  logger.keyValue('Region', region);
  logger.blank();

  // 1. Fetch failed events (paginated)
  logger.task('Querying CloudFormation events...');
  const failedEvents = await getFailedEvents();

  if (failedEvents.length > 0) {
    logger.error(`Found ${failedEvents.length} failed resource(s)`);
    logger.blank();

    logger.table(
      ['Resource', 'Type', 'Status', 'Reason'],
      failedEvents.map((e) => [
        e.logicalId,
        e.resourceType,
        e.status,
        e.reason,
      ]),
    );

    // Emit GitHub Actions annotations
    for (const event of failedEvents) {
      emitAnnotation(
        'error',
        `${event.resourceType} ${event.logicalId}: ${event.reason}`,
        `CFN ${event.status}`,
      );
    }
  } else {
    logger.info(
      'No failed CloudFormation events found (stack may have rolled back)',
    );
  }

  // 2. Current stack status
  logger.blank();
  logger.task('Checking current stack status...');
  const stackStatus = await getStackStatus();
  logger.keyValue('Status', stackStatus.status);
  if (stackStatus.reason) {
    logger.keyValue('Reason', stackStatus.reason);
  }

  // 3. Write summary
  writeSummary(buildDiagnosticSummary(failedEvents, stackStatus));

  logger.blank();
  logger.info('Diagnostics complete');
}

// =============================================================================
// Mode: rollback
// =============================================================================

/** States where the RollbackStack API can be invoked. */
const ROLLABLE_STATES = new Set([
  'UPDATE_FAILED',
  'CREATE_FAILED',
  'UPDATE_ROLLBACK_FAILED',
]);

/** Build rollback result summary markdown. */
function buildRollbackSummary(
  result: 'success' | 'failure' | 'skipped',
  finalStatus: string,
  reason: string,
): string {
  const emoji =
    result === 'success' ? '✅' : result === 'failure' ? '❌' : '⏭️';

  return `## ⚠️ Stack Rollback

**Stack**: \`${stackName}\`
**Region**: \`${region}\`
**Result**: ${emoji} ${result}
**Final Status**: \`${finalStatus}\`
**Reason**: ${reason}

### Manual Remediation (if rollback failed)
\`\`\`bash
# Check current status
aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].StackStatus'

# Manual rollback
aws cloudformation rollback-stack --stack-name ${stackName}

# Or re-deploy from last known good
npx cdk deploy ${stackName} --require-approval broadening
\`\`\`
`;
}

/** Main entry for rollback mode. */
async function runRollback(): Promise<void> {
  logger.header(`Rollback — ${stackName}`);

  // 1. Check current stack status
  const { status: currentStatus } = await getStackStatus();
  logger.info(`Current stack status: ${currentStatus}`);

  emitAnnotation(
    'warning',
    `Rolling back ${stackName} due to post-deploy verification failure`,
  );

  // 2. Determine if rollback is appropriate
  if (currentStatus === 'UPDATE_COMPLETE') {
    const reason =
      'Stack deployment succeeded (UPDATE_COMPLETE) but post-deploy checks failed. ' +
      'This is likely a smoke test configuration issue, not a bad deployment. Skipping rollback.';
    logger.warn(reason);
    emitAnnotation('warning', `${stackName}: ${reason}`);
    setOutput('result', 'skipped');
    writeSummary(buildRollbackSummary('skipped', currentStatus, reason));
    return;
  }

  if (!ROLLABLE_STATES.has(currentStatus)) {
    const reason = `Stack not in a rollable state (${currentStatus})`;
    logger.warn(`${reason}, skipping rollback`);
    setOutput('result', 'skipped');
    writeSummary(buildRollbackSummary('skipped', currentStatus, reason));
    return;
  }

  // 3. Initiate rollback
  logger.info('Initiating CloudFormation rollback...');
  try {
    await cfn.send(new RollbackStackCommand({ StackName: stackName }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to initiate rollback: ${message}`);
    setOutput('result', 'failure');
    writeSummary(
      buildRollbackSummary(
        'failure',
        currentStatus,
        `Failed to initiate rollback: ${message}`,
      ),
    );
    process.exit(1);
  }

  // 4. Wait for rollback (SDK v3 waiter — exponential backoff)
  logger.info('Waiting for rollback to complete (SDK waiter)...');
  try {
    const waiterResult = await waitUntilStackRollbackComplete(
      { client: cfn, maxWaitTime: 600 },
      { StackName: stackName },
    );

    const { status: finalStatus } = await getStackStatus();
    logger.info(`Final stack status: ${finalStatus}`);

    if (waiterResult.state === 'SUCCESS') {
      logger.success('Rollback completed successfully');
      setOutput('result', 'success');
      writeSummary(
        buildRollbackSummary(
          'success',
          finalStatus,
          'Rollback to previous configuration completed',
        ),
      );
    } else {
      logger.error(`Rollback ended in unexpected state: ${finalStatus}`);
      setOutput('result', 'failure');
      emitAnnotation(
        'error',
        `Rollback ended in unexpected state: ${finalStatus}`,
      );
      writeSummary(
        buildRollbackSummary(
          'failure',
          finalStatus,
          'Rollback ended in unexpected state',
        ),
      );
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const { status: finalStatus } = await getStackStatus();
    logger.error(`Waiter failed: ${message}`);
    logger.info(`Final stack status: ${finalStatus}`);
    setOutput('result', 'failure');
    emitAnnotation('error', `Rollback waiter failed: ${message}`);
    writeSummary(
      buildRollbackSummary(
        'failure',
        finalStatus,
        `Waiter failed: ${message}`,
      ),
    );
    process.exit(1);
  }
}

// =============================================================================
// Main Router
// =============================================================================
async function main(): Promise<void> {
  switch (mode) {
    case 'rollback':
      await runRollback();
      break;
    case 'diagnose':
    default:
      await runDiagnose();
      break;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (mode === 'diagnose') {
    logger.warn(`Diagnostics error: ${message}`);
    process.exit(0);
  } else {
    logger.error(`Fatal: ${message}`);
    setOutput('result', 'failure');
    process.exit(1);
  }
});
