# MatterViz Elements Builder

Compiles MatterViz Svelte components into the static custom elements loaded by the web structure and trajectory viewer.

```bash
pnpm --filter @open-design/matterviz-elements build
```

Sources live under `src/`. The build regenerates `apps/web/public/matterviz/`, including `elements.js` and the hashed worker files, so changes go into the sources.
