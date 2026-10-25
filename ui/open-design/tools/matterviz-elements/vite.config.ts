import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds the MatterViz custom-element bundle consumed by the React web app.
// Output lands in apps/web/public/matterviz/ so the Next static export (and
// therefore every daemon instance serving out/ from disk) ships it as a
// plain static asset that StructureViewer lazy-loads on first use.
export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        customElement: true,
      },
    }),
  ],
  resolve: {
    alias: [
      // svelte-multiselect dynamic-imports these docs-only highlighter
      // modules; stub them so the runtime imports resolve without shipping
      // starry-night. Subpath first (exact-match aliases shadow prefixes).
      {
        find: '@wooorm/starry-night/source.svelte',
        replacement: resolve(__dirname, 'src/starry-night-source-stub.svelte'),
      },
      {
        find: '@wooorm/starry-night',
        replacement: resolve(__dirname, 'src/starry-night-stub.ts'),
      },
    ],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/elements.ts'),
      formats: ['es'],
      fileName: () => 'elements.js',
    },
    outDir: resolve(__dirname, '../../apps/web/public/matterviz'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    chunkSizeWarningLimit: 4000,
  },
});
