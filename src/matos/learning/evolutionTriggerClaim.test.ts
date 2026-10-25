import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { withMatOSEvolutionTriggerClaim } from './evolutionTriggerClaim.js'

describe('MatOS evolution trigger claim', () => {
  test('does not delete a claim another owner reclaimed mid-run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-claim-owner-'))
    const claimsDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'claims',
      'session-owner',
    )
    let foreignClaimPath = ''
    const result = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-owner',
        triggerKey: 'user-feedback:event-x',
      },
      async () => {
        const entries = await readdir(claimsDir)
        foreignClaimPath = join(claimsDir, entries[0] ?? 'missing.claim')
        // Simulate another process reclaiming this trigger while we run.
        await writeFile(
          foreignClaimPath,
          JSON.stringify({
            schemaVersion: 1,
            pid: process.pid + 100000,
            hostId: 'other-host',
            createdAt: '2000-01-01T00:00:00.000Z',
            triggerKey: 'user-feedback:event-x',
            sessionId: 'session-owner',
          }),
          'utf8',
        )
        return 'ran'
      },
    )
    expect(result).toBe('ran')
    // The original holder's release must NOT delete the new owner's claim.
    const survived = await stat(foreignClaimPath)
      .then(() => true)
      .catch(() => false)
    expect(survived).toBe(true)
    expect(await readFile(foreignClaimPath, 'utf8')).toContain('other-host')
  })

  test('blocks duplicate trigger claims until the holder releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-claim-'))
    let entered = false
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-claim-test',
        triggerKey: 'user-feedback:event-1',
      },
      async () => {
        entered = true
        await held
        return 'ok'
      },
    )
    // Wait until the first claim is actually held instead of assuming a fixed
    // head start: on a loaded FUSE mount the O_EXCL claim write alone can take
    // longer than any sleep this test could reasonably pick.
    const deadline = Date.now() + 10_000
    while (!entered && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(entered).toBe(true)
    const second = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-claim-test',
        triggerKey: 'user-feedback:event-1',
      },
      async () => 'duplicate',
    )
    release()
    expect(await first).toBe('ok')
    expect(second).toBeUndefined()
  })

  test('acquiring a claim sweeps aged stale-reclaim residue but keeps fresh residue and live claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-claim-residue-'))
    const claimsDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'claims',
      'session-residue',
    )
    await mkdir(claimsDir, { recursive: true })
    // Crash residue: a reclaim renamed a stale claim aside and died before rm.
    const agedResidue = join(claimsDir, 'deadbeef.claim.stale-1-2-3')
    // Fresh residue could belong to a reclaim currently in flight.
    const freshResidue = join(claimsDir, 'cafebabe.claim.stale-4-5-6')
    // A live foreign claim file must never be touched by the sweep.
    const foreignClaim = join(claimsDir, '0123456789abcdef.claim')
    await writeFile(agedResidue, '{}', 'utf8')
    await writeFile(freshResidue, '{}', 'utf8')
    await writeFile(foreignClaim, '{}', 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(agedResidue, old, old)

    const result = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-residue',
        triggerKey: 'user-feedback:event-residue',
      },
      async () => 'ran',
    )
    expect(result).toBe('ran')

    const names = await readdir(claimsDir)
    expect(names).not.toContain('deadbeef.claim.stale-1-2-3')
    expect(names).toContain('cafebabe.claim.stale-4-5-6')
    expect(names).toContain('0123456789abcdef.claim')
  })

  test('allows a new claim after the previous holder releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-claim-release-'))
    const first = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-claim-release',
        triggerKey: 'session-end',
      },
      async () => 'first',
    )
    const second = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-claim-release',
        triggerKey: 'session-end',
      },
      async () => 'second',
    )
    expect(first).toBe('first')
    expect(second).toBe('second')
  })
})
