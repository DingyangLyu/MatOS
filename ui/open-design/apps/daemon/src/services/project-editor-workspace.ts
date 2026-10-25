import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function projectEditorWorkspacePath(dataDir: string, projectId: string): string {
  // The opaque id is hashed so legacy ids cannot influence filesystem paths.
  const key = createHash('sha256').update(projectId).digest('hex');
  return path.join(dataDir, 'editor-workspaces', `${key}.code-workspace`);
}

/** A thin OpenVSCode view over the authoritative project root; never move it. */
export async function syncProjectEditorWorkspace(input: {
  dataDir: string;
  projectId: string;
  name: string;
  projectDir: string;
  onlyIfPresent?: boolean;
}): Promise<string | null> {
  const target = projectEditorWorkspacePath(input.dataDir, input.projectId);
  const root = await realpath(input.dataDir);
  const directory = path.dirname(target);
  if (input.onlyIfPresent) {
    try { await lstat(directory); } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
      || path.dirname(await realpath(directory)) !== root) {
    throw new Error('invalid editor workspace directory');
  }
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('invalid editor workspace file');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    if (input.onlyIfPresent) return null;
  }
  if (!path.isAbsolute(input.projectDir)) throw new Error('project path must be absolute');
  const projectDir = await realpath(input.projectDir);
  if (!(await lstat(projectDir)).isDirectory()) throw new Error('project path must be a directory');
  const content = `${JSON.stringify({
    // JSON escaping safely preserves legacy display names, including names
    // created before the current length limit. Opening them is not a rename.
    folders: [{ name: input.name, path: projectDir }],
  }, null, 2)}\n`;
  // Avoid rewriting an unchanged workspace while the IDE is watching it.
  try { if (await readFile(target, 'utf8') === content) return target; } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
  }
  return target;
}
