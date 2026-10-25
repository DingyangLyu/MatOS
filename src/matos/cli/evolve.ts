/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  abortMatOSDirectAssetEditorPendingMerge,
  applyMatOSDirectAssetEditorPendingMerge,
  approveMatOSDirectAssetEditorProposal,
  findMatOSDirectAssetEditorPendingMerge,
  inspectMatOSDirectAssetEditorScope,
  listMatOSDirectAssetEditorPendingMerges,
  listMatOSDirectAssetEditorRuns,
  readMatOSDirectAssetEditorRun,
  rebaselineMatOSDirectAssetEditorScope,
  recoverInterruptedMatOSDirectAssetEditorRun,
  rejectMatOSDirectAssetEditorProposal,
  rollbackMatOSDirectAssetEditorRun,
} from '../learning/directAssetEditor.js'
import {
  isMatOSEvolutionApprovalMode,
  MATOS_EVOLUTION_APPROVAL_MODES,
  resolveMatOSEvolutionApprovalMode,
  writeMatOSEvolutionApprovalPolicy,
} from '../learning/evolutionApprovalPolicy.js'
import { assertSafeEvolutionRecordId } from '../learning/evolutionRecordPaths.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { resolveMatOSEvolutionProvider } from '../learning/evolutionProvider.js'
import {
  listMatOSSelfEvolutionMonitorRecords,
  readMatOSSelfEvolutionMonitorRecord,
} from '../learning/evolutionMonitor.js'
import { computeMatOSEvolutionEffectivenessRecurrence } from '../learning/evolutionEffectiveness.js'
import { listMatOSExperienceAssets } from '../learning/experienceAssets.js'
import { submitMatOSOdMemoryFeedback } from '../learning/odMemoryFeedback.js'
import { buildMatOSEvolutionDailyReport } from '../learning/dailyReport.js'
import { buildMatOSEvolutionCostReport } from '../learning/evolutionCostLedger.js'
import { buildMatOSEvolutionReport } from '../learning/evolutionReport.js'
import {
  MATOS_EVOLVE_GC_APPLY_ENV,
  runMatOSEvolutionGc,
} from '../learning/evolutionGc.js'
import {
  listMatOSStableImprovementCandidates,
  listMatOSWorkflowReplayCandidates,
  listMatOSWorkflowReplayClusters,
  readMatOSStableImprovementCandidate,
  readMatOSWorkflowReplayCandidate,
  readMatOSWorkflowReplayCluster,
} from '../learning/replayCandidates.js'
import { getMatOSDir } from '../project.js'

type MatOSEvolveIO = {
  cwd: string
  env?: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

type ParsedEvolveArgs = {
  positionals: string[]
  json: boolean
  compact: boolean
  help: boolean
  limit?: number
  offset?: number
  note?: string
}

function parseArgs(args: string[]): ParsedEvolveArgs {
  const positionals: string[] = []
  let json = false
  let compact = false
  let help = false
  let limit: number | undefined
  let offset: number | undefined
  let note: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--compact') {
      compact = true
      continue
    }
    if (arg === '--limit') {
      limit = parseNonNegativeInteger(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--limit=')) {
      limit = parseNonNegativeInteger(arg.slice('--limit='.length))
      continue
    }
    if (arg === '--offset') {
      offset = parseNonNegativeInteger(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--offset=')) {
      offset = parseNonNegativeInteger(arg.slice('--offset='.length))
      continue
    }
    if (arg === '--note') {
      note = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--note=')) {
      note = arg.slice('--note='.length)
      continue
    }
    if (arg.startsWith('--')) {
      continue
    }
    positionals.push(arg)
  }
  return { positionals, json, compact, help, limit, offset, ...(note ? { note } : {}) }
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined
  }
  return parsed
}

function writeJson(io: MatOSEvolveIO, value: unknown): void {
  io.stdout(
    `${JSON.stringify(redactMatOSAssetOutput(value, { cwd: io.cwd }), null, 2)}\n`,
  )
}

function redactCostReportValue(
  value: unknown,
  cwd: string,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') {
    return redactMatOSAssetOutput(value, { cwd })
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '<circular>'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const redactedArray = value.map(item =>
      redactCostReportValue(item, cwd, seen),
    )
    seen.delete(value)
    return redactedArray
  }
  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactCostReportValue(item, cwd, seen)
  }
  seen.delete(value)
  return redacted
}

function writeCostJson(io: MatOSEvolveIO, value: unknown): void {
  io.stdout(
    `${JSON.stringify(redactCostReportValue(value, io.cwd), null, 2)}\n`,
  )
}

function printHelp(io: MatOSEvolveIO): void {
  io.stdout(`Usage:
  matos evolve status [--json]
  matos evolve policy [off|manual|auto] [--json]
  matos evolve experiences list [--json]
  matos evolve experiences show <experience-ref-or-id> [--json]
  matos evolve direct-editor list [--json]
  matos evolve direct-editor show <run-id> [--json]
  matos evolve direct-editor recover <run-id> [--json]
  matos evolve direct-editor rollback <run-id> [--json]
  matos evolve direct-editor approve <run-id> [--note <text>] [--json]
  matos evolve direct-editor reject <run-id> [--note <text>] [--json]
  matos evolve direct-editor merge list [--json]
  matos evolve direct-editor merge show <run-id> [--json]
  matos evolve direct-editor merge apply <run-id> <current|edit|base> [--json]
  matos evolve direct-editor merge abort <run-id> [--json]
  matos evolve direct-editor rebaseline [--json]
  matos evolve direct-editor sync [--json]
  matos evolve monitor list [--json]
  matos evolve monitor show <record-id> [--json]
  matos evolve feedback submit --memory-id <id> --memory-type <type> --title <text> --detail <text> [--extraction-source <src>] [--conversation <ref>] [--project <ref>] [--json]
  matos evolve replay-candidates list [--json]
  matos evolve replay-candidates show <candidate-id> [--json]
  matos evolve replay-clusters list [--json]
  matos evolve replay-clusters show <cluster-id> [--json]
  matos evolve improvement-candidates list [--json]
  matos evolve improvement-candidates show <candidate-id> [--json]
  matos evolve intake repo|paper --path <source> [--llm-assist] [--model <model>] [--json]
  matos evolve intake user-test-logs [--scope user:<id>] [--since <iso|24h|7d>] [--session <id>] [--trace <id>] [--run-id <id>] [--limit <n>] [--json]
  matos evolve proposals generate --episode <episode-id> [--json]
  matos evolve proposals list [--json]
  matos evolve proposals show <proposal-id> [--json]
  matos evolve draft-assets --proposal <proposal-id> [--json]
  matos evolve benchmarks draft --proposal <proposal-id> [--json]
  matos evolve benchmarks run --proposal <proposal-id> [--json]
  matos evolve factory --episode <episode-id> [--json]
  matos evolve cost [--json]
  matos evolve daily-report [--deploy-root <path>] [--runtime-data-dir <path>] [--since <iso>] [--json]
  matos evolve report [--window-days <n>] [--runtime-data-dir <path>] [--json]   (exit 3 when health=degraded)
  matos evolve gc [--dry-run|--apply] [--keep-days <n>] [--keep-runs <n>] [--json]

MatOS self-evolution is direct-editor-first: critic-approved feedback and
workflow evidence directly update scoped role, skill, workflow, tool, MCP and
knowledge assets. The approval policy decides how far it goes on its own: off
(no automatic runs), manual (gate-passing edits wait as proposals for
direct-editor approve/reject) or auto (gate-passing edits are accepted).
Experience assets are optional and disabled by default. Repeated
same-signature workflow failures group into replay clusters, and reproduced
clusters become improvement candidates. Failure2Asset turns teaching episodes
into draft-first proposals, generated asset packs and replayable regression
benchmarks (proposals generate -> draft-assets -> benchmarks draft/run, or the
one-shot factory).
`)
}

function matchesExperienceRef(
  experience: Awaited<ReturnType<typeof listMatOSExperienceAssets>>[number],
  refOrId: string,
): boolean {
  return (
    experience.ref === refOrId ||
    experience.id === refOrId ||
    experience.ref.startsWith(`${refOrId}@`) ||
    experience.ref === `experience:${refOrId}@${experience.version}` ||
    experience.ref.startsWith(`experience:${refOrId}@`)
  )
}

function pageItems<T>(
  items: T[],
  parsed: ParsedEvolveArgs,
): { items: T[]; page: { limit: number; offset: number; total: number; nextOffset?: number } } {
  const total = items.length
  const offset = Math.min(parsed.offset ?? 0, total)
  const limit = parsed.limit ?? total
  const end = Math.min(offset + limit, total)
  return {
    items: items.slice(offset, end),
    page: {
      limit,
      offset,
      total,
      ...(end < total ? { nextOffset: end } : {}),
    },
  }
}

function compactExperience(
  experience: Awaited<ReturnType<typeof listMatOSExperienceAssets>>[number],
): Record<string, unknown> {
  return {
    ref: experience.ref,
    id: experience.id,
    name: experience.name,
    version: experience.version,
    description: experience.description,
    lifecycle: experience.lifecycle,
    manifestPath: experience.manifestPath,
    entryPath: experience.entryPath,
    sourcePath: experience.sourcePath,
    mergeKey: experience.mergeKey,
    evidenceCount: experience.evidenceCount,
    signalKinds: experience.signalKinds,
  }
}

function compactDirectEditorRun(
  run: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>[number],
): Record<string, unknown> {
  return {
    runId: run.runId,
    status: run.status,
    rawStatus: run.rawStatus,
    statusReason: run.statusReason,
    scope: run.scope,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.editorOutput?.summary,
    modifiedFiles: run.modifiedFiles,
    createdAssets: run.createdAssets,
    updatedAssets: run.updatedAssets,
    disabledAssets: run.disabledAssets,
    mergeMode: run.mergeMode,
    pendingMerge: run.pendingMerge,
    mergeConflicts: run.mergeConflicts,
  }
}

function compactMonitorRecord(
  record: Awaited<ReturnType<typeof listMatOSSelfEvolutionMonitorRecords>>[number],
): Record<string, unknown> {
  return {
    recordId: record.recordId,
    sessionId: record.sessionId,
    triggerKind: record.triggerKind,
    triggerKey: record.triggerKey,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    summary: record.summary,
    eventId: record.eventId,
    directEditorRunId: record.directEditorRunId,
    experienceRefs: record.experienceRefs,
  }
}

type CompactDirectEditorRebaseline = {
  status: string
  scope: string
  previousStableSnapshot?: string
  previousStableCommit?: string
  snapshot?: {
    snapshotId: string
    kind: string
    scope: string
    commit: string
    parentCommit?: string
    ref?: string
    createdAt: string
    assetCount: number
    fileCount: number
  }
  validation?: {
    ok: boolean
    gateProfile: string
    assetValidation: {
      ok: boolean
      errorCount: number
    }
    secretScan: {
      ok: boolean
      findingCount: number
    }
    workflowValidationCount: number
    smoke?: {
      ok: boolean
      errorCount: number
    }
  }
  error?: string
}

function compactDirectEditorRebaseline(
  rebaseline: Awaited<ReturnType<typeof rebaselineMatOSDirectAssetEditorScope>>,
): CompactDirectEditorRebaseline {
  return {
    status: rebaseline.status,
    scope: rebaseline.scope,
    ...(rebaseline.previousStableSnapshot
      ? { previousStableSnapshot: rebaseline.previousStableSnapshot }
      : {}),
    ...(rebaseline.previousStableCommit
      ? { previousStableCommit: rebaseline.previousStableCommit }
      : {}),
    ...(rebaseline.snapshot
      ? {
          snapshot: {
            snapshotId: rebaseline.snapshot.snapshotId,
            kind: rebaseline.snapshot.kind,
            scope: rebaseline.snapshot.scope,
            commit: rebaseline.snapshot.commit,
            ...(rebaseline.snapshot.parentCommit
              ? { parentCommit: rebaseline.snapshot.parentCommit }
              : {}),
            ...(rebaseline.snapshot.ref ? { ref: rebaseline.snapshot.ref } : {}),
            createdAt: rebaseline.snapshot.createdAt,
            assetCount: rebaseline.snapshot.assetRefs.length,
            fileCount: rebaseline.snapshot.files.length,
          },
        }
      : {}),
    ...(rebaseline.validation
      ? {
          validation: {
            ok: rebaseline.validation.ok,
            gateProfile: rebaseline.validation.gateProfile,
            assetValidation: {
              ok: rebaseline.validation.assetValidation.ok,
              errorCount: rebaseline.validation.assetValidation.errors.length,
            },
            secretScan: {
              ok: rebaseline.validation.secretScan.ok,
              findingCount: rebaseline.validation.secretScan.findings.length,
            },
            workflowValidationCount: rebaseline.validation.workflowValidation.length,
            ...(rebaseline.validation.smoke
              ? {
                  smoke: {
                    ok: rebaseline.validation.smoke.errorCount === 0,
                    errorCount: rebaseline.validation.smoke.errorCount,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(rebaseline.error ? { error: rebaseline.error } : {}),
  }
}

function countDirectEditorRunStatuses(
  runs: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const run of runs) {
    counts[run.status] = (counts[run.status] ?? 0) + 1
  }
  return counts
}

function splitDirectEditorRunsByCurrentRelevance(
  runs: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>,
): {
  activeRuns: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>
  legacyRuns: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>
} {
  const activeRuns: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>> = []
  const legacyRuns: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>> = []
  for (const run of runs) {
    if (isLegacyBlockedDirectEditorRun(run)) {
      legacyRuns.push(run)
    } else {
      activeRuns.push(run)
    }
  }
  return { activeRuns, legacyRuns }
}

// Only genuinely terminal-successful statuses count as effective. `edited` and
// `validated` are interrupted-checkpoint statuses of crashed finalizes (see the
// direct-editor status taxonomy) and frequently become rolled_back after
// recovery, so counting them inflated effectiveness.
function isEffectiveDirectEditorStatus(status: string): boolean {
  return status === 'accepted' || status === 'accepted_merged'
}

function isBlockedDirectEditorStatus(status: string): boolean {
  return status === 'blocked' || status === 'pending_merge'
}

function isLegacyBlockedDirectEditorRun(
  run: Awaited<ReturnType<typeof listMatOSDirectAssetEditorRuns>>[number],
): boolean {
  return (
    isBlockedDirectEditorStatus(run.status) &&
    typeof run.statusReason === 'string' &&
    run.statusReason.startsWith('legacy_')
  )
}

type MatOSLegacyProvider1Status = {
  removed: true
  ignored: true
  active: false
  promotionPacketDir: string
  promotionPacketCount: number
  statusCounts: Record<string, number>
  replacementCommands: string[]
  summary: string
}

async function inspectLegacyProvider1Status(
  cwd: string,
): Promise<MatOSLegacyProvider1Status> {
  const promotionPacketDir = join(
    getMatOSDir(cwd),
    'internal',
    'evolution',
    'promotion-packets',
  )
  const statusCounts: Record<string, number> = {}
  let promotionPacketCount = 0
  const entries = await readdir(promotionPacketDir, {
    withFileTypes: true,
  }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    promotionPacketCount += 1
    try {
      const parsed = JSON.parse(
        await readFile(join(promotionPacketDir, entry.name), 'utf8'),
      ) as Record<string, unknown>
      const status =
        typeof parsed.status === 'string' && parsed.status.trim()
          ? parsed.status.trim()
          : 'unknown'
      statusCounts[status] = (statusCounts[status] ?? 0) + 1
    } catch {
      statusCounts.unreadable = (statusCounts.unreadable ?? 0) + 1
    }
  }
  return {
    removed: true,
    ignored: true,
    active: false,
    promotionPacketDir,
    promotionPacketCount,
    statusCounts,
    replacementCommands: [
      'matos evolve experiences list --json',
      'matos evolve direct-editor list --json',
      'matos evolve monitor list --json',
      'matos assets show <experience-ref> --json',
    ],
    summary:
      'Legacy native/provider1 promotion packets are removed from the active self-evolution provider and are ignored by MatOS. Use direct-editor runs, monitor records, and optional legacy experience assets instead.',
  }
}

async function handleStatus(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const provider = resolveMatOSEvolutionProvider(io.env ?? process.env)
  const directEditorRuns = await listMatOSDirectAssetEditorRuns(io.cwd)
  const experiences = await listMatOSExperienceAssets(io.cwd)
  const monitorRecords = await listMatOSSelfEvolutionMonitorRecords(io.cwd)
  const replayCandidates = await listMatOSWorkflowReplayCandidates(io.cwd)
  const replayClusters = await listMatOSWorkflowReplayClusters(io.cwd)
  const improvementCandidates = await listMatOSStableImprovementCandidates(io.cwd)
  const directEditorStatusCounts = countDirectEditorRunStatuses(directEditorRuns)
  const { activeRuns: directEditorActiveRuns, legacyRuns: directEditorLegacyRuns } =
    splitDirectEditorRunsByCurrentRelevance(directEditorRuns)
  const directEditorActiveStatusCounts =
    countDirectEditorRunStatuses(directEditorActiveRuns)
  const directEditorLegacyStatusCounts =
    countDirectEditorRunStatuses(directEditorLegacyRuns)
  const directEditorEffectiveCount = directEditorRuns.filter(run =>
    isEffectiveDirectEditorStatus(run.status),
  ).length
  const directEditorLegacyBlockedCount = directEditorLegacyRuns.length
  const directEditorBlockedCount = directEditorRuns.filter(run =>
    isBlockedDirectEditorStatus(run.status),
  ).length
  const directEditorActiveBlockedCount = directEditorActiveRuns.filter(run =>
    isBlockedDirectEditorStatus(run.status),
  ).length
  const legacyProvider1 = await inspectLegacyProvider1Status(io.cwd)
  // Post-acceptance trigger-key recurrence is always computed, without a
  // gating flag: when nothing was accepted inside the lookback the monitor
  // tree is not read at all, and otherwise the scan is bounded by the module's
  // session mtime skip + session cap, which is strictly cheaper than the full
  // monitor-ledger read this handler already performs above.
  const effectivenessRecurrence =
    await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: io.cwd,
      env: io.env ?? process.env,
      runs: directEditorRuns,
    })
  const directEditorHealth = await inspectMatOSDirectAssetEditorScope({
    cwd: io.cwd,
    scope: 'core',
  })
  const approval = await resolveMatOSEvolutionApprovalMode({
    cwd: io.cwd,
    ...(io.env ? { env: io.env } : {}),
  })
  const status = {
    provider: provider.id,
    // 'off' stops automatic self-evolution even when the provider is on.
    enabled: provider.enabled && approval.mode !== 'off',
    approvalMode: approval.mode,
    directEditScope: 'runtime-scope',
    directEditScopePolicy:
      'user/team/project scope first; core only for explicit core/developer runs',
    directEditorCoreHealth: directEditorHealth,
    directEditorHealth,
    experienceCount: experiences.length,
    directEditorRunCount: directEditorRuns.length,
    directEditorStatusCounts,
    directEditorActiveStatusCounts,
    directEditorLegacyStatusCounts,
    directEditorAcceptedCount:
      (directEditorStatusCounts.accepted ?? 0) +
      (directEditorStatusCounts.accepted_merged ?? 0),
    directEditorBlockedCount,
    directEditorActiveBlockedCount,
    directEditorLegacyBlockedCount,
    directEditorFailedCount: directEditorStatusCounts.failed ?? 0,
    directEditorEffectiveness: {
      effectiveCount: directEditorEffectiveCount,
      acceptedCount:
        (directEditorStatusCounts.accepted ?? 0) +
        (directEditorStatusCounts.accepted_merged ?? 0),
      editedCount:
        (directEditorStatusCounts.edited ?? 0) +
        (directEditorStatusCounts.validated ?? 0),
      blockedCount: directEditorBlockedCount,
      activeBlockedCount: directEditorActiveBlockedCount,
      legacyBlockedCount: directEditorLegacyBlockedCount,
      failedCount: directEditorStatusCounts.failed ?? 0,
      summary:
        directEditorLegacyBlockedCount > 0
          ? 'Legacy blocked direct-editor records are historical dirty-preflight evidence and are excluded from activeBlockedCount.'
          : 'No legacy blocked direct-editor records are present.',
    },
    effectivenessRecurrence,
    monitorRecordCount: monitorRecords.length,
    replayCandidateCount: replayCandidates.length,
    replayClusterCount: replayClusters.length,
    improvementCandidateCount: improvementCandidates.length,
    activePipeline: {
      provider: 'direct-editor',
      evidenceAssets: [],
      optionalEvidenceAssets: ['experience'],
      experienceLayerDefault: 'disabled',
      editableTargets: ['role', 'skill', 'workflow', 'tool', 'mcp', 'knowledge'],
      monitorRecords: true,
      directEditor: true,
      legacyProvider1Active: false,
      legacyProvider1Ignored: true,
      summary:
        'Active self-evolution uses critic-approved feedback and workflow evidence to drive direct-editor runs; experience assets are legacy/optional and disabled by default.',
    },
    legacyProvider1,
  }
  if (parsed.json) {
    writeJson(io, status)
  } else {
    io.stdout(
      [
        `provider=${status.provider}`,
        `enabled=${status.enabled ? 'yes' : 'no'}`,
        `approvalMode=${status.approvalMode}`,
        `directEditScope=${status.directEditScope}`,
        `directEditScopePolicy=${status.directEditScopePolicy}`,
        `directEditorHealth=${status.directEditorHealth.status}`,
        `directEditorNeedsRebaseline=${
          status.directEditorHealth.needsRebaseline ? 'yes' : 'no'
        }`,
        `experiences=${status.experienceCount}`,
        `directEditorRuns=${status.directEditorRunCount}`,
        `directEditorEffective=${status.directEditorEffectiveness.effectiveCount}`,
        `directEditorAccepted=${status.directEditorAcceptedCount}`,
        `directEditorBlocked=${status.directEditorActiveBlockedCount}`,
        `directEditorBlockedTotal=${status.directEditorBlockedCount}`,
        `directEditorActiveBlocked=${status.directEditorActiveBlockedCount}`,
        `directEditorLegacyBlocked=${status.directEditorLegacyBlockedCount}`,
        `directEditorFailed=${status.directEditorFailedCount}`,
        `effectivenessRecurrence=accepted:${effectivenessRecurrence.acceptedTotal} quiet:${effectivenessRecurrence.quiet} recurred:${effectivenessRecurrence.recurred} unknown:${effectivenessRecurrence.unknown} rate:${effectivenessRecurrence.recurrenceRate} lookbackDays:${effectivenessRecurrence.lookbackDays}`,
        `monitorRecords=${status.monitorRecordCount}`,
        `replayCandidates=${status.replayCandidateCount}`,
        `replayClusters=${status.replayClusterCount}`,
        `improvementCandidates=${status.improvementCandidateCount}`,
        `activePipeline=${status.activePipeline.provider}`,
        `legacyProvider1Removed=yes`,
        `legacyProvider1Active=no`,
        `legacyProvider1PromotionPackets=${status.legacyProvider1.promotionPacketCount}`,
      ].join('\n') + '\n',
    )
  }
  return 0
}

async function handleExperiences(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  const experiences = await listMatOSExperienceAssets(io.cwd)
  if (subcommand === 'list') {
    const paged = pageItems(experiences, parsed)
    const outputExperiences = parsed.compact
      ? paged.items.map(compactExperience)
      : paged.items
    if (parsed.json) {
      writeJson(io, { experiences: outputExperiences, page: paged.page })
    } else if (paged.items.length === 0) {
      io.stdout('No MatOS experience assets found\n')
    } else {
      for (const experience of paged.items) {
        io.stdout(`${experience.ref}\t${experience.lifecycle}\t${experience.name}\n`)
      }
    }
    return 0
  }
  if (subcommand === 'show') {
    const refOrId = parsed.positionals[2]
    if (!refOrId) {
      io.stderr('Usage: matos evolve experiences show <experience-ref-or-id>\n')
      return 1
    }
    const experience = experiences.find(item => matchesExperienceRef(item, refOrId))
    if (!experience) {
      io.stderr(`MatOS experience asset not found: ${refOrId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { experience })
    } else {
      io.stdout(`${experience.ref}\t${experience.lifecycle}\n${experience.name}\n`)
    }
    return 0
  }
  io.stderr(`Unknown matos evolve experiences command: ${subcommand}\n`)
  return 1
}

async function handlePolicy(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const requested = parsed.positionals[1]
  if (requested !== undefined) {
    if (!isMatOSEvolutionApprovalMode(requested)) {
      io.stderr(
        `Unknown evolution approval mode: ${requested} (expected ${MATOS_EVOLUTION_APPROVAL_MODES.join(', ')})\n`,
      )
      return 1
    }
    await writeMatOSEvolutionApprovalPolicy({
      cwd: io.cwd,
      ...(io.env ? { env: io.env } : {}),
      mode: requested,
    })
  }
  const resolution = await resolveMatOSEvolutionApprovalMode({
    cwd: io.cwd,
    ...(io.env ? { env: io.env } : {}),
  })
  if (parsed.json) {
    writeJson(io, { policy: resolution })
  } else {
    io.stdout(`mode=${resolution.mode}\nsource=${resolution.source}\npath=${resolution.policyPath}\n`)
  }
  return 0
}

async function handleDirectEditor(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    const runs = await listMatOSDirectAssetEditorRuns(io.cwd)
    const paged = pageItems(runs, parsed)
    const outputRuns = parsed.compact
      ? paged.items.map(compactDirectEditorRun)
      : paged.items
    if (parsed.json) {
      writeJson(io, { runs: outputRuns, page: paged.page })
    } else if (paged.items.length === 0) {
      io.stdout('No MatOS direct editor runs found\n')
    } else {
      for (const run of paged.items) {
        io.stdout(`${run.runId}\t${run.status}\t${run.scope}\n`)
      }
    }
    return 0
  }
  if (subcommand === 'merge') {
    const mergeSubcommand = parsed.positionals[2] ?? 'list'
    if (mergeSubcommand === 'list') {
      const pendingMerges = await listMatOSDirectAssetEditorPendingMerges(io.cwd)
      const paged = pageItems(pendingMerges, parsed)
      if (parsed.json) {
        writeJson(io, { pendingMerges: paged.items, page: paged.page })
      } else if (paged.items.length === 0) {
        io.stdout('No MatOS direct editor pending merges found\n')
      } else {
        for (const pendingMerge of paged.items) {
          const prUrl = pendingMerge.giteaReview?.pullRequest?.url
          io.stdout(
            `${pendingMerge.runId}\t${pendingMerge.status}\t${pendingMerge.scope}\tconflicts=${pendingMerge.conflicts.length}${
              prUrl ? `\tpr=${prUrl}` : ''
            }\n`,
          )
        }
      }
      return 0
    }
    if (mergeSubcommand === 'show') {
      const runId = parsed.positionals[3]
      if (!runId) {
        io.stderr('Usage: matos evolve direct-editor merge show <run-id>\n')
        return 1
      }
      const pendingMerge = await findMatOSDirectAssetEditorPendingMerge(
        io.cwd,
        assertSafeEvolutionRecordId(runId, 'direct editor pending merge id'),
      )
      if (!pendingMerge) {
        io.stderr(`MatOS direct editor pending merge not found: ${runId}\n`)
        return 1
      }
      if (parsed.json) {
        writeJson(io, { pendingMerge })
      } else {
        const reviewLine = pendingMerge.giteaReview?.pullRequest?.url
          ? `\nPR: ${pendingMerge.giteaReview.pullRequest.url}`
          : ''
        io.stdout(
          `${pendingMerge.runId}\t${pendingMerge.status}\t${pendingMerge.scope}${reviewLine}\n${pendingMerge.conflicts
            .map(conflict => `- ${conflict.path}: ${conflict.reason}`)
            .join('\n')}\n`,
        )
      }
      return 0
    }
    if (mergeSubcommand === 'apply') {
      const runId = parsed.positionals[3]
      const strategy = parsed.positionals[4]
      if (!runId || !strategy) {
        io.stderr(
          'Usage: matos evolve direct-editor merge apply <run-id> <current|edit|base>\n',
        )
        return 1
      }
      if (!['current', 'edit', 'base'].includes(strategy)) {
        io.stderr(
          `Invalid direct editor pending merge strategy: ${strategy}; expected current, edit, or base\n`,
        )
        return 1
      }
      const result = await applyMatOSDirectAssetEditorPendingMerge({
        cwd: io.cwd,
        runId: assertSafeEvolutionRecordId(
          runId,
          'direct editor pending merge id',
        ),
        strategy: strategy as 'current' | 'edit' | 'base',
      })
      if (!result) {
        io.stderr(`MatOS direct editor pending merge not found: ${runId}\n`)
        return 1
      }
      if (parsed.json) {
        writeJson(io, { result })
      } else {
        io.stdout(
          `${result.pendingMerge.runId}\tapplied\t${result.strategy}\t${result.run.status}\n`,
        )
      }
      return 0
    }
    if (mergeSubcommand === 'abort') {
      const runId = parsed.positionals[3]
      if (!runId) {
        io.stderr('Usage: matos evolve direct-editor merge abort <run-id>\n')
        return 1
      }
      const result = await abortMatOSDirectAssetEditorPendingMerge({
        cwd: io.cwd,
        runId: assertSafeEvolutionRecordId(
          runId,
          'direct editor pending merge id',
        ),
      })
      if (!result) {
        io.stderr(`MatOS direct editor pending merge not found: ${runId}\n`)
        return 1
      }
      if (parsed.json) {
        writeJson(io, { result })
      } else {
        io.stdout(
          `${result.pendingMerge.runId}\taborted${
            result.run ? `\t${result.run.status}` : ''
          }\n`,
        )
      }
      return 0
    }
    io.stderr(`Unknown matos evolve direct-editor merge command: ${mergeSubcommand}\n`)
    return 1
  }
  if (subcommand === 'show') {
    const runId = parsed.positionals[2]
    if (!runId) {
      io.stderr('Usage: matos evolve direct-editor show <run-id>\n')
      return 1
    }
    const run = await readMatOSDirectAssetEditorRun(
      io.cwd,
      assertSafeEvolutionRecordId(runId, 'direct editor run id'),
    )
    if (!run) {
      io.stderr(`MatOS direct editor run not found: ${runId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\t${run.scope}\n${run.editorOutput.summary}\n`)
    }
    return 0
  }
  if (subcommand === 'recover') {
    const runId = parsed.positionals[2]
    if (!runId) {
      io.stderr('Usage: matos evolve direct-editor recover <run-id>\n')
      return 1
    }
    let run
    try {
      run = await recoverInterruptedMatOSDirectAssetEditorRun({
        cwd: io.cwd,
        runId: assertSafeEvolutionRecordId(runId, 'direct editor run id'),
        env: io.env,
      })
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    if (!run) {
      io.stderr(`MatOS direct editor run is not recoverable: ${runId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\t${run.scope}\n`)
    }
    return 0
  }
  if (subcommand === 'rollback') {
    const runId = parsed.positionals[2]
    if (!runId) {
      io.stderr('Usage: matos evolve direct-editor rollback <run-id>\n')
      return 1
    }
    let run
    try {
      run = await rollbackMatOSDirectAssetEditorRun({
        cwd: io.cwd,
        runId: assertSafeEvolutionRecordId(runId, 'direct editor run id'),
      })
    } catch (error) {
      io.stderr(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
    if (!run) {
      io.stderr(`MatOS direct editor run cannot be rolled back: ${runId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\t${run.scope}\n`)
    }
    return 0
  }
  if (subcommand === 'approve' || subcommand === 'reject') {
    const runId = parsed.positionals[2]
    if (!runId) {
      io.stderr(`Usage: matos evolve direct-editor ${subcommand} <run-id> [--note <text>]\n`)
      return 1
    }
    const decide =
      subcommand === 'approve'
        ? approveMatOSDirectAssetEditorProposal
        : rejectMatOSDirectAssetEditorProposal
    let run
    try {
      run = await decide({
        cwd: io.cwd,
        runId: assertSafeEvolutionRecordId(runId, 'direct editor run id'),
        ...(parsed.note ? { note: parsed.note } : {}),
        ...(io.env ? { env: io.env } : {}),
      })
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\t${run.scope}\n`)
    }
    return 0
  }
  if (subcommand === 'rebaseline') {
    const rebaseline = await rebaselineMatOSDirectAssetEditorScope({
      cwd: io.cwd,
      scope: 'core',
      reason: 'operator requested direct editor rebaseline',
    })
    if (parsed.json) {
      writeJson(io, { rebaseline: compactDirectEditorRebaseline(rebaseline) })
    } else {
      io.stdout(
        [
          `status=${rebaseline.status}`,
          `scope=${rebaseline.scope}`,
          ...(rebaseline.snapshot
            ? [
                `snapshot=${rebaseline.snapshot.snapshotId}`,
                `commit=${rebaseline.snapshot.commit}`,
              ]
            : []),
          ...(rebaseline.error ? [`error=${rebaseline.error}`] : []),
        ].join('\n') + '\n',
      )
    }
    return rebaseline.status === 'failed' ? 1 : 0
  }
  if (subcommand === 'sync') {
    const healthBefore = await inspectMatOSDirectAssetEditorScope({
      cwd: io.cwd,
      scope: 'core',
    })
    if (healthBefore.status === 'ready' && !healthBefore.needsRebaseline) {
      const sync = {
        status: 'current',
        scope: 'core',
        healthBefore,
        healthAfter: healthBefore,
        summary:
          'Current editable core assets already match the direct-editor stable baseline.',
      }
      if (parsed.json) {
        writeJson(io, { sync })
      } else {
        io.stdout(
          [
            `status=${sync.status}`,
            `scope=${sync.scope}`,
            `healthBefore=${sync.healthBefore.status}`,
            `healthAfter=${sync.healthAfter.status}`,
          ].join('\n') + '\n',
        )
      }
      return 0
    }

    let rebaseline: Awaited<
      ReturnType<typeof rebaselineMatOSDirectAssetEditorScope>
    >
    try {
      rebaseline = await rebaselineMatOSDirectAssetEditorScope({
        cwd: io.cwd,
        scope: 'core',
        reason: 'developer requested direct editor snapshot sync',
      })
    } catch (error) {
      const healthAfter = await inspectMatOSDirectAssetEditorScope({
        cwd: io.cwd,
        scope: 'core',
      }).catch(() => undefined)
      const sync = {
        status: 'failed',
        scope: 'core',
        healthBefore,
        ...(healthAfter ? { healthAfter } : {}),
        error: error instanceof Error ? error.message : String(error),
        summary:
          'Direct-editor snapshot sync failed before it could update the stable baseline.',
      }
      if (parsed.json) {
        writeJson(io, { sync })
      } else {
        io.stderr(`${sync.error}\n`)
      }
      return 1
    }

    const healthAfter = await inspectMatOSDirectAssetEditorScope({
      cwd: io.cwd,
      scope: 'core',
    })
    const status =
      rebaseline.status === 'failed' || healthAfter.needsRebaseline
        ? 'failed'
        : rebaseline.status
    const sync = {
      status,
      scope: 'core',
      healthBefore,
      rebaseline: compactDirectEditorRebaseline(rebaseline),
      healthAfter,
      summary:
        status === 'failed'
          ? 'Direct-editor snapshot sync did not leave the core scope ready.'
          : status === 'updated'
            ? 'Validated developer asset edits and updated the direct-editor stable baseline.'
            : 'Current editable core assets already match the direct-editor stable baseline.',
    }
    if (parsed.json) {
      writeJson(io, { sync })
    } else {
      io.stdout(
        [
          `status=${sync.status}`,
          `scope=${sync.scope}`,
          `healthBefore=${sync.healthBefore.status}`,
          `rebaseline=${sync.rebaseline.status}`,
          `healthAfter=${sync.healthAfter.status}`,
          ...(sync.rebaseline.snapshot
            ? [
                `snapshot=${sync.rebaseline.snapshot.snapshotId}`,
                `commit=${sync.rebaseline.snapshot.commit}`,
              ]
            : []),
          ...(sync.rebaseline.error ? [`error=${sync.rebaseline.error}`] : []),
        ].join('\n') + '\n',
      )
    }
    return status === 'failed' ? 1 : 0
  }
  io.stderr(`Unknown matos evolve direct-editor command: ${subcommand}\n`)
  return 1
}

function feedbackFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index >= 0) {
    const value = args[index + 1]
    return typeof value === 'string' && !value.startsWith('--') ? value : undefined
  }
  const inline = args.find(arg => arg.startsWith(`${flag}=`))
  return inline ? inline.slice(flag.length + 1) : undefined
}

async function handleFeedback(
  rawArgs: string[],
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1]
  if (subcommand !== 'submit') {
    io.stderr(
      'Usage: matos evolve feedback submit --memory-id <id> --memory-type <type> --title <text> --detail <text> [--extraction-source <src>] [--conversation <ref>] [--project <ref>] [--json]\n',
    )
    return 1
  }
  const memoryId = feedbackFlagValue(rawArgs, '--memory-id') ?? ''
  const memoryType = feedbackFlagValue(rawArgs, '--memory-type') ?? ''
  const title = feedbackFlagValue(rawArgs, '--title') ?? ''
  const detail = feedbackFlagValue(rawArgs, '--detail') ?? ''
  const result = await submitMatOSOdMemoryFeedback({
    cwd: io.cwd,
    memoryId,
    memoryType,
    title,
    detail,
    extractionSource: feedbackFlagValue(rawArgs, '--extraction-source'),
    conversationRef: feedbackFlagValue(rawArgs, '--conversation'),
    projectRef: feedbackFlagValue(rawArgs, '--project'),
    ...(io.env ? { env: io.env as NodeJS.ProcessEnv } : {}),
  })
  if (parsed.json) {
    writeJson(io, { feedback: result })
  } else if (result.status === 'invalid') {
    io.stderr(`invalid feedback submission: ${result.reason}\n`)
  } else {
    io.stdout(`${result.status}\t${result.triggerKey ?? ''}\n`)
  }
  return result.status === 'invalid' ? 1 : 0
}

async function handleMonitor(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    const records = await listMatOSSelfEvolutionMonitorRecords(io.cwd)
    const paged = pageItems(records, parsed)
    const outputRecords = parsed.compact
      ? paged.items.map(compactMonitorRecord)
      : paged.items
    if (parsed.json) {
      writeJson(io, { records: outputRecords, page: paged.page })
    } else if (paged.items.length === 0) {
      io.stdout('No MatOS self-evolution monitor records found\n')
    } else {
      for (const record of paged.items) {
        io.stdout(
          `${record.recordId}\t${record.status}\t${record.triggerKind}\t${record.sessionId}\n`,
        )
      }
    }
    return 0
  }
  if (subcommand === 'show') {
    const recordId = parsed.positionals[2]
    if (!recordId) {
      io.stderr('Usage: matos evolve monitor show <record-id>\n')
      return 1
    }
    const record = await readMatOSSelfEvolutionMonitorRecord(io.cwd, recordId)
    if (!record) {
      io.stderr(`MatOS self-evolution monitor record not found: ${recordId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { record })
    } else {
      io.stdout(`${record.recordId}\t${record.status}\t${record.triggerKind}\n${record.summary}\n`)
    }
    return 0
  }
  io.stderr(`Unknown matos evolve monitor command: ${subcommand}\n`)
  return 1
}

async function handleReplayCandidates(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    const candidates = await listMatOSWorkflowReplayCandidates(io.cwd)
    if (parsed.json) {
      writeJson(io, { candidates })
    } else if (candidates.length === 0) {
      io.stdout('No MatOS workflow replay candidates found\n')
    } else {
      for (const candidate of candidates) {
        io.stdout(
          `${candidate.candidateId}\t${candidate.trigger}\t${candidate.workflowRef}\t${candidate.failureSignature.slice(0, 16)}\n`,
        )
      }
    }
    return 0
  }
  if (subcommand === 'show') {
    const candidateId = parsed.positionals[2]
    if (!candidateId) {
      io.stderr('Usage: matos evolve replay-candidates show <candidate-id>\n')
      return 1
    }
    const candidate = await readMatOSWorkflowReplayCandidate(
      io.cwd,
      assertSafeEvolutionRecordId(candidateId, 'replay candidate id'),
    )
    if (!candidate) {
      io.stderr(`MatOS workflow replay candidate not found: ${candidateId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { candidate })
    } else {
      io.stdout(
        `${candidate.candidateId}\t${candidate.trigger}\t${candidate.workflowRef}\n` +
          `signature=${candidate.failureSignature}\n` +
          `benchmarkCase=${candidate.benchmarkCaseId}\n` +
          `failedNodes=${candidate.failedNodeIds.join(',') || 'none'}\n`,
      )
    }
    return 0
  }
  io.stderr(`Unknown matos evolve replay-candidates command: ${subcommand}\n`)
  return 1
}

async function handleReplayClusters(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    const clusters = await listMatOSWorkflowReplayClusters(io.cwd)
    if (parsed.json) {
      writeJson(io, { clusters })
    } else if (clusters.length === 0) {
      io.stdout('No MatOS workflow replay clusters found\n')
    } else {
      for (const cluster of clusters) {
        io.stdout(
          `${cluster.clusterId}\t${cluster.workflowRef}\toccurrences=${cluster.occurrences}\n`,
        )
      }
    }
    return 0
  }
  if (subcommand === 'show') {
    const clusterId = parsed.positionals[2]
    if (!clusterId) {
      io.stderr('Usage: matos evolve replay-clusters show <cluster-id>\n')
      return 1
    }
    const cluster = await readMatOSWorkflowReplayCluster(
      io.cwd,
      assertSafeEvolutionRecordId(clusterId, 'replay cluster id'),
    )
    if (!cluster) {
      io.stderr(`MatOS workflow replay cluster not found: ${clusterId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { cluster })
    } else {
      io.stdout(
        `${cluster.clusterId}\t${cluster.workflowRef}\n` +
          `signature=${cluster.failureSignature}\n` +
          `occurrences=${cluster.occurrences}\n` +
          `candidates=${cluster.candidateIds.join(',')}\n` +
          `${cluster.proposal.summary}\n`,
      )
    }
    return 0
  }
  io.stderr(`Unknown matos evolve replay-clusters command: ${subcommand}\n`)
  return 1
}

async function handleImprovementCandidates(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    const candidates = await listMatOSStableImprovementCandidates(io.cwd)
    if (parsed.json) {
      writeJson(io, { candidates })
    } else if (candidates.length === 0) {
      io.stdout('No MatOS stable improvement candidates found\n')
    } else {
      for (const candidate of candidates) {
        io.stdout(
          `${candidate.id}\t${candidate.status}\t${candidate.workflowRef}\n`,
        )
      }
    }
    return 0
  }
  if (subcommand === 'show') {
    const candidateId = parsed.positionals[2]
    if (!candidateId) {
      io.stderr('Usage: matos evolve improvement-candidates show <candidate-id>\n')
      return 1
    }
    const candidate = await readMatOSStableImprovementCandidate(
      io.cwd,
      assertSafeEvolutionRecordId(candidateId, 'improvement candidate id'),
    )
    if (!candidate) {
      io.stderr(`MatOS stable improvement candidate not found: ${candidateId}\n`)
      return 1
    }
    if (parsed.json) {
      writeJson(io, { candidate })
    } else {
      io.stdout(
        `${candidate.id}\t${candidate.status}\t${candidate.workflowRef}\n` +
          `cluster=${candidate.clusterRef}\n` +
          `replayCandidates=${candidate.draftRefs.replayCandidateIds.join(',')}\n` +
          `reproducedRuns=${candidate.evidence.reproducedRunIds.join(',') || 'none'}\n` +
          `promotionGate=${candidate.gates.promotion.status}: ${candidate.gates.promotion.reason}\n`,
      )
    }
    return 0
  }
  io.stderr(`Unknown matos evolve improvement-candidates command: ${subcommand}\n`)
  return 1
}

/**
 * Collects a user/time window of real run evidence into a structured intake
 * record plus deterministic teaching episodes (user2asset). Output: `.matos/evolution/intakes/<id>.json` and
 * `.matos/evolution/episodes/<id>.json`.
 */
async function handleUserTestLogsIntake(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  let json = false
  let scopeRef: string | undefined
  let since: string | undefined
  let sessionId: string | undefined
  let traceId: string | undefined
  let runId: string | undefined
  let limit: number | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--scope') {
      scopeRef = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--since') {
      since = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--session') {
      sessionId = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--trace') {
      traceId = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--run-id' || arg === '--run') {
      runId = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--limit') {
      const parsed = Number.parseInt(args[index + 1] ?? '', 10)
      if (Number.isInteger(parsed) && parsed > 0) {
        limit = parsed
      }
      index += 1
      continue
    }
  }
  try {
    const { collectMatOSUserTestLogIntake } = await import(
      '../learning/userTestLogIntake.js'
    )
    const result = await collectMatOSUserTestLogIntake({
      cwd: io.cwd,
      ...(scopeRef ? { scopeRef } : {}),
      ...(since ? { since } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(runId ? { runId } : {}),
      ...(limit ? { limit } : {}),
      ...(io.env ? { env: io.env } : {}),
    })
    if (json) {
      writeJson(io, {
        intakeId: result.intake.intakeId,
        intakePath: result.intakePath,
        stats: result.intake.stats,
        episodeIds: result.intake.episodeIds,
        episodePaths: result.episodePaths,
      })
      return 0
    }
    const stats = result.intake.stats
    io.stdout(
      `${result.intake.intakeId}\n` +
        `window=${result.intake.window.since}..${result.intake.window.until}\n` +
        `sessions=${stats.sessionCount} (failed=${stats.failedSessionCount})\n` +
        `workflowRuns=${stats.workflowRunCount} (failed=${stats.failedWorkflowRunCount})\n` +
        `daemonJobs=${stats.daemonJobCount} (failed=${stats.failedDaemonJobCount})\n` +
        `feedback=${stats.feedbackCount} monitorRecords=${stats.monitorRecordCount}\n` +
        `episodes=${stats.episodeCount}\n` +
        `intake=${result.intakePath}\n`,
    )
    for (const episode of result.episodes) {
      io.stdout(`${episode.episodeId}\t${episode.kind}\t${episode.summary}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * `matos evolve intake repo|paper` is the canonical alias over the
 * deterministic workbench external-intake classifier (repo2asset / paper2asset
 * V1). It delegates to `matos workbench search intake-classify <source>` so the
 * classification, provenance, and validation logic is not duplicated.
 * `matos evolve intake user-test-logs` collects runtime evidence instead.
 */
async function handleIntake(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const positionals: string[] = []
  const flags: Record<string, string | boolean | undefined> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      flags.json = true
      continue
    }
    if (arg === '--llm-assist' || arg === '--llm') {
      flags.llmAssist = true
      continue
    }
    if (arg === '--path' || arg === '--source' || arg === '--intake' || arg === '--model') {
      flags[arg.slice(2)] = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      continue
    }
    positionals.push(arg)
  }
  const kind = positionals[1]
  if (kind === 'user-test-logs') {
    return handleUserTestLogsIntake(args.slice(2), io)
  }
  if (kind !== 'repo' && kind !== 'paper') {
    io.stderr(
      'Usage: matos evolve intake repo|paper --path <source> [--llm-assist] [--model <model>] [--json]\n' +
        '       matos evolve intake user-test-logs [--scope user:<id>] [--since <iso|24h|7d>] [--session <id>] [--trace <id>] [--run-id <id>] [--limit <n>] [--json]\n',
    )
    return 1
  }
  const source =
    (typeof flags.path === 'string' && flags.path) ||
    (typeof flags.source === 'string' && flags.source) ||
    (typeof flags.intake === 'string' && flags.intake) ||
    positionals[2]
  if (!source) {
    io.stderr(
      'matos evolve intake requires --path <source> (a local repo directory for repo, or a paper/markdown file for paper)\n',
    )
    return 1
  }
  const { runMatOSWorkbenchCommand } = await import('./workbench.js')
  const workbenchArgs = ['search', 'intake-classify', source]
  if (flags.llmAssist) {
    workbenchArgs.push('--llm-assist')
  }
  if (typeof flags.model === 'string' && flags.model) {
    workbenchArgs.push('--model', flags.model)
  }
  if (flags.json) {
    workbenchArgs.push('--json')
  }
  return runMatOSWorkbenchCommand(workbenchArgs, io)
}

type Failure2AssetFlags = {
  json: boolean
  episode?: string
  proposal?: string
}

function parseFailure2AssetFlags(args: string[]): {
  flags: Failure2AssetFlags
  positionals: string[]
} {
  const flags: Failure2AssetFlags = { json: false }
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      flags.json = true
      continue
    }
    if (arg === '--episode') {
      flags.episode = args[index + 1]
      index += 1
      continue
    }
    if (arg === '--proposal') {
      flags.proposal = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      continue
    }
    positionals.push(arg)
  }
  return { flags, positionals }
}

function compactProposal(
  proposal: import('../learning/proposalDrafts.js').MatOSEvolutionProposal,
): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    episodeId: proposal.episodeId,
    action: proposal.action,
    episodeKind: proposal.episodeKind,
    title: proposal.title,
    plannedAssets: proposal.plannedAssets.map(asset => asset.ref),
    benchmarkPlan: proposal.benchmarkPlan,
    targetPack: proposal.targetPack,
    gates: proposal.gates,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    path: proposal.path,
  }
}

/**
 * Failure2Asset stage 1: teaching episode -> draft-first
 * evolution proposals under `.matos/evolution/proposals/<id>/proposal.json`.
 */
async function handleProposals(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const { flags, positionals } = parseFailure2AssetFlags(args)
  const subcommand = positionals[1] ?? 'list'
  const {
    generateMatOSEvolutionProposals,
    listMatOSEvolutionProposals,
    readMatOSEvolutionProposal,
  } = await import('../learning/proposalDrafts.js')
  try {
    if (subcommand === 'generate') {
      const episodeId = flags.episode ?? positionals[2]
      if (!episodeId) {
        io.stderr(
          'Usage: matos evolve proposals generate --episode <episode-id> [--json]\n',
        )
        return 1
      }
      const result = await generateMatOSEvolutionProposals({
        cwd: io.cwd,
        episodeId,
      })
      if (flags.json) {
        writeJson(io, {
          episodeId: result.episode.episodeId,
          proposals: result.proposals,
          proposalPaths: result.proposalPaths,
        })
        return 0
      }
      for (const proposal of result.proposals) {
        io.stdout(
          `${proposal.proposalId}\t${proposal.action}\t${proposal.title}\n` +
            `  pack=${proposal.targetPack.relativePath}\n` +
            `  benchmark=${proposal.benchmarkPlan.kind} subject=${proposal.benchmarkPlan.subjectRef}\n` +
            `  next: matos evolve draft-assets --proposal ${proposal.proposalId} --json\n`,
        )
      }
      return 0
    }
    if (subcommand === 'list') {
      const proposals = await listMatOSEvolutionProposals(io.cwd)
      if (flags.json) {
        writeJson(io, { proposals: proposals.map(compactProposal) })
      } else if (proposals.length === 0) {
        io.stdout('No MatOS evolution proposals found\n')
      } else {
        for (const proposal of proposals) {
          io.stdout(
            `${proposal.proposalId}\t${proposal.action}\t` +
              `assets=${proposal.gates.draftAssets.status}\t` +
              `benchmark=${proposal.gates.benchmark.status}\t` +
              `validation=${proposal.gates.validation.status}\n`,
          )
        }
      }
      return 0
    }
    if (subcommand === 'show') {
      const proposalId = flags.proposal ?? positionals[2]
      if (!proposalId) {
        io.stderr('Usage: matos evolve proposals show <proposal-id> [--json]\n')
        return 1
      }
      const proposal = await readMatOSEvolutionProposal(io.cwd, proposalId)
      if (!proposal) {
        io.stderr(`MatOS evolution proposal not found: ${proposalId}\n`)
        return 1
      }
      if (flags.json) {
        writeJson(io, { proposal })
      } else {
        io.stdout(
          `${proposal.proposalId}\t${proposal.action}\n` +
            `episode=${proposal.episodeId}\n` +
            `title=${proposal.title}\n` +
            `plannedAssets=${proposal.plannedAssets.map(asset => asset.ref).join(',')}\n` +
            `benchmarkPlan=${proposal.benchmarkPlan.kind} subject=${proposal.benchmarkPlan.subjectRef}\n` +
            `gates: draftAssets=${proposal.gates.draftAssets.status} benchmark=${proposal.gates.benchmark.status} validation=${proposal.gates.validation.status} promotion=${proposal.gates.promotion.status}\n`,
        )
      }
      return 0
    }
    io.stderr(`Unknown matos evolve proposals command: ${subcommand}\n`)
    return 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Failure2Asset stage 2: proposal -> draft asset pack with asset-history
 * snapshots, draft validation, secret scan, and rollback.
 */
async function handleDraftAssets(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const { flags, positionals } = parseFailure2AssetFlags(args)
  const proposalId = flags.proposal ?? positionals[1]
  if (!proposalId) {
    io.stderr('Usage: matos evolve draft-assets --proposal <proposal-id> [--json]\n')
    return 1
  }
  try {
    const { generateMatOSEvolutionDraftAssets } = await import(
      '../learning/proposalDrafts.js'
    )
    const result = await generateMatOSEvolutionDraftAssets({
      cwd: io.cwd,
      proposalId,
    })
    if (flags.json) {
      writeJson(io, result)
      return result.applied ? 0 : 1
    }
    io.stdout(
      `${result.proposalId}\t${result.status}\n` +
        `pack=${result.targetPackPath}\n` +
        `assets=${result.assetRefs.join(',')}\n` +
        `validation=${result.validation.ok ? 'ok' : 'failed'}\n` +
        (result.reason ? `reason=${result.reason}\n` : '') +
        `next: matos evolve benchmarks draft --proposal ${result.proposalId} --json\n`,
    )
    return result.applied ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Failure2Asset stage 3: benchmark draft + regression run over the shared
 * benchmark runner. Gated kinds report `blocked` without
 * MATOS_RUN_REAL_BENCHMARKS=1 instead of silently skipping.
 */
async function handleBenchmarks(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const { flags, positionals } = parseFailure2AssetFlags(args)
  const subcommand = positionals[1]
  const proposalId = flags.proposal ?? positionals[2]
  if ((subcommand !== 'draft' && subcommand !== 'run') || !proposalId) {
    io.stderr(
      'Usage: matos evolve benchmarks draft --proposal <proposal-id> [--json]\n' +
        '       matos evolve benchmarks run --proposal <proposal-id> [--json]\n',
    )
    return 1
  }
  try {
    const { draftMatOSEvolutionBenchmark, runMatOSEvolutionBenchmarkRegression } =
      await import('../learning/benchmarkDrafts.js')
    if (subcommand === 'draft') {
      const draft = await draftMatOSEvolutionBenchmark({
        cwd: io.cwd,
        proposalId,
      })
      if (flags.json) {
        writeJson(io, {
          proposalId: draft.proposalId,
          case: draft.case,
          casePath: draft.casePath,
          note: draft.note,
          gates: draft.proposal.gates,
        })
        return 0
      }
      io.stdout(
        `${draft.case.id}\t${draft.case.kind}\n` +
          `case=${draft.casePath}\n` +
          `${draft.note}\n` +
          `next: matos evolve benchmarks run --proposal ${draft.proposalId} --json\n`,
      )
      return 0
    }
    const regression = await runMatOSEvolutionBenchmarkRegression({
      cwd: io.cwd,
      proposalId,
    })
    if (flags.json) {
      writeJson(io, {
        proposalId: regression.proposalId,
        benchmarkRef: regression.benchmarkRef,
        casePath: regression.casePath,
        result: regression.result,
        gates: regression.proposal.gates,
      })
      return regression.result.status === 'failed' ? 1 : 0
    }
    io.stdout(
      `${regression.result.caseId}\t${regression.result.kind}\t${regression.result.status}\n` +
        `result=${regression.result.resultPath}\n` +
        (regression.result.evidence.message
          ? `message=${regression.result.evidence.message}\n`
          : ''),
    )
    return regression.result.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * One-shot Failure2Asset factory: episode -> proposals -> draft asset pack ->
 * benchmark draft -> regression run, with per-stage gates recorded on each
 * proposal so partial runs stay resumable through the stage commands.
 */
async function handleFactory(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const { flags, positionals } = parseFailure2AssetFlags(args)
  const episodeId = flags.episode ?? positionals[1]
  if (!episodeId) {
    io.stderr('Usage: matos evolve factory --episode <episode-id> [--json]\n')
    return 1
  }
  try {
    const { runMatOSFailure2AssetFactory } = await import(
      '../learning/benchmarkDrafts.js'
    )
    const result = await runMatOSFailure2AssetFactory({
      cwd: io.cwd,
      episodeId,
    })
    if (flags.json) {
      writeJson(io, result)
      return 0
    }
    io.stdout(`factory episode=${result.episodeId}\n`)
    for (const item of result.proposals) {
      io.stdout(
        `${item.proposalId}\t${item.action}\n` +
          `  pack=${item.draftAssets.targetPackPath} (${item.draftAssets.status})\n` +
          `  benchmark=${item.benchmark.kind} case=${item.benchmark.casePath}\n` +
          `  regression=${item.regression.status}` +
          (item.regression.message ? ` (${item.regression.message})` : '') +
          '\n',
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function handleCost(
  parsed: ParsedEvolveArgs,
  io: MatOSEvolveIO,
): Promise<number> {
  const report = await buildMatOSEvolutionCostReport({ cwd: io.cwd })
  if (parsed.json) {
    writeCostJson(io, report)
    return 0
  }
  const lines = [
    `MatOS self-evolution hidden cost report (${report.generatedAt})`,
    `records=${report.totals.recordCount}`,
    `tokens=${report.totals.totalTokens}`,
    `input=${report.totals.inputTokens}`,
    `output=${report.totals.outputTokens}`,
    `cacheCreate=${report.totals.cacheCreationInputTokens}`,
    `cacheRead=${report.totals.cacheReadInputTokens}`,
    `costUsd=${report.totals.totalCostUsd}`,
  ]
  for (const [stage, summary] of Object.entries(report.byStage).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `  - ${stage}: records=${summary.recordCount} tokens=${summary.totalTokens} costUsd=${summary.totalCostUsd}`,
    )
  }
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

/**
 * Read-only cross-user self-evolution daily report. Aggregates
 * existing per-user evolution records under the deployment runtime data root.
 */
async function handleDailyReport(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const flags: Record<string, string | undefined> = {}
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (
      arg === '--deploy-root' ||
      arg === '--runtime-data-dir' ||
      arg === '--since'
    ) {
      flags[arg.slice(2)] = args[index + 1]
      index += 1
      continue
    }
  }
  const report = await buildMatOSEvolutionDailyReport({
    cwd: io.cwd,
    env: io.env ?? process.env,
    ...(flags['deploy-root'] ? { deployRoot: flags['deploy-root'] } : {}),
    ...(flags['runtime-data-dir']
      ? { runtimeDataDir: flags['runtime-data-dir'] }
      : {}),
    ...(flags.since ? { since: flags.since } : {}),
  })
  if (json) {
    writeJson(io, report)
    return 0
  }
  const lines = [
    `MatOS self-evolution daily report (${report.generatedAt})`,
    `runtimeDataDir=${report.runtimeDataDir}`,
    `usersScanned=${report.usersScanned}`,
    `directEdits=${report.totals.directEdits} (effective=${report.totals.effectiveDirectEdits}, accepted=${report.totals.accepted}, rolledBack=${report.totals.rolledBack}, blocked=${report.totals.blocked}, activeBlocked=${report.totals.activeBlocked}, legacyBlocked=${report.totals.legacyBlocked}, failed=${report.totals.failed})`,
    `assetChanges=created:${report.totals.assetChanges.created.total},updated:${report.totals.assetChanges.updated.total}`,
    `experiences=${report.totals.experiences} replayClusters=${report.totals.replayClusters} stableImprovementCandidates=${report.totals.stableImprovementCandidates}`,
    `promotionCandidates=${report.totals.promotionCandidates}`,
    `crossUserFailureClusters=${report.totals.crossUserFailureClusters}`,
  ]
  for (const candidate of report.promotionCandidates.slice(0, 10)) {
    lines.push(
      `  - promotionCandidate=${candidate.runId} user=${candidate.userId} assets=${candidate.assets.join(',')} reason=${candidate.reason}`,
    )
  }
  for (const cluster of report.crossUserFailureClusters.slice(0, 10)) {
    lines.push(
      `  - signature=${cluster.failureSignature} users=${cluster.userCount} occurrences=${cluster.totalOccurrences} workflows=${cluster.workflowRefs.join(',')}`,
    )
  }
  for (const note of report.notes) {
    lines.push(`note: ${note}`)
  }
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

/**
 * Read-only health report over the trailing window, built for automated daily
 * sweeps: exit code 0 for health ok/idle and 3 for degraded, so a cron line
 * like `matos evolve report --json || alert` needs no JSON parsing.
 */
async function handleReport(args: string[], io: MatOSEvolveIO): Promise<number> {
  let json = false
  let windowDays: number | undefined
  let runtimeDataDir: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--window-days') {
      windowDays = parseNonNegativeInteger(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--window-days=')) {
      windowDays = parseNonNegativeInteger(arg.slice('--window-days='.length))
      continue
    }
    if (arg === '--runtime-data-dir') {
      runtimeDataDir = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--runtime-data-dir=')) {
      runtimeDataDir = arg.slice('--runtime-data-dir='.length)
      continue
    }
  }
  const report = await buildMatOSEvolutionReport({
    cwd: io.cwd,
    env: io.env ?? process.env,
    ...(runtimeDataDir?.trim() ? { runtimeDataDir: runtimeDataDir.trim() } : {}),
    ...(windowDays !== undefined && windowDays > 0 ? { windowDays } : {}),
  })
  if (json) {
    writeJson(io, report)
  } else {
    const lines = [
      `MatOS self-evolution report (${report.generatedAt})`,
      `health=${report.health} (${report.healthReasons.join('; ')})`,
      `window=${report.windowDays}d since ${report.windowStart}`,
      `runs=${report.totals.runs} accepted=${report.totals.accepted} rolledBack=${report.totals.rolledBack} failed=${report.totals.failed} activeBlocked=${report.totals.activeBlocked} legacyBlocked=${report.totals.legacyBlocked} noop=${report.totals.noop}`,
      `decided=${report.totals.decided} acceptanceRatio=${report.acceptanceRatio ?? 'n/a'} activeBlockedStreak=${report.activeBlockedStreak}`,
      `monitorRecords=${report.monitor.records}`,
    ]
    for (const day of report.perDay) {
      lines.push(
        `  ${day.day}: total=${day.total} accepted=${day.accepted} rolledBack=${day.rolledBack} failed=${day.failed} activeBlocked=${day.activeBlocked}`,
      )
    }
    for (const reason of report.topRollbackReasons) {
      lines.push(`  rollbackReason=${reason.reason} count=${reason.count}`)
    }
    io.stdout(`${lines.join('\n')}\n`)
  }
  return report.health === 'degraded' ? 3 : 0
}

/**
 * Plan-first evolution storage GC. Destructive apply is opt-in per the
 * data-preservation policy: without `--apply` (or MATOS_EVOLVE_GC_APPLY=1)
 * the command only prints the prune plan. An explicit `--dry-run` always
 * wins over the env opt-in.
 */
async function handleGc(args: string[], io: MatOSEvolveIO): Promise<number> {
  let json = false
  let dryRunFlag = false
  let applyFlag = false
  let keepDays: number | undefined
  let keepRuns: number | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--dry-run') {
      dryRunFlag = true
      continue
    }
    if (arg === '--apply') {
      applyFlag = true
      continue
    }
    if (arg === '--keep-days') {
      keepDays = parseNonNegativeInteger(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--keep-days=')) {
      keepDays = parseNonNegativeInteger(arg.slice('--keep-days='.length))
      continue
    }
    if (arg === '--keep-runs') {
      keepRuns = parseNonNegativeInteger(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--keep-runs=')) {
      keepRuns = parseNonNegativeInteger(arg.slice('--keep-runs='.length))
      continue
    }
  }
  const env = io.env ?? process.env
  const apply = !dryRunFlag && (applyFlag || env[MATOS_EVOLVE_GC_APPLY_ENV] === '1')
  const report = await runMatOSEvolutionGc({
    cwd: io.cwd,
    env,
    apply,
    ...(keepDays !== undefined ? { keepDays } : {}),
    ...(keepRuns !== undefined ? { keepRuns } : {}),
  })
  if (json) {
    writeJson(io, report)
  } else {
    const lines = [
      `MatOS self-evolution gc (${report.generatedAt})`,
      `mode=${report.dryRun ? 'dry-run' : 'apply'} keepDays=${report.keepDays} keepRuns=${report.keepRuns}`,
      `runDirs: scanned=${report.runs.scanned} planned=${report.runs.planned.length} pruned=${report.runs.pruned.length} keptPendingMerge=${report.runs.kept.pendingMerge} keptInterrupted=${report.runs.kept.interrupted} keptAcceptedProvenance=${report.runs.kept.acceptedProvenance}`,
    ]
    for (const entry of report.runs.planned) {
      lines.push(`  run=${entry.runId} ageDays=${entry.ageDays}${entry.status ? ` status=${entry.status}` : ''}`)
    }
    for (const root of report.monitor) {
      lines.push(
        `monitorRoot=${root.root}: sessions=${root.scannedSessions} planned=${root.planned.length} pruned=${root.pruned.length} plannedCompactions=${root.plannedCompactions.length} compacted=${root.compacted.length}`,
      )
      for (const entry of root.planned) {
        lines.push(`  session=${entry.sessionId} ageDays=${entry.ageDays}`)
      }
    }
    for (const note of report.notes) {
      lines.push(`note: ${note}`)
    }
    io.stdout(`${lines.join('\n')}\n`)
  }
  const failureCount =
    report.runs.failures.length +
    report.monitor.reduce((sum, root) => sum + root.failures.length, 0)
  return failureCount > 0 ? 1 : 0
}

export async function runMatOSEvolveCommand(
  args: string[],
  io: MatOSEvolveIO,
): Promise<number> {
  const parsed = parseArgs(args)
  const command = parsed.positionals[0] ?? 'status'

  if (parsed.help || command === '--help' || command === '-h' || command === 'help') {
    printHelp(io)
    return 0
  }
  if (command === 'status') {
    return handleStatus(parsed, io)
  }
  if (command === 'experiences') {
    return handleExperiences(parsed, io)
  }
  if (command === 'direct-editor') {
    return handleDirectEditor(parsed, io)
  }
  if (command === 'policy') {
    return handlePolicy(parsed, io)
  }
  if (command === 'monitor') {
    return handleMonitor(parsed, io)
  }
  if (command === 'feedback') {
    return handleFeedback(args, parsed, io)
  }
  if (command === 'replay-candidates') {
    return handleReplayCandidates(parsed, io)
  }
  if (command === 'replay-clusters') {
    return handleReplayClusters(parsed, io)
  }
  if (command === 'improvement-candidates') {
    return handleImprovementCandidates(parsed, io)
  }
  if (command === 'intake') {
    return handleIntake(args, io)
  }
  if (command === 'proposals') {
    return handleProposals(args, io)
  }
  if (command === 'draft-assets') {
    return handleDraftAssets(args, io)
  }
  if (command === 'benchmarks') {
    return handleBenchmarks(args, io)
  }
  if (command === 'factory' || command === 'failure2asset') {
    return handleFactory(args, io)
  }
  if (command === 'cost' || command === 'costs') {
    return handleCost(parsed, io)
  }
  if (command === 'daily-report') {
    return handleDailyReport(args, io)
  }
  if (command === 'report') {
    return handleReport(args, io)
  }
  if (command === 'gc') {
    return handleGc(args, io)
  }
  io.stderr(
    `Unknown matos evolve command: ${command}. Legacy native evolution commands have been removed.\n`,
  )
  return 1
}
