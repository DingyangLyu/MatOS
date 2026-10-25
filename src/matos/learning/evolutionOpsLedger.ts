import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { basename, dirname, join } from 'node:path'
import { getMatOSDir } from '../project.js'
import { resolveMatOSSelfEvolutionMonitorRoots } from './evolutionMonitorRecords.js'

// Small per-cwd operational JSON ledgers (cross-session failure ledger, daily
// spend ledger) that sit next to the monitor sessions tree. They must stay
// cheap: one small file read on the hot path, locked read-modify-write with an
// atomic tmp+rename only when something actually changes.

const OPS_LEDGER_LOCK_TIMEOUT_MS = 5_000
const OPS_LEDGER_LOCK_STALE_MS = 15_000

// Sibling of the monitor sessions root, so the default layout is
// `<cwd>/.matos/evolution/monitor/<ledger>.json` and env-relocated monitor
// storage (MATOS_EVOLUTION_MONITOR_DIR / MATOS_SESSION_DIR) keeps the ledgers
// beside the records they summarize.
export function matOSEvolutionOpsLedgerDir(cwd: string): string {
  const primaryRoot = resolveMatOSSelfEvolutionMonitorRoots(cwd)[0]
  return primaryRoot
    ? dirname(primaryRoot)
    : join(getMatOSDir(cwd), 'evolution', 'monitor')
}

export async function readMatOSEvolutionOpsLedgerFile<T>(
  path: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    // Missing or corrupt ledgers are treated as empty; the next locked update
    // rewrites a valid file.
    return undefined
  }
}

// Same mkdir-based lock approach as withMonitorRecordsLock in
// evolutionMonitorRecords.ts: concurrent detached evolution workers can
// conclude at the same moment, and read-modify-write without a lock loses
// updates on FUSE/NFS filesystems. On lock timeout we proceed unlocked — a rare
// lost ledger update is better than blocking or dropping the pipeline.
// Exported so other hidden-pipeline writers of shared cross-session files
// (for example the OD memory bridge JSONL) can serialize appends the same way.
export async function withMatOSEvolutionOpsFileLock(
  path: string,
  run: () => Promise<void>,
): Promise<void> {
  const lockDir = `${path}.lock`
  const start = Date.now()
  let locked = false
  while (Date.now() - start < OPS_LEDGER_LOCK_TIMEOUT_MS) {
    try {
      await mkdir(lockDir)
      locked = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        break
      }
      const info = await stat(lockDir).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > OPS_LEDGER_LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await sleep(25)
    }
  }
  try {
    await run()
  } finally {
    if (locked) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

const OPS_LEDGER_TMP_MAX_AGE_MS = 60 * 60 * 1000
const OPS_LEDGER_TMP_SWEEP_MAX = 20

// A crash between the tmp write and the rename in
// updateMatOSEvolutionOpsLedgerFile leaks `<ledger>.tmp-*` files that nothing
// else ever cleans (the direct-editor retention sweep only covers the runs
// tree). Bounded best-effort sweep of clearly stale siblings, run under the
// ledger lock right before the next write; the one-hour age floor keeps any
// legitimately in-flight unlocked-fallback write safe.
async function removeStaleOpsLedgerTmpFiles(path: string): Promise<void> {
  const prefix = `${basename(path)}.tmp-`
  let names: string[]
  try {
    names = await readdir(dirname(path))
  } catch {
    return
  }
  let removed = 0
  for (const name of names) {
    if (removed >= OPS_LEDGER_TMP_SWEEP_MAX) {
      return
    }
    if (!name.startsWith(prefix)) {
      continue
    }
    const tmpPath = join(dirname(path), name)
    const info = await stat(tmpPath).catch(() => undefined)
    if (!info?.isFile() || Date.now() - info.mtimeMs < OPS_LEDGER_TMP_MAX_AGE_MS) {
      continue
    }
    await rm(tmpPath, { force: true }).catch(() => undefined)
    removed += 1
  }
}

// Locked read-modify-write. `update` returns the next ledger value, or
// undefined to signal "no write needed". Writes go through a tmp file plus
// rename so concurrent readers never observe a torn ledger.
export async function updateMatOSEvolutionOpsLedgerFile<T>(
  path: string,
  update: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  await mkdir(dirname(path), { recursive: true })
  let result: T | undefined
  await withMatOSEvolutionOpsFileLock(path, async () => {
    const current = await readMatOSEvolutionOpsLedgerFile<T>(path)
    const next = update(current)
    result = next ?? current
    if (next === undefined) {
      return
    }
    await removeStaleOpsLedgerTmpFiles(path)
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmpPath, path)
  })
  return result
}
