// Custom-element entrypoint: importing these Svelte modules (compiled with
// customElement: true) registers <mv-structure> and <mv-trajectory> on the
// page. The web app lazy-loads this bundle from /matterviz/elements.js the
// first time a structure file is opened.
// matterviz/app.css is intentionally NOT imported: it pulls docs-site-only
// deps (@wooorm/starry-night). Component styles are Svelte-scoped and ship
// inside the compiled custom elements.
import './StructureCE.svelte';
import './TrajectoryCE.svelte';
