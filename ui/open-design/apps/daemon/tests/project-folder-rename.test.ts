import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

// Folder rename/move is the missing basic file-manager operation the Design
// Files panel wires through POST /api/projects/:id/folders/rename. These
// tests exercise the real route + real filesystem (temp projects under the
// daemon's managed root), matching project-file-rename.test.ts.

describe('project folder rename route', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function createProject() {
    const id = `folder-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { project: { id: string } };
    return body.project.id;
  }

  async function writeText(projectId: string, name: string, content = 'hello') {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    expect(resp.status).toBe(200);
  }

  async function createFolder(projectId: string, name: string) {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(resp.status).toBe(200);
  }

  async function renameFolder(projectId: string, from: string, to: string) {
    return fetch(`${baseUrl}/api/projects/${projectId}/folders/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
  }

  async function listState(projectId: string) {
    const [filesResp, foldersResp] = await Promise.all([
      fetch(`${baseUrl}/api/projects/${projectId}/files`),
      fetch(`${baseUrl}/api/projects/${projectId}/folders`),
    ]);
    const files = ((await filesResp.json()) as { files: Array<{ name: string }> }).files.map(
      (f) => f.name,
    );
    const folders = (
      (await foldersResp.json()) as { folders: Array<{ path: string }> }
    ).folders.map((f) => f.path);
    return { files, folders };
  }

  it('renames a folder and carries its files along', async () => {
    const projectId = await createProject();
    await writeText(projectId, 'runs/relax.in', 'CONTROL');
    await writeText(projectId, 'runs/relax.out', 'DONE');

    const resp = await renameFolder(projectId, 'runs', 'calculations');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { folder: { path: string; type: string } };
    expect(body.folder.path).toBe('calculations');
    expect(body.folder.type).toBe('dir');

    const { files, folders } = await listState(projectId);
    expect(folders).toContain('calculations');
    expect(folders).not.toContain('runs');
    expect(files).toContain('calculations/relax.in');
    expect(files).toContain('calculations/relax.out');
  });

  it('moves a folder under another folder', async () => {
    const projectId = await createProject();
    await writeText(projectId, 'inputs/scf.in', 'x');
    await createFolder(projectId, 'archive');

    const resp = await renameFolder(projectId, 'inputs', 'archive/inputs');
    expect(resp.status).toBe(200);

    const { files, folders } = await listState(projectId);
    expect(folders).toContain('archive/inputs');
    expect(files).toContain('archive/inputs/scf.in');
  });

  it('rejects moving a folder into its own subtree', async () => {
    const projectId = await createProject();
    await writeText(projectId, 'data/a.txt', 'x');

    const resp = await renameFolder(projectId, 'data', 'data/nested');
    expect(resp.status).toBe(400);
  });

  it('refuses to overwrite an existing target folder', async () => {
    const projectId = await createProject();
    await writeText(projectId, 'one/a.txt', 'x');
    await writeText(projectId, 'two/b.txt', 'y');

    const resp = await renameFolder(projectId, 'one', 'two');
    expect(resp.status).toBe(409);

    const { files } = await listState(projectId);
    expect(files).toContain('one/a.txt');
    expect(files).toContain('two/b.txt');
  });

  it('404s when the source folder does not exist', async () => {
    const projectId = await createProject();
    const resp = await renameFolder(projectId, 'missing', 'renamed');
    expect(resp.status).toBe(404);
  });
});
