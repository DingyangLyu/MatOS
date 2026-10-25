import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectEditorWorkspacePath, syncProjectEditorWorkspace } from '../src/services/project-editor-workspace.js';

describe('named editor workspace projection', () => {
  let root: string;
  let input: Parameters<typeof syncProjectEditorWorkspace>[0];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'editor-project-')));
    const projectDir = path.join(root, '工作区 #1');
    await mkdir(projectDir);
    input = { dataDir: root, projectId: '../../legacy-id', name: '中文 "名称"', projectDir };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('does not create a workspace on a rename until the user opens the IDE', async () => {
    expect(await syncProjectEditorWorkspace({ ...input, onlyIfPresent: true })).toBeNull();
  });
  it('writes safe JSON with an opaque filename and a stable real folder path', async () => {
    const file = await syncProjectEditorWorkspace(input);
    expect(path.dirname(file!)).toBe(path.join(root, 'editor-workspaces'));
    expect(JSON.parse(await readFile(file!, 'utf8')).folders).toEqual([{ name: input.name, path: input.projectDir }]);
    expect(await syncProjectEditorWorkspace({ ...input, name: 'renamed' })).toBe(file);
    expect(JSON.parse(await readFile(file!, 'utf8')).folders[0]).toEqual({ name: 'renamed', path: input.projectDir });
  });
  it('rejects symlink workspace directories without writing outside the cache', async () => {
    await symlink(input.projectDir, path.join(root, 'editor-workspaces'));
    await expect(syncProjectEditorWorkspace(input)).rejects.toThrow('invalid editor workspace directory');
  });
  it('rejects symlink workspace files without touching their targets', async () => {
    await mkdir(path.join(root, 'editor-workspaces'));
    const sentinel = path.join(input.projectDir, 'keep.txt');
    await writeFile(sentinel, 'keep');
    await symlink(sentinel, projectEditorWorkspacePath(root, input.projectId));
    await expect(syncProjectEditorWorkspace(input)).rejects.toThrow('invalid editor workspace file');
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });
});
