import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

// writeGeneratedAssetFile writes `.<uuid>.tmp` then renames; a crash between
// the two leaves dot-tmp residue in generated asset dirs forever (dot names
// are invisible to asset discovery). Swept opportunistically on the next
// write to the same directory: only exact `.<uuid>.tmp` names, only plain
// files, only after a generous age gate (any legitimate in-flight write
// finishes in seconds), and a bounded number per call.
const GENERATED_ASSET_TMP_NAME = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const GENERATED_ASSET_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const GENERATED_ASSET_TMP_SWEEP_MAX_REMOVALS = 10

export async function ensureGeneratedAssetDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await chmod(path, 0o755)
}

export async function sweepStaleGeneratedAssetTmpFiles(
  dir: string,
  options: {
    now?: number
    maxAgeMs?: number
    maxRemovals?: number
  } = {},
): Promise<number> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? GENERATED_ASSET_TMP_MAX_AGE_MS
  const maxRemovals = Math.max(
    0,
    options.maxRemovals ?? GENERATED_ASSET_TMP_SWEEP_MAX_REMOVALS,
  )
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (removed >= maxRemovals) {
      break
    }
    if (!GENERATED_ASSET_TMP_NAME.test(name)) {
      continue
    }
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || now - info.mtimeMs < maxAgeMs) {
        continue
      }
      await unlink(path)
      removed += 1
    } catch {
      // Concurrent removal or transient stat failure: leave it for the next
      // sweep rather than failing the write that triggered it.
    }
  }
  return removed
}

export async function writeGeneratedAssetFile(
  path: string,
  content: string,
): Promise<void> {
  const dir = dirname(path)
  await ensureGeneratedAssetDir(dir)
  const tempPath = join(dir, `.${randomUUID()}.tmp`)
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o644 })
  await rename(tempPath, path)
  await chmod(path, 0o644)
  // Best-effort crash-residue cleanup for this directory; never fails the
  // write that just succeeded.
  await sweepStaleGeneratedAssetTmpFiles(dir).catch(() => 0)
}
