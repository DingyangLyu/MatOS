import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectFolder,
  deleteProjectFolder,
  listProjectFolders,
  projectFoldersListCacheTestHooks,
  renameProjectFolder,
} from '../src/projects.js';

const tempRoots: string[] = [];

async function makeProjectsRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-project-folders-'));
  tempRoots.push(root);
  return path.join(root, 'projects');
}

afterEach(async () => {
  projectFoldersListCacheTestHooks.reset();
  await Promise.all(
    tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  );
});

describe('listProjectFolders', () => {
  it('singleflights and caches recursive folder scans', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'large-project';
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        mkdir(path.join(projectsRoot, projectId, `batch-${index}`, 'results'), {
          recursive: true,
        })),
    );

    let releaseScan!: () => void;
    projectFoldersListCacheTestHooks.beforeScan = () =>
      new Promise<void>(resolve => {
        releaseScan = resolve;
      });

    const first = listProjectFolders(projectsRoot, projectId);
    const second = listProjectFolders(projectsRoot, projectId);
    await vi.waitFor(() =>
      expect(projectFoldersListCacheTestHooks.getScanCount()).toBe(1),
    );
    releaseScan();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toHaveLength(192);
    expect(secondResult).toEqual(firstResult);
    expect(await listProjectFolders(projectsRoot, projectId)).toEqual(firstResult);
    expect(projectFoldersListCacheTestHooks.getScanCount()).toBe(1);
  });

  it('invalidates the cache after folder mutations', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'mutating-project';
    await mkdir(path.join(projectsRoot, projectId), { recursive: true });

    expect(await listProjectFolders(projectsRoot, projectId)).toEqual([]);
    await createProjectFolder(projectsRoot, projectId, 'alpha');
    expect((await listProjectFolders(projectsRoot, projectId)).map((folder: { path: string }) => folder.path))
      .toEqual(['alpha']);

    await renameProjectFolder(projectsRoot, projectId, 'alpha', 'beta');
    expect((await listProjectFolders(projectsRoot, projectId)).map((folder: { path: string }) => folder.path))
      .toEqual(['beta']);

    await deleteProjectFolder(projectsRoot, projectId, 'beta');
    expect(await listProjectFolders(projectsRoot, projectId)).toEqual([]);
    expect(projectFoldersListCacheTestHooks.getScanCount()).toBe(4);
  });
});
