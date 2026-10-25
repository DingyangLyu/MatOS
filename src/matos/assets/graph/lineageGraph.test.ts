import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  writeMatOSAssetHistoryReleaseRecord,
  writeMatOSAssetHistorySnapshotRecord,
} from '../history/records.js'
import { loadMatOSAssets } from '../loadAssets.js'
import { buildMatOSAssetRegistry } from '../registry.js'
import { buildMatOSAssetGraphIndex } from './buildGraphIndex.js'
import { getMatOSAssetLineageTree } from './queries.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS asset lineage graph', () => {
  test('indexes snapshots, releases, and direct-editor runs as asset lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-lineage-'))
    const assetDir = join(root, '.matos', 'assets', 'knowledges', 'runbook')
    const otherAssetDir = join(root, '.matos', 'assets', 'knowledges', 'other')
    await mkdir(assetDir, { recursive: true })
    await mkdir(otherAssetDir, { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(assetDir, 'asset.json'), {
      id: 'runbook',
      type: 'knowledge',
      name: 'Runbook',
      version: '0.1.0',
      description: 'Operational runbook.',
    })
    await writeJson(join(otherAssetDir, 'asset.json'), {
      id: 'other',
      type: 'knowledge',
      name: 'Other',
      version: '0.1.0',
      description: 'Unrelated asset in the same snapshot.',
    })

    await writeMatOSAssetHistorySnapshotRecord(root, {
      schemaVersion: 1,
      snapshotId: 'asset-snapshot-before',
      kind: 'direct-editor-before',
      scope: 'project',
      gitDir: '.matos/asset-history/git',
      commit: 'a'.repeat(40),
      createdAt: '2026-06-06T00:00:00.000Z',
      cwd: root,
      assetRefs: ['knowledge:runbook@0.1.0', 'knowledge:other@0.1.0'],
      files: [],
      provenance: {
        runId: 'direct-editor-1',
        hostPath: '/vepfs-mlp2/example-project/example-user/private/file',
        message:
          'failed at /vepfs-mlp2/example-project/example-user/private/file with token=abc123',
        apiKey: 'should-not-leak',
      },
    })
    await writeMatOSAssetHistorySnapshotRecord(root, {
      schemaVersion: 1,
      snapshotId: 'asset-snapshot-after',
      kind: 'direct-editor-after',
      scope: 'project',
      gitDir: '.matos/asset-history/git',
      commit: 'b'.repeat(40),
      parentCommit: 'a'.repeat(40),
      createdAt: '2026-06-06T00:01:00.000Z',
      cwd: root,
      assetRefs: ['knowledge:runbook@0.1.0', 'knowledge:other@0.1.0'],
      files: [],
      provenance: {
        runId: 'direct-editor-1',
        experienceRefs: ['experience:runbook-fix@0.1.0'],
      },
    })
    await writeMatOSAssetHistorySnapshotRecord(root, {
      schemaVersion: 1,
      snapshotId: 'asset-snapshot-rollback',
      kind: 'direct-editor-rollback',
      scope: 'project',
      gitDir: '.matos/asset-history/git',
      commit: 'c'.repeat(40),
      parentCommit: 'b'.repeat(40),
      createdAt: '2026-06-06T00:01:45.000Z',
      cwd: root,
      assetRefs: ['knowledge:runbook@0.1.0'],
      files: [],
      provenance: {
        runId: 'direct-editor-1',
        validation: { ok: false },
      },
    })
    await writeMatOSAssetHistoryReleaseRecord(root, {
      schemaVersion: 1,
      releaseId: 'asset-release-project-stable',
      name: 'Project stable',
      createdAt: '2026-06-06T00:02:00.000Z',
      sourceRef: 'asset-snapshot-after',
      commit: 'b'.repeat(40),
      previousStableCommit: 'a'.repeat(40),
    })
    const runDir = join(
      root,
      '.matos',
      'evolution',
      'direct-editor',
      'runs',
      'direct-editor-1',
    )
    await mkdir(runDir, { recursive: true })
    await writeJson(join(runDir, 'run.json'), {
      runId: 'direct-editor-1',
      status: 'accepted',
      createdAt: '2026-06-06T00:01:30.000Z',
      updatedAt: '2026-06-06T00:01:30.000Z',
      scope: 'project',
      updatedAssets: ['knowledge:runbook@0.1.0'],
      createdAssets: [],
      disabledAssets: [],
      evidenceRefs: ['experience:runbook-fix@0.1.0'],
      beforeSnapshot: 'asset-snapshot-before',
      afterSnapshot: 'asset-snapshot-after',
      rollbackSnapshot: 'asset-snapshot-rollback',
    })
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'runbook-fix',
    )
    await mkdir(experienceDir, { recursive: true })
    await writeJson(join(experienceDir, 'asset.json'), {
      id: 'runbook-fix',
      type: 'experience',
      name: 'Runbook Fix Experience',
      version: '0.1.0',
      description: 'A generated lesson from the runbook fix.',
      entry: 'EXPERIENCE.md',
      tags: ['generated', 'learning', 'draft', 'experience'],
      metadata: {
        mergeKey: 'runbook-fix',
        evidenceCount: 1,
        roles: ['role:compute'],
        signalKinds: ['correction'],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'User corrected the runbook.',
          signals: [
            {
              id: 'sig-1',
              kind: 'correction',
              severity: 'high',
              explicitness: 'explicit',
              claim: 'Record the runbook failure.',
              target: {
                assetTypes: ['knowledge'],
                roleRefs: [],
                toolNames: [],
                workflowRefs: [],
              },
              evidenceExcerpt: 'record this',
              sourceEventRefs: ['event:1'],
              confidence: 0.9,
            },
          ],
          decisions: [],
        },
      },
    })
    await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# Experience\n', 'utf8')
    const monitorDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'sessions',
      'session-1',
    )
    await mkdir(monitorDir, { recursive: true })
    await writeFile(
      join(monitorDir, 'records.jsonl'),
      `${JSON.stringify({
        recordId: 'monitor-1',
        sessionId: 'session-1',
        triggerKind: 'user-feedback',
        triggerKey: 'feedback:1',
        status: 'direct-edit-complete',
        createdAt: '2026-06-06T00:01:40.000Z',
        updatedAt: '2026-06-06T00:01:40.000Z',
        summary:
          'Direct editor used /vepfs-mlp2/example-project/private/file and sk-1234567890abcdef.',
        error: 'authorization Bearer abcdefghijklmnop failed',
        experienceRefs: ['experience:runbook-fix@0.1.0'],
        directEditorRunId: 'direct-editor-1',
      })}\n`,
      'utf8',
    )

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      assets,
      registry,
      options: { includeLineage: true },
    })

    expect(index.nodes['snapshot:asset-snapshot-before']).toBeDefined()
    expect(index.nodes['snapshot:asset-snapshot-before']?.metadata?.provenance).toEqual(
      expect.objectContaining({
        runId: 'direct-editor-1',
        hostPath: '<redacted-path>',
        message: 'failed at <redacted-path> with token=<redacted>',
        apiKey: '<redacted>',
      }),
    )
    expect(index.nodes['snapshot:asset-snapshot-after']).toBeDefined()
    expect(index.nodes['release:asset-release-project-stable']).toBeDefined()
    expect(index.nodes['direct-editor-run:direct-editor-1']).toBeDefined()
    expect(index.nodes['experience-event:experience:runbook-fix@0.1.0']).toEqual(
      expect.objectContaining({
        kind: 'experience',
        reference: 'experience:runbook-fix@0.1.0',
      }),
    )
    expect(index.nodes['self-evolution-monitor:monitor-1']).toEqual(
      expect.objectContaining({
        kind: 'event',
        reference: 'monitor-1',
      }),
    )
    expect(
      JSON.stringify(index.nodes['self-evolution-monitor:monitor-1']?.metadata),
    ).not.toContain('/vepfs-mlp2')
    expect(
      JSON.stringify(index.nodes['self-evolution-monitor:monitor-1']?.metadata),
    ).not.toContain('sk-1234567890abcdef')
    expect(
      JSON.stringify(index.nodes['self-evolution-monitor:monitor-1']?.metadata),
    ).not.toContain('Bearer abcdefghijklmnop')
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'snapshot:asset-snapshot-before',
        kind: 'snapshot_before',
        source: 'history',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'direct-editor-run:direct-editor-1',
        kind: 'updated_by',
        source: 'evolution',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'experience-event:experience:runbook-fix@0.1.0',
        to: 'direct-editor-run:direct-editor-1',
        kind: 'evidence_for',
        source: 'evolution',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'experience-event:experience:runbook-fix@0.1.0',
        to: 'self-evolution-monitor:monitor-1',
        kind: 'created_by',
        source: 'evolution',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'self-evolution-monitor:monitor-1',
        to: 'direct-editor-run:direct-editor-1',
        kind: 'evidence_for',
        source: 'evolution',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'release:asset-release-project-stable',
        kind: 'released_as',
        source: 'history',
      }),
    )

    const lineage = getMatOSAssetLineageTree(index, 'knowledge:runbook')
    expect(lineage.assetKey).toBe('knowledge:runbook@0.1.0')
    expect(lineage.events.map(event => event.nodeId)).toContain(
      'direct-editor-run:direct-editor-1',
    )
    expect(lineage.events.map(event => event.nodeId)).toContain(
      'experience-event:experience:runbook-fix@0.1.0',
    )
    expect(lineage.events.map(event => event.nodeId)).toContain(
      'self-evolution-monitor:monitor-1',
    )
    expect(lineage.edges).toContainEqual(
      expect.objectContaining({
        from: 'direct-editor-run:direct-editor-1',
        to: 'snapshot:asset-snapshot-after',
        kind: 'snapshot_after',
      }),
    )
    expect(lineage.rollbackTargets).toContainEqual({
      snapshotId: 'asset-snapshot-rollback',
      commit: 'c'.repeat(40),
      createdAt: '2026-06-06T00:01:45.000Z',
      validationOk: false,
    })
    expect(lineage.edges).toContainEqual(
      expect.objectContaining({
        from: 'snapshot:asset-snapshot-after',
        to: 'release:asset-release-project-stable',
        kind: 'released_as',
      }),
    )
    expect(lineage.events.map(event => event.nodeId)).not.toContain(
      'knowledge:other@0.1.0',
    )
    expect(lineage.edges).not.toContainEqual(
      expect.objectContaining({
        from: 'knowledge:other@0.1.0',
      }),
    )
    expect(lineage.stableRelease).toBe('release:asset-release-project-stable')
  })

  test('does not reintroduce hidden generated experience assets through lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-lineage-hidden-'))
    const assetDir = join(root, '.matos', 'assets', 'knowledges', 'runbook')
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'hidden-lesson',
    )
    await mkdir(assetDir, { recursive: true })
    await mkdir(experienceDir, { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(assetDir, 'asset.json'), {
      id: 'runbook',
      type: 'knowledge',
      name: 'Runbook',
      version: '0.1.0',
      description: 'Visible runbook.',
    })
    await writeJson(join(experienceDir, 'asset.json'), {
      id: 'hidden-lesson',
      type: 'experience',
      name: 'Hidden Lesson',
      version: '0.1.0',
      description: 'Hidden generated lesson.',
      entry: 'EXPERIENCE.md',
      tags: ['generated', 'learning', 'draft', 'experience'],
      metadata: {
        roles: [],
        tools: [],
        toolNames: [],
        signalKinds: ['correction'],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'Hidden target',
          signals: [
            {
              id: 'sig-1',
              kind: 'correction',
              severity: 'high',
              explicitness: 'explicit',
              claim: 'Hidden lesson targets visible runbook.',
              target: {
                assetTypes: ['knowledge'],
                assetRefs: ['knowledge:runbook@0.1.0'],
                roleRefs: [],
                toolNames: [],
                toolRefs: [],
                knowledgeRefs: ['knowledge:runbook@0.1.0'],
                workflowRefs: [],
              },
              evidenceExcerpt: 'hidden',
              sourceEventRefs: ['event:1'],
              confidence: 0.9,
            },
          ],
          decisions: [],
        },
      },
    })
    await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# Hidden\n', 'utf8')
    await writeMatOSAssetHistorySnapshotRecord(root, {
      schemaVersion: 1,
      snapshotId: 'asset-snapshot-visible',
      kind: 'manual',
      scope: 'project',
      gitDir: '.matos/asset-history/git',
      commit: 'd'.repeat(40),
      createdAt: '2026-06-06T00:00:00.000Z',
      cwd: root,
      assetRefs: ['knowledge:runbook@0.1.0'],
      files: [],
    })

    const previousHide = process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE
    const previousVisibleRoots = process.env.MATOS_USER_VISIBLE_ASSET_ROOTS
    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'
    process.env.MATOS_USER_VISIBLE_ASSET_ROOTS = assetDir
    try {
      const assets = await loadMatOSAssets(root)
      const registry = buildMatOSAssetRegistry(assets)
      const index = await buildMatOSAssetGraphIndex({
        cwd: root,
        assets,
        registry,
        options: { includeLineage: true },
      })

      expect(index.nodes['knowledge:runbook@0.1.0']).toBeDefined()
      expect(
        index.nodes['experience-event:experience:hidden-lesson@0.1.0'],
      ).toBeUndefined()
      expect(JSON.stringify(index)).not.toContain('hidden-lesson')
    } finally {
      if (previousHide === undefined) {
        delete process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE
      } else {
        process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = previousHide
      }
      if (previousVisibleRoots === undefined) {
        delete process.env.MATOS_USER_VISIBLE_ASSET_ROOTS
      } else {
        process.env.MATOS_USER_VISIBLE_ASSET_ROOTS = previousVisibleRoots
      }
    }
  })
})
