import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MatOSAssetSourceConfig, MatOSProjectConfig } from '../project.js'

type EnvLike = Record<string, string | undefined>

export function matOSGiteaApiUrlFromSourceRepo(repo: string, source: MatOSAssetSourceConfig & { type: 'git' }): string {
  const url = new URL(repo)
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '')
  const suffix = source.gitea?.owner && source.gitea.repo
    ? `/${encodeURIComponent(source.gitea.owner)}/${encodeURIComponent(source.gitea.repo)}` : ''
  if (!/^https?:$/.test(url.protocol) || !suffix || !path.endsWith(suffix) || url.username || url.password || url.search || url.hash) {
    throw new Error('gitea_source_invalid: repository URL and Gitea owner/repository metadata do not agree')
  }
  return `${url.origin}${path.slice(0, -suffix.length)}/api/v1`
}

export const DEFAULT_MATOS_GITEA_CONTAINER_NAME = 'matos-gitea'
export const DEFAULT_MATOS_GITEA_CONTAINER_ALIAS = 'matos-gitea'
export const DEFAULT_MATOS_GITEA_CONTAINER_PORT = '3000'
// Host-side (gateway/operator) executions reach the local Gitea container over
// its published loopback port, not over the container-link alias. Keep this as
// the stable fallback when no explicit host source base URL is configured.
export const DEFAULT_MATOS_GITEA_HOST_SOURCE_BASE_URL = 'http://127.0.0.1:3001'
export const DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT =
  '/workspace/assets/gitea-sources'

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function envFlagEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (value ?? '').trim().toLowerCase(),
  )
}

function envFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes(
    (value ?? '').trim().toLowerCase(),
  )
}

function containerAlias(env: EnvLike): string {
  return nonEmpty(env.MATOS_GITEA_CONTAINER_ALIAS) ?? DEFAULT_MATOS_GITEA_CONTAINER_ALIAS
}

export function matOSGiteaContainerName(env: EnvLike = process.env): string {
  return nonEmpty(env.MATOS_GITEA_CONTAINER_NAME) ?? DEFAULT_MATOS_GITEA_CONTAINER_NAME
}

export function matOSGiteaContainerSourceBaseUrl(
  env: EnvLike = process.env,
): string {
  return (
    nonEmpty(env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL) ??
    `http://${containerAlias(env)}:${DEFAULT_MATOS_GITEA_CONTAINER_PORT}`
  )
}

export function matOSGiteaContainerApiUrl(
  env: EnvLike = process.env,
): string {
  const baseUrl = matOSGiteaContainerSourceBaseUrl(env).replace(/\/+$/, '')
  return /\/api\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/api/v1`
}

// Host-side executions (gateway provisioning, self-evolution acceptance, and
// operator CLI runs) must reach Gitea through a loopback-published base URL, not
// the container-link alias. Prefer the same env vars that provisioning uses to
// build clone URLs so host and provisioning stay consistent.
export function matOSGiteaHostSourceBaseUrl(env: EnvLike = process.env): string {
  return (
    nonEmpty(env.MATOS_GITEA_SOURCE_BASE_URL) ??
    nonEmpty(env.MATOS_GITEA_UPSTREAM) ??
    nonEmpty(env.MATOS_GITEA_BASE_URL) ??
    DEFAULT_MATOS_GITEA_HOST_SOURCE_BASE_URL
  )
}

function containerAliasHosts(env: EnvLike): Set<string> {
  const hosts = new Set<string>([DEFAULT_MATOS_GITEA_CONTAINER_ALIAS])
  const configuredAlias = nonEmpty(env.MATOS_GITEA_CONTAINER_ALIAS)
  if (configuredAlias) {
    hosts.add(configuredAlias.toLowerCase())
  }
  const configuredName = nonEmpty(env.MATOS_GITEA_CONTAINER_NAME)
  if (configuredName) {
    hosts.add(configuredName.toLowerCase())
  }
  const containerBaseUrl = nonEmpty(env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL)
  const parsedContainerBase = containerBaseUrl
    ? parseHttpUrl(containerBaseUrl)
    : undefined
  if (parsedContainerBase) {
    hosts.add(parsedContainerBase.hostname.toLowerCase())
  }
  return hosts
}

function isContainerAliasHost(hostname: string, env: EnvLike): boolean {
  return containerAliasHosts(env).has(hostname.trim().toLowerCase())
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function sourceIsGitea(source: MatOSAssetSourceConfig): boolean {
  return source.type === 'git' && (source.provider === 'gitea' || Boolean(source.gitea))
}

/** Alternate addresses of the same operator-configured Gitea service. Only
 * origins are translated; repository path, query and scope remain authoritative.
 * In particular, an arbitrary host (including an arbitrary loopback port) is
 * not equivalent just because its repository path happens to match.
 */
export function matOSGiteaEquivalentSourceRepos(
  source: MatOSAssetSourceConfig & { type: 'git' },
  env: EnvLike = process.env,
): string[] {
  const repos = new Set([source.repo])
  const parsed = parseHttpUrl(source.repo)
  if (!sourceIsGitea(source) || !parsed) return [...repos]
  const bases = [
    matOSGiteaHostSourceBaseUrl(env),
    matOSGiteaContainerSourceBaseUrl(env),
  ].map(parseHttpUrl).filter((url): url is URL => Boolean(url && url.pathname === '/'))
  if (!bases.some(base => base.origin === parsed.origin)) return [...repos]
  for (const base of bases) {
    const equivalent = new URL(parsed.toString())
    equivalent.protocol = base.protocol
    equivalent.hostname = base.hostname
    equivalent.port = base.port
    repos.add(equivalent.toString())
  }
  return [...repos]
}

export function safeMatOSGiteaFileSourceId(id: string): string {
  return (
    id
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'source'
  )
}

export function matOSGiteaFileSourceRepoForSource(input: {
  source: MatOSAssetSourceConfig
  env?: EnvLike
  requireExists?: boolean
}): string | undefined {
  if (!sourceIsGitea(input.source)) {
    return undefined
  }
  const env = input.env ?? process.env
  const root = nonEmpty(env.MATOS_GITEA_FILE_SOURCE_ROOT)
  if (!root) {
    return undefined
  }
  const repo = join(root, `${safeMatOSGiteaFileSourceId(input.source.id)}.git`)
  if (input.requireExists !== false && !existsSync(repo)) {
    return undefined
  }
  return repo
}

function sourceUsesLoopbackRepo(
  source: MatOSAssetSourceConfig,
  repo: string,
): boolean {
  if (!sourceIsGitea(source)) {
    return false
  }
  const parsed = parseHttpUrl(repo)
  return Boolean(parsed && isLoopbackHost(parsed.hostname))
}

function sourceUsesContainerAliasRepo(
  source: MatOSAssetSourceConfig,
  repo: string,
  env: EnvLike,
): boolean {
  if (!sourceIsGitea(source)) {
    return false
  }
  const parsed = parseHttpUrl(repo)
  return Boolean(parsed && isContainerAliasHost(parsed.hostname, env))
}

export function runningInMatOSContainer(cwd: string, env: EnvLike): boolean {
  return Boolean(
    nonEmpty(env.MATOS_WORKSPACE_DIR) ||
      nonEmpty(env.MATOS_IMAGE_PROFILE) ||
      cwd.startsWith('/workspace/') ||
      env.HOME === '/home/workspace' ||
      env.HOME === '/home/node',
  )
}

function rewriteUrlOrigin(input: {
  sourceUrl: URL
  baseUrl: string
}): string | undefined {
  const base = parseHttpUrl(input.baseUrl)
  if (!base) {
    return undefined
  }
  const basePath = base.pathname.replace(/\/+$/, '')
  const sourcePath = input.sourceUrl.pathname.replace(/^\/+/, '')
  base.pathname = [basePath, sourcePath].filter(Boolean).join('/')
  base.search = input.sourceUrl.search
  base.hash = input.sourceUrl.hash
  return base.toString().replace(/\/$/, '')
}

export function resolveMatOSGitAssetSourceRuntimeRepo(input: {
  cwd: string
  source: MatOSAssetSourceConfig
  repo: string
  env?: EnvLike
}): string {
  // Resolve before passing the remote to Git commands running in a cache
  // checkout. Keeping this relative in config makes local workspaces movable.
  if (input.repo.startsWith('./') || input.repo.startsWith('../')) return resolve(input.cwd, input.repo)
  const env = input.env ?? process.env
  if (!runningInMatOSContainer(input.cwd, env)) {
    // Host-side executions (gateway provisioning, self-evolution acceptance,
    // operator CLI) cannot resolve the container-link alias such as
    // `matos-gitea`. When a source URL was persisted with the container alias by
    // a prior workspace preparation, rewrite it back to the loopback-published
    // host base URL so `git fetch/push` works from the host.
    if (sourceUsesContainerAliasRepo(input.source, input.repo, env)) {
      const parsed = parseHttpUrl(input.repo)
      if (parsed) {
        return (
          rewriteUrlOrigin({
            sourceUrl: parsed,
            baseUrl: matOSGiteaHostSourceBaseUrl(env),
          }) ?? input.repo
        )
      }
    }
    return input.repo
  }
  const fileRepo = matOSGiteaFileSourceRepoForSource({
    source: input.source,
    env,
  })
  if (fileRepo) {
    return fileRepo
  }
  if (!sourceUsesLoopbackRepo(input.source, input.repo)) {
    return input.repo
  }
  const parsed = parseHttpUrl(input.repo)
  if (!parsed) {
    return input.repo
  }
  return (
    rewriteUrlOrigin({
      sourceUrl: parsed,
      baseUrl: matOSGiteaContainerSourceBaseUrl(env),
    }) ?? input.repo
  )
}

export function matOSProjectUsesContainerGiteaTransport(
  config: MatOSProjectConfig,
  env: EnvLike = process.env,
): boolean {
  if (envFlagDisabled(env.MATOS_GITEA_CONTAINER_LINK)) {
    return false
  }
  if (
    envFlagEnabled(env.MATOS_GITEA_ENABLED) ||
    nonEmpty(env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL) ||
    nonEmpty(env.MATOS_GITEA_SOURCE_BASE_URL) ||
    nonEmpty(env.MATOS_GITEA_UPSTREAM)
  ) {
    return true
  }
  return Boolean(
    config.assetSources?.some(
      source =>
        source.type === 'git' && sourceUsesLoopbackRepo(source, source.repo),
    ),
  )
}

export function matOSGiteaContainerTransportEnv(
  config: MatOSProjectConfig,
  env: EnvLike = process.env,
): Record<string, string> {
  if (!matOSProjectUsesContainerGiteaTransport(config, env)) {
    return {}
  }
  return {
    MATOS_GITEA_CONTAINER_SOURCE_BASE_URL:
      matOSGiteaContainerSourceBaseUrl(env),
    MATOS_GITEA_API_URL: matOSGiteaContainerApiUrl(env),
    MATOS_GITEA_FILE_SOURCE_ROOT: DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT,
  }
}
