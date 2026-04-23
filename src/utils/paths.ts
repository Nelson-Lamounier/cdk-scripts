/**
 * Path Helpers
 *
 * Shared path resolution utilities for monorepo scripts.
 * Handles the common GITHUB_WORKSPACE → process.cwd() fallback.
 */

import { join } from 'path';

// =============================================================================
// Workspace Resolution
// =============================================================================

/**
 * Resolve the monorepo workspace root.
 *
 * In CI:    $GITHUB_WORKSPACE (set automatically by actions/checkout)
 * Locally:  process.cwd()
 */
export function resolveWorkspaceDir(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/**
 * Resolve a relative path against the workspace root.
 *
 * @example
 *   resolveWorkspacePath('stack-outputs')
 *   // CI:    /home/runner/work/repo/repo/stack-outputs
 *   // Local: /Users/you/project/stack-outputs
 */
export function resolveWorkspacePath(relativePath: string): string {
  return join(resolveWorkspaceDir(), relativePath);
}
