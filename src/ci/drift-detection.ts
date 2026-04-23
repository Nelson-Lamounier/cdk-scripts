#!/usr/bin/env npx tsx
/**
 * Drift Detection Script
 *
 * Runs `cdk diff --fail` for all stacks in a project and writes the results
 * to `$GITHUB_STEP_SUMMARY`. Informational only — never blocks deployment.
 *
 * **Critical fix**: Uses the `--fail` flag so `cdk diff` exits with code 1
 * when differences are found. Without it, `cdk diff` always exits 0 and
 * drift is silently missed.
 *
 * Usage:
 *   npx tsx scripts/deployment/drift-detection.ts kubernetes staging
 *   npx tsx scripts/deployment/drift-detection.ts kubernetes production --region eu-west-1
 *
 * Exit codes:
 *   0 = always (informational — does not block)
 */

import { parseArgs } from 'util';

import {
  emitAnnotation,
  setOutput,
  writeSummary,
} from '../utils/github.js';
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
    region: {
      type: 'string',
      default: process.env.AWS_REGION ?? 'eu-west-1',
    },
  },
});

const [projectId, environment] = positionals as [string, Environment];
const region = values.region!;

if (!projectId || !environment) {
  console.error(
    'Usage: drift-detection.ts <project> <environment> [--region <region>]',
  );
  process.exit(1);
}

const project = getProject(projectId);
if (!project) {
  console.error(`Unknown project: ${projectId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a single `cdk diff --fail` invocation against one stack.
 *
 * @remarks
 * With the `--fail` flag:
 *   - exit 0  → no differences
 *   - exit 1  → differences found (or new/undeployed stack)
 *   - exit >1 → unexpected error
 */
interface DiffResult {
  /** CloudFormation stack name */
  stackName: string;
  /** Human-readable display name */
  displayName: string;
  /** Categorised outcome */
  status: 'no-changes' | 'changes' | 'new-stack' | 'error';
  /** Raw CDK diff output */
  output: string;
}

// ---------------------------------------------------------------------------
// Run cdk diff for a single stack
// ---------------------------------------------------------------------------

/**
 * Execute `cdk diff --fail` for a single stack and categorise the result.
 *
 * @param stackName   - Full CloudFormation stack name.
 * @param displayName - Human-readable name for logging.
 * @returns A {@link DiffResult} with the categorised status.
 */
async function diffStack(
  stackName: string,
  displayName: string,
): Promise<DiffResult> {
  const cdkArgs = buildCdkArgs({
    command: 'diff',
    stackNames: [stackName],
    fail: true, // ← Critical: without --fail, cdk diff always exits 0
    context: {
      env: environment,
      region,
      account: process.env.AWS_ACCOUNT_ID ?? '',
    },
  });

  const result = await runCdk(cdkArgs, { captureOutput: true });
  const combined = (result.stdout + '\n' + result.stderr).trim();

  // Exit code 0 = no differences (with --fail flag)
  if (result.exitCode === 0) {
    return { stackName, displayName, status: 'no-changes', output: combined };
  }

  // Exit code 1 = differences found (with --fail flag)
  if (result.exitCode === 1) {
    // Check if it's a new stack that hasn't been deployed yet
    if (
      combined.includes('has not been deployed') ||
      combined.includes('does not exist')
    ) {
      return { stackName, displayName, status: 'new-stack', output: combined };
    }
    return { stackName, displayName, status: 'changes', output: combined };
  }

  // Any other exit code = error
  return { stackName, displayName, status: 'error', output: combined };
}

// ---------------------------------------------------------------------------
// Build step summary markdown
// ---------------------------------------------------------------------------

/**
 * Build a GitHub Step Summary markdown string from diff results.
 *
 * @param results - Array of per-stack diff results.
 * @returns Markdown string ready for `$GITHUB_STEP_SUMMARY`.
 */
function buildSummaryMarkdown(results: DiffResult[]): string {
  const lines: string[] = [
    '## 🔍 Infrastructure Drift Detection',
    '',
    `**Project**: ${project!.name}`,
    `**Environment**: ${environment}`,
    '',
  ];

  for (const result of results) {
    lines.push(`### \`${result.stackName}\``);
    lines.push('');

    switch (result.status) {
      case 'no-changes':
        lines.push('✅ No changes detected');
        break;

      case 'new-stack':
        lines.push('🆕 Stack has not been deployed yet');
        break;

      case 'changes':
        lines.push('<details>');
        lines.push(
          '<summary>⚠️ Changes detected (click to expand)</summary>',
        );
        lines.push('');
        lines.push('```diff');
        lines.push(result.output);
        lines.push('```');
        lines.push('</details>');
        break;

      case 'error':
        lines.push('❌ Diff failed');
        lines.push('');
        lines.push('```');
        lines.push(result.output);
        lines.push('```');
        break;
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.setEnvironment(environment);
  logger.header(`Drift Detection — ${project!.name} (${environment})`);

  const stacks = project!.stacks;
  logger.info(`Running cdk diff --fail for ${stacks.length} stack(s)...`);

  // Run diff for all stacks sequentially (CDK requires sequential execution)
  const results: DiffResult[] = [];
  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    logger.info(`Diffing ${stack.name} (${stackName})...`);
    const result = await diffStack(stackName, stack.name);
    results.push(result);

    // Log inline result
    switch (result.status) {
      case 'no-changes':
        logger.success(`${stack.name}: No changes`);
        break;
      case 'changes':
        logger.warn(`${stack.name}: Changes detected`);
        break;
      case 'new-stack':
        logger.info(`${stack.name}: New stack (not yet deployed)`);
        break;
      case 'error':
        logger.warn(`${stack.name}: Diff failed`);
        break;
    }
  }

  // Build and write summary via shared helper
  writeSummary(buildSummaryMarkdown(results));

  if (!process.env.GITHUB_STEP_SUMMARY) {
    // Local mode — print to console
    console.log(buildSummaryMarkdown(results));
  } else {
    logger.success('Wrote drift detection summary to $GITHUB_STEP_SUMMARY');
  }

  // Set outputs via shared helper
  const hasChanges = results.some((r) => r.status === 'changes');
  const hasErrors = results.some((r) => r.status === 'error');
  setOutput('has_changes', String(hasChanges));

  if (hasChanges) {
    emitAnnotation(
      'notice',
      'Infrastructure changes detected — review the step summary before approving deployment',
    );
    logger.warn('Infrastructure changes detected');
  }

  if (hasErrors) {
    emitAnnotation(
      'warning',
      'Some stacks could not be diffed (new stacks or permission issues)',
    );
  }

  // Summary line
  const counts = {
    noChanges: results.filter((r) => r.status === 'no-changes').length,
    changes: results.filter((r) => r.status === 'changes').length,
    newStacks: results.filter((r) => r.status === 'new-stack').length,
    errors: results.filter((r) => r.status === 'error').length,
  };

  logger.blank();
  logger.info(
    `Results: ${counts.noChanges} unchanged, ${counts.changes} changed, ${counts.newStacks} new, ${counts.errors} errors`,
  );

  // Always exit 0 — drift detection is informational
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  // Still exit 0 — drift detection should never block deployment
});
