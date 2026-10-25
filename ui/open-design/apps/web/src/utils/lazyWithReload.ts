// Stale-chunk self-healing for lazy views in the static-export SPA.
//
// The daemon serves a prebuilt `apps/web/out` bundle. Every rebuild replaces
// the hashed `_next/static/chunks/*` files, so a browser tab that loaded the
// previous build 404s the moment it lazy-imports a view it has not visited
// yet (Settings, CLI config, Assets, …). React then surfaces Next's global
// "This page couldn't load" screen — a dead end the user has to notice and
// manually reload past.
//
// Instead, when a dynamic import fails we force one full reload (per
// RELOAD_WINDOW_MS, tracked in sessionStorage so loops cannot happen while a
// broken deploy keeps 404ing) and leave the promise pending so the Suspense
// fallback stays up until the fresh HTML arrives.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_AT_KEY = 'od.stale-chunk-reload-at';
const RELOAD_WINDOW_MS = 30_000;

function shouldForceReload(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_AT_KEY) ?? '0');
    if (Number.isFinite(last) && Date.now() - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
    return true;
  } catch {
    // Storage disabled: still reload — repeated module-load failures without
    // the guard are no worse than the hard error page we replace.
    return true;
  }
}

/**
 * Recover from a failed dynamic import. Reloads the page once per guard
 * window and suspends forever (the reload replaces the document); outside
 * the guard window it rethrows so a genuinely broken build still surfaces.
 */
export function recoverStaleChunkImport<T>(
  error: unknown,
  reload: () => void = () => window.location.reload(),
): Promise<T> {
  if (shouldForceReload()) {
    reload();
    return new Promise<T>(() => {});
  }
  throw error;
}

/** Drop-in `React.lazy` replacement with stale-chunk reload recovery. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => load().catch((error) => recoverStaleChunkImport<{ default: T }>(error)));
}
