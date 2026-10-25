import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  runMatOSBenchmarkCase,
  type MatOSBenchmarkCaseRunResult,
} from './benchmarkRunner.js'
import { normalizeMatOSBenchmarkCase } from './benchmarkSchema.js'
import { writeGeneratedAssetFile } from './generatedAssetFiles.js'
import {
  matOSEvolutionProposalBenchmarkDir,
  readMatOSEvolutionProposal,
  updateMatOSEvolutionProposalGates,
  type MatOSEvolutionProposal,
} from './proposalDrafts.js'
import { readMatOSWorkflowReplayCandidate } from './replayCandidates.js'

/**
 * Failure2Asset benchmark drafting and regression.
 *
 * Drafts one replayable MatOS benchmark case per proposal and runs it through
 * the existing `runMatOSBenchmarkCase` runner so every failure-derived draft
 * ships with an executable regression instead of an unverified document:
 *
 *   .matos/evolution/proposals/<proposal-id>/benchmark/case.json
 *   .matos/evolution/proposals/<proposal-id>/benchmark/result.json
 *
 * Case kinds follow the deterministic proposal plan:
 * - workflow-run   for workflow failures (reusing replay-candidate parameters
 *   when the failed run already produced a replay plan)
 * - tool-call      for tool failures that resolved to a tool asset (runs the
 *   generated preflight tool for real)
 * - artifact-check for runbook-only proposals (free, always runnable)
 */

export type MatOSEvolutionBenchmarkCase = {
  schemaVersion: 2
  id: string
  kind: 'workflow-run' | 'tool-call' | 'artifact-check'
  subjectRefs: string[]
  task: Record<string, unknown>
  checks: Array<Record<string, unknown>>
  costRisk: 'free' | 'cheap' | 'standard'
  approvalPolicy: 'bypass-safe'
  timeoutMs: number
  description: string
  provenance: {
    proposalRef: string
    episodeRef: string
    intakeRef?: string
    replayCandidateRef?: string
  }
}

export type MatOSEvolutionBenchmarkDraft = {
  proposalId: string
  case: MatOSEvolutionBenchmarkCase
  casePath: string
  note: string
  proposal: MatOSEvolutionProposal
}

export type MatOSEvolutionBenchmarkRegression = {
  proposalId: string
  benchmarkRef: string
  casePath: string
  result: MatOSBenchmarkCaseRunResult
  proposal: MatOSEvolutionProposal
}

const CASE_FILE = 'case.json'
const WORKFLOW_RUN_TIMEOUT_MS = 600_000
const TOOL_CALL_TIMEOUT_MS = 60_000
const ARTIFACT_CHECK_TIMEOUT_MS = 30_000

function benchmarkCaseIdFor(proposal: MatOSEvolutionProposal): string {
  const base = proposal.proposalId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base}-regression`
}

async function replayParametersFor(input: {
  cwd: string
  replayCandidateId: string
}): Promise<Record<string, unknown>> {
  const candidate = await readMatOSWorkflowReplayCandidate(
    input.cwd,
    input.replayCandidateId,
  )
  if (!candidate?.path) {
    return {}
  }
  try {
    const planPath = join(
      candidate.path.replace(/candidate\.json$/, ''),
      candidate.files.replayPlan,
    )
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as {
      parameters?: unknown
    }
    return plan.parameters &&
      typeof plan.parameters === 'object' &&
      !Array.isArray(plan.parameters)
      ? (plan.parameters as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function runbookArtifactPath(proposal: MatOSEvolutionProposal): string | undefined {
  const runbook = proposal.plannedAssets.find(asset => asset.role === 'runbook')
  if (!runbook) {
    return undefined
  }
  return `${proposal.targetPack.relativePath}/knowledge/${runbook.id}/${runbook.entry}`
}

/**
 * Drafts the benchmark case declared by the proposal's benchmark plan and
 * persists it under the proposal record. The case is normalized through the
 * shared benchmark schema before writing so drafted cases are always loadable
 * by the runner.
 */
export async function draftMatOSEvolutionBenchmark(input: {
  cwd: string
  proposalId: string
}): Promise<MatOSEvolutionBenchmarkDraft> {
  const proposal = await readMatOSEvolutionProposal(input.cwd, input.proposalId)
  if (!proposal) {
    throw new Error(`MatOS evolution proposal not found: ${input.proposalId}`)
  }
  const plan = proposal.benchmarkPlan
  const caseId = benchmarkCaseIdFor(proposal)
  const provenance: MatOSEvolutionBenchmarkCase['provenance'] = {
    proposalRef: `evolution-proposal:${proposal.proposalId}`,
    episodeRef: proposal.provenance.episodeRef,
    ...(proposal.provenance.intakeRef
      ? { intakeRef: proposal.provenance.intakeRef }
      : {}),
    ...(plan.replayCandidateId
      ? { replayCandidateRef: `replay-candidate:${plan.replayCandidateId}` }
      : {}),
  }

  let benchmarkCase: MatOSEvolutionBenchmarkCase
  let note: string
  if (plan.kind === 'workflow-run') {
    const parameters = plan.replayCandidateId
      ? await replayParametersFor({
          cwd: input.cwd,
          replayCandidateId: plan.replayCandidateId,
        })
      : {}
    benchmarkCase = {
      schemaVersion: 2,
      id: caseId,
      kind: 'workflow-run',
      subjectRefs: [plan.subjectRef],
      task: { workflowRef: plan.subjectRef, input: parameters },
      checks: [{ type: 'secret-scan', allow: false }],
      costRisk: 'standard',
      approvalPolicy: 'bypass-safe',
      timeoutMs: WORKFLOW_RUN_TIMEOUT_MS,
      description: `Replay regression for ${proposal.title}: the workflow must complete after the fix.`,
      provenance,
    }
    note = plan.replayCandidateId
      ? `Replays ${plan.subjectRef} with the redacted parameters recorded by replay candidate ${plan.replayCandidateId}. It should fail while the original failure reproduces and pass after the fix.`
      : `Replays ${plan.subjectRef} with empty parameters. Review parameters before treating a pass as proof of the fix.`
  } else if (plan.kind === 'tool-call') {
    benchmarkCase = {
      schemaVersion: 2,
      id: caseId,
      kind: 'tool-call',
      subjectRefs: [plan.subjectRef],
      task: { toolRef: plan.subjectRef, input: {} },
      checks: [
        { type: 'stdout-contains', value: '"ok": true' },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'cheap',
      approvalPolicy: 'bypass-safe',
      timeoutMs: TOOL_CALL_TIMEOUT_MS,
      description: `Preflight regression for ${proposal.title}: the generated preflight must report ok=true once the failing tool contract is repaired.`,
      provenance,
    }
    note =
      'Runs the generated preflight tool for real (requires MATOS_RUN_REAL_BENCHMARKS=1) and asserts the target tool asset contract holds.'
  } else {
    const artifactPath = runbookArtifactPath(proposal)
    if (!artifactPath) {
      throw new Error(
        `Evolution proposal ${proposal.proposalId} plans an artifact-check benchmark but has no runbook asset.`,
      )
    }
    benchmarkCase = {
      schemaVersion: 2,
      id: caseId,
      kind: 'artifact-check',
      subjectRefs: [plan.subjectRef],
      task: { input: { path: artifactPath } },
      checks: [
        { type: 'stdout-contains', value: proposal.episodeId },
        { type: 'stdout-contains', value: proposal.proposalId },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'free',
      approvalPolicy: 'bypass-safe',
      timeoutMs: ARTIFACT_CHECK_TIMEOUT_MS,
      description: `Runbook integrity regression for ${proposal.title}: the drafted runbook must persist the episode and proposal provenance.`,
      provenance,
    }
    note =
      'Free artifact-check over the generated runbook; it fails while the draft pack is missing and passes once draft-assets ran.'
  }

  // Guarantee the drafted case stays loadable by the shared runner.
  normalizeMatOSBenchmarkCase(benchmarkCase)

  const casePath = join(
    matOSEvolutionProposalBenchmarkDir(input.cwd, proposal.proposalId),
    CASE_FILE,
  )
  await writeGeneratedAssetFile(
    casePath,
    `${JSON.stringify(benchmarkCase, null, 2)}\n`,
  )
  const updated = await updateMatOSEvolutionProposalGates(
    input.cwd,
    proposal.proposalId,
    {
      benchmark: {
        status: 'drafted',
        caseId,
        casePath,
        at: new Date().toISOString(),
      },
    },
  )
  return {
    proposalId: proposal.proposalId,
    case: benchmarkCase,
    casePath,
    note,
    proposal: updated,
  }
}

export async function readMatOSEvolutionBenchmarkCase(
  cwd: string,
  proposalId: string,
): Promise<{ case: MatOSEvolutionBenchmarkCase; casePath: string } | undefined> {
  const casePath = join(
    matOSEvolutionProposalBenchmarkDir(cwd, proposalId),
    CASE_FILE,
  )
  try {
    await lstat(casePath)
  } catch {
    return undefined
  }
  const parsed = JSON.parse(
    await readFile(casePath, 'utf8'),
  ) as MatOSEvolutionBenchmarkCase
  return { case: parsed, casePath }
}

/**
 * Runs the drafted benchmark case through the shared runner and records the
 * outcome on the proposal validation gate. Gated kinds (workflow-run,
 * tool-call) report `blocked` unless MATOS_RUN_REAL_BENCHMARKS=1; the free
 * artifact-check kind always executes.
 */
export async function runMatOSEvolutionBenchmarkRegression(input: {
  cwd: string
  proposalId: string
}): Promise<MatOSEvolutionBenchmarkRegression> {
  const proposal = await readMatOSEvolutionProposal(input.cwd, input.proposalId)
  if (!proposal) {
    throw new Error(`MatOS evolution proposal not found: ${input.proposalId}`)
  }
  const drafted = await readMatOSEvolutionBenchmarkCase(
    input.cwd,
    input.proposalId,
  )
  if (!drafted) {
    throw new Error(
      `Evolution proposal ${input.proposalId} has no drafted benchmark case. Run: matos evolve benchmarks draft --proposal ${input.proposalId} --json`,
    )
  }
  const benchmarkRef = `evolution-proposal:${proposal.proposalId}`
  const result = await runMatOSBenchmarkCase({
    cwd: input.cwd,
    benchmarkRef,
    casePath: drafted.casePath,
    timeoutMs: drafted.case.timeoutMs,
  })
  await writeGeneratedAssetFile(
    join(
      matOSEvolutionProposalBenchmarkDir(input.cwd, proposal.proposalId),
      'result.json',
    ),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  const updated = await updateMatOSEvolutionProposalGates(
    input.cwd,
    proposal.proposalId,
    {
      validation: {
        status:
          result.status === 'succeeded'
            ? 'succeeded'
            : result.status === 'blocked'
              ? 'blocked'
              : 'failed',
        ok: result.ok,
        resultId: result.resultId,
        resultPath: result.resultPath,
        at: new Date().toISOString(),
        ...(result.evidence.message ? { reason: result.evidence.message } : {}),
      },
    },
  )
  return {
    proposalId: proposal.proposalId,
    benchmarkRef,
    casePath: drafted.casePath,
    result,
    proposal: updated,
  }
}

export type MatOSFailure2AssetFactoryResult = {
  episodeId: string
  proposals: Array<{
    proposalId: string
    action: string
    draftAssets: {
      applied: boolean
      status: string
      targetPackPath: string
      assetRefs: string[]
      reason?: string
    }
    benchmark: {
      caseId: string
      casePath: string
      kind: string
      note: string
    }
    regression: {
      status: string
      ok: boolean
      resultPath: string
      message?: string
    }
    gates: MatOSEvolutionProposal['gates']
  }>
}

/**
 * One-shot Failure2Asset factory: episode -> proposals -> draft asset pack ->
 * benchmark draft -> regression run. Each stage records its gate on the
 * proposal so partial factories stay resumable through the stage commands.
 */
export async function runMatOSFailure2AssetFactory(input: {
  cwd: string
  episodeId: string
}): Promise<MatOSFailure2AssetFactoryResult> {
  const { generateMatOSEvolutionProposals, generateMatOSEvolutionDraftAssets } =
    await import('./proposalDrafts.js')
  const generated = await generateMatOSEvolutionProposals({
    cwd: input.cwd,
    episodeId: input.episodeId,
  })
  const results: MatOSFailure2AssetFactoryResult['proposals'] = []
  for (const proposal of generated.proposals) {
    const draftAssets = await generateMatOSEvolutionDraftAssets({
      cwd: input.cwd,
      proposalId: proposal.proposalId,
    })
    const benchmark = await draftMatOSEvolutionBenchmark({
      cwd: input.cwd,
      proposalId: proposal.proposalId,
    })
    const regression = await runMatOSEvolutionBenchmarkRegression({
      cwd: input.cwd,
      proposalId: proposal.proposalId,
    })
    results.push({
      proposalId: proposal.proposalId,
      action: proposal.action,
      draftAssets: {
        applied: draftAssets.applied,
        status: draftAssets.status,
        targetPackPath: draftAssets.targetPackPath,
        assetRefs: draftAssets.assetRefs,
        ...(draftAssets.reason ? { reason: draftAssets.reason } : {}),
      },
      benchmark: {
        caseId: benchmark.case.id,
        casePath: benchmark.casePath,
        kind: benchmark.case.kind,
        note: benchmark.note,
      },
      regression: {
        status: regression.result.status,
        ok: regression.result.ok,
        resultPath: regression.result.resultPath,
        ...(regression.result.evidence.message
          ? { message: regression.result.evidence.message }
          : {}),
      },
      gates: regression.proposal.gates,
    })
  }
  return { episodeId: input.episodeId, proposals: results }
}
