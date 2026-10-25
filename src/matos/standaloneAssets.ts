import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { withMatOSAssetHistoryLock } from './assets/history/lock.js'
import { assertNoSymlinkPathComponent } from './assets/history/policy.js'
import {
  getMatOSConfigPath, getMatOSDir, readMatOSProjectConfig,
  writeMatOSProjectConfig, type MatOSGitAssetSourceConfig,
} from './project.js'

import { standaloneScopeRef } from './standaloneProfile.js'
import { matOSGitProcessEnv } from './assets/gitProcessEnv.js'

const exec = promisify(execFile)

/** A local bare remote keeps the existing accepted-ref/evolution protocol.
 * It holds only this workspace's assets, never the application repository. */
export async function ensureMatOSStandaloneAssets(
  cwd: string,
  options: { scopeRef?: string; env?: Record<string, string | undefined> } = {},
): Promise<MatOSGitAssetSourceConfig> {
  const root = resolve(cwd)
  await assertNoSymlinkPathComponent({ cwd: root, absolutePath: getMatOSConfigPath(root) })
  await mkdir(getMatOSDir(root), { recursive: true })
  return withMatOSAssetHistoryLock({ cwd: root, operation: 'standalone-init', lockKey: 'standalone-init' }, async () => {
    const config = await readMatOSProjectConfig(root, { strict: true })
    const defaultId = basename(root).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'workspace'
    const scopeRef = standaloneScopeRef(options.scopeRef ?? config.standalone?.scopeRef ?? `project:${defaultId}`)
    const scope = scopeRef.split(':')[0] as 'user' | 'team' | 'project'

    const existing = config.assetSources?.find(source => source.type === 'git' && source.scope === scope && source.scopeRef === scopeRef)
    if (existing?.type === 'git') {
      if (config.standalone?.scopeRef !== scopeRef) {
        await writeMatOSProjectConfig(root, { ...config, standalone: { scopeRef } })
      }
      return existing
    }
    const id = `local-${scope}-${createHash('sha256').update(scopeRef).digest('hex').slice(0, 12)}`
    if (config.assetSources?.some(source => source.id === id)) throw new Error(`Asset source id already exists: ${id}`)
    const repo = `./.matos/local-git/${id}.git`
    const bare = resolve(root, repo)
    await assertNoSymlinkPathComponent({ cwd: root, absolutePath: join(bare, 'HEAD') })
    await mkdir(bare, { recursive: true })
    const gitEnv = matOSGitProcessEnv({ repo: bare })
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete gitEnv[key]
    const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root, env: gitEnv, timeout: 30_000, maxBuffer: 1024 * 1024,
    })).stdout.trim()
    await git('init', '--bare', '--initial-branch=main', '--template=', bare)
    let commit = await git('--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/main').catch(() => '')
    if (!commit) {
      if (await git('--git-dir', bare, 'for-each-ref', '--format=%(refname)')) {
        throw new Error('Local asset repository has existing refs but no main branch; repair it before initializing.')
      }
      const empty = join(getMatOSDir(root), `.empty-tree-${randomUUID()}`)
      try {
        await writeFile(empty, '')
        const tree = await git('--git-dir', bare, 'hash-object', '-t', 'tree', '-w', empty)
        commit = await git('--git-dir', bare, '-c', 'user.name=MatOS', '-c', 'user.email=matos@localhost',
          '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Initialize local MatOS assets')
        await git('--git-dir', bare, 'update-ref', 'refs/heads/main', commit)
      } finally { await rm(empty, { force: true }) }
    }
    const accepted = `accepted/${id}/stable`
    // An empty source is valid by construction. All subsequent edits use the
    // normal native validation, semantic judge, publication and rollback.
    const acceptedCommit = await git('--git-dir', bare, 'rev-parse', '--verify', `refs/heads/${accepted}`).catch(() => '')
    if (!acceptedCommit) await git('--git-dir', bare, 'update-ref', `refs/heads/${accepted}`, commit)
    const source: MatOSGitAssetSourceConfig = {
      type: 'git', id, repo, ref: 'main', scope, scopeRef, refresh: 'manual',
      runtimeRef: { mode: 'accepted-ref', ref: accepted, commit: acceptedCommit || commit, acceptedAt: new Date().toISOString() },
    }
    await writeMatOSProjectConfig(root, {
      ...config, standalone: { scopeRef }, includeDefaultAssetRoots: false,
      execution: { ...config.execution, defaultMode: config.execution?.defaultMode ?? 'local' },
      assetRoots: config.assetRoots,
      assetSources: [...(config.assetSources ?? []), source],
    })
    return source
  })
}
