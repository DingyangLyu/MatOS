import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeMatOSProjectConfig, type MatOSGitAssetSourceConfig } from '../../project.js'
import { acceptMatOSGiteaAssetSourceCommit } from '../giteaAcceptance.js'
import { loadMatOSAssetsFromRoot } from '../loadAssets.js'
import { validateMatOSAssets } from '../validateAssets.js'
import { matOSGitAssetSourceCheckoutRoot } from '../sourceAdapters.js'
import { createMatOSGiteaRollbackPullRequest } from '../giteaRollback.js'
import { listMatOSAssetRevisions, showMatOSAssetRevision } from './archive.js'
import { backfillMatOSAssetArchive } from './backfill.js'
import { buildMatOSAssetGraphIndex } from '../graph/buildGraphIndex.js'

const exec = promisify(execFile)
test('accepted archives survive GC; path-scoped rollback uses an isolated checkout; backfill preserves uncertain acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-source-archive-'))
  const cwd = join(root, 'workspace')
  const repo = join(root, 'origin')
  const assetPath = 'packs/demo/knowledge/a'
  async function git(args: string[], location = repo) {
    return (await exec('git', args, { cwd: location, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Archive test', GIT_AUTHOR_EMAIL: 'archive@example.test', GIT_COMMITTER_NAME: 'Archive test', GIT_COMMITTER_EMAIL: 'archive@example.test' } })).stdout.trim()
  }
  const validateRoot = async (path: string) => validateMatOSAssets(await loadMatOSAssetsFromRoot(path))
  try {
    await mkdir(cwd, { recursive: true })
    await mkdir(join(repo, assetPath), { recursive: true })
    await writeFile(join(repo, 'packs/demo/matos.pack.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }))
    await writeFile(join(repo, assetPath, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id: 'a', name: 'A', version: '1.0.0', entry: 'KNOWLEDGE.md' }))
    await writeFile(join(repo, assetPath, 'KNOWLEDGE.md'), '# Version one\n')
    await git(['init', '-b', 'main'])
    await git(['add', '.'])
    await git(['commit', '-m', 'Initial accepted asset'])
    const original = await git(['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'sibling.txt'), 'Unrelated work must survive\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'Unaccepted intermediate development'])
    const middle = await git(['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'sibling-two.txt'), 'Second intermediate development\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'Another unaccepted intermediate development'])
    await writeFile(join(repo, assetPath, 'KNOWLEDGE.md'), '# Version two\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'Second accepted asset'])
    const latest = await git(['rev-parse', 'HEAD'])
    let source: MatOSGitAssetSourceConfig = { type: 'git', id: 'user-archive', repo, ref: 'main', scope: 'user', scopeRef: 'user:alice', gitea: { owner: 'matos-users', repo: 'alice-assets' } }
    const configure = () => writeMatOSProjectConfig(cwd, { version: 1, assetRoots: [], includeDefaultAssetRoots: false, assetSources: [source] })
    await configure()
    for (const ref of [original, latest]) {
      const accepted = await acceptMatOSGiteaAssetSourceCommit({ cwd, source, ref, push: true, validateRoot })
      expect(accepted.ok).toBe(true)
      source = { ...source, runtimeRef: accepted.runtimeRef }
      await configure()
    }
    const archive = await listMatOSAssetRevisions({ cwd, assetRef: 'knowledge:a' })
    expect(archive.total).toBe(2)
    expect(archive.revisions.every(item => item.state === 'accepted')).toBe(true)
    expect(archive.revisions.some(item => item.configuredCurrent)).toBe(true)
    const old = archive.revisions.find(item => item.sourceCommit === original)!
    await git(['gc', '--prune=now'])
    expect((await showMatOSAssetRevision({ cwd, revisionId: old.revisionId })).files.find(file => file.path === 'KNOWLEDGE.md')?.content).toBe('# Version one\n')
    const checkout = matOSGitAssetSourceCheckoutRoot(cwd, source)
    await writeFile(join(checkout, 'uncommitted.txt'), 'Keep authoring work\n')
    const preview = await createMatOSGiteaRollbackPullRequest({ cwd, source, apiUrl: 'http://127.0.0.1:1/api/v1', restoreRef: original,
      paths: [assetPath], dryRun: true, expectedTargetCommit: latest, validateRoot })
    expect(preview.action).toBe('preview')
    expect(preview.changedPaths).toEqual([`${assetPath}/KNOWLEDGE.md`])
    expect(await readFile(join(checkout, 'uncommitted.txt'), 'utf8')).toContain('Keep authoring')
    expect(await git(['rev-parse', 'main'])).toBe(latest)
    await expect(createMatOSGiteaRollbackPullRequest({ cwd, source, apiUrl: 'http://127.0.0.1:1/api/v1', restoreRef: original,
      paths: [assetPath], dryRun: true, expectedTargetCommit: original, validateRoot })).rejects.toThrow('stale')
    const backfill = await backfillMatOSAssetArchive({ cwd, limit: 1 })
    expect(backfill.archived.length).toBe(1)
    expect(backfill.hasMore).toBe(true)
    const nextPage = await backfillMatOSAssetArchive({ cwd, limit: 1 })
    expect(nextPage.archived.length).toBe(1)
    expect(nextPage.hasMore).toBe(false)
    expect((await listMatOSAssetRevisions({ cwd })).revisions.find(item => item.sourceCommit === middle)?.state).toBe('git-history')
    expect((await backfillMatOSAssetArchive({ cwd })).archived).toEqual([])
    const requests: Array<{ path: string; body: Record<string, string> }> = []
    const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as Record<string, string>
      requests.push({ path: new URL(request.url).pathname, body })
      return Response.json({ number: 1, state: 'open', html_url: 'http://localhost/pulls/1', head: { ref: body.head }, base: { ref: body.base } }, { status: 201 })
    } })
    try {
      const applied = await createMatOSGiteaRollbackPullRequest({ cwd, source, apiUrl: `http://127.0.0.1:${api.port}/api/v1`,
        restoreRef: original, paths: [assetPath], expectedTargetCommit: latest, validateRoot })
      expect(applied).toMatchObject({ ok: true, action: 'created', pushed: true })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/v1/repos/matos-users/alice-assets/pulls')
      expect(requests[0]?.body.base).toBe('main')
      expect(requests[0]?.body.head).toBe(applied.rollbackBranch)
      expect(await git(['show', `${applied.rollbackBranch}:${assetPath}/KNOWLEDGE.md`])).toBe('# Version one')
      expect(await git(['show', `${applied.rollbackBranch}:sibling.txt`])).toContain('Unrelated work')
      expect(await git(['rev-parse', 'main'])).toBe(latest)
      expect(await git(['rev-parse', 'accepted/user-archive/stable'])).toBe(latest)
      expect(await readFile(join(checkout, 'uncommitted.txt'), 'utf8')).toContain('Keep authoring')
    } finally { api.stop(true) }
    source = { ...source, repo: join(root, 'different-owner') }
    await configure()
    expect((await listMatOSAssetRevisions({ cwd })).total).toBe(0)
    const hiddenGraph = await buildMatOSAssetGraphIndex({ cwd, assets: [], options: { profile: 'full', includeHidden: true } })
    expect(Object.values(hiddenGraph.nodes).some(node => node.kind === 'asset-revision')).toBe(false)
    await expect(showMatOSAssetRevision({ cwd, revisionId: old.revisionId })).rejects.toThrow('source')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 90_000)
