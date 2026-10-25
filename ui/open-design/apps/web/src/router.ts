// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useSyncExternalStore } from 'react';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'workflows'
  | 'ops'
  | 'schedules'
  | 'integrations'
  | 'assets'
  | 'evolution'
  | 'blog'
  | 'feedback'
  | 'profile';

export type Route =
  | {
      kind: 'home';
      view: EntryHomeView;
      /**
       * Optional selected MatOS asset ref for the Assets tab. `/assets/:ref`
       * deep-links open the structured editor for that asset while the tab
       * (and the entry nav rail) stay mounted.
       */
      assetRef?: string | null;
      /** Workflow dashboard selection, kept inside the entry workbench. */
      workflowRunId?: string;
      workflowProjectId?: string;
    }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home', view: 'home' };
  if (parts[0] === 'workflows') {
    if (parts[1] === 'runs' && parts[2]) {
      return { kind: 'home', view: 'workflows', workflowRunId: decodeURIComponent(parts[2]) };
    }
    if (parts[1] === 'projects' && parts[2]) {
      const projectId = decodeURIComponent(parts[2]);
      if (parts[3] === 'runs' && parts[4]) {
        return { kind: 'home', view: 'workflows', workflowProjectId: projectId, workflowRunId: decodeURIComponent(parts[4]) };
      }
      // Old studio links now open the same project/chat/file workspace.
      if (parts[3] === 'files' && parts[4]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(4).join('/')),
        };
      }
      return { kind: 'home', view: 'workflows', workflowProjectId: projectId };
    }
    return { kind: 'home', view: 'workflows' };
  }
  if (parts[0] === 'onboarding') {
    return { kind: 'home', view: 'onboarding' };
  }
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeURIComponent(parts[1]);
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeURIComponent(parts[3]);
        if (parts[4] === 'files' && parts[5]) {
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName: decodeURIComponent(parts.slice(5).join('/')),
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(3).join('/')),
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'ops') {
    // Runtime operations monitor — split from /automations so scheduled
    // automations (TasksView) and ops monitoring are separate destinations.
    return { kind: 'home', view: 'ops' };
  }
  if (parts[0] === 'schedules') {
    // Native cron workflow scheduler — MatOS scheduled tasks, distinct from
    // the /automations agent-conversation routines.
    return { kind: 'home', view: 'schedules' };
  }
  if (parts[0] === 'integrations') {
    return { kind: 'home', view: 'integrations' };
  }
  if (parts[0] === 'assets') {
    return {
      kind: 'home',
      view: 'assets',
      assetRef: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
    };
  }
  if (parts[0] === 'evolution') {
    return { kind: 'home', view: 'evolution' };
  }
  if (parts[0] === 'blog' || parts[0] === 'releases' || parts[0] === 'changelog') {
    return { kind: 'home', view: 'blog' };
  }
  if (parts[0] === 'feedback') {
    return { kind: 'home', view: 'feedback' };
  }
  if (parts[0] === 'profile') {
    return { kind: 'home', view: 'profile' };
  }
  return { kind: 'home', view: 'home' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'workflows') {
      if (route.workflowRunId && route.workflowProjectId)
        return `/workflows/projects/${encodeURIComponent(route.workflowProjectId)}/runs/${encodeURIComponent(route.workflowRunId)}`;
      if (route.workflowRunId) return `/workflows/runs/${encodeURIComponent(route.workflowRunId)}`;
      if (route.workflowProjectId)
        return `/workflows/projects/${encodeURIComponent(route.workflowProjectId)}`;
      return '/workflows';
    }
    if (route.view === 'onboarding') return '/onboarding';
    if (route.view === 'projects') return '/projects';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'ops') return '/ops';
    if (route.view === 'schedules') return '/schedules';
    if (route.view === 'integrations') return '/integrations';
    if (route.view === 'assets') {
      return route.assetRef ? `/assets/${encodeURIComponent(route.assetRef)}` : '/assets';
    }
    if (route.view === 'evolution') return '/evolution';
    if (route.view === 'blog') return '/blog';
    if (route.view === 'feedback') return '/feedback';
    if (route.view === 'profile') return '/profile';
    return '/';
  }
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
//
// The `popstate` dispatch is deferred to a microtask so that callers
// can safely invoke `navigate()` from inside a `useState` updater or
// during a render commit phase without triggering React's
// "Cannot update a component while rendering a different component"
// warning. The `history` API call itself stays synchronous so the URL
// bar updates immediately; only the `useRoute()` subscriber updates
// are deferred past the current render.
// Each history entry carries a monotonic depth (`odIndex`) so `goBack()` can
// tell whether there is an in-app entry behind the current one. We store it in
// `history.state` — nothing else reads host history state — so it survives
// reloads and the browser's own back/forward. The very first entry (a fresh
// load or deep link) has no state, which reads as index 0.
interface HistoryState {
  odIndex: number;
}

function readHistoryIndex(): number {
  const state = window.history.state as Partial<HistoryState> | null;
  return typeof state?.odIndex === 'number' ? state.odIndex : 0;
}

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  if (target === current) return;
  const index = readHistoryIndex();
  // `replace` keeps the current depth (it swaps the entry in place); a push
  // adds one level so the entry we are leaving becomes the "previous layer".
  const nextState: HistoryState = { odIndex: opts.replace ? index : index + 1 };
  if (opts.replace) {
    window.history.replaceState(nextState, '', target);
  } else {
    window.history.pushState(nextState, '', target);
  }
  queueMicrotask(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

// Step back to the route the user actually came from. We pop the browser
// history stack (which `navigate()` builds via pushState) so "back" lands on
// the real previous layer — Projects, Tasks, a design system, wherever — not a
// hardcoded destination. When the current entry is the first in-app entry
// (`odIndex` 0: deep link or fresh load), there is nothing in-app to pop, so we
// navigate to `fallback` instead of letting `history.back()` escape the app.
export function goBack(fallback: Route): void {
  if (readHistoryIndex() > 0) {
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

let cachedPathname: string | null = null;
let cachedRoute: Route | null = null;

function getRouteSnapshot(): Route {
  const pathname = window.location.pathname;
  if (cachedPathname !== pathname || cachedRoute === null) {
    cachedPathname = pathname;
    cachedRoute = parseRoute(pathname);
  }
  return cachedRoute;
}

function subscribeToRouteChanges(onStoreChange: () => void): () => void {
  window.addEventListener('popstate', onStoreChange);
  return () => window.removeEventListener('popstate', onStoreChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeToRouteChanges, getRouteSnapshot, getRouteSnapshot);
}
