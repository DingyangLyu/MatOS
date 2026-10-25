import type { Route } from './router';

export type AppRouteResource =
  | 'agents'
  | 'projects'
  | 'skills'
  | 'designTemplates'
  | 'templates'
;

export interface AppRouteResourcePlan {
  immediate: AppRouteResource[];
  deferred: AppRouteResource[];
}

const AGENT_ONLY: AppRouteResourcePlan = {
  immediate: [],
  deferred: ['agents'],
};

/**
 * Keeps each route's own daemon request ahead of catalogues that route does
 * not render. Deferred resources hydrate shared chrome and future modals once
 * the browser has yielded its first paint; navigating later remains warm.
 */
export function appRouteResourcePlan(route: Route): AppRouteResourcePlan {
  if (route.kind === 'project') {
    return {
      immediate: ['agents', 'projects'],
      deferred: [],
    };
  }
  if (route.kind !== 'home') return { immediate: [], deferred: [] };

  switch (route.view) {
    case 'home':
      return {
        immediate: ['agents', 'projects'],
        deferred: [],
      };
    case 'onboarding':
      return { immediate: ['agents'], deferred: [] };
    case 'projects':
    case 'workflows':
      return {
        immediate: ['projects'],
        deferred: ['agents'],
      };
    default:
      return AGENT_ONLY;
  }
}
