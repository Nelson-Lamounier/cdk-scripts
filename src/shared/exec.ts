import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

import {
  executeChildProcess,
  type CommandResult,
  type ExecuteOptions,
} from '../utils/exec.js';

export { executeChildProcess, runCommand, type CommandResult, type ExecuteOptions } from '../utils/exec.js';

export type CdkResult = CommandResult;

// =============================================================================
// CDK Argument Builder
// =============================================================================

export interface CdkArgsOptions {
  command: 'synth' | 'deploy' | 'diff' | 'destroy' | 'list' | 'bootstrap';
  stackNames?: string[];
  all?: boolean;
  exclusively?: boolean;
  context?: Record<string, string>;
  profile?: string;
  region?: string;
  accountId?: string;
  requireApproval?: 'never' | 'broadening' | 'any-change';
  force?: boolean;
  quiet?: boolean;
  method?: 'direct' | 'change-set';
  progress?: 'events' | 'bar';
  outputsFile?: string;
  tags?: Record<string, string>;
  fail?: boolean;
}

export function buildCdkArgs(options: CdkArgsOptions): string[] {
  const args: string[] = [options.command];

  if (options.all) {
    args.push('--all');
  } else if (options.stackNames?.length) {
    args.push(...options.stackNames);
  }

  if (options.exclusively) args.push('--exclusively');

  if (options.context) {
    for (const [key, value] of Object.entries(options.context)) {
      args.push('-c', `${key}=${value}`);
    }
  }

  if (options.profile) args.push('--profile', options.profile);
  if (options.region) args.push('-c', `region=${options.region}`);
  if (options.accountId) args.push('-c', `account=${options.accountId}`);
  if (options.requireApproval) args.push('--require-approval', options.requireApproval);
  if (options.force) args.push('--force');
  if (options.quiet) args.push('--quiet');
  if (options.method) args.push(`--method=${options.method}`);
  if (options.progress) args.push('--progress', options.progress);
  if (options.outputsFile) args.push('--outputs-file', options.outputsFile);

  if (options.tags) {
    for (const [key, value] of Object.entries(options.tags)) {
      args.push('--tags', `${key}=${value}`);
    }
  }

  if (options.fail) args.push('--fail');

  return args;
}

// =============================================================================
// CDK Runner
// =============================================================================

export async function runCdk(
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  return executeChildProcess('npx', ['cdk', ...args], {
    ...options,
    cwd: options.cwd ?? getCdkProjectRoot(),
  });
}

// =============================================================================
// CDK Project Root
// =============================================================================

/**
 * Resolve the CDK project root (the directory containing cdk.json).
 *
 * Resolution order:
 *   1. CDK_PROJECT_ROOT env var — resolved relative to process.cwd()
 *      Set in consumer justfile: `export CDK_PROJECT_ROOT := "infra"`
 *   2. Walk up from process.cwd() until cdk.json is found (max 5 levels)
 *
 * @throws Error if cdk.json cannot be found and CDK_PROJECT_ROOT is not set.
 */
export function getCdkProjectRoot(): string {
  const fromEnv = process.env.CDK_PROJECT_ROOT;
  if (fromEnv) {
    return resolve(process.cwd(), fromEnv);
  }

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'cdk.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    'Could not find CDK project root (no cdk.json found). ' +
    'Set CDK_PROJECT_ROOT env var to the path of your CDK project (e.g. "infra").',
  );
}
