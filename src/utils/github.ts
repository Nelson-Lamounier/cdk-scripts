/**
 * GitHub Actions Helpers
 *
 * Shared utilities for writing GitHub Actions outputs and step summaries.
 * All monorepo scripts that interact with GHA should import from here.
 *
 * Key design decisions:
 *   - setOutput uses the EOF delimiter pattern, which is safe for multiline
 *     values (JSON blobs, CDK outputs). The old `key=value\n` pattern breaks
 *     if a value contains a newline character.
 *   - writeSummary is a no-op outside CI, so scripts work locally too.
 */

import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';

// =============================================================================
// GitHub Actions Outputs ($GITHUB_OUTPUT)
// =============================================================================

/**
 * Write a key-value pair to $GITHUB_OUTPUT using the EOF delimiter pattern.
 *
 * This is safe for multiline and JSON values. The pattern is:
 *   key<<DELIMITER\nvalue\nDELIMITER\n
 *
 * @see https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#setting-an-output-parameter
 */
export function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  const delimiter = `EOF_${randomUUID().slice(0, 8)}`;
  appendFileSync(outputFile, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// =============================================================================
// GitHub Actions Step Summary ($GITHUB_STEP_SUMMARY)
// =============================================================================

/**
 * Append a line to $GITHUB_STEP_SUMMARY (markdown-formatted).
 * No-op when not running in GitHub Actions.
 */
export function writeSummary(line: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  appendFileSync(summaryFile, line + '\n');
}

// =============================================================================
// CI Detection
// =============================================================================

/** Returns true when running inside GitHub Actions */
export function isCI(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Mask a secret value in GitHub Actions logs.
 *
 * After calling this, any occurrence of the value in subsequent log output
 * will be replaced with `***` by the Actions runner.
 *
 * @see https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#masking-a-value-in-a-log
 */
export function maskSecret(value: string): void {
  if (!isCI()) return;
  console.log(`::add-mask::${value}`);
}

// =============================================================================
// GitHub Actions Annotations
// =============================================================================

/**
 * Emit a GitHub Actions workflow annotation.
 *
 * @param level   - 'error' | 'warning' | 'notice'
 * @param message - Annotation body
 * @param title   - Optional annotation title
 *
 * @see https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#setting-an-error-message
 */
export function emitAnnotation(
  level: 'error' | 'warning' | 'notice',
  message: string,
  title?: string,
): void {
  if (!isCI()) return;
  const titlePart = title ? ` title=${title}` : '';
  console.log(`::${level}${titlePart}::${message}`);
}
