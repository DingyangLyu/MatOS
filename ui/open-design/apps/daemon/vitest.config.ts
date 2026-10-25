import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These suites mutate process-wide env/PATH and bind real local servers.
    // Keep files serial so fake agent binaries stay scoped to their tests.
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    // Suite hooks routinely boot the full daemon (catalog seeding
    // included) or stage fixture trees on disk. On slow or heavily shared
    // hosts that regularly exceeds Vitest's 10s hook default even though the
    // hooks always complete; give them the same headroom scale as the slowest
    // verified boots without masking genuine hangs.
    hookTimeout: 60_000,
  },
});
