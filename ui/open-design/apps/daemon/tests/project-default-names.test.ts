import type http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { openDatabase, insertProject } from '../src/db.js';
import type { Project, ProjectResponse, ProjectEditorWorkspaceResponse } from '@open-design/contracts';

type MaterializedProject = Project & { metadata: NonNullable<Project['metadata']> & { baseDir: string } };
async function readProjectResponse(response: Response): Promise<MaterializedProject> {
  const { project } = await response.json() as ProjectResponse;
  expect(typeof project.metadata?.baseDir).toBe('string');
  return project as MaterializedProject;
}

describe('numbered project names and stable editor paths', () => {
  let server: http.Server;
  let baseUrl: string;
  let root: string;
  const savedLocation = process.env.OD_DEFAULT_PROJECT_LOCATION;
  const savedMode = process.env.MATOS_OPEN_DESIGN_ENABLED;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'matos-project-names-'));
    process.env.OD_DEFAULT_PROJECT_LOCATION = root;
    process.env.MATOS_OPEN_DESIGN_ENABLED = '1';
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string; server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (savedLocation === undefined) delete process.env.OD_DEFAULT_PROJECT_LOCATION;
    else process.env.OD_DEFAULT_PROJECT_LOCATION = savedLocation;
    if (savedMode === undefined) delete process.env.MATOS_OPEN_DESIGN_ENABLED;
    else process.env.MATOS_OPEN_DESIGN_ENABLED = savedMode;
    if (root) await rm(root, { recursive: true, force: true });
  });

  const create = (id = randomUUID()) => fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name: '未命名项目', metadata: { kind: 'prototype', nameSource: 'untitled' } }),
  });

  it('allocates distinct Chinese names at the server and keeps UUIDs out of workspace folder names', async () => {
    const responses = await Promise.all([create(), create()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const projects = await Promise.all(responses.map(readProjectResponse));
    expect(projects.map(project => project.name).sort()).toEqual(['未命名项目（1）', '未命名项目（2）']);
    for (const project of projects) {
      expect(project.metadata.nameSource).toBe('untitled');
      expect(path.dirname(project.metadata.baseDir)).toBe(await realpath(root));
      expect(path.basename(project.metadata.baseDir)).toBe(project.name === '未命名项目（1）' ? '未命名项目-1' : '未命名项目-2');
      const authority = JSON.parse(await readFile(path.join(project.metadata.baseDir, '.matos/project.json'), 'utf8'));
      expect(authority.name).toBe(project.name);
    }
  }, 120_000);

  it('preserves files and the real path when renamed, and updates the editor display name', async () => {
    const created = await create();
    expect(created.status).toBe(200);
    const project = await readProjectResponse(created);
    await writeFile(path.join(project.metadata.baseDir, '研究结果.txt'), 'keep my data');
    const openEditor = () => fetch(`${baseUrl}/api/projects/${project.id}/editor-workspace`, { method: 'POST' });
    const opened = await openEditor();
    expect(opened.status).toBe(200);
    const initial = await opened.json() as ProjectEditorWorkspaceResponse;
    const patch = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '镍基合金研究' }),
    });
    expect(patch.status).toBe(200);
    const updated = await readProjectResponse(patch);
    expect(updated.name).toBe('镍基合金研究');
    expect(updated.metadata.nameSource).toBe('user');
    expect(updated.metadata.baseDir).toBe(project.metadata.baseDir);
    expect(await readFile(path.join(project.metadata.baseDir, '研究结果.txt'), 'utf8')).toBe('keep my data');
    const workspace = JSON.parse(await readFile(initial.workspacePath, 'utf8'));
    expect(workspace.folders).toEqual([{ name: '镍基合金研究', path: project.metadata.baseDir }]);
    const reopened = await openEditor();
    expect(reopened.status).toBe(200);
    expect((await reopened.json() as ProjectEditorWorkspaceResponse).workspacePath).toBe(initial.workspacePath);
    const listed = await (await fetch(`${baseUrl}/api/projects`)).json() as { projects: Array<Project & { overview?: { projectDir: string; conversationCount: number } }> };
    const listedProject = listed.projects.find(item => item.id === project.id)!;
    expect(listedProject.overview?.projectDir).toBe(project.metadata.baseDir);
    expect(listedProject.overview?.conversationCount).toBe(1);
    const { stdout } = await promisify(execFile)(process.execPath, [
      process.env.OD_DAEMON_CLI_PATH!, 'project', 'editor-workspace', project.id,
      '--daemon-url', baseUrl, '--json',
    ], { timeout: 30_000 });
    expect(JSON.parse(stdout).workspacePath).toBe(initial.workspacePath);
    const manifest = JSON.parse(await readFile(path.join(project.metadata.baseDir, '.open-design/project.json'), 'utf8'));
    expect(manifest.name).toBe('镍基合金研究');
  }, 120_000);

  it('does not delete the winner of concurrent creation with the same id', async () => {
    const id = randomUUID();
    const responses = await Promise.all([create(id), create(id)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const detail = await fetch(`${baseUrl}/api/projects/${id}`);
    expect(detail.status).toBe(200);
    const project = await readProjectResponse(detail);
    expect(JSON.parse(await readFile(path.join(project.metadata.baseDir, '.matos/project.json'), 'utf8')).id).toBe(id);
  }, 120_000);

  it('rejects invalid and automated renames and preserves the saved name', async () => {
    const response = await create();
    expect(response.status).toBe(200);
    const project = await readProjectResponse(response);
    for (const name of ['', 'bad\nname', 'x'.repeat(161)]) {
      const invalid = await fetch(`${baseUrl}/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
      expect(invalid.status).toBe(400);
    }
    const automatic = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'prompt title', metadata: { nameSource: 'agent' } }),
    });
    expect(automatic.status).toBe(409);
    const detail = await fetch(`${baseUrl}/api/projects/${project.id}`).then(readProjectResponse);
    expect(detail.name).toBe(project.name);
  }, 120_000);

  it('skips occupied directory names without adopting or deleting existing files', async () => {
    await mkdir(path.join(root, 'Collision-1'));
    await writeFile(path.join(root, 'Collision-1', 'keep.txt'), 'keep');
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), name: 'Collision', metadata: { kind: 'prototype', nameSource: 'untitled' } }),
    });
    expect(response.status).toBe(200);
    const project = await readProjectResponse(response);
    expect(project.name).toBe('Collision (2)');
    expect(path.basename(project.metadata.baseDir)).toBe('Collision-2');
    expect(await readFile(path.join(root, 'Collision-1', 'keep.txt'), 'utf8')).toBe('keep');
  }, 120_000);

  it('preserves a long legacy name on a full-project save without relaxing new rename validation', async () => {
    const id = randomUUID();
    const name = '旧项目中文需求'.repeat(40);
    const baseDir = path.join(root, `legacy-${id}`);
    await mkdir(baseDir);
    await writeFile(path.join(baseDir, 'keep.txt'), 'original data');
    const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
    insertProject(db, {
      id, name, createdAt: 1, updatedAt: 1,
      metadata: { kind: 'prototype', baseDir, importedFrom: 'folder', nameSource: 'prompt' },
    });
    const patch = (body: unknown) => fetch(`${baseUrl}/api/projects/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const saved = await patch({ name, customInstructions: 'updated settings' });
    expect(saved.status).toBe(200);
    const project = await readProjectResponse(saved);
    expect(project.name).toBe(name);
    expect(project.customInstructions).toBe('updated settings');
    expect(project.metadata.nameSource).toBe('prompt');
    expect(project.metadata.baseDir).toBe(baseDir);
    expect(JSON.parse(await readFile(path.join(baseDir, '.matos/project.json'), 'utf8')).name).toBe(name);
    expect((await patch({ name: `${name}changed` })).status).toBe(400);
    expect((await patch({ name: 'new\nname' })).status).toBe(400);
    const renamed = await patch({ name: '新的合法名称' });
    expect(renamed.status).toBe(200);
    expect((await readProjectResponse(renamed)).metadata.nameSource).toBe('user');
    const echoed = await patch({ name: '新的合法名称', metadata: { nameSource: 'generated' } });
    expect(echoed.status).toBe(200);
    expect((await readProjectResponse(echoed)).metadata.nameSource).toBe('user');
    expect(await readFile(path.join(baseDir, 'keep.txt'), 'utf8')).toBe('original data');
  }, 120_000);
});
