// Red spec for the "mystery files in the file manager" bug: commitProjectFile
// stages atomic writes as `<target>.tmp.<pid>.<uuid>` (body) and
// `<target>.artifact.json.tmp.<pid>.<uuid>` (sidecar) siblings before the
// rename. Those names are neither dotfiles nor `.artifact.json`, so:
//   - a list scan racing an in-flight write captured them in the snapshot,
//   - chokidar `add` events pushed them into the cached snapshot / SSE feed,
//   - a crash mid-write with NO sidecar leaves the temp body orphaned forever
//     (only sidecar writes get a recovery journal),
// and users see transient or permanent intermediate files in the file panel.
//
// The invariant: commit intermediates are never visible on any listing
// surface, and stale orphans (older than the recovery grace window) are
// swept by the same crash-recovery pass that already runs before each scan.

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isProjectFileCommitIntermediateEventPath,
  isProjectFileCommitIntermediateName,
  listCachedProjectFiles,
  listFiles,
  projectFilesListCacheTestHooks,
  retainCachedProjectFilesWatcher,
  updateCachedProjectFilesFromEvent,
} from '../src/projects.js';

const tempRoots: string[] = [];

async function makeProjectsRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-commit-intermediates-'));
  tempRoots.push(root);
  return path.join(root, 'projects');
}

afterEach(async () => {
  projectFilesListCacheTestHooks.reset();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const UUID = '3f9a1c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b';
const BODY_TMP = `page.html.tmp.4242.${UUID}`;
const SIDECAR_TMP = `page.html.artifact.json.tmp.4242.${UUID}`;

async function seedProject(projectsRoot: string, projectId: string) {
  const projectDir = path.join(projectsRoot, projectId);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'page.html'), '<!doctype html>');
  await writeFile(path.join(projectDir, BODY_TMP), '<!doctype html>');
  await writeFile(path.join(projectDir, SIDECAR_TMP), '{}');
  return projectDir;
}

describe('isProjectFileCommitIntermediateName', () => {
  it('matches the commitProjectFile staging suffix and nothing user-like', () => {
    expect(isProjectFileCommitIntermediateName(BODY_TMP)).toBe(true);
    expect(isProjectFileCommitIntermediateName(SIDECAR_TMP)).toBe(true);
    expect(isProjectFileCommitIntermediateName('page.html')).toBe(false);
    expect(isProjectFileCommitIntermediateName('notes.tmp')).toBe(false);
    expect(isProjectFileCommitIntermediateName('video.tmp.mp4')).toBe(false);
    expect(isProjectFileCommitIntermediateName('report.tmp.2024.final.html')).toBe(false);
  });

  it('matches watcher event paths by basename across separators (SSE forward guard)', () => {
    expect(isProjectFileCommitIntermediateEventPath(`pages/${BODY_TMP}`)).toBe(true);
    expect(isProjectFileCommitIntermediateEventPath(`pages\\${BODY_TMP}`)).toBe(true);
    expect(isProjectFileCommitIntermediateEventPath(BODY_TMP)).toBe(true);
    expect(isProjectFileCommitIntermediateEventPath('pages/page.html')).toBe(false);
    expect(isProjectFileCommitIntermediateEventPath(undefined)).toBe(false);
    // A DIRECTORY named like an intermediate must not suppress events for the
    // real files inside it.
    expect(isProjectFileCommitIntermediateEventPath(`${BODY_TMP}/real.html`)).toBe(false);
  });
});

describe('commit intermediates on listing surfaces', () => {
  it('listFiles never surfaces commit intermediates (in-flight write race)', async () => {
    const projectsRoot = await makeProjectsRoot();
    await seedProject(projectsRoot, 'project-race');

    const files = await listFiles(projectsRoot, 'project-race');

    expect(files.map((file) => file.path)).toEqual(['page.html']);
  });

  it('ignores watcher add events for commit intermediates', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-watch';
    await seedProject(projectsRoot, projectId);
    const releaseWatcher = retainCachedProjectFilesWatcher(projectsRoot, projectId);
    const initial = await listCachedProjectFiles(projectsRoot, projectId);

    await expect(updateCachedProjectFilesFromEvent(
      projectsRoot,
      projectId,
      { path: BODY_TMP, kind: 'add' },
    )).resolves.toBe(false);

    const delta = await listCachedProjectFiles(projectsRoot, projectId, { since: initial.snapshotAt });
    expect(delta.files).toEqual([]);
    releaseWatcher();
  });

});

describe('orphaned commit intermediate sweep', () => {
  it('removes stale orphans during the pre-scan recovery pass but keeps fresh in-flight temps on disk', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectDir = await seedProject(projectsRoot, 'project-sweep');
    // Nest one orphan to prove the sweep follows the recursive recovery walk.
    const nested = path.join(projectDir, 'pages');
    await mkdir(nested, { recursive: true });
    const nestedOrphan = path.join(nested, `deep.html.tmp.4242.${UUID}`);
    await writeFile(nestedOrphan, 'orphan');

    // Backdate the root body temp + nested orphan past the grace window; the
    // sidecar temp stays fresh, standing in for a write that is mid-flight.
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(path.join(projectDir, BODY_TMP), stale, stale);
    await utimes(nestedOrphan, stale, stale);

    await listFiles(projectsRoot, 'project-sweep');

    await expect(stat(path.join(projectDir, BODY_TMP))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(nestedOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    // Fresh temp: hidden from the listing (above) but never deleted from disk.
    await expect(stat(path.join(projectDir, SIDECAR_TMP))).resolves.toBeTruthy();
  });
});
