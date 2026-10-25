import { build } from "esbuild";

await build({
  bundle: true,
  entryNames: "[dir]/[name]",
  entryPoints: [
    "./src/index.ts",
    "./src/api/connectionTest.ts",
    "./src/api/amrWallet.ts",
    "./src/api/research.ts",
  ],
  format: "esm",
  outbase: "./src",
  outdir: "./dist",
  outExtension: { ".js": ".mjs" },
  packages: "external",
  platform: "node",
  target: "node24",
});
