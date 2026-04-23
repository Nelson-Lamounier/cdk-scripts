/**
 * Shared Types — Re-export barrel
 *
 * Centralises type exports from across the @repo/script-utils package.
 * Consumer modules can import types from either the origin module or
 * from this barrel:
 *
 *   import type { Environment, StackConfig } from '@repo/script-utils/types.js';
 */

export type {
  Environment,
  StackConfig,
  ExtraContext,
  ProjectConfig,
  DefaultConfig,
} from './stacks.js';

export type { StackOutput } from './cdk.js';

export type { AwsConfig, CliArgSpec, ParsedArgs } from './aws.js';
