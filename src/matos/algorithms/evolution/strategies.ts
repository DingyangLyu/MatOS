import {
  constrainMatOSEvolutionDecision,
  type MatOSEvolutionDecision,
  type MatOSEvolutionObservation,
} from './protocol.js'

export function baselineEvolutionPolicy(
  input: MatOSEvolutionObservation,
): MatOSEvolutionDecision {
  return constrainMatOSEvolutionDecision(
    {
      action:
        input.phase === 'observed'
          ? 'analyze'
          : input.phase === 'evaluated'
            ? 'retain'
            : 'edit',
      signalIds: input.signals.map((signal) => signal.id),
      reason: 'Native eligible evidence in original order.',
    },
    input,
  )
}

export function evidenceFirstEvolutionPolicy(
  input: MatOSEvolutionObservation,
): MatOSEvolutionDecision {
  if (input.phase !== 'analyzed') return baselineEvolutionPolicy(input)
  const ranked = input.signals
    .filter(
      (signal) =>
        signal.evidenceSupport === 'supported' &&
        signal.confidence >= 0.7 &&
        signal.risk !== 'high',
    )
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  return constrainMatOSEvolutionDecision(
    {
      action: 'edit',
      signalIds: ranked.slice(0, 2).map((signal) => signal.id),
      reason: 'At most two supported, high-confidence signals per transaction.',
    },
    input,
  )
}
