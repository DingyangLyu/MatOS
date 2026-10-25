import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('project skillId validation', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function uniqueId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  async function createProject(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('POST /api/projects', () => {
    it('rejects unknown skillId with 400 SKILL_NOT_FOUND', async () => {
      const id = uniqueId('p');
      const resp = await createProject({
        id,
        name: 'Skill id check',
        skillId: 'definitely-not-a-real-skill',
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('SKILL_NOT_FOUND');
      // Project must not have been persisted.
      const getResp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      expect(getResp.status).toBe(404);
    });


    it('normalizes empty string skillId to null', async () => {
      const id = uniqueId('p');
      const resp = await createProject({ id, name: 'Empty skill', skillId: '' });
      expect(resp.status).toBe(200);
      projectsToClean.push(id);
      const body = (await resp.json()) as { project: { skillId: string | null } };
      expect(body.project.skillId).toBeNull();
    });

    it('treats null skillId as no skill pinned', async () => {
      const id = uniqueId('p');
      const resp = await createProject({ id, name: 'Null skill', skillId: null });
      expect(resp.status).toBe(200);
      projectsToClean.push(id);
      const body = (await resp.json()) as { project: { skillId: string | null } };
      expect(body.project.skillId).toBeNull();
    });

    it('treats omitted skillId as no skill pinned', async () => {
      const id = uniqueId('p');
      const resp = await createProject({ id, name: 'Omitted skill' });
      expect(resp.status).toBe(200);
      projectsToClean.push(id);
      const body = (await resp.json()) as { project: { skillId: string | null } };
      expect(body.project.skillId).toBeNull();
    });

    it('rejects numeric skillId with 400 INVALID_SKILL_ID', async () => {
      const id = uniqueId('p');
      const resp = await createProject({ id, name: 'Bad type', skillId: 42 });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_SKILL_ID');
      const getResp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      expect(getResp.status).toBe(404);
    });

    it('rejects object skillId with 400 INVALID_SKILL_ID', async () => {
      const id = uniqueId('p');
      const resp = await createProject({ id, name: 'Bad type', skillId: {} });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_SKILL_ID');
      const getResp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      expect(getResp.status).toBe(404);
    });
  });

  async function patchProject(id: string, patch: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  describe('PATCH /api/projects/:id', () => {
    it('rejects unknown skillId with 400 SKILL_NOT_FOUND', async () => {
      const id = uniqueId('p');
      const created = await createProject({ id, name: 'Patch target' });
      expect(created.status).toBe(200);
      projectsToClean.push(id);

      const resp = await patchProject(id, { skillId: 'still-not-a-real-skill' });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('SKILL_NOT_FOUND');

      // skillId on the row stays unchanged (null since create).
      const get = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      const getBody = (await get.json()) as { project: { skillId: string | null } };
      expect(getBody.project.skillId).toBeNull();
    });


    it('normalizes empty-string skillId on patch to null', async () => {
      const id = uniqueId('p');
      await createProject({ id, name: 'Patch empty', skillId: null });
      projectsToClean.push(id);
      const resp = await patchProject(id, { skillId: '' });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { skillId: string | null } };
      expect(body.project.skillId).toBeNull();
    });

    it('treats null skillId on patch as unset', async () => {
      const id = uniqueId('p');
      await createProject({ id, name: 'Patch null', skillId: null });
      projectsToClean.push(id);
      const resp = await patchProject(id, { skillId: null });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { skillId: string | null } };
      expect(body.project.skillId).toBeNull();
    });

    it('leaves skillId untouched when the field is omitted from patch', async () => {
      const id = uniqueId('p');
      await createProject({ id, name: 'Patch omit', skillId: null });
      projectsToClean.push(id);
      const resp = await patchProject(id, { name: 'Renamed' });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { skillId: string; name: string } };
      expect(body.project.skillId).toBeNull();
      expect(body.project.name).toBe('Renamed');
    });

    it('rejects numeric skillId on patch with 400 INVALID_SKILL_ID', async () => {
      const id = uniqueId('p');
      await createProject({ id, name: 'Patch bad type' });
      projectsToClean.push(id);
      const resp = await patchProject(id, { skillId: 42 });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_SKILL_ID');
      const get = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      const getBody = (await get.json()) as { project: { skillId: string | null } };
      expect(getBody.project.skillId).toBeNull();
    });
  });
});
