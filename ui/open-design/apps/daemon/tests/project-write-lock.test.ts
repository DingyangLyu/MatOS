import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProjectWriteLock } from '../src/project-write-lock.js';

describe('project writer lock', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function projectRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'od-project-writer-'));
    roots.push(root);
    return root;
  }

  it('serializes write-capable runs for the same project', async () => {
    const root = projectRoot();
    const releaseFirst = await acquireProjectWriteLock({
      projectCwd: root,
      runId: 'run-1',
      timeoutMs: 2_000,
    });
    let secondAcquired = false;
    const second = acquireProjectWriteLock({
      projectCwd: root,
      runId: 'run-2',
      timeoutMs: 2_000,
    }).then(release => {
      secondAcquired = true;
      return release;
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(secondAcquired).toBe(false);
    await releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    await releaseSecond();
  });

  it('recovers an orphan directory left before owner metadata was written', async () => {
    const root = projectRoot();
    const lockDir = path.join(root, '.matos', 'workbench', 'project-write.lock');
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);
    const release = await acquireProjectWriteLock({
      projectCwd: root,
      runId: 'run-recovery',
      timeoutMs: 1_000,
    });
    await release();
    await expect(rm(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a lock whose owner run is no longer active even if the daemon pid is alive', async () => {
    const root = projectRoot();
    const lockDir = path.join(root, '.matos', 'workbench', 'project-write.lock');
    const lockFile = path.join(lockDir, 'owner.json');
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockFile, JSON.stringify({
      token: 'stale-token',
      pid: process.pid,
      runId: 'missing-run',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const release = await acquireProjectWriteLock({
      projectCwd: root,
      runId: 'run-recovery',
      timeoutMs: 1_000,
      ownerIsActive: (owner) => owner.runId !== 'missing-run',
    });

    await release();
    await expect(rm(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
