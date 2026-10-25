import { createHash } from 'node:crypto'
import type { MatOSAssetHistoryScope } from './types.js'

function stableScopeRefSegment(scopeRef: string): string {
  const normalized = scopeRef.trim().toLowerCase()
  const readable = normalized
    .replace(/^[a-z]+:/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'owner'
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

function matOSAssetHistoryScopeRef(
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
  leaf = 'stable',
): string {
  const owner = scopeRef?.trim()
  return owner
    ? `refs/matos/assets/${scope}/${stableScopeRefSegment(owner)}/${leaf}`
    : `refs/matos/assets/${scope}/${leaf}`
}

export function matOSAssetHistoryStableRef(
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): string {
  return matOSAssetHistoryScopeRef(scope, scopeRef, 'stable')
}

export function matOSAssetHistoryLatestRef(
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): string {
  return matOSAssetHistoryScopeRef(scope, scopeRef, 'latest')
}
