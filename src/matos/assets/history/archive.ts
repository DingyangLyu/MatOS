import { createHash, randomUUID } from 'node:crypto'
import { dirname, relative, join } from 'node:path'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { getMatOSDir, readMatOSProjectConfig, type MatOSProjectConfig } from '../../project.js'
import { assetArchiveSourceIdentity, type MatOSArchiveAudit } from './acceptedArchive.js'
import { parseMatOSAssetReference } from '../refs.js'
import { redactMatOSAssetOutput } from '../outputRedaction.js'
import { hasMatOSSecretLookingContent, isMatOSSecretLookingFileName } from '../secretScan.js'
import { assetHistoryGitDir, git, gitRawBuffer } from './gitBackend.js'
import { listMatOSAssetHistorySnapshotsWithIssues, readMatOSAssetHistorySnapshot } from './records.js'
import { listCurrentMatOSAssetHistoryFiles, resolveMatOSAssetHistoryRecordPath } from './policy.js'
import type { MatOSAssetHistorySnapshotRecord, MatOSAssetHistoryFileRecord } from './types.js'
import { archiveOwnerScopeRef, archiveScopeAllowed, isScopedAssetArchiveCaller } from './archiveScope.js'
export { archiveOwnerScopeRef, archiveScopeAllowed, isScopedAssetArchiveCaller } from './archiveScope.js'

export type MatOSAssetRevision = {
  revisionId: string
  assetRef: string
  name: string
  version: string
  snapshotId: string
  commit: string
  scope: string
  scopeRef?: string
  createdAt: string
  kind: string
  state: string
  sourceId?: string
  sourceCommit?: string
  fileCount: number
  sizeBytes: number
  configuredCurrent?: boolean
  audit?: MatOSArchiveAudit
}

type ManifestSummary = { type: string; id: string; version: string; name: string; public: boolean }
type ManifestCache = Map<string, ManifestSummary>

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function archiveSourceAllowed(snapshot: MatOSAssetHistorySnapshotRecord, config: MatOSProjectConfig | undefined): boolean {
  if (!archiveScopeAllowed(snapshot)) return false
  if (!snapshot.provenance?.sourceIdentity) return true
  const source = config?.assetSources?.find(source => source.id === snapshot.provenance?.sourceId)
  return source?.type === 'git' && assetArchiveSourceIdentity(source) === snapshot.provenance.sourceIdentity
}

function matchesRef(ref: string, query?: string): boolean {
  if (!query) return true
  const a = parseMatOSAssetReference(ref)
  const b = parseMatOSAssetReference(query)
  // History follows the logical asset across semantic version changes.
  return a.id === b.id && (!b.type || a.type === b.type)
}

function filesForManifest(snapshot: MatOSAssetHistorySnapshotRecord, path: string): MatOSAssetHistoryFileRecord[] {
  const root = `${dirname(path)}/`
  const nested = snapshot.files.filter(file => file.path.endsWith('/asset.json') && file.path !== path && file.path.startsWith(root)).map(file => `${dirname(file.path)}/`)
  return snapshot.files.filter(file => file.path.startsWith(root) && !nested.some(dir => file.path.startsWith(dir)))
}

async function readBlob(cwd: string, snapshot: MatOSAssetHistorySnapshotRecord, file: MatOSAssetHistoryFileRecord): Promise<Buffer> {
  if (file.sizeBytes > 2 * 1024 * 1024) throw new Error('Archive preview exceeds 2 MiB per file')
  const content = await gitRawBuffer(['--git-dir', assetHistoryGitDir(cwd), 'show', `${snapshot.commit}:${file.path}`], { cwd })
  if (content.length !== file.sizeBytes || digest(content) !== file.sha256) throw new Error('Archive content checksum mismatch')
  return content
}

async function revisionForManifest(cwd: string, snapshot: MatOSAssetHistorySnapshotRecord, file: MatOSAssetHistoryFileRecord, cache?: ManifestCache): Promise<MatOSAssetRevision | undefined> {
  let manifest = cache?.get(file.sha256)
  if (!manifest) {
    const raw = JSON.parse((await readBlob(cwd, snapshot, file)).toString('utf8'))
    if (!raw || !['type', 'id', 'version'].every(key => typeof raw[key] === 'string' && raw[key].length > 0 && !/[\s:@\x00-\x1f]/.test(raw[key]))) return undefined
    manifest = { type: raw.type, id: raw.id, version: raw.version, name: typeof raw.name === 'string' ? raw.name : raw.id, public: raw.metadata?.marketplace?.visibility === 'public' }
    cache?.set(file.sha256, manifest)
  }
  if (process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE === '1' && ['core', 'global', 'shared'].includes(snapshot.scope) && !manifest.public) return undefined
  const files = filesForManifest(snapshot, file.path)
  const provenance = snapshot.provenance ?? {}
  return {
    revisionId: `${snapshot.snapshotId}~${digest(file.path).slice(0, 24)}`,
    assetRef: `${manifest.type}:${manifest.id}@${manifest.version}`,
    name: typeof manifest.name === 'string' ? manifest.name : manifest.id,
    version: manifest.version, snapshotId: snapshot.snapshotId, commit: snapshot.commit,
    scope: snapshot.scope, scopeRef: archiveOwnerScopeRef(snapshot),
    createdAt: provenance.backfilled && typeof provenance.sourceCommittedAt === 'string' ? provenance.sourceCommittedAt : snapshot.createdAt, kind: snapshot.kind,
    state: typeof provenance.archiveState === 'string' ? provenance.archiveState : snapshot.kind === 'direct-editor-after' ? 'candidate' : snapshot.kind === 'direct-editor-rollback' ? 'rollback' : 'snapshot',
    ...(typeof provenance.sourceId === 'string' ? { sourceId: provenance.sourceId } : {}),
    ...(typeof provenance.sourceCommit === 'string' ? { sourceCommit: provenance.sourceCommit } : {}),
    fileCount: files.length, sizeBytes: files.reduce((sum, item) => sum + item.sizeBytes, 0),
    ...((!isScopedAssetArchiveCaller() || archiveOwnerScopeRef(snapshot)) && provenance.audit && typeof provenance.audit === 'object' && typeof (provenance.audit as MatOSArchiveAudit).runId === 'string'
      ? { audit: Object.fromEntries(Object.entries(provenance.audit).filter(([key, value]) => ['runId', 'summary', 'expectedBehaviorChange', 'verdict', 'beforeSnapshot', 'afterSnapshot'].includes(key) && typeof value === 'string')) as MatOSArchiveAudit } : {}),
  }
}

export async function listMatOSAssetRevisions(input: { cwd: string; assetRef?: string; offset?: number; limit?: number }) {
  const snapshots = await listMatOSAssetHistorySnapshotsWithIssues(input.cwd)
  const config = await readMatOSProjectConfig(input.cwd)
  const cachePath = join(getMatOSDir(input.cwd), 'index', 'asset-archive-manifests-v1.json')
  const cache: ManifestCache = new Map()
  try {
    const stored = JSON.parse(await readFile(cachePath, 'utf8'))
    if (stored.version === 1 && Array.isArray(stored.entries)) for (const [key, value] of stored.entries.slice(0, 20_000)) {
      if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) && value && ['type', 'id', 'version', 'name'].every(field => typeof value[field] === 'string') && typeof value.public === 'boolean') cache.set(key, value)
    }
  } catch { /* This index is disposable and never used by restore. */ }
  const initialSize = cache.size
  const revisions: MatOSAssetRevision[] = []
  // Unparseable records have no trusted scope; never reveal their paths to users.
  const issues: string[] = snapshots.issues.some(issue => issue.directory || !isScopedAssetArchiveCaller()) ? ['Some archive records are unreadable; run an operator archive audit'] : []
  for (const snapshot of snapshots.records) {
    if (!archiveSourceAllowed(snapshot, config)) continue
    const source = config?.assetSources?.find(source => source.id === snapshot.provenance?.sourceId)
    if (input.assetRef && snapshot.assetRefs.length && !snapshot.assetRefs.some(ref => matchesRef(ref, input.assetRef))) continue
    for (const file of snapshot.files.filter(file => file.path.endsWith('/asset.json'))) {
      try {
        const revision = await revisionForManifest(input.cwd, snapshot, file, cache)
        if (revision && source?.type === 'git' && source.runtimeRef && 'commit' in source.runtimeRef && source.runtimeRef.commit === revision.sourceCommit) revision.configuredCurrent = true
        if (revision && matchesRef(revision.assetRef, input.assetRef)) revisions.push(revision)
      } catch {
        issues.push(`${snapshot.snapshotId}: archive content unavailable or invalid`)
      }
    }
  }
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.revisionId.localeCompare(b.revisionId))
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
  if (cache.size !== initialSize) {
    const tmp = `${cachePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 })
      await writeFile(tmp, JSON.stringify(redactMatOSAssetOutput({ version: 1, entries: [...cache].slice(-20_000) })), { flag: 'wx', mode: 0o600 })
      await rename(tmp, cachePath)
    } catch { /* A failed cache write must not hide readable archives. */ }
    finally { await rm(tmp, { force: true }).catch(() => undefined) }
  }
  return { revisions: redactMatOSAssetOutput(revisions.slice(offset, offset + limit)) as MatOSAssetRevision[], total: revisions.length,
    hasMore: offset + limit < revisions.length, nextOffset: offset + limit,
    issues: [...new Set(issues)], storage: '.matos/asset-history.git', schemaVersion: 1 }
}

export async function resolveMatOSAssetRevision(cwd: string, revisionId: string) {
  if (!/^asset-snapshot-[A-Za-z0-9_-]+~[a-f0-9]{24}$/.test(revisionId)) throw new Error('Invalid asset revision id')
  const [snapshotId, pathDigest] = revisionId.split('~')
  const snapshot = await readMatOSAssetHistorySnapshot(cwd, snapshotId!)
  if (!snapshot || !archiveScopeAllowed(snapshot)) throw new Error('Asset revision not available in this scope')
  if (snapshot.provenance?.sourceIdentity) {
    const config = await readMatOSProjectConfig(cwd)
    const source = config?.assetSources?.find(source => source.id === snapshot.provenance?.sourceId)
    if (!source || source.type !== 'git' || assetArchiveSourceIdentity(source) !== snapshot.provenance.sourceIdentity) throw new Error('Asset revision source is no longer registered in this scope')
  }
  const manifestFile = snapshot.files.find(file => file.path.endsWith('/asset.json') && digest(file.path).slice(0, 24) === pathDigest)
  if (!manifestFile) throw new Error('Asset revision not found')
  const revision = await revisionForManifest(cwd, snapshot, manifestFile)
  if (!revision) throw new Error('Asset revision not available in this scope')
  const files = filesForManifest(snapshot, manifestFile.path)
  return { snapshot, revision, manifestFile, files, root: dirname(manifestFile.path) }
}

export async function showMatOSAssetRevision(input: { cwd: string; revisionId: string }) {
  const selected = await resolveMatOSAssetRevision(input.cwd, input.revisionId)
  const files = []
  let remainingBytes = 512 * 1024
  for (const file of selected.files) {
    const name = relative(selected.root, file.path).replace(/\\/g, '/')
    let content: string | undefined
    let unavailable: string | undefined
    try {
      if (file.sizeBytes > remainingBytes) throw new Error('Archive preview size limit')
      const blob = await readBlob(input.cwd, selected.snapshot, file)
      remainingBytes -= blob.length
      if (blob.includes(0)) unavailable = 'binary'
      else if (isMatOSSecretLookingFileName(name) || hasMatOSSecretLookingContent(blob.toString('utf8'))) unavailable = 'redacted'
      else content = blob.toString('utf8')
    } catch { unavailable = 'content unavailable or checksum mismatch' }
    files.push({ path: name, sha256: file.sha256, sizeBytes: file.sizeBytes, content, unavailable })
  }
  const result = { revision: selected.revision, files }
  return redactMatOSAssetOutput(result) as typeof result
}

export async function diffMatOSAssetRevisions(input: { cwd: string; from: string; to: string }) {
  const from = await resolveMatOSAssetRevision(input.cwd, input.from)
  const to = await resolveMatOSAssetRevision(input.cwd, input.to)
  if (!matchesRef(from.revision.assetRef, to.revision.assetRef) || from.snapshot.scope !== to.snapshot.scope || archiveOwnerScopeRef(from.snapshot) !== archiveOwnerScopeRef(to.snapshot) || from.revision.sourceId !== to.revision.sourceId || from.root !== to.root) throw new Error('Cannot compare unrelated asset owners or archive paths')
  const files = [...new Set([...from.files, ...to.files].map(file => file.path))]
  for (const side of [from, to]) for (const file of side.files) {
    const content = await readBlob(input.cwd, side.snapshot, file)
    if (isMatOSSecretLookingFileName(file.path) || hasMatOSSecretLookingContent(content.toString('utf8'))) throw new Error('Archive diff contains protected material')
  }
  const patch = await git(input.cwd, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', from.snapshot.commit, to.snapshot.commit, '--', ...files])
  return { from: input.from, to: input.to, patch: redactMatOSAssetOutput(patch.slice(0, 128 * 1024)), truncated: patch.length > 128 * 1024 }
}

export async function previewMatOSAssetRevisionRestore(input: { cwd: string; revisionId: string }) {
  const selected = await resolveMatOSAssetRevision(input.cwd, input.revisionId)
  const config = await readMatOSProjectConfig(input.cwd)
  const roots = (config?.assetSources ?? []).filter(source => source.type === 'git')
  const { matOSGitAssetSourceCheckoutRoot } = await import('../sourceAdapters.js')
  const target = resolveMatOSAssetHistoryRecordPath({ cwd: input.cwd, scope: selected.snapshot.scope, scopeRef: selected.snapshot.scopeRef, path: selected.manifestFile.path }).absolutePath
  const gitBacked = roots.some(source => target.startsWith(`${matOSGitAssetSourceCheckoutRoot(input.cwd, source)}/`))
  // Local restore must never masquerade as publishing a Gitea accepted revision.
  const writableScope = !['core', 'shared', 'global'].includes(selected.snapshot.scope) || !isScopedAssetArchiveCaller()
  const currentPaths = (await listCurrentMatOSAssetHistoryFiles({ cwd: input.cwd, scope: selected.snapshot.scope, scopeRef: selected.snapshot.scopeRef })).filter(path => path.startsWith(`${selected.root}/`))
  const nestedAssets = [...currentPaths, ...selected.snapshot.files.map(file => file.path)]
    .some(path => path.startsWith(`${selected.root}/`) && path.endsWith('/asset.json') && path !== selected.manifestFile.path)
  const current = []
  for (const path of currentPaths.sort()) {
    const absolute = resolveMatOSAssetHistoryRecordPath({ cwd: input.cwd, scope: selected.snapshot.scope, scopeRef: selected.snapshot.scopeRef, path }).absolutePath
    current.push({ path, sha256: digest(await readFile(absolute)) })
  }
  return { revision: selected.revision, canRestore: writableScope && !gitBacked && !nestedAssets,
    reason: nestedAssets ? 'nested-assets-require-independent-rollback' : gitBacked ? 'gitea-acceptance-required' : !writableScope ? 'owner-review-required' : undefined,
    expectedCurrent: digest(JSON.stringify(current)),
    files: selected.files.map(file => relative(selected.root, file.path)),
    currentPaths, selected }
}

export async function retainMatOSAssetHistoryArchive(cwd: string) {
  const records = await listMatOSAssetHistorySnapshotsWithIssues(cwd)
  const retained: string[] = []
  const issues: string[] = records.issues.length ? ['Some archive records are unreadable; retention is incomplete'] : []
  for (const snapshot of records.records) {
    if (!archiveScopeAllowed(snapshot)) continue
    try {
      await git(cwd, ['cat-file', '-e', `${snapshot.commit}^{commit}`])
      const ref = `refs/matos/snapshots/${snapshot.snapshotId}`
      const existing = await git(cwd, ['rev-parse', '--verify', ref]).then(value => value.trim(), () => '')
      if (existing && existing !== snapshot.commit) throw new Error('Archive ref changed')
      if (!existing) await git(cwd, ['update-ref', ref, snapshot.commit, ''])
      retained.push(snapshot.snapshotId)
    } catch { issues.push(`${snapshot.snapshotId}: archive objects missing or ref conflict`) }
  }
  return { retained, issues, ok: issues.length === 0 && records.issues.length === 0 }
}
