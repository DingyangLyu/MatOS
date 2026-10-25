import type { MatOSGitAssetSourceConfig } from '../project.js'

export type MatOSGiteaAssetScope =
  | 'core'
  | 'evolution'
  | 'global'
  | 'project'
  | 'shared'
  | 'team'
  | 'user'

export type MatOSGiteaRepoVisibility = 'private' | 'internal' | 'public'

export type MatOSGiteaAssetRepoRef = {
  owner: string
  repo: string
  visibility: MatOSGiteaRepoVisibility
  scopeKind: MatOSGiteaAssetScope
  scopeId?: string
}

export type MatOSGiteaAssetRepoPathInfo = {
  owner: string
  repo: string
  isMatOSAssetRepo: boolean
}

export type MatOSGiteaAuthorizedScope = {
  role: 'admin' | 'reviewer' | 'curator'
  scopeRef: string
}

const MATOS_ASSET_REPO_OWNERS = new Set([
  'matos-core',
  'matos-community',
  'matos-evolution',
  'matos-global',
  'matos-projects',
  'matos-shared',
  'matos-teams',
  'matos-users',
])

const NON_REPO_GITEA_PATHS = new Set([
  '-',
  'admin',
  'api',
  'assets',
  'avatars',
  'explore',
  'issues',
  'notifications',
  'org',
  'pulls',
  'user',
])

function safeScopeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'default'
  )
}

export function matOSGiteaScopeIdFromScopeRef(scopeRef: string): string {
  return safeScopeId(scopeRef)
}

function repoForScopedAsset(input: {
  owner: string
  scopeKind: MatOSGiteaAssetScope
  scopeRef?: string
  scopeId?: string
  visibility: MatOSGiteaRepoVisibility
}): MatOSGiteaAssetRepoRef {
  const scopeId = safeScopeId(input.scopeId ?? input.scopeRef ?? '')
  if (!scopeId || scopeId === 'default') {
    throw new Error(`MatOS Gitea ${input.scopeKind} asset repo requires a scope id`)
  }
  return {
    owner: input.owner,
    repo: `${scopeId}-assets`,
    visibility: input.visibility,
    scopeKind: input.scopeKind,
    scopeId,
  }
}

export function matOSGiteaAssetRepoForScope(input: {
  scope: MatOSGiteaAssetScope
  scopeRef?: string
  scopeId?: string
}): MatOSGiteaAssetRepoRef {
  if (input.scope === 'core') {
    return {
      owner: 'matos-core',
      repo: 'assets',
      visibility: 'internal',
      scopeKind: 'core',
    }
  }
  if (input.scope === 'evolution') {
    return {
      owner: 'matos-evolution',
      repo: 'proposals',
      visibility: 'private',
      scopeKind: 'evolution',
    }
  }
  if (input.scope === 'global') {
    return {
      owner: 'matos-global',
      repo: 'assets',
      visibility: 'internal',
      scopeKind: 'global',
    }
  }
  if (input.scope === 'shared') {
    return {
      owner: 'matos-shared',
      repo: 'assets',
      visibility: 'internal',
      scopeKind: 'shared',
    }
  }
  if (input.scope === 'project') {
    return repoForScopedAsset({
      owner: 'matos-projects',
      scopeKind: 'project',
      scopeRef: input.scopeRef,
      scopeId: input.scopeId,
      visibility: 'private',
    })
  }
  if (input.scope === 'team') {
    return repoForScopedAsset({
      owner: 'matos-teams',
      scopeKind: 'team',
      scopeRef: input.scopeRef,
      scopeId: input.scopeId,
      visibility: 'private',
    })
  }
  return repoForScopedAsset({
    owner: 'matos-users',
    scopeKind: 'user',
    scopeRef: input.scopeRef,
    scopeId: input.scopeId,
    visibility: 'private',
  })
}

export function matOSGiteaAssetRepoPathInfo(
  path: string,
): MatOSGiteaAssetRepoPathInfo | undefined {
  const pathname = path.split('?')[0] ?? ''
  let segments: string[]
  try {
    segments = pathname
      .split('/')
      .map(segment => decodeURIComponent(segment.trim()))
      .filter(Boolean)
  } catch {
    return undefined
  }
  const isSafeSegment = (value: string | undefined): value is string =>
    Boolean(value) && value !== '.' && value !== '..' && !/[\\/]/.test(value)
  if (
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'repos'
  ) {
    const owner = segments[3]
    const rawRepo = segments[4]
    if (!isSafeSegment(owner) || !rawRepo) {
      return undefined
    }
    const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo
    if (!isSafeSegment(repo)) {
      return undefined
    }
    return {
      owner,
      repo,
      isMatOSAssetRepo: MATOS_ASSET_REPO_OWNERS.has(owner),
    }
  }
  const [owner, rawRepo] = segments
  if (!isSafeSegment(owner) || !rawRepo || NON_REPO_GITEA_PATHS.has(owner)) {
    return undefined
  }
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo
  if (!isSafeSegment(repo)) {
    return undefined
  }
  return {
    owner,
    repo,
    isMatOSAssetRepo: MATOS_ASSET_REPO_OWNERS.has(owner),
  }
}

function scopedRepoMatches(input: {
  accountScopeRef: string
  expectedScope: MatOSGiteaAssetScope
  repo: string
}): boolean {
  const prefix = `${input.expectedScope}:`
  if (!input.accountScopeRef.toLowerCase().startsWith(prefix)) {
    return false
  }
  const scopeId = matOSGiteaScopeIdFromScopeRef(input.accountScopeRef)
  return input.repo === `${scopeId}-assets`
}

function authorizedScopeAllowsAction(input: {
  scope: MatOSGiteaAuthorizedScope
  action: 'admin' | 'read' | 'write'
}): boolean {
  if (input.action === 'admin') {
    return false
  }
  if (input.action === 'read') {
    return true
  }
  return input.scope.role === 'curator' || input.scope.role === 'admin'
}

function authorizedScopesForKind(input: {
  authorizedScopes?: MatOSGiteaAuthorizedScope[]
  expectedScope: 'project' | 'team'
  action: 'admin' | 'read' | 'write'
}): string[] {
  const prefix = `${input.expectedScope}:`
  return (input.authorizedScopes ?? [])
    .filter(scope => scope.scopeRef.toLowerCase().startsWith(prefix))
    .filter(scope => authorizedScopeAllowsAction({ scope, action: input.action }))
    .map(scope => scope.scopeRef)
}

export function canAccessMatOSGiteaAssetRepo(input: {
  accountScopeRef: string
  accountPrincipal?: string
  authorizedScopes?: MatOSGiteaAuthorizedScope[]
  authorizedScopeRefs?: string[]
  isAdmin?: boolean
  owner: string
  repo: string
  action: 'admin' | 'read' | 'write'
}): boolean {
  if (!MATOS_ASSET_REPO_OWNERS.has(input.owner)) {
    return false
  }
  if (input.isAdmin === true) {
    return true
  }
  if (input.action === 'admin') {
    return false
  }
  if (
    input.owner === 'matos-core' ||
    input.owner === 'matos-global' ||
    input.owner === 'matos-shared'
  ) {
    return input.repo === 'assets' && input.action === 'read'
  }
  if (input.owner === 'matos-community') {
    // This is a protected review inbox, never a runtime source. Community
    // writes go straight to the contributor's private Gitea fork with their
    // scoped token; the gateway exposes only read navigation for the inbox.
    return input.repo === 'contributions' && input.action === 'read'
  }
  if (input.owner === 'matos-users') {
    return scopedRepoMatches({
      accountScopeRef: input.accountScopeRef,
      expectedScope: 'user',
      repo: input.repo,
    })
  }
  if (input.owner === 'matos-teams') {
    return [
      input.accountScopeRef,
      ...authorizedScopesForKind({
        authorizedScopes: input.authorizedScopes,
        expectedScope: 'team',
        action: input.action,
      }),
    ].some(
      scopeRef =>
        scopedRepoMatches({
          accountScopeRef: scopeRef,
          expectedScope: 'team',
          repo: input.repo,
        }),
    )
  }
  if (input.owner === 'matos-projects') {
    return [
      input.accountScopeRef,
      ...authorizedScopesForKind({
        authorizedScopes: input.authorizedScopes,
        expectedScope: 'project',
        action: input.action,
      }),
    ].some(
      scopeRef =>
        scopedRepoMatches({
          accountScopeRef: scopeRef,
          expectedScope: 'project',
          repo: input.repo,
        }),
    )
  }
  return false
}

export function matOSGiteaCloneUrl(input: {
  baseUrl: string
  owner: string
  repo: string
}): string {
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}.git`
}

function matOSGiteaWebUrl(input: {
  baseUrl: string
  owner: string
  repo: string
}): string {
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}`
}

export function canonicalizeMatOSGiteaAssetSource(
  source: MatOSGitAssetSourceConfig,
  input: { baseUrl?: string } = {},
): MatOSGitAssetSourceConfig {
  if (source.provider !== 'gitea' && !source.gitea) {
    return source
  }
  const owner = source.gitea?.owner?.trim()
  const repo = source.gitea?.repo?.trim()
  const baseUrl = input.baseUrl?.trim() || source.gitea?.baseUrl?.trim()
  if (!owner || !repo || !baseUrl) {
    return source
  }
  const cloneUrl = matOSGiteaCloneUrl({ baseUrl, owner, repo })
  const webUrl = matOSGiteaWebUrl({ baseUrl, owner, repo })
  if (
    source.repo === cloneUrl &&
    source.gitea?.baseUrl === baseUrl &&
    source.gitea?.cloneUrl === cloneUrl &&
    source.gitea?.webUrl === webUrl
  ) {
    return source
  }
  return {
    ...source,
    repo: cloneUrl,
    gitea: {
      ...source.gitea,
      owner,
      repo,
      baseUrl,
      webUrl,
      cloneUrl,
    },
  }
}
