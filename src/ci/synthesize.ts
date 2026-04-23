#!/usr/bin/env npx tsx
/**
 * Synthesize CI Script
 *
 * Runs CDK synth for a project and outputs stack names + metadata
 * for GitHub Actions workflows. Replaces inline bash in CI workflows.
 *
 * Usage:
 *   npx tsx scripts/deployment/synthesize-ci.ts kubernetes development
 *   npx tsx scripts/deployment/synthesize-ci.ts bedrock staging
 *
 * Outputs (via `$GITHUB_OUTPUT`):
 *   `timestamp`, `architecture`, and per-stack names (e.g., `data`, `base`)
 *
 * Side effects:
 *   - Runs `cdk synth` and writes templates to `cdk.out/`
 *   - Writes `synthesis-metadata.json` to `cdk.out/`
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { parseArgs } from 'util';

import { setOutput } from '../utils/github.js';
import logger from '../utils/logger.js';

import { buildCdkArgs, runCdk, getCdkProjectRoot } from '../shared/exec.js';
import { getProject, projectsMap, type Environment } from '../utils/stacks.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {},
});

const [projectId, environment] = positionals as [string, Environment];

if (!projectId || !environment) {
  console.error('Usage: synthesize-ci.ts <project> <environment>');
  console.error(`  Projects: ${Object.keys(projectsMap).join(', ')}`);
  console.error('  Environments: development, staging, production, management');
  console.error('\n  Synth-time values (domain, secrets, etc.) come from:');
  console.error('    - Typed config files: lib/config/*/configurations.ts');
  console.error('    - Environment variables: bridged via app.ts');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const stacksConfigPath =
    process.env.CDK_STACKS_CONFIG ??
    require('path').join(process.cwd(), 'scripts', 'shared', 'stacks.js');
  try {
    require(stacksConfigPath);
  } catch {
    // stacks config required — will fail below on getProject() if absent
  }

  const project = getProject(projectId);
  if (!project) {
    console.error(
      `Unknown project: ${projectId}. Ensure CDK_STACKS_CONFIG is set or scripts/shared/stacks.js exists.`,
    );
    process.exit(1);
  }

  logger.setEnvironment(environment);
  logger.header(`Synthesize ${project.name} (${environment})`);

  // Build CDK context (only project + environment; everything else is in typed config + env vars)
  const context = project.cdkContext(environment);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  // 1. Run CDK synth
  logger.task('Running CDK synth...');
  const synthArgs = buildCdkArgs({
    command: 'synth',
    all: true,
    context,
    quiet: true,
  });

  const result = await runCdk(synthArgs);
  if (result.exitCode !== 0) {
    logger.error('CDK synth failed');
    process.exit(1);
  }
  logger.success('CDK synth completed');

  // 2. Write synthesis metadata (async I/O)
  const commitSha = process.env.GITHUB_SHA ?? 'local';
  const shortSha = commitSha.slice(0, 8);
  const awsRegion = process.env.AWS_REGION ?? 'eu-west-1';

  const metadata = {
    commitSha,
    shortSha,
    timestamp,
    environment,
    region: awsRegion,
    project: projectId,
    stackCount: project.stacks.length,
    architecture: `consolidated-${project.stacks.length}-stack`,
  };

  const cdkOutPath = join(
    getCdkProjectRoot(),
    'cdk.out',
    'synthesis-metadata.json',
  );
  await writeFile(cdkOutPath, JSON.stringify(metadata, null, 2));
  logger.success('Wrote synthesis-metadata.json');
  logger.debug(`Metadata: ${JSON.stringify(metadata)}`);

  // 3. Output stack names for downstream jobs
  logger.task('Stack names:');
  for (const stack of project.stacks) {
    const stackName = stack.getStackName(environment);
    setOutput(stack.id, stackName);
    logger.keyValue(stack.id, stackName);
    logger.listItem(`${stack.name}: ${stackName}`);
  }

  // 4. Output metadata
  setOutput('timestamp', timestamp);
  setOutput('architecture', metadata.architecture);

  logger.blank();
  logger.success(
    `Synthesis complete: ${project.stacks.length} stacks for ${environment}`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
