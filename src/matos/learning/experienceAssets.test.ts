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

import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildPromptInput } from './directAssetEditorPrompt.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import {
  maintainMatOSExperienceAssetsForSession,
  maintainMatOSExperienceAssetsForWorkflowEvidence,
  writeMatOSExperienceDraftAsset,
} from './experienceAssets.js'

async function writeProjectWithCoreAssetRoot(root: string): Promise<string> {
  await Bun.write(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: ['../matos-assets'],
        includeDefaultAssetRoots: false,
      },
      null,
      2,
    )}\n`,
  )
  const packRoot = join(root, 'matos-assets', 'packs', 'matos-core')
  await mkdir(packRoot, { recursive: true })
  await Bun.write(
    join(packRoot, 'matos.pack.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'matos-core',
        name: 'MatOS Core',
        version: '0.1.0',
      },
      null,
      2,
    )}\n`,
  )
  return packRoot
}

async function writeRoleAsset(input: {
  packRoot: string
  id: string
  dependencies: string[]
}): Promise<void> {
  const dir = join(input.packRoot, 'roles', input.id)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'role',
        name: input.id,
        version: '0.1.0',
        entry: 'ROLE.md',
        dependencies: input.dependencies,
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'ROLE.md'), `# ${input.id}\n`)
}

async function writeToolAsset(input: {
  packRoot: string
  id: string
  binding: string
  mcpName?: string
  description?: string
}): Promise<void> {
  const dir = join(input.packRoot, 'tools', input.id)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'tool',
        name: input.id,
        version: '0.1.0',
        description: input.description ?? `${input.id} tool.`,
        entry: 'prompt.md',
        metadata: {
          binding: input.binding,
          executor: {
            type: 'matos-python',
            mcpName: input.mcpName ?? input.binding,
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'prompt.md'), `# ${input.id}\n`)
}

async function writeSkillAsset(input: {
  packRoot: string
  id: string
  dependencies: string[]
  description: string
  tags?: string[]
  toolReferences?: string[]
}): Promise<void> {
  const dir = join(input.packRoot, 'skills', input.id)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'skill',
        name: input.id,
        version: '0.1.0',
        description: input.description,
        entry: 'SKILL.md',
        tags: input.tags ?? [],
        dependencies: input.dependencies,
        metadata:
          input.toolReferences && input.toolReferences.length > 0
            ? { toolReferences: input.toolReferences }
            : undefined,
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'SKILL.md'), `# ${input.id}\n\n${input.description}\n`)
}

async function writeKnowledgeAsset(input: {
  packRoot: string
  id: string
  description: string
  tags?: string[]
}): Promise<void> {
  const dir = join(input.packRoot, 'knowledge', input.id)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'knowledge',
        name: input.id,
        version: '0.1.0',
        description: input.description,
        entry: 'KNOWLEDGE.md',
        tags: input.tags ?? [],
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'KNOWLEDGE.md'), `# ${input.id}\n\n${input.description}\n`)
}

async function writeWorkflowAsset(input: {
  packRoot: string
  id: string
  dependencies: string[]
}): Promise<void> {
  const dir = join(input.packRoot, 'workflows', input.id)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'workflow',
        name: input.id,
        version: '0.1.0',
        entry: 'workflow.json',
        dependencies: input.dependencies,
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'workflow.json'), '{"nodes":[],"edges":[]}\n')
}

async function writeScopedToolAsset(input: {
  root: string
  userId: string
  id: string
}): Promise<void> {
  const dir = join(
    input.root,
    '.matos',
    'assets',
    'generated',
    'scopes',
    'users',
    input.userId,
    'evolution',
    'tools',
    input.id,
  )
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        type: 'tool',
        name: input.id,
        version: '0.1.0',
        entry: 'prompt.md',
        metadata: {
          scope: 'user',
          scopeRef: `user:${input.userId}`,
        },
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'prompt.md'), `# ${input.id}\n`)
}

describe('MatOS experience asset maintenance', () => {
  test('skips LLM refiner for zero-turn local slash command sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-zero-turn-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run "/login status"',
      cwd: root,
      traceId: 'trace-zero-turn-login-status',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: {
        result: 'Provider source: deployment-default',
        isError: false,
        numTurns: 0,
      },
    })
    await recorder.close()
    let refinerCalled = false

    const result = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        refinerCalled = true
        throw new Error('zero-turn local slash commands must not be refined')
      },
    })

    expect(result).toEqual([])
    expect(refinerCalled).toBe(false)
  })

  test('writes user scoped session experiences into a scope-local generated root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-user-scope-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role compute',
      cwd: root,
      traceId: 'trace-user-scope-experience',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: { prompt: '以后这个用户自己的 compute 资产优先使用本地 GPU。' },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => ({
        shouldWrite: true,
        id: 'local-gpu-preference',
        mergeKey: 'compute:local-gpu-preference',
        name: 'Local GPU Preference',
        summary: 'Prefer local GPUs for this user scope.',
        scenario: {
          domain: 'compute',
          taskType: 'role-preference',
          failureMode: 'shared-default-overrides-user-preference',
          appliesWhen: ['the current user asks for local GPU preference'],
          doesNotApplyWhen: ['a project policy requires remote queues'],
        },
        problemSignals: ['the user asks for a private compute preference'],
        failureModes: [
          {
            name: 'Shared default overrides user preference',
            symptoms: ['agent chooses the shared compute default'],
            rootCause: 'the user scoped preference is not recorded',
            avoidance: ['write the preference into user scoped evidence/assets'],
          },
        ],
        recommendedActions: ['Prefer local idle GPUs for this user.'],
        avoidRepeating: ['Do not write this private preference into core assets.'],
        checklist: ['Confirm the current scopeRef before applying the preference.'],
        examples: [],
      }),
    })

    expect(refs).toEqual(['experience:alice-local-gpu-preference@0.1.0'])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-local-gpu-preference',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata).toMatchObject({
      scope: 'user',
      scopeRef: 'user:alice',
      baseExperienceId: 'local-gpu-preference',
      mergeKey: 'compute:local-gpu-preference',
    })
  })

  test('direct editor prompt excludes other users scoped experiences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-scope-filter-'))
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: [],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    const draft = {
      mergeKey: 'compute:local-gpu-preference',
      name: 'Local GPU Preference',
      summary: 'Prefer local GPUs for this user scope.',
      roles: ['role:compute'],
      tools: [],
      toolNames: [],
      signalKinds: ['correction'],
      examples: [],
    }
    await writeMatOSExperienceDraftAsset({
      cwd: root,
      scopeRef: 'user:alice',
      draft: { ...draft, id: 'local-gpu-preference' },
    })
    await writeMatOSExperienceDraftAsset({
      cwd: root,
      scopeRef: 'user:bob',
      draft: { ...draft, id: 'local-gpu-preference' },
    })

    const promptInput = await buildPromptInput({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
    })

    expect(promptInput.experiences.map(experience => experience.assetRef)).toContain(
      'experience:alice-local-gpu-preference@0.1.0',
    )
    expect(promptInput.experiences.map(experience => experience.assetRef)).not.toContain(
      'experience:bob-local-gpu-preference@0.1.0',
    )
  })

  test('writes deterministic target-routed experience from session tool asset bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-tool-binding-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'custom-reader',
      binding: 'mcp__matos_asset__custom_reader',
      mcpName: 'custom_reader',
      description: 'Custom session-mounted web retrieval tool.',
    })
    await writeRoleAsset({
      packRoot,
      id: 'academic',
      dependencies: ['tool:custom-reader'],
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role academic',
      cwd: root,
      traceId: 'trace-custom-tool-binding-failure',
      roleRef: 'role:academic',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: {
        prompt: '读取这个 DOI 页面并总结论文。',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'mcp__matos_asset__custom_reader',
        isError: true,
        resultPreview:
          'HTTP 403 from publisher page after DOI redirect; socket closed before content could be extracted.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-tooling-custom-reader-session-tool-asset-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-tooling-custom-reader-session-tool-asset-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata).toMatchObject({
      sourceFormat: 'matos-experience-draft-v2',
      mergeKey: 'tooling:custom-reader:session-tool-asset-gap',
      targetAssetRefs: ['tool:custom-reader'],
      targetAssetTypes: ['tool'],
      directEditRecommended: true,
    })
  })

  test('routes asset graph feedback to the graph evolution runbook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-graph-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeKnowledgeAsset({
      packRoot,
      id: 'asset-graph-evolution-runbook',
      description: 'How to evolve MatOS asset graph behavior through source assets.',
      tags: ['asset-graph', 'self-evolution'],
    })
    await writeRoleAsset({
      packRoot,
      id: 'workflow-builder',
      dependencies: ['knowledge:asset-graph-evolution-runbook'],
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role workflow-builder',
      cwd: root,
      traceId: 'trace-asset-graph-feedback',
      roleRef: 'role:workflow-builder',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: {
        prompt:
          'asset_graph 图谱太吵了，应该默认用 core profile，并且不要错过已有 workflow 资产。',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'mcp__matos_asset__asset_graph',
        isError: false,
        resultPreview:
          'asset_graph returned many weak same_tag edges and the agent missed an existing workflow dependency.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-assets-asset-graph-graph-routing-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-assets-asset-graph-graph-routing-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata).toMatchObject({
      sourceFormat: 'matos-experience-draft-v2',
      mergeKey: 'assets:asset-graph:graph-routing-gap',
      targetAssetRefs: ['knowledge:asset-graph-evolution-runbook'],
      targetAssetTypes: ['knowledge'],
      directEditRecommended: true,
    })
  })

  test('routes domain-specific failures through the active role asset graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-vasp-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'remote-submit',
      binding: 'session_remote_submit',
      description: 'Session-specific remote compute submit tool.',
    })
    await writeSkillAsset({
      packRoot,
      id: 'custom-vasp-interface',
      dependencies: ['tool:remote-submit'],
      description:
        'Custom VASP HDF5 Wannier90 POTCAR preflight interface for this role.',
      tags: ['vasp', 'hdf5', 'wannier90', 'potcar'],
    })
    await writeRoleAsset({
      packRoot,
      id: 'compute',
      dependencies: ['skill:custom-vasp-interface', 'tool:remote-submit'],
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role compute',
      cwd: root,
      traceId: 'trace-vasp-hpc-failure',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: {
        prompt: '提交 VASP HDF5 + Wannier90 远程任务并检查 POTCAR。',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'session_remote_submit',
        isError: true,
        resultPreview:
          'Remote VASP failed: HDF5 ABI mismatch; POTCAR PPE.54/PBE_54 directory confusion should be preflighted with VRHFIN/LEXCH checks.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-tooling-remote-submit-session-tool-asset-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-tooling-remote-submit-session-tool-asset-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata).toMatchObject({
      mergeKey: 'tooling:remote-submit:session-tool-asset-gap',
      targetAssetRefs: expect.arrayContaining([
        'skill:custom-vasp-interface',
        'tool:remote-submit',
      ]),
      targetAssetTypes: expect.arrayContaining(['skill', 'tool']),
      directEditRecommended: true,
    })
  })

  test('uses matos.asset.loaded when roleRef is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-loaded-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'loaded-reader',
      binding: 'session_loaded_reader',
      description: 'Loaded reader tool for this session.',
    })
    await writeToolAsset({
      packRoot,
      id: 'unrelated-reader',
      binding: 'session_unrelated_reader',
      description: 'Unrelated reader tool outside the session.',
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run reader task',
      cwd: root,
      traceId: 'trace-loaded-asset-failure',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.asset.loaded',
      data: {
        id: 'loaded-reader',
        type: 'tool',
        canonicalKey: 'tool:loaded-reader@0.1.0',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'session_loaded_reader',
        isError: true,
        resultPreview: 'Loaded reader failed with a reusable parser error.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-tooling-loaded-reader-session-tool-asset-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-tooling-loaded-reader-session-tool-asset-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata?.targetAssetRefs).toEqual(['tool:loaded-reader'])
  })

  test('expands legacy skill toolReferences through the active role graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-toolrefs-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'legacy-submit',
      binding: 'matos_tool__legacy_submit',
      description: 'Legacy submit tool referenced from a skill.',
    })
    await writeSkillAsset({
      packRoot,
      id: 'legacy-submit-skill',
      dependencies: [],
      description: 'Legacy skill that uses a referenced submit tool.',
      toolReferences: ['tool:legacy-submit'],
    })
    await writeRoleAsset({
      packRoot,
      id: 'compute',
      dependencies: ['skill:legacy-submit-skill'],
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role compute',
      cwd: root,
      traceId: 'trace-legacy-toolref-failure',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'matos_tool__legacy_submit',
        isError: true,
        resultPreview: 'Legacy submit rejected the structured request body.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-tooling-legacy-submit-session-tool-asset-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-tooling-legacy-submit-session-tool-asset-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata?.targetAssetRefs).toEqual(
      expect.arrayContaining(['skill:legacy-submit-skill', 'tool:legacy-submit']),
    )
  })

  test('unknown non-generic tool failures request new asset types without targeting role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-unknown-tool-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeRoleAsset({
      packRoot,
      id: 'compute',
      dependencies: [],
    })
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run unknown tool',
      cwd: root,
      traceId: 'trace-unknown-tool-failure',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolName: 'mcp__matos_asset__unregistered_runtime_tool',
        isError: true,
        resultPreview:
          'The unregistered runtime tool failed with a stable schema error.',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => {
        throw new Error('LLM refiner unavailable')
      },
    })

    expect(refs).toEqual([
      'experience:alice-tooling-mcp-matos-asset-unregistered-runtime-tool-session-tool-asset-gap@0.1.0',
    ])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-tooling-mcp-matos-asset-unregistered-runtime-tool-session-tool-asset-gap',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata?.targetAssetRefs).toBeUndefined()
    expect(manifest.metadata?.targetAssetTypes).toEqual(['knowledge', 'mcp', 'tool'])
    expect(manifest.metadata?.directEditRecommended).toBe(true)
  })

  test('LLM refiner type-only target output still recommends direct editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-refiner-type-only-'))
    await writeProjectWithCoreAssetRoot(root)
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos --role compute',
      cwd: root,
      traceId: 'trace-refiner-type-only',
      roleRef: 'role:compute',
      scopeRef: 'user:alice',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: { prompt: '这个新工具应该沉淀为资产。' },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0, numTurns: 1 },
    })
    await recorder.close()

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', `${recorder.sessionId}.jsonl`),
      refiner: async () => ({
        shouldWrite: true,
        id: 'type-only-tool-target',
        mergeKey: 'tooling:type-only:target',
        name: 'Type-only tool target',
        summary: 'A tool type target should be enough to let direct editor create an asset.',
        scenario: {
          domain: 'tooling',
          taskType: 'type-only',
          failureMode: 'missing-asset',
          appliesWhen: ['a reusable tool asset is missing'],
          doesNotApplyWhen: ['the task is one-off'],
        },
        failureModes: [
          {
            name: 'missing tool asset',
            symptoms: ['tool behavior is not captured'],
            rootCause: 'the target asset does not exist yet',
            avoidance: ['create a tool asset'],
          },
        ],
        problemSignals: ['missing reusable tool asset'],
        recommendedActions: ['create a tool asset'],
        avoidRepeating: ['do not leave this only as an experience'],
        checklist: ['create or update a target tool asset'],
        targetAssetTypes: ['tool'],
        examples: [{ outcome: 'accepted' }],
      }),
    })

    expect(refs).toEqual(['experience:alice-type-only-tool-target@0.1.0'])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-type-only-tool-target',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata).toMatchObject({
      targetAssetTypes: ['tool'],
      directEditRecommended: true,
    })
  })

  test('workflow evidence adds workflow subgraph target hints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-workflow-evidence-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'workflow-submit',
      binding: 'workflow_submit',
      description: 'Workflow submit tool.',
    })
    await writeSkillAsset({
      packRoot,
      id: 'workflow-skill',
      dependencies: ['tool:workflow-submit'],
      description: 'Workflow repair skill.',
    })
    await writeWorkflowAsset({
      packRoot,
      id: 'repair-flow',
      dependencies: ['skill:workflow-skill'],
    })

    const refs = await maintainMatOSExperienceAssetsForWorkflowEvidence({
      cwd: root,
      evidence: {
        schemaVersion: 1,
        evidenceId: 'ev-workflow-1',
        runId: 'run-workflow-1',
        workflowRef: 'workflow:repair-flow',
        status: 'failed',
        sourceRefs: ['workflow-event:run-workflow-1#n1'],
        nodeSummary: [{ nodeId: 'n1', status: 'failed', attempts: 1, hasError: true }],
        eventTypes: ['workflow.node.failed'],
        artifactRefs: [],
        suggestedAssetTypes: ['workflow', 'skill', 'knowledge'],
        createdAt: new Date().toISOString(),
      },
      refiner: async () => ({
        shouldWrite: true,
        id: 'workflow-repair-failure',
        mergeKey: 'workflow:repair:failure',
        name: 'Workflow repair failure',
        summary: 'Workflow repair failures should update the workflow subgraph.',
        scenario: {
          domain: 'workflow',
          taskType: 'repair-flow',
          failureMode: 'node-failed',
          appliesWhen: ['workflow node failed'],
          doesNotApplyWhen: ['unrelated session'],
        },
        failureModes: [
          {
            name: 'node failed',
            symptoms: ['workflow node failed'],
            rootCause: 'workflow subgraph lacks a repair hint',
            avoidance: ['update workflow subgraph assets'],
          },
        ],
        problemSignals: ['workflow failed'],
        recommendedActions: ['update the workflow subgraph assets'],
        avoidRepeating: ['do not leave the failure only in evidence'],
        checklist: ['check workflow dependencies'],
        examples: [{ outcome: 'failed' }],
      }),
    })

    expect(refs).toEqual(['experience:workflow-repair-failure@0.1.0'])
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'evolution',
          'experiences',
          'workflow-repair-failure',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata?: Record<string, unknown> }
    expect(manifest.metadata?.targetAssetRefs).toEqual(
      expect.arrayContaining([
        'workflow:repair-flow',
        'skill:workflow-skill',
        'tool:workflow-submit',
      ]),
    )
    expect(manifest.metadata?.directEditRecommended).toBe(true)
  })

  test('direct editor prioritizes target assets declared by experience metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-target-routing-'))
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    const packRoot = join(root, 'matos-assets', 'packs', 'matos-core')
    await mkdir(join(packRoot, 'tools', 'custom-target-tool'), { recursive: true })
    await Bun.write(
      join(packRoot, 'matos.pack.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'matos-core',
          name: 'MatOS Core',
          version: '0.1.0',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(packRoot, 'tools', 'custom-target-tool', 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'custom-target-tool',
          type: 'tool',
          name: 'Custom Target Tool',
          version: '0.1.0',
          description: 'Custom target tool for MatOS agents.',
          entry: 'prompt.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(packRoot, 'tools', 'custom-target-tool', 'prompt.md'),
      'Run the custom target tool and classify retrieval failures.\n',
    )

    await writeMatOSExperienceDraftAsset({
      cwd: root,
      draft: {
        id: 'custom-target-tool-fallback',
        mergeKey: 'tooling:custom-target-tool:failure',
        name: 'Custom Target Tool fallback',
        summary:
          'Custom target tool retrieval failures should update the declared tool asset.',
        roles: ['academic'],
        tools: ['custom-target-tool'],
        toolNames: ['custom_target_tool'],
        signalKinds: ['failure'],
        targetAssetRefs: ['tool:custom-target-tool'],
        targetAssetTypes: ['tool' as const],
        directEditRecommended: true,
        examples: [],
      },
    })

    const promptInput = await buildPromptInput({
      cwd: root,
      scope: 'core',
      evolutionContext: {
        experienceRefs: ['experience:custom-target-tool-fallback@0.1.0'],
      },
    })

    expect(promptInput.targetContract).toMatchObject({
      source: 'experience',
      preferredRefs: ['tool:custom-target-tool'],
      expectedTypes: ['tool'],
    })
    expect(promptInput.targetAssets[0]?.assetRef).toBe('tool:custom-target-tool@0.1.0')
    expect(promptInput.targetAssets[0]?.editableFiles).toEqual(
      expect.arrayContaining([
        'matos-assets/packs/matos-core/tools/custom-target-tool/asset.json',
        'matos-assets/packs/matos-core/tools/custom-target-tool/prompt.md',
      ]),
    )
  })

  test('direct editor ignores hidden experience target routing metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-hidden-routing-'))
    const packRoot = await writeProjectWithCoreAssetRoot(root)
    await writeToolAsset({
      packRoot,
      id: 'visible-tool',
      binding: 'visible_tool',
      description: 'Visible tool.',
    })
    await writeMatOSExperienceDraftAsset({
      cwd: root,
      draft: {
        id: 'hidden-target-routing',
        mergeKey: 'tooling:hidden-target-routing',
        name: 'Hidden target routing',
        summary: 'Hidden experiences must not steer direct editor.',
        roles: ['compute'],
        tools: ['visible-tool'],
        toolNames: ['visible_tool'],
        signalKinds: ['failure'],
        targetAssetRefs: ['tool:visible-tool'],
        targetAssetTypes: ['tool' as const],
        directEditRecommended: true,
        examples: [],
      },
    })
    const manifestPath = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'hidden-target-routing',
      'asset.json',
    )
    const hiddenManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await Bun.write(
      manifestPath,
      `${JSON.stringify(
        {
          ...hiddenManifest,
          metadata: {
            ...((hiddenManifest.metadata as Record<string, unknown>) ?? {}),
            hidden: true,
          },
        },
        null,
        2,
      )}\n`,
    )

    const promptInput = await buildPromptInput({
      cwd: root,
      scope: 'core',
      evolutionContext: {
        experienceRefs: ['experience:hidden-target-routing@0.1.0'],
      },
    })

    expect(promptInput.experiences.map(experience => experience.assetRef)).not.toContain(
      'experience:hidden-target-routing@0.1.0',
    )
    expect(promptInput.targetContract).toBeUndefined()
  })

  test('direct editor filters scoped target refs to the current user scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-assets-scoped-targets-'))
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: [],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: 'assets/generated/scopes/users/alice',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
            {
              type: 'local',
              id: 'bob-assets',
              path: 'assets/generated/scopes/users/bob',
              scope: 'user',
              scopeRef: 'user:bob',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeScopedToolAsset({ root, userId: 'alice', id: 'alice-private' })
    await writeScopedToolAsset({ root, userId: 'bob', id: 'bob-private' })
    await writeMatOSExperienceDraftAsset({
      cwd: root,
      scopeRef: 'user:alice',
      draft: {
        id: 'scoped-target-routing',
        mergeKey: 'tooling:scoped-target-routing',
        name: 'Scoped target routing',
        summary: 'Only current user scoped target assets may steer direct editor.',
        roles: ['compute'],
        tools: ['alice-private'],
        toolNames: ['alice_private'],
        signalKinds: ['failure'],
        targetAssetRefs: ['tool:bob-private', 'tool:alice-private'],
        targetAssetTypes: ['tool' as const],
        directEditRecommended: true,
        examples: [],
      },
    })

    const promptInput = await buildPromptInput({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      evolutionContext: {
        experienceRefs: ['experience:alice-scoped-target-routing@0.1.0'],
      },
    })

    expect(promptInput.targetContract?.preferredRefs).toEqual(['tool:alice-private'])
    expect(promptInput.targetAssets.map(asset => asset.assetRef)).toContain(
      'tool:alice-private@0.1.0',
    )
    expect(promptInput.targetAssets.map(asset => asset.assetRef)).not.toContain(
      'tool:bob-private@0.1.0',
    )
  })
})
