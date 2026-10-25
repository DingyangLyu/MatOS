import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'

function scopedIdentity(scope: MatOSDirectAssetEditorScope, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.MATOS_SCOPE_REF?.trim() || env.MATOS_SCOPE_ID?.trim()
  if (explicit) return explicit
  const keys = scope === 'user'
    ? ['MATOS_USER_ID', 'MATOS_GATEWAY_USER_ID', 'MATOS_WORKSPACE_USER_ID', 'MATOS_ACCOUNT_ID']
    : scope === 'team' ? ['MATOS_TEAM_ID'] : ['MATOS_PROJECT_ID']
  const id = keys.map(key => env[key]?.trim()).find(Boolean)
  return id ? id.startsWith(`${scope}:`) ? id : `${scope}:${id}` : undefined
}

/** One identity for prompt, writable roots, source locks and publication. */
export function resolvedDirectEditorScopeRef(input: {
  scope?: MatOSDirectAssetEditorScope; scopeRef?: string; env?: NodeJS.ProcessEnv
}): string | undefined {
  const scope = input.scope ?? 'core'
  if (scope === 'core') {
    if (input.scopeRef && !['core', 'scope:core'].includes(input.scopeRef.trim())) throw new Error('Core evolution cannot use an owner-qualified scopeRef.')
    return undefined
  }
  const ref = input.scopeRef?.trim() || scopedIdentity(scope, input.env ?? {}) || scopedIdentity(scope, process.env)
  if (ref && (!ref.startsWith(`${scope}:`) || !ref.slice(scope.length + 1).trim())) {
    throw new Error('Direct editor scope and owner reference do not match')
  }
  return ref
}
