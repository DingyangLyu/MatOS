import { readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readMatOSProjectConfig, type MatOSGitAssetSourceConfig } from '../../project.js'
import { loadMatOSAssetsFromRoot } from '../loadAssets.js'
import { shouldIgnoreMatOSAssetHistoryPath } from './policy.js'
import { createMatOSAssetHistorySnapshot } from './snapshot.js'
import { writeMatOSAssetHistorySnapshotRecord } from './records.js'
import type { MatOSAssetHistorySnapshotRecord } from './types.js'
import { redactMatOSAssetOutput } from '../outputRedaction.js'

export type MatOSArchiveAudit = { runId: string; summary?: string; expectedBehaviorChange?: string; verdict?: string; beforeSnapshot?: string; afterSnapshot?: string }

export function assetArchiveSourceIdentity(source: MatOSGitAssetSourceConfig): string {
  return createHash('sha256').update(JSON.stringify([source.repo, source.subdir ?? '', source.scope ?? 'project', source.scopeRef ?? ''])).digest('hex')
}

export async function archiveMatOSAcceptedCandidate(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  root: string
  commit: string
  acceptedBranch: string
  sourceRoot?: string
  audit?: MatOSArchiveAudit
}): Promise<MatOSAssetHistorySnapshotRecord | undefined> {
  const config = await readMatOSProjectConfig(input.cwd)
  const source = config?.assetSources?.find(source => source.id === input.source.id)
  // Unregistered candidates have no runtime authority or scope-governed root.
  if (!source || source.type !== 'git' || assetArchiveSourceIdentity(source) !== assetArchiveSourceIdentity(input.source)) return undefined
  const scope = source.scope ?? 'project'
  const paths: string[] = []
  async function visit(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.name === '.git' || shouldIgnoreMatOSAssetHistoryPath(path)) continue
      if (entry.isSymbolicLink()) throw new Error('Cannot archive symlink asset content')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  await visit(resolve(input.sourceRoot ?? input.root))
  const assets = await loadMatOSAssetsFromRoot(input.sourceRoot ?? input.root)
  return createMatOSAssetHistorySnapshot({
    cwd: input.cwd, kind: 'manual', scope, scopeRef: source.scopeRef,
    paths: input.sourceRoot ? paths.map(path => resolve(input.root, relative(input.sourceRoot!, path))) : paths,
    ...(input.sourceRoot ? { contentSource: { targetRoot: input.root, sourceRoot: input.sourceRoot } } : {}),
    assetRefs: assets.map(asset => asset.canonicalKey),
    provenance: { sourceId: source.id, sourceIdentity: assetArchiveSourceIdentity(source), sourceCommit: input.commit,
      acceptedBranch: input.acceptedBranch, archiveState: 'validated-candidate',
      ...(input.audit ? { audit: redactMatOSAssetOutput(input.audit) } : {}) },
    message: `Validated candidate ${source.id} ${input.commit}`,
  })
}

export async function markMatOSArchiveAccepted(
  cwd: string, record: MatOSAssetHistorySnapshotRecord | undefined, pushed: boolean,
): Promise<void> {
  if (!record) return
  await writeMatOSAssetHistorySnapshotRecord(cwd, {
    ...record,
    provenance: { ...record.provenance, archiveState: pushed ? 'accepted' : 'accepted-local', acceptedAt: new Date().toISOString() },
  })
}
