import type {
  MatOSDirectAssetEditorAttemptSummary,
  MatOSDirectAssetEditorPreviousAttempt,
  MatOSDirectAssetEditorRejectionStage,
  MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import { evolutionInfrastructureFailureCode } from './evolutionInfrastructure.js'

const DEFAULT_DIRECT_EDITOR_MAX_ATTEMPTS = 3
const MIN_DIRECT_EDITOR_MAX_ATTEMPTS = 1
const MAX_DIRECT_EDITOR_MAX_ATTEMPTS = 4
const MAX_PREVIOUS_ATTEMPT_VALIDATION_ERRORS = 10

// Isolation-guard rollbacks are deterministic infrastructure-side failures:
// the guards restore the stray writes and the same retry hits the same guard
// again, so feeding them back as correctable rejections only burns attempts.
const NON_RETRYABLE_ROLLBACK_REASON_PREFIXES = [
  'files modified outside direct-editor writable scope:',
  'protected core asset files modified outside direct-editor scope:',
]

// The bounded retry loop runs at most this many editor attempts per logical
// self-evolution direct-edit run. A rejected attempt feeds its rejection
// evidence back to the next attempt's editor.
export function resolveDirectEditorMaxAttempts(
  env?: Record<string, string | undefined>,
): number {
  const raw = (env ?? process.env).MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DIRECT_EDITOR_MAX_ATTEMPTS
  }
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DIRECT_EDITOR_MAX_ATTEMPTS
  }
  return Math.min(
    MAX_DIRECT_EDITOR_MAX_ATTEMPTS,
    Math.max(MIN_DIRECT_EDITOR_MAX_ATTEMPTS, parsed),
  )
}

function formatIntroducedValidationErrors(
  errors: unknown[] | undefined,
): string[] {
  if (!errors || errors.length === 0) {
    return []
  }
  const formatted: string[] = []
  for (const error of errors.slice(0, MAX_PREVIOUS_ATTEMPT_VALIDATION_ERRORS)) {
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      const code = typeof record.code === 'string' ? record.code : 'error'
      const message =
        typeof record.message === 'string'
          ? record.message
          : JSON.stringify(error)
      const assetKey =
        typeof record.assetKey === 'string' ? ` [${record.assetKey}]` : ''
      formatted.push(`${code}${assetKey}: ${message}`)
    } else {
      formatted.push(String(error))
    }
  }
  return formatted
}

function editorClaimedEditsButChangedNothing(
  record: MatOSDirectAssetEditorRunRecord,
): boolean {
  return (
    record.status === 'noop' &&
    record.roleExitCode === 0 &&
    (record.editorOutput.modifiedFiles.length > 0 ||
      record.editorOutput.updatedAssets.length > 0 ||
      record.editorOutput.createdAssets.length > 0 ||
      record.editorOutput.disabledAssets.length > 0)
  )
}

export function buildPreviousAttemptFromRecord(
  record: MatOSDirectAssetEditorRunRecord,
  attempt: number,
): MatOSDirectAssetEditorPreviousAttempt | undefined {
  if (editorClaimedEditsButChangedNothing(record)) {
    return {
      attempt,
      rejectionStage: 'no-op-no-edit',
      reason:
        'The previous attempt reported modifiedFiles/updatedAssets but did NOT change any file on disk: you described or "specified" the edit instead of calling the Edit/Write tools. You DO have those tools (path-scoped). This time you MUST actually call Edit or Write to change the real files before returning the result JSON.',
    }
  }
  if (record.status !== 'rolled_back') {
    return undefined
  }
  const rollbackReason = record.rollback?.reason
  if (evolutionInfrastructureFailureCode(record)) return undefined
  if (
    rollbackReason !== undefined &&
    NON_RETRYABLE_ROLLBACK_REASON_PREFIXES.some(prefix =>
      rollbackReason.startsWith(prefix),
    )
  ) {
    return undefined
  }
  // Failing to advance a Gitea-backed source always records
  // sourceCommitErrors alongside this rollback reason, so this correctable
  // branch must run before the sourceCommitErrors short-circuit below or the
  // retry path is unreachable.
  if (
    rollbackReason?.startsWith(
      'Gitea-backed source acceptance failed:',
    )
  ) {
    return {
      attempt,
      rejectionStage: 'unknown',
      reason: [
        rollbackReason,
        'The previous attempt did not advance a matching Gitea-backed asset source.',
        'If this is a scoped user/team/project run, create or update role, skill, workflow, tool, MCP, and knowledge assets inside targetAssetCreationRoots, preferably the .matos/source-cache/.../git/... root.',
        'Do not create new target assets under .matos/assets/generated/...; generated roots are evidence-only storage for experience assets and cannot become the accepted runtime source.',
      ].join(' '),
    }
  }
  if (
    record.sourceCommitErrors &&
    record.sourceCommitErrors.length > 0
  ) {
    return undefined
  }
  const semantic = record.semanticAcceptance
  if (semantic?.judgeFailed) {
    return undefined
  }
  let rejectionStage: MatOSDirectAssetEditorRejectionStage = 'unknown'
  if (semantic && semantic.verdict === 'rollback') {
    rejectionStage = 'gate2-semantic'
  } else if (
    record.introducedValidationErrors &&
    record.introducedValidationErrors.length > 0
  ) {
    rejectionStage = 'gate1-validation'
  } else if (record.roleExitCode !== 0) {
    rejectionStage = 'editor-failed'
  }
  const introduced = formatIntroducedValidationErrors(
    record.introducedValidationErrors,
  )
  return {
    attempt,
    rejectionStage,
    reason:
      record.rollback?.reason ??
      semantic?.reason ??
      'previous attempt was rolled back',
    ...(introduced.length > 0
      ? { introducedValidationErrors: introduced }
      : {}),
    ...(semantic?.reason ? { judgeReason: semantic.reason } : {}),
    ...(semantic?.overfitRisk ? { overfitRisk: semantic.overfitRisk } : {}),
    ...(semantic?.assetPollutionRisk
      ? { assetPollutionRisk: semantic.assetPollutionRisk }
      : {}),
    ...(semantic?.missingEvidence && semantic.missingEvidence.length > 0
      ? { missingEvidence: semantic.missingEvidence }
      : {}),
    ...(semantic?.recommendedFollowup &&
    semantic.recommendedFollowup.length > 0
      ? { recommendedFollowup: semantic.recommendedFollowup }
      : {}),
  }
}

export function summarizeDirectEditorAttempt(
  record: MatOSDirectAssetEditorRunRecord,
  attempt: number,
  feedback: MatOSDirectAssetEditorPreviousAttempt | undefined,
): MatOSDirectAssetEditorAttemptSummary {
  const semantic = record.semanticAcceptance
  return {
    attempt,
    runId: record.runId,
    status: record.status,
    ...(feedback?.rejectionStage
      ? { rejectionStage: feedback.rejectionStage }
      : {}),
    ...(record.rollback?.reason ? { reason: record.rollback.reason } : {}),
    ...(record.introducedValidationErrors
      ? {
          introducedValidationErrorCount:
            record.introducedValidationErrors.length,
        }
      : {}),
    ...(semantic ? { judgeVerdict: semantic.verdict } : {}),
    ...(semantic?.reason ? { judgeReason: semantic.reason } : {}),
    ...(semantic?.missingEvidence && semantic.missingEvidence.length > 0
      ? { missingEvidence: semantic.missingEvidence }
      : {}),
    ...(semantic?.recommendedFollowup &&
    semantic.recommendedFollowup.length > 0
      ? { recommendedFollowup: semantic.recommendedFollowup }
      : {}),
  }
}
