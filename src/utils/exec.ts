/**
 * Child Process Execution Utilities
 *
 * Shared, CDK-agnostic utilities for spawning child processes and
 * capturing their output. Used by both the CDK execution wrapper
 * (`infra/scripts/deployment/exec.ts`) and any arbitrary command
 * runner in the monorepo.
 *
 * Design decisions:
 *   - Uses Buffer arrays instead of string concatenation for V8 perf
 *     on large outputs (e.g. `cdk synth` for a 10-stack cluster).
 *   - Spawns directly on Unix (no shell); uses `shell: true` only on
 *     Windows where `npx.cmd` requires it. This avoids the security
 *     and performance costs of unnecessary shell invocation.
 *
 * @module
 */

import { spawn, type SpawnOptions } from 'child_process';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of a child process execution.
 *
 * Returned by {@link executeChildProcess} and {@link runCommand}.
 */
export interface CommandResult {
  /** Process exit code (`0` = success, non-zero = failure) */
  exitCode: number;
  /** Captured standard output (empty string when `captureOutput` is false) */
  stdout: string;
  /** Captured standard error (empty string when `captureOutput` is false) */
  stderr: string;
}

/**
 * Options for {@link executeChildProcess}.
 */
export interface ExecuteOptions {
  /**
   * If `true`, stdout/stderr are piped and captured into
   * {@link CommandResult.stdout} / {@link CommandResult.stderr}.
   * If `false` (default), output is inherited and streams to the
   * parent process terminal.
   */
  captureOutput?: boolean;
  /** Working directory for the child process (default: `process.cwd()`). */
  cwd?: string;
  /**
   * Additional environment variables to inject into the subprocess.
   * Merged with `process.env`; values here take precedence.
   * Use this to pass `AWS_PROFILE`, `KUBECONFIG`, etc. without
   * mutating the parent process environment.
   *
   * @example { AWS_PROFILE: 'dev-account' }
   */
  env?: NodeJS.ProcessEnv;
}

// =============================================================================
// Core Execution Engine
// =============================================================================

/**
 * Spawn a child process and optionally capture its output.
 *
 * This is the single, DRY implementation shared by {@link runCommand}
 * and the CDK-specific `runCdk` wrapper in `infra/scripts/deployment/exec.ts`.
 *
 * **Performance**: Accumulates output as `Buffer` chunks and joins once
 * at the end, avoiding V8 string-concatenation pressure on large outputs.
 *
 * **Security**: On Unix (macOS/Linux), processes are spawned directly
 * without a shell. On Windows, `shell: true` is used so that `.cmd`
 * wrappers (e.g. `npx.cmd`) resolve correctly.
 *
 * @param command - Executable to run (e.g. `'npx'`, `'node'`, `'bash'`).
 * @param args    - Arguments to pass to the executable.
 * @param options - Execution options (capture output, working directory).
 * @returns A promise that resolves with the {@link CommandResult}.
 *
 * @example
 * ```ts
 * const result = await executeChildProcess('npx', ['cdk', 'diff', '--fail'], {
 *   captureOutput: true,
 *   cwd: '/path/to/infra',
 * });
 *
 * if (result.exitCode !== 0) {
 *   console.error(result.stderr);
 * }
 * ```
 */
export async function executeChildProcess(
  command: string,
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const useShell = process.platform === 'win32';

  const spawnOpts: SpawnOptions = {
    cwd,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    // Merge caller-supplied env vars with the inherited process environment.
    // Caller values take precedence so AWS_PROFILE, KUBECONFIG, etc.
    // can be injected without mutating the parent process.env.
    env: options.env ? { ...process.env, ...options.env } : process.env,
    ...(useShell && { shell: true }),
  };

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (options.captureOutput) {
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    }

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
      });
    });
  });
}

// =============================================================================
// Convenience Wrapper
// =============================================================================

/**
 * Run an arbitrary shell command and optionally capture its output.
 *
 * This is a thin wrapper around {@link executeChildProcess} for scripts
 * that need to run non-CDK commands (linters, test runners, etc.).
 *
 * @param command - Executable to run.
 * @param args    - Arguments to pass.
 * @param options - Execution options.
 * @returns A promise that resolves with the {@link CommandResult}.
 *
 * @example
 * ```ts
 * const result = await runCommand('helm', ['lint', 'charts/monitoring'], {
 *   captureOutput: true,
 *   cwd: '/path/to/repo',
 * });
 * ```
 */
export async function runCommand(
  command: string,
  args: string[] = [],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  return executeChildProcess(command, args, options);
}
