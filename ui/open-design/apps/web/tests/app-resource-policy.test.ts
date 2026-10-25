import { describe, expect, it } from 'vitest';

import { appRouteResourcePlan } from '../src/app-resource-policy';

describe('appRouteResourcePlan', () => {
  it('hydrates project names for workflow workbench tabs without loading unrelated catalogues', () => {
    expect(appRouteResourcePlan({ kind: 'home', view: 'workflows', workflowRunId: 'run-one' })).toEqual({
      immediate: ['projects'], deferred: ['agents'],
    });
  });
  it('keeps unrelated catalogues out of an operations-page critical path', () => {
    expect(appRouteResourcePlan({ kind: 'home', view: 'ops' })).toEqual({
      immediate: [],
      deferred: ['agents'],
    });
  });

  it('keeps upstream Open Design catalogues out of the MatOS projects page', () => {
    expect(appRouteResourcePlan({ kind: 'home', view: 'projects' })).toEqual({
      immediate: ['projects'],
      deferred: ['agents'],
    });
  });

  it('loads only native MatOS resources for the home composer and recent projects', () => {
    expect(appRouteResourcePlan({ kind: 'home', view: 'home' })).toEqual({
      immediate: ['agents', 'projects'],
      deferred: [],
    });
  });

  it('keeps upstream Open Design catalogues out of a MatOS project conversation', () => {
    expect(appRouteResourcePlan({
      kind: 'project',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      fileName: null,
    })).toEqual({
      immediate: ['agents', 'projects'],
      deferred: [],
    });
  });
});
