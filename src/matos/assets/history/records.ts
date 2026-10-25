import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getMatOSDir } from '../../project.js'
import type {
  MatOSAssetHistoryReleaseRecord,
  MatOSAssetHistorySnapshotRecord,
} from './types.js'
import {
  assertValidMatOSAssetHistoryReleaseId,
  assertValidMatOSAssetHistorySnapshotId,
  validateMatOSAssetHistoryReleaseRecord,
  validateMatOSAssetHistorySnapshotRecord,
} from './policy.js'

export type MatOSAssetHistoryRecordIssue = {
  kind: 'snapshot' | 'release'
  file: string
  message: string
  directory?: boolean
}

function historyDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'asset-history')
}

// Snapshot/release records are the pointers rollback depends on. Write them
// atomically (tmp + rename) so a killed process or full disk can never leave
// a truncated JSON file that later makes readMatOSAssetHistorySnapshot — and
// therefore restore/rollback — fail for an otherwise intact git snapshot.
async function writeRecordFileAtomically(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export function snapshotRecordsDir(cwd: string): string {
  return join(historyDir(cwd), 'records')
}

export function releaseRecordsDir(cwd: string): string {
  return join(historyDir(cwd), 'releases')
}

export async function writeMatOSAssetHistorySnapshotRecord(
  cwd: string,
  record: MatOSAssetHistorySnapshotRecord,
): Promise<void> {
  const validated = validateMatOSAssetHistorySnapshotRecord({
    cwd,
    requestedSnapshotId: record.snapshotId,
    record,
  })
  const dir = snapshotRecordsDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeRecordFileAtomically(
    join(dir, `${validated.snapshotId}.json`),
    `${JSON.stringify(validated, null, 2)}\n`,
  )
}

export async function readMatOSAssetHistorySnapshot(
  cwd: string,
  snapshotId: string,
): Promise<MatOSAssetHistorySnapshotRecord | undefined> {
  assertValidMatOSAssetHistorySnapshotId(snapshotId)
  let raw: string
  try {
    raw = await readFile(join(snapshotRecordsDir(cwd), `${snapshotId}.json`), 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  return validateMatOSAssetHistorySnapshotRecord({
    cwd,
    requestedSnapshotId: snapshotId,
    record: JSON.parse(raw),
  })
}

export async function listMatOSAssetHistorySnapshots(
  cwd: string,
): Promise<MatOSAssetHistorySnapshotRecord[]> {
  return (await listMatOSAssetHistorySnapshotsWithIssues(cwd)).records
}

export async function listMatOSAssetHistorySnapshotsWithIssues(
  cwd: string,
): Promise<{
  records: MatOSAssetHistorySnapshotRecord[]
  issues: MatOSAssetHistoryRecordIssue[]
}> {
  let entries: string[]
  try {
    entries = await readdir(snapshotRecordsDir(cwd))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], issues: [] }
    return { records: [], issues: [{ kind: 'snapshot', file: 'records', directory: true, message: 'Asset snapshot directory is unreadable' }] }
  }
  const issues: MatOSAssetHistoryRecordIssue[] = []
  const records = (
    await Promise.all(
      entries
        .filter(entry => entry.endsWith('.json'))
        .map(async entry => {
          try {
            return {
              file: entry,
              raw: await readFile(join(snapshotRecordsDir(cwd), entry), 'utf8'),
            }
          } catch (error) {
            issues.push({
              kind: 'snapshot',
              file: entry,
              message: error instanceof Error ? error.message : String(error),
            })
            return undefined
          }
        }),
    )
  ).filter((record): record is { file: string; raw: string } => Boolean(record))
  const valid = records
    .flatMap(({ file, raw }) => {
      try {
        return [validateMatOSAssetHistorySnapshotRecord({ cwd, requestedSnapshotId: file.slice(0, -5), record: JSON.parse(raw) })]
      } catch (error) {
        issues.push({
          kind: 'snapshot',
          file,
          message: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { records: valid, issues }
}

export async function writeMatOSAssetHistoryReleaseRecord(
  cwd: string,
  record: MatOSAssetHistoryReleaseRecord,
): Promise<void> {
  const validated = validateMatOSAssetHistoryReleaseRecord({ record })
  const dir = releaseRecordsDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeRecordFileAtomically(
    join(dir, `${validated.releaseId}.json`),
    `${JSON.stringify(validated, null, 2)}\n`,
  )
}

export async function readMatOSAssetHistoryRelease(
  cwd: string,
  releaseId: string,
): Promise<MatOSAssetHistoryReleaseRecord | undefined> {
  assertValidMatOSAssetHistoryReleaseId(releaseId)
  let raw: string
  try {
    raw = await readFile(join(releaseRecordsDir(cwd), `${releaseId}.json`), 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  return validateMatOSAssetHistoryReleaseRecord({
    requestedReleaseId: releaseId,
    record: JSON.parse(raw),
  })
}

export async function listMatOSAssetHistoryReleases(
  cwd: string,
): Promise<MatOSAssetHistoryReleaseRecord[]> {
  return (await listMatOSAssetHistoryReleasesWithIssues(cwd)).records
}

export async function listMatOSAssetHistoryReleasesWithIssues(
  cwd: string,
): Promise<{
  records: MatOSAssetHistoryReleaseRecord[]
  issues: MatOSAssetHistoryRecordIssue[]
}> {
  let entries: string[]
  try {
    entries = await readdir(releaseRecordsDir(cwd))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], issues: [] }
    return { records: [], issues: [{ kind: 'release', file: 'releases', directory: true, message: 'Asset release directory is unreadable' }] }
  }
  const issues: MatOSAssetHistoryRecordIssue[] = []
  const records = (
    await Promise.all(
      entries
        .filter(entry => entry.endsWith('.json'))
        .map(async entry => {
          try {
            return {
              file: entry,
              raw: await readFile(join(releaseRecordsDir(cwd), entry), 'utf8'),
            }
          } catch (error) {
            issues.push({
              kind: 'release',
              file: entry,
              message: error instanceof Error ? error.message : String(error),
            })
            return undefined
          }
        }),
    )
  ).filter((record): record is { file: string; raw: string } => Boolean(record))
  const valid = records
    .flatMap(({ file, raw }) => {
      try {
        return [validateMatOSAssetHistoryReleaseRecord({ requestedReleaseId: file.slice(0, -5), record: JSON.parse(raw) })]
      } catch (error) {
        issues.push({
          kind: 'release',
          file,
          message: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { records: valid, issues }
}

export async function listMatOSAssetHistoryRecordIssues(
  cwd: string,
): Promise<MatOSAssetHistoryRecordIssue[]> {
  const [snapshots, releases] = await Promise.all([
    listMatOSAssetHistorySnapshotsWithIssues(cwd),
    listMatOSAssetHistoryReleasesWithIssues(cwd),
  ])
  return [...snapshots.issues, ...releases.issues]
}
