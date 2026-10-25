import { createHash } from 'node:crypto'
import { createMatOSAlgorithmSurface } from '../surface.js'
import {
  constrainMatOSEvolutionDecision,
  type MatOSEvolutionDecision,
  type MatOSEvolutionObservation,
} from '../evolution/protocol.js'
import {
  baselineEvolutionPolicy,
  evidenceFirstEvolutionPolicy,
} from '../evolution/strategies.js'

export const matOSEvolutionPolicySurface = createMatOSAlgorithmSurface<
  MatOSEvolutionObservation,
  MatOSEvolutionDecision
>({
  surfaceId: 'evolution-policy',
  envVar: 'MATOS_ALGO_EVOLUTION_POLICY',
  baseline: {
    description: 'Native eligible evolution evidence in original order.',
    version: '1.0.0',
    implementationDigest: createHash('sha256')
      .update(
        [
          baselineEvolutionPolicy.toString(),
          constrainMatOSEvolutionDecision.toString(),
        ].join('\n'),
      )
      .digest('hex'),
    decide: baselineEvolutionPolicy,
  },
  sanitizeDecision: constrainMatOSEvolutionDecision,
  inputDigest: (input) =>
    createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  decisionSummary: (decision, input) => ({
    phase: input.phase,
    action: decision.action,
    signalCount: decision.signalIds.length,
  }),
})

matOSEvolutionPolicySurface.register({
  id: 'evidence-first',
  version: '1.0.0',
  description:
    'Prioritizes supported evidence and bounds each edit transaction.',
  // Include imported implementation helpers, not just the provider wrapper.
  implementationDigest: createHash('sha256')
    .update(
      [
        evidenceFirstEvolutionPolicy.toString(),
        baselineEvolutionPolicy.toString(),
        constrainMatOSEvolutionDecision.toString(),
      ].join('\n'),
    )
    .digest('hex'),
  decide: evidenceFirstEvolutionPolicy,
})
