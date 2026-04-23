#!/usr/bin/env npx tsx
/**
 * Deployment Failure Report
 *
 * Aggregates diagnostics from multiple sources when a pipeline deployment fails.
 * Runs as a post-failure hook in the `deployment-failure-alert` job.
 *
 * Diagnostics collected:
 *   1. Deployment context — environment, commit, per-job results
 *   2. CloudFormation failed events — across all stacks (paginated)
 *   3. K8s pod diagnostics via SSM — non-Running pods
 *   4. EC2 boot logs from CloudWatch — last 15 minutes
 *   5. Quick links + "roll forward" guidance
 *
 * All output is written to $GITHUB_STEP_SUMMARY and console.
 *
 * Usage:
 *   npx tsx deployment-failure-report.ts \
 *     --stacks "Stack1,Stack2,Stack3" \
 *     [--region <region>] [--ssm-prefix <prefix>]
 *
 * Environment variables (set by workflow):
 *   DEPLOY_ENVIRONMENT  — environment name (e.g. staging)
 *   COMMIT_SHA          — commit being deployed
 *   JOB_RESULTS         — JSON map of job name → result
 *   RUN_URL             — GitHub Actions run URL
 *   COMMIT_URL          — GitHub commit URL
 *
 * Exit codes: always 0 (diagnostic-only — never masks the real failure).
 */

import { parseArgs } from 'util';

import {
    CloudFormationClient,
    paginateDescribeStackEvents,
} from '@aws-sdk/client-cloudformation';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    GetCommandInvocationCommand,
    GetParameterCommand,
    SSMClient,
    SendCommandCommand,
} from '@aws-sdk/client-ssm';
import { emitAnnotation, maskSecret, writeSummary } from '../utils/github.js';
import logger from '../utils/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        stacks: {
            type: 'string',
            default: process.env.STACKS ?? '',
        },
        region: {
            type: 'string',
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
        'ssm-prefix': {
            type: 'string',
            default: process.env.SSM_PREFIX ?? '',
        },
    },
});

const stackNames = (values.stacks ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const region = values.region!;
const ssmPrefix = values['ssm-prefix'] ?? '';

if (stackNames.length === 0) {
    console.error(
        'Usage: deployment-failure-report.ts --stacks "Stack1,Stack2" [--region <region>] [--ssm-prefix <prefix>]',
    );
    process.exit(0);
}

// =============================================================================
// Environment variables (from workflow)
// =============================================================================
const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? 'unknown';
const commitSha = process.env.COMMIT_SHA ?? 'unknown';
const runUrl = process.env.RUN_URL ?? '';
const commitUrl = process.env.COMMIT_URL ?? '';

interface JobResults {
    [key: string]: string;
}

let jobResults: JobResults = {};
try {
    jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}') as JobResults;
} catch {
    logger.warn('Could not parse JOB_RESULTS — skipping job results table');
}

// =============================================================================
// AWS Clients
// =============================================================================
const cfn = new CloudFormationClient({ region });
const ssm = new SSMClient({ region });
const cwl = new CloudWatchLogsClient({ region });

// =============================================================================
// Constants
// =============================================================================
const FAILURE_STATUSES = new Set([
    'CREATE_FAILED',
    'UPDATE_FAILED',
    'DELETE_FAILED',
]);

const SSM_COMMAND_WAIT_MS = 15_000;
const BOOT_LOG_LOOKBACK_MS = 15 * 60 * 1000; // 15 minutes

// =============================================================================
// 1. Deployment Context Header
// =============================================================================
function buildContextHeader(): string {
    const lines: string[] = [];

    lines.push('## Deployment Failure Report');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| **Environment** | ${deployEnvironment} |`);
    lines.push(`| **Commit** | \`${commitSha}\` |`);

    for (const [job, result] of Object.entries(jobResults)) {
        const label = job
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        lines.push(`| **${label}** | ${result} |`);
    }

    lines.push('');
    return lines.join('\n');
}

// =============================================================================
// 2. CloudFormation Failed Events (multi-stack)
// =============================================================================
interface FailedEvent {
    stack: string;
    logicalId: string;
    resourceType: string;
    status: string;
    reason: string;
    timestamp: string;
}

async function getFailedEventsForStack(
    stackName: string,
): Promise<FailedEvent[]> {
    const events: FailedEvent[] = [];

    try {
        const paginator = paginateDescribeStackEvents(
            { client: cfn },
            { StackName: stackName },
        );

        for await (const page of paginator) {
            for (const e of page.StackEvents ?? []) {
                if (FAILURE_STATUSES.has(e.ResourceStatus ?? '')) {
                    events.push({
                        stack: stackName,
                        logicalId: e.LogicalResourceId ?? 'Unknown',
                        resourceType: e.ResourceType ?? 'Unknown',
                        status: e.ResourceStatus ?? 'Unknown',
                        reason: e.ResourceStatusReason ?? 'No reason provided',
                        timestamp: e.Timestamp?.toISOString() ?? 'Unknown',
                    });
                }
            }
        }
    } catch (err) {
        logger.warn(
            `Could not fetch events for ${stackName}: ${(err as Error).message}`,
        );
    }

    return events;
}

async function collectCfnDiagnostics(): Promise<string> {
    const lines: string[] = [];
    lines.push('### CloudFormation Failed Events');
    lines.push('');

    for (const stackName of stackNames) {
        lines.push(`#### \`${stackName}\``);

        const events = await getFailedEventsForStack(stackName);

        if (events.length > 0) {
            lines.push('');
            lines.push(
                '| Timestamp | Resource | Type | Reason |',
            );
            lines.push(
                '|-----------|----------|------|--------|',
            );
            for (const e of events) {
                lines.push(
                    `| ${e.timestamp} | \`${e.logicalId}\` | ${e.resourceType} | ${e.reason} |`,
                );
            }

            // Emit GitHub annotations for failed resources
            for (const e of events) {
                emitAnnotation(
                    'error',
                    `[${stackName}] ${e.resourceType} ${e.logicalId}: ${e.reason}`,
                    `CFN ${e.status}`,
                );
            }
        } else {
            lines.push('[PASS] No failed events');
        }

        lines.push('');
    }

    return lines.join('\n');
}

// =============================================================================
// 3. K8s Diagnostics via SSM
// =============================================================================
async function collectK8sDiagnostics(): Promise<string> {
    const lines: string[] = [];

    // Resolve instance ID from SSM parameter
    let instanceId = '';
    try {
        const response = await ssm.send(
            new GetParameterCommand({
                Name: `${ssmPrefix}/instance-id`,
            }),
        );
        instanceId = response.Parameter?.Value ?? '';
        if (instanceId) {
            maskSecret(instanceId);
        }
    } catch {
        logger.warn('Could not resolve instance ID from SSM — skipping K8s diagnostics');
    }

    if (!instanceId) {
        lines.push('### K8s Diagnostics');
        lines.push('_Could not resolve instance ID — skipping_');
        lines.push('');
        return lines.join('\n');
    }

    lines.push('### K8s Pod Status (non-Running)');

    try {
        // Send kubectl command via SSM
        const sendResponse = await ssm.send(
            new SendCommandCommand({
                InstanceIds: [instanceId],
                DocumentName: 'AWS-RunShellScript',
                Parameters: {
                    commands: [
                        'sudo kubectl get pods -A --field-selector=status.phase!=Running -o wide 2>/dev/null || echo "No kubectl access"',
                    ],
                },
            }),
        );

        const commandId = sendResponse.Command?.CommandId;
        if (!commandId) {
            lines.push('_Could not send SSM command_');
            lines.push('');
            return lines.join('\n');
        }

        // Wait for command to complete
        logger.info(
            `Waiting ${SSM_COMMAND_WAIT_MS / 1000}s for SSM command to complete...`,
        );
        await new Promise((resolve) =>
            setTimeout(resolve, SSM_COMMAND_WAIT_MS),
        );

        // Retrieve command output
        const invocationResponse = await ssm.send(
            new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId,
            }),
        );

        const podOutput =
            invocationResponse.StandardOutputContent ??
            'Could not retrieve pod status';

        lines.push('```');
        lines.push(podOutput);
        lines.push('```');
    } catch (err) {
        logger.warn(
            `K8s diagnostics failed: ${(err as Error).message}`,
        );
        lines.push('_SSM command failed — could not retrieve pod status_');
    }

    lines.push('');
    return lines.join('\n');
}

// =============================================================================
// 4. CloudWatch Boot Logs
// =============================================================================
async function collectBootLogs(): Promise<string> {
    const lines: string[] = [];
    const cdkEnv =
        process.env.CDK_ENV ?? deployEnvironment.toLowerCase();
    const logGroup = `/ec2/k8s-${cdkEnv}/instances`;
    const startTime = Date.now() - BOOT_LOG_LOOKBACK_MS;

    lines.push('### EC2 Boot Logs (last 15 minutes)');
    lines.push('');

    try {
        const response = await cwl.send(
            new FilterLogEventsCommand({
                logGroupName: logGroup,
                startTime,
            }),
        );

        const events = response.events ?? [];

        if (events.length > 0) {
            lines.push('```');
            for (const event of events) {
                const ts = event.timestamp
                    ? new Date(event.timestamp).toISOString()
                    : '?';
                const stream = event.logStreamName ?? '?';
                const msg = event.message ?? '';
                lines.push(`[${ts}] [${stream}] ${msg}`);
            }
            lines.push('```');
        } else {
            lines.push(
                '_No boot log events found in the last 15 minutes_',
            );
        }
    } catch (err) {
        logger.warn(
            `Could not fetch boot logs: ${(err as Error).message}`,
        );
        lines.push(
            '_Could not fetch boot logs — check CloudWatch_',
        );
    }

    lines.push('');
    return lines.join('\n');
}

// =============================================================================
// 5. Quick Links + Guidance
// =============================================================================
function buildQuickLinks(): string {
    const lines: string[] = [];

    lines.push('### Quick Links');
    lines.push('');

    if (runUrl) {
        lines.push(`- **[Failed Run Logs](${runUrl})**`);
    }
    if (commitUrl) {
        lines.push(`- **[Commit](${commitUrl})**`);
    }

    lines.push('');
    lines.push(
        '> **Do not run automated CFn rollbacks on K8s/GitOps infrastructure.**',
    );
    lines.push(
        '> Prefer "roll forward" — push a fix commit to trigger a new deployment.',
    );

    return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Deployment Failure Report');
    logger.keyValue('Environment', deployEnvironment);
    logger.keyValue('Commit', commitSha);
    logger.keyValue('Region', region);
    logger.keyValue('Stacks', stackNames.join(', '));
    logger.blank();

    const sections: string[] = [];

    // 1. Context header
    logger.task('Building deployment context...');
    sections.push(buildContextHeader());

    // 2. CloudFormation diagnostics
    logger.task('Collecting CloudFormation diagnostics...');
    sections.push(await collectCfnDiagnostics());

    // 3. K8s diagnostics (only if SSM prefix is provided)
    if (ssmPrefix) {
        logger.task('Collecting K8s diagnostics via SSM...');
        sections.push(await collectK8sDiagnostics());
    }

    // 4. Boot logs
    logger.task('Fetching CloudWatch boot logs...');
    sections.push(await collectBootLogs());

    // 5. Quick links
    sections.push(buildQuickLinks());

    // Write combined summary
    writeSummary(sections.join('\n'));

    // Emit error annotation
    emitAnnotation(
        'error',
        `Deployment verification failed for ${deployEnvironment}. Check the Deployment Failure Report in the job summary for diagnostics.`,
    );

    logger.blank();
    logger.info('Failure report complete');
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failure report error: ${message}`);
    // Never fail — this is a diagnostic-only hook
    process.exit(0);
});
