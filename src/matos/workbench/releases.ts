import { createHash } from 'node:crypto'
import { lstat,readdir } from 'node:fs/promises'
import { join,relative } from 'node:path'
import { git } from '../assets/history/gitBackend.js'
import {
createMatOSAssetHistorySnapshot,
createMatOSAssetRelease,
listMatOSAssetHistorySnapshots,
matOSAssetHistoryStableRef,
readMatOSAssetHistoryRelease,
readMatOSAssetHistorySnapshot,
rollbackMatOSAssetRelease,
} from '../assets/history/index.js'
import type { MatOSAssetHistorySnapshotRecord } from '../assets/history/types.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { showMatOSWorkbenchResource } from './resources.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchContext,
MatOSWorkbenchOperatorReview,
MatOSWorkbenchReleaseAction,
MatOSWorkbenchReleaseApplyResult,
MatOSWorkbenchReleaseGate,
MatOSWorkbenchReleasePreview,
} from './types.js'
import { previewMatOSWorkbenchWriteTransaction } from './writeTransactions.js'

type UnknownRecord = Record<string, unknown>

const WRITE_GATE_REASON =
  'This is a read-only release preview. Persistent publish or rollback requires an explicit native MatOS release apply request with the current confirmation fingerprint.'

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function normalizeReleaseAction(action: unknown): MatOSWorkbenchReleaseAction {
  const raw = String(action || '').trim().toLowerCase()
  if (raw === 'approve' || raw === 'accept') {
    return 'approve'
  }
  if (raw === 'reject' || raw === 'deny') {
    return 'reject'
  }
  if (raw === 'rollback' || raw === 'revert') {
    return 'rollback'
  }
  return 'publish'
}

function confirmationFingerprintFor(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function snapshotSummary(snapshot: MatOSAssetHistorySnapshotRecord) {
  return {
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    files: snapshot.files,
    assetRefs: snapshot.assetRefs,
  }
}

function unversionedRef(ref: string): string {
  return ref.replace(/@[^:@/]+$/, '')
}

function snapshotMentionsRef(
  snapshot: MatOSAssetHistorySnapshotRecord,
  ref: string,
): boolean {
  const normalized = unversionedRef(ref)
  return snapshot.assetRefs.some(assetRef => {
    const candidate = String(assetRef)
    return candidate === ref || unversionedRef(candidate) === normalized
  })
}

async function resolveSnapshotForReleaseApply(input: {
  cwd: string
  ref: string
  snapshotRef?: string
}): Promise<MatOSAssetHistorySnapshotRecord> {
  if (input.snapshotRef) {
    if (input.snapshotRef.startsWith('asset-snapshot-')) {
      const snapshot = await readMatOSAssetHistorySnapshot(input.cwd, input.snapshotRef)
      if (snapshot) {
        return snapshot
      }
    }
    const snapshots = await listMatOSAssetHistorySnapshots(input.cwd)
    const byCommit = snapshots.find(snapshot => snapshot.commit === input.snapshotRef)
    if (byCommit) {
      return byCommit
    }
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotRef}`)
  }
  const snapshots = await listMatOSAssetHistorySnapshots(input.cwd)
  const snapshot = snapshots.find(candidate => snapshotMentionsRef(candidate, input.ref))
  if (!snapshot) {
    throw new Error(
      `No MatOS asset-history snapshot found for ${input.ref}; apply a controlled draft or create a snapshot before publishing.`,
    )
  }
  return snapshot
}

async function resolveSnapshotRef(input: {
  cwd: string
  ref: string
}): Promise<MatOSAssetHistorySnapshotRecord | undefined> {
  if (input.ref.startsWith('asset-snapshot-')) {
    const snapshot = await readMatOSAssetHistorySnapshot(input.cwd, input.ref)
    if (snapshot) {
      return snapshot
    }
  }
  const snapshots = await listMatOSAssetHistorySnapshots(input.cwd)
  return snapshots.find(snapshot => snapshot.commit === input.ref)
}

async function readStableCommit(
  cwd: string,
  scope: MatOSAssetHistorySnapshotRecord['scope'],
  scopeRef?: string,
): Promise<string | undefined> {
  try {
    return (
      await git(cwd, [
        'rev-parse',
        '--verify',
        matOSAssetHistoryStableRef(scope, scopeRef),
      ])
    ).trim()
  } catch {
    return undefined
  }
}

async function collectWorkspaceFiles(cwd: string, workspacePath: string): Promise<string[]> {
  const absolutePath = join(cwd, workspacePath)
  const info = await lstat(absolutePath)
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing release snapshot through symlink path: ${workspacePath}`)
  }
  if (info.isFile()) {
    return [relative(cwd, absolutePath).replace(/\\/g, '/')]
  }
  if (!info.isDirectory()) {
    return []
  }
  const entries = await readdir(absolutePath, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const child = join(workspacePath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectWorkspaceFiles(cwd, child)))
    } else if (entry.isFile()) {
      files.push(child.replace(/\\/g, '/'))
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Refusing release snapshot through symlink path: ${child}`)
    }
  }
  return files
}

async function releaseSnapshotPathsForPreview(
  input: MatOSWorkbenchContext & { includeHidden?: boolean },
  preview: MatOSWorkbenchReleasePreview,
): Promise<string[]> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const refs = [
    preview.ref,
    ...arrayOfStrings(preview.provenance.dependencies),
  ]
  const paths: string[] = []
  const seenRefs = new Set<string>()
  for (const ref of refs) {
    if (seenRefs.has(ref)) {
      continue
    }
    seenRefs.add(ref)
    const asset = registry.resolve(ref)
    if (!asset?.manifestDir) {
      throw new Error(`MatOS release snapshot cannot resolve asset path for ${ref}.`)
    }
    paths.push(
      ...(await collectWorkspaceFiles(
        input.cwd,
        relative(input.cwd, asset.manifestDir).replace(/\\/g, '/'),
      )),
    )
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right))
}

function inspectAction(ref: string): MatOSWorkbenchAction {
  return {
    key: 'inspect',
    label: 'Inspect',
    enabled: true,
    maturity: 'route-only',
    command: {
      argv: ['workbench', 'resources', 'show', ref, '--json'],
      command: `matos "workbench" "resources" "show" ${JSON.stringify(ref)} "--json"`,
    },
  }
}

function releaseAction(input: {
  key: MatOSWorkbenchReleaseAction
  label: string
  selected: boolean
  fingerprint: string
}): MatOSWorkbenchAction {
  return {
    key: input.key,
    label: input.selected ? `${input.label} Preview` : input.label,
    enabled: false,
    maturity: 'read-only',
    reason: WRITE_GATE_REASON,
    requiresConfirmation: input.key === 'publish' || input.key === 'approve' || input.key === 'rollback',
    danger: input.key === 'rollback' || input.key === 'reject',
    confirmationFingerprint: input.fingerprint,
  }
}

function releaseActions(
  ref: string,
  requestedAction: MatOSWorkbenchReleaseAction,
  fingerprint: string,
): MatOSWorkbenchAction[] {
  return [
    inspectAction(ref),
    releaseAction({ key: 'publish', label: 'Publish', selected: requestedAction === 'publish', fingerprint }),
    releaseAction({ key: 'approve', label: 'Approve', selected: requestedAction === 'approve', fingerprint }),
    releaseAction({ key: 'reject', label: 'Reject', selected: requestedAction === 'reject', fingerprint }),
    releaseAction({ key: 'rollback', label: 'Rollback', selected: requestedAction === 'rollback', fingerprint }),
  ]
}

function gate(input: MatOSWorkbenchReleaseGate): MatOSWorkbenchReleaseGate {
  return input
}

function releaseOperatorReview(input: {
  ref: string
  type: MatOSWorkbenchReleasePreview['summary']['type']
  action: MatOSWorkbenchReleaseAction
  source?: string
}): MatOSWorkbenchOperatorReview {
  const projectLocal = input.source === 'project'
  const nativeAction = input.action === 'rollback' ? 'rollback' : 'publish'
  return {
    mode: 'native-operator-review',
    status: projectLocal ? 'confirmation-required' : 'blocked',
    policy: projectLocal ? 'asset-history-release' : 'shared-global-promotion-blocked',
    targetRef: input.ref,
    targetType: input.type,
    ...(input.source ? { source: input.source } : {}),
    reason: projectLocal
      ? `Project-local ${nativeAction} is available only through MatOS asset-history release apply with the current confirmation fingerprint.`
      : `Shared/global/core ${nativeAction} is not available from the workspace. MatOS can show release evidence; persistent promotion needs a promotion policy and native promotion writer.`,
    scopeGate: {
      allowedSources: ['project'],
      ...(input.source ? { actualSource: input.source } : {}),
      status: projectLocal ? 'passed' : 'blocked',
      reason: projectLocal
        ? 'Resource is project-local and can use the asset-history release writer after confirmation.'
        : 'Resource is not project-local. Promotion to shared/global/core must remain disabled until a promotion policy is configured.',
    },
    nativeNextStep: projectLocal
      ? {
          label: 'Apply native release action',
          description: 'Use the current confirmation fingerprint to apply the release through MatOS asset history.',
          route: {
            argv: [
              'workbench',
              'releases',
              'apply',
              input.ref,
              '--action',
              nativeAction,
              '--fingerprint',
              '<sha256>',
              '--json',
            ],
            command: `matos "workbench" "releases" "apply" ${JSON.stringify(input.ref)} "--action" ${JSON.stringify(nativeAction)} "--fingerprint" "<sha256>" "--json"`,
          },
        }
      : {
          label: 'Inspect native release preview',
          description: 'Use the release preview for operator evidence. Do not apply until shared/global/core promotion governance exists.',
          route: {
            argv: [
              'workbench',
              'releases',
              'preview',
              input.ref,
              '--action',
              nativeAction,
              '--include-hidden',
              '--json',
            ],
            command: `matos "workbench" "releases" "preview" ${JSON.stringify(input.ref)} "--action" ${JSON.stringify(nativeAction)} "--include-hidden" "--json"`,
          },
        },
  }
}

export async function previewMatOSWorkbenchRelease(
  input: MatOSWorkbenchContext & {
    ref: string
    action?: string
    includeHidden?: boolean
  },
): Promise<MatOSWorkbenchReleasePreview> {
  const requestedAction = normalizeReleaseAction(input.action)
  const shown = await showMatOSWorkbenchResource({
    ...input,
    includeDisabled: true,
    includeGraph: true,
    includeHidden: input.includeHidden,
    ref: input.ref,
  })
  const resource = shown.resource
  const detail = shown.detail
  const dependencies = detail?.relationships.dependencies ?? resource.dependencies ?? []
  const consumers = detail?.relationships.consumers ?? []
  const rollbackTargets = detail?.history.rollbackTargets ?? []
  const metadata = recordValue(resource.metadata)
  const sourcePath = stringValue(metadata.path)
  const fingerprint = confirmationFingerprintFor({
    action: requestedAction,
    ref: resource.ref,
    version: resource.version,
    lifecycle: resource.lifecycle,
    dependencies,
    consumers,
    rollbackTargets,
    source: resource.source,
    packId: resource.packId,
  })
  const operatorReview = releaseOperatorReview({
    ref: resource.ref,
    type: resource.type,
    action: requestedAction,
    source: resource.source,
  })
  const actions = releaseActions(resource.ref, requestedAction, fingerprint)
  const gates: MatOSWorkbenchReleaseGate[] = [
    gate({
      key: 'resource-resolved',
      label: 'Resource resolved',
      status: 'passed',
      summary: `${resource.ref} resolved through the native MatOS asset registry.`,
    }),
    gate({
      key: 'resource-visible',
      label: 'Resource visible',
      status: 'passed',
      summary: input.includeHidden
        ? 'Resolved with includeHidden for an operator workbench request.'
        : 'Resource is allowed on this user-facing workbench surface.',
    }),
    gate({
      key: 'dependency-graph',
      label: 'Dependency graph',
      status: detail ? 'passed' : 'unknown',
      summary: `${dependencies.length} dependencies, ${consumers.length} consumers, ${rollbackTargets.length} rollback targets collected.`,
      evidence: {
        dependencies,
        consumers,
        rollbackTargets,
      },
    }),
    gate({
      key: 'write-gate',
      label: 'Write gate',
      status: 'blocked',
      summary: WRITE_GATE_REASON,
    }),
  ]
  const transaction = previewMatOSWorkbenchWriteTransaction({
    source: 'matos-release',
    requestedMutation: requestedAction,
    targetRef: resource.ref,
    targetType: resource.type,
    scopeRef: input.scopeRef,
    patch: {
      action: requestedAction,
      version: resource.version,
      lifecycle: resource.lifecycle,
      dependencies,
      consumers,
      rollbackTargets,
    },
    validationOk: true,
    errorCount: 0,
    warningCount: 0,
    validationEvidence: {
      gates,
      summary: `${dependencies.length} dependencies, ${consumers.length} consumers, ${rollbackTargets.length} rollback targets collected.`,
    },
    deterministicSmoke: {
      ok: true,
      summary: detail
        ? 'Release preview resolved native resource detail and dependency evidence.'
        : 'Release preview resolved native resource identity; dependency detail is partial.',
      evidence: {
        dependencyCount: dependencies.length,
        consumerCount: consumers.length,
        rollbackTargetCount: rollbackTargets.length,
      },
    },
    rollbackTargets,
    confirmationFingerprint: fingerprint,
  })
  return {
    mode: 'release-preview',
    readonly: true,
    ref: resource.ref,
    requestedAction,
    resource,
    ...(detail ? { detail } : {}),
    summary: {
      type: resource.type,
      name: resource.name,
      ...(resource.version ? { version: resource.version } : {}),
      ...(resource.lifecycle ? { lifecycle: resource.lifecycle } : {}),
      dependencyCount: dependencies.length,
      consumerCount: consumers.length,
      rollbackTargetCount: rollbackTargets.length,
    },
    gates,
    provenance: {
      ...(resource.source ? { source: resource.source } : {}),
      ...(resource.packId ? { packId: resource.packId } : {}),
      ...(sourcePath ? { path: sourcePath } : {}),
      dependencies,
      consumers,
      rollbackTargets,
    },
    releasePacket: {
      mode: 'read-only-release-preview',
      canMutate: false,
      action: requestedAction,
      confirmationFingerprint: fingerprint,
      actions,
      rollbackTargets,
      dependencies,
      consumers,
      operatorReview,
    },
    operatorReview,
    transaction,
    write: {
      enabled: false,
      reason: operatorReview.status === 'blocked'
        ? operatorReview.reason
        : WRITE_GATE_REASON,
    },
  }
}

export async function applyMatOSWorkbenchRelease(
  input: MatOSWorkbenchContext & {
    ref: string
    action?: string
    fingerprint: string
    reason?: string
    snapshotRef?: string
    releaseId?: string
    releaseName?: string
    forceStale?: boolean
    includeHidden?: boolean
  },
): Promise<MatOSWorkbenchReleaseApplyResult> {
  const requestedAction = normalizeReleaseAction(input.action)
  if (requestedAction !== 'publish' && requestedAction !== 'rollback') {
    throw new Error(
      `MatOS release apply only supports publish and rollback in this controlled writer slice; got ${requestedAction}.`,
    )
  }
  const preview = await previewMatOSWorkbenchRelease({
    ...input,
    ref: input.ref,
    action: requestedAction,
    includeHidden: input.includeHidden,
  })
  if (input.fingerprint !== preview.releasePacket.confirmationFingerprint) {
    throw new Error(
      'Release apply confirmation fingerprint does not match the current MatOS release packet.',
    )
  }
  if (preview.resource.source !== 'project') {
    throw new Error(
      `Release apply is only enabled for project-local assets; ${preview.ref} comes from ${preview.resource.source ?? 'unknown'}.`,
    )
  }

  const before = {
    resource: preview.resource,
    ...(preview.detail ? { detail: preview.detail } : {}),
  }

  if (requestedAction === 'publish') {
    const sourceSnapshot = await resolveSnapshotForReleaseApply({
      cwd: input.cwd,
      ref: preview.ref,
      snapshotRef: input.snapshotRef,
    })
    const stableCommit = await readStableCommit(
      input.cwd,
      sourceSnapshot.scope,
      sourceSnapshot.scopeRef,
    )
    const releasePaths = await releaseSnapshotPathsForPreview(input, preview)
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'release',
      scope: sourceSnapshot.scope,
      ...(sourceSnapshot.scopeRef
        ? { scopeRef: sourceSnapshot.scopeRef }
        : {}),
      parentCommit: stableCommit ?? sourceSnapshot.commit,
      message: `workbench release publish ${preview.ref}`,
      paths: releasePaths,
      assetRefs: [preview.ref],
      provenance: {
        source: 'matos-workbench',
        operation: 'releases.apply.snapshot',
        action: 'publish',
        assetRef: preview.ref,
        sourceSnapshot: sourceSnapshot.snapshotId,
        confirmationFingerprint: preview.releasePacket.confirmationFingerprint,
        reason: input.reason,
      },
    })
    const created = await createMatOSAssetRelease({
      cwd: input.cwd,
      name: input.releaseName ?? `${preview.ref} publish`,
      ref: snapshot.snapshotId,
      forceStale: input.forceStale,
      provenance: {
        source: 'matos-workbench',
        operation: 'releases.apply',
        action: 'publish',
        assetRef: preview.ref,
        confirmationFingerprint: preview.releasePacket.confirmationFingerprint,
        snapshotId: snapshot.snapshotId,
        reason: input.reason,
      },
    })
    if ('error' in created) {
      const details = created.validation
        ? `: ${JSON.stringify(created.validation)}`
        : ''
      throw new Error(`${created.error}${details}`)
    }
    const after = await showMatOSWorkbenchResource({
      ...input,
      ref: preview.ref,
      includeDisabled: true,
      includeGraph: true,
      includeHidden: input.includeHidden,
    }).catch(() => undefined)
    return {
      mode: 'controlled-write',
      source: 'matos-release',
      action: 'publish',
      ref: preview.ref,
      applied: true,
      readonly: false,
      preview,
      transaction: preview.transaction,
      before,
      ...(after ? { after } : {}),
      snapshot: snapshotSummary(snapshot),
      release: created.release,
      validation: created.validation,
      write: {
        enabled: true,
        status: 'applied',
      },
      audit: {
        target: 'matos-asset-history',
        operation: 'releases.apply',
        reason: input.reason,
      },
    }
  }

  if (!input.releaseId) {
    throw new Error('Release rollback apply requires --release-id.')
  }
  const release = await readMatOSAssetHistoryRelease(input.cwd, input.releaseId)
  if (!release) {
    throw new Error(`MatOS asset release not found: ${input.releaseId}`)
  }
  const releasedSnapshot = await resolveSnapshotRef({
    cwd: input.cwd,
    ref: release.sourceRef,
  })
  if (releasedSnapshot && !snapshotMentionsRef(releasedSnapshot, preview.ref)) {
    throw new Error(
      `Refusing release rollback: ${input.releaseId} does not reference ${preview.ref}.`,
    )
  }
  const rolledBack = await rollbackMatOSAssetRelease({
    cwd: input.cwd,
    releaseId: input.releaseId,
  })
  if ('error' in rolledBack) {
    throw new Error(rolledBack.error)
  }
  const after = await showMatOSWorkbenchResource({
    ...input,
    ref: preview.ref,
    includeDisabled: true,
    includeGraph: true,
    includeHidden: input.includeHidden,
  }).catch(() => undefined)
  return {
    mode: 'controlled-write',
    source: 'matos-release',
    action: 'rollback',
    ref: preview.ref,
    applied: true,
    readonly: false,
    preview,
    transaction: preview.transaction,
    before,
    ...(after ? { after } : {}),
    release: rolledBack.release,
    rollback: {
      releaseId: input.releaseId,
      restoredSnapshot: snapshotSummary(rolledBack.restoredSnapshot),
      restoredFiles: rolledBack.rollback.restoredFiles,
      removedFiles: rolledBack.rollback.removedFiles,
    },
    validation: rolledBack.validation,
    write: {
      enabled: true,
      status: 'rolled-back',
    },
    audit: {
      target: 'matos-asset-history',
      operation: 'releases.apply',
      reason: input.reason,
    },
  }
}
