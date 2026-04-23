/**
 * Stack Configuration — Shared Types & Utilities
 *
 * Pipeline-facing types, interfaces, and lookup functions for
 * multi-project CDK infrastructure. This module is CDK-agnostic;
 * actual stack definitions (with `getStackName` lambdas) live in
 * `infra/scripts/deployment/stacks.ts` and register themselves here.
 *
 * Design decisions:
 *   - projectsMap uses Record<string, ProjectConfig> for O(1) lookups
 *   - getEffectiveStacks uses dynamic key lookup (no hardcoded if/else)
 *   - registerProject() lets the CDK layer populate stack data at runtime
 */

// =============================================================================
// Types
// =============================================================================

/** Valid deployment environments for all CDK projects. */
export type Environment = 'development' | 'staging' | 'production';

/**
 * Describes a single CDK stack within a project.
 *
 * Each stack has a unique `id` used for CLI references and a `getStackName`
 * lambda that resolves the full CloudFormation stack name for a given
 * environment.
 */
export interface StackConfig {
  /** Short identifier for CLI (e.g., 'vpc', 'ecr') */
  id: string;
  /** Display name */
  name: string;
  /** Full CDK stack name resolver */
  getStackName: (env: Environment) => string;
  /** Human-readable description */
  description: string;
  /** Stack IDs this depends on (for deploy order) */
  dependsOn?: string[];
  /** If true, requires extra context (e.g., CloudFront) */
  optional?: boolean;
  /** Context keys required for this stack */
  requiredContext?: string[];
  /** Override deployment region (e.g., 'us-east-1' for Edge) */
  region?: string;
}

/**
 * Extra context variables for optional stacks.
 * Cross-account CloudFront requires all of these.
 */
export interface ExtraContext {
  // CloudFront/Edge context
  domainName?: string;
  hostedZoneId?: string;
  subjectAlternativeNames?: string[];
  /** Cross-account IAM role ARN for Route53 access */
  crossAccountRoleArn?: string;
  // Org project context
  /** Route53 hosted zone IDs to allow access to (comma-separated) */
  hostedZoneIds?: string;
  /** Trusted AWS account IDs (comma-separated) */
  trustedAccountIds?: string;
  /** External ID for additional security */
  externalId?: string;
  /** Generic additional context key-value pairs */
  additionalContext?: Record<string, string>;
}

/**
 * Describes a CDK project containing one or more stacks.
 *
 * Projects are registered into {@link projectsMap} at import time by
 * the CDK layer (`infra/scripts/deployment/stacks.ts`).
 */
export interface ProjectConfig {
  id: string;
  name: string;
  description: string;
  stacks: StackConfig[];
  cdkContext: (
    env: Environment,
    extra?: ExtraContext,
  ) => Record<string, string>;
}

// =============================================================================
// Project Registry — O(1) Record Map
// =============================================================================

/**
 * Mutable project registry. CDK-layer code calls `registerProject()` to
 * populate this map with actual stack definitions at import time.
 */
export const projectsMap: Record<string, ProjectConfig> = {};

/**
 * Register a project into the shared registry.
 *
 * Called by `infra/scripts/deployment/stacks.ts` at module load time.
 * Each call adds (or overwrites) the project keyed by {@link ProjectConfig.id}.
 *
 * @param config - The full project configuration to register.
 *
 * @example
 * ```ts
 * registerProject({
 *   id: 'kubernetes',
 *   name: 'Kubernetes',
 *   description: 'Self-managed K8s cluster',
 *   stacks: k8sStacks,
 *   cdkContext: (env) => ({ project: 'kubernetes', environment: env }),
 * });
 * ```
 */
export function registerProject(config: ProjectConfig): void {
  projectsMap[config.id] = config;
}

// =============================================================================
// Lookup Functions
// =============================================================================

/**
 * Look up a project by its unique identifier.
 *
 * Performs an O(1) record lookup instead of iterating an array.
 *
 * @param projectId - The project identifier (e.g. `'kubernetes'`, `'shared'`).
 * @returns The matching {@link ProjectConfig}, or `undefined` if not found.
 *
 * @example
 * ```ts
 * const project = getProject('kubernetes');
 * if (!project) throw new Error('Unknown project');
 * ```
 */
export function getProject(projectId: string): ProjectConfig | undefined {
  return projectsMap[projectId];
}

/**
 * Look up a single stack within a project.
 *
 * @param projectId - The project identifier (e.g. `'kubernetes'`).
 * @param stackId   - The stack short ID (e.g. `'controlPlane'`).
 * @returns The matching {@link StackConfig}, or `undefined` if not found.
 */
export function getStack(
  projectId: string,
  stackId: string,
): StackConfig | undefined {
  return projectsMap[projectId]?.stacks.find((s) => s.id === stackId);
}

/**
 * Return every stack registered under a project.
 *
 * @param projectId - The project identifier.
 * @returns An array of {@link StackConfig} objects (empty if project is unknown).
 */
export function getAllStacksForProject(projectId: string): StackConfig[] {
  return projectsMap[projectId]?.stacks ?? [];
}

/**
 * Return only the required (non-optional) stacks for a project.
 *
 * Optional stacks (e.g. CloudFront Edge) are excluded because they
 * need additional context to deploy.
 *
 * @param projectId - The project identifier.
 * @returns An array of required {@link StackConfig} objects.
 */
export function getRequiredStacksForProject(
  projectId: string,
): StackConfig[] {
  return getAllStacksForProject(projectId).filter((s) => !s.optional);
}

/**
 * Determine which stacks can be deployed given the available context.
 *
 * Required stacks are always included. Optional stacks are included only
 * when **every** key listed in {@link StackConfig.requiredContext} is
 * present (and truthy) in `extraContext`.
 *
 * Uses a dynamic index-signature lookup so adding a new key to
 * {@link ExtraContext} never requires a code change here.
 *
 * @param projectId    - The project identifier.
 * @param extraContext - Optional context bag (CloudFront domain, Org IDs, …).
 * @returns An object with `stacks` (deployable) and `skipped` (missing context).
 *
 * @example
 * ```ts
 * const { stacks, skipped } = getEffectiveStacks('kubernetes', {
 *   domainName: 'example.com',
 *   hostedZoneId: 'Z12345',
 *   crossAccountRoleArn: 'arn:aws:iam::role/dns',
 * });
 * ```
 */
export function getEffectiveStacks(
  projectId: string,
  extraContext?: ExtraContext,
): { stacks: StackConfig[]; skipped: StackConfig[] } {
  const allStacks = getAllStacksForProject(projectId);
  const stacks: StackConfig[] = [];
  const skipped: StackConfig[] = [];

  for (const stack of allStacks) {
    if (!stack.optional) {
      stacks.push(stack);
      continue;
    }

    // Dynamic context check — scales automatically with new ExtraContext keys
    const requiredContext = stack.requiredContext ?? [];
    const contextRecord = extraContext as
      | Record<string, unknown>
      | undefined;
    const hasAllContext = requiredContext.every(
      (key) => !!contextRecord?.[key],
    );

    if (hasAllContext) {
      stacks.push(stack);
    } else {
      skipped.push(stack);
    }
  }

  return { stacks, skipped };
}

/**
 * Check if a stack is the CloudFront/Edge stack.
 *
 * @param stackId - The stack short ID.
 * @returns `true` when `stackId` equals `'edge'`.
 */
export function isCloudFrontStack(stackId: string): boolean {
  return stackId === 'edge';
}

/**
 * Build a human-readable message listing the context keys a stack needs.
 *
 * @param stack - The stack configuration to inspect.
 * @returns A comma-separated list prefixed with `"Required context: "`,
 *          or an empty string when the stack has no requirements.
 */
export function getRequiredContextMessage(stack: StackConfig): string {
  if (!stack.requiredContext?.length) return '';
  return `Required context: ${stack.requiredContext.join(', ')}`;
}

// =============================================================================
// Default Configuration
// =============================================================================

/** Default configuration values for local development and CI fallbacks. */
export interface DefaultConfig {
  environment: Environment;
  awsProfile: string;
  awsRegion: string;
  awsAccountId?: string;
  outputDir: string;
  cdkOutDir: string;
}

export const defaults: DefaultConfig = {
  environment: 'development',
  awsProfile: 'dev-account',
  awsRegion: 'eu-west-1',
  outputDir: 'cdk-outputs',
  cdkOutDir: 'cdk.out',
};

/** Profile mapping for environments */
export const profileMap: Record<Environment, string> = {
  development: 'dev-account',
  staging: 'staging-account',
  production: 'prod-account',
};
