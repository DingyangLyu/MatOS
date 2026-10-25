import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireMatOSProjectWriteLock } from './projectWriteLock.js'

const roots: string[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MatOS project writer lock', () => {
  test('serializes independent CLI writers and lets an inherited child share its parent lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-write-lock-'))
    roots.push(root)
    const releaseFirst = await acquireMatOSProjectWriteLock({
      cwd: root,
      runId: 'run-1',
      env: {},
    })
    let secondAcquired = false
    const second = acquireMatOSProjectWriteLock({
      cwd: root,
      runId: 'run-2',
      env: {},
      timeoutMs: 5_000,
    }).then(release => {
      secondAcquired = true
      return release
    })
    await delay(50)
    expect(secondAcquired).toBe(false)

    const inheritedRelease = await acquireMatOSProjectWriteLock({
      cwd: root,
      runId: 'nested-run',
      env: {
        MATOS_PROJECT_WRITE_LOCK_HELD: 'run-1',
        MATOS_PROJECT_WRITE_LOCK_CWD: root,
      },
      timeoutMs: 10,
    })
    await inheritedRelease()
    expect(secondAcquired).toBe(false)

    await releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    await releaseSecond()

    const otherRoot = await mkdtemp(join(tmpdir(), 'matos-project-write-lock-other-'))
    roots.push(otherRoot)
    const releaseOther = await acquireMatOSProjectWriteLock({
      cwd: otherRoot,
      runId: 'other-owner',
      env: {},
    })
    await expect(acquireMatOSProjectWriteLock({
      cwd: otherRoot,
      runId: 'cross-project-child',
      env: {
        MATOS_PROJECT_WRITE_LOCK_HELD: 'run-1',
        MATOS_PROJECT_WRITE_LOCK_CWD: root,
      },
      timeoutMs: 10,
    })).rejects.toThrow('Timed out waiting for MatOS project writer')
    await releaseOther()
  })
})
