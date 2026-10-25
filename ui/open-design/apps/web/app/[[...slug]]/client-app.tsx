'use client';

import dynamic from 'next/dynamic';

import { recoverStaleChunkImport } from '../../src/utils/lazyWithReload';

// The product is a fully client-driven SPA — every component reads
// localStorage, window.location, etc. — so we opt out of static-time
// rendering for the entire tree. This keeps `next build --output export`
// from trying to evaluate browser-only code while still emitting a real
// shell HTML the daemon can serve as the SPA fallback.
// recoverStaleChunkImport: a stale tab whose hashed App chunk was replaced
// by a rebuild reloads once instead of dead-ending on the error screen.
const App = dynamic(
  () =>
    import('../../src/App')
      .then((m) => m.App)
      .catch((error) => recoverStaleChunkImport<typeof import('../../src/App').App>(error)),
  {
    ssr: false,
    loading: () => <div className="od-loading-shell">Loading MatOS…</div>,
  },
);

export function ClientApp() {
  return <App />;
}
