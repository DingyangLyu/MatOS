import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MATOS_GITEA_TOKEN_KEYS, matOSGiteaEnvValueWithProcessFallback } from '../assets/giteaOperatorEnv.js'
import { inspectMatOSGiteaRepositoryAccess, inspectMatOSGiteaGitWriteAccess } from '../assets/giteaClient.js'
import { matOSGitBranchName } from '../assets/giteaAcceptance.js'
import { matOSGitProcessEnv } from '../assets/gitProcessEnv.js'
import { resolveMatOSGitAssetSourceRuntimeRepo, matOSGiteaApiUrlFromSourceRepo } from '../assets/giteaRuntimeTransport.js'
import { readMatOSProjectConfig, writeMatOSProjectConfig } from '../project.js'
import { withMatOSGitAssetSourceLock } from '../assets/sourceAdapters.js'
import { directEditorAssetSourceMatchesRunScope, fastForwardDirectEditorSourceToRemoteAccepted } from './directAssetEditorSourceAcceptance.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'

const execFileAsync = promisify(execFile)
export type EvolutionGiteaPreflightResult = { ok: true; refreshed?: boolean } | {
  ok: false
  code: 'gitea_credentials_missing' | 'gitea_auth_rejected' | 'gitea_identity_mismatch' |
    'gitea_repository_forbidden' | 'gitea_unavailable' | 'gitea_source_invalid' | 'gitea_version_stale'
  sourceId: string
  message: string
}

/** Check publication before spending editor/judge tokens. Remote checks are
 * read-only; optional local accepted-version repair holds the native source lock. */
export async function preflightEvolutionGiteaSources(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  env?: NodeJS.ProcessEnv
  refreshAccepted?: boolean
  checkVersion?: boolean
}): Promise<EvolutionGiteaPreflightResult> {
  let config: Awaited<ReturnType<typeof readMatOSProjectConfig>>
  try { config = await readMatOSProjectConfig(input.cwd, { strict: true }) }
  catch {
    return { ok: false, code: 'gitea_source_invalid', sourceId: 'matos-config',
      message: 'The project asset configuration is unreadable, malformed or unsupported; repair it before evolution.' }
  }
  const policyEnv = { ...input.env, ...(input.scopeRef ? { MATOS_SCOPE_REF: input.scopeRef } : {}) }
  const token = matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS, policyEnv)
  let refreshed = false
  for (const source of config.assetSources ?? []) {
    if (source.type !== 'git' || !directEditorAssetSourceMatchesRunScope({ ...input, source })) continue
    if (source.provider !== 'gitea' && !source.gitea) continue
    const repo = resolveMatOSGitAssetSourceRuntimeRepo({ cwd: input.cwd, source, repo: source.repo })
    if (!/^https?:\/\//i.test(repo)) continue
    const failure = (code: Exclude<EvolutionGiteaPreflightResult, { ok: true }>['code'], message: string): EvolutionGiteaPreflightResult =>
      ({ ok: false, code, sourceId: source.id, message })
    if (!token) return failure('gitea_credentials_missing', 'The scoped Gitea credential is missing or unreadable; repair token passthrough before retrying.')
    try {
      const owner = source.gitea?.owner
      const name = source.gitea?.repo
      let apiUrl: string
      try { apiUrl = matOSGiteaApiUrlFromSourceRepo(repo, source) }
      catch { return failure('gitea_source_invalid', 'Gitea repository URL and source owner/repository metadata do not agree.') }
      const access = await inspectMatOSGiteaRepositoryAccess({ apiUrl, token, owner: owner!, repo: name! })
      if (access.ok === false) return failure(access.code, `Gitea publication preflight failed (HTTP ${access.status}); no asset edit was started.`)
      const writable = await inspectMatOSGiteaGitWriteAccess({ repoUrl: repo, token, username: access.username })
      if (!writable.ok) return failure([401, 403, 404].includes(writable.status) ? 'gitea_repository_forbidden' : 'gitea_unavailable',
        `The scoped credential could not authorize Git publication (HTTP ${writable.status}); no edit was started.`)
      if (input.checkVersion !== false && source.runtimeRef?.mode === 'accepted-ref') {
        if (!source.runtimeRef.commit || !/^[a-f0-9]{40,64}$/i.test(source.runtimeRef.commit)) {
          return failure('gitea_version_stale', 'The accepted runtime version has no verified commit; re-accept the source before starting an edit.')
        }
        const ref = `refs/heads/${matOSGitBranchName(source.runtimeRef.ref)}`
        const result = await execFileAsync('git', ['ls-remote', '--refs', repo, ref], {
          cwd: input.cwd, env: matOSGitProcessEnv({ token, repo }), timeout: 15_000, maxBuffer: 1024 * 1024,
        })
        const commit = String(result.stdout).trim().split(/\s+/)[0]
        if (commit && source.runtimeRef.commit && commit !== source.runtimeRef.commit && input.refreshAccepted) {
          const updated = await withMatOSGitAssetSourceLock(input.cwd, source, async () => {
            const next = await fastForwardDirectEditorSourceToRemoteAccepted({ cwd: input.cwd, source, token })
            if (next.runtimeRef?.mode !== 'accepted-ref' || next.runtimeRef.commit !== commit) return false
            const current = await readMatOSProjectConfig(input.cwd, { strict: true })
            const index = current.assetSources?.findIndex(item => item.id === source.id) ?? -1
            if (index < 0 || JSON.stringify(current.assetSources![index]) !== JSON.stringify(source)) return false
            current.assetSources![index] = next
            await writeMatOSProjectConfig(input.cwd, current)
            return true
          })
          if (updated) { refreshed = true; continue }
        }
        if (!commit || (source.runtimeRef.commit && commit !== source.runtimeRef.commit)) {
          return failure('gitea_version_stale', 'The configured accepted version differs from the remote accepted ref; refresh/reconcile the scoped source before editing.')
        }
      }
    } catch {
      return failure('gitea_unavailable', 'Gitea identity, repository or Git transport could not be verified; keep the evidence and retry after infrastructure recovery.')
    }
  }
  return { ok: true, ...(refreshed ? { refreshed } : {}) }
}
