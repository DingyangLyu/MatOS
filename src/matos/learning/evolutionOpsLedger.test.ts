import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  readMatOSEvolutionOpsLedgerFile,
  updateMatOSEvolutionOpsLedgerFile,
} from './evolutionOpsLedger.js'

type CounterLedger = { count: number }

describe('MatOS evolution ops ledger', () => {
  test('concurrent locked updates do not lose increments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-ops-ledger-'))
    const path = join(root, 'monitor', 'counter-ledger.json')
    await Promise.all(
      Array.from({ length: 8 }, () =>
        updateMatOSEvolutionOpsLedgerFile<CounterLedger>(path, current => ({
          count: (current?.count ?? 0) + 1,
        })),
      ),
    )
    const final = await readMatOSEvolutionOpsLedgerFile<CounterLedger>(path)
    expect(final?.count).toBe(8)
    // Neither the lock dir nor any atomic-write tmp survives the updates.
    const names = await readdir(dirname(path))
    expect(names).toEqual(['counter-ledger.json'])
  })

  test('update returning undefined leaves the ledger untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-ops-noop-'))
    const path = join(root, 'monitor', 'spend-ledger.json')
    await updateMatOSEvolutionOpsLedgerFile<CounterLedger>(path, () => ({
      count: 3,
    }))
    const before = await stat(path)
    const result = await updateMatOSEvolutionOpsLedgerFile<CounterLedger>(
      path,
      () => undefined,
    )
    expect(result).toEqual({ count: 3 })
    const after = await stat(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test('the next locked write sweeps aged tmp residue but keeps fresh and foreign files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-ops-tmp-'))
    const dir = join(root, 'monitor')
    const path = join(dir, 'failure-ledger.json')
    await mkdir(dir, { recursive: true })
    // Crash residue from a writer that died between tmp write and rename.
    const agedTmp = join(dir, 'failure-ledger.json.tmp-1234-1')
    // A fresh tmp could belong to an in-flight unlocked-fallback writer.
    const freshTmp = join(dir, 'failure-ledger.json.tmp-5678-2')
    // Another ledger's residue is that ledger's own sweep's business.
    const foreignTmp = join(dir, 'spend-ledger.json.tmp-9-9')
    await writeFile(agedTmp, '{', 'utf8')
    await writeFile(freshTmp, '{', 'utf8')
    await writeFile(foreignTmp, '{', 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(agedTmp, old, old)
    await utimes(foreignTmp, old, old)

    await updateMatOSEvolutionOpsLedgerFile<CounterLedger>(path, () => ({
      count: 1,
    }))

    const names = (await readdir(dir)).sort()
    expect(names).not.toContain('failure-ledger.json.tmp-1234-1')
    expect(names).toContain('failure-ledger.json.tmp-5678-2')
    expect(names).toContain('spend-ledger.json.tmp-9-9')
    expect(names).toContain('failure-ledger.json')
    expect(
      await readMatOSEvolutionOpsLedgerFile<CounterLedger>(path),
    ).toEqual({ count: 1 })
  })
})
