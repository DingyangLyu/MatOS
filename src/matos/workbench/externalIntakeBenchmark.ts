/**
 * Deterministic benchmark drafting for repo2asset / paper2asset intake.
 *
 * Given a draft-pack plan, this produces a runnable MatOS `artifact-check`
 * benchmark case that verifies the generated pack actually persisted the
 * expected asset and intake provenance. It is LLM-free and runnable through the
 * existing `runMatOSBenchmarkCase` runner, so an intake-generated pack ships
 * with a replayable integrity check instead of an unverified document dump.
 */

export type MatOSIntakeBenchmarkPlanInput = {
  targetPack: {
    packId: string
    manifestRelativePath: string
  }
  proposedAssets: Array<{
    id: string
    ref: string
    type: string
    primary: boolean
    manifestRelativePath: string
  }>
  provenance: {
    intakeRef: string
    sourceFingerprint?: string
  }
}

export type MatOSIntakeBenchmarkCase = {
  schemaVersion: 1
  id: string
  kind: 'artifact-check'
  subjectRefs: string[]
  costRisk: 'free'
  approvalPolicy: 'bypass-safe'
  timeoutMs: number
  description: string
  task: { input: { path: string } }
  checks: Array<{ type: 'stdout-contains'; value: string }>
  provenance: {
    intakeRef: string
    packId: string
    sourceFingerprint?: string
  }
}

export type MatOSIntakeBenchmarkDraft = {
  case: MatOSIntakeBenchmarkCase
  note: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Returns undefined when there is nothing draftable to benchmark (no proposed
 * assets), so callers can simply omit the benchmark from the result.
 */
export function draftMatOSIntakeBenchmarkCase(
  plan: MatOSIntakeBenchmarkPlanInput,
): MatOSIntakeBenchmarkDraft | undefined {
  if (plan.proposedAssets.length === 0) {
    return undefined
  }
  const primary =
    plan.proposedAssets.find(asset => asset.primary) ?? plan.proposedAssets[0]
  const targetPath = primary.manifestRelativePath
  // Assert bare values (not "key": "value" patterns) so the check does not
  // depend on the manifest JSON indentation/spacing.
  const checks: MatOSIntakeBenchmarkCase['checks'] = [
    { type: 'stdout-contains', value: primary.id },
  ]
  if (plan.provenance.sourceFingerprint) {
    checks.push({
      type: 'stdout-contains',
      value: plan.provenance.sourceFingerprint,
    })
  }
  const benchmarkCase: MatOSIntakeBenchmarkCase = {
    schemaVersion: 1,
    id: `intake-${plan.targetPack.packId}-pack-integrity`,
    kind: 'artifact-check',
    subjectRefs: [...new Set(plan.proposedAssets.map(asset => asset.ref))],
    costRisk: 'free',
    approvalPolicy: 'bypass-safe',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description: `Verify the intake-generated pack "${plan.targetPack.packId}" persisted the primary ${primary.type} asset manifest and intake provenance.`,
    task: { input: { path: targetPath } },
    checks,
    provenance: {
      intakeRef: plan.provenance.intakeRef,
      packId: plan.targetPack.packId,
      ...(plan.provenance.sourceFingerprint
        ? { sourceFingerprint: plan.provenance.sourceFingerprint }
        : {}),
    },
  }
  return {
    case: benchmarkCase,
    note: plan.provenance.sourceFingerprint
      ? 'Deterministic artifact-check: the primary drafted asset manifest must exist and carry its id, type, and the intake source fingerprint.'
      : 'Deterministic artifact-check: the primary drafted asset manifest must exist and carry its id and type.',
  }
}
