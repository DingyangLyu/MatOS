import { rm, stat } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../../runtime/tempDirs.js'
import { assetHistoryLockPath, withMatOSAssetHistoryLock } from './lock.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe('asset history lock heartbeat', () => {
  test('refreshes the held lock file mtime so long finalize phases are not judged stale', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-lock-heartbeat-' })
    roots.push(root)
    const path = assetHistoryLockPath(root)
    await withMatOSAssetHistoryLock(
      { cwd: root, operation: 'heartbeat-test', heartbeatMs: 100 },
      async () => {
        const before = (await stat(path)).mtimeMs
        await Bun.sleep(450)
        const after = (await stat(path)).mtimeMs
        expect(after).toBeGreaterThan(before)
      },
    )
  })

  test('keeps independent lock namespaces available while the global ledger lock is held', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-lock-scope-isolation-' })
    roots.push(root)
    let scopedRan = false
    await withMatOSAssetHistoryLock(
      { cwd: root, operation: 'global-holder' },
      async () => {
        await withMatOSAssetHistoryLock(
          {
            cwd: root,
            operation: 'scoped-holder',
            lockKey: 'generated-scoped-asset-sync-user-alice',
            timeoutMs: 50,
          },
          async () => {
            scopedRan = true
          },
        )
      },
    )
    expect(scopedRan).toBe(true)
  })

  test('prevents a foreign-host contender from stealing a heartbeating lock', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-lock-foreign-steal-' })
    roots.push(root)
    const originalHostname = process.env.HOSTNAME
    try {
      process.env.HOSTNAME = 'holder-host'
      let contenderError: unknown
      let contenderRan = false
      await withMatOSAssetHistoryLock(
        {
          cwd: root,
          operation: 'holder',
          heartbeatMs: 100,
          foreignHostStaleMs: 2000,
        },
        async () => {
          // Well past foreignHostStaleMs since acquisition; without the
          // heartbeat the foreign contender below would judge the lock stale
          // by mtime and steal it from the live holder. Margins are wide
          // (staleness 2s vs 100ms heartbeat) so slow CI filesystems cannot
          // starve the heartbeat into a false steal.
          await Bun.sleep(2600)
          process.env.HOSTNAME = 'foreign-host'
          await withMatOSAssetHistoryLock(
            {
              cwd: root,
              operation: 'foreign',
              timeoutMs: 500,
              pollMs: 50,
              foreignHostStaleMs: 2000,
            },
            async () => {
              contenderRan = true
            },
          ).catch(error => {
            contenderError = error
          })
        },
      )
      expect(contenderRan).toBe(false)
      expect(String(contenderError)).toContain('locked by holder')
    } finally {
      if (originalHostname === undefined) {
        delete process.env.HOSTNAME
      } else {
        process.env.HOSTNAME = originalHostname
      }
    }
  })
})
