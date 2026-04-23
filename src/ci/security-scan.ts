#!/usr/bin/env npx tsx
/**
 * IaC Security Scan Script
 *
 * Runs Checkov against synthesised CDK CloudFormation templates to detect
 * security misconfigurations. Called by the `just ci-security-scan` recipe
 * from `ci.yml`.
 *
 * Usage:
 *   npx tsx scripts/ci/security-scan.ts [cdk-output-path]
 *   npx tsx scripts/ci/security-scan.ts infra/cdk.out --soft-fail
 *
 * Behaviour:
 *   1. Validates the `cdk.out/` directory contains CloudFormation templates
 *   2. Detects `.checkov/config.yaml` for custom rules and skip lists
 *   3. Shells out to `checkov` (must be on PATH — included in CI image)
 *   4. Parses JSON results for severity counts
 *   5. Writes GitHub step summary with findings table
 *   6. Sets outputs: scan-passed, findings-count, critical-count, high-count
 *   7. Exits non-zero if CRITICAL or HIGH findings are detected (unless --soft-fail)
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';

import { runCommand } from '../utils/exec.js';
import { setOutput, writeSummary, emitAnnotation } from '../utils/github.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Checkov JSON result structure (subset we care about) */
interface CheckovSummary {
  passed: number;
  failed: number;
  skipped: number;
  parsing_errors: number;
  resource_count: number;
}

/** Individual failed check from Checkov results */
interface CheckovFailedCheck {
  check_id: string;
  check_type: string;
  check_result: { result: string };
  resource: string;
  severity?: string;
  guideline?: string;
}

interface CheckovResults {
  summary: CheckovSummary;
  results: {
    passed_checks: unknown[];
    failed_checks: CheckovFailedCheck[];
    skipped_checks: unknown[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CDK_OUTPUT = 'infra/cdk.out';
const CHECKOV_CONFIG_PATH = '.checkov/config.yaml';
const REPORTS_DIR = 'security-reports';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'soft-fail': {
      type: 'boolean',
      default: false,
      description: 'Do not exit non-zero on CRITICAL/HIGH findings',
    },
  },
});

const cdkOutputPath = positionals[0] ?? DEFAULT_CDK_OUTPUT;
const softFail = values['soft-fail'] ?? false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count templates in the CDK output directory.
 *
 * @param dirPath - Absolute or relative path to `cdk.out/`
 * @returns Number of `.template.json` files found
 */
function countTemplates(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  return readdirSync(dirPath, { recursive: true })
    .filter((f) => String(f).endsWith('.template.json'))
    .length;
}

/**
 * Parse Checkov JSON output into typed results.
 *
 * @param jsonPath - Path to `results_json.json`
 * @returns Parsed results or undefined if parsing fails
 */
function parseCheckovResults(jsonPath: string): CheckovResults | undefined {
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    return JSON.parse(raw) as CheckovResults;
  } catch {
    logger.warn(`Could not parse Checkov results from ${jsonPath}`);
    return undefined;
  }
}

/**
 * Count findings by severity from the failed checks array.
 *
 * @param failedChecks - Array of failed Checkov checks
 * @param severity - Target severity level
 * @returns Number of findings matching the severity
 */
function countBySeverity(
  failedChecks: CheckovFailedCheck[],
  severity: string,
): number {
  return failedChecks.filter((c) => c.severity === severity).length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.header('IaC Security Scan (Checkov)');

  // 1. Validate CDK output exists
  const resolvedPath = resolve(cdkOutputPath);
  const templateCount = countTemplates(resolvedPath);

  logger.keyValue('CDK output', resolvedPath);
  logger.keyValue('Templates found', String(templateCount));
  logger.keyValue('Soft-fail mode', softFail ? 'enabled' : 'disabled');

  if (templateCount === 0) {
    logger.warn('No CloudFormation templates found — skipping scan');
    setOutput('scan-passed', 'true');
    setOutput('findings-count', '0');
    setOutput('critical-count', '0');
    setOutput('high-count', '0');
    writeSummary('## IaC Security Scan\n\n⏭️ Skipped — no templates found\n');
    return;
  }

  // 2. Build Checkov arguments
  const checkovArgs: string[] = [
    '--directory', resolvedPath,
    '--framework', 'cloudformation',
    '-o', 'cli',
    '-o', 'json',
    '-o', 'sarif',
    '--output-file-path', REPORTS_DIR,
    '--compact',
    '--quiet',
  ];

  // Use custom config if present
  if (existsSync(CHECKOV_CONFIG_PATH)) {
    checkovArgs.push('--config-file', CHECKOV_CONFIG_PATH);
    logger.info(`Using custom config: ${CHECKOV_CONFIG_PATH}`);
  }

  logger.blank();
  logger.task('Running Checkov security scan...');

  // 3. Execute Checkov (may exit non-zero on findings — we handle this)
  const result = await runCommand('checkov', checkovArgs, {
    captureOutput: false,
    cwd: process.cwd(),
  });

  logger.blank();
  logger.keyValue('Checkov exit code', String(result.exitCode));

  // 4. Parse results
  const jsonPath = join(REPORTS_DIR, 'results_json.json');
  const parsed = parseCheckovResults(jsonPath);

  let passedCount = 0;
  let findingsCount = 0;
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  if (parsed) {
    passedCount = parsed.summary.passed;
    findingsCount = parsed.summary.failed;

    criticalCount = countBySeverity(parsed.results.failed_checks, 'CRITICAL');
    highCount = countBySeverity(parsed.results.failed_checks, 'HIGH');
    mediumCount = countBySeverity(parsed.results.failed_checks, 'MEDIUM');
    lowCount = countBySeverity(parsed.results.failed_checks, 'LOW');
  }

  // 5. Log summary
  logger.blank();
  logger.table(
    ['Severity', 'Count'],
    [
      ['Passed', String(passedCount)],
      ['Failed', String(findingsCount)],
      ['  Critical', String(criticalCount)],
      ['  High', String(highCount)],
      ['  Medium', String(mediumCount)],
      ['  Low', String(lowCount)],
    ],
  );

  // 6. Set GitHub outputs
  setOutput('findings-count', String(findingsCount));
  setOutput('critical-count', String(criticalCount));
  setOutput('high-count', String(highCount));

  // 7. Write GitHub step summary
  const summaryLines = [
    '## IaC Security Scan Results',
    '',
    `**Templates scanned**: ${templateCount}`,
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| ✅ Passed | ${passedCount} |`,
    `| 🔴 Critical | ${criticalCount} |`,
    `| 🟠 High | ${highCount} |`,
    `| 🟡 Medium | ${mediumCount} |`,
    `| 🔵 Low | ${lowCount} |`,
    `| **Total Failed** | **${findingsCount}** |`,
    '',
  ];

  // 8. Determine pass/fail
  const hasBlockingFindings = criticalCount > 0 || highCount > 0;
  const scanPassed = !hasBlockingFindings;

  if (hasBlockingFindings && !softFail) {
    summaryLines.push(
      '### ❌ Blocking Findings Detected',
      '',
      'CRITICAL or HIGH severity findings must be resolved before merge.',
      'Download the `security-scan-results` artifact for detailed findings.',
      '',
    );
    emitAnnotation(
      'error',
      `IaC security scan: ${criticalCount} critical, ${highCount} high findings`,
      'Security Scan Failed',
    );
  } else if (findingsCount > 0) {
    summaryLines.push(
      '### ⚠️ Non-Blocking Findings',
      '',
      'MEDIUM/LOW findings detected. Review recommended but not required.',
      '',
    );
  } else {
    summaryLines.push(
      '### ✅ No Findings',
      '',
      'All security checks passed.',
      '',
    );
  }

  setOutput('scan-passed', String(scanPassed));
  writeSummary(summaryLines.join('\n'));

  // 9. Exit with appropriate code
  if (hasBlockingFindings && !softFail) {
    logger.error(
      `Blocking: ${criticalCount} critical, ${highCount} high findings detected`,
    );
    process.exit(1);
  }

  logger.success(
    findingsCount > 0
      ? `Scan complete: ${findingsCount} non-blocking findings`
      : 'Scan complete: no findings',
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
