#!/usr/bin/env npx tsx
/**
 * CloudWatch Log Group Audit
 *
 * Scans all CloudWatch log groups in the target region and reports those
 * with zero log streams (empty / orphaned groups). Produces a GitHub
 * Step Summary table for pipeline visibility.
 *
 * Informational only — always exits 0, never blocks deployment.
 *
 * Usage:
 *   npx tsx scripts/ci/log-group-audit.ts --region eu-west-1
 */

import { parseArgs } from 'util';

import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
    type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    emitAnnotation,
    setOutput,
    writeSummary,
} from '../utils/github.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        region: {
            type: 'string',
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
    },
});

const region = values.region!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AuditedLogGroup {
    name: string;
    createdAt: Date | undefined;
    storedBytes: number;
    retentionDays: number | undefined;
    hasStreams: boolean;
}

// ---------------------------------------------------------------------------
// AWS API helpers
// ---------------------------------------------------------------------------
const cwl = new CloudWatchLogsClient({ region });

/** Paginate through all log groups in the region. */
async function getAllLogGroups(): Promise<LogGroup[]> {
    const groups: LogGroup[] = [];
    let nextToken: string | undefined;

    do {
        const resp = await cwl.send(
            new DescribeLogGroupsCommand({ nextToken, limit: 50 }),
        );
        if (resp.logGroups) groups.push(...resp.logGroups);
        nextToken = resp.nextToken;
    } while (nextToken);

    return groups;
}

/** Check if a log group has at least one log stream. Uses limit=1 for speed. */
async function hasLogStreams(logGroupName: string): Promise<boolean> {
    try {
        const resp = await cwl.send(
            new DescribeLogStreamsCommand({ logGroupName, limit: 1 }),
        );
        return (resp.logStreams?.length ?? 0) > 0;
    } catch {
        // Group may have been deleted between list and check
        return false;
    }
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------
async function auditLogGroups(): Promise<AuditedLogGroup[]> {
    const groups = await getAllLogGroups();
    logger.info(`Found ${groups.length} log group(s) in ${region}`);

    const results: AuditedLogGroup[] = [];

    for (const group of groups) {
        const name = group.logGroupName ?? '<unnamed>';
        const streams = await hasLogStreams(name);
        results.push({
            name,
            createdAt: group.creationTime
                ? new Date(group.creationTime)
                : undefined,
            storedBytes: group.storedBytes ?? 0,
            retentionDays: group.retentionInDays,
            hasStreams: streams,
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(d: Date | undefined): string {
    if (!d) return '—';
    return d.toISOString().slice(0, 10);
}

function buildSummaryMarkdown(results: AuditedLogGroup[]): string {
    const empty = results.filter((r) => !r.hasStreams);
    const active = results.filter((r) => r.hasStreams);

    const lines: string[] = [
        '## 📋 CloudWatch Log Group Audit',
        '',
        `**Region**: \`${region}\``,
        `**Total**: ${results.length} log group(s)`,
        `**Active** (has streams): ${active.length}`,
        `**Empty** (no streams): ${empty.length}`,
        '',
    ];

    if (empty.length > 0) {
        lines.push(
            '### ⚠️ Empty Log Groups (no log streams)',
            '',
            '> These groups exist but have never received logs. They may be safe to delete.',
            '',
            '| Log Group | Created | Stored | Retention |',
            '|-----------|---------|--------|-----------|',
        );

        for (const g of empty.sort((a, b) => a.name.localeCompare(b.name))) {
            const retention = g.retentionDays
                ? `${g.retentionDays}d`
                : 'Never';
            lines.push(
                `| \`${g.name}\` | ${formatDate(g.createdAt)} | ${formatBytes(g.storedBytes)} | ${retention} |`,
            );
        }
        lines.push('');
    }

    if (active.length > 0) {
        lines.push(
            '<details>',
            '<summary>✅ Active Log Groups (click to expand)</summary>',
            '',
            '| Log Group | Created | Stored | Retention |',
            '|-----------|---------|--------|-----------|',
        );

        for (const g of active.sort((a, b) => a.name.localeCompare(b.name))) {
            const retention = g.retentionDays
                ? `${g.retentionDays}d`
                : 'Never';
            lines.push(
                `| \`${g.name}\` | ${formatDate(g.createdAt)} | ${formatBytes(g.storedBytes)} | ${retention} |`,
            );
        }
        lines.push('', '</details>');
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    logger.header(`CloudWatch Log Group Audit — ${region}`);

    const results = await auditLogGroups();
    const empty = results.filter((r) => !r.hasStreams);
    const active = results.filter((r) => r.hasStreams);

    // Write GitHub Step Summary + always print to stdout for pipeline log visibility
    const md = buildSummaryMarkdown(results);
    writeSummary(md);
    console.log(md);

    if (process.env.GITHUB_STEP_SUMMARY) {
        logger.success('Wrote log audit summary to $GITHUB_STEP_SUMMARY');
    }

    // Outputs
    setOutput('total_groups', String(results.length));
    setOutput('empty_groups', String(empty.length));
    setOutput('active_groups', String(active.length));

    if (empty.length > 0) {
        emitAnnotation(
            'warning',
            `${empty.length} CloudWatch log group(s) have no log streams and may be orphaned`,
        );
        logger.warn(
            `${empty.length} empty log group(s) found — review the step summary for details`,
        );
    } else {
        logger.success('All log groups have at least one log stream');
    }

    logger.blank();
    logger.info(
        `Results: ${active.length} active, ${empty.length} empty out of ${results.length} total`,
    );
}

main().catch((err) => {
    logger.error(`Fatal: ${err.message}`);
    // Always exit 0 — audit is informational
});
