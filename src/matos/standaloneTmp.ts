import { createHash } from 'node:crypto'
import { lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Unix socket names are length-limited. A short, owned alias keeps sockets
 * addressable while every temporary file still lives in the chosen state root. */
export async function ensureMatOSStandaloneTmp(storage: string): Promise<string> {
  await mkdir(storage, { recursive: true, mode: 0o700 })
  const target = await realpath(storage)
  const uid = process.getuid?.()
  const info = await lstat(target)
  if (uid === undefined || info.uid !== uid || !info.isDirectory()) {
    throw new Error('Standalone temporary storage must be a directory owned by the current user')
  }
  if (Buffer.byteLength(target) <= 40) return target
  const name = `matos-${uid}-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`
  const alias = join('/var/tmp', name)
  try { await symlink(target, alias, 'dir') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const entry = await lstat(alias)
  if (!entry.isSymbolicLink() || entry.uid !== uid || resolve(await readlink(alias)) !== target) {
    throw new Error(`Temporary path is already owned by another location: ${alias}`)
  }
  return alias
}
