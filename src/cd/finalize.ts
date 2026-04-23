#!/usr/bin/env npx tsx
/**
 * Finalize Deployment Script
 *
 * Single post-deploy hook that handles all CDK deployment finalization.
 * Operates in two modes selected by `--mode`:
 *
 * **stack-outputs** (default):
 *   Per-stack CDK output collection, GHA output emission, step summary,
 *   and artifact file save. Called once per stack in the deploy matrix.
 *
 *   Usage:
 *     npx tsx finalize-deployment.ts <stack-name> --mode stack-outputs \
 *       --deploy-status <status> --environment <env> --region <region> \
 *       --account-id <id> [--deploy-duration <s>] [--outputs-dir <dir>]
 *
 * **pipeline-summary**:
 *   Project-wide post-deploy verification and summary generation.
 *   Verifies all CloudFormation stack statuses, generates a step summary
 *   with per-stack results, and outputs SSM access commands.
 *
 *   Usage:
 *     npx tsx finalize-deployment.ts <project> <environment> \
 *       --mode pipeline-summary [--region <region>]
 *
 * Exit codes:
 *   stack-outputs mode:    0 always (informational, never blocks pipeline)
 *   pipeline-summary mode: 1 if any stack is unhealthy
 */

import { existsSync } from "fs";
import { copyFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { parseArgs } from "util";

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from "@aws-sdk/client-auto-scaling";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  readStackOutputs,
  CDK_OUTPUTS_FILE,
  type StackOutput,
} from "../utils/cdk.js";
import { setOutput, writeSummary } from "../utils/github.js";
import logger, { LogLevel } from "../utils/logger.js";
import { resolveWorkspacePath } from "../utils/paths.js";

import {
  getProject,
  type Environment,
  type StackConfig,
} from "../utils/stacks.js";

// =============================================================================
// CLI argument parsing
// =============================================================================
const { positionals, values: flags } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "stack-outputs" },
    "deploy-status": { type: "string", default: "" },
    environment: { type: "string", default: "" },
    region: { type: "string", default: process.env.AWS_REGION || "eu-west-1" },
    "account-id": { type: "string", default: "" },
    "deploy-duration": { type: "string", default: "" },
    "outputs-dir": { type: "string", default: "" },
  },
});

const mode = flags.mode as "stack-outputs" | "pipeline-summary";

// =============================================================================
// Shared Helpers
// =============================================================================

/** Mask all but last 4 chars of a sensitive string */
function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  return `***${value.slice(-4)}`;
}

/** @deprecated Use {@link maskValue} — kept as alias for backward compat */
const maskAccountId = maskValue;

// =============================================================================
// Mode: stack-outputs
// =============================================================================

/** Sanitise stack name for use in filenames */
function sanitiseForFilename(name: string): string {
  return name.replace(/[/:]/g, "-");
}

/** Emit stack outputs to $GITHUB_OUTPUT (values stay in GHA, not in public logs) */
function emitGitHubOutputs(outputs: StackOutput[]): void {
  const json = JSON.stringify(outputs);
  setOutput("stack_outputs", json);

  if (outputs.length > 0) {
    logger.success(`Retrieved ${outputs.length} stack output(s)`);
    logger.blank();
    // Log only keys — values contain infrastructure identifiers
    // that must not appear in public workflow logs.
    // Full values remain accessible in $GITHUB_OUTPUT for downstream steps.
    for (const o of outputs) {
      logger.keyValue(o.OutputKey, maskValue(o.OutputValue));
    }
  } else {
    logger.info("No stack outputs to emit");
  }
}

/** Build and write per-stack summary to $GITHUB_STEP_SUMMARY */
function buildStackSummary(
  stackName: string,
  outputs: StackOutput[],
  deployStatus: string,
  environment: string,
  region: string,
  accountId: string,
  deployDuration: string,
): void {
  const lines: string[] = [];

  lines.push("## CDK Stack Deployment");
  lines.push("");
  lines.push(`**Stack**: \`${stackName}\``);
  lines.push(`**Environment**: ${environment}`);
  lines.push(`**Region**: ${region}`);
  lines.push(`**Account**: \`${maskAccountId(accountId)}\``);
  lines.push("");

  if (deployStatus === "success") {
    lines.push("### Status: ✓ Success");
    lines.push("");
    lines.push(
      deployDuration
        ? `Deployment completed in ${deployDuration}s`
        : "Deployment completed successfully",
    );

    if (outputs.length > 0) {
      lines.push("");
      lines.push("### Stack Outputs");
      lines.push("");
      // Mask values in step summary — defence-in-depth on public repos.
      // Contributors with repo access can see step summaries.
      for (const o of outputs) {
        lines.push(`- **${o.OutputKey}**: \`${maskValue(o.OutputValue)}\``);
      }
    }
  } else {
    lines.push("### Status: ✗ Failed");
    lines.push("");
    lines.push(
      deployDuration
        ? `Deployment failed after ${deployDuration}s`
        : "Deployment failed",
    );
    lines.push("");
    lines.push("Check deployment logs for details.");
  }

  const summary = lines.join("\n") + "\n";
  writeSummary(summary);
  logger.success("Wrote deployment summary to $GITHUB_STEP_SUMMARY");
}

/** Save outputs to artifact file */
async function saveOutputsToFile(
  outputs: StackOutput[],
  stackName: string,
  deployStatus: string,
  outputsDir: string,
): Promise<void> {
  if (!outputsDir) {
    logger.debug("No --outputs-dir provided, skipping file save");
    return;
  }

  const absoluteDir = resolveWorkspacePath(outputsDir);

  logger.task(`Creating outputs directory: ${absoluteDir}`);
  await mkdir(absoluteDir, { recursive: true });

  if (!existsSync(absoluteDir)) {
    logger.error("Failed to create outputs directory");
    return;
  }
  logger.success("Outputs directory created");

  if (deployStatus !== "success") {
    logger.warn("Deployment did not succeed, skipping output file save");
    logger.info("Directory created for artifact upload consistency");
    return;
  }

  const safeStackName = sanitiseForFilename(stackName);
  const outputFile = join(absoluteDir, `${safeStackName}-outputs.json`);

  if (existsSync(CDK_OUTPUTS_FILE)) {
    await copyFile(CDK_OUTPUTS_FILE, outputFile);
    setOutput("file_path", outputFile);
    logger.success(`Outputs saved to: ${outputFile}`);
  } else if (outputs.length > 0) {
    await writeFile(outputFile, JSON.stringify(outputs, null, 2));
    setOutput("file_path", outputFile);
    logger.success(`Outputs saved to: ${outputFile}`);
  } else {
    logger.warn("No outputs to save");
  }
}

/** Main entry for stack-outputs mode */
async function runStackOutputs(): Promise<void> {
  const stackName = positionals[0];
  const deployStatus = flags["deploy-status"] ?? "";
  const environment = flags.environment ?? "";
  const region = flags.region ?? "";
  const accountId = flags["account-id"] ?? "";
  const deployDuration = flags["deploy-duration"] ?? "";
  const outputsDir = flags["outputs-dir"] ?? "";

  if (!stackName) {
    console.error(
      "Usage: finalize-deployment.ts <stack-name> --mode stack-outputs " +
        "--deploy-status <status> --environment <env> --region <region> " +
        "--account-id <id> [--deploy-duration <s>] [--outputs-dir <dir>]",
    );
    process.exit(0);
  }

  logger.header(`Finalize Deployment — ${stackName}`);
  logger.keyValue("Stack", stackName);
  logger.keyValue("Environment", environment || "unknown");
  logger.keyValue("Region", region || "unknown");
  logger.keyValue("Account", maskAccountId(accountId));
  logger.keyValue("Deploy Status", deployStatus || "unknown");
  logger.keyValue("Outputs Dir", outputsDir || "(none)");
  logger.blank();

  // Read CDK outputs — once
  let outputs: StackOutput[] = [];
  if (deployStatus === "success") {
    outputs = await readStackOutputs(stackName);
  } else {
    logger.info("Deployment did not succeed — skipping output retrieval");
  }

  // Step 1: Emit to $GITHUB_OUTPUT
  emitGitHubOutputs(outputs);
  logger.blank();

  // Step 2: Write $GITHUB_STEP_SUMMARY
  buildStackSummary(
    stackName,
    outputs,
    deployStatus,
    environment,
    region,
    accountId,
    deployDuration,
  );
  logger.blank();

  // Step 3: Save artifact file
  await saveOutputsToFile(outputs, stackName, deployStatus, outputsDir);

  logger.blank();
  logger.info("Deployment finalization complete");
}

// =============================================================================
// Mode: pipeline-summary
// =============================================================================

interface StackVerification {
  stack: StackConfig;
  stackName: string;
  status: string;
  healthy: boolean;
}

/** Read deployment result from environment variable */
function getResult(key: string, fallback = "skipped"): string {
  return process.env[key] ?? fallback;
}

/** Map a result string to an emoji */
function resultEmoji(result: string): string {
  switch (result) {
    case "success":
      return "✅";
    case "failure":
      return "❌";
    case "skipped":
      return "⏭️";
    case "cancelled":
      return "🚫";
    default:
      return "❓";
  }
}

/** Verify a single CloudFormation stack via DescribeStacks */
async function verifyStack(
  cfn: CloudFormationClient,
  stack: StackConfig,
  environment: Environment,
  defaultRegion: string,
): Promise<StackVerification> {
  const stackName = stack.getStackName(environment);
  // Use stack-specific region (e.g., us-east-1 for Edge) or fall back to default
  const client =
    stack.region && stack.region !== defaultRegion
      ? new CloudFormationClient({ region: stack.region })
      : cfn;
  try {
    const response = await client.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const status = response.Stacks?.[0]?.StackStatus ?? "UNKNOWN";
    const healthy = status.includes("COMPLETE") && !status.includes("ROLLBACK");
    return { stack, stackName, status, healthy };
  } catch {
    // Optional stacks (e.g., API) are healthy when NOT_FOUND
    const healthy = stack.optional === true;
    return { stack, stackName, status: "NOT_FOUND", healthy };
  }
}

/** Get SSM access commands for compute stacks */
async function getSSMAccessInfo(
  cfn: CloudFormationClient,
  asg: AutoScalingClient,
  stackName: string,
): Promise<void> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const outputs = response.Stacks?.[0]?.Outputs ?? [];

    // Look for ASG name in outputs
    const asgOutput = outputs.find((o) => o.OutputKey === "AsgName");
    if (asgOutput?.OutputValue) {
      const asgName = asgOutput.OutputValue;

      const asgResponse = await asg.send(
        new DescribeAutoScalingGroupsCommand({
          AutoScalingGroupNames: [asgName],
        }),
      );
      const instanceId =
        asgResponse.AutoScalingGroups?.[0]?.Instances?.[0]?.InstanceId;

      if (instanceId && logger.isEnabled(LogLevel.VERBOSE)) {
        logger.blank();
        logger.verbose("SSM Port Forwarding (ASG mode)");
        logger.verbose(`Instance: ${instanceId}`);
        logger.blank();
        logger.verboseKeyValue(
          "Grafana",
          `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'`,
        );
        logger.verboseKeyValue(
          "Prometheus",
          `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["9090"],"localPortNumber":["9090"]}'`,
        );
        logger.verboseKeyValue(
          "Loki",
          `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3100"],"localPortNumber":["3100"]}'`,
        );
      }
      return;
    }

    // Look for direct Instance ID in outputs
    const instanceOutput = outputs.find((o) => o.OutputKey === "InstanceId");
    if (instanceOutput?.OutputValue) {
      const instanceId = instanceOutput.OutputValue;
      if (logger.isEnabled(LogLevel.VERBOSE)) {
        logger.blank();
        logger.verbose("SSM Port Forwarding (Single Instance mode)");
        logger.verbose(`Instance: ${instanceId}`);
        logger.blank();
        logger.verboseKeyValue(
          "Grafana",
          `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `Could not retrieve SSM access info: ${(err as Error).message}`,
    );
  }
}

/** Main entry for pipeline-summary mode */
async function runPipelineSummary(): Promise<void> {
  const [projectId, env] = positionals as [string, Environment];
  const region = flags.region!;

  if (!projectId || !env) {
    console.error(
      "Usage: finalize-deployment.ts <project> <environment> --mode pipeline-summary [--region <region>]",
    );
    process.exit(1);
  }

  const _project = getProject(projectId);
  if (!_project) {
    console.error(`Unknown project: ${projectId}`);
    process.exit(1);
  }
  const project = _project;

  logger.setEnvironment(env);
  const cfn = new CloudFormationClient({ region });
  const asgClient = new AutoScalingClient({ region });

  // ── Phase 1: Verify all stacks via live DescribeStacks ──────────────
  logger.header(`Verify ${project.name} Deployment (${env})`);

  const results = await Promise.all(
    project.stacks.map((stack) => verifyStack(cfn, stack, env, region)),
  );

  const allHealthy = results.every((r) => r.healthy);

  logger.table(
    ["Stack", "CloudFormation Name", "Status"],
    results.map((r) => {
      const isOptionalNotFound = r.stack.optional && r.status === "NOT_FOUND";
      const prefix = isOptionalNotFound ? "⚠" : r.healthy ? "✓" : "✗";
      const suffix = isOptionalNotFound
        ? " (Optional — not deployed)"
        : r.stack.region
          ? ` (${r.stack.region})`
          : "";
      return [`${prefix} ${r.stack.name}`, r.stackName, `${r.status}${suffix}`];
    }),
  );

  // SSM access info for compute stacks
  const computeResult = results.find(
    (r) => r.stack.id === "compute" && r.healthy,
  );
  if (computeResult) {
    await getSSMAccessInfo(cfn, asgClient, computeResult.stackName);
  }

  // ── Phase 2: Generate pipeline-wide summary ─────────────────────────
  const commitSha =
    process.env.COMMIT_SHORT_SHA ??
    process.env.GITHUB_SHA?.slice(0, 8) ??
    "unknown";

  const stackRows = project.stacks.map((stack) => {
    const envKey = `DEPLOY_${stack.id.toUpperCase()}_RESULT`;
    const result = getResult(envKey);
    return `| ${stack.name} | ${stack.description} | ${resultEmoji(result)} ${result} |`;
  });

  const securityScan = getResult("SECURITY_SCAN_RESULT");
  const verify = getResult("VERIFY_RESULT");
  const smokeTests = getResult("SMOKE_TESTS_RESULT");
  const alert = getResult("ALERT_RESULT");

  const summary = `## ${project.name} Infrastructure Deployment

**Architecture**: Consolidated ${project.stacks.length}-Stack (Shared VPC)
**Environment**: ${env}
**Region**: ${region}
**Commit**: ${commitSha}

### Stack Deployment Status

| Stack | Description | Status |
|-------|-------------|--------|
${stackRows.join("\n")}

### Verification
- **Security Scan**: ${resultEmoji(securityScan)} ${securityScan}
- **Post-Deploy Verify**: ${resultEmoji(verify)} ${verify}
- **Smoke Tests**: ${resultEmoji(smokeTests)} ${smokeTests}
- **Failure Alert**: ${resultEmoji(alert)} ${alert}
`;

  writeSummary(summary);

  if (!process.env.GITHUB_STEP_SUMMARY) {
    console.log(summary);
  } else {
    logger.success("Wrote pipeline summary to $GITHUB_STEP_SUMMARY");
  }

  // ── Phase 3: Exit code ──────────────────────────────────────────────
  if (!allHealthy) {
    const failed = results.filter((r) => !r.healthy);
    logger.error(
      `${failed.length}/${results.length} stacks failed verification`,
    );
    process.exit(1);
  }

  logger.blank();
  logger.success(`All ${results.length} stacks verified successfully`);
}

// =============================================================================
// Main Router
// =============================================================================
async function main(): Promise<void> {
  // Load consumer stacks config — required for pipeline-summary mode
  const stacksConfigPath =
    process.env.CDK_STACKS_CONFIG ??
    require('path').join(process.cwd(), 'scripts', 'shared', 'stacks.js');
  try {
    require(stacksConfigPath);
  } catch {
    // OK for stack-outputs mode; pipeline-summary will fail on getProject() if absent
  }

  switch (mode) {
    case "pipeline-summary":
      await runPipelineSummary();
      break;
    case "stack-outputs":
    default:
      await runStackOutputs();
      break;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  // stack-outputs mode: never block pipeline; pipeline-summary: error already handled
  process.exit(mode === "pipeline-summary" ? 1 : 0);
});
