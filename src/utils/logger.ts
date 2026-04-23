/**
 * Logger Utility
 *
 * Styled console logging for deployment and operational scripts.
 * Shared across all monorepo subdirectories — import from scripts/util/logger.
 *
 * Log levels control verbosity per environment:
 *
 *   | Level   | Shown in prod/staging | Shown in dev |
 *   |---------|-----------------------|--------------|
 *   | error   | ✓                     | ✓            |
 *   | warn    | ✓                     | ✓            |
 *   | info    | ✓                     | ✓            |
 *   | verbose | ✗                     | ✓            |
 *   | debug   | ✗                     | ✓            |
 *
 * The level is determined by:
 *   1. LOG_LEVEL env var (explicit override)
 *   2. DEPLOY_ENVIRONMENT env var (auto: production/staging → info, else → debug)
 *   3. Fallback: debug (local development assumed)
 */

import chalk from 'chalk';

// =============================================================================
// Log Levels
// =============================================================================

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  VERBOSE = 3,
  DEBUG = 4,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  verbose: LogLevel.VERBOSE,
  debug: LogLevel.DEBUG,
};

/**
 * Resolve the active log level from environment.
 *
 * Priority:
 *   1. LOG_LEVEL env var (explicit)
 *   2. DEPLOY_ENVIRONMENT env var (production/staging → INFO, else → DEBUG)
 *   3. Default → DEBUG (local dev)
 */
function resolveLogLevel(): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (explicit && explicit in LOG_LEVEL_MAP) {
    return LOG_LEVEL_MAP[explicit];
  }

  const env = process.env.DEPLOY_ENVIRONMENT?.toLowerCase();
  if (env === 'production' || env === 'staging') {
    return LogLevel.INFO;
  }

  return LogLevel.DEBUG;
}

let currentLevel = resolveLogLevel();

// =============================================================================
// Logger
// =============================================================================

const logger = {
  // ---------------------------------------------------------------------------
  // Level management
  // ---------------------------------------------------------------------------

  /** Override the current log level programmatically */
  setLevel: (level: LogLevel): void => {
    currentLevel = level;
  },

  /** Get the current log level */
  getLevel: (): LogLevel => currentLevel,

  /**
   * Set log level from deployment environment string.
   * Call this early in main() after parsing the CLI environment arg:
   *
   *   logger.setEnvironment(environment);
   */
  setEnvironment: (environment: string): void => {
    // Respect explicit LOG_LEVEL override
    if (process.env.LOG_LEVEL) return;

    const env = environment.toLowerCase();
    if (env === 'production' || env === 'staging') {
      currentLevel = LogLevel.INFO;
    } else {
      currentLevel = LogLevel.DEBUG;
    }
  },

  /** Check if a given level would produce output */
  isEnabled: (level: LogLevel): boolean => level <= currentLevel,

  // ---------------------------------------------------------------------------
  // Core output (always shown: error, warn, success, header)
  // ---------------------------------------------------------------------------

  header: (message: string): void => {
    console.log();
    console.log(chalk.bold.cyan(`━━━ ${message} ━━━`));
    console.log();
  },

  success: (message: string): void => {
    console.log(chalk.green('✓'), message);
  },

  warn: (message: string): void => {
    console.log(chalk.yellow('⚠'), message);
  },

  error: (message: string): void => {
    console.log(chalk.red('✗'), message);
  },

  // ---------------------------------------------------------------------------
  // Info level (shown in dev + staging + prod)
  // ---------------------------------------------------------------------------

  info: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(chalk.blue('ℹ'), message);
    }
  },

  task: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(chalk.cyan('→'), message);
    }
  },

  keyValue: (key: string, value: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(`  ${chalk.dim(key + ':')} ${value}`);
    }
  },

  listItem: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(`  ${chalk.dim('•')} ${message}`);
    }
  },

  // ---------------------------------------------------------------------------
  // Verbose level (dev only — troubleshooting commands, access info)
  // ---------------------------------------------------------------------------

  /** Log troubleshooting info (SSM commands, access URLs, port forwarding) */
  verbose: (message: string): void => {
    if (currentLevel >= LogLevel.VERBOSE) {
      console.log(chalk.gray('⋯'), message);
    }
  },

  /** Log a key-value pair at verbose level */
  verboseKeyValue: (key: string, value: string): void => {
    if (currentLevel >= LogLevel.VERBOSE) {
      console.log(`  ${chalk.gray(key + ':')} ${value}`);
    }
  },

  // ---------------------------------------------------------------------------
  // Debug level (dev only — raw data dumps, metadata, internal state)
  // ---------------------------------------------------------------------------

  /** Log internal state for debugging */
  debug: (message: string): void => {
    if (currentLevel >= LogLevel.DEBUG) {
      console.log(chalk.gray('⊡'), chalk.dim(message));
    }
  },

  // ---------------------------------------------------------------------------
  // Colors (always shown — used for structured output like summaries)
  // ---------------------------------------------------------------------------

  green: (message: string): void => {
    console.log(chalk.green(message));
  },

  yellow: (message: string): void => {
    console.log(chalk.yellow(message));
  },

  red: (message: string): void => {
    console.log(chalk.red(message));
  },

  dim: (message: string): void => {
    console.log(chalk.dim(message));
  },

  blank: (): void => {
    console.log();
  },

  // ---------------------------------------------------------------------------
  // Complex formatters (box, table — level-aware)
  // ---------------------------------------------------------------------------

  /** Box for important messages (always shown) */
  box: (title: string, content: string[]): void => {
    console.log();
    console.log(chalk.cyan('┌─' + '─'.repeat(title.length + 2) + '─┐'));
    console.log(chalk.cyan('│ ') + chalk.bold(title) + chalk.cyan(' │'));
    console.log(chalk.cyan('├─' + '─'.repeat(title.length + 2) + '─┤'));
    content.forEach((line) => {
      const padding = ' '.repeat(Math.max(0, title.length - line.length + 2));
      console.log(chalk.cyan('│ ') + line + padding + chalk.cyan(' │'));
    });
    console.log(chalk.cyan('└─' + '─'.repeat(title.length + 2) + '─┘'));
    console.log();
  },

  /** Table for stack listings (always shown — essential deployment output) */
  table: (headers: string[], rows: string[][]): void => {
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || '').length))
    );

    const separator = colWidths.map((w) => '─'.repeat(w + 2)).join('┼');
    const headerRow = headers
      .map((h, i) => h.padEnd(colWidths[i]))
      .join(' │ ');

    console.log();
    console.log(chalk.dim('┌─' + separator + '─┐'));
    console.log(chalk.dim('│ ') + chalk.bold(headerRow) + chalk.dim(' │'));
    console.log(chalk.dim('├─' + separator + '─┤'));

    rows.forEach((row) => {
      const rowStr = row
        .map((cell, i) => (cell || '').padEnd(colWidths[i]))
        .join(' │ ');
      console.log(chalk.dim('│ ') + rowStr + chalk.dim(' │'));
    });

    console.log(chalk.dim('└─' + separator + '─┘'));
    console.log();
  },
  // ---------------------------------------------------------------------------
  // Script convenience helpers (always shown — used by root scripts/)
  // ---------------------------------------------------------------------------

  /** Print a step progress indicator: [1/5] Doing something... */
  step: (current: number, total: number, message: string): void => {
    console.log(chalk.yellow(`[${current}/${total}] ${message}`));
  },

  /** Alias for error — matches legacy log.fail() API */
  fail: (message: string): void => {
    console.log(chalk.red('✗'), message);
  },

  /** Print a labelled configuration block */
  config: (label: string, entries: Record<string, string>): void => {
    console.log(chalk.yellow(`📋 ${label}:`));
    for (const [key, value] of Object.entries(entries)) {
      console.log(`   ${key}: ${value}`);
    }
    console.log();
  },

  /** Print a horizontal divider line */
  divider: (): void => {
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  },

  /** Print a summary block with title and key-value entries */
  summary: (title: string, entries: Record<string, string>): void => {
    console.log();
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green(`✅ ${title}`));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log();
    console.log(chalk.cyan('Summary:'));
    for (const [key, value] of Object.entries(entries)) {
      console.log(`  ${key}: ${value}`);
    }
    console.log();
  },

  /** Print a numbered list of next steps */
  nextSteps: (steps: string[]): void => {
    console.log(chalk.yellow('Next steps:'));
    steps.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s}`);
    });
    console.log();
  },

  // ---------------------------------------------------------------------------
  // Fatal (always shown — terminates the process)
  // ---------------------------------------------------------------------------

  /** Print error and exit with code 1 */
  fatal: (message: string): never => {
    console.error(chalk.red(`✗ Fatal: ${message}`));
    process.exit(1);
  },
};

export default logger;
