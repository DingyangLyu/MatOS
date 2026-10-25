import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

/** Treat concurrent growth, oversized files and symlinks as incomplete evidence. */
export async function readEvolutionEvidenceFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 8 * 1024 * 1024) {
      throw new Error('Evolution evidence must be a bounded regular file.')
    }
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size)
      throw new Error('Evolution evidence changed while reading.')
    return bytes.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}
