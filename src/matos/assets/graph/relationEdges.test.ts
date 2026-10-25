import { describe, expect, test } from 'bun:test'
import { buildMatOSAssetRegistry } from '../registry.js'
import type { MatOSAsset } from '../types.js'
import { buildManifestRelationEdges } from './relationEdges.js'

function asset(
  input: Partial<MatOSAsset> & Pick<MatOSAsset, 'canonicalKey' | 'id' | 'type'>,
): MatOSAsset {
  return {
    name: input.id,
    version: '0.1.0',
    relativePath: '',
    absolutePath: '',
    manifestPath: `/tmp/${input.type}/${input.id}/asset.json`,
    manifestDir: '',
    source: 'pack',
    sourcePath: '',
    packId: 'test',
    tags: [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {},
    ...input,
  } as MatOSAsset
}

describe('manifest relation edges', () => {
  test('materializes experience targetAssetRefs as evidence_for edges', () => {
    const experience = asset({
      canonicalKey: 'experience:vasp-encut-lesson@0.1.0',
      id: 'vasp-encut-lesson',
      type: 'experience',
      metadata: {
        targetAssetRefs: ['knowledge:vasp-runbook', 'skill:missing-one'],
      },
    })
    const knowledge = asset({
      canonicalKey: 'knowledge:vasp-runbook@0.1.0',
      id: 'vasp-runbook',
      type: 'knowledge',
    })
    const assets = [experience, knowledge]
    const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })

    const edges = buildManifestRelationEdges({
      cwd: '/tmp',
      registry,
      assets,
      options: {},
    })

    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'experience:vasp-encut-lesson@0.1.0',
        to: 'knowledge:vasp-runbook@0.1.0',
        kind: 'evidence_for',
        source: 'metadata',
        reference: 'knowledge:vasp-runbook',
      }),
    )
    // Unresolvable refs are skipped, not fabricated.
    expect(
      edges.filter(edge => edge.kind === 'evidence_for'),
    ).toHaveLength(1)
  })
})
