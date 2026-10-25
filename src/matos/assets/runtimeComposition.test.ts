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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildMatOSRunInvocation } from '../cli/run.js'
import { composeMatOSRoleRuntime } from './runtimeComposition.js'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { validateMatOSAssets } from './validateAssets.js'
import type { MatOSAsset } from './types.js'
import { withMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'

function isNativeCoreAssetPath(path: string | undefined): boolean {
  return Boolean(path && path.includes(join('matos-assets', 'packs', 'matos-core')))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// Explicit per-test ceilings guard against hangs, but they must not defeat
// the repo-wide MATOS_TEST_TIMEOUT_MS escape hatch used on loaded hosts where
// real default-library composition and skill materialization run several
// times slower than on an idle machine.
const ENV_TEST_TIMEOUT_MS = Number(process.env.MATOS_TEST_TIMEOUT_MS ?? '')
const RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS =
  Number.isFinite(ENV_TEST_TIMEOUT_MS) && ENV_TEST_TIMEOUT_MS > 60_000
    ? ENV_TEST_TIMEOUT_MS
    : 60_000

// The bundled compute role version legitimately moves (developer edits and
// accepted self-evolution both bump it). Guard tests must assert against the
// resolved canonical key instead of pinning a stale version, otherwise every
// routine version bump turns the regression gate red.
const COMPUTE_ROLE_KEY_PATTERN = /^role:compute@\d+\.\d+\.\d+$/

describe('MatOS native runtime composition', () => {
  test('composes explicitly selected scoped assets without mutating the role asset', async () => {
    const asset = (
      type: string,
      id: string,
      overrides: Partial<MatOSAsset> = {},
    ): MatOSAsset => ({
      id,
      type,
      name: id,
      version: '1.0.0',
      description: `${id} description`,
      canonicalKey: `${type}:${id}@1.0.0`,
      relativePath: `${type}/${id}`,
      absolutePath: `/assets/${type}/${id}`,
      entryRelativePath: undefined,
      entryAbsolutePath: undefined,
      manifestPath: `/assets/${type}/${id}/asset.json`,
      manifestDir: `/assets/${type}/${id}`,
      source: 'pack',
      sourcePath: '/assets',
      packId: 'test',
      packName: 'test',
      packVersion: '1.0.0',
      tags: [],
      permissions: [],
      dependencies: [],
      mounts: {},
      runtime: { assetDiscoveryTools: false, workflowFacadeTools: false },
      lifecycle: { status: 'enabled' },
      metadata: {},
      ...overrides,
    })
    const role = asset('role', 'project-role')
    const knowledge = asset('knowledge', 'shared-runbook')
    const registry = buildMatOSAssetRegistry([role, knowledge])

    const runtime = await composeMatOSRoleRuntime(registry, 'role:project-role', {
      additionalAssetRefs: ['knowledge:shared-runbook'],
      includeToolSurfaces: false,
    })

    expect(runtime.appendSystemPrompt.join('\n')).toContain('shared-runbook')
    expect(runtime.assetEvents).toContainEqual({
      type: 'selected',
      assetKey: knowledge.canonicalKey,
    })
    expect(role.mounts).toEqual({})
    // An explicit empty registry catalog must suppress inherited broad roots.
    const mcp = JSON.parse(runtime.mcpConfigJson[0]!)
    expect(mcp.mcpServers.matos_asset.env.MATOS_MLIP_MODEL_MANIFESTS).toBe('[]')
    await expect(
      composeMatOSRoleRuntime(registry, 'role:project-role', {
        additionalAssetRefs: ['knowledge:not-visible'],
      }),
    ).rejects.toThrow('MatOS selected asset not found')
  })

  test(
    'builds a role run invocation from default asset roots',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-runtime-defaults-'))
      const invocation = await buildMatOSRunInvocation(
        ['--role', 'role:compute', 'profile only', '--max-turns', '1'],
        root,
      )

      expect(
        invocation.selectedAssetKeys.filter(key =>
          COMPUTE_ROLE_KEY_PATTERN.test(key),
        ),
      ).toHaveLength(1)
      expect(invocation.agentArgs).toContain('--agent')
      expect(invocation.agentArgs).toContain('compute')
      expect(invocation.agentArgs).toContain('--mcp-config')
    },
    RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS,
  )

  test('passes web-read proxy env to the MatOS asset MCP server', async () => {
    const originalHttpProxy = process.env.MATOS_WEB_READ_HTTP_PROXY
    const originalHttpsProxy = process.env.MATOS_WEB_READ_HTTPS_PROXY
    const originalJinaProxy = process.env.MATOS_JINA_HTTPS_PROXY
    process.env.MATOS_WEB_READ_HTTP_PROXY = 'http://198.51.100.15:7892'
    process.env.MATOS_WEB_READ_HTTPS_PROXY = 'http://198.51.100.15:7892'
    process.env.MATOS_JINA_HTTPS_PROXY = 'http://198.51.100.15:7892'
    try {
      const root = await mkdtemp(join(tmpdir(), 'matos-runtime-web-read-proxy-'))
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      const runtime = await composeMatOSRoleRuntime(registry, 'role:research-scientist', {
        projectCwd: root,
      })
      const selectedMcpConfig = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')

      expect(selectedMcpConfig.mcpServers?.matos_asset?.env).toMatchObject({
        MATOS_WEB_READ_HTTP_PROXY: 'http://198.51.100.15:7892',
        MATOS_WEB_READ_HTTPS_PROXY: 'http://198.51.100.15:7892',
        MATOS_JINA_HTTPS_PROXY: 'http://198.51.100.15:7892',
      })
    } finally {
      if (originalHttpProxy === undefined) {
        delete process.env.MATOS_WEB_READ_HTTP_PROXY
      } else {
        process.env.MATOS_WEB_READ_HTTP_PROXY = originalHttpProxy
      }
      if (originalHttpsProxy === undefined) {
        delete process.env.MATOS_WEB_READ_HTTPS_PROXY
      } else {
        process.env.MATOS_WEB_READ_HTTPS_PROXY = originalHttpsProxy
      }
      if (originalJinaProxy === undefined) {
        delete process.env.MATOS_JINA_HTTPS_PROXY
      } else {
        process.env.MATOS_JINA_HTTPS_PROXY = originalJinaProxy
      }
    }
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('enables only compact workflow facade tools for non-workflow roles without delegated workflow agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-workflow-facade-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'basic')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'basic',
      type: 'role',
      name: 'Basic',
      version: '0.1.0',
      entry: 'ROLE.md',
      mounts: {
        tools: ['tool:files-core'],
      },
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'You are a basic MatOS role.\n')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const runtime = await composeMatOSRoleRuntime(registry, 'role:basic', {
      projectCwd: root,
    })
    const selectedMcpConfig = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')

    expect(runtime.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__matos_asset__workflow_query',
        'mcp__matos_asset__workflow_run',
        'mcp__matos_asset__workflow_edit',
      ]),
    )
    expect(runtime.allowedTools).not.toContain(
      'mcp__matos_asset__workflow_add_node',
    )
    expect(selectedMcpConfig.mcpServers?.matos_asset?.env).toMatchObject({
      MATOS_ENABLE_WORKFLOW_TOOLS: '1',
      MATOS_WORKFLOW_TOOL_MODE: 'facade',
      MATOS_SELECTED_ROLE_REF: 'role:basic@0.1.0',
    })
    const prompt = runtime.appendSystemPrompt.join('\n')
    expect(prompt).toContain('When a tracked CLI harness owns execution')
    expect(prompt).toContain('do not wait or poll')
  })

  test('passes durable remaining workflow budget into production inference routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-budget-routing-'))
    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(
      assets.map(asset =>
        asset.type === 'role' && asset.id === 'compute'
          ? {
              ...asset,
              runtime: {
                ...asset.runtime,
                model: 'authorized-model',
                effort: 'high',
                inferenceRoutes: [
                  { model: 'authorized-model', effort: 'low' },
                ],
                algorithms: { 'inference-routing': 'budget-aware' },
              },
            }
          : asset,
      ),
    )
    const runtime = await withMatOSWorkflowExecutionContext(
      {
        runId: 'run-budget-routing',
        runDir: join(root, '.matos', 'workflows', 'runs', 'run-budget-routing'),
        workflowNodeId: 'agent',
        attempt: 1,
        projectCwd: root,
        remainingBudget: { maxTotalTokens: 0, maxTotalCostUsd: 1 },
      },
      () =>
        composeMatOSRoleRuntime(registry, 'role:compute', {
          projectCwd: root,
        }),
    )

    expect(runtime.agents.compute).toMatchObject({
      model: 'authorized-model',
      effort: 'low',
    })
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('projects enabled workflows into role runtime and MCP env without creating hard dependency cycles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-mounted-workflow-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'relax')
    const runtimeWorkflowDir = join(root, '.matos', 'assets', 'workflows', 'screen')
    await mkdir(roleDir, { recursive: true })
    await mkdir(workflowDir, { recursive: true })
    await mkdir(runtimeWorkflowDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'ROLE.md',
      mounts: {
        workflows: ['workflow:relax'],
      },
      metadata: {
        runtimeWorkflowRefs: ['workflow:screen'],
      },
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'Plan with workflows.\n')
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'relax',
      type: 'workflow',
      name: 'Relax',
      version: '0.1.0',
      description: 'Relax a structure.',
      entry: 'workflow.yaml',
    })
    await writeJson(join(runtimeWorkflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'screen',
      type: 'workflow',
      name: 'Screen',
      version: '0.1.0',
      description: 'Screen candidates.',
      entry: 'workflow.yaml',
      dependencies: ['role:planner'],
    })
    await writeFile(
      join(workflowDir, 'workflow.yaml'),
      [
        'schemaVersion: 1',
        'name: relax',
        'parameters: {}',
        'policy:',
        '  approvalMode: bypass',
        '  defaultRisk: low',
        'nodes: {}',
        'outputs: {}',
      ].join('\n'),
    )
    await writeFile(
      join(runtimeWorkflowDir, 'workflow.yaml'),
      [
        'schemaVersion: 1',
        'name: screen',
        'parameters: {}',
        'policy:',
        '  approvalMode: bypass',
        '  defaultRisk: low',
        'nodes: {}',
        'outputs: {}',
      ].join('\n'),
    )

    const assets = await loadMatOSAssets(root)
    expect((await validateMatOSAssets(assets)).ok).toBe(true)
    const registry = buildMatOSAssetRegistry(assets)
    const runtime = await composeMatOSRoleRuntime(registry, 'role:planner', {
      projectCwd: root,
    })
    const selectedMcpConfig = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')

    expect(runtime.mountedWorkflowRefs).toEqual([
      'workflow:relax@0.1.0',
      'workflow:screen@0.1.0',
    ])
    expect(runtime.appendSystemPrompt.join('\n')).toContain(
      'MatOS workflows enabled for this role runtime:',
    )
    expect(selectedMcpConfig.mcpServers?.matos_asset?.env).toMatchObject({
      MATOS_ALLOWED_WORKFLOW_REFS: JSON.stringify([
        'workflow:relax@0.1.0',
        'workflow:screen@0.1.0',
      ]),
    })
  })

  test('does not advertise external-channel Skill routing unless the role mounts that skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-no-external-skill-'))
    const assetsDir = join(root, '.matos', 'assets')
    const roleDir = join(assetsDir, 'roles', 'basic')
    const skillDir = join(assetsDir, 'skills', 'basic-helper')
    await mkdir(roleDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'basic',
      type: 'role',
      name: 'Basic',
      version: '0.1.0',
      entry: 'ROLE.md',
      mounts: {
        skills: ['skill:basic-helper'],
        tools: ['tool:files-core'],
      },
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'You are a basic MatOS role.\n')
    await writeJson(join(skillDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'basic-helper',
      type: 'skill',
      name: 'Basic Helper',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Basic Helper\n')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const runtime = await composeMatOSRoleRuntime(registry, 'role:basic', {
      projectCwd: root,
    })
    const prompt = runtime.appendSystemPrompt.join('\n')

    expect(prompt).toContain('Available MatOS skill names: basic-helper.')
    expect(prompt).not.toContain('MatOS external-channel checkpoint')
    expect(prompt).not.toContain('Skill("external-channels")')
  })

  test('injects draft experience summaries only when draft opt-in is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-experience-'))
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'glob-grep-ripgrep-missing-fallback',
    )
    await mkdir(experienceDir, { recursive: true })
    await writeJson(join(experienceDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'glob-grep-ripgrep-missing-fallback',
      type: 'experience',
      name: 'Glob/Grep Tool Failure Recovery via Bash find/grep',
      version: '0.1.0',
      description:
        'When Glob and Grep fail because vendored ripgrep is missing, fall back to Bash find and grep.',
      entry: 'EXPERIENCE.md',
      tags: ['generated', 'learning', 'draft', 'experience'],
      lifecycle: { status: 'draft' },
      metadata: {
        sourceFormat: 'matos-experience-llm-v1',
        mergeKey: 'tools:search:ripgrep-vendor-missing',
        toolNames: ['Glob', 'Grep', 'Bash', 'Read'],
        tools: ['glob', 'grep', 'bash', 'read'],
        signalKinds: ['failure', 'success'],
        scenario: {
          domain: 'tools',
          taskType: 'file-discovery-and-content-search',
          failureMode: 'vendored-ripgrep-missing',
          appliesWhen: [
            'Glob or Grep returns ENOENT for src/utils/vendor/ripgrep.',
          ],
          doesNotApplyWhen: ['Glob and Grep are working normally.'],
        },
        recommendedActions: [
          'Stop retrying Glob/Grep and switch to Bash find/grep.',
        ],
        avoidRepeating: [
          'Do not issue another large batch of Glob/Grep calls after the vendor rg ENOENT.',
        ],
      },
    })
    await writeFile(
      join(experienceDir, 'EXPERIENCE.md'),
      '# Glob/Grep Tool Failure Recovery via Bash find/grep\n',
      'utf8',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    // Default: draft experiences never reach the prompt (no acceptance gate).
    const defaultRuntime = await composeMatOSRoleRuntime(registry, 'role:compute', {
      projectCwd: root,
    })
    expect(defaultRuntime.appendSystemPrompt.join('\n')).not.toContain(
      'Relevant MatOS experience',
    )

    process.env.MATOS_EXPERIENCE_CONTEXT_ALLOW_DRAFT = '1'
    let runtime: Awaited<ReturnType<typeof composeMatOSRoleRuntime>>
    try {
      runtime = await composeMatOSRoleRuntime(registry, 'role:compute', {
        projectCwd: root,
      })
    } finally {
      delete process.env.MATOS_EXPERIENCE_CONTEXT_ALLOW_DRAFT
    }
    const prompt = runtime.appendSystemPrompt.join('\n')

    expect(prompt).toContain('Relevant MatOS experience')
    expect(prompt).toContain(
      'experience:glob-grep-ripgrep-missing-fallback@0.1.0',
    )
    expect(prompt).toContain('Stop retrying Glob/Grep')
    expect(prompt).toContain('vendor rg ENOENT')
    expect(runtime.assetEvents).toContainEqual({
      type: 'projected',
      assetKey: 'experience:glob-grep-ripgrep-missing-fallback@0.1.0',
      reason: 'relevant-experience',
    })
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('injects relevant scoped knowledge without requiring explicit role mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-knowledge-context-'))
    const knowledgeDir = join(
      root,
      '.matos',
      'assets',
      'knowledge',
      'vasp-input-verification-check-before-submit',
    )
    const unrelatedDir = join(
      root,
      '.matos',
      'assets',
      'knowledge',
      'unrelated-sales-playbook',
    )
    await mkdir(knowledgeDir, { recursive: true })
    await mkdir(unrelatedDir, { recursive: true })
    await writeJson(join(knowledgeDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-input-verification-check-before-submit',
      type: 'knowledge',
      name: 'Verify VASP input files before batch submission',
      version: '0.1.0',
      description:
        'Check POTCAR element order, INCAR settings, KPOINTS, and unique HPC benchmarkCaseId before VASP batch submission.',
      entry: 'KNOWLEDGE.md',
      tags: ['vasp', 'dft', 'compute', 'hpc', 'input-validation'],
      metadata: {
        summary:
          'Use this compute knowledge before submitting VASP batches through HPC.',
        evidenceRefs: [
          'experience:vasp-input-verification-before-submit@0.1.0',
        ],
      },
    })
    await writeFile(
      join(knowledgeDir, 'KNOWLEDGE.md'),
      '# Verify VASP input files before batch submission\n',
      'utf8',
    )
    await writeJson(join(unrelatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'unrelated-sales-playbook',
      type: 'knowledge',
      name: 'Unrelated Sales Playbook',
      version: '0.1.0',
      description: 'Commercial sales process notes that should not enter compute.',
      entry: 'KNOWLEDGE.md',
      tags: ['sales', 'crm'],
    })
    await writeFile(
      join(unrelatedDir, 'KNOWLEDGE.md'),
      '# Unrelated Sales Playbook\n',
      'utf8',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const runtime = await composeMatOSRoleRuntime(registry, 'role:compute', {
      projectCwd: root,
    })
    const prompt = runtime.appendSystemPrompt.join('\n')

    expect(prompt).toContain('Relevant MatOS scoped knowledge assets:')
    expect(prompt).toContain(
      'knowledge:vasp-input-verification-check-before-submit@0.1.0',
    )
    expect(prompt).toContain('Use this compute knowledge before submitting VASP')
    expect(prompt).not.toContain('knowledge:unrelated-sales-playbook@0.1.0')
    expect(runtime.readablePaths).toContain(join(knowledgeDir, 'KNOWLEDGE.md'))
    expect(runtime.assetEvents).toContainEqual({
      type: 'projected',
      assetKey: 'knowledge:vasp-input-verification-check-before-submit@0.1.0',
      reason: 'relevant-knowledge',
    })
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('task text surfaces knowledge that role identity alone would not select', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-task-knowledge-'))
    const knowledgeDir = join(
      root,
      '.matos',
      'assets',
      'knowledge',
      'papyrus-bioactivity-filtering',
    )
    await mkdir(knowledgeDir, { recursive: true })
    await writeJson(join(knowledgeDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'papyrus-bioactivity-filtering',
      type: 'knowledge',
      name: 'Papyrus bioactivity dataset filtering conventions',
      version: '0.1.0',
      description:
        'Filter Papyrus ligand bioactivity records by pchembl threshold, assay quality, and target accession before modeling.',
      entry: 'KNOWLEDGE.md',
      // Intentionally no compute/DFT/tool tags: this asset only matches via
      // task text, not the compute role identity or its tool vocabulary.
      tags: ['papyrus', 'bioactivity', 'ligand', 'cheminformatics'],
      metadata: {
        summary:
          'Papyrus filtering must drop low-quality and duplicate bioactivity rows before QSAR modeling.',
      },
    })
    await writeFile(
      join(knowledgeDir, 'KNOWLEDGE.md'),
      '# Papyrus bioactivity dataset filtering conventions\n',
      'utf8',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    const withoutTask = await composeMatOSRoleRuntime(registry, 'role:compute', {
      projectCwd: root,
    })
    expect(withoutTask.appendSystemPrompt.join('\n')).not.toContain(
      'knowledge:papyrus-bioactivity-filtering@0.1.0',
    )

    const withTask = await composeMatOSRoleRuntime(registry, 'role:compute', {
      projectCwd: root,
      taskText:
        'Filter the Papyrus bioactivity dataset and remove low-quality ligand records before building a QSAR model.',
    })
    expect(withTask.appendSystemPrompt.join('\n')).toContain(
      'knowledge:papyrus-bioactivity-filtering@0.1.0',
    )
    expect(withTask.assetEvents).toContainEqual({
      type: 'projected',
      assetKey: 'knowledge:papyrus-bioactivity-filtering@0.1.0',
      reason: 'relevant-knowledge',
    })
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('emits skipped asset events for unresolved role references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-skipped-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'runner')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'runner',
      type: 'role',
      name: 'Runner',
      version: '0.1.0',
      entry: 'prompt.md',
      mounts: {
        tools: ['tool:ghost-tool', 'Read'],
        skills: ['skill:ghost-skill'],
        knowledge: ['knowledge:ghost-knowledge'],
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'You run things.\n', 'utf8')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const runtime = await composeMatOSRoleRuntime(registry, 'role:runner', {
      projectCwd: root,
    })

    expect(runtime.assetEvents).toContainEqual({
      type: 'skipped',
      assetKey: 'tool:ghost-tool',
      reason: 'unresolved-tools-reference',
    })
    expect(runtime.assetEvents).toContainEqual({
      type: 'skipped',
      assetKey: 'skill:ghost-skill',
      reason: 'unresolved-skills-reference',
    })
    expect(runtime.assetEvents).toContainEqual({
      type: 'skipped',
      assetKey: 'knowledge:ghost-knowledge',
      reason: 'unresolved-knowledge-reference',
    })
    expect(
      runtime.assetEvents.some(
        event => event.type === 'skipped' && event.assetKey === 'Read',
      ),
    ).toBe(false)
    expect(runtime.allowedTools).toContain('Read')
  })

  test('filters host-only TOS paths from asset MCP server env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-tos-env-'))
    const previousQePseudoRoot = process.env.MATOS_QE_PSEUDO_ROOT
    const previousLabActorFile = process.env.MATOS_LAB_ACTOR_FILE
    try {
      process.env.MATOS_QE_PSEUDO_ROOT =
        '/tos-example-bucket/example-user/qe-pseudopotentials'
      process.env.MATOS_LAB_ACTOR_FILE =
        '/tos-example-bucket/example-user/matos/lab-actor.json'

      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      const runtime = await composeMatOSRoleRuntime(registry, 'role:compute', {
        projectCwd: root,
      })
      const selectedMcpConfig = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')
      const selectedEnv = selectedMcpConfig.mcpServers?.matos_asset?.env ?? {}

      expect(selectedEnv.MATOS_QE_PSEUDO_ROOT).toBeUndefined()
      expect(selectedEnv.MATOS_LAB_ACTOR_FILE).toBeUndefined()
      expect(JSON.stringify(selectedMcpConfig)).not.toContain('/tos-example-bucket')
    } finally {
      if (previousQePseudoRoot === undefined) {
        delete process.env.MATOS_QE_PSEUDO_ROOT
      } else {
        process.env.MATOS_QE_PSEUDO_ROOT = previousQePseudoRoot
      }
      if (previousLabActorFile === undefined) {
        delete process.env.MATOS_LAB_ACTOR_FILE
      } else {
        process.env.MATOS_LAB_ACTOR_FILE = previousLabActorFile
      }
    }
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('reuses cached runtime skill materializations under configured scratch root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-isolated-skills-'))
    const runtimeRoot = join(root, 'scratch', 'asset-runtime')
    const previousRuntimeRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    try {
      process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = runtimeRoot
      const first = await buildMatOSRunInvocation(
        ['--role', 'role:compute', 'first', '--max-turns', '1'],
        root,
      )
      const second = await buildMatOSRunInvocation(
        ['--role', 'role:compute', 'second', '--max-turns', '1'],
        root,
      )

      const firstAddDir = first.agentArgs[first.agentArgs.indexOf('--add-dir') + 1] ?? ''
      const secondAddDir = second.agentArgs[second.agentArgs.indexOf('--add-dir') + 1] ?? ''
      expect(firstAddDir.startsWith(`${runtimeRoot}/`)).toBe(true)
      expect(secondAddDir.startsWith(`${runtimeRoot}/`)).toBe(true)
      expect(firstAddDir).toBe(secondAddDir)
      expect(
        await readFile(
          join(firstAddDir, '.matos', 'skills', 'scientific-programming', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('user-invocable: false')
      expect(
        await readFile(
          join(secondAddDir, '.matos', 'skills', 'scientific-programming', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('user-invocable: false')
    } finally {
      if (previousRuntimeRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRuntimeRoot
      }
    }
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('projects self-evolution hidden roles without legacy Provider1 MCP tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-self-evolution-'))
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    const directEditor = await composeMatOSRoleRuntime(
      registry,
      'role:direct-asset-editor',
      {
        projectCwd: root,
      },
    )
    expect(directEditor.allowedTools).not.toContain(
      'mcp__matos_asset__evolution_context',
    )
    expect(directEditor.allowedTools).not.toContain(
      'mcp__matos_asset__evolution_request',
    )
    expect(directEditor.allowedTools).toContain('Read')
    expect(directEditor.allowedTools).toContain('Edit')
    const directEditorMcpConfig = JSON.parse(directEditor.mcpConfigJson[0] ?? '{}')
    expect(
      directEditorMcpConfig.mcpServers?.matos_asset?.env
        ?.MATOS_ENABLE_EVOLUTION_TOOLS,
    ).toBeUndefined()

    const experienceRefiner = await composeMatOSRoleRuntime(
      registry,
      'role:user-feedback-critic',
      {
        projectCwd: root,
      },
    )
    expect(experienceRefiner.allowedTools).not.toContain(
      'mcp__matos_asset__evolution_context',
    )
    expect(experienceRefiner.agents['asset-optimizer']).toBeUndefined()
    expect(experienceRefiner.agents['benchmark-builder']).toBeUndefined()

    const compute = await composeMatOSRoleRuntime(registry, 'role:compute', {
      projectCwd: root,
    })
    expect(compute.agents['matos-evolver']).toBeUndefined()
    expect(compute.agents['asset-optimizer']).toBeUndefined()
    expect(compute.agents.compute?.tools).not.toContain(
      'mcp__matos_asset__evolution_context',
    )
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('materializes nested skill assets with collision-safe skill names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-nested-skills-'))
    const configDir = join(root, '.matos')
    const assetsDir = join(configDir, 'assets')
    const roleDir = join(assetsDir, 'roles', 'planner')
    const bandsSkillDir = join(
      assetsDir,
      'skills',
      'electronic-structure',
      'vasp-bands',
    )
    const workflowSkillDir = join(
      assetsDir,
      'skills',
      'workflow',
      'vasp-bands',
    )
    const meltingSkillDir = join(
      assetsDir,
      'skills',
      'phase-transition',
      'melting-point-coexistence',
    )

    await mkdir(roleDir, { recursive: true })
    await mkdir(bandsSkillDir, { recursive: true })
    await mkdir(workflowSkillDir, { recursive: true })
    await mkdir(meltingSkillDir, { recursive: true })
    await mkdir(join(meltingSkillDir, 'references'), { recursive: true })
    await writeJson(join(configDir, 'matos.json'), {
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
      mounts: {
        skills: [
          'skill:electronic-structure/vasp-bands',
          'skill:workflow/vasp-bands',
          'skill:phase-transition/melting-point-coexistence',
        ],
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Plan with mounted skills.\n')
    await writeJson(join(bandsSkillDir, 'asset.json'), {
      id: 'electronic-structure/vasp-bands',
      type: 'skill',
      name: 'VASP Bands',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(bandsSkillDir, 'SKILL.md'), '# VASP Bands\n')
    await writeJson(join(workflowSkillDir, 'asset.json'), {
      id: 'workflow/vasp-bands',
      type: 'skill',
      name: 'Workflow VASP Bands',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(workflowSkillDir, 'SKILL.md'), '# Workflow VASP Bands\n')
    await writeJson(join(meltingSkillDir, 'asset.json'), {
      id: 'phase-transition/melting-point-coexistence',
      type: 'skill',
      name: 'Melting Point Coexistence',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(
      join(meltingSkillDir, 'SKILL.md'),
      '# Melting Point Coexistence\n',
    )
    await writeFile(
      join(meltingSkillDir, 'references', 'example.md'),
      'Nested reference content.\n',
    )

    const invocation = await buildMatOSRunInvocation(
      ['--role', 'role:planner', 'profile only', '--max-turns', '1'],
      root,
    )

    expect(invocation.projection?.agents.planner?.skills).toEqual([
      'electronic-structure__vasp-bands',
      'workflow__vasp-bands',
      'phase-transition__melting-point-coexistence',
    ])
    expect(invocation.projection?.allowedTools).toContain('Skill')
    expect(invocation.projection?.appendSystemPrompt.join('\n')).toContain(
      'melting-point-coexistence -> phase-transition__melting-point-coexistence',
    )
    expect(invocation.projection?.appendSystemPrompt.join('\n')).toContain(
      'Only invoke Skill with a name explicitly listed above',
    )

    const addDirIndex = invocation.agentArgs.indexOf('--add-dir')
    expect(addDirIndex).toBeGreaterThanOrEqual(0)
    const skillRoot = invocation.agentArgs[addDirIndex + 1] ?? ''
    await expect(
      readFile(
        join(
          skillRoot,
          '.matos',
          'skills',
          'electronic-structure__vasp-bands',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('# VASP Bands')
    await expect(
      readFile(
        join(skillRoot, '.matos', 'skills', 'workflow__vasp-bands', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# Workflow VASP Bands')
    await expect(
      readFile(
        join(
          skillRoot,
          '.matos',
          'skills',
          'phase-transition__melting-point-coexistence',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('# Melting Point Coexistence')
    await expect(
      readFile(
        join(skillRoot, '.matos', 'skills', 'melting-point-coexistence', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# Melting Point Coexistence')
    await expect(
      readFile(
        join(
          skillRoot,
          '.matos',
          'skills',
          'phase-transition__melting-point-coexistence',
          'references',
          'example.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('Nested reference content.')
    await expect(
      readFile(
        join(
          skillRoot,
          '.matos',
          'skills',
          'melting-point-coexistence',
          'references',
          'example.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('Nested reference content.')
    await expect(
      readFile(join(skillRoot, '.matos', 'skills', 'vasp-bands', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow()
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)

  test('exposes nested child skills from a mounted parent skill without preloading them all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-parent-skills-'))
    const configDir = join(root, '.matos')
    const assetsDir = join(configDir, 'assets')
    const roleDir = join(assetsDir, 'roles', 'planner')
    const parentSkillDir = join(assetsDir, 'skills', 'phase-transition')
    const childSkillDir = join(parentSkillDir, 'melting-point-coexistence')

    await mkdir(roleDir, { recursive: true })
    await mkdir(childSkillDir, { recursive: true })
    await writeJson(join(configDir, 'matos.json'), {
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
      mounts: {
        skills: ['skill:phase-transition'],
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Plan phase transitions.\n')
    await writeJson(join(parentSkillDir, 'asset.json'), {
      id: 'phase-transition',
      type: 'skill',
      name: 'Phase Transition',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(parentSkillDir, 'SKILL.md'), '# Phase Transition\n')
    await writeJson(join(childSkillDir, 'asset.json'), {
      id: 'phase-transition/melting-point-coexistence',
      type: 'skill',
      name: 'Melting Point Coexistence',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(
      join(childSkillDir, 'SKILL.md'),
      '# Melting Point Coexistence\n',
    )

    const invocation = await buildMatOSRunInvocation(
      ['--role', 'role:planner', 'profile only', '--max-turns', '1'],
      root,
    )

    expect(invocation.projection?.agents.planner?.skills).toEqual([
      'phase-transition',
    ])
    expect(invocation.projection?.appendSystemPrompt.join('\n')).toContain(
      'phase-transition__melting-point-coexistence',
    )
    expect(invocation.projection?.appendSystemPrompt.join('\n')).toContain(
      'melting-point-coexistence -> phase-transition__melting-point-coexistence',
    )

    const addDirIndex = invocation.agentArgs.indexOf('--add-dir')
    expect(addDirIndex).toBeGreaterThanOrEqual(0)
    const skillRoot = invocation.agentArgs[addDirIndex + 1] ?? ''
    await expect(
      readFile(
        join(
          skillRoot,
          '.matos',
          'skills',
          'phase-transition__melting-point-coexistence',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('# Melting Point Coexistence')
    await expect(
      readFile(
        join(skillRoot, '.matos', 'skills', 'melting-point-coexistence', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# Melting Point Coexistence')
  }, RUNTIME_COMPOSITION_REAL_ASSET_TIMEOUT_MS)
})

test('restricts workflow MCP access when a role mounts no workflows', async () => {
  const role: MatOSAsset = {
    id: 'workflow-empty-role',
    type: 'role',
    name: 'Workflow Empty Role',
    version: '1.0.0',
    description: 'role without workflow mounts',
    canonicalKey: 'role:workflow-empty-role@1.0.0',
    relativePath: 'roles/workflow-empty-role',
    absolutePath: '/assets/roles/workflow-empty-role',
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: '/assets/roles/workflow-empty-role/asset.json',
    manifestDir: '/assets/roles/workflow-empty-role',
    source: 'pack',
    sourcePath: '/assets',
    packId: 'test',
    packName: 'test',
    packVersion: '1.0.0',
    tags: [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: { workflowFacadeTools: true },
    lifecycle: { status: 'enabled' },
    metadata: {},
  }
  const registry = buildMatOSAssetRegistry([role])
  const runtime = await composeMatOSRoleRuntime(registry, role.canonicalKey)
  const config = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')
  expect(config.mcpServers?.matos_asset?.env).toMatchObject({
    MATOS_WORKFLOW_ACCESS_MODE: 'role-mounted',
    MATOS_ALLOWED_WORKFLOW_REFS: '[]',
  })
})
