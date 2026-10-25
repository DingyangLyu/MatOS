import { describe, expect, it } from 'vitest';
import { projectFolderHref, projectWorkspaceHref } from '../../src/utils/projectWorkspace';

describe('container project workspace URL', () => {
  it.each(['/workspace/旧项目 #1', '/home/workspace/旧的中文路径', '/workspace', '/home/workspace'])('opens the exact legacy container folder: %s', folder => {
    const url = new URL(projectFolderHref(folder), 'https://matos.example');
    expect(url.searchParams.get('folder')).toBe(folder);
    expect(url.searchParams.has('workspace')).toBe(false);
  });
  it.each([null, '/host/other', '/workspace-evil/other', '/home/workspace-evil/other', '/workspace/a/../b', '/workspace/a\\b', '/workspace/a\nb'])('rejects unsafe legacy folder paths: %j', folder => {
    expect(() => projectFolderHref(folder)).toThrow();
  });
  it('accepts the production daemon data root under the container home', () => {
    const file = '/home/workspace/.matos/open-design/editor-workspaces/test.code-workspace';
    expect(new URL(projectWorkspaceHref(file), 'https://matos.example').searchParams.get('workspace')).toBe(file);
  });
  it('round-trips Unicode, spaces and URL punctuation through the workspace parameter', () => {
    const file = '/workspace/项目 #1/a & b.code-workspace';
    const url = new URL(projectWorkspaceHref(file), 'https://matos.example');
    expect(url.pathname).toBe('/workspace');
    expect(url.searchParams.get('workspace')).toBe(file);
    expect(url.searchParams.has('folder')).toBe(false);
  });
  it.each([null, '/workspace-evil/a.code-workspace', '/host/a.code-workspace', '/workspace/a/../b.code-workspace', '/workspace/a/./b.code-workspace', '/workspace/a\\b.code-workspace', '/workspace/a\n.code-workspace', '/workspace/project'])('rejects unsafe or non-workspace paths: %j', file => {
    expect(() => projectWorkspaceHref(file)).toThrow();
  });
});
