import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { readMatOSProjectConfig } from '../../project.js'
import { materializeAcceptedRuntimeSnapshot, matOSGitAssetSourceCheckoutRoot, withMatOSGitAssetSourceLock } from '../sourceAdapters.js'
import { matOSGitCheckoutProcessEnv } from '../gitProcessEnv.js'
import { archiveScopeAllowed } from './archive.js'
import { archiveMatOSAcceptedCandidate, assetArchiveSourceIdentity } from './acceptedArchive.js'
import { listMatOSAssetHistorySnapshots, writeMatOSAssetHistorySnapshotRecord } from './records.js'

const exec = promisify(execFile)

export async function backfillMatOSAssetArchive(input: { cwd: string; sourceId?: string; limit?: number }) {
  const config = await readMatOSProjectConfig(input.cwd)
  if (input.sourceId && !config?.assetSources?.some(source => source.id === input.sourceId && source.type === 'git' && archiveScopeAllowed({ scope: source.scope ?? 'project', scopeRef: source.scopeRef }))) throw new Error('Archive source is unavailable in this scope')
  const records = await listMatOSAssetHistorySnapshots(input.cwd)
  const archived: string[] = []
  const sources: Array<{ sourceId: string; headCommit: string; hasMore: boolean }> = []
  for (const source of config?.assetSources ?? []) {
    if (source.type !== 'git' || source.includeInRuntime === false || !source.runtimeRef || source.runtimeRef.mode === 'source-ref' || input.sourceId && source.id !== input.sourceId || !archiveScopeAllowed({ scope: source.scope ?? 'project', scopeRef: source.scopeRef })) continue
    await withMatOSGitAssetSourceLock(input.cwd, source, async () => {
      const current = await materializeAcceptedRuntimeSnapshot(input.cwd, source, false)
      const checkout = matOSGitAssetSourceCheckoutRoot(input.cwd, source)
      const env = await matOSGitCheckoutProcessEnv(checkout)
      const limit = Math.min(1000, Math.max(1, input.limit ?? 100))
      const acceptedRef = source.runtimeRef?.mode === 'accepted-ref' ? source.runtimeRef.ref.replace(/^refs\/heads\//, '') : undefined
      const tags = acceptedRef ? await exec('git', ['for-each-ref', '--format=%(objectname)', `refs/tags/matos-accepted/${acceptedRef}/`], { cwd: checkout, env }) : { stdout: '' }
      const accepted = new Set([current.commit, ...tags.stdout.trim().split('\n')])
      const known = new Set(records.filter(record => record.provenance?.sourceIdentity === assetArchiveSourceIdentity(source)).map(record => record.provenance?.sourceCommit))
      // The limit bounds newly archived commits, not ancestry depth. Repeating
      // the command continues past known snapshots until the full ledger is covered.
      const pending: string[] = []
      for (let offset = 0; pending.length <= limit; offset += 256) {
        const output = await exec('git', ['log', '--max-count=256', `--skip=${offset}`, '--format=%H', current.commit, '--'], { cwd: checkout, env, maxBuffer: 1024 * 1024 })
        const commits = output.stdout.trim().split('\n').filter(commit => /^[a-f0-9]{40,64}$/.test(commit))
        for (const commit of commits) if (!known.has(commit)) pending.push(commit)
        if (commits.length < 256) break
      }
      sources.push({ sourceId: source.id, headCommit: current.commit, hasMore: pending.length > limit })
      for (const commit of pending.slice(0, limit)) {
        const tree = await materializeAcceptedRuntimeSnapshot(input.cwd, { ...source, runtimeRef: { mode: 'commit', commit } }, false)
        const record = await archiveMatOSAcceptedCandidate({ cwd: input.cwd, source, root: resolve(checkout, source.subdir ?? '.'), sourceRoot: tree.root,
          commit, acceptedBranch: source.runtimeRef?.mode === 'accepted-ref' ? source.runtimeRef.ref : 'pinned' })
        if (!record) throw new Error('Registered source disappeared during archive backfill')
        const committedAt = (await exec('git', ['show', '-s', '--format=%cI', commit], { cwd: checkout, env })).stdout.trim()
        await writeMatOSAssetHistorySnapshotRecord(input.cwd, { ...record, provenance: { ...record.provenance,
          archiveState: accepted.has(commit) ? 'accepted' : 'git-history', backfilled: true, sourceCommittedAt: committedAt } })
        archived.push(record.snapshotId)
      }
    })
  }
  return { ok: true, archived, sources, hasMore: sources.some(source => source.hasMore), runtimeChanged: false }
}
