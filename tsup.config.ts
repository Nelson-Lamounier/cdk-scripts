import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    // Library exports (top-level subpath exports)
    index: 'src/index.ts',
    stacks: 'src/utils/stacks.ts',
    github: 'src/utils/github.ts',
    logger: 'src/utils/logger.ts',
    cdk: 'src/utils/cdk.ts',
    paths: 'src/utils/paths.ts',
    aws: 'src/utils/aws.ts',
    exec: 'src/utils/exec.ts',
    types: 'src/utils/types.ts',
    // CD scripts (required by bin/ shims)
    'cd/deploy': 'src/cd/deploy.ts',
    'cd/diagnose-rollback': 'src/cd/diagnose-rollback.ts',
    'cd/deployment-failure-report': 'src/cd/deployment-failure-report.ts',
    'cd/finalize': 'src/cd/finalize.ts',
    // CI scripts (required by bin/ shims)
    'ci/cfn-import-rescue': 'src/ci/cfn-import-rescue.ts',
    'ci/drift-detection': 'src/ci/drift-detection.ts',
    'ci/log-group-audit': 'src/ci/log-group-audit.ts',
    'ci/pipeline-setup': 'src/ci/pipeline-setup.ts',
    'ci/preflight-checks': 'src/ci/preflight-checks.ts',
    'ci/security-scan': 'src/ci/security-scan.ts',
    'ci/synthesize': 'src/ci/synthesize.ts',
    // Shared utilities consumers can import directly
    'shared/exec': 'src/shared/exec.ts',
  },
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist',
  sourcemap: false,
  dts: true,
  clean: true,
  // Leave AWS SDK external (avoid shipping 300MB), bundle everything else
  // including chalk v4 (CJS-compatible — no ESM/CJS boundary issue)
  external: [
    /^@aws-sdk\//,
  ],
});
