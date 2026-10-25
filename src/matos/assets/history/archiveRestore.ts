import { relative, dirname, resolve } from 'node:path'
import { readMatOSProjectConfig } from '../../project.js'
import { loadMatOSAssetsFromRoot, loadMatOSRuntimeAssets } from '../loadAssets.js'
import { validateMatOSAssets } from '../validateAssets.js'
import { validateMatOSWorkflowAssetsForAcceptance } from '../giteaAcceptance.js'
import { createMatOSGiteaRollbackPullRequest } from '../giteaRollback.js'
import { matOSGitAssetSourceCheckoutRoot } from '../sourceAdapters.js'
import { matOSGiteaApiUrlFromSourceRepo, resolveMatOSGitAssetSourceRuntimeRepo } from '../giteaRuntimeTransport.js'
import { redactMatOSAssetOutput } from '../outputRedaction.js'
import { previewMatOSAssetRevisionRestore, isScopedAssetArchiveCaller } from './archive.js'
import { resolveMatOSAssetHistoryRecordPath } from './policy.js'
import { createMatOSAssetHistorySnapshot } from './snapshot.js'
import { restoreMatOSAssetHistorySnapshot } from './restore.js'
import { validateMatOSAssetHistorySnapshot } from './validation.js'
import { withMatOSAssetHistoryLock } from './lock.js'
import { assetArchiveSourceIdentity } from './acceptedArchive.js'

export async function restoreMatOSAssetRevision(input: {
  cwd: string; revisionId: string; expectedCurrent?: string; apply?: boolean
}) {
  if (input.apply && !/^[a-f0-9]{40,64}$/.test(input.expectedCurrent ?? '')) throw new Error('A current rollback preview and explicit confirmation are required')
  return withMatOSAssetHistoryLock({ cwd: input.cwd, operation: 'asset-archive-restore' }, async () => {
    const preview = await previewMatOSAssetRevisionRestore(input)
    const { selected, currentPaths, ...publicPreview } = preview
    if (preview.reason === 'gitea-acceptance-required') {
      const config = await readMatOSProjectConfig(input.cwd)
      const source = config?.assetSources?.find(source => source.id === selected.revision.sourceId)
      const snapshot = selected.snapshot
      const isPublic = ['core', 'shared', 'global'].includes(snapshot.scope)
      const scopedCaller = isScopedAssetArchiveCaller()
      if (!source || source.type !== 'git' || !source.gitea?.owner || !source.gitea.repo || assetArchiveSourceIdentity(source) !== snapshot.provenance?.sourceIdentity || source.scopeRef !== snapshot.scopeRef || !selected.revision.sourceCommit || (isPublic && scopedCaller)) {
        if (input.apply) throw new Error('This revision requires owner review through the asset source')
        return { ...publicPreview, canRestore: false, reason: 'owner-review-required', mode: 'candidate' }
      }
      const path = resolveMatOSAssetHistoryRecordPath({ cwd: input.cwd, scope: snapshot.scope, scopeRef: snapshot.scopeRef, path: selected.manifestFile.path }).absolutePath
      const relativeRoot = relative(matOSGitAssetSourceCheckoutRoot(input.cwd, source), dirname(path)).replace(/\\/g, '/')
      const runtimeRepo = resolveMatOSGitAssetSourceRuntimeRepo({ cwd: input.cwd, source, repo: source.repo })
      const result = await createMatOSGiteaRollbackPullRequest({
        cwd: input.cwd, source, apiUrl: matOSGiteaApiUrlFromSourceRepo(runtimeRepo, source),
        restoreRef: selected.revision.sourceCommit, paths: [relativeRoot],
        expectedTargetCommit: input.apply ? input.expectedCurrent : undefined, dryRun: !input.apply,
        body: `Restore ${selected.revision.assetRef} from archive ${input.revisionId}.\nAccepted runtime remains unchanged until native MatOS acceptance.`,
        validateRoot: async root => {
          const runtime = await loadMatOSRuntimeAssets(input.cwd)
          const others = runtime.filter(asset => (asset.metadata.sourceProvenance as Record<string, unknown> | undefined)?.sourceId !== source.id)
          const validation = await validateMatOSAssets([...others, ...await loadMatOSAssetsFromRoot(root)])
          if (validation.ok) {
            const workflows = await validateMatOSWorkflowAssetsForAcceptance({ cwd: input.cwd, root,
              extraAssetRoots: [...new Set(others.map(asset => asset.sourcePath))] })
            if (workflows.failures.length) return { ok: false, errors: workflows.failures.map(failure => ({ code: 'invalid_manifest' as const, manifestPath: root, message: JSON.stringify(failure) })) }
          }
          return validation
        },
      })
      return { revision: selected.revision, canRestore: result.ok && result.action !== 'noop', mode: 'candidate', expectedCurrent: result.targetCommit,
        files: result.changedPaths, ok: result.ok, action: result.action, pullRequest: result.pullRequest, runtimeChanged: false }
    }
    if (!input.apply) return { ...publicPreview, mode: 'local' }
    if (!preview.canRestore) throw new Error('Asset revision requires owner review')
    if (input.expectedCurrent !== preview.expectedCurrent) throw new Error('Rollback preview is stale: current asset changed')
    if (currentPaths.some(path => path.endsWith('/asset.json') && path !== selected.manifestFile.path)) throw new Error('Nested assets require independent rollback')
    const snapshot = selected.snapshot
    const validation = await validateMatOSAssetHistorySnapshot({ cwd: input.cwd, snapshotId: snapshot.snapshotId })
    if (!validation.ok) throw new Error('Archived snapshot failed validation')
    const before = await createMatOSAssetHistorySnapshot({ cwd: input.cwd, scope: snapshot.scope, scopeRef: snapshot.scopeRef,
      kind: 'manual', paths: currentPaths, provenance: { archiveState: 'restore-before', restoresRevision: input.revisionId } })
    if ((await previewMatOSAssetRevisionRestore(input)).expectedCurrent !== input.expectedCurrent) throw new Error('Rollback preview is stale: current asset changed')
    try {
      const restore = await restoreMatOSAssetHistorySnapshot({ cwd: input.cwd, snapshotId: snapshot.snapshotId,
        compareSnapshotId: before.snapshotId, removeCreatedFiles: true, onlyPaths: [selected.root] })
      if (restore.skippedRemovals.length) throw new Error('Rollback left unremoved files')
      const afterValidation = await validateMatOSAssetHistorySnapshot({ cwd: input.cwd, scope: snapshot.scope, scopeRef: snapshot.scopeRef })
      if (!afterValidation.ok) throw new Error('Restored asset failed runtime validation')
      const after = await createMatOSAssetHistorySnapshot({ cwd: input.cwd, scope: snapshot.scope, scopeRef: snapshot.scopeRef,
        kind: 'direct-editor-rollback', paths: selected.files.map(file => file.path), assetRefs: [selected.revision.assetRef],
        parentCommit: before.commit, provenance: { archiveState: 'rollback', restoresRevision: input.revisionId, beforeSnapshot: before.snapshotId } })
      return { ok: true, action: 'restored', mode: 'local', revision: selected.revision, beforeSnapshot: before.snapshotId, afterSnapshot: after.snapshotId }
    } catch (error) {
      await restoreMatOSAssetHistorySnapshot({ cwd: input.cwd, snapshotId: before.snapshotId,
        compareSnapshotId: snapshot.snapshotId, removeCreatedFiles: true, onlyPaths: [selected.root] })
      throw error
    }
  })
}
