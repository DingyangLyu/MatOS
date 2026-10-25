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
import { writeMatOSAssetLifecycleState } from '../assets/lifecycle.js'
import { readMatOSSessionEvents } from '../sessions/sessionIndex.js'
import { createMatOSAssetDiscoveryTools } from './assetDiscoveryTools.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createDiscoveryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-asset-discovery-'))
  const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
  const knowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'matbench')
  const skillDir = join(root, '.matos', 'assets', 'skills', 'literature')
  const bandSkillDir = join(root, '.matos', 'assets', 'skills', 'electronic-structure', 'band-structure')
  const dosSkillDir = join(root, '.matos', 'assets', 'skills', 'electronic-structure', 'density-of-states')
  const phononSkillDir = join(root, '.matos', 'assets', 'skills', 'thermal-properties', 'phonon')
  const toolDir = join(root, '.matos', 'assets', 'tools', 'marker')
  const disabledKnowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'draft')
  await mkdir(roleDir, { recursive: true })
  await mkdir(knowledgeDir, { recursive: true })
  await mkdir(skillDir, { recursive: true })
  await mkdir(bandSkillDir, { recursive: true })
  await mkdir(dosSkillDir, { recursive: true })
  await mkdir(phononSkillDir, { recursive: true })
  await mkdir(toolDir, { recursive: true })
  await mkdir(disabledKnowledgeDir, { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })

  await writeJson(join(roleDir, 'asset.json'), {
    id: 'planner',
    type: 'role',
    name: 'Planner',
    version: '0.1.0',
    description: 'Plans materials work',
    entry: 'prompt.md',
    mounts: {
      knowledge: ['knowledge:matbench'],
      skills: ['skill:literature'],
      tools: ['Read'],
    },
  })
  await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')
  await writeJson(join(knowledgeDir, 'asset.json'), {
    id: 'matbench',
    type: 'knowledge',
    name: 'Matbench',
    version: '0.1.0',
    description: 'Curated benchmark data',
    entry: 'README.md',
    tags: ['benchmark', 'materials'],
    metadata: {
      summary: 'Benchmark datasets for materials ML.',
      apiKey: 'secret-value',
      hostPath: '/vepfs-mlp2/private/data',
    },
  })
  await writeFile(join(knowledgeDir, 'README.md'), 'Matbench details.\n')
  await writeJson(join(skillDir, 'asset.json'), {
    id: 'literature',
    type: 'skill',
    name: 'Literature Skill',
    version: '0.1.0',
    entry: 'SKILL.md',
  })
  await writeFile(join(skillDir, 'SKILL.md'), '# Literature Skill\n')
  await writeJson(join(bandSkillDir, 'asset.json'), {
    id: 'electronic-structure/band-structure',
    type: 'skill',
    name: 'Band Structure',
    version: '0.1.0',
    entry: 'SKILL.md',
    tags: ['electronic', 'bands'],
    metadata: {
      summary: 'Band structure calculation workflow.',
    },
  })
  await writeFile(join(bandSkillDir, 'SKILL.md'), '# Band Structure\n')
  await writeJson(join(dosSkillDir, 'asset.json'), {
    id: 'electronic-structure/density-of-states',
    type: 'skill',
    name: 'Density of States',
    version: '0.1.0',
    entry: 'SKILL.md',
    tags: ['electronic', 'dos'],
  })
  await writeFile(join(dosSkillDir, 'SKILL.md'), '# Density of States\n')
  await writeJson(join(phononSkillDir, 'asset.json'), {
    id: 'thermal-properties/phonon',
    type: 'skill',
    name: 'Phonon',
    version: '0.1.0',
    entry: 'SKILL.md',
    tags: ['thermal', 'phonon'],
  })
  await writeFile(join(phononSkillDir, 'SKILL.md'), '# Phonon\n')
  await writeJson(join(toolDir, 'asset.json'), {
    id: 'marker',
    type: 'tool',
    name: 'Marker Tool',
    version: '0.1.0',
    description: 'Tool with manifest-only metadata',
  })
  await writeJson(join(disabledKnowledgeDir, 'asset.json'), {
    id: 'draft',
    type: 'knowledge',
    name: 'Draft Notes',
    version: '0.1.0',
    entry: 'README.md',
  })
  await writeFile(join(disabledKnowledgeDir, 'README.md'), 'Draft details.\n')
  await writeMatOSAssetLifecycleState(root, {
    version: 1,
    assets: {
      'knowledge:draft@0.1.0': {
        status: 'disabled',
        reason: 'not reviewed',
      },
    },
  })

  return root
}

function toolByName(
  tools: ReturnType<typeof createMatOSAssetDiscoveryTools>,
  name: string,
) {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool) {
    throw new Error(`Missing discovery tool: ${name}`)
  }
  return tool
}

describe('MatOS agent-facing asset discovery tools', () => {
  test('merges the scope asset workspace into project discovery', async () => {
    const projectRoot = await createDiscoveryFixture()
    const scopeRoot = await mkdtemp(join(tmpdir(), 'matos-asset-discovery-scope-'))
    const sharedDir = join(scopeRoot, '.matos', 'assets', 'knowledge', 'recipient-copy')
    await mkdir(sharedDir, { recursive: true })
    await writeJson(join(scopeRoot, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(sharedDir, 'asset.json'), {
      id: 'recipient-copy',
      type: 'knowledge',
      name: 'Recipient copy',
      version: '1.0.0',
      entry: 'README.md',
    })
    await writeFile(join(sharedDir, 'README.md'), 'Shared recipient knowledge.\n')

    const tools = createMatOSAssetDiscoveryTools({
      cwd: projectRoot,
      assetCwd: scopeRoot,
    })
    const shown = JSON.parse(
      (
        await toolByName(tools, 'asset_show').call({
          ref: 'knowledge:recipient-copy@1.0.0',
        })
      ).text,
    ) as { asset: { canonicalKey: string } }
    expect(shown.asset.canonicalKey).toBe('knowledge:recipient-copy@1.0.0')
  })

  test('list, search, show, graph, and read active project assets at runtime', async () => {
    const root = await createDiscoveryFixture()
    const tools = createMatOSAssetDiscoveryTools({
      cwd: root,
      selectedRole: 'role:planner',
      selectedAssetKeys: ['role:planner@0.1.0', 'knowledge:matbench@0.1.0'],
    })

    expect(tools.map(tool => tool.name)).toEqual([
      'asset_context',
      'asset_graph',
      'asset_related',
      'asset_impact',
      'asset_lineage',
      'asset_list',
      'asset_read',
      'asset_search',
      'asset_show',
    ])

    const contextRaw = (await toolByName(tools, 'asset_context').call({})).text
    const context = JSON.parse(contextRaw) as {
      cwd: string
      selectedRole: string
      selectedAssetKeys: string[]
      discoveryTools: string[]
    }
    expect(context.cwd).toBe('<workspace>')
    expect(contextRaw).not.toContain(root)
    expect(context.selectedRole).toBe('role:planner')
    expect(context.selectedAssetKeys).toContain('knowledge:matbench@0.1.0')
    expect(context.discoveryTools).toContain('asset_search')

    const listRaw = (
      await toolByName(tools, 'asset_list').call({ type: 'knowledge' })
    ).text
    const list = JSON.parse(listRaw) as {
      cwd: string
      assets: Array<{ canonicalKey: string }>
    }
    expect(list.cwd).toBe('<workspace>')
    expect(listRaw).not.toContain(root)
    expect(list.assets.map(asset => asset.canonicalKey)).toEqual([
      'knowledge:matbench@0.1.0',
    ])

    const listWithDisabled = JSON.parse(
      (
        await toolByName(tools, 'asset_list').call({
          type: 'knowledge',
          includeDisabled: true,
        })
      ).text,
    ) as { assets: Array<{ canonicalKey: string; status: string }> }
    expect(listWithDisabled.assets.map(asset => asset.canonicalKey)).toEqual([
      'knowledge:draft@0.1.0',
      'knowledge:matbench@0.1.0',
    ])
    expect(listWithDisabled.assets[0]?.status).toBe('disabled')

    const searchRaw = (
      await toolByName(tools, 'asset_search').call({ query: 'benchmark' })
    ).text
    const search = JSON.parse(searchRaw) as {
      cwd: string
      assets: Array<{ canonicalKey: string }>
    }
    expect(search.cwd).toBe('<workspace>')
    expect(searchRaw).not.toContain(root)
    expect(search.assets.map(asset => asset.canonicalKey)).toEqual([
      'knowledge:matbench@0.1.0',
    ])

    const fullSearchRaw = (
      await toolByName(tools, 'asset_search').call({
        query: 'benchmark',
        detail: 'full',
      })
    ).text
    const fullSearch = JSON.parse(fullSearchRaw) as {
      fullDetailLimited: boolean
      fullDetailHint: string
      assets: Array<{
        canonicalKey: string
        metadata?: unknown
        fullDetailOmitted: boolean
        fullDetailHint: string
      }>
    }
    expect(fullSearch.fullDetailLimited).toBe(true)
    expect(fullSearch.fullDetailHint).toContain('asset_show')
    expect(fullSearch.assets).toHaveLength(1)
    expect(fullSearch.assets[0]?.canonicalKey).toBe('knowledge:matbench@0.1.0')
    expect(fullSearch.assets[0]?.fullDetailOmitted).toBe(true)
    expect(fullSearch.assets[0]?.fullDetailHint).toContain(
      'knowledge:matbench@0.1.0',
    )
    expect(fullSearch.assets[0]?.metadata).toBeUndefined()

    const graphRankSearch = JSON.parse(
      (
        await toolByName(tools, 'asset_search').call({
          query: 'benchmark',
          graphRank: true,
          seedRefs: ['role:planner'],
        })
      ).text,
    ) as {
      hits: Array<{ assetKey: string; explanations: Array<{ kind: string }> }>
      assets: Array<{ id: string; score: number; explanations: Array<{ kind: string }> }>
    }
    expect(graphRankSearch.hits[0]?.assetKey).toBe(
      'knowledge:matbench@0.1.0',
    )
    expect(
      graphRankSearch.hits[0]?.explanations.map(item => item.kind),
    ).toContain('lexical')
    expect(graphRankSearch.assets[0]).toMatchObject({
      id: 'matbench',
      canonicalKey: 'knowledge:matbench@0.1.0',
      score: expect.any(Number),
      explanations: expect.any(Array),
    })
    const pagedGraphRankSearch = JSON.parse(
      (
        await toolByName(tools, 'asset_search').call({
          query: 'skill',
          type: 'skill',
          graphRank: true,
          limit: 1,
          offset: 1,
        })
      ).text,
    ) as { total: number; count: number; offset: number; hits: unknown[] }
    expect(pagedGraphRankSearch.total).toBeGreaterThan(1)
    expect(pagedGraphRankSearch.offset).toBe(1)
    expect(pagedGraphRankSearch.count).toBe(1)
    expect(pagedGraphRankSearch.hits).toHaveLength(1)
    const filteredGraphRankSearch = JSON.parse(
      (
        await toolByName(tools, 'asset_search').call({
          query: 'skill',
          graphRank: true,
          prefix: 'electronic-structure/',
          includeGroups: true,
          groupBy: 'type',
        })
      ).text,
    ) as {
      hits: Array<{ assetKey: string }>
      groups: Array<{ group: string; count: number }>
    }
    expect(filteredGraphRankSearch.hits.every(hit =>
      hit.assetKey.startsWith('skill:electronic-structure/'),
    )).toBe(true)
    expect(filteredGraphRankSearch.groups).toContainEqual({
      group: 'skill',
      count: filteredGraphRankSearch.hits.length,
    })

    const related = JSON.parse(
      (await toolByName(tools, 'asset_related').call({ ref: 'role:planner' }))
        .text,
    ) as { root: string; hits: Array<{ assetKey: string }> }
    expect(related.root).toBe('role:planner@0.1.0')
    expect(related.hits.map(hit => hit.assetKey)).toContain(
      'knowledge:matbench@0.1.0',
    )

    const impact = JSON.parse(
      (await toolByName(tools, 'asset_impact').call({ ref: 'knowledge:matbench' }))
        .text,
    ) as { affectedAssetKeys: string[] }
    expect(impact.affectedAssetKeys).toContain('role:planner@0.1.0')

    const show = JSON.parse(
      (await toolByName(tools, 'asset_show').call({ ref: 'role:planner' })).text,
    ) as { asset: { canonicalKey: string; mounts: { knowledge: string[] } } }
    expect(show.asset.canonicalKey).toBe('role:planner@0.1.0')
    expect(show.asset.mounts.knowledge).toEqual(['knowledge:matbench'])

    const fullKnowledgeShowRaw = (
      await toolByName(tools, 'asset_show').call({ ref: 'knowledge:matbench' })
    ).text
    const fullKnowledgeShow = JSON.parse(fullKnowledgeShowRaw) as {
      asset: { metadata: Record<string, unknown> }
    }
    expect(fullKnowledgeShow.asset.metadata.apiKey).toBe('<redacted>')
    expect(fullKnowledgeShow.asset.metadata.hostPath).toBe('<redacted-path>')
    expect(fullKnowledgeShowRaw).not.toContain('secret-value')
    expect(fullKnowledgeShowRaw).not.toContain('/vepfs-mlp2')

    const graph = JSON.parse(
      (await toolByName(tools, 'asset_graph').call({})).text,
    ) as { root: string; assets: Array<Record<string, unknown>> }
    expect(graph.root).toBe('role:planner@0.1.0')
    expect(graph.assets.map(asset => asset.canonicalKey)).toEqual([
      'role:planner@0.1.0',
      'knowledge:matbench@0.1.0',
      'skill:literature@0.1.0',
    ])
    expect(graph.assets[0]).not.toHaveProperty('absolutePath')

    const invalidGraphMode = await toolByName(tools, 'asset_graph').call({
      ref: 'role:planner',
      mode: 'dependecies',
    })
    expect(invalidGraphMode.isError).toBe(true)
    expect(invalidGraphMode.text).toContain('mode must be')

    const coreNeighborhood = JSON.parse(
      (
        await toolByName(tools, 'asset_graph').call({
          ref: 'skill:electronic-structure/band-structure',
          mode: 'all',
        })
      ).text,
    ) as { edges: Array<{ kind: string }> }
    expect(coreNeighborhood.edges.some(edge => edge.kind === 'same_tag')).toBe(false)

    const discoveryNeighborhood = JSON.parse(
      (
        await toolByName(tools, 'asset_graph').call({
          ref: 'skill:electronic-structure/band-structure',
          mode: 'all',
          profile: 'discovery',
        })
      ).text,
    ) as { edges: Array<{ kind: string; to: string }> }
    expect(discoveryNeighborhood.edges).toContainEqual(
      expect.objectContaining({
        kind: 'same_tag',
        to: 'skill:electronic-structure/density-of-states@0.1.0',
      }),
    )

    const lineageGraph = JSON.parse(
      (
        await toolByName(tools, 'asset_graph').call({
          ref: 'role:planner',
          mode: 'lineage',
        })
      ).text,
    ) as { assetKey: string; events: unknown[] }
    expect(lineageGraph.assetKey).toBe('role:planner@0.1.0')
    expect(lineageGraph.events).toEqual([])

    await mkdir(join(root, '.matos', 'sessions'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'sessions', 'session-graph-usage.jsonl'),
      `${JSON.stringify({
        id: 'event-graph-usage',
        schemaVersion: 1,
        traceId: 'trace-graph-usage',
        sessionId: 'session-graph-usage',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          assetKey: 'role:planner@0.1.0',
        },
      })}\n`,
      'utf8',
    )
    const usageGraph = JSON.parse(
      (
        await toolByName(tools, 'asset_graph').call({
          ref: 'role:planner',
          mode: 'usage',
        })
      ).text,
    ) as { nodes: string[]; edges: Array<{ kind: string; to: string }> }
    expect(usageGraph.nodes).toContain('trace:trace-graph-usage')
    expect(usageGraph.nodes).not.toContain('knowledge:matbench@0.1.0')
    expect(usageGraph.edges.every(edge =>
      edge.kind === 'used_in_session' || edge.kind === 'used_in_workflow_run',
    )).toBe(true)
    expect(usageGraph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used_in_session',
        to: 'trace:trace-graph-usage',
      }),
    )

    const read = JSON.parse(
      (await toolByName(tools, 'asset_read').call({ ref: 'knowledge:matbench' }))
        .text,
    ) as { asset: { canonicalKey: string }; content: string; truncated: boolean }
    expect(read.asset.canonicalKey).toBe('knowledge:matbench@0.1.0')
    expect(read.content).toContain('Matbench details.')
    expect(read.truncated).toBe(false)
    expect(read).toMatchObject({
      offset: 0,
      hasMore: false,
      totalBytes: Buffer.byteLength('Matbench details.\n', 'utf8'),
    })

    await writeFile(
      join(root, '.matos', 'assets', 'knowledges', 'matbench', 'README.md'),
      '甲乙丙丁',
      'utf8',
    )
    const firstUtf8Page = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          ref: 'knowledge:matbench',
          maxBytes: 7,
        })
      ).text,
    ) as {
      content: string
      nextOffset: number
      hasMore: boolean
      totalBytes: number
    }
    expect(firstUtf8Page.content).toBe('甲乙')
    expect(Buffer.byteLength(firstUtf8Page.content, 'utf8')).toBeLessThanOrEqual(7)
    expect(firstUtf8Page.nextOffset).toBe(6)
    expect(firstUtf8Page.hasMore).toBe(true)
    expect(firstUtf8Page.totalBytes).toBe(12)

    const secondUtf8Page = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          ref: 'knowledge:matbench',
          offset: firstUtf8Page.nextOffset,
          maxBytes: 7,
        })
      ).text,
    ) as { content: string; offset: number; hasMore: boolean }
    expect(secondUtf8Page).toMatchObject({
      content: '丙丁',
      offset: 6,
      hasMore: false,
    })

    const readById = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          id: 'electronic-structure/band-structure',
        })
      ).text,
    ) as { asset: { canonicalKey: string }; content: string }
    expect(readById.asset.canonicalKey).toBe(
      'skill:electronic-structure/band-structure@0.1.0',
    )
    expect(readById.content).toContain('Band Structure')

    const showById = JSON.parse(
      (
        await toolByName(tools, 'asset_show').call({
          id: 'electronic-structure/band-structure',
        })
      ).text,
    ) as { asset: { canonicalKey: string } }
    expect(showById.asset.canonicalKey).toBe(
      'skill:electronic-structure/band-structure@0.1.0',
    )

    const manifestRead = JSON.parse(
      (await toolByName(tools, 'asset_read').call({ ref: 'tool:marker' })).text,
    ) as { asset: { canonicalKey: string }; content: string }
    expect(manifestRead.asset.canonicalKey).toBe('tool:marker@0.1.0')
    expect(manifestRead.content).toContain('"id": "marker"')

    const jsonPathRead = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          ref: 'tool:marker',
          jsonPath: '$.id',
          fields: 'id,type,name',
        })
      ).text,
    ) as {
      asset: Record<string, unknown>
      jsonPath: string
      selected: string
      content: string
    }
    expect(jsonPathRead.asset).toEqual({
      id: 'marker',
      type: 'tool',
      name: 'Marker Tool',
    })
    expect(jsonPathRead.jsonPath).toBe('$.id')
    expect(jsonPathRead.selected).toBe('marker')
    expect(jsonPathRead.content).toBe('"marker"')

    const truncatedJsonPathRead = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          ref: 'tool:marker',
          jsonPath: '$',
          maxBytes: 8,
        })
      ).text,
    ) as {
      selected?: unknown
      selectedTruncated?: boolean
      content: string
      truncated: boolean
    }
    expect(truncatedJsonPathRead.truncated).toBe(true)
    expect(truncatedJsonPathRead.selected).toBeUndefined()
    expect(truncatedJsonPathRead.selectedTruncated).toBe(true)
    expect(truncatedJsonPathRead.content.length).toBeLessThanOrEqual(8)
  })

  test('lists assets with compact defaults, field selection, pagination, and groups', async () => {
    const root = await createDiscoveryFixture()
    const tools = createMatOSAssetDiscoveryTools({ cwd: root })

    const compact = JSON.parse(
      (
        await toolByName(tools, 'asset_list').call({
          type: 'skill',
          limit: 2,
          includeGroups: true,
          groupLimit: 2,
        })
      ).text,
    ) as {
      total: number
      count: number
      offset: number
      limit: number
      hasMore: boolean
      groups: Array<{ group: string; count: number }>
      groupCount: number
      groupOffset: number
      groupLimit: number
      groupsHasMore: boolean
      assets: Array<Record<string, unknown>>
    }

    expect(compact.total).toBe(4)
    expect(compact.count).toBe(2)
    expect(compact.offset).toBe(0)
    expect(compact.limit).toBe(2)
    expect(compact.hasMore).toBe(true)
    expect(compact.groups).toEqual([
      { group: 'electronic-structure', count: 2 },
      { group: 'literature', count: 1 },
    ])
    expect(compact).toMatchObject({
      groupCount: 3,
      groupOffset: 0,
      groupLimit: 2,
      groupsHasMore: true,
    })
    const groupPage = JSON.parse(
      (
        await toolByName(tools, 'asset_list').call({
          type: 'skill',
          includeGroups: true,
          groupOffset: 2,
          groupLimit: 2,
        })
      ).text,
    ) as { groups: Array<{ group: string; count: number }>; groupsHasMore: boolean }
    expect(groupPage.groups).toEqual([
      { group: 'thermal-properties', count: 1 },
    ])
    expect(groupPage.groupsHasMore).toBe(false)
    expect(compact.assets[0]).toMatchObject({
      id: 'electronic-structure/band-structure',
      type: 'skill',
      group: 'electronic-structure',
      canonicalKey: 'skill:electronic-structure/band-structure@0.1.0',
    })
    expect(compact.assets[0]).not.toHaveProperty('absolutePath')
    expect(compact.assets[0]).not.toHaveProperty('manifestPath')
    expect(compact.assets[0]).not.toHaveProperty('metadata')

    const page = JSON.parse(
      (
        await toolByName(tools, 'asset_list').call({
          type: 'skill',
          offset: 2,
          limit: 1,
          fields: ['id', 'name'],
        })
      ).text,
    ) as { assets: Array<Record<string, unknown>>; offset: number; hasMore: boolean }
    expect(page.offset).toBe(2)
    expect(page.hasMore).toBe(true)
    expect(page.assets).toEqual([{ id: 'literature', name: 'Literature Skill' }])

    const group = JSON.parse(
      (
        await toolByName(tools, 'asset_list').call({
          type: 'skill',
          group: 'electronic-structure',
        })
      ).text,
    ) as { total: number; assets: Array<{ id: string; group: string }> }
    expect(group.total).toBe(2)
    expect(group.assets.map(asset => asset.id)).toEqual([
      'electronic-structure/band-structure',
      'electronic-structure/density-of-states',
    ])
  })

  test('reports missing or disabled assets without exposing them as active by default', async () => {
    const root = await createDiscoveryFixture()
    const tools = createMatOSAssetDiscoveryTools({ cwd: root })

    const disabledRead = await toolByName(tools, 'asset_read').call({
      ref: 'knowledge:draft',
    })
    expect(disabledRead.isError).toBe(true)
    expect(disabledRead.text).toContain('not found or disabled')

    const missingShow = await toolByName(tools, 'asset_show').call({
      ref: 'knowledge:missing',
    })
    expect(missingShow.isError).toBe(true)
    expect(missingShow.text).toContain('MatOS asset not found')
  })

  test('shows and reads generated draft experience assets by default', async () => {
    const root = await createDiscoveryFixture()
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'bash-enospc-cascade-recovery',
    )
    await mkdir(experienceDir, { recursive: true })
    await writeJson(join(experienceDir, 'asset.json'), {
      id: 'bash-enospc-cascade-recovery',
      type: 'experience',
      name: 'Bash ENOSPC Cascade Detection and Recovery',
      version: '0.1.0',
      description: 'Stop retrying Bash after repeated ENOSPC failures.',
      entry: 'EXPERIENCE.md',
      tags: ['generated', 'learning', 'draft', 'experience'],
      lifecycle: { status: 'draft' },
      metadata: {
        sourceFormat: 'matos-experience-llm-v1',
        mergeKey: 'compute:bash-execution:enospc-cascade',
      },
    })
    await writeFile(
      join(experienceDir, 'EXPERIENCE.md'),
      '# Bash ENOSPC\n\nStop retrying Bash after repeated ENOSPC failures.\n',
      'utf8',
    )
    const tools = createMatOSAssetDiscoveryTools({ cwd: root })

    const shown = JSON.parse(
      (
        await toolByName(tools, 'asset_show').call({
          ref: 'experience:bash-enospc-cascade-recovery@0.1.0',
        })
      ).text,
    ) as { asset: { canonicalKey: string; status?: string; lifecycle?: unknown } }
    expect(shown.asset.canonicalKey).toBe(
      'experience:bash-enospc-cascade-recovery@0.1.0',
    )

    const read = JSON.parse(
      (
        await toolByName(tools, 'asset_read').call({
          ref: 'experience:bash-enospc-cascade-recovery@0.1.0',
        })
      ).text,
    ) as { content: string }
    expect(read.content).toContain('Stop retrying Bash')
  })

  test('records runtime asset discovery and read usage into the active trace', async () => {
    const root = await createDiscoveryFixture()
    process.env.MATOS_SESSION_DIR = join(root, '.matos', 'sessions')
    process.env.MATOS_TRACE_ID = 'trace-assets-1'
    process.env.MATOS_SESSION_ID = 'session-assets-1'
    process.env.MATOS_ROLE_REF = 'role:planner'

    const tools = createMatOSAssetDiscoveryTools({
      cwd: root,
      selectedRole: 'role:planner',
      selectedAssetKeys: ['role:planner@0.1.0', 'knowledge:matbench@0.1.0'],
    })

    await toolByName(tools, 'asset_list').call({ type: 'knowledge' })
    await toolByName(tools, 'asset_read').call({ ref: 'knowledge:matbench' })

    const events = await readMatOSSessionEvents(root, 'session-assets-1')
    expect(events.map(event => event.type)).toEqual([
      'matos.asset.used',
      'matos.asset.used',
    ])
    expect(events[0]?.data).toMatchObject({
      toolName: 'asset_list',
      query: { type: 'knowledge' },
      resultCount: 1,
      total: 1,
    })
    expect(events[1]?.data).toMatchObject({
      toolName: 'asset_read',
      assetKey: 'knowledge:matbench@0.1.0',
      reference: 'knowledge:matbench',
      contentBytes: 18,
      truncated: false,
    })
  })
})
