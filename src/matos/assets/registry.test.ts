import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { loadMatOSAssets } from './loadAssets.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetSubgraph,
  writeMatOSAssetIndex,
} from './registry.js'
import {
  compareMatOSAssetStrings,
  compareMatOSAssetVersions,
  parseMatOSAssetReference,
  toMatOSAssetKey,
} from './refs.js'
import { validateMatOSAssets } from './validateAssets.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS asset registry', () => {
  test('parses canonical typed references and keys', () => {
    expect(parseMatOSAssetReference('knowledge:matbench@0.1.0')).toEqual({
      type: 'knowledge',
      id: 'matbench',
      version: '0.1.0',
      raw: 'knowledge:matbench@0.1.0',
    })
    expect(parseMatOSAssetReference('tool:Read')).toEqual({
      type: 'tool',
      id: 'Read',
      version: undefined,
      raw: 'tool:Read',
    })
    expect(toMatOSAssetKey('role', 'materials-planner', '0.1.0')).toBe(
      'role:materials-planner@0.1.0',
    )
  })

  test('orders prerelease versions below their release', () => {
    expect(compareMatOSAssetVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0)
    expect(compareMatOSAssetVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0)
    expect(compareMatOSAssetVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(
      compareMatOSAssetVersions('1.0.0-alpha.1', '1.0.0-alpha.2'),
    ).toBeLessThan(0)
    expect(compareMatOSAssetVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareMatOSAssetVersions('1.0.0', '1.0.0')).toBe(0)
  })

  test('winner-selection ordering is deterministic and locale-independent', async () => {
    // Code-unit order, not ICU collation: uppercase before lowercase, and the
    // \0 field separators used by registry sort keys must not be ignorable
    // (localeCompare treats them as such, collapsing distinct sort keys).
    expect(compareMatOSAssetStrings('B', 'a')).toBeLessThan(0)
    expect(compareMatOSAssetStrings('a\u0000b', 'ab')).not.toBe(0)
    expect(compareMatOSAssetStrings('same', 'same')).toBe(0)

    // Locales genuinely disagree about pairs like 'ö' vs 'z' (Swedish sorts
    // ö after z, English before). The registry comparator must give one fixed
    // answer that matches neither collator by construction — proving it does
    // not consult any locale.
    const en = new Intl.Collator('en').compare('ö', 'z')
    const sv = new Intl.Collator('sv').compare('ö', 'z')
    expect(en).toBeLessThan(0)
    expect(sv).toBeGreaterThan(0)
    expect(compareMatOSAssetStrings('ö', 'z')).toBeGreaterThan(0)

    // Semver compares prerelease identifiers in ASCII order: 'Beta' < 'alpha'
    // by code units. ICU collation would flip this and change which version
    // an unversioned reference resolves to depending on the process locale.
    expect(
      compareMatOSAssetVersions('1.0.0-Beta', '1.0.0-alpha'),
    ).toBeLessThan(0)

    const root = await mkdtemp(join(tmpdir(), 'matos-registry-locale-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    for (const variant of [
      { dir: 'skill-upper', version: '1.0.0-Beta', name: 'Upper' },
      { dir: 'skill-lower', version: '1.0.0-alpha', name: 'Lower' },
    ]) {
      const dir = join(root, '.matos', 'assets', variant.dir)
      await mkdir(dir, { recursive: true })
      await writeJson(join(dir, 'asset.json'), {
        id: 'locale-probe',
        type: 'skill',
        name: variant.name,
        version: variant.version,
        path: '.',
      })
    }
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    // ASCII order: 'Beta' < 'alpha', so 1.0.0-alpha is the newest prerelease
    // in every locale.
    expect(registry.resolve('skill:locale-probe')?.version).toBe('1.0.0-alpha')
  })

  test('resolves bare id and alias references to the latest version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-latest-'))
    const oldDir = join(root, '.matos', 'assets', 'skills', 'foo-old')
    const newDir = join(root, '.matos', 'assets', 'skills', 'foo-new')
    const prereleaseDir = join(root, '.matos', 'assets', 'skills', 'foo-rc')
    await mkdir(oldDir, { recursive: true })
    await mkdir(newDir, { recursive: true })
    await mkdir(prereleaseDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(oldDir, 'asset.json'), {
      id: 'foo',
      type: 'skill',
      name: 'Foo Old',
      version: '0.1.0',
      path: '.',
    })
    await writeJson(join(newDir, 'asset.json'), {
      id: 'foo',
      type: 'skill',
      name: 'Foo New',
      version: '0.2.0',
      path: '.',
    })
    await writeJson(join(prereleaseDir, 'asset.json'), {
      id: 'foo',
      type: 'skill',
      name: 'Foo RC',
      version: '0.2.0-rc.1',
      path: '.',
    })

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('foo')?.version).toBe('0.2.0')
    expect(registry.resolve('skill:foo')?.version).toBe('0.2.0')
    expect(registry.resolve('skill:foo@0.1.0')?.version).toBe('0.1.0')
    expect(registry.resolve('skill:foo@0.2')?.version).toBe('0.2.0')
    expect(registry.resolve('foo@0.2')?.version).toBe('0.2.0')
    expect(registry.resolve('foo@0.2.0-rc.1')?.version).toBe('0.2.0-rc.1')
  })

  test('resolves references independently of asset input order', async () => {
    // Unversioned refs and exact-key collisions must resolve to the same
    // winner regardless of the order assets arrive from discovery: version
    // precedence has to be a function of the asset set, not of load order.
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-order-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const variants = [
      { dir: 'pack-a', version: '1.0.0', name: 'Dup A' },
      { dir: 'pack-b', version: '1.1.0', name: 'Dup B' },
      // Same canonical key as pack-a's asset, different content/name.
      { dir: 'pack-c', version: '1.0.0', name: 'Dup C' },
    ]
    for (const variant of variants) {
      const dir = join(root, '.matos', 'assets', variant.dir, 'roles', 'dup')
      await mkdir(dir, { recursive: true })
      await writeJson(join(dir, 'asset.json'), {
        id: 'dup',
        type: 'role',
        name: variant.name,
        version: variant.version,
        path: '.',
      })
    }

    const assets = await loadMatOSAssets(root)
    const forward = buildMatOSAssetRegistry(assets)
    const reversed = buildMatOSAssetRegistry([...assets].reverse())

    for (const reference of ['role:dup', 'dup', 'role:dup@1.0.0', 'role:dup@1.1.0']) {
      expect(reversed.resolve(reference)?.manifestPath).toBe(
        forward.resolve(reference)?.manifestPath,
      )
    }
    expect(forward.resolve('role:dup')?.version).toBe('1.1.0')
    expect(forward.resolve('role:dup@1.0.0')).toBeDefined()
  })

  test('loads pack assets and single mounted raw files with role mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-'))
    const packRoot = join(root, '.matos', 'assets', 'packs', 'core')
    const roleDir = join(packRoot, 'roles', 'planner')
    const knowledgeDir = join(packRoot, 'knowledges', 'matbench')
    const skillDir = join(packRoot, 'skills', 'planner')
    const mountedPaper = join(root, 'paper.md')

    await mkdir(roleDir, { recursive: true })
    await mkdir(knowledgeDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })
    await writeFile(mountedPaper, '# Paper\n\nMounted paper summary.\n', 'utf8')
    await writeJson(join(packRoot, 'matos.pack.json'), {
      id: 'core',
      version: '0.1.0',
      name: 'Core Materials Pack',
    })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetMounts: [
        {
          id: 'paper-abc',
          type: 'knowledge',
          version: '0.1.0',
          path: mountedPaper,
          name: 'Paper ABC',
          description: 'Mounted paper',
        },
      ],
    })

    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
      dependencies: ['skill:planner'],
      mounts: {
        knowledge: ['knowledge:matbench', 'knowledge:paper-abc'],
        skills: ['skill:planner'],
        tools: ['tool:Read', 'Bash'],
      },
      runtime: {
        model: 'inherit',
        permissionMode: 'bypassPermissions',
        maxTurns: 2,
      },
      permissions: {
        tools: ['Read', 'Bash'],
        assets: ['knowledge:*'],
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')
    await writeJson(join(knowledgeDir, 'asset.json'), {
      id: 'matbench',
      type: 'knowledge',
      name: 'Matbench',
      version: '0.1.0',
      entry: 'README.md',
      metadata: {
        summary: 'Benchmark datasets for materials ML.',
      },
    })
    await writeFile(join(knowledgeDir, 'README.md'), 'Matbench details.\n')
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planner',
      type: 'skill',
      name: 'Planner Skill',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planner Skill\n')

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)

    expect(registry.assetsByKey.has('role:planner@0.1.0')).toBe(true)
    expect(registry.assetsByKey.has('knowledge:paper-abc@0.1.0')).toBe(true)
    expect(registry.assetsByKey.get('role:planner@0.1.0')?.packId).toBe('core')
    expect(registry.assetsByKey.get('role:planner@0.1.0')?.entryRelativePath).toBe(
      'prompt.md',
    )
    expect(
      registry.assetsByKey.get('role:planner@0.1.0')?.mounts.knowledge,
    ).toEqual(['knowledge:matbench', 'knowledge:paper-abc'])
    expect(
      registry.resolve('knowledge:matbench')?.canonicalKey,
    ).toBe('knowledge:matbench@0.1.0')
    expect(
      getMatOSAssetSubgraph(registry, 'role:planner').map(asset => asset.canonicalKey),
    ).toEqual([
      'role:planner@0.1.0',
      'skill:planner@0.1.0',
      'knowledge:matbench@0.1.0',
      'knowledge:paper-abc@0.1.0',
    ])

    const validation = await validateMatOSAssets(assets)
    expect(validation.ok).toBe(true)
  })

  test('loads runtime assets and includes role runtime profile references in graphs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-asset-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'compute')
    const runtimeDir = join(root, '.matos', 'assets', 'runtimes', 'lite')
    await mkdir(roleDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '0.1.0',
      runtime: {
        profile: 'runtime:custom-local',
      },
    })
    await writeJson(join(runtimeDir, 'asset.json'), {
      id: 'custom-local',
      type: 'runtime',
      name: 'Custom Local',
      version: '0.1.1',
      runtime: {
        engine: 'local',
        workdir: '/workspace/group',
      },
    })

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)

    expect(registry.resolve('runtime:custom-local')?.canonicalKey).toBe('runtime:custom-local@0.1.1')
    expect(
      getMatOSAssetSubgraph(registry, 'role:compute').map(
        asset => asset.canonicalKey,
      ),
    ).toEqual([
      'role:compute@0.1.0',
      'runtime:custom-local@0.1.1',
    ])
  })

  test('validates missing runtime profile references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-missing-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'compute')
    await mkdir(roleDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '0.1.0',
      runtime: {
        profile: 'runtime:missing-runtime',
      },
    })

    const validation = await validateMatOSAssets(await loadMatOSAssets(root))

    expect(validation.errors.map(error => error.code)).toContain(
      'missing_dependency',
    )
    expect(
      validation.errors.some(error =>
        error.message.includes('runtime:missing-runtime'),
      ),
    ).toBe(true)
  })

  test('validates missing skill toolReferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-toolref-missing-'))
    const skillDir = join(root, '.matos', 'assets', 'skills', 'bands')
    await mkdir(skillDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'bands',
      type: 'skill',
      name: 'Bands',
      version: '0.1.0',
      metadata: {
        toolReferences: ['tool:missing-native-tool'],
      },
    })

    const validation = await validateMatOSAssets(await loadMatOSAssets(root))

    expect(validation.ok).toBe(false)
    expect(
      validation.errors.some(
        error =>
          error.code === 'missing_dependency' &&
          error.message.includes('tool:missing-native-tool'),
      ),
    ).toBe(true)
  })

  test('validates duplicate type id versions and missing role mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-invalid-'))
    const first = join(root, '.matos', 'assets', 'roles', 'planner-a')
    const second = join(root, '.matos', 'assets', 'roles', 'planner-b')
    const skill = join(root, '.matos', 'assets', 'skills', 'planner')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await mkdir(skill, { recursive: true })

    for (const dir of [first, second]) {
      await writeJson(join(dir, 'asset.json'), {
        id: 'planner',
        type: 'role',
        name: 'Planner',
        version: '0.1.0',
        path: '.',
        mounts: {
          knowledge: ['knowledge:missing'],
        },
      })
    }
    await writeJson(join(skill, 'asset.json'), {
      id: 'planner',
      type: 'skill',
      name: 'Same ID Different Type',
      version: '0.1.0',
      path: '.',
    })

    const validation = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(validation.ok).toBe(false)
    expect(validation.errors.map(error => error.code)).toContain(
      'duplicate_asset',
    )
    expect(validation.errors.map(error => error.code)).toContain(
      'missing_mount',
    )
    expect(
      validation.errors.some(
        error =>
          error.code === 'duplicate_asset' &&
          error.assetKey === 'role:planner@0.1.0',
      ),
    ).toBe(true)
  })

  test('allows cyclic role delegation while still validating mounted role refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-role-delegation-cycle-'))
    const planner = join(root, '.matos', 'assets', 'roles', 'planner')
    const critic = join(root, '.matos', 'assets', 'roles', 'critic')
    await mkdir(planner, { recursive: true })
    await mkdir(critic, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(planner, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      path: '.',
      dependencies: ['role:critic'],
      mounts: { roles: ['role:critic'] },
    })
    await writeJson(join(critic, 'asset.json'), {
      id: 'critic',
      type: 'role',
      name: 'Critic',
      version: '0.1.0',
      path: '.',
      dependencies: ['role:planner'],
      mounts: { roles: ['role:planner'] },
    })

    const validation = await validateMatOSAssets(await loadMatOSAssets(root))

    expect(validation.ok).toBe(true)
  })

  test('writes a deterministic asset index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-index-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    await mkdir(roleDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      path: '.',
    })

    const indexPath = await writeMatOSAssetIndex(root)
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      assets: Record<string, unknown>
      aliases: Record<string, string>
    }

    expect(Object.keys(index.assets)).toEqual([
      'role:planner@0.1.0',
      'runtime:local@1.0.0',
    ])
    expect(index.aliases['role:planner']).toBe('role:planner@0.1.0')
  })

  test('deprecated assets leave the active runtime registry like disabled ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-deprecated-'))
    const activeDir = join(root, '.matos', 'assets', 'skills', 'active')
    const retiredDir = join(root, '.matos', 'assets', 'skills', 'retired')
    const retiredExpDir = join(root, '.matos', 'assets', 'experiences', 'old-lesson')
    await mkdir(activeDir, { recursive: true })
    await mkdir(retiredDir, { recursive: true })
    await mkdir(retiredExpDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(activeDir, 'asset.json'), {
      id: 'active',
      type: 'skill',
      name: 'Active Skill',
      version: '0.1.0',
      path: '.',
    })
    await writeJson(join(retiredDir, 'asset.json'), {
      id: 'retired',
      type: 'skill',
      name: 'Retired Skill',
      version: '0.1.0',
      path: '.',
      lifecycle: { status: 'deprecated', reason: 'superseded' },
    })
    await writeJson(join(retiredExpDir, 'asset.json'), {
      id: 'old-lesson',
      type: 'experience',
      name: 'Old Lesson',
      version: '0.1.0',
      path: '.',
      lifecycle: { status: 'deprecated' },
    })

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    expect(registry.resolve('skill:active')).toBeDefined()
    expect(registry.resolve('skill:retired')).toBeUndefined()
    expect(registry.resolve('experience:old-lesson')).toBeUndefined()

    const withRetired = buildMatOSAssetRegistry(assets, { includeDisabled: true })
    expect(withRetired.resolve('skill:retired')).toBeDefined()
  })
})

describe('declared overlays at equal precedence', () => {
  // The direct editor forks a bundled asset into a project as the same
  // type, id and version with metadata.overlayOf; neither copy carries a
  // scope, so they tie on precedence.
  async function forkedProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'matos-registry-overlay-fork-'))
    const bundled = join(root, 'bundled', 'skills', 'answer-finalization')
    const fork = join(root, '.matos', 'assets', 'skills', 'answer-finalization')
    await mkdir(bundled, { recursive: true })
    await mkdir(fork, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets', '../bundled'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(bundled, 'asset.json'), {
      id: 'answer-finalization',
      type: 'skill',
      name: 'Answer finalization',
      version: '0.1.1',
      entry: 'SKILL.md',
    })
    await writeFile(join(bundled, 'SKILL.md'), '# Bundled\n', 'utf8')
    await writeJson(join(fork, 'asset.json'), {
      id: 'answer-finalization',
      type: 'skill',
      name: 'Answer finalization',
      version: '0.1.1',
      entry: 'SKILL.md',
      metadata: { overlayOf: 'skill:answer-finalization@0.1.1' },
    })
    await writeFile(join(fork, 'SKILL.md'), '# Project fork\n', 'utf8')
    return root
  }

  test('the fork validates and wins resolution in either load order', async () => {
    const root = await forkedProject()
    const assets = await loadMatOSAssets(root)
    expect(assets.filter(asset => asset.id === 'answer-finalization')).toHaveLength(2)

    const validation = await validateMatOSAssets(assets)
    expect(validation.errors.filter(error => error.code === 'duplicate_asset')).toEqual([])
    for (const ordered of [assets, [...assets].reverse()]) {
      const resolved = buildMatOSAssetRegistry(ordered).resolve('skill:answer-finalization')
      expect(resolved?.metadata.overlayOf).toBe('skill:answer-finalization@0.1.1')
    }
  })

  test('two copies of the same key without a declared overlay stay a duplicate', async () => {
    const root = await forkedProject()
    await writeJson(join(root, '.matos', 'assets', 'skills', 'answer-finalization', 'asset.json'), {
      id: 'answer-finalization',
      type: 'skill',
      name: 'Answer finalization',
      version: '0.1.1',
      entry: 'SKILL.md',
    })
    const validation = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(validation.errors.filter(error => error.code === 'duplicate_asset').length).toBeGreaterThan(0)
  })
})
