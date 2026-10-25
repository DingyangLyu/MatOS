import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMatOSAssetHistorySnapshot } from './snapshot.js'
import { git } from './gitBackend.js'
import { listMatOSAssetRevisions, showMatOSAssetRevision, diffMatOSAssetRevisions, archiveScopeAllowed, retainMatOSAssetHistoryArchive, isScopedAssetArchiveCaller } from './archive.js'
import { restoreMatOSAssetRevision } from './archiveRestore.js'
import { listMatOSAssetHistorySnapshotsWithIssues, listMatOSAssetHistoryReleasesWithIssues } from './records.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-archive-'))
  roots.push(cwd)
  const root = join(cwd, 'matos-assets/packs/matos-core/knowledge/example')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id: 'example', name: 'Example', version: '1.0.0', entry: 'KNOWLEDGE.md' }))
  await writeFile(join(root, 'KNOWLEDGE.md'), '# Original\n')
  return { cwd, root }
}
describe('native asset revision archive', () => {
  test('unreadable archive directories are reported rather than an empty successful archive', async () => {
    const { cwd } = await fixture()
    const previous = process.env.MATOS_SCOPE_REF
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      expect((await listMatOSAssetRevisions({ cwd })).issues).toEqual([])
      await mkdir(join(cwd, '.matos/asset-history'), { recursive: true })
      await writeFile(join(cwd, '.matos/asset-history/records'), 'not a directory')
      await writeFile(join(cwd, '.matos/asset-history/releases'), 'not a directory')
      expect((await listMatOSAssetRevisions({ cwd })).issues).toHaveLength(1)
      expect((await listMatOSAssetHistorySnapshotsWithIssues(cwd)).issues[0]?.directory).toBe(true)
      expect((await listMatOSAssetHistoryReleasesWithIssues(cwd)).issues[0]?.directory).toBe(true)
      expect(await retainMatOSAssetHistoryArchive(cwd)).toMatchObject({ ok: false, issues: [expect.any(String)] })
    } finally {
      if (previous === undefined) delete process.env.MATOS_SCOPE_REF
      else process.env.MATOS_SCOPE_REF = previous
    }
  })
  test('rejects mismatched record filenames and hides internal public-source audit evidence from scoped readers', async () => {
    const { cwd } = await fixture()
    const snapshot = await createMatOSAssetHistorySnapshot({ cwd, scope: 'core', kind: 'manual',
      provenance: { audit: { runId: 'internal-core-run', summary: 'Internal private trajectory' } } })
    const revision = (await listMatOSAssetRevisions({ cwd })).revisions[0]!
    expect(revision.audit?.runId).toBe('internal-core-run')
    await writeFile(join(cwd, '.matos/asset-history/records/asset-snapshot-wrong.json'), JSON.stringify(snapshot))
    const records = await listMatOSAssetHistorySnapshotsWithIssues(cwd)
    expect(records.records).toHaveLength(1)
    expect(records.issues).toHaveLength(1)
    const previous = process.env.MATOS_SCOPE_REF
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      expect((await showMatOSAssetRevision({ cwd, revisionId: revision.revisionId })).revision.audit).toBeUndefined()
      expect((await listMatOSAssetRevisions({ cwd })).revisions[0]?.audit).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.MATOS_SCOPE_REF
      else process.env.MATOS_SCOPE_REF = previous
    }
  })
  test('new local project snapshots remain readable by their recorded user owner only', async () => {
    const { cwd } = await fixture()
    const local = join(cwd, '.matos/assets/knowledge/local')
    await mkdir(local, { recursive: true })
    await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false }))
    await writeFile(join(local, 'asset.json'), JSON.stringify({ type: 'knowledge', id: 'local', name: 'Local', version: '1.0.0', entry: 'README.md' }))
    await writeFile(join(local, 'README.md'), '# Local original\n')
    const previous = process.env.MATOS_SCOPE_REF
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      const snapshot = await createMatOSAssetHistorySnapshot({ cwd, scope: 'project', kind: 'manual' })
      expect(snapshot.provenance?.archiveOwnerScopeRef).toBe('user:alice')
      const archive = await listMatOSAssetRevisions({ cwd })
      expect(archive.total).toBe(1)
      const revisionId = archive.revisions[0]!.revisionId
      expect(archive.revisions[0]!.scopeRef).toBe('user:alice')
      await writeFile(join(local, 'README.md'), '# Local changed\n')
      const preview = await restoreMatOSAssetRevision({ cwd, revisionId })
      expect(await restoreMatOSAssetRevision({ cwd, revisionId, apply: true, expectedCurrent: preview.expectedCurrent })).toMatchObject({ ok: true })
      process.env.MATOS_SCOPE_REF = 'user:bob'
      expect((await listMatOSAssetRevisions({ cwd })).total).toBe(0)
      await expect(showMatOSAssetRevision({ cwd, revisionId })).rejects.toThrow('scope')
    } finally {
      if (previous === undefined) delete process.env.MATOS_SCOPE_REF
      else process.env.MATOS_SCOPE_REF = previous
    }
  })
  test('retains independent commits through GC and exposes exact contents and diff', async () => {
    const { cwd, root } = await fixture()
    const before = await createMatOSAssetHistorySnapshot({ cwd, kind: 'manual', scope: 'core' })
    await writeFile(join(root, 'KNOWLEDGE.md'), '# Changed\n')
    await createMatOSAssetHistorySnapshot({ cwd, kind: 'direct-editor-after', scope: 'core' })
    await git(cwd, ['reflog', 'expire', '--expire=now', '--all'])
    await git(cwd, ['gc', '--prune=now'])
    const archive = await listMatOSAssetRevisions({ cwd, assetRef: 'knowledge:example' })
    expect(archive.total).toBe(2)
    const old = archive.revisions.find(item => item.snapshotId === before.snapshotId)!
    const newer = archive.revisions.find(item => item.snapshotId !== before.snapshotId)!
    expect(old.revisionId).not.toBe(newer.revisionId)
    expect((await showMatOSAssetRevision({ cwd, revisionId: old.revisionId })).files.find(file => file.path === 'KNOWLEDGE.md')?.content).toBe('# Original\n')
    expect((await diffMatOSAssetRevisions({ cwd, from: old.revisionId, to: newer.revisionId })).patch).toContain('+# Changed')
    expect(newer.state).toBe('candidate')
    await rm(root, { recursive: true })
    expect((await listMatOSAssetRevisions({ cwd })).total).toBe(2)
    expect((await retainMatOSAssetHistoryArchive(cwd)).ok).toBe(true)
  })
  test('requires confirmation, refuses stale previews, and records reversible local restores', async () => {
    const { cwd, root } = await fixture()
    await createMatOSAssetHistorySnapshot({ cwd, kind: 'manual', scope: 'core' })
    const revisionId = (await listMatOSAssetRevisions({ cwd })).revisions[0]!.revisionId
    await writeFile(join(root, 'KNOWLEDGE.md'), '# Updated\n')
    const preview = await restoreMatOSAssetRevision({ cwd, revisionId })
    await expect(restoreMatOSAssetRevision({ cwd, revisionId, apply: true })).rejects.toThrow('confirmation')
    await writeFile(join(root, 'KNOWLEDGE.md'), '# Concurrent edit\n')
    await expect(restoreMatOSAssetRevision({ cwd, revisionId, apply: true, expectedCurrent: preview.expectedCurrent })).rejects.toThrow('stale')
    const fresh = await restoreMatOSAssetRevision({ cwd, revisionId })
    expect(await restoreMatOSAssetRevision({ cwd, revisionId, apply: true, expectedCurrent: fresh.expectedCurrent })).toMatchObject({ ok: true, action: 'restored' })
    expect(await readFile(join(root, 'KNOWLEDGE.md'), 'utf8')).toBe('# Original\n')
    expect((await listMatOSAssetRevisions({ cwd })).total).toBe(3)
  })
  test('scope membership is exact and does not imply access to other users or teams', () => {
    expect(archiveScopeAllowed({ scope: 'user', scopeRef: 'user:alice' }, { MATOS_SCOPE_REF: 'user:alice' })).toBe(true)
    expect(archiveScopeAllowed({ scope: 'user', scopeRef: 'user:alice2' }, { MATOS_SCOPE_REF: 'user:alice' })).toBe(false)
    expect(archiveScopeAllowed({ scope: 'team', scopeRef: 'team:lab' }, { MATOS_SCOPE_REF: 'user:alice' })).toBe(false)
    expect(archiveScopeAllowed({ scope: 'team', scopeRef: 'team:lab' }, { MATOS_SCOPE_REF: 'team:lab' })).toBe(true)
    expect(archiveScopeAllowed({ scope: 'user' }, { MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1' })).toBe(false)
    expect(archiveScopeAllowed({ scope: 'team', scopeRef: 'user:alice' }, { MATOS_SCOPE_REF: 'user:alice' })).toBe(false)
    expect(isScopedAssetArchiveCaller({ MATOS_GATEWAY_USER_ID: 'alice' })).toBe(true)
    expect(isScopedAssetArchiveCaller({ MATOS_WORKSPACE_USER_ID: 'alice' })).toBe(true)
  })
  test('archives namespaced asset ids and refuses to restore a deleted nested asset indirectly', async () => {
    const { cwd, root } = await fixture()
    await writeFile(join(root, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id: 'chemistry/example', name: 'Example', version: '1.0.0+revision', entry: 'KNOWLEDGE.md' }))
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested/asset.json'), JSON.stringify({ type: 'knowledge', id: 'nested', version: '1.0.0' }))
    await createMatOSAssetHistorySnapshot({ cwd, kind: 'manual', scope: 'core' })
    const archive = await listMatOSAssetRevisions({ cwd, assetRef: 'knowledge:chemistry/example' })
    expect(archive.total).toBe(1)
    await rm(join(root, 'nested'), { recursive: true })
    const preview = await restoreMatOSAssetRevision({ cwd, revisionId: archive.revisions[0]!.revisionId })
    expect(preview).toMatchObject({ canRestore: false, reason: 'nested-assets-require-independent-rollback' })
    await expect(restoreMatOSAssetRevision({ cwd, revisionId: archive.revisions[0]!.revisionId, apply: true, expectedCurrent: preview.expectedCurrent })).rejects.toThrow('owner review')
  })
  test('shared/global snapshots require registered roots and never fall back to unrelated files', async () => {
    const { cwd } = await fixture()
    await mkdir(join(cwd, '.matos/shared'), { recursive: true })
    await mkdir(join(cwd, '.matos/global'), { recursive: true })
    await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, assetRoots: [], includeDefaultAssetRoots: false,
      assetSources: ['shared', 'global'].map(scope => ({ id: scope, type: 'local', path: scope, scope })) }))
    for (const scope of ['shared', 'global'] as const) {
      await mkdir(join(cwd, '.matos', scope, 'example'), { recursive: true })
      await writeFile(join(cwd, '.matos', scope, 'example/asset.json'), JSON.stringify({ type: 'knowledge', id: `${scope}-example`, version: '1.0.0' }))
      const snapshot = await createMatOSAssetHistorySnapshot({ cwd, kind: 'manual', scope })
      expect(snapshot.files.every(file => file.path.startsWith(`.matos/${scope}/`))).toBe(true)
    }
    expect((await listMatOSAssetRevisions({ cwd })).total).toBe(2)
  })
})
