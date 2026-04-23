#!/usr/bin/env npx tsx
/**
 * CDK Deploy Script
 *
 * Deploys a single CDK stack with provenance tags, output capture,
 * and GitHub Actions integration. Called by the `just ci-deploy`
 * recipe from `_deploy-stack.yml`.
 *
 * Usage:
 *   npx tsx scripts/deployment/deploy.ts <stack-name> <project> <environment>
 *   npx tsx scripts/deployment/deploy.ts K8s-Compute-development k8s development --require-approval never
 *   npx tsx scripts/deployment/deploy.ts Org-DnsRole-prod org development --context hostedZoneIds='["Z123"]' --context trustedAccountIds='["111"]'
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   status        - deployment result (success|failure)
 *   duration      - deployment duration in seconds
 *
 * Environment variables consumed:
 *   GITHUB_SHA, GITHUB_RUN_ID, GITHUB_ACTOR, GITHUB_REPOSITORY,
 *   GITHUB_WORKFLOW — used for SLSA-inspired provenance tags
 *
 * Exit codes:
 *   0 = deployment successful
 *   1 = deployment failed
 */

import { mkdir } from 'fs/promises';
import { parseArgs } from 'util';

import { setOutput } from '../utils/github.js';
import logger from '../utils/logger.js';

import { buildCdkArgs, runCdk } from '../shared/exec.js';
import { getProject, type Environment } from '../utils/stacks.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'require-approval': {
      type: 'string',
      default: 'never',
    },
    context: {
      type: 'string',
      multiple: true,
      default: [],
    },
  },
});

const [stackName, project, environment] = positionals;
const requireApproval = (values['require-approval'] ?? 'never') as
  | 'never'
  | 'broadening'
  | 'any-change';

// Parse --context key=value pairs into a Record for buildCdkArgs
const extraContext: Record<string, string> = {};
for (const entry of values.context ?? []) {
  const eqIdx = entry.indexOf('=');
  if (eqIdx > 0) {
    extraContext[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
  }
}

if (!stackName || !project || !environment) {
  console.error(
    'Usage: deploy.ts <stack-name> <project> <environment> [--require-approval never] [--context key=value ...]',
  );
  console.error('');
  console.error('Examples:');
  console.error(
    '  deploy.ts K8s-ControlPlane-development kubernetes development',
  );
  console.error(
    '  deploy.ts Bedrock-Compute-production bedrock production --require-approval broadening',
  );
  console.error(
    '  deploy.ts Org-DnsRole-prod org development --context hostedZoneIds=\'["Z123"]\'',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// IAM tag sanitisation
// ---------------------------------------------------------------------------

/** Strip characters that are invalid in IAM tag values. */
function sanitizeTagValue(value: string): string {
  // IAM allows: unicode letters, spaces, digits, and _ . : / = + - @
  return value.replace(/[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu, '');
}

// ---------------------------------------------------------------------------
// Build provenance tags (SLSA-inspired audit metadata)
// ---------------------------------------------------------------------------
function buildProvenanceTags(): Record<string, string> {
  return {
    DeployCommit: sanitizeTagValue(process.env.GITHUB_SHA ?? 'local'),
    DeployRunId: sanitizeTagValue(process.env.GITHUB_RUN_ID ?? '0'),
    DeployActor: sanitizeTagValue(process.env.GITHUB_ACTOR ?? 'local'),
    DeployRepo: sanitizeTagValue(process.env.GITHUB_REPOSITORY ?? 'local'),
    DeployTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    DeployWorkflow: sanitizeTagValue(process.env.GITHUB_WORKFLOW ?? 'manual'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Load consumer stacks config to populate the project registry.
  // Consumers keep scripts/shared/stacks.js which calls registerProject().
  const stacksConfigPath =
    process.env.CDK_STACKS_CONFIG ??
    require('path').join(process.cwd(), 'scripts', 'shared', 'stacks.js');
  try {
    require(stacksConfigPath);
  } catch {
    // optional for deploy.ts — falls back to passthrough context
  }

  logger.header(`Deploy ${stackName}`);
  logger.keyValue('Stack', stackName);
  logger.keyValue('Project', project);
  logger.keyValue('Environment', environment);
  logger.keyValue('Approval', requireApproval);
  logger.blank();

  // Prepare outputs directory (async)
  const outputsDir = '/tmp/cdk-outputs';
  await mkdir(outputsDir, { recursive: true });
  const outputsFile = `${outputsDir}/stack-outputs.json`;

  // Resolve full CDK context for the project — includes env-var-bridged
  // values like adminAllowedIps (from ALLOW_IPV4/ALLOW_IPV6) that
  // base-stack.ts reads via tryGetContext().
  const projectConfig = getProject(project);
  const resolvedContext = projectConfig
    ? { ...projectConfig.cdkContext(environment as Environment), ...extraContext }
    : { project, environment, ...extraContext };

  // Build CDK args
  const cdkArgs = buildCdkArgs({
    command: 'deploy',
    stackNames: [stackName],
    exclusively: true,
    context: resolvedContext,
    requireApproval,
    method: 'direct',
    progress: 'events',
    outputsFile,
    tags: buildProvenanceTags(),
  });

  logger.task('Executing CDK deploy...');
  logger.verbose(`cdk ${cdkArgs.join(' ')}`);
  logger.blank();

  // Execute deployment with timing — capture output to prevent
  // infrastructure identifiers leaking into public workflow logs.
  const startTime = Date.now();
  const result = await runCdk(cdkArgs, { captureOutput: true });
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Extract minimal troubleshooting signal from captured output
  const resourceCount = (result.stdout.match(/UPDATE_COMPLETE|CREATE_COMPLETE/g) ?? []).length;
  const synthesisMatch = result.stdout.match(/Synthesis time:\s*([\d.]+)s/);
  const synthesisTime = synthesisMatch ? synthesisMatch[1] : 'unknown';

  // Write outputs for GitHub Actions
  if (result.exitCode === 0) {
    setOutput('status', 'success');
    setOutput('duration', String(duration));
    logger.blank();
    logger.success(`Stack deployment successful (${duration}s)`);
    logger.keyValue('Synthesis', `${synthesisTime}s`);
    logger.keyValue('Resources updated', String(resourceCount));
  } else {
    setOutput('status', 'failure');
    setOutput('duration', String(duration));
    logger.blank();
    logger.error(
      `Stack deployment failed (exit code: ${result.exitCode}, duration: ${duration}s)`,
    );
    // Print stderr for failure diagnostics (CDK error messages, not resource IDs)
    if (result.stderr) {
      logger.info('CDK error output:');
      console.error(result.stderr);
    }
    process.exit(result.exitCode);
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  setOutput('status', 'failure');
  process.exit(1);
});
