import { appendMatOSAlgorithmOutcome } from '../algorithms/outcomes/ledger.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'

export async function recordEvolutionAlgorithmOutcome(
  cwd: string,
  run: MatOSDirectAssetEditorRunRecord,
  env?: Record<string, string | undefined>,
): Promise<boolean | undefined> {
  const journal = run.input.currentEvolutionContext?.algorithm
  if (!journal) return undefined
  const accepted = run.status === 'accepted' || run.status === 'accepted_merged'
  const terminal =
    accepted ||
    [
      'noop',
      'failed',
      'rolled_back',
      'rollback_failed',
      'pending_merge',
      'blocked',
    ].includes(run.status)
  if (!terminal) return undefined
  const binding = journal.binding
  return appendMatOSAlgorithmOutcome(
    cwd,
    {
      schemaVersion: 1,
      redacted: true,
      generation: 1,
      outcomeId: `evolution:${run.runId}:${run.status}:${run.updatedAt}`,
      recordedAt: new Date().toISOString(),
      runUpdatedAt: run.updatedAt,
      kind: 'evolution-run',
      subject: { runId: run.runId },
      status: accepted || run.status === 'noop' ? 'completed' : 'failed',
      success: accepted,
      decisionRefs: journal.decisions.map((item) => item.decisionId),
      providerId: binding.providerId,
      providerVersion: binding.version,
      configDigest: binding.configDigest,
      providerRefs: [
        {
          ...binding,
          source: 'evolution-transaction',
          providerVersion: binding.version,
        },
      ],
      algorithmPlane: 'policy',
      algorithmId: 'evolution-policy',
      algorithmVersion: binding.version,
      assetRefs: run.acceptanceEvidence?.observedChanges?.actualRefs ?? [],
      ...(run.input.scopeRef ? { scopeRef: run.input.scopeRef } : {}),
      metrics: {
        nativePublicationAccepted: accepted,
        status: run.status,
        effectivenessProven: false,
        ...(run.totalCostUsd !== undefined
          ? { directEditorCostUsd: run.totalCostUsd }
          : {}),
      },
      // Publication success is not behavioral improvement and must not train an optimizer as such.
      trainingEligible: false,
      evidenceCompleteness: {
        status: 'incomplete',
        reasons: ['post-acceptance-behavior-not-yet-evaluated'],
      },
      provenanceRefs: [
        `direct-editor:${run.runId}`,
        ...(run.beforeSnapshot ? [run.beforeSnapshot] : []),
        ...(run.afterSnapshot ? [run.afterSnapshot] : []),
      ],
    },
    { env },
  )
}
