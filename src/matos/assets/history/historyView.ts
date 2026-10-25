import { listMatOSAssetRevisions, showMatOSAssetRevision, diffMatOSAssetRevisions, type MatOSAssetRevision } from './archive.js'

function commit(revision: MatOSAssetRevision) {
  return { hash: revision.commit, shortHash: revision.commit.slice(0, 10), author: revision.scopeRef || revision.scope,
    date: revision.createdAt, subject: `${revision.assetRef} · ${revision.state}`, body: `Archive ${revision.snapshotId}` }
}

// Compatibility view for existing history drilldowns. Archive lookup follows
// native scope/provenance, never an ancestor .git directory of a runtime export.
export async function matOSAssetHistoryView(cwd: string, assetRef: string, hash?: string) {
  const archive = await listMatOSAssetRevisions({ cwd, assetRef, limit: 200 })
  if (!hash) return { archive, git: archive.revisions.length ? {
    repoRoot: archive.revisions[0]!.sourceId ?? 'asset-history', relPath: assetRef, head: null,
    commits: archive.revisions.map(commit), refs: [],
  } : null }
  if (!/^[a-f0-9]{7,64}$/.test(hash)) throw new Error('Invalid archive commit')
  const matches = archive.revisions.filter(revision => revision.commit.startsWith(hash))
  if (matches.length !== 1) throw new Error('Archive commit missing or ambiguous')
  const revision = matches[0]!
  const detail = await showMatOSAssetRevision({ cwd, revisionId: revision.revisionId })
  const prior = archive.revisions.slice(archive.revisions.indexOf(revision) + 1).find(item => item.scope === revision.scope && item.scopeRef === revision.scopeRef && item.sourceId === revision.sourceId)
  const diff = prior ? await diffMatOSAssetRevisions({ cwd, from: prior.revisionId, to: revision.revisionId }) : undefined
  return { commit: commit(revision), scope: 'asset', files: detail.files.map(file => ({ path: file.path, additions: null, deletions: null })),
    patch: diff?.patch ?? '', patchTruncated: diff?.truncated ?? false,
    evolution: revision.audit ? { runId: revision.audit.runId, editorSummary: revision.audit.summary,
      expectedBehaviorChange: revision.audit.expectedBehaviorChange, semanticVerdict: revision.audit.verdict,
      summaryMarkdown: null, semanticReason: null } : null }
}
