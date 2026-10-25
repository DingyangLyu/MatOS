import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { syncGeneratedScopedAssetsToGitea } from '../learning/generatedScopedAssetSync.js'
import { readMatOSProjectConfig } from '../project.js'
import { ensureMatOSStandaloneAssets } from '../standaloneAssets.js'
import { loadMatOSAssets } from './loadAssets.js'

async function publishUserKnowledge(workspace: string, version: string): Promise<void> {
  const staged = join(workspace, '.matos', 'assets', 'generated', 'scopes', 'users', 'local', 'knowledge', 'runbook')
  await mkdir(staged, { recursive: true })
  await writeFile(
    join(staged, 'asset.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'runbook',
      type: 'knowledge',
      name: 'Runbook',
      version,
      entry: 'REFERENCE.md',
      lifecycle: { status: 'enabled' },
    }, null, 2)}\n`,
  )
  await writeFile(join(staged, 'REFERENCE.md'), `# Runbook ${version}\n`)
  const result = await syncGeneratedScopedAssetsToGitea({
    cwd: workspace,
    scope: 'user',
    scopeRef: 'user:local',
    runId: `publish-${version}`,
    env: { MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' },
    parkRuntimeAssetsAsDraft: false,
    generatedAssetDirs: [staged],
  })
  expect(result.ok).toBe(true)
}

async function runbookVersions(project: string): Promise<string[]> {
  return (await loadMatOSAssets(project))
    .filter(asset => asset.type === 'knowledge' && asset.id === 'runbook')
    .map(asset => asset.version)
}

describe('standalone projects and the workspace user source', () => {
  test('a project loads the user assets at the accepted commit without changing its config', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'matos-standalone-workspace-'))
    const project = await mkdtemp(join(tmpdir(), 'matos-standalone-project-'))
    await ensureMatOSStandaloneAssets(workspace, { scopeRef: 'user:local' })
    await ensureMatOSStandaloneAssets(project, { scopeRef: 'project:p1' })
    await publishUserKnowledge(workspace, '0.1.0')

    const saved = process.env.MATOS_STANDALONE_WORKSPACE
    try {
      delete process.env.MATOS_STANDALONE_WORKSPACE
      expect(await runbookVersions(project)).toEqual([])

      process.env.MATOS_STANDALONE_WORKSPACE = workspace
      expect(await runbookVersions(project)).toEqual(['0.1.0'])

      // A newly accepted version is what the next load sees.
      await publishUserKnowledge(workspace, '0.2.0')
      expect(await runbookVersions(project)).toEqual(['0.2.0'])

      const config = await readMatOSProjectConfig(project)
      expect(config.assetSources?.every(source => source.scope === 'project')).toBe(true)
      // The workspace itself is unaffected by its own setting.
      expect(await runbookVersions(workspace)).toEqual(['0.2.0'])
    } finally {
      if (saved === undefined) delete process.env.MATOS_STANDALONE_WORKSPACE
      else process.env.MATOS_STANDALONE_WORKSPACE = saved
    }
  }, 60000)
})
