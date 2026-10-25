import { createHash } from 'node:crypto'
import type { MatOSAsset } from '../../assets/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

/**
 * S4 tool-selection: orders (and optionally narrows) the composed
 * `allowedTools` list for the selected role's runtime projection.
 *
 * The mount graph is a permission boundary and is not exposed here:
 * strategies receive the already-composed tool list and can only reorder or
 * narrow within it. The sanitize clamp guarantees a strategy can never add a
 * tool the role did not mount and never empty the tool list (an empty
 * decision falls back to the baseline list). Baseline preserves the exact
 * composed order, so default behavior is unchanged.
 */

export type MatOSToolSelectionInput = {
  /** Selected role ref for telemetry and strategy context. */
  roleRef: string
  /** Composed allowlist from role runtime composition (the full mounted set). */
  allowedTools: string[]
  disallowedTools?: string[]
  role?: MatOSAsset
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
}

export type MatOSToolSelectionDecision = {
  allowedTools: string[]
}

function baselineToolSelection(
  input: MatOSToolSelectionInput,
): MatOSToolSelectionDecision {
  return { allowedTools: [...input.allowedTools] }
}

function sanitizeToolSelection(
  decision: MatOSToolSelectionDecision,
  input: MatOSToolSelectionInput,
): MatOSToolSelectionDecision {
  const mounted = new Set(input.allowedTools)
  const seen = new Set<string>()
  const selected: string[] = []
  for (const tool of Array.isArray(decision.allowedTools)
    ? decision.allowedTools
    : []) {
    if (typeof tool !== 'string') {
      continue
    }
    // Only-narrow invariant: the mounted allowlist is a permission boundary,
    // so strategies cannot introduce tools outside it.
    if (!mounted.has(tool) || seen.has(tool)) {
      continue
    }
    seen.add(tool)
    selected.push(tool)
  }
  // A strategy cannot strip a role down to zero tools; an empty result means
  // the strategy abstained and the baseline list stands.
  return selected.length > 0
    ? { allowedTools: selected }
    : { allowedTools: [...input.allowedTools] }
}

export const matOSToolSelectionSurface = createMatOSAlgorithmSurface<
  MatOSToolSelectionInput,
  MatOSToolSelectionDecision
>({
  surfaceId: 'tool-selection',
  envVar: 'MATOS_ALGO_TOOL_SELECTION',
  baseline: {
    description:
      'Keeps the composed role tool allowlist exactly as mounted, in composition order.',
    decide: baselineToolSelection,
  },
  sanitizeDecision: sanitizeToolSelection,
  inputDigest: input =>
    createHash('sha256')
      .update(
        JSON.stringify({
          roleRef: input.roleRef,
          allowedTools: [...input.allowedTools].sort(),
          disallowedTools: [...(input.disallowedTools ?? [])].sort(),
        }),
      )
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    roleRef: input.roleRef,
    mountedCount: input.allowedTools.length,
    selectedCount: decision.allowedTools.length,
    narrowed: decision.allowedTools.length < input.allowedTools.length,
  }),
})

function roleAlgorithms(role: MatOSAsset | undefined): unknown {
  const value = role?.runtime.algorithms
  return value && typeof value === 'object' ? value : undefined
}

export function decideMatOSToolSelection(
  input: MatOSToolSelectionInput,
): MatOSAlgorithmDecisionOutcome<MatOSToolSelectionDecision> {
  return matOSToolSelectionSurface.decideSync(input, {
    env: input.env,
    roleAlgorithms: roleAlgorithms(input.role),
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  })
}
