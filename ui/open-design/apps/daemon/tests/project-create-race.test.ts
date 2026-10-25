import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

describe('project folder identity', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectIds: string[] = [];

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    await Promise.all(projectIds.map(id =>
      fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('publishes exactly one project for concurrent requests with the same id', async () => {
    const id = `project-race-${randomUUID()}`;
    projectIds.push(id);
    const create = () => fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'Concurrent project' }),
    });
    const responses = await Promise.all([create(), create()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);

    const listed = await fetch(`${baseUrl}/api/projects`).then(response => response.json()) as {
      projects?: Array<{ id?: string; metadata?: { matosProjectAuthority?: string } }>;
    };
    const matches = (listed.projects ?? []).filter(project => project.id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.metadata?.matosProjectAuthority).toBe('.matos/project.json');
  });
});
