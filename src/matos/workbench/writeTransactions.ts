import { createHash } from 'node:crypto'
import type {
MatOSWorkbenchResourceType,
MatOSWorkbenchWriteTransactionGate,
MatOSWorkbenchWriteTransactionPreview,
} from './types.js'

const WRITE_GATE_REASON =
  'Persistent MatOS asset writes require native permission, scope, history snapshot, rollback, deterministic validation, semantic acceptance, and audit gates before the writer can mutate assets.'

function stableJson(value: unknown): string {
  return JSON.stringify(sortForHash(value))
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForHash)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForHash(item)]),
  )
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function gate(input: MatOSWorkbenchWriteTransactionGate): MatOSWorkbenchWriteTransactionGate {
  return input
}

export function previewMatOSWorkbenchWriteTransaction(input: {
  source: MatOSWorkbenchWriteTransactionPreview['source']
  requestedMutation: string
  targetRef?: string
  targetType?: MatOSWorkbenchResourceType | 'unknown'
  scopeRef?: string
  patch?: unknown
  validationOk: boolean
  errorCount?: number
  warningCount?: number
  validationEvidence?: unknown
  deterministicSmoke?: {
    ok?: boolean
    summary: string
    evidence?: unknown
  }
  rollbackTargets?: unknown[]
  confirmationFingerprint?: string
}): MatOSWorkbenchWriteTransactionPreview {
  const errorCount = input.errorCount ?? (input.validationOk ? 0 : 1)
  const warningCount = input.warningCount ?? 0
  const targetRef = input.targetRef
  const rollbackTargets = input.rollbackTargets ?? []
  const confirmationFingerprint =
    input.confirmationFingerprint ??
    fingerprint({
      source: input.source,
      requestedMutation: input.requestedMutation,
      targetRef,
      targetType: input.targetType,
      scopeRef: input.scopeRef,
      patch: input.patch,
      validationOk: input.validationOk,
      errorCount,
      warningCount,
    })
  const smoke = input.deterministicSmoke
  const gates: MatOSWorkbenchWriteTransactionGate[] = [
    gate({
      key: 'canonical-target',
      label: 'Canonical target',
      status: targetRef ? 'passed' : 'unknown',
      summary: targetRef
        ? `Mutation targets canonical MatOS resource ${targetRef}.`
        : 'Mutation did not include a canonical MatOS target yet; create flows need a writer-selected target path.',
      evidence: {
        targetRef,
        targetType: input.targetType ?? 'unknown',
      },
    }),
    gate({
      key: 'draft-validation',
      label: 'Draft validation',
      status: input.validationOk ? 'passed' : 'blocked',
      summary: input.validationOk
        ? `Draft validation passed with ${warningCount} warning(s).`
        : `Draft validation failed with ${errorCount} error(s).`,
      evidence: input.validationEvidence,
    }),
    gate({
      key: 'permission-scope',
      label: 'Permission and scope',
      status: 'pending',
      summary:
        'A controlled writer must verify the caller, scope, editable roots, and promotion policy before mutating this asset.',
      evidence: {
        scopeRef: input.scopeRef,
      },
    }),
    gate({
      key: 'history-snapshot',
      label: 'History snapshot',
      status: 'pending',
      summary:
        'A controlled writer must snapshot the before-state in MatOS asset history before applying this mutation.',
    }),
    gate({
      key: 'rollback-target',
      label: 'Rollback target',
      status: 'pending',
      summary: rollbackTargets.length
        ? `${rollbackTargets.length} existing rollback target(s) were found; the writer must add a fresh before-state rollback record.`
        : 'No reusable rollback target is attached to this preview; the writer must create one before mutation.',
      evidence: {
        rollbackTargets,
      },
    }),
    gate({
      key: 'deterministic-smoke',
      label: 'Deterministic smoke',
      status: smoke ? (smoke.ok === false ? 'blocked' : 'passed') : 'pending',
      summary: smoke
        ? smoke.summary
        : 'A controlled writer must reload, validate, compose, compile, or dry-run the affected asset after mutation.',
      evidence: smoke?.evidence,
    }),
    gate({
      key: 'semantic-acceptance',
      label: 'Semantic acceptance',
      status: 'pending',
      summary:
        'A semantic judge must compare trajectory, before/after asset snapshots, diff, and validation evidence before accepting automated edits.',
    }),
    gate({
      key: 'audit-record',
      label: 'Audit record',
      status: 'pending',
      summary:
        'A controlled writer must append an auditable MatOS asset-write transaction record with provenance and rollback metadata.',
    }),
    gate({
      key: 'write-gate',
      label: 'Write gate',
      status: 'blocked',
      summary: WRITE_GATE_REASON,
    }),
  ]
  return {
    mode: 'write-transaction-preview',
    readonly: true,
    canMutate: false,
    source: input.source,
    requestedMutation: input.requestedMutation,
    ...(targetRef ? { targetRef } : {}),
    ...(input.targetType ? { targetType: input.targetType } : {}),
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    confirmationFingerprint,
    validation: {
      ok: input.validationOk,
      errorCount,
      warningCount,
    },
    gates,
    rollback: {
      required: true,
      snapshotRequired: true,
      targets: rollbackTargets,
    },
    audit: {
      required: true,
      target: 'matos-asset-history',
      recordType: 'asset-write-transaction',
    },
    write: {
      enabled: false,
      reason: WRITE_GATE_REASON,
    },
  }
}
