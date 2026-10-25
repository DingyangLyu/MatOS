import { randomBytes } from 'node:crypto'
import {
  listMatOSAssetHistorySnapshots,
  readMatOSAssetHistoryRelease,
  readMatOSAssetHistorySnapshot,
  writeMatOSAssetHistoryReleaseRecord,
} from './records.js'
import { restoreMatOSAssetHistorySnapshot } from './restore.js'
import {
  matosAssetValidationErrorFingerprint,
  validateMatOSAssetHistorySnapshot,
} from './validation.js'
import { withMatOSAssetHistoryLock } from './lock.js'
import { git } from './gitBackend.js'
import { matOSAssetHistoryStableRef } from './refs.js'
import type {
  MatOSAssetHistoryReleaseRecord,
  MatOSAssetHistorySnapshotRecord,
  MatOSAssetHistoryValidationResult,
} from './types.js'

export type CreateMatOSAssetReleaseInput = {
  cwd: string
  name: string
  ref?: string
  forceStale?: boolean
  provenance?: Record<string, unknown>
}

export type CreateMatOSAssetReleaseResult =
  | {
      release: MatOSAssetHistoryReleaseRecord
      validation: MatOSAssetHistoryValidationResult
    }
  | {
      error: string
      validation?: MatOSAssetHistoryValidationResult
    }

export type RollbackMatOSAssetReleaseInput = {
  cwd: string
  releaseId: string
}

export type RollbackMatOSAssetReleaseResult =
  | {
      release: MatOSAssetHistoryReleaseRecord
      rollback: { restoredFiles: string[]; removedFiles: string[] }
      validation: MatOSAssetHistoryValidationResult
      restoredSnapshot: MatOSAssetHistorySnapshotRecord
    }
  | { error: string }

function releaseIdFromName(name: string): string {
  const safeName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = randomBytes(4).toString('hex')
  return `asset-release-${safeName || 'release'}-${suffix}`
}

async function resolveSnapshotForHistoryRef(
  cwd: string,
  ref: string | undefined,
): Promise<MatOSAssetHistorySnapshotRecord | undefined> {
  const snapshots = await listMatOSAssetHistorySnapshots(cwd)
  if (!ref) {
    return snapshots[0]
  }
  if (ref.startsWith('asset-snapshot-')) {
    const byId = await readMatOSAssetHistorySnapshot(cwd, ref)
    if (byId) {
      return byId
    }
  }
  return snapshots.find(snapshot => snapshot.commit === ref)
}

async function readAssetHistoryRefCommit(
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', ref])).trim()
  } catch {
    return undefined
  }
}

async function isAssetHistoryAncestor(
  cwd: string,
  ancestorCommit: string,
  descendantCommit: string,
): Promise<boolean> {
  if (ancestorCommit === descendantCommit) {
    return true
  }
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestorCommit, descendantCommit])
    return true
  } catch {
    return false
  }
}

export async function createMatOSAssetRelease(
  input: CreateMatOSAssetReleaseInput,
): Promise<CreateMatOSAssetReleaseResult> {
  return withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'assets-release-create',
    },
    async () => {
      const snapshot = await resolveSnapshotForHistoryRef(input.cwd, input.ref)
      if (!snapshot) {
        return { error: 'MatOS asset history snapshot not found for release' }
      }
      const validation = await validateMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: snapshot.snapshotId,
      })
      if (!validation.ok) {
        return {
          error: 'MatOS asset release validation failed',
          validation,
        }
      }
      const stableRef = matOSAssetHistoryStableRef(
        snapshot.scope,
        snapshot.scopeRef,
      )
      const previousStableCommit = await readAssetHistoryRefCommit(input.cwd, stableRef)
      if (
        previousStableCommit &&
        !input.forceStale &&
        !(await isAssetHistoryAncestor(input.cwd, previousStableCommit, snapshot.commit))
      ) {
        return {
          error:
            'Refusing stale MatOS asset release create: selected snapshot is not descended from current stable; pass --force-stale to override',
        }
      }
      const release: MatOSAssetHistoryReleaseRecord = {
        schemaVersion: 1,
        releaseId: releaseIdFromName(input.name),
        name: input.name,
        createdAt: new Date().toISOString(),
        sourceRef: snapshot.snapshotId,
        commit: snapshot.commit,
        ...(previousStableCommit ? { previousStableCommit } : {}),
        validation,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      }
      await writeMatOSAssetHistoryReleaseRecord(input.cwd, release)
      await git(input.cwd, [
        'update-ref',
        `refs/matos/releases/${release.releaseId}`,
        snapshot.commit,
      ])
      await git(input.cwd, ['update-ref', stableRef, snapshot.commit])
      return { release, validation }
    },
  )
}

export async function rollbackMatOSAssetRelease(
  input: RollbackMatOSAssetReleaseInput,
): Promise<RollbackMatOSAssetReleaseResult> {
  return withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'assets-release-rollback',
    },
    async () => {
      const release = await readMatOSAssetHistoryRelease(input.cwd, input.releaseId)
      if (!release) {
        return { error: `MatOS asset release not found: ${input.releaseId}` }
      }
      if (!release.previousStableCommit) {
        return {
          error: `MatOS asset release has no previous stable commit: ${input.releaseId}`,
        }
      }
      const snapshot = await resolveSnapshotForHistoryRef(
        input.cwd,
        release.previousStableCommit,
      )
      if (!snapshot) {
        return {
          error: `MatOS asset previous stable snapshot not found: ${release.previousStableCommit}`,
        }
      }
      const releasedSnapshot = await resolveSnapshotForHistoryRef(
        input.cwd,
        release.sourceRef,
      )
      if (!releasedSnapshot) {
        return {
          error: `MatOS asset released snapshot not found: ${release.sourceRef}`,
        }
      }
      if (releasedSnapshot.commit !== release.commit) {
        return { error: `MatOS asset release commit mismatch: ${input.releaseId}` }
      }
      if (
        releasedSnapshot.scope !== snapshot.scope ||
        releasedSnapshot.scopeRef !== snapshot.scopeRef
      ) {
        return { error: `MatOS asset release rollback scope mismatch: ${input.releaseId}` }
      }
      const stableRef = matOSAssetHistoryStableRef(
        releasedSnapshot.scope,
        releasedSnapshot.scopeRef,
      )
      const currentStableCommit = await readAssetHistoryRefCommit(input.cwd, stableRef)
      if (currentStableCommit !== release.commit) {
        return {
          error: `Refusing stale MatOS asset release rollback: stable no longer points at ${input.releaseId}`,
        }
      }
      const targetValidation = await validateMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: snapshot.snapshotId,
      })
      if (!targetValidation.ok) {
        return {
          error: `MatOS asset release rollback target validation failed: ${input.releaseId}`,
        }
      }
      // Post-restore validation checks the LIVE tree (scope), not just the
      // already-validated target snapshot: the restored working tree can
      // contain invalid leftovers the snapshot never recorded. The gate is
      // differential, mirroring the direct-editor Gate 1 policy: pre-existing
      // environmental errors (captured in the pre-restore baseline) must not
      // block a rollback, only errors the restore itself introduces (or any
      // secret finding) trigger the release re-restore.
      const baselineValidation = await validateMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        scope: snapshot.scope,
        ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
      })
      const baselineFingerprints = new Set(
        baselineValidation.assetValidation.errors.map(matosAssetValidationErrorFingerprint),
      )
      const rollback = await restoreMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: snapshot.snapshotId,
        removeCreatedFiles: true,
        compareSnapshotId: releasedSnapshot.snapshotId,
      })
      const liveValidation = await validateMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        scope: snapshot.scope,
        ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
      })
      const introducedErrors = liveValidation.assetValidation.errors.filter(
        error => !baselineFingerprints.has(matosAssetValidationErrorFingerprint(error)),
      )
      const validation = {
        ...liveValidation,
        // Differential verdict: pre-existing baseline errors do not fail the
        // rollback; introduced errors and secret findings do.
        ok: introducedErrors.length === 0 && liveValidation.secretScan.ok,
      }
      if (!validation.ok) {
        try {
          await restoreMatOSAssetHistorySnapshot({
            cwd: input.cwd,
            snapshotId: releasedSnapshot.snapshotId,
            removeCreatedFiles: true,
            compareSnapshotId: snapshot.snapshotId,
          })
        } catch (error) {
          return {
            error: `MatOS asset release rollback validation failed and release restore failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }
        }
        const validationDetails = [
          ...introducedErrors.map(error =>
            error && typeof error === 'object' && 'message' in error &&
            typeof (error as { message?: unknown }).message === 'string'
              ? (error as { message: string }).message
              : JSON.stringify(error),
          ),
          ...liveValidation.secretScan.findings.map(
            finding => `secret finding: ${finding.path ?? ''}`,
          ),
        ]
        return {
          error: `MatOS asset release rollback validation failed: ${input.releaseId}: ${validationDetails
            .slice(0, 5)
            .join('; ')}`,
        }
      }
      await git(input.cwd, ['update-ref', stableRef, snapshot.commit])
      return { release, rollback, validation, restoredSnapshot: snapshot }
    },
  )
}
