type ArchiveScope = { scope: string; scopeRef?: string; provenance?: Record<string, unknown> }

function userId(env: NodeJS.ProcessEnv): string | undefined {
  return env.MATOS_USER_ID?.trim() || env.MATOS_GATEWAY_USER_ID?.trim() || env.MATOS_WORKSPACE_USER_ID?.trim()
}

export function activeMatOSAssetArchiveScopeRef(env = process.env): string | undefined {
  const user = userId(env)
  return env.MATOS_SCOPE_REF?.trim() || env.MATOS_SCOPE_ID?.trim() || (user ? `user:${user}` : undefined)
}

export function isScopedAssetArchiveCaller(env = process.env): boolean {
  return Boolean(activeMatOSAssetArchiveScopeRef(env) || env.MATOS_HIDE_INTERNAL_ASSET_SOURCE === '1')
}

export function archiveOwnerScopeRef(record: ArchiveScope): string | undefined {
  if (record.scopeRef?.startsWith(`${record.scope}:`)) return record.scopeRef
  const localOwner = record.provenance?.archiveOwnerScopeRef
  return record.scope === 'project' && !record.scopeRef && typeof localOwner === 'string' && /^(user|team|project):[^\s]+$/.test(localOwner) ? localOwner : undefined
}

export function archiveScopeAllowed(record: ArchiveScope, env = process.env): boolean {
  const active = activeMatOSAssetArchiveScopeRef(env)
  if (!active) return env.MATOS_HIDE_INTERNAL_ASSET_SOURCE !== '1'
  if (['core', 'shared', 'global'].includes(record.scope)) return true
  const owner = archiveOwnerScopeRef(record)
  const user = userId(env)
  return Boolean(owner && (owner === active || (user && owner === `user:${user}`)))
}
