import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'bun:test'
import { matOSGitProcessEnv } from '../assets/gitProcessEnv.js'
import { materializeMatOSAssetSource, resolveMatOSGitSourceToken } from '../assets/sourceAdapters.js'
import { readMatOSProjectConfig, writeMatOSProjectConfig, type MatOSGitAssetSourceConfig } from '../project.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { commitAcceptedDirectEditorGitAssetSources, restoreDirectEditorAcceptedSourceState } from './directAssetEditorSourceAcceptance.js'

const execFileAsync = promisify(execFile)
const git = async (cwd: string, args: string[]) => String((await execFileAsync('git', args, {
  cwd, env: matOSGitProcessEnv(), timeout: 15_000,
})).stdout).trim()

test('publication and rollback preserve untouched dirty sources and concurrent project config', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-source-publication-' })
  const sources: MatOSGitAssetSourceConfig[] = []
  for (const id of ['first', 'second']) {
    const repo = join(cwd, `remote-${id}`)
    const asset = join(repo, 'packs', id, 'knowledge', id)
    await mkdir(asset, { recursive: true })
    await writeFile(join(repo, 'packs', id, 'matos.pack.json'), JSON.stringify({ id, name: id, version: '1.0.0' }))
    await writeFile(join(asset, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id, name: id, version: '1.0.0', entry: 'README.md' }))
    await writeFile(join(asset, 'README.md'), 'Initial accepted content.\n')
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['add', '.'])
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'seed'])
    const commit = await git(repo, ['rev-parse', 'HEAD'])
    const ref = `accepted/${id}/canary`
    await git(repo, ['branch', ref])
    sources.push({ type: 'git', id, repo, ref: 'main', scope: 'user', scopeRef: 'user:alice', provider: 'gitea',
      runtimeRef: { mode: 'accepted-ref', ref: `refs/heads/${ref}`, commit } })
  }
  await writeMatOSProjectConfig(cwd, { version: 1, assetRoots: [], includeDefaultAssetRoots: false, assetSources: sources })
  const first = await materializeMatOSAssetSource(cwd, sources[0]!)
  const second = await materializeMatOSAssetSource(cwd, sources[1]!)
  const dirty = join(second, 'packs/second/knowledge/second/asset.json')
  await writeFile(dirty, '{unfinished manual edit')
  const changed = join(first, 'packs/first/knowledge/first/README.md')
  await writeFile(changed, 'A learned unit correction.\n')
  const before = await readMatOSProjectConfig(cwd)
  const changes = [relative(cwd, changed)]
  const published = await commitAcceptedDirectEditorGitAssetSources({ cwd, scope: 'user', scopeRef: 'user:alice',
    runId: 'isolation', summary: 'Unit correction', changedPaths: changes,
    onAcceptedRefPushed: async () => {
      await writeMatOSProjectConfig(cwd, { ...await readMatOSProjectConfig(cwd), defaultRuntimeProfile: 'concurrent-profile' })
    },
  })
  expect(published.sourceCommitErrors).toBeUndefined()
  expect(published.sourceAcceptance).toEqual([expect.objectContaining({ sourceId: 'first', acceptedBranch: 'accepted/first/canary', ok: true })])
  expect(await readFile(dirty, 'utf8')).toBe('{unfinished manual edit')
  expect((await readMatOSProjectConfig(cwd)).defaultRuntimeProfile).toBe('concurrent-profile')
  expect(await restoreDirectEditorAcceptedSourceState({ cwd, scope: 'user', scopeRef: 'user:alice', config: before,
    pushedSourceIds: new Set(published.acceptedRefPushedSourceIds), pushedSourceCommits: new Map(Object.entries(published.acceptedRefPushedCommits ?? {})),
    changedPaths: changes,
  })).toEqual({ ok: true })
  expect(await readFile(dirty, 'utf8')).toBe('{unfinished manual edit')
  expect((await readMatOSProjectConfig(cwd)).defaultRuntimeProfile).toBe('concurrent-profile')
}, 90_000)

test('generic repository sources never select ambient Gitea credentials', () => {
  const prior = process.env.MATOS_GITEA_TOKEN
  process.env.MATOS_GITEA_TOKEN = 'operator-fixture'
  try {
    expect(resolveMatOSGitSourceToken(undefined, { type: 'git', id: 'external', repo: 'https://external.example/repo.git' })).toBeUndefined()
    expect(resolveMatOSGitSourceToken('explicit-fixture', { type: 'git', id: 'external', repo: 'https://external.example/repo.git' })).toBe('explicit-fixture')
  } finally {
    if (prior === undefined) delete process.env.MATOS_GITEA_TOKEN
    else process.env.MATOS_GITEA_TOKEN = prior
  }
})
