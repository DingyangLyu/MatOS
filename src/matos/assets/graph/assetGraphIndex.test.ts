/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../../project.js'
import { loadMatOSAssets } from '../loadAssets.js'
import { buildMatOSAssetRegistry } from '../registry.js'
import { buildMatOSAssetGraphIndex } from './buildGraphIndex.js'
import type { MatOSAssetGraphProvider } from './types.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createGraphFixture(): Promise<{
  root: string
  registry: ReturnType<typeof buildMatOSAssetRegistry>
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-asset-graph-'))
  const packRoot = join(root, '.matos', 'assets', 'packs', 'core')
  const roleDir = join(packRoot, 'roles', 'planner')
  const skillDir = join(packRoot, 'skills', 'planner')
  const toolDir = join(packRoot, 'tools', 'web-search')
  const dataDir = join(packRoot, 'data', 'matbench')
  const knowledgeDir = join(packRoot, 'knowledges', 'runbook')
  const runtimeDir = join(packRoot, 'runtimes', 'openvscode')
  const workflowDir = join(packRoot, 'workflows', 'research')
  const childWorkflowDir = join(packRoot, 'workflows', 'child')
  const benchmarkDir = join(packRoot, 'benchmarks', 'research-smoke')

  for (const dir of [
    roleDir,
    skillDir,
    toolDir,
    dataDir,
    knowledgeDir,
    runtimeDir,
    workflowDir,
    childWorkflowDir,
    benchmarkDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }

  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: 'core',
    name: 'Core',
    version: '0.1.0',
  })

  await writeJson(join(roleDir, 'asset.json'), {
    id: 'planner',
    type: 'role',
    name: 'Planner',
    version: '0.1.0',
    tags: ['materials', 'planning'],
    dependencies: ['skill:planner'],
    mounts: {
      data: ['data:matbench'],
      knowledge: ['knowledge:runbook'],
      skills: ['skill:planner'],
      tools: ['tool:web-search', 'Bash'],
    },
    runtime: {
      profile: 'runtime:openvscode',
    },
    metadata: {
      group: 'materials',
    },
  })
  await writeJson(join(skillDir, 'asset.json'), {
    id: 'planner',
    type: 'skill',
    name: 'Planner Skill',
    version: '0.1.0',
    tags: ['materials', 'planning'],
    metadata: {
      toolReferences: ['tool:web-search'],
      group: 'materials',
    },
  })
  await writeJson(join(toolDir, 'asset.json'), {
    id: 'web-search',
    type: 'tool',
    name: 'Web Search',
    version: '0.1.0',
    tags: ['research'],
    metadata: {
      backend: 'mcp',
      mcpServer: 'web',
      group: 'research',
    },
  })
  await writeJson(join(dataDir, 'asset.json'), {
    id: 'matbench',
    type: 'data',
    name: 'Matbench',
    version: '0.1.0',
    tags: ['materials'],
    metadata: {
      group: 'materials',
    },
  })
  await writeJson(join(knowledgeDir, 'asset.json'), {
    id: 'runbook',
    type: 'knowledge',
    name: 'Runbook',
    version: '0.1.0',
    tags: ['materials', 'planning'],
    metadata: {
      group: 'materials',
      topics: ['materials planning'],
    },
  })
  await writeJson(join(runtimeDir, 'asset.json'), {
    id: 'openvscode',
    type: 'runtime',
    name: 'OpenVSCode Runtime',
    version: '0.1.0',
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    id: 'research',
    type: 'workflow',
    name: 'Research Workflow',
    version: '0.1.0',
    entry: 'workflow.yaml',
  })
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: research',
      'policy:',
      '  reviewSkillRef: skill:planner',
      '  allowedAssetRefs: [knowledge:runbook]',
      'outputs:',
      '  curated:',
      '    dataRef: data:matbench',
      'nodes:',
      '  plan:',
      '    type: agent',
      '    role: role:planner',
      '    prompt: Plan the work',
      '  search:',
      '    type: backend',
      '    backend: web',
      '    tool: tool:web-search',
      '    dependsOn: [plan]',
      '  fanout:',
      '    type: map',
      '    workflow: workflow:child',
      '    items: [a]',
      '    itemParameter: item',
      '    dependsOn: [search]',
      '  assess:',
      '    type: guard',
      '    dependsOn: [fanout]',
      '    checks:',
      '      - type: expression',
      '        value: true',
      '    benchmarkRef: benchmark:research-smoke',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(childWorkflowDir, 'asset.json'), {
    id: 'child',
    type: 'workflow',
    name: 'Child Workflow',
    version: '0.1.0',
    entry: 'workflow.yaml',
  })
  await writeFile(
    join(childWorkflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: child',
      'nodes:',
      '  echo:',
      '    type: exec',
      '    command: "printf ok"',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(benchmarkDir, 'asset.json'), {
    id: 'research-smoke',
    type: 'benchmark',
    name: 'Research Smoke',
    version: '0.1.0',
  })

  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
  return { root, registry }
}

describe('MatOS asset graph index', () => {
  test('builds typed relation edges and reverse lookup from registry references', async () => {
    const { root, registry } = await createGraphFixture()

    const index = await buildMatOSAssetGraphIndex({ cwd: root, registry })

    expect(Object.keys(index.nodes).sort()).toContain(
      'role:planner@0.1.0',
    )
    expect(Object.keys(index.nodes).sort()).toContain(
      'skill:planner@0.1.0',
    )
    expect(Object.keys(index.nodes).sort()).toContain(
      'knowledge:runbook@0.1.0',
    )
    expect(Object.keys(index.nodes).sort()).toContain(
      'data:matbench@0.1.0',
    )
    expect(Object.keys(index.nodes).sort()).toContain(
      'tool:web-search@0.1.0',
    )
    expect(Object.keys(index.nodes).sort()).toContain(
      'runtime:openvscode@0.1.0',
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'skill:planner@0.1.0',
        kind: 'depends_on',
        source: 'manifest',
        reference: 'skill:planner',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'knowledge:runbook@0.1.0',
        kind: 'mounts_knowledge',
        source: 'manifest',
        reference: 'knowledge:runbook',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'data:matbench@0.1.0',
        kind: 'mounts_data',
        source: 'manifest',
        reference: 'data:matbench',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'skill:planner@0.1.0',
        to: 'tool:web-search@0.1.0',
        kind: 'uses_tool',
        source: 'metadata',
        reference: 'tool:web-search',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'runtime:openvscode@0.1.0',
        kind: 'uses_runtime',
        source: 'manifest',
        reference: 'runtime:openvscode',
      }),
    )
    expect(index.reverseEdges['skill:planner@0.1.0']).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        kind: 'depends_on',
      }),
    )
    expect(index.search.documents['role:planner@0.1.0']?.text).toBe('')
    expect(
      index.search.documents['role:planner@0.1.0']?.terms.planner,
    ).toBeGreaterThan(0)
  })

  test('skips quadratic same-value similarity buckets above the fanout limit', async () => {
    // Regression: the material-bench-data pack added 650+ bundled data assets
    // sharing the same tags, and pairwise same_tag edges exploded past a
    // million, stalling the direct-editor prompt builder and workbench
    // role/member surfaces for ~45s per call.
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-graph-fanout-'))
    const packRoot = join(root, '.matos', 'assets', 'packs', 'fanout')
    await mkdir(packRoot, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(packRoot, 'matos.pack.json'), {
      id: 'fanout',
      name: 'Fanout',
      version: '0.1.0',
    })
    const wideCount = 40
    for (let index = 0; index < wideCount; index += 1) {
      const dir = join(packRoot, 'data', `unit-${String(index).padStart(3, '0')}`)
      await mkdir(dir, { recursive: true })
      await writeJson(join(dir, 'asset.json'), {
        id: `unit-${String(index).padStart(3, '0')}`,
        type: 'data',
        name: `Unit ${index}`,
        version: '0.1.0',
        // 'wide-tag' fans out across all 40 assets (over the limit) and must
        // be skipped; 'narrow-tag' links only two assets and must survive.
        tags: index < 2 ? ['wide-tag', 'narrow-tag'] : ['wide-tag'],
      })
    }
    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)

    const started = Date.now()
    const index = await buildMatOSAssetGraphIndex({ cwd: root, registry })
    const elapsedMs = Date.now() - started

    const wideTagEdges = index.edges.filter(
      edge => edge.kind === 'same_tag' && edge.reference === 'tag:wide-tag',
    )
    const narrowTagEdges = index.edges.filter(
      edge => edge.kind === 'same_tag' && edge.reference === 'tag:narrow-tag',
    )
    expect(wideTagEdges).toEqual([])
    expect(narrowTagEdges).toHaveLength(1)
    expect(narrowTagEdges[0]).toMatchObject({
      from: 'data:unit-000@0.1.0',
      to: 'data:unit-001@0.1.0',
      kind: 'same_tag',
      source: 'metadata',
    })
    // Guardrail, generous even for loaded CI hosts: the unbounded quadratic
    // build took tens of seconds on the real bundled tree.
    expect(elapsedMs).toBeLessThan(10_000)
  })

  test('accepts custom providers without changing the graph builder', async () => {
    const { root, registry } = await createGraphFixture()
    const customProvider: MatOSAssetGraphProvider = {
      id: 'custom-test-provider',
      stage: 'similarity',
      build() {
        return {
          edges: [
            {
              from: 'knowledge:runbook@0.1.0',
              to: 'skill:planner@0.1.0',
              kind: 'similar_to',
              source: 'content',
              weight: 0.4,
              confidence: 0.8,
            },
          ],
        }
      },
    }

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [customProvider],
    })

    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'skill:planner@0.1.0',
        kind: 'similar_to',
        source: 'content',
      }),
    )
    expect(index.stats.providerCount).toBeGreaterThanOrEqual(1)
  })

  test('adds workflow node asset references through a dedicated provider', async () => {
    const { root, registry } = await createGraphFixture()

    const index = await buildMatOSAssetGraphIndex({ cwd: root, registry })

    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'role:planner@0.1.0',
        kind: 'depends_on',
        source: 'workflow',
        reference: 'nodes.plan.role',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'tool:web-search@0.1.0',
        kind: 'uses_tool',
        source: 'workflow',
        reference: 'nodes.search.tool',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'workflow:child@0.1.0',
        kind: 'subworkflow',
        source: 'workflow',
        reference: 'nodes.fanout.workflow',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'benchmark:research-smoke@0.1.0',
        kind: 'benchmarks',
        source: 'workflow',
        reference: 'nodes.assess.benchmarkRef',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'knowledge:runbook@0.1.0',
        kind: 'mounts_knowledge',
        source: 'workflow',
        reference: 'workflow.policy.allowedAssetRefs',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'data:matbench@0.1.0',
        kind: 'mounts_data',
        source: 'workflow',
        reference: 'workflow.outputs.curated.dataRef',
      }),
    )
    expect(index.typeGraphs.workflow.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'workflow:child@0.1.0',
        kind: 'subworkflow',
      }),
    )
  })

  test('filters graph profiles for agent core, discovery, evidence, and full views', async () => {
    const { root, registry } = await createGraphFixture()
    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session-profile.jsonl'),
      `${JSON.stringify({
        id: 'event-profile-asset',
        schemaVersion: 1,
        traceId: 'trace-profile',
        sessionId: 'session-profile',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          assetKey: 'knowledge:runbook@0.1.0',
        },
      })}\n`,
      'utf8',
    )
    const weakSimilarityProvider: MatOSAssetGraphProvider = {
      id: 'custom-weak-profile-edge',
      stage: 'similarity',
      build() {
        return {
          edges: [
            {
              from: 'role:planner@0.1.0',
              to: 'skill:planner@0.1.0',
              kind: 'same_tag',
              source: 'metadata',
              reference: 'tag:planning',
            },
          ],
        }
      },
    }

    const core = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [weakSimilarityProvider],
      options: { profile: 'core' },
    })
    const discovery = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [weakSimilarityProvider],
      options: { profile: 'discovery' },
    })
    const evidence = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [weakSimilarityProvider],
      options: { profile: 'evidence' },
    })
    const full = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [weakSimilarityProvider],
      options: { profile: 'full' },
    })

    expect(Object.values(core.nodes).every(node => node.kind === 'asset')).toBe(true)
    expect(core.edges.some(edge => edge.kind === 'same_tag')).toBe(false)
    expect(core.edges.some(edge => edge.kind === 'used_in_session')).toBe(false)
    expect(core.nodes['trace:trace-profile']).toBeUndefined()

    expect(Object.values(discovery.nodes).every(node => node.kind === 'asset')).toBe(true)
    expect(discovery.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'skill:planner@0.1.0',
        kind: 'same_tag',
      }),
    )
    expect(discovery.edges.some(edge => edge.kind === 'used_in_session')).toBe(false)

    expect(evidence.nodes['trace:trace-profile']).toBeDefined()
    expect(evidence.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'trace:trace-profile',
        kind: 'used_in_session',
      }),
    )
    expect(evidence.edges.some(edge => edge.kind === 'same_tag')).toBe(false)

    expect(full.nodes['trace:trace-profile']).toBeDefined()
    expect(full.edges.some(edge => edge.kind === 'used_in_session')).toBe(true)
    expect(full.edges.some(edge => edge.kind === 'same_tag')).toBe(true)
  })

  test('merges provider metadata without overwriting asset node identity', async () => {
    const { root, registry } = await createGraphFixture()
    const customProvider: MatOSAssetGraphProvider = {
      id: 'custom-node-metadata',
      stage: 'usage',
      build() {
        return {
          nodes: [
            {
              id: 'role:planner@0.1.0',
              kind: 'trace',
              label: 'Wrong Label',
              assetType: 'trace',
              metadata: { usage: { count: 2 } },
            },
          ],
        }
      },
    }

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [customProvider],
    })

    expect(index.nodes['role:planner@0.1.0']).toMatchObject({
      kind: 'asset',
      label: 'Planner',
      assetType: 'role',
      metadata: expect.objectContaining({ usage: { count: 2 } }),
    })
  })

  test('redacts provider issues before exposing graph diagnostics', async () => {
    const { root, registry } = await createGraphFixture()
    const customProvider: MatOSAssetGraphProvider = {
      id: 'custom-diagnostic',
      stage: 'similarity',
      build() {
        return {
          issues: [
            {
              code: 'custom_warning',
              assetKey: `${root}/asset-key`,
              message: `${root}/secret/path token=abc123 {"apiKey":"abc123"} Authorization: Bearer abc123 /vepfs-mlp2/private`,
              severity: 'warning',
            },
          ],
        }
      },
    }

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      providers: [customProvider],
    })

    expect(index.issues).toContainEqual(
      expect.objectContaining({
        code: 'custom_warning',
        providerId: 'custom-diagnostic',
        assetKey: '<workspace>/asset-key',
        message: '<workspace>/secret/path token=<redacted> {"apiKey=<redacted>} Authorization: Bearer <redacted> <redacted-path>',
      }),
    )
    expect(JSON.stringify(index.issues)).not.toContain(root)
    expect(JSON.stringify(index.issues)).not.toContain('abc123')
  })

  test('filters edges to hidden target assets before serialization', async () => {
    const { root, registry } = await createGraphFixture()
    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'

    const index = await buildMatOSAssetGraphIndex({ cwd: root, registry })

    expect(index.nodes['role:planner@0.1.0']).toBeUndefined()
    expect(index.edges.some(edge => edge.from.includes('planner'))).toBe(false)
    expect(index.edges.some(edge => edge.to.includes('planner'))).toBe(false)
    expect(index.root).toBe('<workspace>')
  })

  test('rejects custom providers that override built-in provider ids', async () => {
    const { root, registry } = await createGraphFixture()

    await expect(
      buildMatOSAssetGraphIndex({
        cwd: root,
        registry,
        providers: [
          {
            id: 'manifest-relation',
            stage: 'relation',
            build: () => ({}),
          },
        ],
      }),
    ).rejects.toThrow('Duplicate MatOS asset graph provider id')
  })

  test('indexes compact asset usage edges from MatOS session events', async () => {
    const { root, registry } = await createGraphFixture()
    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session-usage.jsonl'),
      `${JSON.stringify({
        id: 'event-asset-read',
        schemaVersion: 1,
        traceId: 'trace-usage',
        sessionId: 'session-usage',
        roleRef: 'role:planner',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          toolName: 'asset_read',
          assetKey: 'knowledge:runbook@0.1.0',
          reference: 'knowledge:runbook',
        },
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(sessionsDir, 'session-usage-repeat.jsonl'),
      [
        JSON.stringify({
          id: 'event-repeat-1',
          schemaVersion: 1,
          traceId: 'trace-repeat',
          sessionId: 'session-usage-repeat',
          timestamp: '2026-06-06T00:00:00.000Z',
          type: 'matos.asset.used',
          data: {
            assetKey: 'knowledge:runbook@0.1.0',
          },
        }),
        JSON.stringify({
          id: 'event-repeat-2',
          schemaVersion: 1,
          traceId: 'trace-repeat',
          sessionId: 'session-usage-repeat',
          timestamp: '2026-06-06T00:00:10.000Z',
          type: 'matos.asset.used',
          data: {
            assetKey: 'knowledge:runbook@0.1.0',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )
    await writeFile(join(sessionsDir, 'bad.jsonl'), '{"broken":\n', 'utf8')

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      options: { includeUsage: true },
    })

    expect(index.nodes['trace:trace-usage']).toMatchObject({
      kind: 'trace',
      reference: 'trace-usage',
      metadata: expect.objectContaining({
        roleRef: 'role:planner',
        usageCount: 1,
      }),
    })
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'trace:trace-usage',
        kind: 'used_in_session',
        source: 'trace',
        reference: 'session-usage',
        evidenceRefs: ['event-asset-read'],
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:runbook@0.1.0',
        to: 'trace:trace-repeat',
        kind: 'used_in_session',
        source: 'trace',
        reference: 'session-usage-repeat',
        evidenceRefs: ['event-repeat-1', 'event-repeat-2'],
        weight: 2,
      }),
    )
    expect(index.nodes['knowledge:runbook@0.1.0']?.metadata?.usage).toEqual({
      count: 3,
      traceCount: 2,
      sessionCount: 2,
      lastUsedAt: '2026-06-06T00:00:10.000Z',
    })
    expect(JSON.stringify(index.nodes['trace:trace-usage'])).not.toContain(root)
    expect(index.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_usage_session_record',
        message: expect.stringContaining('bad'),
      }),
    )
  })

  test('indexes workflow run usage edges without copying run paths', async () => {
    const { root, registry } = await createGraphFixture()
    const runDir = join(root, '.matos', 'workflows', 'runs', 'run-research')
    await mkdir(runDir, { recursive: true })
    await writeJson(join(runDir, 'run.json'), {
      runId: 'run-research',
      workflowRef: 'workflow:research@0.1.0',
      status: 'completed',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:01:00.000Z',
      parameters: {},
      outputs: {},
      graphSnapshotPath: 'graph.snapshot.json',
    })
    await writeJson(join(runDir, 'graph.snapshot.json'), {
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          roleRef: 'role:planner@0.1.0',
        },
      ],
    })
    await mkdir(join(runDir, 'child-runs'), { recursive: true })
    await writeJson(join(runDir, 'child-runs', 'child.json'), {
      childRunId: 'run-child',
    })
    const childRunDir = join(root, '.matos', 'workflows', 'runs', 'run-child')
    await mkdir(childRunDir, { recursive: true })
    await writeJson(join(childRunDir, 'run.json'), {
      runId: 'run-child',
      workflowRef: 'workflow:child@0.1.0',
      status: 'completed',
      createdAt: '2026-06-06T00:00:10.000Z',
      updatedAt: '2026-06-06T00:00:20.000Z',
      parameters: {},
      outputs: {},
    })
    await writeFile(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({
        id: 'workflow-event-tool',
        timestamp: '2026-06-06T00:00:30.000Z',
        type: 'workflow.node.completed',
        data: {
          toolRef: 'tool:web-search@0.1.0',
        },
      })}\n`,
      'utf8',
    )

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      options: { includeUsage: true },
    })

    expect(index.nodes['workflow-run:run-research']).toMatchObject({
      kind: 'workflow-run',
      reference: 'run-research',
      metadata: expect.objectContaining({
        workflowRef: 'workflow:research@0.1.0',
        usageCount: 4,
      }),
    })
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'workflow-run:run-research',
        kind: 'used_in_workflow_run',
        source: 'workflow',
        reference: 'run-research',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:web-search@0.1.0',
        to: 'workflow-run:run-research',
        kind: 'used_in_workflow_run',
        source: 'workflow',
        evidenceRefs: ['workflow-event-tool'],
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'workflow-run:run-research',
        kind: 'used_in_workflow_run',
        source: 'workflow',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:child@0.1.0',
        to: 'workflow-run:run-research',
        kind: 'used_in_workflow_run',
        source: 'workflow',
      }),
    )
    expect(index.nodes['workflow:research@0.1.0']?.metadata?.usage).toEqual(
      expect.objectContaining({
        count: 1,
        workflowRunCount: 1,
      }),
    )
    expect(index.nodes['workflow:child@0.1.0']?.metadata?.usage).toEqual(
      expect.objectContaining({
        count: 1,
        workflowRunCount: 1,
      }),
    )
    expect(JSON.stringify(index.nodes['workflow-run:run-research'])).not.toContain(
      root,
    )
  })

  test('indexes usage from configured runtime session and workflow run directories', async () => {
    const { root, registry } = await createGraphFixture()
    const sessionDir = join(root, 'runtime-state', 'sessions')
    const runsDir = join(root, 'runtime-state', 'workflow-runs')
    process.env.MATOS_SESSION_DIR = sessionDir
    process.env.MATOS_WORKFLOW_RUNS_DIR = runsDir
    await mkdir(sessionDir, { recursive: true })
    await mkdir(join(runsDir, 'run-env'), { recursive: true })
    await writeFile(
      join(sessionDir, 'session-env.jsonl'),
      `${JSON.stringify({
        id: 'event-env-asset',
        schemaVersion: 1,
        traceId: 'trace-env',
        sessionId: 'session-env',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          assetKey: 'tool:web-search@0.1.0',
        },
      })}\n`,
      'utf8',
    )
    await writeJson(join(runsDir, 'run-env', 'run.json'), {
      runId: 'run-env',
      workflowRef: 'workflow:research@0.1.0',
      status: 'completed',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:01:00.000Z',
      parameters: {},
      outputs: {},
    })

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      options: { includeUsage: true },
    })

    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:web-search@0.1.0',
        to: 'trace:trace-env',
        kind: 'used_in_session',
      }),
    )
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'workflow:research@0.1.0',
        to: 'workflow-run:run-env',
        kind: 'used_in_workflow_run',
      }),
    )
  })

  test('does not reintroduce hidden assets through usage events', async () => {
    const { root, registry } = await createGraphFixture()
    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'
    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session-hidden-usage.jsonl'),
      `${JSON.stringify({
        id: 'event-hidden-asset-read',
        schemaVersion: 1,
        traceId: 'trace-hidden-usage',
        sessionId: 'session-hidden-usage',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          assetKey: 'role:planner@0.1.0',
        },
      })}\n`,
      'utf8',
    )

    const index = await buildMatOSAssetGraphIndex({
      cwd: root,
      registry,
      options: { includeUsage: true },
    })

    expect(index.nodes['role:planner@0.1.0']).toBeUndefined()
    expect(index.nodes['trace:trace-hidden-usage']).toBeUndefined()
    expect(index.edges.some(edge => edge.source === 'trace')).toBe(false)
  })
})
