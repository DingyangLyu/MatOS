import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@excalidraw/excalidraw': resolve(__dirname, 'tests/helpers/excalidraw-mock.tsx'),
      'motion/react': resolve(__dirname, 'tests/helpers/motion-mock.tsx'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup/jsdom-lexical.ts'],
    // Several suites mount the real App/EntryShell, which pulls HomeView and
    // other views in as lazy Suspense chunks. Under full-suite transform
    // pressure those cold import()s can blow past Vitest's 5s default and flake,
    // even though the assertions themselves are fast. 15s gives real headroom
    // without masking genuine hangs.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
