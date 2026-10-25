import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type LockRecord = {
  token: string
  pid: number
  runId: string
  createdAt: string
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockRecord
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function acquireMatOSProjectWriteLock(input: {
  cwd: string
  runId: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<() => Promise<void>> {
  if (
    input.env?.MATOS_PROJECT_WRITE_LOCK_HELD &&
    input.env.MATOS_PROJECT_WRITE_LOCK_CWD &&
    resolve(input.env.MATOS_PROJECT_WRITE_LOCK_CWD) === resolve(input.cwd)
  ) {
    return async () => {}
  }
  const lockDir = join(input.cwd, '.matos', 'workbench', 'project-write.lock')
  const lockFile = join(lockDir, 'owner.json')
  const token = randomUUID()
  const timeoutAt = Date.now() + (input.timeoutMs ?? 30 * 60_000)
  await mkdir(join(input.cwd, '.matos', 'workbench'), { recursive: true })
  while (true) {
    try {
      await mkdir(lockDir)
      try {
        await writeFile(lockFile, `${JSON.stringify({
          token,
          pid: process.pid,
          runId: input.runId,
          createdAt: new Date().toISOString(),
        } satisfies LockRecord)}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
      const owner = await readLock(lockFile)
      const orphaned = !owner && await stat(lockDir)
        .then(info => Date.now() - info.mtimeMs > 5_000, () => false)
      if ((owner && !pidAlive(owner.pid)) || orphaned) {
        const stalePath = `${lockDir}.stale.${randomUUID()}`
        try {
          await rename(lockDir, stalePath)
          await rm(stalePath, { recursive: true, force: true })
          continue
        } catch {
          await sleep(50)
          continue
        }
      }
      if (Date.now() >= timeoutAt) {
        throw new Error(`Timed out waiting for MatOS project writer ${owner?.runId ?? 'unknown'}`)
      }
      await sleep(100)
    }
  }
  return async () => {
    const owner = await readLock(lockFile)
    if (owner?.token === token) await rm(lockDir, { recursive: true, force: true })
  }
}
