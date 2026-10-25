export type MatOSEvolutionPhase = 'observed' | 'analyzed' | 'evaluated'

/** Serializable algorithm inputs. No runtime handles or mutation capabilities. */
export type MatOSEvolutionObservation = {
  schemaVersion: 1
  phase: MatOSEvolutionPhase
  trigger: { kind: string; key: string }
  scopeRef?: string
  constraints: { canAnalyze: boolean; canEdit: boolean; maxSignals: number }
  signals: Array<{
    id: string
    confidence: number
    evidenceSupport:
      | 'supported'
      | 'partially_supported'
      | 'unsupported'
      | 'contradicted'
    risk: 'low' | 'medium' | 'high'
    targetTypes: string[]
    targetRefs?: string[]
    kind?: string
  }>
  candidate?: {
    nativeGatesPassed: boolean
    changedAssetRefs?: string[]
    introducedValidationErrors?: number
    semanticVerdict?: string
  }
}

export type MatOSEvolutionDecision = {
  action: 'analyze' | 'edit' | 'defer' | 'stop' | 'retain' | 'reject'
  signalIds: string[]
  reason?: string
}

export type MatOSEvolutionAlgorithmBinding = {
  surfaceId: 'evolution-policy'
  providerId: string
  version: string
  configDigest: string
  implementationDigest: string
  assetRef?: string
}

export type MatOSEvolutionAlgorithmJournal = {
  schemaVersion: 1
  binding: MatOSEvolutionAlgorithmBinding
  decisions: Array<{
    phase: MatOSEvolutionPhase
    decisionId: string
    decision: MatOSEvolutionDecision
    fallback?: string
  }>
}

/** The host, not a replaceable strategy, owns these non-bypassable gates. */
export function constrainMatOSEvolutionDecision(
  proposed: MatOSEvolutionDecision,
  input: MatOSEvolutionObservation,
): MatOSEvolutionDecision {
  const reason =
    typeof proposed?.reason === 'string'
      ? proposed.reason.slice(0, 500)
      : undefined
  const empty = (
    action: MatOSEvolutionDecision['action'],
  ): MatOSEvolutionDecision => ({
    action,
    signalIds: [],
    ...(reason ? { reason } : {}),
  })
  if (input.phase === 'evaluated') {
    return empty(
      input.candidate?.nativeGatesPassed === true &&
        proposed?.action === 'retain'
        ? 'retain'
        : 'reject',
    )
  }
  if (proposed?.action === 'stop') return empty('stop')
  if (input.phase === 'observed') {
    return empty(
      input.constraints.canAnalyze && proposed?.action === 'analyze'
        ? 'analyze'
        : 'defer',
    )
  }
  if (!input.constraints.canEdit || proposed?.action !== 'edit')
    return empty('defer')
  const eligible = new Set(input.signals.map((signal) => signal.id))
  const limit = Number.isFinite(input.constraints.maxSignals)
    ? Math.max(0, Math.floor(input.constraints.maxSignals))
    : 0
  const signalIds = [
    ...new Set(
      (Array.isArray(proposed.signalIds) ? proposed.signalIds : []).filter(
        (id) => typeof id === 'string' && eligible.has(id),
      ),
    ),
  ].slice(0, limit)
  return { ...empty(signalIds.length ? 'edit' : 'defer'), signalIds }
}
