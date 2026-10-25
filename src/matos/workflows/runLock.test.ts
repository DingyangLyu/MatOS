import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import {
  WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS,
  reclaimStaleWorkflowRunLock,
  withWorkflowRunLock,
} from './runLock.js'

describe('workflow run lock', () => {
  test('serializes concurrent mutations for one run directory', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-'))
    const order: string[] = []
    let resolveFirstEntered!: () => void
    const firstEntered = new Promise<void>(resolve => {
      resolveFirstEntered = resolve
    })

    const first = withWorkflowRunLock(runDir, async () => {
      order.push('first-start')
      resolveFirstEntered()
      await delay(25)
      order.push('first-end')
      return 'first'
    })
    await firstEntered
    const second = withWorkflowRunLock(runDir, async () => {
      order.push('second')
      return 'second'
    })

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  test('records non-secret lock metadata while held', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-meta-'))
    let metadata = ''

    await withWorkflowRunLock(
      runDir,
      async lock => {
        metadata = await readFile(lock.metadataPath, 'utf8')
      },
      { owner: 'test-owner' },
    )

    expect(metadata).toContain('test-owner')
    expect(metadata).toContain('acquiredAt')
  })

  test('reclaims a stale lock left by a dead process', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-stale-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // A pid that cannot be alive: beyond pid_max on Linux.
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: 'pid:99999999', pid: 99999999, acquiredAt: '2026-06-10T00:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    )

    const result = await withWorkflowRunLock(
      runDir,
      async () => 'reclaimed',
      { timeoutMs: 2000 },
    )
    expect(result).toBe('reclaimed')
  })

  test('reclaims a stale lock left by a zombie process', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-zombie-'))
    const helperPath = join(runDir, 'make-zombie.py')
    const pidPath = join(runDir, 'zombie.pid')
    await writeFile(
      helperPath,
      [
        'import os',
        'import sys',
        'import time',
        'pid = os.fork()',
        'if pid == 0:',
        '    os._exit(0)',
        "with open(sys.argv[1], 'w', encoding='utf-8') as handle:",
        "    handle.write(f'{pid}\\n')",
        'time.sleep(30)',
        '',
      ].join('\n'),
      'utf8',
    )
    const helper = Bun.spawn(['python3', helperPath, pidPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      let zombiePid = 0
      let zombieState = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try {
          zombiePid = Number((await readFile(pidPath, 'utf8')).trim())
          const status = await readFile(`/proc/${zombiePid}/status`, 'utf8')
          zombieState = /^State:\s+([A-Z])/m.exec(status)?.[1] ?? ''
          if (zombieState === 'Z') {
            break
          }
        } catch {
          // The helper has not published its child yet.
        }
        await delay(25)
      }
      expect(zombiePid).toBeGreaterThan(0)
      expect(zombieState).toBe('Z')

      const lockDir = join(runDir, '.run.lock')
      await mkdir(lockDir)
      await writeFile(
        join(lockDir, 'lock.json'),
        `${JSON.stringify({ owner: `pid:${zombiePid}`, pid: zombiePid, acquiredAt: '2026-06-10T00:00:00.000Z' }, null, 2)}\n`,
        'utf8',
      )
      const result = await withWorkflowRunLock(
        runDir,
        async () => 'reclaimed-zombie',
        { timeoutMs: 2000 },
      )
      expect(result).toBe('reclaimed-zombie')
    } finally {
      helper.kill()
      await helper.exited
    }
  })

  test('does not reclaim a recent lock held by a live process', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-live-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // No pidStartTime (old-format lock): within the age backstop a live pid
    // keeps the lock held.
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: `pid:${process.pid}`, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )

    await expect(
      withWorkflowRunLock(runDir, async () => 'should-not-run', {
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).rejects.toThrow('Timed out waiting for workflow run lock')
  })

  /**
   * Reads the same /proc identity the lock records: process start time in
   * clock ticks since boot (field 22 of /proc/<pid>/stat, counted after the
   * last ')' because comm may contain spaces).
   */
  async function readProcStartTime(pid: number): Promise<string | undefined> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const closing = stat.lastIndexOf(')')
      if (closing < 0) return undefined
      return stat.slice(closing + 1).trim().split(/\s+/)[19]
    } catch {
      return undefined
    }
  }

  test('acquiring records the holder process start time on Linux', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-identity-'))
    let metadata: { pid?: number; pidStartTime?: string } = {}
    await withWorkflowRunLock(runDir, async lock => {
      metadata = JSON.parse(await readFile(lock.metadataPath, 'utf8'))
    })
    expect(metadata.pid).toBe(process.pid)
    expect(metadata.pidStartTime).toBe(await readProcStartTime(process.pid))
  })

  test('reclaims a lock whose pid was recycled by another process', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-recycled-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // The pid is alive (this very process) but the recorded start time belongs
    // to a different, long-dead process: exactly what pid recycling looks
    // like. Liveness alone would pin this lock forever (P2-4).
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify(
        {
          owner: `pid:${process.pid}`,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          pidStartTime: '1',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const result = await withWorkflowRunLock(
      runDir,
      async () => 'reclaimed-recycled',
      { timeoutMs: 2000 },
    )
    expect(result).toBe('reclaimed-recycled')
  })

  test('reclaims an over-age lock when the holder identity is unverifiable', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-age-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // Live pid, no recorded start time (old-format lock), acquired beyond the
    // age backstop: this is indistinguishable from a recycled pid, so the
    // backstop reclaims it instead of timing out forever.
    const beyondBackstop = new Date(
      Date.now() - WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS - 60_000,
    ).toISOString()
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: `pid:${process.pid}`, pid: process.pid, acquiredAt: beyondBackstop }, null, 2)}\n`,
      'utf8',
    )

    const result = await withWorkflowRunLock(
      runDir,
      async () => 'reclaimed-over-age',
      { timeoutMs: 2000 },
    )
    expect(result).toBe('reclaimed-over-age')
  })

  test('age backstop does not steal an unverifiable lock backed by a live heartbeat', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-age-heartbeat-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // Live-but-identity-unverifiable holder (no recorded start time, e.g. a
    // non-Linux host or a lock written mid-upgrade) that has legitimately
    // held the lock through a very long advance segment. Its worker stamps a
    // fresh heartbeat, so the age backstop must NOT reclaim (P2-4: reclaiming
    // here would put a second advancer on a run that is actively advancing).
    const beyondBackstop = new Date(
      Date.now() - WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS - 60_000,
    ).toISOString()
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: `pid:${process.pid}`, pid: process.pid, acquiredAt: beyondBackstop }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(runDir, 'heartbeat.json'),
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      'utf8',
    )

    await expect(
      withWorkflowRunLock(runDir, async () => 'should-not-run', {
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).rejects.toThrow('Timed out waiting for workflow run lock')
  })

  test('age backstop still reclaims when the run heartbeat is stale', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-age-stale-hb-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    const beyondBackstop = new Date(
      Date.now() - WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS - 60_000,
    ).toISOString()
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: `pid:${process.pid}`, pid: process.pid, acquiredAt: beyondBackstop }, null, 2)}\n`,
      'utf8',
    )
    // The worker stopped stamping long ago (died without releasing): the
    // stale heartbeat must not pin the lock forever.
    await writeFile(
      join(runDir, 'heartbeat.json'),
      `${JSON.stringify({
        pid: process.pid,
        at: new Date(Date.now() - 10 * 60_000).toISOString(),
      })}\n`,
      'utf8',
    )

    const result = await withWorkflowRunLock(
      runDir,
      async () => 'reclaimed-stale-heartbeat',
      { timeoutMs: 2000 },
    )
    expect(result).toBe('reclaimed-stale-heartbeat')
  })

  test('arbitrates concurrent stale-lock reclaims to exactly one holder', async () => {
    // Regression (P1-3): stale reclaim used to be rm-then-mkdir with no
    // arbitration, so several acquirers that all judged the same lock stale
    // could each delete whatever was at the lock path (including a
    // competitor's FRESH lock) and every one of them then "acquired" — two
    // concurrent run advancers. Real concurrent claims against a real stale
    // lock dir must serialize to exactly one holder at a time, every round.
    const rounds = 10
    const racers = 6
    for (let round = 0; round < rounds; round += 1) {
      const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-reclaim-race-'))
      const lockDir = join(runDir, '.run.lock')
      await mkdir(lockDir)
      // A pid that cannot be alive: beyond pid_max on Linux.
      await writeFile(
        join(lockDir, 'lock.json'),
        `${JSON.stringify({ owner: 'pid:99999999', pid: 99999999, acquiredAt: '2026-06-10T00:00:00.000Z' }, null, 2)}\n`,
        'utf8',
      )
      let inside = 0
      let maxInside = 0
      let entries = 0
      await Promise.all(
        Array.from({ length: racers }, () =>
          withWorkflowRunLock(
            runDir,
            async () => {
              inside += 1
              maxInside = Math.max(maxInside, inside)
              entries += 1
              await delay(10)
              inside -= 1
            },
            { timeoutMs: 10_000, pollMs: 5 },
          ),
        ),
      )
      expect(maxInside).toBe(1)
      expect(entries).toBe(racers)
    }
  }, 60_000)

  test('never reclaims an over-age lock from the verified original holder', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-long-hold-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    // Run advancement (resume / initial start) holds the run lock for the
    // whole execution segment, which can legitimately exceed any age
    // threshold. With a matching recorded start time the holder is verified
    // alive, so age must NOT make the lock stale.
    const beyondBackstop = new Date(
      Date.now() - WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS - 60_000,
    ).toISOString()
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify(
        {
          owner: `pid:${process.pid}`,
          pid: process.pid,
          acquiredAt: beyondBackstop,
          pidStartTime: await readProcStartTime(process.pid),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    await expect(
      withWorkflowRunLock(runDir, async () => 'should-not-run', {
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).rejects.toThrow('Timed out waiting for workflow run lock')
  })

  test('stale-lock reclaim keeps mutual exclusion under concurrent acquirers', async () => {
    // Regression: reclaim used rm + retry-mkdir, so two acquirers that both
    // observed the stale lock could delete each other's fresh lock and enter
    // the critical section together. Rename-based reclaim has a single winner.
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-race-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: 'pid:99999999', pid: 99999999, acquiredAt: '2026-06-10T00:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    )

    let active = 0
    let maxActive = 0
    const contenders = Array.from({ length: 8 }, (_, index) =>
      withWorkflowRunLock(
        runDir,
        async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await delay(20)
          active -= 1
          return index
        },
        { timeoutMs: 10_000, pollMs: 5 },
      ),
    )

    const results = await Promise.all(contenders)
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(maxActive).toBe(1)
  })

  test('reclaim helper removes a dead-pid lock exactly once and leaves live locks alone', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-reclaim-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: 'pid:99999999', pid: 99999999, acquiredAt: '2026-06-10T00:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    )

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => reclaimStaleWorkflowRunLock(lockDir)),
    )
    expect(attempts.filter(Boolean)).toHaveLength(1)
    await expect(stat(lockDir)).rejects.toThrow()

    // A live holder must never be reclaimed. (Fresh acquiredAt: an
    // identity-less lock beyond the age backstop is reclaimable by design,
    // which is covered by the over-age tests above.)
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'lock.json'),
      `${JSON.stringify({ owner: `pid:${process.pid}`, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
    expect(await reclaimStaleWorkflowRunLock(lockDir)).toBe(false)
    expect((await stat(lockDir)).isDirectory()).toBe(true)
  })

  test('reclaims an aged lock dir whose metadata write never happened', async () => {
    // Regression: a crash (or ENOSPC) between mkdir and the metadata write
    // left a metadata-less lock dir that was never considered stale, so every
    // later acquire timed out forever.
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-orphan-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)
    const past = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lockDir, past, past)

    const result = await withWorkflowRunLock(runDir, async () => 'reclaimed', {
      timeoutMs: 2000,
    })
    expect(result).toBe('reclaimed')
  })

  test('does not reclaim a fresh metadata-less lock dir (racing acquirer)', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-run-lock-fresh-'))
    const lockDir = join(runDir, '.run.lock')
    await mkdir(lockDir)

    await expect(
      withWorkflowRunLock(runDir, async () => 'should-not-run', {
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).rejects.toThrow('Timed out waiting for workflow run lock')
    expect((await stat(lockDir)).isDirectory()).toBe(true)
  })
})
