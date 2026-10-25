import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMatOSAssetRegistry, serializeMatOSAssetRegistry } from '../registry.js'
import type { MatOSAsset } from '../types.js'
import { buildMatOSAssetGraphIndex } from './buildGraphIndex.js'
import { writeMatOSAssetHistorySnapshotRecord } from '../history/records.js'

function asset(type: string, id: string, scope: string, dependencies: string[] = [], overlayOf?: string): MatOSAsset {
  return {
    type, id, name: `${scope}-${id}`, version: '1.0.0', canonicalKey: `${type}:${id}@1.0.0`,
    description: scope, relativePath: id, absolutePath: `/fixture/${scope}/${id}`,
    entryRelativePath: undefined, entryAbsolutePath: undefined,
    manifestPath: `/fixture/${scope}/${id}/asset.json`, manifestDir: `/fixture/${scope}/${id}`,
    source: 'pack', sourcePath: '/fixture', packId: scope, packName: scope, packVersion: '1.0.0',
    tags: [], permissions: [], dependencies, mounts: {}, runtime: {}, lifecycle: { status: 'enabled' },
    metadata: { sourceProvenance: { scope }, ...(overlayOf ? { overlayOf } : {}) },
  }
}

describe('effective asset graph and index', () => {
  test('public lineage exposes revisions but not hidden snapshots or internal evolution evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-public-graph-'))
    const previous = process.env.MATOS_SCOPE_REF
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      for (const id of ['planner', 'hidden-internal']) {
        await writeMatOSAssetHistorySnapshotRecord(cwd, { schemaVersion: 1, snapshotId: `asset-snapshot-${id}`,
          kind: 'direct-editor-after', scope: 'core', gitDir: '.matos/asset-history.git', commit: 'a'.repeat(40),
          createdAt: '2026-09-14T00:00:00Z', cwd, assetRefs: [`role:${id}@0.9.0`], files: [],
          provenance: { sourceCommit: 'b'.repeat(40), runId: 'private-evolution-run', experienceRefs: ['experience:private'], trajectory: 'Private user feedback' } })
      }
      const graph = await buildMatOSAssetGraphIndex({ cwd, assets: [asset('role', 'planner', 'core')], options: { profile: 'full', includeHidden: true } })
      expect(graph.nodes['snapshot:asset-snapshot-planner']?.metadata?.provenance).toEqual({ sourceCommit: 'b'.repeat(40) })
      expect(graph.nodes['snapshot:asset-snapshot-hidden-internal']).toBeUndefined()
      expect(JSON.stringify(graph)).not.toContain('private-evolution-run')
      expect(JSON.stringify(graph)).not.toContain('Private user feedback')
      expect(JSON.stringify(graph)).not.toContain('experience:private')
    } finally {
      if (previous === undefined) delete process.env.MATOS_SCOPE_REF
      else process.env.MATOS_SCOPE_REF = previous
      await rm(cwd, { recursive: true, force: true })
    }
  })
  test('scope filters lineage, releases and usage even when an asset key is shared by users', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-private-graph-'))
    const previous = process.env.MATOS_SCOPE_REF
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      for (const owner of ['alice', 'bob']) {
        await writeMatOSAssetHistorySnapshotRecord(cwd, { schemaVersion: 1, snapshotId: `asset-snapshot-${owner}`,
          kind: 'direct-editor-after', scope: 'user', scopeRef: `user:${owner}`, gitDir: '.matos/asset-history.git',
          commit: (owner === 'alice' ? 'a' : 'b').repeat(40), createdAt: '2026-09-14T00:00:00Z', cwd, assetRefs: ['role:planner@1.0.0'], files: [] })
        const run = join(cwd, '.matos/evolution/direct-editor/runs', owner)
        await mkdir(run, { recursive: true })
        await writeFile(join(run, 'run.json'), JSON.stringify({ runId: owner, scope: 'user', input: { scopeRef: `user:${owner}` }, updatedAssets: ['role:planner@1.0.0'] }))
        await mkdir(join(cwd, '.matos/sessions'), { recursive: true })
        await writeFile(join(cwd, '.matos/sessions', `${owner}.jsonl`), JSON.stringify({ id: owner, type: 'matos.asset.used', sessionId: owner, scopeRef: `user:${owner}`, data: { assetKey: 'role:planner@1.0.0' } }) + '\n')
      }
      const graph = await buildMatOSAssetGraphIndex({ cwd, assets: [asset('role', 'planner', 'core')], options: { profile: 'full', includeHidden: true } })
      expect(graph.nodes['direct-editor-run:alice']).toBeDefined()
      expect(graph.nodes['snapshot:asset-snapshot-alice']).toBeDefined()
      expect(graph.nodes['trace:alice']).toBeDefined()
      expect(JSON.stringify(graph)).not.toContain('bob')
    } finally {
      if (previous === undefined) delete process.env.MATOS_SCOPE_REF
      else process.env.MATOS_SCOPE_REF = previous
      await rm(cwd, { recursive: true, force: true })
    }
  })
  test('keeps observed old versions and commits as non-executable revision nodes after an upgrade', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-historical-graph-'))
    try {
      await mkdir(join(cwd, '.matos/sessions'), { recursive: true })
      await writeFile(join(cwd, '.matos/sessions/trace-old.jsonl'), JSON.stringify({ id: 'old-event', type: 'matos.asset.used', traceId: 'trace-old', sessionId: 'trace-old', timestamp: '2026-09-01T00:00:00Z', data: { assetKey: 'role:planner@1.0.0', sourceCommit: 'a'.repeat(40) } }) + '\n')
      const current = { ...asset('role', 'planner', 'core'), version: '2.0.0', canonicalKey: 'role:planner@2.0.0' }
      const graph = await buildMatOSAssetGraphIndex({ cwd, assets: [current], options: { profile: 'full' } })
      const archived = Object.values(graph.nodes).find(node => node.kind === 'asset-revision' && node.reference === 'role:planner@1.0.0')!
      expect(archived.metadata).toMatchObject({ executable: false, sourceCommit: 'a'.repeat(40) })
      expect(graph.edges).toContainEqual(expect.objectContaining({ from: archived.id, to: 'trace:trace-old', kind: 'used_in_session' }))
      expect(graph.stats.assetCount).toBe(1)
      expect(graph.typeGraphs.role?.nodes).toEqual([current.canonicalKey])
      const core = await buildMatOSAssetGraphIndex({ cwd, assets: [current], options: { profile: 'core' } })
      expect(Object.keys(core.nodes)).toEqual([current.canonicalKey])
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })
  test('uses only the approved overlay for names, edges, search and bare references', async () => {
    const core = asset('role', 'planner', 'core', ['tool:old'])
    const overlay = asset('role', 'planner', 'user', ['tool:new'], core.canonicalKey)
    const assets = [core, overlay, asset('tool', 'old', 'core'), asset('tool', 'new', 'core')]
    const registry = buildMatOSAssetRegistry(assets)
    const graph = await buildMatOSAssetGraphIndex({ cwd: '/fixture', assets, registry, options: { profile: 'core', includeHidden: true } })
    expect(registry.resolve('planner@1.0.0')).toBe(overlay)
    expect(graph.nodes[core.canonicalKey]?.name).toBe(overlay.name)
    expect(graph.edges.filter(edge => edge.from === core.canonicalKey).map(edge => edge.to)).toEqual(['tool:new@1.0.0'])
    expect(graph.search.documents[core.canonicalKey]?.title).toBe(overlay.name)
    expect(graph.stats.assetCount).toBe(3)
  })

  test('serializes the protected runtime winner instead of an unapproved shadow', async () => {
    const core = asset('role', 'planner', 'core')
    const unauthorized = asset('role', 'planner', 'user')
    const registry = buildMatOSAssetRegistry([core, unauthorized])
    const index = serializeMatOSAssetRegistry(registry) as { assets: Record<string, { name: string }> }
    expect(registry.resolve(core.canonicalKey)).toBe(core)
    expect(index.assets[core.canonicalKey]?.name).toBe(core.name)
    const graph = await buildMatOSAssetGraphIndex({ cwd: '/fixture', registry, assets: [core, unauthorized], options: { profile: 'core', includeHidden: true } })
    expect(graph.search.documents[core.canonicalKey]?.title).toBe(core.name)
  })

  test('reports unresolved dependencies and mounts without inventing executable nodes', async () => {
    const role = asset('role', 'planner', 'core', ['skill:absent@1.0.0'])
    role.mounts = { tools: ['Read', 'tool:required', 'tool:optional'], knowledge: ['knowledge:absent'] }
    role.metadata.optionalToolRefs = ['tool:optional']
    const graph = await buildMatOSAssetGraphIndex({ cwd: '/fixture', assets: [role], options: { profile: 'core', includeHidden: true } })
    expect(graph.edges).toEqual([])
    expect(Object.keys(graph.nodes)).toEqual([role.canonicalKey])
    expect(graph.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_dependency', assetKey: role.canonicalKey, severity: 'error' }),
      expect.objectContaining({ code: 'missing_mount', severity: 'error' }),
      expect.objectContaining({ code: 'optional_reference_unavailable', severity: 'info' }),
    ]))
    expect(graph.issues.some(issue => issue.message.includes('"Read"'))).toBe(false)
  })
})
