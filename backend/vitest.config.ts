import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Test files share one database; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests must not depend on a local live smoke-test report.
    env: { ASSISTANT_SMOKE_REPORT: 'test/.no-smoke-report.json' },
  },
});
