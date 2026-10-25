import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateCachedProjectFiles,
  listCachedProjectFiles,
  listFiles,
  projectFilesListCacheTestHooks,
  retainCachedProjectFilesWatcher,
  updateCachedProjectFilesFromEvent,
} from '../src/projects.js';

const tempRoots: string[] = [];

async function makeProjectsRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-project-files-'));
  tempRoots.push(root);
  return path.join(root, 'projects');
}

afterEach(async () => {
  projectFilesListCacheTestHooks.reset();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listFiles', () => {
  it('does not recover journals inside ignored dependency and build trees', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'ignored-recovery';
    const projectDir = path.join(projectsRoot, projectId);
    for (const dir of ['node_modules/pkg', 'task/env/venv/lib', 'build/compiler', '__pycache__', '.matos', '.matos/private']) {
      const ignored = path.join(projectDir, dir);
      await mkdir(ignored, { recursive: true });
      await writeFile(path.join(ignored, '.matos-write-00000000000000000000.json'), 'invalid journal');
    }
    await writeFile(path.join(projectDir, 'result.txt'), 'result');
    const files = await listFiles(projectsRoot, projectId);
    expect(files.map(file => file.path)).toEqual(['result.txt']);
  });

  it('still reports corrupt journals in visible user folders', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'visible-recovery';
    const projectDir = path.join(projectsRoot, projectId, 'results');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, '.matos-write-00000000000000000000.json'), 'invalid journal');
    await expect(listFiles(projectsRoot, projectId)).rejects.toThrow();
  });

  it('includes the absolute local path for each visible project file', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-1';
    const projectDir = path.join(projectsRoot, projectId);
    const filePath = path.join(projectDir, 'alpha.html');
    await mkdir(projectDir, { recursive: true });
    await writeFile(filePath, '<!doctype html>');

    const files = await listFiles(projectsRoot, projectId);

    expect(files).toEqual([
      expect.objectContaining({
        name: 'alpha.html',
        path: 'alpha.html',
        localPath: filePath,
      }),
    ]);
  });

  it('excludes only the project-root MatOS runtime while preserving project-owned MatOS assets', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectDir = path.join(projectsRoot, 'project-boundaries');
    const visible = [
      '.matos/assets/roles/materials.md',
      'runtime/user-owned.txt',
      'examples/.matos/runtime/fixture.txt',
      'src/index.ts',
    ];
    const hidden = [
      '.matos/runtime/cache/large.bin',
      '.git/config',
      '.hidden/secret.txt',
      'src/.private/token.txt',
      'node_modules/pkg/index.js',
      'dist/index.html',
    ];
    for (const relPath of [...visible, ...hidden]) {
      const target = path.join(projectDir, ...relPath.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, relPath);
    }

    const files = await listFiles(projectsRoot, 'project-boundaries');

    expect(files.map((file) => file.path).sort()).toEqual(visible.sort());
  });
});

describe('listCachedProjectFiles', () => {
  it('singleflights concurrent cold scans for the same project', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-singleflight';
    const projectDir = path.join(projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'index.html'), '<!doctype html>');

    let releaseScan!: () => void;
    projectFilesListCacheTestHooks.beforeScan = () => new Promise<void>((resolve) => {
      releaseScan = resolve;
    });

    const first = listCachedProjectFiles(projectsRoot, projectId);
    const second = listCachedProjectFiles(projectsRoot, projectId);
    await vi.waitFor(() => expect(projectFilesListCacheTestHooks.getScanCount()).toBe(1));
    releaseScan();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.files.map((file) => file.path)).toEqual(['index.html']);
    expect(secondResult).toEqual(firstResult);
    expect(projectFilesListCacheTestHooks.getScanCount()).toBe(1);
  });

  it('serves watcher changes and removals as deltas without rescanning', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-deltas';
    const projectDir = path.join(projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'alpha.txt'), 'alpha');
    const releaseWatcher = retainCachedProjectFilesWatcher(projectsRoot, projectId);

    const initial = await listCachedProjectFiles(projectsRoot, projectId);
    await writeFile(path.join(projectDir, 'beta.txt'), 'beta');
    await updateCachedProjectFilesFromEvent(
      projectsRoot,
      projectId,
      { path: 'beta.txt', kind: 'add' },
    );

    const added = await listCachedProjectFiles(projectsRoot, projectId, { since: initial.snapshotAt });
    expect(added).toMatchObject({ complete: false, removed: [] });
    expect(added.files.map((file) => file.path)).toEqual(['beta.txt']);

    await unlink(path.join(projectDir, 'alpha.txt'));
    await updateCachedProjectFilesFromEvent(
      projectsRoot,
      projectId,
      { path: 'alpha.txt', kind: 'unlink' },
    );
    const removed = await listCachedProjectFiles(projectsRoot, projectId, { since: added.snapshotAt });

    expect(removed).toMatchObject({ complete: false, files: [], removed: ['alpha.txt'] });
    expect(projectFilesListCacheTestHooks.getScanCount()).toBe(1);
    releaseWatcher();
  });

  it('ignores dot/generated watcher events but accepts .matos/assets changes', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-event-filter';
    const projectDir = path.join(projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'visible.txt'), 'visible');
    const releaseWatcher = retainCachedProjectFilesWatcher(projectsRoot, projectId);
    const initial = await listCachedProjectFiles(projectsRoot, projectId);

    for (const relPath of ['node_modules/pkg/new.js', '.hidden/new.txt', '.matos/runtime/new.log']) {
      const target = path.join(projectDir, ...relPath.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, relPath);
      await expect(updateCachedProjectFilesFromEvent(
        projectsRoot,
        projectId,
        { path: relPath, kind: 'add' },
      )).resolves.toBe(false);
    }

    const assetPath = '.matos/assets/knowledge/new.md';
    const assetTarget = path.join(projectDir, ...assetPath.split('/'));
    await mkdir(path.dirname(assetTarget), { recursive: true });
    await writeFile(assetTarget, 'new knowledge');
    await updateCachedProjectFilesFromEvent(
      projectsRoot,
      projectId,
      { path: assetPath, kind: 'add' },
    );

    const delta = await listCachedProjectFiles(projectsRoot, projectId, { since: initial.snapshotAt });
    expect(delta.files.map((file) => file.path)).toEqual([assetPath]);
    expect(delta.removed).toEqual([]);
    releaseWatcher();
  });

  it('singleflights a correctness refresh after structural invalidation', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-invalidation';
    const projectDir = path.join(projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'before.txt'), 'before');
    await listCachedProjectFiles(projectsRoot, projectId);

    await writeFile(path.join(projectDir, 'after.txt'), 'after');
    invalidateCachedProjectFiles(projectsRoot, projectId);
    const [first, second] = await Promise.all([
      listCachedProjectFiles(projectsRoot, projectId),
      listCachedProjectFiles(projectsRoot, projectId),
    ]);

    expect(first.files.map((file) => file.path).sort()).toEqual(['after.txt', 'before.txt']);
    expect(second.files.map((file) => file.path).sort()).toEqual(['after.txt', 'before.txt']);
    expect(projectFilesListCacheTestHooks.getScanCount()).toBe(2);
  });
});
