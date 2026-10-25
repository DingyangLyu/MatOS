import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createMatOSAssetHistorySnapshot,
  diffMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshots,
  readMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  matOSAssetHistoryStableRef,
  type MatOSAssetHistoryScope,
  type MatOSAssetHistorySnapshotRecord,
} from '../assets/history/index.js'
import { git } from '../assets/history/gitBackend.js'
import {
  resolveMatOSAssetHistoryRecordPath,
} from '../assets/history/policy.js'

export const DIRECT_EDITOR_RUNS_DIR = [
  'evolution',
  'direct-editor',
  'runs',
] as const

export type DirectEditorRollbackResult = {
  status: 'rolled_back' | 'rollback_failed'
  rollbackSnapshot?: string
  rollback: {
    reason: string
    restoredFromSnapshot?: string
    rollbackSnapshot?: string
  }
}

export async function stableCommitForDirectEditorScope(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): Promise<string | undefined> {
  const scopedCommit = await git(cwd, [
    'rev-parse',
    '--verify',
    matOSAssetHistoryStableRef(scope, scopeRef),
  ])
    .then(value => value.trim())
    .catch(() => undefined)
  if (scopedCommit || !scopeRef) {
    return scopedCommit
  }

  // One-time compatibility path for snapshots written before stable refs were
  // owner-qualified. Never adopt a legacy ref unless its snapshot files all
  // resolve inside this exact owner's current allowlist.
  const legacyCommit = await git(cwd, [
    'rev-parse',
    '--verify',
    matOSAssetHistoryStableRef(scope),
  ])
    .then(value => value.trim())
    .catch(() => undefined)
  if (!legacyCommit) return undefined
  const snapshots = await listMatOSAssetHistorySnapshots(cwd)
  const legacySnapshot = snapshots.find(
    snapshot => snapshot.scope === scope && snapshot.commit === legacyCommit,
  )
  return legacySnapshot && snapshotBelongsToScopeRef(cwd, legacySnapshot, scopeRef)
    ? legacyCommit
    : undefined
}

function snapshotBelongsToScopeRef(
  cwd: string,
  snapshot: MatOSAssetHistorySnapshotRecord,
  scopeRef: string,
): boolean {
  if (snapshot.scopeRef) return snapshot.scopeRef === scopeRef
  return snapshot.files.length > 0 && snapshot.files.every(file => {
    try {
      resolveMatOSAssetHistoryRecordPath({
        cwd,
        scope: snapshot.scope,
        scopeRef,
        path: file.path,
      })
      return true
    } catch {
      return false
    }
  })
}

export async function stableSnapshotForDirectEditorScope(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): Promise<string | undefined> {
  const stableCommit = await stableCommitForDirectEditorScope(cwd, scope, scopeRef)
  if (!stableCommit) {
    return undefined
  }
  const snapshots = await listMatOSAssetHistorySnapshots(cwd)
  return snapshots.find(
    snapshot =>
      snapshot.scope === scope &&
      snapshot.commit === stableCommit &&
      (!scopeRef || snapshotBelongsToScopeRef(cwd, snapshot, scopeRef)),
  )
    ?.snapshotId
}

async function reachableParentCommit(
  cwd: string,
  commit: string | undefined,
): Promise<string | undefined> {
  if (!commit) {
    return undefined
  }
  try {
    await git(cwd, ['cat-file', '-e', `${commit}^{commit}`])
    return commit
  } catch {
    return undefined
  }
}

export async function createDirectEditorBeforeSnapshot(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  runId: string
  triggerKey?: string
  experienceRefs?: string[]
}) {
  return createMatOSAssetHistorySnapshot({
    cwd: input.cwd,
    kind: 'direct-editor-before',
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ref: `refs/matos/evolution/direct-editor/${input.runId}/before`,
    provenance: {
      runId: input.runId,
      triggerKey: input.triggerKey,
      experienceRefs: input.experienceRefs,
    },
  })
}

export async function createDirectEditorAfterSnapshot(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  runId: string
  parentCommit: string
  triggerKey?: string
  experienceRefs?: string[]
}) {
  return createMatOSAssetHistorySnapshot({
    cwd: input.cwd,
    kind: 'direct-editor-after',
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ref: `refs/matos/evolution/direct-editor/${input.runId}/after`,
    parentCommit: input.parentCommit,
    provenance: {
      runId: input.runId,
      triggerKey: input.triggerKey,
      experienceRefs: input.experienceRefs,
    },
  })
}

export async function writeDirectEditorDiffPatch(input: {
  cwd: string
  runId: string
  beforeSnapshot: string
  afterSnapshot: string
}): Promise<{ path: string; hasChanges: boolean }> {
  const diff = await diffMatOSAssetHistorySnapshots({
    cwd: input.cwd,
    from: input.beforeSnapshot,
    to: input.afterSnapshot,
  })
  const relativePath = join(
    '.matos',
    ...DIRECT_EDITOR_RUNS_DIR,
    input.runId,
    'diff.patch',
  ).replace(/\\/g, '/')
  const path = join(input.cwd, relativePath)
  await mkdir(join(input.cwd, '.matos', ...DIRECT_EDITOR_RUNS_DIR, input.runId), {
    recursive: true,
  })
  await writeFile(path, diff.patch, 'utf8')
  return { path: relativePath, hasChanges: diff.patch.trim().length > 0 }
}


export async function rollbackDirectEditorToBefore(input: {
  cwd: string
  runId: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  beforeSnapshotId: string
  beforeCommit: string
  reason: string
  compareSnapshotId?: string
  // Logical asset-history paths (files or directory prefixes) written by this
  // run. When provided, the rollback only reverts inside this set: concurrent
  // third-party paths are never scanned, read, or rewritten.
  runTouchedPaths?: string[]
}): Promise<DirectEditorRollbackResult> {
  try {
    const restoreResult = await restoreMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: input.beforeSnapshotId,
      removeCreatedFiles: Boolean(input.compareSnapshotId),
      ...(input.compareSnapshotId
        ? { compareSnapshotId: input.compareSnapshotId }
        : {}),
      ...(input.runTouchedPaths ? { onlyPaths: input.runTouchedPaths } : {}),
    })
    // A created runtime file that survives rejection is not a complete rollback.
    const reason =
      restoreResult.skippedRemovals.length > 0
        ? `${input.reason}; skipped ${restoreResult.skippedRemovals.length} undeletable residue path(s): ${restoreResult.skippedRemovals.slice(0, 5).join(', ')}`
        : input.reason
    const before = input.runTouchedPaths ? await readMatOSAssetHistorySnapshot(input.cwd, input.beforeSnapshotId) : undefined
    const rollbackPaths = before?.files.filter(file => input.runTouchedPaths!.some(root => file.path === root || file.path.startsWith(`${root}/`))).map(file => file.path)
    const rollbackRecord = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'direct-editor-rollback',
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      ...(rollbackPaths ? { paths: rollbackPaths } : {}),
      ...(await reachableParentCommit(input.cwd, input.beforeCommit)
        ? { parentCommit: input.beforeCommit }
        : {}),
      provenance: {
        runId: input.runId,
        reason,
      },
    })
    return {
      status: restoreResult.skippedRemovals.length > 0 ? 'rollback_failed' : 'rolled_back',
      rollbackSnapshot: rollbackRecord.snapshotId,
      rollback: {
        reason,
        restoredFromSnapshot: input.beforeSnapshotId,
        rollbackSnapshot: rollbackRecord.snapshotId,
      },
    }
  } catch (error) {
    return {
      status: 'rollback_failed',
      rollback: {
        reason: error instanceof Error ? error.message : String(error),
        restoredFromSnapshot: input.beforeSnapshotId,
      },
    }
  }
}

export async function createDirectEditorRollbackSnapshot(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  runId: string
  parentCommit?: string
  reason: string
}) {
  return createMatOSAssetHistorySnapshot({
    cwd: input.cwd,
    kind: 'direct-editor-rollback',
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...((await reachableParentCommit(input.cwd, input.parentCommit))
      ? { parentCommit: input.parentCommit }
      : {}),
    provenance: {
      runId: input.runId,
      reason: input.reason,
    },
  })
}

export async function updateDirectEditorStableRef(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  commit: string
}): Promise<void> {
  await git(input.cwd, [
    'update-ref',
    matOSAssetHistoryStableRef(input.scope, input.scopeRef),
    input.commit,
  ])
}
