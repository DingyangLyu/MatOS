import type { Project } from '../types';

export function visibleProjectDirectory(project: Project): string | null {
  const value = project.overview?.projectDir ?? project.metadata?.baseDir;
  try { projectFolderHref(value); return value!; } catch { return null; }
}

function containerProjectPath(value: unknown): string {
  if (typeof value !== 'string'
      || !['/workspace', '/home/workspace'].some(root => value === root || value.startsWith(`${root}/`))
      || /[\\\u0000-\u001f\u007f]/u.test(value)
      || value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('invalid container project path');
  }
  return value;
}

/** Only pass container-visible workspace files to the same-origin IDE. */
export function projectWorkspaceHref(workspacePath: unknown): string {
  const file = containerProjectPath(workspacePath);
  if (!file.endsWith('.code-workspace')) throw new Error('invalid container workspace file');
  return `/workspace?workspace=${encodeURIComponent(file)}`;
}

/** Compatibility with old daemons: the folder must come from project detail,
 * never from a browser-side name/id reconstruction or stale component prop. */
export function projectFolderHref(folderPath: unknown): string {
  return `/workspace?folder=${encodeURIComponent(containerProjectPath(folderPath))}`;
}
