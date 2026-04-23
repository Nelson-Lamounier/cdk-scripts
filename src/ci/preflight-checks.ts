#!/usr/bin/env npx tsx
/**
 * Pre-flight Checks Script
 *
 * Validates deployment inputs, verifies AWS credentials, and optionally
 * checks CDK bootstrap status before a stack deployment. Called by
 * the `just ci-preflight` recipe from `_deploy-stack.yml`.
 *
 * Usage:
 *   npx tsx scripts/deployment/preflight-checks.ts <stack-name> \
 *     --project <project> --environment <env> --region <region> \
 *     --account-id <id> --require-approval <approval> \
 *     [--verify-bootstrap]
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = validation or verification failed
 */

import { parseArgs } from 'util';

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    environment: { type: 'string' },
    region: { type: 'string' },
    'account-id': { type: 'string' },
    'require-approval': { type: 'string' },
    'verify-bootstrap': { type: 'boolean', default: false },
  },
});

const [stackName] = positionals;
const project = values.project ?? '';
const environment = values.environment ?? '';
const region = values.region ?? '';
const accountId = values['account-id'] ?? '';
const requireApproval = values['require-approval'] ?? '';
const verifyBootstrap = values['verify-bootstrap']!;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed deployment target environments. */
const VALID_ENVIRONMENTS = ['development', 'staging', 'production', 'management'];

/** Allowed CDK approval modes. */
const VALID_APPROVALS = ['never', 'any-change', 'broadening'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mask a sensitive string, showing only the last 4 characters.
 *
 * Kept local because it's a trivial display-only helper — not worth
 * extracting to the shared package.
 *
 * @param value - The string to mask.
 * @returns The masked string (e.g. `'***1234'`).
 */
function mask(value: string): string {
  if (value.length <= 4) return value;
  return `***${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 1. Validate Inputs
// ---------------------------------------------------------------------------

/**
 * Validate all deployment inputs synchronously.
 *
 * Exits with code 1 on the first validation failure, printing
 * actionable guidance for each problem.
 */
function validateInputs(): void {
  logger.header('Validate Deployment Inputs');

  let valid = true;

  // Stack name
  if (!stackName) {
    logger.error('stack-name is required');
    valid = false;
  }

  // Environment
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    logger.error(`Invalid environment: ${environment}`);
    logger.info(`Valid environments: ${VALID_ENVIRONMENTS.join(', ')}`);
    logger.blank();
    logger.info('Note: This action is for deploying to target environments.');
    logger.info('For CI/CD pipeline validation, use CDK synth directly.');
    valid = false;
  }

  // AWS account ID format (12-digit number)
  if (!/^\d{12}$/.test(accountId)) {
    logger.error(`Invalid AWS account ID format: ${accountId}`);
    logger.info('Expected: 12-digit number');
    valid = false;
  }

  // AWS region format
  if (!/^[a-z]{2}-[a-z]+-\d{1}$/.test(region)) {
    logger.error(`Invalid AWS region format: ${region}`);
    logger.info('Expected format: eu-west-1, us-east-1, etc.');
    valid = false;
  }

  // require-approval value
  if (!VALID_APPROVALS.includes(requireApproval)) {
    logger.error(`Invalid require-approval: ${requireApproval}`);
    logger.info(`Valid values: ${VALID_APPROVALS.join(', ')}`);
    valid = false;
  }

  if (!valid) {
    process.exit(1);
  }

  logger.success('Input validation passed');
  logger.blank();
  logger.info('Deployment Configuration:');
  logger.keyValue('Stack Name', stackName);
  logger.keyValue('Project', project);
  logger.keyValue('Environment', environment);
  logger.keyValue('Account ID', mask(accountId));
  logger.keyValue('Region', region);
  logger.keyValue('Approval', requireApproval);
}

// ---------------------------------------------------------------------------
// 2. Verify AWS Credentials
// ---------------------------------------------------------------------------

/**
 * Verify AWS credentials by calling `sts:GetCallerIdentity`.
 *
 * Exits with code 1 if credentials are invalid or unavailable,
 * printing troubleshooting steps.
 */
async function verifyCredentials(): Promise<void> {
  logger.blank();
  logger.header('Verify AWS Credentials');

  const sts = new STSClient({ region });

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const currentAccount = identity.Account ?? '';

    logger.success(`Authenticated to AWS account: ${mask(currentAccount)}`);

    if (currentAccount !== accountId) {
      logger.blank();
      logger.warn(
        `Current account (${mask(currentAccount)}) differs from target (${mask(accountId)})`,
      );
      logger.info(
        'This may be expected for cross-account deployments via AssumeRole',
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Cannot retrieve AWS account information');
    logger.info(`AWS error: ${message}`);
    logger.blank();
    logger.info('Troubleshooting:');
    logger.info('  1. Verify AWS credentials are configured');
    logger.info('  2. Check IAM role trust policy allows GitHub OIDC');
    logger.info('  3. Ensure role has sts:GetCallerIdentity permission');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 3. Verify CDK Bootstrap (optional)
// ---------------------------------------------------------------------------

/**
 * Verify that the CDKToolkit bootstrap stack exists and is healthy.
 *
 * Exits with code 1 if the stack is missing or in an unhealthy state,
 * printing the bootstrap command to run.
 */
async function verifyCdkBootstrap(): Promise<void> {
  logger.blank();
  logger.header('Verify CDK Bootstrap');

  logger.keyValue('Account', mask(accountId));
  logger.keyValue('Region', region);
  logger.blank();

  const cfn = new CloudFormationClient({ region });
  const bootstrapStack = 'CDKToolkit';

  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: bootstrapStack }),
    );

    const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';

    if (!status.includes('COMPLETE')) {
      logger.error('CDK bootstrap stack is not in a healthy state');
      logger.keyValue('Status', status);
      process.exit(1);
    }

    logger.success(`CDK bootstrap verified: ${status}`);
  } catch {
    logger.error('CDK bootstrap stack not found');
    logger.blank();
    logger.info('Please bootstrap the CDK environment:');
    logger.info(`  cdk bootstrap aws://${accountId}/${region}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. Validate inputs (synchronous — exits on failure)
  validateInputs();

  // 2. Verify AWS credentials (exits on failure)
  await verifyCredentials();

  // 3. Optionally verify CDK bootstrap (exits on failure)
  if (verifyBootstrap) {
    await verifyCdkBootstrap();
  }

  logger.blank();
  logger.success('All pre-flight checks passed');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
