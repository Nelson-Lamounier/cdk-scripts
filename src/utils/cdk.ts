/**
 * CDK Output Helpers
 *
 * Shared utilities for reading and parsing CDK stack outputs.
 * Both collect-outputs.ts and deploy-summary.ts use this module
 * instead of duplicating the parsing logic.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

// =============================================================================
// Types
// =============================================================================

export interface StackOutput {
  OutputKey: string;
  OutputValue: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Default CDK outputs file produced by `cdk deploy --outputs-file` */
export const CDK_OUTPUTS_FILE = '/tmp/cdk-outputs/stack-outputs.json';

// =============================================================================
// CDK Output Reader
// =============================================================================

/**
 * Read CDK stack outputs from the outputs file.
 *
 * The CDK outputs file has the format:
 *   { "StackName": { "Key1": "Value1", "Key2": "Value2" } }
 *
 * This function extracts the outputs for a specific stack and returns
 * them in CloudFormation-style `{ OutputKey, OutputValue }` format.
 *
 * @param stackName - The CDK stack to read outputs for
 * @param outputsFile - Path to the CDK outputs JSON (default: /tmp/cdk-outputs/stack-outputs.json)
 * @returns Array of stack outputs, empty array if file missing or parse fails
 */
export async function readStackOutputs(
  stackName: string,
  outputsFile: string = CDK_OUTPUTS_FILE,
): Promise<StackOutput[]> {
  if (!existsSync(outputsFile)) {
    return [];
  }

  const raw = await readFile(outputsFile, 'utf-8');

  let allOutputs: Record<string, Record<string, string>>;
  try {
    allOutputs = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse CDK outputs file: ${message}`);
    return [];
  }

  const stackOutputs = allOutputs[stackName];
  if (!stackOutputs || Object.keys(stackOutputs).length === 0) {
    return [];
  }

  return Object.entries(stackOutputs).map(([key, value]) => ({
    OutputKey: key,
    OutputValue: String(value),
  }));
}
