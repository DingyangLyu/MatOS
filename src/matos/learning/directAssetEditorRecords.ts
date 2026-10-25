import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSGiteaContentWriteResult } from '../assets/giteaClient.js'
import { getMatOSDir } from '../project.js'
import { writeJson } from '../workflows/jsonIo.js'
import type {
  MatOSDirectAssetEditorGiteaReview,
  MatOSDirectAssetEditorPendingMergeRecord,
  MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import { DIRECT_EDITOR_RUNS_DIR } from './directAssetEditorTransaction.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'

export function directEditorRunsDir(cwd: string): string {
  return join(getMatOSDir(cwd), ...DIRECT_EDITOR_RUNS_DIR)
}

export function directEditorPendingMergesDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'direct-editor', 'pending-merges')
}

export function directEditorPendingMergeDir(cwd: string, runId: string): string {
  const safeId = assertSafeEvolutionRecordId(runId, 'direct editor pending merge id')
  return assertPathStaysUnderRoot(
    directEditorPendingMergesDir(cwd),
    join(directEditorPendingMergesDir(cwd), safeId),
  )
}

export function directEditorRunDir(cwd: string, runId: string): string {
  const safeId = assertSafeEvolutionRecordId(runId, 'direct editor run id')
  return assertPathStaysUnderRoot(
    directEditorRunsDir(cwd),
    join(directEditorRunsDir(cwd), safeId),
  )
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function isDirectAssetEditorScope(value: unknown): value is MatOSDirectAssetEditorScope {
  return value === 'core' || value === 'project' || value === 'user' || value === 'team'
}

function normalizeLegacyDirectAssetEditorRunRecord(
  record: MatOSDirectAssetEditorRunRecord,
): MatOSDirectAssetEditorRunRecord {
  const hasNoAssetEdits =
    record.modifiedFiles.length === 0 &&
    record.createdAssets.length === 0 &&
    record.updatedAssets.length === 0 &&
    record.disabledAssets.length === 0 &&
    record.editorOutput.modifiedFiles.length === 0 &&
    record.editorOutput.createdAssets.length === 0 &&
    record.editorOutput.updatedAssets.length === 0 &&
    record.editorOutput.disabledAssets.length === 0
  if (record.status === 'pending_merge' && hasNoAssetEdits) {
    const {
      pendingMerge: _pendingMerge,
      mergeConflicts: _mergeConflicts,
      mergeMode: _mergeMode,
      ...rest
    } = record
    return {
      ...rest,
      status: 'noop',
      rawStatus: record.rawStatus ?? record.status,
      statusReason:
        record.statusReason ?? 'empty_pending_merge_no_asset_edits',
    }
  }
  if (
    (record.status === 'failed' || record.status === 'blocked') &&
    record.editorOutput.summary ===
      'Direct asset editor skipped because current assets are dirty.' &&
    record.stderr?.includes(
      'current assets differ from the stable snapshot',
    )
  ) {
    return {
      ...record,
      status: 'blocked',
      ...(record.rawStatus || record.status === 'failed'
        ? { rawStatus: record.rawStatus ?? record.status }
        : {}),
      statusReason: record.statusReason ?? 'legacy_dirty_preflight',
    }
  }
  if (
    (record.status === 'failed' || record.status === 'blocked') &&
    record.stderr?.includes(
      'import skipped because editable assets changed during the isolated editor run',
    )
  ) {
    return {
      ...record,
      status: 'blocked',
      ...(record.rawStatus || record.status === 'failed'
        ? { rawStatus: record.rawStatus ?? record.status }
        : {}),
      statusReason: record.statusReason ?? 'legacy_concurrent_import',
    }
  }
  return record
}

function normalizeGiteaReviewFileAction(
  value: unknown,
): MatOSGiteaContentWriteResult['action'] | 'skipped' {
  return value === 'created' ||
    value === 'updated' ||
    value === 'deleted' ||
    value === 'absent' ||
    value === 'skipped'
    ? value
    : 'skipped'
}

function normalizeDirectEditorGiteaReview(
  value: unknown,
): MatOSDirectAssetEditorGiteaReview | undefined {
  const raw = metadataObject(value)
  if (raw.provider !== 'gitea') {
    return undefined
  }
  const status =
    raw.status === 'created' || raw.status === 'disabled' || raw.status === 'failed'
      ? raw.status
      : undefined
  const owner = typeof raw.owner === 'string' ? raw.owner : ''
  const repo = typeof raw.repo === 'string' ? raw.repo : ''
  const branch = typeof raw.branch === 'string' ? raw.branch : ''
  const baseBranch = typeof raw.baseBranch === 'string' ? raw.baseBranch : ''
  if (!status || !owner || !repo || !branch || !baseBranch) {
    return undefined
  }
  const pullRequestRaw = metadataObject(raw.pullRequest)
  const files = Array.isArray(raw.files)
    ? raw.files
        .map(file => metadataObject(file))
        .map(file => ({
          path: typeof file.path === 'string' ? file.path : '',
          action: normalizeGiteaReviewFileAction(file.action),
          ...(typeof file.reason === 'string' ? { reason: file.reason } : {}),
        }))
        .filter(file => file.path)
    : undefined
  return {
    provider: 'gitea',
    status,
    owner,
    repo,
    branch,
    baseBranch,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    ...(typeof pullRequestRaw.number === 'number'
      ? {
          pullRequest: {
            number: pullRequestRaw.number,
            ...(typeof pullRequestRaw.url === 'string'
              ? { url: pullRequestRaw.url }
              : {}),
            ...(typeof pullRequestRaw.state === 'string'
              ? { state: pullRequestRaw.state }
              : {}),
          },
        }
      : {}),
    ...(files ? { files } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

function isPendingMergeVersionKind(
  value: unknown,
): value is 'file' | 'absent' | 'symlink' | 'dir' {
  return value === 'file' || value === 'absent' || value === 'symlink' || value === 'dir'
}

function normalizePendingMergeRecord(
  value: unknown,
): MatOSDirectAssetEditorPendingMergeRecord | undefined {
  const raw = metadataObject(value)
  if (raw.schemaVersion !== 1) {
    return undefined
  }
  const runId = typeof raw.runId === 'string' ? raw.runId : ''
  const status =
    raw.status === 'aborted'
      ? 'aborted'
      : raw.status === 'pending'
        ? 'pending'
        : undefined
  const scope = isDirectAssetEditorScope(raw.scope) ? raw.scope : undefined
  const scopeRef =
    typeof raw.scopeRef === 'string' && raw.scopeRef.startsWith(`${scope}:`)
      ? raw.scopeRef
      : undefined
  if (!runId || !status || !scope) {
    return undefined
  }
  const conflicts = Array.isArray(raw.conflicts)
    ? raw.conflicts
        .map(item => metadataObject(item))
        .map(item => ({
          path: typeof item.path === 'string' ? item.path : '',
          reason: typeof item.reason === 'string' ? item.reason : '',
        }))
        .filter(item => item.path)
    : []
  const files = Array.isArray(raw.files)
    ? raw.files
        .map(item => metadataObject(item))
        .map(item => ({
          path: typeof item.path === 'string' ? item.path : '',
          basePath: typeof item.basePath === 'string' ? item.basePath : '',
          ...(isPendingMergeVersionKind(item.baseKind)
            ? { baseKind: item.baseKind }
            : {}),
          currentPath: typeof item.currentPath === 'string' ? item.currentPath : '',
          ...(isPendingMergeVersionKind(item.currentKind)
            ? { currentKind: item.currentKind }
            : {}),
          editPath: typeof item.editPath === 'string' ? item.editPath : '',
          ...(isPendingMergeVersionKind(item.editKind)
            ? { editKind: item.editKind }
            : {}),
        }))
        .filter(item => item.path && item.basePath && item.currentPath && item.editPath)
    : []
  return {
    schemaVersion: 1,
    runId,
    status,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    scope,
    ...(scopeRef ? { scopeRef } : {}),
    mergeMode: 'conflict',
    dirtyFilesAtStart: stringArray(raw.dirtyFilesAtStart),
    conflicts,
    files,
    runRecordPath:
      typeof raw.runRecordPath === 'string' ? raw.runRecordPath : '',
    ...(normalizeDirectEditorGiteaReview(raw.giteaReview)
      ? { giteaReview: normalizeDirectEditorGiteaReview(raw.giteaReview) }
      : {}),
  }
}

export async function writeDirectEditorRunFile(
  dir: string,
  name: string,
  value: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  // Atomic same-directory tmp+rename write: run.json is the recovery
  // authority and readMatOSDirectAssetEditorRunRecord silently drops records
  // that fail to parse, so a crash mid-write must never leave a truncated
  // JSON document at the target path.
  await writeJson(join(dir, name), value)
}

export async function writeMatOSDirectAssetEditorRunRecord(
  cwd: string,
  record: MatOSDirectAssetEditorRunRecord,
): Promise<void> {
  const dir = directEditorRunDir(cwd, record.runId)
  await mkdir(dir, { recursive: true })
  await writeDirectEditorRunFile(dir, 'input.json', record.input)
  await writeDirectEditorRunFile(dir, 'editor-output.json', record.editorOutput)
  await writeDirectEditorRunFile(dir, 'run.json', record)
  await writeFile(
    join(dir, 'SUMMARY.md'),
    [
      `# MatOS Direct Asset Editor Run ${record.runId}`,
      '',
      `Status: ${record.status}`,
      `Scope: ${record.scope}`,
      '',
      record.editorOutput.summary,
      '',
      ...record.modifiedFiles.map(file => `- modified ${file}`),
      ...record.createdAssets.map(ref => `- created ${ref}`),
      ...record.updatedAssets.map(ref => `- updated ${ref}`),
      ...record.disabledAssets.map(ref => `- disabled ${ref}`),
      '',
    ].join('\n'),
    'utf8',
  )
}

export async function readMatOSDirectAssetEditorRunRecord(
  cwd: string,
  runId: string,
): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  try {
    const raw = await readFile(join(directEditorRunDir(cwd, runId), 'run.json'), 'utf8')
    return normalizeLegacyDirectAssetEditorRunRecord(
      JSON.parse(raw) as MatOSDirectAssetEditorRunRecord,
    )
  } catch {
    return undefined
  }
}

export async function listMatOSDirectAssetEditorRunRecords(
  cwd: string,
): Promise<MatOSDirectAssetEditorRunRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(directEditorRunsDir(cwd))
  } catch {
    return []
  }
  const runs = await Promise.all(
    entries.map(entry => readMatOSDirectAssetEditorRunRecord(cwd, entry)),
  )
  return runs
    .filter((run): run is MatOSDirectAssetEditorRunRecord => Boolean(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function writeMatOSDirectAssetEditorPendingMergeRecord(input: {
  cwd: string
  record: MatOSDirectAssetEditorPendingMergeRecord
}): Promise<void> {
  await writeDirectEditorRunFile(
    directEditorPendingMergeDir(input.cwd, input.record.runId),
    'record.json',
    input.record,
  )
}

export async function readMatOSDirectAssetEditorPendingMergeRecord(
  cwd: string,
  runId: string,
): Promise<MatOSDirectAssetEditorPendingMergeRecord | undefined> {
  try {
    const raw = await readFile(
      join(directEditorPendingMergeDir(cwd, runId), 'record.json'),
      'utf8',
    )
    return normalizePendingMergeRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export async function listMatOSDirectAssetEditorPendingMergeRecords(
  cwd: string,
): Promise<MatOSDirectAssetEditorPendingMergeRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(directEditorPendingMergesDir(cwd))
  } catch {
    return []
  }
  const records = await Promise.all(
    entries.map(entry => readMatOSDirectAssetEditorPendingMergeRecord(cwd, entry)),
  )
  return records
    .filter((record): record is MatOSDirectAssetEditorPendingMergeRecord => Boolean(record))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
