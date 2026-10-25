/**
 * URL router round-trip tests (issue #1505).
 *
 * Pins the deep-link shape for the project route:
 *
 *   /                                                 home
 *   /projects/:id                                     project root
 *   /projects/:id/files/:path                         file view
 *   /projects/:id/conversations/:cid                  specific conversation
 *   /projects/:id/conversations/:cid/files/:path      conversation + file
 *
 * The conversation segment was added to unblock the Routines history
 * row: clicking "Open project" on a parallel run's row needs to land
 * the user on that run's own conversation, not on whatever the
 * project happens to default to.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute, type Route } from '../src/router';

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('parseRoute / buildPath (issue #1505)', () => {
  it('parses the home route', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('')).toEqual({ kind: 'home', view: 'home' });
  });

  it('round-trips a bare project route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1');
  });

  it('round-trips a project + file route (no conversation)', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'src/index.tsx',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/files/src/index.tsx');
  });

  it('round-trips a project + conversation route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc');
  });

  it('round-trips a project + conversation + file route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: 'index.html',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc/files/index.html');
  });

  it('percent-encodes ids and file names with reserved characters', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p/1 with space',
      conversationId: 'conv/abc with space',
      fileName: 'dir/file name.tsx',
    };
    const built = buildPath(route);
    expect(built).toContain('p%2F1%20with%20space');
    expect(built).toContain('conv%2Fabc%20with%20space');
    // File path components are percent-encoded individually so the
    // slash between segments survives.
    expect(built.endsWith('/dir/file%20name.tsx')).toBe(true);
    expect(roundTrip(route)).toEqual(route);
  });

  it('parses a legacy project + file URL with no conversation segment', () => {
    expect(parseRoute('/projects/p-1/files/README.md')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'README.md',
    });
  });

  it('parses a project + conversation URL with no file segment', () => {
    expect(parseRoute('/projects/p-1/conversations/c-2')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'c-2',
      fileName: null,
    });
  });

  it('falls back to home when the URL is unrecognized', () => {
    expect(parseRoute('/something/else')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/projects')).toEqual({ kind: 'home', view: 'projects' });
  });

  it('routes automations and ops as separate views', () => {
    // /automations (and legacy /tasks) is the scheduled-automations surface;
    // /ops is the runtime operations monitor. They must not collapse into one.
    expect(parseRoute('/automations')).toEqual({ kind: 'home', view: 'tasks' });
    expect(parseRoute('/tasks')).toEqual({ kind: 'home', view: 'tasks' });
    expect(parseRoute('/ops')).toEqual({ kind: 'home', view: 'ops' });
    expect(buildPath({ kind: 'home', view: 'tasks' })).toBe('/automations');
    expect(buildPath({ kind: 'home', view: 'ops' })).toBe('/ops');
  });

  it('routes the native cron scheduler on its own /schedules view', () => {
    // /schedules is the MatOS workflow cron scheduler — a distinct destination
    // from the /automations agent-conversation routines and the /ops monitor.
    expect(parseRoute('/schedules')).toEqual({ kind: 'home', view: 'schedules' });
    expect(buildPath({ kind: 'home', view: 'schedules' })).toBe('/schedules');
  });

  it('round-trips the native product-feedback page', () => {
    expect(parseRoute('/feedback')).toEqual({ kind: 'home', view: 'feedback' });
    expect(buildPath({ kind: 'home', view: 'feedback' })).toBe('/feedback');
  });

  it('uses /blog as the canonical release-notes route', () => {
    const route = { kind: 'home', view: 'blog' } as const;
    expect(parseRoute('/blog')).toEqual(route);
    expect(parseRoute('/releases')).toEqual(route);
    expect(parseRoute('/changelog')).toEqual(route);
    expect(buildPath(route)).toBe('/blog');
  });

  it.each(['/papers', '/reader', '/mathub', '/marketplace', '/design-systems', '/library'])(
    'falls back to home for the retired %s surface',
    (path) => {
      expect(parseRoute(path)).toEqual({ kind: 'home', view: 'home' });
    },
  );

  it.each<Route>([
    { kind: 'home', view: 'workflows' },
    { kind: 'home', view: 'workflows', workflowRunId: 'run-123' },
    { kind: 'home', view: 'workflows', workflowRunId: 'run-123', workflowProjectId: 'project-a' },
    { kind: 'home', view: 'workflows', workflowProjectId: 'project/with spaces' },
  ])('round-trips embedded workflow deep links: %j', (route) => {
    expect(roundTrip(route)).toEqual(route);
  });

  it('opens legacy workflow file links in the existing project workspace', () => {
    expect(
      parseRoute('/workflows/projects/project-1/files/folder/sample%20one.workflow.yaml'),
    ).toEqual({
      kind: 'project',
      projectId: 'project-1',
      conversationId: null,
      fileName: 'folder/sample one.workflow.yaml',
    });
  });
});
