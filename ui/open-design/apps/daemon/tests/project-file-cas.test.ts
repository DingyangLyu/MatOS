import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteProjectFile,
  ProjectFileConflictError,
  listFiles,
  listCachedProjectFiles,
  projectFileWriteTestHooks,
  readProjectFile,
  renameProjectFile,
  updateCachedProjectFilesFromEvent,
  writeProjectFile,
} from '../src/projects.js';

describe('project file compare-and-swap', () => {
  const roots: string[] = [];

  afterEach(() => {
    projectFileWriteTestHooks.afterCommit = null;
    projectFileWriteTestHooks.afterBodyCommit = null;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { projectsRoot: string; projectId: string; projectDir: string } {
    const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'od-project-cas-'));
    roots.push(projectsRoot);
    const projectId = 'project-1';
    return { projectsRoot, projectId, projectDir: path.join(projectsRoot, projectId) };
  }

  it('rejects stale and simultaneous writes without producing partial content', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(projectsRoot, projectId, 'README.md', '# Original\n');
    const original = await readProjectFile(projectsRoot, projectId, 'README.md');
    const first = await writeProjectFile(
      projectsRoot,
      projectId,
      'README.md',
      '# First\n',
      { expectedEtag: original.etag },
    );
    await expect(writeProjectFile(
      projectsRoot,
      projectId,
      'README.md',
      '# Stale\n',
      { expectedEtag: original.etag },
    )).rejects.toBeInstanceOf(ProjectFileConflictError);

    const concurrent = await Promise.allSettled([
      writeProjectFile(projectsRoot, projectId, 'README.md', '# A\n', {
        expectedEtag: first.etag,
      }),
      writeProjectFile(projectsRoot, projectId, 'README.md', '# B\n', {
        expectedEtag: first.etag,
      }),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(['# A\n', '# B\n']).toContain(
      await readFile(path.join(projectDir, 'README.md'), 'utf8'),
    );
  });

  it('keeps MatOS private and runtime files out of generic project APIs', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await mkdir(path.join(projectDir, '.matos', 'private', 'agent-compute'), { recursive: true });
    await mkdir(path.join(projectDir, '.matos', 'assets'), { recursive: true });
    await writeFile(
      path.join(projectDir, '.matos', 'private', 'agent-compute', 'notes.md'),
      'private\n',
      'utf8',
    );
    await symlink(
      path.join(projectDir, '.matos', 'private', 'agent-compute'),
      path.join(projectDir, 'private-link'),
      'dir',
    );
    await writeFile(
      path.join(projectDir, '.matos', 'project.json'),
      '{"id":"secret-authority"}\n',
      'utf8',
    );
    await writeFile(path.join(projectDir, '.matos', 'assets', 'README.md'), 'asset\n', 'utf8');
    const files = await listFiles(projectsRoot, projectId);
    expect(files.map(file => file.name)).toContain('.matos/assets/README.md');
    expect(files.map(file => file.name)).not.toContain('.matos/project.json');
    expect(files.map(file => file.name)).not.toContain('.matos/private/agent-compute/notes.md');
    await expect(readProjectFile(
      projectsRoot,
      projectId,
      '.matos/project.json',
    )).rejects.toMatchObject({ code: 'EPROJECTPRIVATE' });
    await expect(readProjectFile(
      projectsRoot,
      projectId,
      '.matos/private/agent-compute/notes.md',
    )).rejects.toMatchObject({ code: 'EPROJECTPRIVATE' });
    await expect(writeProjectFile(
      projectsRoot,
      projectId,
      '.matos/workbench/tamper.json',
      '{}',
    )).rejects.toMatchObject({ code: 'EPROJECTPRIVATE' });
    await expect(readProjectFile(
      projectsRoot,
      projectId,
      'private-link/notes.md',
    )).rejects.toMatchObject({ code: 'EPROJECTPRIVATE' });
    await expect(writeProjectFile(
      projectsRoot,
      projectId,
      'private-link/tamper.md',
      'private overwrite',
    )).rejects.toMatchObject({ code: 'EPROJECTPRIVATE' });
    const asset = await writeProjectFile(
      projectsRoot,
      projectId,
      '.matos/assets/new-guidance.md',
      '# Shared guidance\n',
    );
    expect(asset.name).toBe('.matos/assets/new-guidance.md');
    expect(await readFile(path.join(projectDir, asset.name), 'utf8')).toBe('# Shared guidance\n');
  });

  it('publishes an artifact body and manifest as one serialized mutation', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    let firstCommitted!: () => void;
    const waitForFirstCommit = new Promise<void>((resolve) => { firstCommitted = resolve; });
    let releaseFirst!: () => void;
    const secondCommitted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    projectFileWriteTestHooks.afterCommit = async ({ body }) => {
      const content = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      if (content.includes('second')) {
        releaseFirst();
      } else if (content.includes('first')) {
        firstCommitted();
        await secondCommitted;
      }
    };

    const first = writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>first</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'First' } },
    );
    await Promise.race([waitForFirstCommit, first]);
    const second = writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>second</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'Second' } },
    );
    await Promise.all([first, second]);

    expect(await readFile(path.join(projectDir, 'report.html'), 'utf8')).toContain('second');
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, 'report.html.artifact.json'), 'utf8'),
    ) as { title?: string; entry?: string };
    expect(manifest).toMatchObject({ title: 'Second', entry: 'report.html' });
  });

  it('recovers an interrupted body and manifest commit before the next read', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>old</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'Old' } },
    );
    let interrupted = false;
    projectFileWriteTestHooks.afterBodyCommit = () => {
      if (!interrupted) {
        interrupted = true;
        throw new Error('simulated process interruption');
      }
    };
    await expect(writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>new</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'New' } },
    )).rejects.toThrow('simulated process interruption');
    projectFileWriteTestHooks.afterBodyCommit = null;

    const recovered = await readProjectFile(projectsRoot, projectId, 'report.html');
    expect(recovered.buffer.toString('utf8')).toContain('new');
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, 'report.html.artifact.json'), 'utf8'),
    ) as { title?: string };
    expect(manifest.title).toBe('New');
    expect((await listFiles(projectsRoot, projectId)).map(file => file.name))
      .not.toContainEqual(expect.stringContaining('.matos-write-'));
  });

  it('does not let a reader recover a transaction while its writer still owns the lock', async () => {
    const { projectsRoot, projectId } = fixture();
    let bodyCommitted!: () => void;
    let releaseWriter!: () => void;
    const bodyCommitReached = new Promise<void>(resolve => { bodyCommitted = resolve; });
    const writerMayContinue = new Promise<void>(resolve => { releaseWriter = resolve; });
    projectFileWriteTestHooks.afterBodyCommit = async () => {
      bodyCommitted();
      await writerMayContinue;
    };

    const write = writeProjectFile(
      projectsRoot,
      projectId,
      'locked.html',
      '<html><body>locked</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'Locked' } },
    );
    await bodyCommitReached;
    let readSettled = false;
    const read = readProjectFile(projectsRoot, projectId, 'locked.html').finally(() => {
      readSettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(readSettled).toBe(false);

    releaseWriter();
    await write;
    const recovered = await read;
    expect(recovered.buffer.toString('utf8')).toContain('locked');
  });

  it('rejects stale deletes and removes an artifact sidecar with the current revision', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>first</body></html>',
      { artifactManifest: { kind: 'html', renderer: 'html', exports: ['html'], title: 'Report' } },
    );
    const first = await readProjectFile(projectsRoot, projectId, 'report.html');
    const second = await writeProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      '<html><body>second</body></html>',
      { expectedEtag: first.etag },
    );
    await expect(deleteProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      undefined,
      first.etag,
    )).rejects.toBeInstanceOf(ProjectFileConflictError);
    await deleteProjectFile(
      projectsRoot,
      projectId,
      'report.html',
      undefined,
      second.etag,
    );
    await expect(readFile(path.join(projectDir, 'report.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(projectDir, 'report.html.artifact.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a stale rename without moving the newer file', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(projectsRoot, projectId, 'notes.md', 'first\n');
    const first = await readProjectFile(projectsRoot, projectId, 'notes.md');
    const second = await writeProjectFile(
      projectsRoot,
      projectId,
      'notes.md',
      'second\n',
      { expectedEtag: first.etag },
    );
    await expect(renameProjectFile(
      projectsRoot,
      projectId,
      'notes.md',
      'renamed.md',
      undefined,
      first.etag,
    )).rejects.toBeInstanceOf(ProjectFileConflictError);
    expect(await readFile(path.join(projectDir, 'notes.md'), 'utf8')).toBe('second\n');
    await renameProjectFile(
      projectsRoot,
      projectId,
      'notes.md',
      'renamed.md',
      undefined,
      second.etag,
    );
    expect(await readFile(path.join(projectDir, 'renamed.md'), 'utf8')).toBe('second\n');
  });

  it('preserves executable mode across atomic file replacement', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(projectsRoot, projectId, 'run.sh', '#!/bin/sh\necho old\n');
    await chmod(path.join(projectDir, 'run.sh'), 0o755);
    await writeProjectFile(projectsRoot, projectId, 'run.sh', '#!/bin/sh\necho new\n');
    expect((await stat(path.join(projectDir, 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('invalidates a cached etag even when size and mtime are unchanged', async () => {
    const { projectsRoot, projectId, projectDir } = fixture();
    await writeProjectFile(projectsRoot, projectId, 'same.txt', 'AAAA');
    const first = await listCachedProjectFiles(projectsRoot, projectId);
    const firstFile = first.files.find(file => file.name === 'same.txt')!;
    await writeFile(path.join(projectDir, 'same.txt'), 'BBBB');
    const timestamp = new Date(firstFile.mtime);
    await utimes(path.join(projectDir, 'same.txt'), timestamp, timestamp);
    expect(await updateCachedProjectFilesFromEvent(
      projectsRoot,
      projectId,
      { kind: 'change', path: 'same.txt' },
    )).toBe(true);
    const second = await listCachedProjectFiles(projectsRoot, projectId);
    expect(second.files.find(file => file.name === 'same.txt')?.etag)
      .not.toBe(firstFile.etag);
  });
});
