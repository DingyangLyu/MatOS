import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listMatOSAlgorithmRegressionRecords } from '../algorithms/regression.js'
import { resolveMatOSDeploymentRoots } from '../runtime/deploymentRoots.js'
import { listMatOSDirectAssetEditorRuns } from './directAssetEditor.js'
import { listMatOSExperienceAssets } from './experienceAssets.js'
import {
  listMatOSStableImprovementCandidates,
  listMatOSWorkflowReplayClusters,
} from './replayCandidates.js'

/**
 * Read-only cross-user self-evolution daily report.
 *
 * It aggregates evolution records that ALREADY exist under each user's runtime
 * scope (`<runtimeDataDir>/scopes/users/<id>/workspace-state/shared/.matos/...`)
 * into one operator-facing report. The highest-value cross-user signal is
 * grouping repeated-failure replay clusters by failure signature across users.
 *
 * This slice is intentionally read-only: it does not promote, edit, govern, or
 * mutate anything. It never reads another scope's private data into a per-user
 * surface beyond aggregate counts, and the CLI output is redacted.
 */

export type MatOSEvolutionDailyReportUser = {
  userId: string
  scopeRef: string
  directEdits: {
    total: number
    accepted: number
    rolledBack: number
    edited: number
    noop: number
    blocked: number
    activeBlocked: number
    legacyBlocked: number
    failed: number
    effective: number
  }
  experiences: number
  replayClusters: number
  stableImprovementCandidates: number
}

export type MatOSEvolutionCrossUserFailureCluster = {
  failureSignature: string
  workflowRefs: string[]
  users: string[]
  userCount: number
  totalOccurrences: number
  clusterCount: number
}

export type MatOSEvolutionDailyReportEdit = {
  userId: string
  runId: string
  status: string
  rawStatus?: string
  statusReason?: string
  effective: boolean
  assets: string[]
  updatedAt: string
}

export type MatOSEvolutionDailyReportPromotionCandidate = {
  userId: string
  sourceScopeRef: string
  targetScope: 'global'
  reason: 'accepted_user_local_direct_edit'
  runId: string
  status: string
  assets: string[]
  summary: string
  evidenceRefs: string[]
  updatedAt: string
  diffPatchPath?: string
  semanticConfidence?: number
  sourceAcceptance?: Array<{
    sourceId: string
    acceptedBranch: string
    commit: string
    ok: boolean
    pushed: boolean
    validationOk: boolean
  }>
}

export type MatOSEvolutionDailyReportAssetChangeSummary = {
  total: number
  byType: Record<string, number>
}

export type MatOSEvolutionDailyReportAlgorithmRegression = {
  userId: string
  regressionId: string
  createdAt: string
  trigger: string
  status: string
  overallOk: boolean
  benchmarkCount: number
  failedBenchmarkRefs: string[]
}

export type MatOSEvolutionDailyReport = {
  mode: 'evolution-daily-report'
  generatedAt: string
  deployRoot: string
  runtimeDataDir: string
  usersScanned: number
  since?: string
  totals: {
    users: number
    directEdits: number
    accepted: number
    rolledBack: number
    effectiveDirectEdits: number
    blocked: number
    activeBlocked: number
    legacyBlocked: number
    failed: number
    experiences: number
    replayClusters: number
    stableImprovementCandidates: number
    promotionCandidates: number
    crossUserFailureClusters: number
    algorithmRegressions: number
    failedAlgorithmRegressions: number
    assetChanges: {
      created: MatOSEvolutionDailyReportAssetChangeSummary
      updated: MatOSEvolutionDailyReportAssetChangeSummary
    }
  }
  users: MatOSEvolutionDailyReportUser[]
  crossUserFailureClusters: MatOSEvolutionCrossUserFailureCluster[]
  recentDirectEdits: MatOSEvolutionDailyReportEdit[]
  promotionCandidates: MatOSEvolutionDailyReportPromotionCandidate[]
  algorithmRegressions: MatOSEvolutionDailyReportAlgorithmRegression[]
  notes: string[]
}

export type MatOSEvolutionDailyReportInput = {
  cwd: string
  env?: Record<string, string | undefined>
  deployRoot?: string
  runtimeDataDir?: string
  since?: string
  /** Test/override hook: explicit user scope cwds instead of scanning the deploy root. */
  userScopes?: Array<{ userId: string; cwd: string }>
  recentEditLimit?: number
}

const RECENT_EDIT_DEFAULT_LIMIT = 20

function isEffectiveDirectEditorStatus(status: string): boolean {
  return (
    status === 'accepted' ||
    status === 'accepted_merged' ||
    status === 'edited' ||
    status === 'validated'
  )
}

function isAcceptedDirectEditorStatus(status: string): boolean {
  return status === 'accepted' || status === 'accepted_merged'
}

function isBlockedDirectEditorStatus(status: string): boolean {
  return status === 'blocked' || status === 'pending_merge'
}

function isLegacyBlockedDirectEditorRun(run: {
  status: string
  statusReason?: string
}): boolean {
  return (
    isBlockedDirectEditorStatus(run.status) &&
    typeof run.statusReason === 'string' &&
    run.statusReason.startsWith('legacy_')
  )
}

function emptyAssetChangeSummary(): MatOSEvolutionDailyReportAssetChangeSummary {
  return { total: 0, byType: {} }
}

function assetTypeFromRef(ref: string): string {
  const separator = ref.indexOf(':')
  if (separator <= 0) {
    return 'unknown'
  }
  const type = ref.slice(0, separator).trim()
  return type || 'unknown'
}

function addAssetRefs(
  summary: MatOSEvolutionDailyReportAssetChangeSummary,
  refs: string[],
): void {
  for (const ref of refs) {
    summary.total += 1
    const type = assetTypeFromRef(ref)
    summary.byType[type] = (summary.byType[type] ?? 0) + 1
  }
}

function afterSince(timestamp: string | undefined, since?: number): boolean {
  if (since === undefined) {
    return true
  }
  if (!timestamp) {
    return false
  }
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed >= since : false
}

function resolveRuntimeDataDir(input: MatOSEvolutionDailyReportInput): {
  deployRoot: string
  runtimeDataDir: string
} {
  if (input.runtimeDataDir) {
    return { deployRoot: input.deployRoot ?? '', runtimeDataDir: input.runtimeDataDir }
  }
  if (input.deployRoot) {
    return {
      deployRoot: input.deployRoot,
      runtimeDataDir: join(input.deployRoot, 'runtime'),
    }
  }
  const roots = resolveMatOSDeploymentRoots(input.env ?? process.env)
  return { deployRoot: roots.deployRoot, runtimeDataDir: roots.runtimeDataDir }
}

async function listUserScopes(
  runtimeDataDir: string,
): Promise<Array<{ userId: string; cwd: string }>> {
  const usersDir = join(runtimeDataDir, 'scopes', 'users')
  let entries: string[]
  try {
    entries = await readdir(usersDir)
  } catch {
    return []
  }
  const scopes: Array<{ userId: string; cwd: string }> = []
  for (const entry of entries.sort()) {
    const userRoot = join(usersDir, entry)
    try {
      const info = await stat(userRoot)
      if (!info.isDirectory()) {
        continue
      }
    } catch {
      continue
    }
    scopes.push({
      userId: entry,
      cwd: join(userRoot, 'workspace-state', 'shared'),
    })
  }
  return scopes
}

export async function buildMatOSEvolutionDailyReport(
  input: MatOSEvolutionDailyReportInput,
): Promise<MatOSEvolutionDailyReport> {
  const { deployRoot, runtimeDataDir } = resolveRuntimeDataDir(input)
  const sinceMs = input.since ? Date.parse(input.since) : undefined
  const sinceFilter = Number.isFinite(sinceMs) ? (sinceMs as number) : undefined
  const notes: string[] = []
  if (input.since && sinceFilter === undefined) {
    notes.push(`Ignored unparseable --since value: ${input.since}`)
  }

  const scopes =
    input.userScopes ?? (await listUserScopes(runtimeDataDir))
  if (scopes.length === 0) {
    notes.push(
      `No user scopes found under ${join(runtimeDataDir, 'scopes', 'users')}.`,
    )
  }

  const users: MatOSEvolutionDailyReportUser[] = []
  const recentEdits: MatOSEvolutionDailyReportEdit[] = []
  const promotionCandidates: MatOSEvolutionDailyReportPromotionCandidate[] = []
  const assetChanges = {
    created: emptyAssetChangeSummary(),
    updated: emptyAssetChangeSummary(),
  }
  const failureClusters = new Map<
    string,
    {
      failureSignature: string
      workflowRefs: Set<string>
      users: Set<string>
      totalOccurrences: number
      clusterCount: number
    }
  >()

  const algorithmRegressions: MatOSEvolutionDailyReportAlgorithmRegression[] = []

  for (const scope of scopes) {
    const [editorRuns, experiences, replayClusters, stableCandidates, scopeRegressions] =
      await Promise.all([
        listMatOSDirectAssetEditorRuns(scope.cwd).catch(() => []),
        listMatOSExperienceAssets(scope.cwd).catch(() => []),
        listMatOSWorkflowReplayClusters(scope.cwd).catch(() => []),
        listMatOSStableImprovementCandidates(scope.cwd).catch(() => []),
        listMatOSAlgorithmRegressionRecords(scope.cwd).catch(
          () => [] as Awaited<ReturnType<typeof listMatOSAlgorithmRegressionRecords>>,
        ),
      ])

    for (const regression of scopeRegressions) {
      if (!afterSince(regression.createdAt, sinceFilter)) {
        continue
      }
      algorithmRegressions.push({
        userId: scope.userId,
        regressionId: regression.regressionId,
        createdAt: regression.createdAt,
        trigger: regression.trigger.runId
          ? `${regression.trigger.kind}(${regression.trigger.runId})`
          : regression.trigger.kind,
        status: regression.status,
        overallOk: regression.overallOk,
        benchmarkCount: regression.benchmarks.length,
        failedBenchmarkRefs: regression.benchmarks
          .filter(benchmark => benchmark.status === 'failed')
          .map(benchmark => benchmark.benchmarkRef),
      })
    }

    const edits = editorRuns.filter(run => afterSince(run.updatedAt, sinceFilter))
    const effectiveEdits = edits.filter(run =>
      isEffectiveDirectEditorStatus(run.status),
    )
    const legacyBlocked = edits.filter(run =>
      isLegacyBlockedDirectEditorRun(run),
    ).length
    const blocked = edits.filter(run =>
      isBlockedDirectEditorStatus(run.status),
    ).length
    const directEdits = {
      total: edits.length,
      accepted: edits.filter(
        run => run.status === 'accepted' || run.status === 'accepted_merged',
      ).length,
      rolledBack: edits.filter(
        run => run.status === 'rolled_back' || run.status === 'rollback_failed',
      ).length,
      edited: edits.filter(
        run => run.status === 'edited' || run.status === 'validated',
      ).length,
      noop: edits.filter(run => run.status === 'noop').length,
      blocked,
      activeBlocked: blocked - legacyBlocked,
      legacyBlocked,
      failed: edits.filter(run => run.status === 'failed').length,
      effective: effectiveEdits.length,
    }
    for (const run of edits) {
      const effective = isEffectiveDirectEditorStatus(run.status)
      const assets = [...new Set([...run.createdAssets, ...run.updatedAssets])]
      if (effective) {
        addAssetRefs(assetChanges.created, run.createdAssets)
        addAssetRefs(assetChanges.updated, run.updatedAssets)
      }
      if (isAcceptedDirectEditorStatus(run.status) && assets.length > 0) {
        promotionCandidates.push({
          userId: scope.userId,
          sourceScopeRef: `user:${scope.userId}`,
          targetScope: 'global',
          reason: 'accepted_user_local_direct_edit',
          runId: run.runId,
          status: run.status,
          assets,
          summary: run.editorOutput.summary,
          evidenceRefs: run.evidenceRefs,
          updatedAt: run.updatedAt,
          ...(run.diffPatchPath ? { diffPatchPath: run.diffPatchPath } : {}),
          ...(typeof run.semanticAcceptance?.confidence === 'number'
            ? { semanticConfidence: run.semanticAcceptance.confidence }
            : {}),
          ...(Array.isArray(run.sourceAcceptance) &&
          run.sourceAcceptance.length > 0
            ? {
                sourceAcceptance: run.sourceAcceptance.map(item => ({
                  sourceId: item.sourceId,
                  acceptedBranch: item.acceptedBranch,
                  commit: item.commit,
                  ok: item.ok,
                  pushed: item.pushed,
                  validationOk: item.validationOk,
                })),
              }
            : {}),
        })
      }
      recentEdits.push({
        userId: scope.userId,
        runId: run.runId,
        status: run.status,
        ...(run.rawStatus ? { rawStatus: run.rawStatus } : {}),
        ...(run.statusReason ? { statusReason: run.statusReason } : {}),
        effective,
        assets,
        updatedAt: run.updatedAt,
      })
    }

    // Only count experiences that physically live under this user's scope cwd,
    // so bundled/global experiences are not attributed to every user.
    const scopedExperiences = experiences.filter(
      experience =>
        typeof experience.sourcePath === 'string' &&
        experience.sourcePath.startsWith(scope.cwd),
    )

    const scopedClusters = replayClusters.filter(cluster =>
      afterSince(cluster.lastSeenAt, sinceFilter),
    )
    for (const cluster of scopedClusters) {
      const existing = failureClusters.get(cluster.failureSignature) ?? {
        failureSignature: cluster.failureSignature,
        workflowRefs: new Set<string>(),
        users: new Set<string>(),
        totalOccurrences: 0,
        clusterCount: 0,
      }
      existing.workflowRefs.add(cluster.workflowRef)
      existing.users.add(scope.userId)
      existing.totalOccurrences += cluster.occurrences
      existing.clusterCount += 1
      failureClusters.set(cluster.failureSignature, existing)
    }

    const scopedCandidates = stableCandidates.filter(candidate =>
      afterSince(candidate.updatedAt, sinceFilter),
    )

    users.push({
      userId: scope.userId,
      scopeRef: `user:${scope.userId}`,
      directEdits,
      experiences: scopedExperiences.length,
      replayClusters: scopedClusters.length,
      stableImprovementCandidates: scopedCandidates.length,
    })
  }

  const crossUserFailureClusters: MatOSEvolutionCrossUserFailureCluster[] = [
    ...failureClusters.values(),
  ]
    .map(entry => ({
      failureSignature: entry.failureSignature,
      workflowRefs: [...entry.workflowRefs].sort(),
      users: [...entry.users].sort(),
      userCount: entry.users.size,
      totalOccurrences: entry.totalOccurrences,
      clusterCount: entry.clusterCount,
    }))
    .sort(
      (a, b) =>
        b.userCount - a.userCount ||
        b.totalOccurrences - a.totalOccurrences ||
        a.failureSignature.localeCompare(b.failureSignature),
    )

  recentEdits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  promotionCandidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const recentDirectEdits = recentEdits.slice(
    0,
    input.recentEditLimit ?? RECENT_EDIT_DEFAULT_LIMIT,
  )

  const totals = {
    users: users.length,
    directEdits: users.reduce((sum, user) => sum + user.directEdits.total, 0),
    accepted: users.reduce((sum, user) => sum + user.directEdits.accepted, 0),
    rolledBack: users.reduce(
      (sum, user) => sum + user.directEdits.rolledBack,
      0,
    ),
    effectiveDirectEdits: users.reduce(
      (sum, user) => sum + user.directEdits.effective,
      0,
    ),
    blocked: users.reduce((sum, user) => sum + user.directEdits.blocked, 0),
    activeBlocked: users.reduce(
      (sum, user) => sum + user.directEdits.activeBlocked,
      0,
    ),
    legacyBlocked: users.reduce(
      (sum, user) => sum + user.directEdits.legacyBlocked,
      0,
    ),
    failed: users.reduce((sum, user) => sum + user.directEdits.failed, 0),
    experiences: users.reduce((sum, user) => sum + user.experiences, 0),
    replayClusters: users.reduce((sum, user) => sum + user.replayClusters, 0),
    stableImprovementCandidates: users.reduce(
      (sum, user) => sum + user.stableImprovementCandidates,
      0,
    ),
    promotionCandidates: promotionCandidates.length,
    crossUserFailureClusters: crossUserFailureClusters.length,
    algorithmRegressions: algorithmRegressions.length,
    failedAlgorithmRegressions: algorithmRegressions.filter(
      regression => !regression.overallOk,
    ).length,
    assetChanges,
  }

  algorithmRegressions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return {
    mode: 'evolution-daily-report',
    generatedAt: new Date().toISOString(),
    deployRoot,
    runtimeDataDir,
    usersScanned: scopes.length,
    ...(input.since ? { since: input.since } : {}),
    totals,
    users,
    crossUserFailureClusters,
    recentDirectEdits,
    promotionCandidates,
    algorithmRegressions: algorithmRegressions.slice(
      0,
      input.recentEditLimit ?? RECENT_EDIT_DEFAULT_LIMIT,
    ),
    notes,
  }
}
