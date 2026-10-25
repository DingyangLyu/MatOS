import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMatOSInit } from './init'
import { readMatOSProjectConfig } from '../project'
import { commitMatOSGitAssetSource, materializeMatOSAssetSource } from '../assets/sourceAdapters'
import { acceptMatOSGiteaAssetSourceCommit, readMatOSGiteaRemoteRefCommit, updateMatOSGiteaAcceptedRefWithLease } from '../assets/giteaAcceptance'
import { loadMatOSAssetsFromRoot } from '../assets/loadAssets'
import { validateMatOSAssets } from '../assets/validateAssets'
import { syncMatOSWorkbenchProjectGroup } from '../workbench/projectGroups'
import { preflightEvolutionGiteaSources } from '../learning/evolutionGiteaPreflight'

test('standalone init provides a portable accepted Git source without Gitea', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-local-init-'))
  let cwd = join(root, 'workspace')
  try {
    const io = () => ({ cwd, stdout: () => {}, stderr: () => {} })
    await runMatOSInit(io(), { standalone: true, scopeRef: 'user:local' })
    const first = await readMatOSProjectConfig(cwd)
    const source = first.assetSources?.find(source => source.type === 'git')
    expect(source?.type).toBe('git')
    if (!source || source.type !== 'git') throw new Error('local source missing')
    expect(source.provider).toBeUndefined()
    expect(source.scopeRef).toBe('user:local')
    expect(source.repo.startsWith('./.matos/')).toBe(true)
    expect(source.runtimeRef?.mode).toBe('accepted-ref')
    expect(first.includeDefaultAssetRoots).toBe(false)
    expect(first.assetRoots.every(root => !root.startsWith('/'))).toBe(true)
    await runMatOSInit(io(), { standalone: true, scopeRef: 'user:local' })
    expect(await readMatOSProjectConfig(cwd)).toEqual(first)
    await materializeMatOSAssetSource(cwd, source)
    const moved = join(root, 'moved')
    await rename(cwd, moved); cwd = moved
    const checkout = await materializeMatOSAssetSource(cwd, source)
    expect(checkout).toContain(cwd)
    const folder = join(checkout, 'knowledges/local-note')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id: 'local-note', name: 'Local note', version: '1.0.0', description: 'Local acceptance check', entry: 'KNOWLEDGE.md' }))
    await writeFile(join(folder, 'KNOWLEDGE.md'), '# Local note\nValidated local asset.\n')
    const candidate = await commitMatOSGitAssetSource(cwd, source, { message: 'Add local note', branch: 'evolution/local-check', push: true })
    expect(candidate.pushed).toBe(true)
    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd, source, ref: candidate.commit, push: true,
      validateRoot: async root => validateMatOSAssets(await loadMatOSAssetsFromRoot(root)),
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error(JSON.stringify(accepted))
    expect(accepted.commit).toBe(candidate.commit)
    if (source.runtimeRef?.mode !== 'accepted-ref') throw new Error('accepted source missing')
    const originalCommit = source.runtimeRef.commit!
    await updateMatOSGiteaAcceptedRefWithLease({
      checkoutRoot: checkout, acceptedBranch: source.runtimeRef.ref,
      targetCommit: originalCommit, expectedRemoteCommit: accepted.commit,
    })
    expect(await readMatOSGiteaRemoteRefCommit({ checkoutRoot: checkout, ref: source.runtimeRef.ref })).toBe(originalCommit)
    expect(await preflightEvolutionGiteaSources({ cwd, scope: 'user', scopeRef: 'user:local' })).toEqual({ ok: true })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)


test('standalone init rejects a redirected .matos directory before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-local-boundary-'))
  try {
    const cwd = join(root, 'project'), outside = join(root, 'outside')
    await mkdir(cwd); await mkdir(outside); await symlink(outside, join(cwd, '.matos'))
    await expect(runMatOSInit({ cwd, stdout: () => {}, stderr: () => {} }, { standalone: true })).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('web project sync provisions its own project-scoped local source', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-local-project-'))
  try {
    await syncMatOSWorkbenchProjectGroup({ cwd, id: 'web-project', name: 'Web project', team: [], env: { MATOS_STANDALONE: '1' } })
    const config = await readMatOSProjectConfig(cwd)
    expect(config.assetSources?.some(source => source.type === 'git' && source.scopeRef === 'project:web-project')).toBe(true)
  } finally { await rm(cwd, { recursive: true, force: true }) }
}, 30000)
