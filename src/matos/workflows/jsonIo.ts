import { open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

// Atomic write: serialize to a unique temp file in the same directory, then
// rename over the target. A crash mid-write leaves the temp file (harmless)
// instead of a truncated/invalid JSON at `path`, so recovery/resume always read
// either the old or the new complete document. The unique temp name keeps
// concurrent writers from clobbering each other's temp before the rename, and
// the rename also makes pointer flips (e.g. run.json graphSnapshotPath) atomic.
//
// `durable: true` additionally fsyncs the temp file before the rename. Plain
// writes survive process crashes but not necessarily OS/power failure (the
// rename can be journaled before the data blocks). Reserved for low-frequency,
// high-value transitions (terminal run status) — fsyncing every node-state
// write would dominate run time on network filesystems.
export async function writeJson(
  path: string,
  value: unknown,
  options: { durable?: boolean } = {},
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    if (options.durable) {
      await handle.sync().catch(() => {
        // fsync support varies by filesystem; durability is best-effort.
      })
    }
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  if (options.durable) {
    // The rename itself is a directory-entry change: without fsyncing the
    // parent directory, an OS crash/power loss can roll the rename back and
    // resurrect the old file content — the exact scenario `durable` exists
    // to prevent. Same best-effort posture as the file sync above.
    try {
      const dir = await open(dirname(path), 'r')
      try {
        await dir.sync().catch(() => {})
      } finally {
        await dir.close()
      }
    } catch {
      // Directory fsync unsupported on this platform/filesystem.
    }
  }
}
