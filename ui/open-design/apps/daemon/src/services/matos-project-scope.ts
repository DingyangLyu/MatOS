import { realpath } from 'node:fs/promises';
import { matosCwd } from './matos-cli.js';

export interface MatOSProjectScopeDeps { resolveProjectCwd?: (projectId: string) => string | undefined | Promise<string | undefined> }

/** Resolve only registered workspace projects, never a browser-supplied path. */
export async function matosProjectScope(projectId: unknown, deps: MatOSProjectScopeDeps) {
  if (projectId !== undefined && (typeof projectId !== 'string' || !/^[\w-]{1,128}$/.test(projectId))) throw new Error('Invalid project ID');
  const selected = typeof projectId === 'string' ? await deps.resolveProjectCwd?.(projectId) : matosCwd();
  if (!selected) throw new Error('Project unavailable in this workspace');
  const cwd = await realpath(selected).catch(() => { throw new Error('Project directory unavailable'); });
  return { cwd, projectId: projectId as string | undefined };
}
