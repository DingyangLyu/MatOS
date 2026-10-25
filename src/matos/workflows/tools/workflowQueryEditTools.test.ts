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
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../../project.js'
import type { MatOSWorkflowDefinition } from '../types.js'
import { createMatOSWorkflowQueryEditTools } from './workflowQueryEditTools.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function definition(): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'inferred-draft',
    version: '0.1.0',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [
      {
        id: 'prepare',
        type: 'exec',
        dependsOn: [],
        command: 'printf ready',
      },
    ],
    outputs: {
      status: { value: 'ready' },
    },
  }
}

describe('workflow_edit facade', () => {
  test('infers the latest draft id for follow-up draft actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-edit-infer-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_edit',
    )
    expect(workflowEdit).toBeDefined()

    const created = await workflowEdit!.call({
      action: 'create_draft',
      id: 'inferred-draft',
      name: 'Inferred Draft',
      version: '0.1.0',
    })
    expect(created.structuredContent).toMatchObject({
      ok: true,
      draft: { draftId: 'inferred-draft' },
    })

    const replaced = await workflowEdit!.call({
      action: 'replace_definition',
      definition: definition(),
    })
    expect(replaced.structuredContent).toMatchObject({
      ok: true,
      validation: { ok: true },
    })

    const published = await workflowEdit!.call({
      action: 'publish_draft',
      id: 'inferred-draft-published',
      name: 'Inferred Draft Published',
      version: '0.1.0',
    })
    expect(published.structuredContent).toMatchObject({
      ok: true,
      published: {
        assetKey: 'workflow:inferred-draft-published@0.1.0',
      },
    })
  }, 15000)

  test('explains empty input as possibly truncated tool arguments', async () => {
    // Observed in AutoMat traces: models drop oversized inline definitions and
    // the tool receives {}, which then read as "requires action" with no path
    // forward. The error must teach the definitionFile/small-edit recovery.
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-edit-empty-'))
    const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_edit',
    )

    const empty = await workflowEdit!.call({})
    expect(empty.isError).toBe(true)
    expect(String(empty.structuredContent?.error)).toContain('received empty input')
    expect(String(empty.structuredContent?.error)).toContain('definitionFile')

    // A present-but-unknown action keeps the precise unsupported message.
    const unsupported = await workflowEdit!.call({ action: 'refactor_graph' })
    expect(String(unsupported.structuredContent?.error)).toContain(
      'Unsupported workflow_edit action: refactor_graph',
    )
  })

  test('replace_definition accepts a definitionFile path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-edit-file-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_edit',
    )

    await workflowEdit!.call({ action: 'create_draft', id: 'file-draft' })
    await writeJson(join(root, 'definition.json'), definition())

    const replaced = await workflowEdit!.call({
      action: 'replace_definition',
      draftId: 'file-draft',
      definitionFile: 'definition.json',
    })
    expect(replaced.structuredContent).toMatchObject({
      ok: true,
      validation: { ok: true },
    })

    const unreadable = await workflowEdit!.call({
      action: 'replace_definition',
      draftId: 'file-draft',
      definitionFile: 'missing.json',
    })
    expect(unreadable.isError).toBe(true)
    expect(String(unreadable.structuredContent?.error)).toContain(
      'could not read definitionFile "missing.json"',
    )
  })

  test('author publishes a definition file in one call and is idempotent after repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-author-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const tools = createMatOSWorkflowQueryEditTools({ cwd: root })
    const workflowEdit = tools.find(tool => tool.name === 'workflow_edit')
    const workflowQuery = tools.find(tool => tool.name === 'workflow_query')

    // Start from the deterministic skeleton — the boilerplate rules live in
    // code, not in the agent's context.
    const skeleton = await workflowQuery!.call({
      action: 'skeleton',
      nodeTypes: ['exec', 'exec'],
      name: 'authored-demo',
    })
    expect(skeleton.isError).not.toBe(true)
    const skeletonBody = skeleton.structuredContent as {
      definition: {
        nodes: Array<{ id: string; type: string; dependsOn: string[]; command?: string }>
      }
      validation: { ok: boolean }
      note: string
    }
    expect(skeletonBody.validation.ok).toBe(true)
    expect(skeletonBody.definition.nodes.map(node => node.id)).toEqual([
      'exec_1',
      'exec_2',
    ])
    expect(skeletonBody.definition.nodes[1]?.dependsOn).toEqual(['exec_1'])
    expect(skeletonBody.note).toContain('action=author')

    // Fill the skeleton and author it from a file in one call.
    const definition = {
      ...skeletonBody.definition,
      name: 'authored-demo',
      nodes: skeletonBody.definition.nodes.map((node, index) => ({
        ...node,
        command: `printf step-${index}`,
      })),
    }
    await writeJson(join(root, 'authored.json'), definition)
    const authored = await workflowEdit!.call({
      action: 'author',
      id: 'authored-demo',
      definitionFile: 'authored.json',
    })
    expect(authored.isError).not.toBe(true)
    expect(authored.structuredContent).toMatchObject({
      ok: true,
      draftId: 'authored-demo',
      published: { assetKey: 'workflow:authored-demo@0.1.0' },
      workflowRef: 'workflow:authored-demo@0.1.0',
    })
    expect(
      (authored.structuredContent as { nextSteps: string[] }).nextSteps[0],
    ).toContain('workflow_run action=start')
    // The compact result must not echo the full definition back.
    expect(authored.structuredContent && 'definition' in authored.structuredContent).toBe(
      false,
    )

    // Invalid definitions keep the draft and report structured errors; a
    // repaired re-run with the same id republishes (idempotent).
    const broken = {
      ...definition,
      nodes: [{ id: 'agent_1', type: 'agent', dependsOn: [] }],
    }
    await writeJson(join(root, 'authored.json'), broken)
    const rejected = await workflowEdit!.call({
      action: 'author',
      id: 'authored-demo',
      definitionFile: 'authored.json',
    })
    expect(String(rejected.structuredContent?.error ?? '')).toContain(
      'Agent node requires role',
    )

    await writeJson(join(root, 'authored.json'), definition)
    const repaired = await workflowEdit!.call({
      action: 'author',
      id: 'authored-demo',
      definitionFile: 'authored.json',
    })
    expect(repaired.structuredContent).toMatchObject({
      ok: true,
      workflowRef: 'workflow:authored-demo@0.1.0',
    })
    // Publish+repair round-trip on vePFS; the 5s bun default flaked under
    // parallel CI load (2026-08-13 t1 red).
  }, 20000)

  test('templates list, inspect, and expand inside skeletons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-templates-'))
    const workflowQuery = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_query',
    )

    const listed = await workflowQuery!.call({ action: 'templates', tag: 'qe' })
    expect(listed.isError).not.toBe(true)
    const listBody = listed.structuredContent as {
      templates: Array<{ id: string; nodeType: string; parameterKeys: string[] }>
    }
    expect(listBody.templates.map(item => item.id)).toContain('qe-pw-exec')
    // Compact listing: node bodies stay out of the browse call.
    expect(
      listBody.templates.every(item => !('node' in item)),
    ).toBe(true)

    const single = await workflowQuery!.call({
      action: 'template',
      templateId: 'qe-convergence-guard',
    })
    expect(single.isError).not.toBe(true)
    const template = (single.structuredContent as {
      template: { node: { checks: Array<{ type: string }> }; usage: string }
    }).template
    expect(template.node.checks.map(check => check.type)).toEqual([
      'file_size',
      'grep',
      'regex',
    ])
    expect(template.usage.length).toBeGreaterThan(20)

    const unknown = await workflowQuery!.call({ action: 'template', templateId: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(String(unknown.structuredContent?.error)).toContain('available:')

    // Skeleton composes template ids and plain node types into one wired,
    // valid definition with the template parameters merged in.
    const skeleton = await workflowQuery!.call({
      action: 'skeleton',
      nodeTypes: ['qe-pw-exec', 'qe-convergence-guard', 'agent'],
      name: 'qe-chain',
    })
    expect(skeleton.isError).not.toBe(true)
    const body = skeleton.structuredContent as {
      definition: {
        parameters: Record<string, unknown>
        nodes: Array<{ id: string; type: string; dependsOn: string[] }>
      }
      validation: { ok: boolean }
    }
    expect(body.validation.ok).toBe(true)
    expect(body.definition.nodes.map(node => node.id)).toEqual([
      'qe_pw_exec_1',
      'qe_convergence_guard_1',
      'agent_1',
    ])
    expect(body.definition.nodes[1]?.dependsOn).toEqual(['qe_pw_exec_1'])
    expect(body.definition.nodes[2]?.dependsOn).toEqual(['qe_convergence_guard_1'])
    expect(Object.keys(body.definition.parameters)).toEqual(
      expect.arrayContaining(['qe_input_file', 'qe_output_file', 'qe_profile']),
    )
  })

  test('draft mutations return compact summaries unless returnDefinition=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-compact-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_edit',
    )
    await workflowEdit!.call({ action: 'create_draft', id: 'compact-draft' })

    const added = await workflowEdit!.call({
      action: 'add_node',
      draftId: 'compact-draft',
      node: {
        id: 'prepare',
        type: 'exec',
        command: 'x'.repeat(500),
        dependsOn: [],
      },
    })
    expect(added.isError).not.toBe(true)
    const compact = added.structuredContent as {
      definition?: unknown
      summary: { nodeCount: number; nodes: Array<Record<string, unknown>> }
      note: string
    }
    // Full definition omitted; skeleton keeps wiring visible without bodies.
    expect(compact.definition).toBeUndefined()
    expect(compact.summary.nodeCount).toBe(1)
    expect(compact.summary.nodes[0]?.id).toBe('prepare')
    expect(compact.summary.nodes[0]?.command).toBeUndefined()
    expect(compact.note).toContain('returnDefinition=true')

    const full = await workflowEdit!.call({
      action: 'update_node',
      draftId: 'compact-draft',
      nodeId: 'prepare',
      patch: { description: 'updated' },
      returnDefinition: true,
    })
    expect(full.isError).not.toBe(true)
    expect(
      (full.structuredContent as { definition: { nodes: Array<{ command: string }> } })
        .definition.nodes[0]?.command,
    ).toBe('x'.repeat(500))
  })

  test('draft rejections name declared outputs and supported guard checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-edit-reject-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_edit',
    )
    await workflowEdit!.call({ action: 'create_draft', id: 'reject-draft' })

    // Agents intuitively reference `.outputs.response` on agent nodes; the
    // rejection must list the actually declared contract keys.
    const undeclared = await workflowEdit!.call({
      action: 'replace_definition',
      draftId: 'reject-draft',
      definition: {
        ...definition(),
        nodes: [
          {
            id: 'review',
            type: 'agent',
            role: 'role:compute',
            prompt: 'review results',
            dependsOn: [],
          },
        ],
        outputs: {
          verdict: { value: '{{ nodes.review.outputs.response }}' },
        },
      },
    })
    expect(undeclared.isError).toBe(true)
    expect(String(undeclared.structuredContent?.error)).toContain(
      'undeclared output "response"',
    )
    expect(String(undeclared.structuredContent?.error)).toContain(
      'declared outputs: result, structured, role',
    )

    // Guard node without checks: the rejection teaches the supported types.
    const guardless = await workflowEdit!.call({
      action: 'replace_definition',
      draftId: 'reject-draft',
      definition: {
        ...definition(),
        nodes: [
          { id: 'gate', type: 'guard', dependsOn: [] },
        ],
        outputs: {},
      },
    })
    expect(guardless.isError).toBe(true)
    expect(String(guardless.structuredContent?.error)).toContain(
      'Guard node requires checks (supported types: expression',
    )

    // An unrecognized check type must surface as its own error instead of
    // being silently dropped into a bare "requires checks".
    const unknownCheck = await workflowEdit!.call({
      action: 'add_node',
      draftId: 'reject-draft',
      node: {
        id: 'gate2',
        type: 'guard',
        dependsOn: [],
        checks: [{ type: 'weird_check', path: 'out.json' }],
      },
    })
    expect(unknownCheck.isError).toBe(true)
    expect(String(unknownCheck.structuredContent?.error)).toContain(
      'Unsupported guard check type "weird_check"',
    )
  })
})

describe('workflow_query list compaction', () => {
  // Context-budget guard: real role-mounted list rows measured ~1.9KB each
  // (full descriptions + provenance + lifecycle), so a 30-workflow role paid
  // 8-16K tokens per bare list call. Compact capped rows with pagination are
  // the default; detail=full restores the legacy row shape.
  async function setupListFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-list-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    for (let index = 0; index < 3; index += 1) {
      const id = `wf-${index}`
      await writeJson(
        join(root, '.matos', 'assets', 'workflows', id, 'asset.json'),
        {
          schemaVersion: 1,
          id,
          type: 'workflow',
          name: `WF ${index}`,
          version: '0.1.0',
          entry: 'workflow.json',
          description:
            `Workflow ${index} headline sentence. ` +
            'Verbose implementation detail nobody needs in a list row. '.repeat(
              20,
            ),
          tags: ['probe', `t${index}`],
          runtime: { workflow: { kind: 'executable' } },
        },
      )
      await writeJson(
        join(root, '.matos', 'assets', 'workflows', id, 'workflow.json'),
        {
          schemaVersion: 1,
          name: id,
          nodes: [
            { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ready' },
          ],
        },
      )
    }
    return root
  }

  function queryTool(root: string) {
    return createMatOSWorkflowQueryEditTools({ cwd: root }).find(
      tool => tool.name === 'workflow_query',
    )!
  }

  test('returns compact capped rows with pagination metadata by default', async () => {
    const root = await setupListFixture()
    const listed = await queryTool(root).call({ action: 'list' })
    const payload = listed.structuredContent as {
      workflows: Array<Record<string, unknown>>
      total: number
      count: number
      hasMore: boolean
    }
    expect(payload.total).toBe(3)
    expect(payload.count).toBe(3)
    expect(payload.hasMore).toBe(false)
    for (const row of payload.workflows) {
      // Compact rows keep the call contract but drop provenance/lifecycle.
      expect(row.canonicalKey).toBeDefined()
      expect(row.name).toBeDefined()
      expect(row.allowedToRun).toBe(true)
      expect(row.path).toBeUndefined()
      expect(row.lifecycle).toBeUndefined()
      expect(row.packId).toBeUndefined()
      expect(String(row.description).length).toBeLessThan(260)
      expect(String(row.description)).toContain('headline sentence.')
    }
  })

  test('honors limit/offset pagination and query filtering', async () => {
    const root = await setupListFixture()
    const tool = queryTool(root)

    const page = (await tool.call({ action: 'list', limit: 1, offset: 1 }))
      .structuredContent as {
      workflows: Array<Record<string, unknown>>
      total: number
      count: number
      hasMore: boolean
      offset: number
    }
    expect(page.total).toBe(3)
    expect(page.count).toBe(1)
    expect(page.offset).toBe(1)
    expect(page.hasMore).toBe(true)
    expect(page.workflows[0]!.canonicalKey).toBe('workflow:wf-1@0.1.0')

    const filtered = (await tool.call({ action: 'list', query: 'wf-2' }))
      .structuredContent as { workflows: Array<Record<string, unknown>>; total: number }
    expect(filtered.total).toBe(1)
    expect(filtered.workflows[0]!.canonicalKey).toBe('workflow:wf-2@0.1.0')
  })

  test('detail=full restores legacy rows and fields selects columns', async () => {
    const root = await setupListFixture()
    const tool = queryTool(root)

    const full = (await tool.call({ action: 'list', detail: 'full' }))
      .structuredContent as { workflows: Array<Record<string, unknown>> }
    expect(full.workflows[0]!.path).toBeDefined()
    expect(full.workflows[0]!.entry).toBeDefined()
    expect(
      String(full.workflows[0]!.description).length,
    ).toBeGreaterThan(400)

    const selected = (await tool.call({
      action: 'list',
      fields: ['canonicalKey', 'tags'],
    })).structuredContent as { workflows: Array<Record<string, unknown>> }
    for (const row of selected.workflows) {
      expect(Object.keys(row).sort()).toEqual(['canonicalKey', 'tags'])
    }

    const csvSelected = (await tool.call({
      action: 'list',
      fields: 'canonicalKey,name',
    })).structuredContent as { workflows: Array<Record<string, unknown>> }
    for (const row of csvSelected.workflows) {
      expect(Object.keys(row).sort()).toEqual(['canonicalKey', 'name'])
    }
  })
})

test('rejects empty update_node patches instead of silently doing nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-edit-empty-patch-'))
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  const workflowEdit = createMatOSWorkflowQueryEditTools({ cwd: root }).find(
    tool => tool.name === 'workflow_edit',
  )
  await workflowEdit!.call({ action: 'create_draft', id: 'empty-patch-draft' })
  const result = await workflowEdit!.call({
    action: 'update_node',
    draftId: 'empty-patch-draft',
    nodeId: 'missing',
    patch: {},
  })
  expect(result.isError).toBe(true)
  expect(String(result.structuredContent?.error)).toContain(
    'requires patch to be a non-empty object',
  )
})
