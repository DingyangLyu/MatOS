import { capPromptSummary } from './promptBudget.js'
import type { MatOSAsset } from './types.js'

// This fallback enumeration runs when no role is composed, so it is the only
// asset surface in the prompt. It must stay bounded: the registry already
// holds ~2000 assets and grows monotonically, and an uncapped map here turns
// asset-pack growth directly into system-prompt growth. Entries beyond the cap
// stay reachable through the asset discovery tools (asset_list / asset_search).
export const ASSET_CONTEXT_MAX_ENTRIES = 200

export function renderMatOSAssetContext(
  assets: MatOSAsset[],
  options: { maxEntries?: number } = {},
): string {
  if (assets.length === 0) {
    return ''
  }

  const maxEntries = Math.max(1, options.maxEntries ?? ASSET_CONTEXT_MAX_ENTRIES)
  const shown = assets.slice(0, maxEntries)
  const omitted = assets.length - shown.length

  const lines = [
    'MatOS project assets available in this session:',
    ...shown.map(asset => {
      const description = asset.description
        ? ` - ${capPromptSummary(asset.description)}`
        : ''
      return `- ${asset.type}:${asset.id} (${asset.name})${description}`
    }),
  ]
  if (omitted > 0) {
    lines.push(
      `… ${omitted} more assets omitted; use asset_list / asset_search to discover them.`,
    )
  }

  return lines.join('\n')
}
