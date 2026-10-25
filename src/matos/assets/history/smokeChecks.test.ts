import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
} from './index.js'
import { matosAssetValidationErrorFingerprint } from './validation.js'

const fixtureRoots: string[] = []

afterEach(async () => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop()
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

type SmokeFixture = {
  root: string
  coreDir: string
  workflowEntry: string
  toolDir: string
  toolEntry: string
  skillEntry: string
}

async function createSmokeFixture(): Promise<SmokeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'matos-smoke-checks-'))
  fixtureRoots.push(root)
  const coreDir = join(root, 'matos-assets', 'packs', 'matos-core')

  const roleDir = join(coreDir, 'roles', 'planner')
  await mkdir(roleDir, { recursive: true })
  await writeJson(join(roleDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'planner',
    type: 'role',
    name: 'Planner',
    version: '0.1.0',
    entry: 'ROLE.md',
    mounts: { skills: ['skill:notes'], knowledge: ['knowledge:guide'] },
  })
  await writeFile(join(roleDir, 'ROLE.md'), '# Planner\n\nPlan the work.\n', 'utf8')

  const skillDir = join(coreDir, 'skills', 'notes')
  await mkdir(skillDir, { recursive: true })
  await writeJson(join(skillDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'notes',
    type: 'skill',
    name: 'Notes',
    version: '0.1.0',
    entry: 'SKILL.md',
  })
  const skillEntry = join(skillDir, 'SKILL.md')
  await writeFile(skillEntry, '# Notes skill\n\nTake notes.\n', 'utf8')

  // Core scope policy only tracks the singular `knowledge` subdir.
  const knowledgeDir = join(coreDir, 'knowledge', 'guide')
  await mkdir(knowledgeDir, { recursive: true })
  await writeJson(join(knowledgeDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'guide',
    type: 'knowledge',
    name: 'Guide',
    version: '0.1.0',
    entry: 'README.md',
  })
  await writeFile(join(knowledgeDir, 'README.md'), 'Guide content.\n', 'utf8')

  const workflowDir = join(coreDir, 'workflows', 'relax')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'relax',
    type: 'workflow',
    name: 'Relax',
    version: '0.1.0',
    entry: 'workflow.json',
  })
  const workflowEntry = join(workflowDir, 'workflow.json')
  await writeJson(workflowEntry, {
    schemaVersion: 1,
    name: 'relax',
    version: '0.1.0',
    nodes: [{ id: 'prepare', type: 'exec', command: 'printf prepare' }],
  })

  const toolDir = join(coreDir, 'tools', 'xrd-parse')
  await mkdir(toolDir, { recursive: true })
  await writeJson(join(toolDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'xrd-parse',
    type: 'tool',
    name: 'XRD Parse',
    version: '0.1.0',
    entry: 'run.py',
    metadata: {
      kind: 'external-tool',
      executor: { entry: 'run.py', runtime: 'python3' },
    },
  })
  const toolEntry = join(toolDir, 'run.py')
  await writeFile(toolEntry, 'print("ok")\n', 'utf8')

  return { root, coreDir, workflowEntry, toolDir, toolEntry, skillEntry }
}

// Core scope policy does not track mcp assets; exercise them on a
// project-scope fixture instead, where all of .matos/assets is in scope.
async function createProjectMcpFixture(): Promise<{
  root: string
  mcpEntry: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-smoke-mcp-'))
  fixtureRoots.push(root)
  const mcpDir = join(root, '.matos', 'assets', 'mcps', 'helper')
  await mkdir(mcpDir, { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(mcpDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'helper',
    type: 'mcp',
    name: 'Helper MCP',
    version: '0.1.0',
    entry: 'mcp.json',
  })
  const mcpEntry = join(mcpDir, 'mcp.json')
  await writeJson(mcpEntry, {
    mcpServers: { helper: { command: 'helper-server' } },
  })
  return { root, mcpEntry }
}

async function snapshotAndValidate(
  root: string,
  gateProfile?: 'structural' | 'smoke' | 'full',
  scope: 'core' | 'project' = 'core',
) {
  const snapshot = await createMatOSAssetHistorySnapshot({
    cwd: root,
    kind: 'manual',
    scope,
  })
  return validateMatOSAssetHistorySnapshot({
    cwd: root,
    snapshotId: snapshot.snapshotId,
    ...(gateProfile ? { gateProfile } : {}),
  })
}

function smokeCodes(validation: { assetValidation: { errors: unknown[] } }): string[] {
  return validation.assetValidation.errors
    .map(error =>
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : '',
    )
    .filter(code => code.startsWith('smoke_'))
}

describe('MatOS asset history smoke checks', () => {
  test('smoke profile passes a healthy fixture and records check coverage', async () => {
    const { root } = await createSmokeFixture()

    const structural = await snapshotAndValidate(root)
    expect(structural.ok).toBe(true)
    expect(structural.gateProfile).toBe('structural')
    expect(structural.smoke).toBeUndefined()
    expect(structural.workflowValidation).toEqual([])

    const smoke = await snapshotAndValidate(root, 'smoke')
    expect(smoke.ok).toBe(true)
    expect(smoke.gateProfile).toBe('smoke')
    expect(smoke.assetValidation.errors).toEqual([])
    expect(smoke.smoke).toMatchObject({
      errorCount: 0,
      checkedByType: {
        role: 1,
        skill: 1,
        knowledge: 1,
        workflow: 1,
        tool: 1,
      },
    })
    expect(smoke.workflowValidation).toEqual([
      { assetKey: 'workflow:relax@0.1.0', ok: true, errors: [] },
    ])
  })

  test('smoke profile catches workflow breakage that structural validation misses', async () => {
    const { root, workflowEntry } = await createSmokeFixture()

    await writeFile(workflowEntry, '{ this is not json\n', 'utf8')
    const unparseable = await snapshotAndValidate(root, 'smoke')
    expect(unparseable.ok).toBe(false)
    expect(smokeCodes(unparseable)).toContain('smoke_workflow_unparseable')
    // Structural-only validation still passes: the entry file exists.
    const structural = await snapshotAndValidate(root)
    expect(structural.ok).toBe(true)

    await writeJson(workflowEntry, {
      schemaVersion: 1,
      name: 'relax',
      version: '0.1.0',
      nodes: [
        { id: 'a', type: 'exec', dependsOn: [], command: 'printf a' },
        { id: 'b', type: 'exec', dependsOn: [], command: 'printf b' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })
    const cyclic = await snapshotAndValidate(root, 'smoke')
    expect(cyclic.ok).toBe(false)
    expect(smokeCodes(cyclic)).toContain('smoke_workflow_invalid')
    expect(cyclic.workflowValidation).toEqual([
      expect.objectContaining({ assetKey: 'workflow:relax@0.1.0', ok: false }),
    ])
  })

  test('smoke profile catches external tool executor breakage', async () => {
    const { root, toolDir, toolEntry } = await createSmokeFixture()

    await rm(toolEntry)
    const missingEntry = await snapshotAndValidate(root, 'smoke')
    expect(missingEntry.ok).toBe(false)
    expect(smokeCodes(missingEntry)).toContain('smoke_tool_entry_missing')

    await writeFile(toolEntry, 'print("ok")\n', 'utf8')
    await writeJson(join(toolDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'xrd-parse',
      type: 'tool',
      name: 'XRD Parse',
      version: '0.1.0',
      entry: 'run.py',
      metadata: {
        kind: 'external-tool',
        executor: { entry: 'run.py', runtime: 'python3' },
        inputSchemaPath: 'schema/input.json',
      },
    })
    const missingSchema = await snapshotAndValidate(root, 'smoke')
    expect(missingSchema.ok).toBe(false)
    expect(smokeCodes(missingSchema)).toContain('smoke_tool_load')
  })

  test('smoke profile flags empty skill entries', async () => {
    const { root, skillEntry } = await createSmokeFixture()

    await writeFile(skillEntry, '   \n', 'utf8')

    const validation = await snapshotAndValidate(root, 'smoke')
    expect(validation.ok).toBe(false)
    expect(smokeCodes(validation)).toContain('smoke_skill_entry_unreadable')
    // Structural-only validation accepts the empty file because it exists.
    const structural = await snapshotAndValidate(root)
    expect(structural.ok).toBe(true)
  })

  test('smoke profile flags broken mcp configs in project scope', async () => {
    const { root, mcpEntry } = await createProjectMcpFixture()

    const healthy = await snapshotAndValidate(root, 'smoke', 'project')
    expect(healthy.ok).toBe(true)
    expect(healthy.smoke).toMatchObject({ checkedByType: { mcp: 1 } })

    await writeFile(mcpEntry, '{ broken json\n', 'utf8')
    const broken = await snapshotAndValidate(root, 'smoke', 'project')
    expect(broken.ok).toBe(false)
    expect(smokeCodes(broken)).toContain('smoke_mcp_config_invalid')

    await writeJson(mcpEntry, { notMcpServers: true })
    const empty = await snapshotAndValidate(root, 'smoke', 'project')
    expect(empty.ok).toBe(false)
    expect(smokeCodes(empty)).toContain('smoke_mcp_config_invalid')

    // Structural-only validation accepts the broken config because it exists.
    const structural = await snapshotAndValidate(root, undefined, 'project')
    expect(structural.ok).toBe(true)
  })

  test('smoke error fingerprints stay stable across snapshot validation roots', async () => {
    const { root, workflowEntry } = await createSmokeFixture()
    await writeFile(workflowEntry, '{ this is not json\n', 'utf8')

    // Two separate validate calls materialize two different temp roots; the
    // differential Gate 1 baseline only works if fingerprints are identical.
    const first = await snapshotAndValidate(root, 'smoke')
    const second = await snapshotAndValidate(root, 'smoke')
    const firstPrints = first.assetValidation.errors
      .map(matosAssetValidationErrorFingerprint)
      .sort()
    const secondPrints = second.assetValidation.errors
      .map(matosAssetValidationErrorFingerprint)
      .sort()
    expect(firstPrints.length).toBeGreaterThan(0)
    expect(firstPrints).toEqual(secondPrints)
    for (const print of firstPrints) {
      expect(print).not.toContain(tmpdir())
    }
  })
})
