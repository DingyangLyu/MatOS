import { buildMatOSAssetExecProviderScope } from '../algorithms/assetExecProvider.js'
import { matOSEvolutionPolicySurface } from '../algorithms/surfaces/evolutionPolicy.js'
import type { MatOSAlgorithmSelectionContext } from '../algorithms/surface.js'
import type {
  MatOSEvolutionAlgorithmBinding,
  MatOSEvolutionAlgorithmJournal,
  MatOSEvolutionObservation,
} from '../algorithms/evolution/protocol.js'
import { loadMatOSAssetsFromRoot } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { resolveMatOSAssetSourceRootProvenance } from '../assets/sourceAdapters.js'
import type { MatOSAsset } from '../assets/types.js'
import { readMatOSProjectConfig } from '../project.js'
import {
  directEditableFeedbackDecisions,
  type MatOSUserFeedbackAnalysis,
} from './userFeedbackSignals.js'

function bindingFor(
  context: MatOSAlgorithmSelectionContext,
): MatOSEvolutionAlgorithmBinding {
  const resolved = matOSEvolutionPolicySurface.resolve(context)
  if (resolved.requested)
    throw new Error(`Evolution algorithm is unavailable: ${resolved.requested}`)
  const provider = resolved.provider
  return {
    surfaceId: 'evolution-policy',
    providerId: provider.id,
    version: provider.version,
    configDigest: provider.configDigest,
    implementationDigest: provider.implementationDigest,
    ...(provider.assetRef ? { assetRef: provider.assetRef } : {}),
  }
}

export type MatOSEvolutionAlgorithmRuntime = Awaited<
  ReturnType<typeof createMatOSEvolutionAlgorithmRuntime>
>

/** A host adapter over Algorithm Layer V2, not a second evolution provider. */
export async function createMatOSEvolutionAlgorithmRuntime(input: {
  cwd: string
  scopeRef?: string
  env?: Record<string, string | undefined>
  journal?: MatOSEvolutionAlgorithmJournal
}) {
  const env = { ...(input.env ?? process.env) }
  const providerId =
    input.journal?.binding.providerId ??
    (env.MATOS_ALGO_EVOLUTION_POLICY?.trim() || 'evidence-first')
  const context: MatOSAlgorithmSelectionContext = {
    cwd: input.cwd,
    env,
    providerId,
  }
  if (providerId.startsWith('asset:')) {
    const config = await readMatOSProjectConfig(input.cwd)
    // Filter sources before materialization, not after loading private files.
    const assetSources = (config.assetSources ?? []).filter(
      (source) =>
        ['core', 'shared', 'global'].includes(source.scope ?? '') ||
        Boolean(input.scopeRef && source.scopeRef === input.scopeRef),
    )
    const roots = await resolveMatOSAssetSourceRootProvenance(
      input.cwd,
      { ...config, assetRoots: [], assetSources },
      { runtimeSnapshot: true },
    )
    const assets: MatOSAsset[] = []
    for (const [root, provenance] of roots) {
      for (const asset of await loadMatOSAssetsFromRoot(root)) {
        assets.push({
          ...asset,
          metadata: { ...asset.metadata, sourceProvenance: provenance },
        })
      }
    }
    context.providerOverrides = buildMatOSAssetExecProviderScope(
      buildMatOSAssetRegistry(assets),
      { env },
    ).providersFor('evolution-policy')
    // Never resolve a scoped asset strategy from the process-global registry.
    if (!context.providerOverrides?.has(providerId))
      throw new Error(
        'Evolution algorithm asset is not enabled in the current scope.',
      )
  }
  const binding = bindingFor(context)
  if (
    input.journal &&
    JSON.stringify(binding) !== JSON.stringify(input.journal.binding)
  ) {
    throw new Error(
      'Evolution algorithm changed since this transaction started; retry with a new transaction.',
    )
  }
  const journal: MatOSEvolutionAlgorithmJournal = {
    schemaVersion: 1,
    binding,
    decisions: [...(input.journal?.decisions ?? [])],
  }
  return {
    journal: () => structuredClone(journal),
    async decide(observation: MatOSEvolutionObservation) {
      if (JSON.stringify(bindingFor(context)) !== JSON.stringify(binding))
        throw new Error(
          'Evolution algorithm identity changed during the transaction.',
        )
      const outcome = await matOSEvolutionPolicySurface.decide(
        observation,
        context,
      )
      // Failure of an experiment must not silently activate a broader editor.
      const decision = outcome.fallback
        ? {
            action:
              observation.phase === 'evaluated'
                ? ('reject' as const)
                : ('defer' as const),
            signalIds: [],
            reason: `Algorithm unavailable: ${outcome.fallback}`,
          }
        : outcome.decision
      journal.decisions.push({
        phase: observation.phase,
        decisionId: outcome.decisionId,
        decision,
        ...(outcome.fallback ? { fallback: outcome.fallback } : {}),
      })
      return decision
    },
  }
}

export function evolutionAlgorithmSignals(input: {
  analysis?: MatOSUserFeedbackAnalysis
  scoped?: boolean
  ownedSourceEventRefs?: string[]
}): MatOSEvolutionObservation['signals'] {
  return directEditableFeedbackDecisions(input.analysis, input).flatMap(
    (decision) => {
      const signal = input.analysis?.signals.find(
        (item) => item.id === decision.signalId,
      )
      if (!signal) return []
      return [
        {
          id: signal.id,
          confidence: Math.min(signal.confidence, decision.confidence),
          evidenceSupport: decision.evidenceSupport,
          risk: decision.risk,
          kind: signal.kind,
          targetTypes: signal.target.assetTypes ?? [],
          targetRefs: [
            ...(signal.target.assetRefs ?? []),
            ...(signal.target.toolRefs ?? []),
            ...(signal.target.mcpRefs ?? []),
            ...(signal.target.knowledgeRefs ?? []),
            ...signal.target.roleRefs,
            ...signal.target.workflowRefs,
          ],
        },
      ]
    },
  )
}

export function selectEvolutionAlgorithmFeedback(
  analysis: MatOSUserFeedbackAnalysis | undefined,
  ids: string[],
): MatOSUserFeedbackAnalysis | undefined {
  if (!analysis) return undefined
  const selected = new Set(ids)
  return {
    ...analysis,
    shouldUseFeedback: analysis.shouldUseFeedback && selected.size > 0,
    signals: analysis.signals.filter((signal) => selected.has(signal.id)),
    decisions: analysis.decisions.filter((decision) =>
      selected.has(decision.signalId),
    ),
  }
}
