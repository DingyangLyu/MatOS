import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { matOSProjectAssetRefs, matOSRunAssetRefs } from './projectAssets.js'
import { buildMatOSRoleLaunchInvocation, buildMatOSRunInvocation } from './cli/run.js'

describe('project asset version lifecycle', () => {
  test('applies the same policy to every project-mountable asset type', () => {
    for (const type of ['role', 'skill', 'tool', 'data', 'knowledge', 'workflow', 'mcp', 'plugin']) {
      expect(matOSProjectAssetRefs({ assetRefs: [`${type}:shared-asset@1.0.0`] })).toEqual([`${type}:shared-asset`])
    }
  })

  test('legacy picker selections follow identities, while explicit project pins remain strict', () => {
    const assetRefs = [' skill:procedure@0.1.0 ', 'skill:procedure@0.1.1', 'data:measurements']
    expect(matOSProjectAssetRefs({ assetRefs })).toEqual(['skill:procedure', 'data:measurements'])
    expect(matOSProjectAssetRefs({ assetRefs, assetVersionPolicy: 'pinned' })).toEqual([
      'skill:procedure@0.1.0', 'skill:procedure@0.1.1', 'data:measurements',
    ])
    expect(() => matOSProjectAssetRefs({ assetRefs, assetVersionPolicy: 'typo' })).toThrow('asset version policy')
    expect(matOSRunAssetRefs({ assetRefs }, ['skill:procedure@0.1.0'])).toEqual(['data:measurements', 'skill:procedure@0.1.0'])
  })

  test('both native run transports survive replacement, record exact versions and reject explicit stale pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-version-'))
    const roleDir = join(root, '.matos/assets/roles/version-fixture')
    const skillDir = join(root, '.matos/assets/skills/procedure')
    await mkdir(roleDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })
    // This lifecycle fixture needs only its two local assets. Default sources
    // can trigger unrelated accepted-source fetches/materialization on cold CI.
    await writeFile(join(root, '.matos/matos.json'), JSON.stringify({
      version: 1, includeDefaultAssetRoots: false, assetRoots: [join(root, '.matos/assets')], assetSources: [],
      execution: { runtimeDataDir: join(root, 'runtime') },
    }))
    const metadata = {
      id: 'version-project', name: 'Version project',
      team: [{ roleRef: 'role:version-fixture', memberId: 'agent-version-fixture' }],
      assetRefs: ['skill:procedure@0.1.0'],
    }
    const saveMetadata = (value: unknown) => writeFile(join(root, '.matos/project.json'), JSON.stringify(value))
    const saveSkill = (version: string, status = 'enabled') => writeFile(join(skillDir, 'asset.json'), JSON.stringify({
      id: 'procedure', type: 'skill', name: 'Procedure', version, entry: 'SKILL.md', lifecycle: { status },
    }))
    await saveMetadata(metadata)
    await writeFile(join(roleDir, 'asset.json'), JSON.stringify({
      id: 'version-fixture', type: 'role', name: 'Version fixture', version: '1.0.0', entry: 'prompt.md',
    }))
    await writeFile(join(roleDir, 'prompt.md'), 'Inspect assets.')
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: procedure\ndescription: Procedure\n---\nOriginal procedure.\n')
    await saveSkill('0.1.0')
    // A new fixture fingerprint must not scan or prune the CI-wide cache.
    const previousMaterializationRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'materialization')
    try {
      const initial = await buildMatOSRunInvocation(['inspect'], root)
      expect(initial.materializationDirs?.length).toBeGreaterThan(0)
      expect(initial.materializationDirs?.map(dir => dirname(dir))).toEqual([join(root, 'materialization')])
      expect(initial.selectedAssetKeys).toContain('skill:procedure@0.1.0')

      await saveSkill('0.1.1')
      const next = await buildMatOSRunInvocation(['inspect'], root)
      const print = await buildMatOSRoleLaunchInvocation('version-fixture', root)
      expect(next.selectedAssetKeys).toContain('skill:procedure@0.1.1')
      expect(print.selectedAssetKeys).toContain('skill:procedure@0.1.1')
      expect(next.selectedAssetKeys).not.toContain('skill:procedure@0.1.0')
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: procedure\ndescription: Procedure\n---\nUpdated procedure without a version bump.\n')
      const contentUpdate = await buildMatOSRoleLaunchInvocation('version-fixture', root)
      expect(contentUpdate.selectedAssetKeys).toContain('skill:procedure@0.1.1')
      expect(contentUpdate.materializationDirs).not.toEqual(print.materializationDirs)
      await expect(buildMatOSRunInvocation(['--asset', 'skill:procedure@0.1.0', 'inspect'], root)).rejects.toThrow('current accessible version is skill:procedure@0.1.1')
      await expect(buildMatOSRoleLaunchInvocation('version-fixture', root, [], {
        additionalAssetRefs: ['skill:procedure@0.1.0'],
      })).rejects.toThrow('selected asset not found')

      await saveMetadata({ ...metadata, assetVersionPolicy: 'pinned' })
      await expect(buildMatOSRunInvocation(['inspect'], root)).rejects.toThrow('selected asset not found')
      await saveMetadata({ ...metadata, assetRefs: ['skill:deleted-procedure'] })
      await expect(buildMatOSRunInvocation(['inspect'], root)).rejects.toThrow('selected asset not found')
      await saveMetadata(metadata)
      await saveSkill('0.1.1', 'disabled')
      await expect(buildMatOSRunInvocation(['inspect'], root)).rejects.toThrow(/not found|not enabled/)
    } finally {
      if (previousMaterializationRoot === undefined) delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      else process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousMaterializationRoot
    }
  }, 60_000)
})
