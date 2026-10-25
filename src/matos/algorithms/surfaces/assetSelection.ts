import { createHash } from 'node:crypto'
import type { MatOSAsset } from '../../assets/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

export type MatOSAssetSelectionInput = {
  roleRef: string
  candidateAssetKeys: string[]
  requiredAssetKeys?: string[]
  maxAssets?: number
  query?: string
  role?: MatOSAsset
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
}

export type MatOSAssetSelectionDecision = {
  selectedAssetKeys: string[]
}

function roleAlgorithms(role: MatOSAsset | undefined): unknown {
  return role?.runtime.algorithms && typeof role.runtime.algorithms === 'object'
    ? role.runtime.algorithms
    : undefined
}

export const matOSAssetSelectionSurface = createMatOSAlgorithmSurface<
  MatOSAssetSelectionInput,
  MatOSAssetSelectionDecision
>({
  surfaceId: 'asset-selection',
  envVar: 'MATOS_ALGO_ASSET_SELECTION',
  baseline: {
    description: 'Keeps the pre-filtered asset candidate set unchanged.',
    decide: input => ({ selectedAssetKeys: [...input.candidateAssetKeys] }),
  },
  sanitizeDecision: (decision, input) => {
    const candidates = new Set(input.candidateAssetKeys)
    const required = (input.requiredAssetKeys ?? []).filter(key =>
      candidates.has(key),
    )
    const ordered = [...required]
    for (const key of Array.isArray(decision.selectedAssetKeys)
      ? decision.selectedAssetKeys
      : []) {
      if (candidates.has(key) && !ordered.includes(key)) ordered.push(key)
    }
    const max = Math.max(input.maxAssets ?? ordered.length, required.length)
    const selected = ordered.slice(0, max)
    return {
      selectedAssetKeys:
        selected.length > 0 ? selected : [...input.candidateAssetKeys],
    }
  },
  inputDigest: input =>
    createHash('sha256')
      .update(input.roleRef)
      .update('\u0000')
      .update([...input.candidateAssetKeys].sort().join(','))
      .update('\u0000')
      .update([...(input.requiredAssetKeys ?? [])].sort().join(','))
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    roleRef: input.roleRef,
    candidateCount: input.candidateAssetKeys.length,
    selectedCount: decision.selectedAssetKeys.length,
    requiredCount: input.requiredAssetKeys?.length ?? 0,
  }),
})

matOSAssetSelectionSurface.register({
  id: 'required-first',
  description:
    'Keeps every required asset and fills the remaining budget in pre-ranked candidate order.',
  decide: input => {
    const required = new Set(input.requiredAssetKeys ?? [])
    const max = Math.max(input.maxAssets ?? input.candidateAssetKeys.length, required.size)
    return {
      selectedAssetKeys: [
        ...input.candidateAssetKeys.filter(key => required.has(key)),
        ...input.candidateAssetKeys.filter(key => !required.has(key)),
      ].slice(0, max),
    }
  },
})

export function decideMatOSAssetSelection(
  input: MatOSAssetSelectionInput,
): MatOSAlgorithmDecisionOutcome<MatOSAssetSelectionDecision> {
  return matOSAssetSelectionSurface.decideSync(input, {
    env: input.env,
    roleAlgorithms: roleAlgorithms(input.role),
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  })
}
