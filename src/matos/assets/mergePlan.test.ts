import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  applyMatOSAssetMergePlanAutoOnly,
  buildMatOSAssetMergePlan,
} from './mergePlan.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeAsset(input: {
  root: string
  pack: string
  typeDir: string
  id: string
  dirName?: string
  type: string
  version?: string
  name?: string
  entry?: string
  manifest?: Record<string, unknown>
  body?: string
}): Promise<void> {
  const dir = join(
    input.root,
    'packs',
    input.pack,
    input.typeDir,
    input.dirName ?? input.id,
  )
  await mkdir(dir, { recursive: true })
  await writeJson(join(input.root, 'packs', input.pack, 'matos.pack.json'), {
    id: input.pack,
    name: input.pack,
    version: '1.0.0',
  })
  const entry = input.entry ?? 'README.md'
  await writeJson(join(dir, 'asset.json'), {
    id: input.id,
    type: input.type,
    name: input.name ?? input.id,
    version: input.version ?? '1.0.0',
    entry,
    ...(input.manifest ?? {}),
  })
  await writeFile(join(dir, entry), input.body ?? `${input.name ?? input.id}\n`, 'utf8')
}

describe('MatOS personalized asset merge plan', () => {
  test('classifies new upstream assets as auto_add', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-new-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await mkdir(target, { recursive: true })
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'gw-basics',
      name: 'GW Basics',
      body: 'Use GW for quasiparticle corrections.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.auto_add).toBe(1)
    expect(plan.items[0]).toMatchObject({
      action: 'auto_add',
      identityKey: 'skill:gw-basics',
      safeToAutoApply: true,
      requiresUserConfirmation: false,
    })
  })

  test('classifies upstream changes to scoped-specialized assets as llm_user_merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-specialized-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      body: 'Prefer stable public defaults.\n',
    })
    await writeAsset({
      root: target,
      pack: 'alice',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      body: 'Prefer Alice lab HPC queue and local GPU policy.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.llm_user_merge).toBe(1)
    expect(plan.items[0]).toMatchObject({
      action: 'llm_user_merge',
      identityKey: 'role:compute',
      safeToAutoApply: false,
      requiresLlmReview: true,
      requiresUserConfirmation: true,
    })
  })

  test('classifies same-id scoped specializations with different versions as llm_user_merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-version-specialized-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      version: '1.0.0',
      name: 'Compute',
      body: 'Shared compute defaults.\n',
    })
    await writeAsset({
      root: target,
      pack: 'alice',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      version: '1.0.1',
      name: 'Compute',
      body: 'Alice versioned specialization.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.llm_user_merge).toBe(1)
    expect(plan.items[0]).toMatchObject({
      action: 'llm_user_merge',
      identityKey: 'role:compute',
      upstreamRef: 'role:compute@1.0.0',
      targetRef: 'role:compute@1.0.1',
    })
  })

  test('classifies behavior-changing role or tool mounts as manual_review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-sensitive-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      manifest: {
        mounts: {
          tools: ['tool:hpc-submit'],
        },
      },
      body: 'Default role now mounts a submit tool.\n',
    })
    await writeAsset({
      root: target,
      pack: 'alice',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      body: 'Alice compute policy.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.manual_review).toBe(1)
    expect(plan.items[0]).toMatchObject({
      action: 'manual_review',
      identityKey: 'role:compute',
      safeToAutoApply: false,
      requiresUserConfirmation: true,
    })
  })

  test('classifies upstream deletions from a previous upstream root as blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-deleted-'))
    const previousUpstream = join(root, 'previous-upstream')
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await mkdir(upstream, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeAsset({
      root: previousUpstream,
      pack: 'matos-core',
      typeDir: 'tools',
      type: 'tool',
      id: 'legacy-tool',
      name: 'Legacy Tool',
      body: 'Legacy tool instructions.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      previousUpstreamRoot: previousUpstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.blocked).toBe(1)
    expect(plan.items[0]).toMatchObject({
      action: 'blocked',
      identityKey: 'tool:legacy-tool',
      safeToAutoApply: false,
    })
  })

  test('does not auto-add assets inherited from a previous upstream root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-inherited-'))
    const previousUpstream = join(root, 'previous-upstream')
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await mkdir(target, { recursive: true })
    await writeAsset({
      root: previousUpstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'baseline-skill',
      name: 'Baseline Skill',
      body: 'Baseline inherited skill.\n',
    })
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'baseline-skill',
      name: 'Baseline Skill',
      body: 'Baseline inherited skill with upstream edits.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      previousUpstreamRoot: previousUpstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.summary.actions.auto_add).toBe(0)
    expect(plan.items).toEqual([
      expect.objectContaining({
        action: 'no_change',
        identityKey: 'skill:baseline-skill',
        safeToAutoApply: false,
        requiresUserConfirmation: false,
      }),
    ])
  })

  test('keeps multiple versions of the same asset identity in the merge plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-versions-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await mkdir(target, { recursive: true })
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'phase-diagram',
      dirName: 'phase-diagram-v1',
      version: '1.0.0',
      name: 'Phase Diagram',
      body: 'Phase diagram v1.\n',
    })
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'phase-diagram',
      dirName: 'phase-diagram-v2',
      version: '2.0.0',
      name: 'Phase Diagram',
      body: 'Phase diagram v2.\n',
    })

    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    expect(plan.items.map(item => item.upstreamRef).sort()).toEqual([
      'skill:phase-diagram@1.0.0',
      'skill:phase-diagram@2.0.0',
    ])
  })

  test('applies only safe auto_add assets into the scoped target root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-plan-apply-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'skills',
      type: 'skill',
      id: 'gw-basics',
      name: 'GW Basics',
      body: 'Use GW for quasiparticle corrections.\n',
    })
    await writeAsset({
      root: upstream,
      pack: 'matos-core',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      body: 'Shared compute defaults.\n',
    })
    await writeAsset({
      root: target,
      pack: 'alice',
      typeDir: 'roles',
      type: 'role',
      id: 'compute',
      name: 'Compute',
      body: 'Alice local GPU policy.\n',
    })
    const plan = await buildMatOSAssetMergePlan({
      upstreamRoot: upstream,
      targetRoot: target,
      upstreamSourceId: 'core-assets',
      targetSourceId: 'alice-assets',
    })

    const result = await applyMatOSAssetMergePlanAutoOnly({
      upstreamRoot: upstream,
      targetRoot: target,
      plan,
    })

    expect(result.applied).toEqual([
      expect.objectContaining({
        identityKey: 'skill:gw-basics',
        action: 'auto_add',
      }),
    ])
    expect(result.skipped.map(item => item.identityKey)).toContain('role:compute')
    expect(
      await readFile(
        join(target, 'packs', 'matos-core', 'skills', 'gw-basics', 'README.md'),
        'utf8',
      ),
    ).toBe('Use GW for quasiparticle corrections.\n')
    expect(
      JSON.parse(
        await readFile(join(target, 'packs', 'matos-core', 'matos.pack.json'), 'utf8'),
      ),
    ).toMatchObject({
      id: 'matos-core',
      version: '1.0.0',
    })
    expect(
      await readFile(join(target, 'packs', 'alice', 'roles', 'compute', 'README.md'), 'utf8'),
    ).toBe('Alice local GPU policy.\n')
    expect(
      await stat(
        join(target, 'packs', 'matos-core', 'roles', 'compute', 'asset.json'),
      ).catch(() => undefined),
    ).toBeUndefined()
  })
})
