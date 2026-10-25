/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  abortMatOSDirectAssetEditorPendingMerge,
  runMatOSDirectAssetEditor,
  readMatOSDirectAssetEditorRun,
  type MatOSDirectAssetEditorPendingMergeRecord,
  type MatOSDirectAssetEditorRoleRunner,
  type MatOSDirectAssetEditorRunRecord,
  type MatOSDirectAssetEditorRunStatus,
} from './directAssetEditor.js'
import type { MatOSSemanticAcceptanceJudge } from './semanticAcceptanceJudge.js'
import {
  directEditorPendingMergeDir,
  directEditorRunDir,
  directEditorRunsDir,
  writeMatOSDirectAssetEditorPendingMergeRecord,
  writeMatOSDirectAssetEditorRunRecord,
} from './directAssetEditorRecords.js'
import {
  evolutionMonitorClaimsRoot,
  expireMatOSDirectAssetEditorPendingMerges,
  pruneMatOSDirectAssetEditorRunDirectories,
  removeEmptyMatOSEvolutionClaimSessionDirs,
  resolveDirectEditorPendingMergeTtlDays,
  resolveDirectEditorRunRetentionDays,
  resolveDirectEditorRunRetentionMaxRuns,
  runMatOSDirectAssetEditorRetention,
  DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON,
  MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV,
  MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV,
  MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV,
} from './directAssetEditorRetention.js'
import { withMatOSEvolutionTriggerClaim } from './evolutionTriggerClaim.js'

const ENV_TEST_TIMEOUT_MS = Number(process.env.MATOS_TEST_TIMEOUT_MS ?? '')
function testTimeoutMs(defaultMs: number): number {
  return Number.isFinite(ENV_TEST_TIMEOUT_MS) && ENV_TEST_TIMEOUT_MS > defaultMs
    ? ENV_TEST_TIMEOUT_MS
    : defaultMs
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempRoot(): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-direct-editor-retention-' })
  roots.push(root)
  return root
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function runRecord(input: {
  runId: string
  status: MatOSDirectAssetEditorRunStatus
  createdAt?: string
  withEdits?: boolean
}): MatOSDirectAssetEditorRunRecord {
  const createdAt = input.createdAt ?? new Date().toISOString()
  // Legacy normalization rewrites a pending_merge record with no asset edits
  // to noop on read, so pending_merge seeds must claim a modified file.
  const modifiedFiles =
    (input.withEdits ?? input.status === 'pending_merge')
      ? ['user-assets/packs/user-alice/roles/compute/ROLE.md']
      : []
  return {
    runId: input.runId,
    status: input.status,
    createdAt,
    updatedAt: createdAt,
    scope: 'user',
    editorOutput: {
      summary: 'Retention test run.',
      modifiedFiles,
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
    },
    modifiedFiles,
    createdAssets: [],
    updatedAssets: [],
    disabledAssets: [],
    evidenceRefs: [],
    roleExitCode: 0,
    ...(input.status === 'edited' || input.status === 'validated'
      ? { beforeSnapshot: 'snapshot-test' }
      : {}),
  } as never
}

async function backdatePath(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

async function backdateRunDir(
  root: string,
  runId: string,
  ageMs: number,
): Promise<void> {
  const dir = directEditorRunDir(root, runId)
  for (const name of await readdir(dir)) {
    await backdatePath(join(dir, name), ageMs)
  }
  await backdatePath(dir, ageMs)
}

async function seedRunDir(
  root: string,
  runId: string,
  status: MatOSDirectAssetEditorRunStatus,
  ageMs: number,
): Promise<void> {
  await writeMatOSDirectAssetEditorRunRecord(
    root,
    runRecord({ runId, status, createdAt: isoAgo(ageMs) }),
  )
  await backdateRunDir(root, runId, ageMs)
}

function pendingMergeRecord(input: {
  runId: string
  createdAt: string
  status?: 'pending' | 'aborted'
  updatedAt?: string
}): MatOSDirectAssetEditorPendingMergeRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    status: input.status ?? 'pending',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    scope: 'user',
    scopeRef: 'user:alice',
    mergeMode: 'conflict',
    dirtyFilesAtStart: [],
    conflicts: [
      { path: 'user-assets/packs/user-alice/roles/compute/ROLE.md', reason: 'same hunk changed' },
    ],
    files: [
      {
        path: 'user-assets/packs/user-alice/roles/compute/ROLE.md',
        basePath: 'files/abc.base',
        baseKind: 'file',
        currentPath: 'files/abc.current',
        currentKind: 'file',
        editPath: 'files/abc.edit',
        editKind: 'file',
      },
    ],
    runRecordPath: `.matos/evolution/direct-editor/runs/${input.runId}/run.json`,
  }
}

async function seedPendingMerge(
  root: string,
  input: {
    runId: string
    ageMs: number
    status?: 'pending' | 'aborted'
    withRunRecord?: boolean
  },
): Promise<void> {
  await writeMatOSDirectAssetEditorPendingMergeRecord({
    cwd: root,
    record: pendingMergeRecord({
      runId: input.runId,
      createdAt: isoAgo(input.ageMs),
      ...(input.status ? { status: input.status } : {}),
    }),
  })
  if (input.withRunRecord ?? true) {
    await writeMatOSDirectAssetEditorRunRecord(
      root,
      runRecord({
        runId: input.runId,
        status: 'pending_merge',
        createdAt: isoAgo(input.ageMs),
      }),
    )
  }
}

describe('direct-editor retention env knobs', () => {
  test('defaults, off switches, and invalid values', () => {
    expect(resolveDirectEditorPendingMergeTtlDays({})).toBe(14)
    expect(resolveDirectEditorRunRetentionDays({})).toBe(30)
    expect(resolveDirectEditorRunRetentionMaxRuns({})).toBe(300)

    for (const disable of ['0', 'off', 'OFF', ' 0 ', '-3']) {
      expect(
        resolveDirectEditorPendingMergeTtlDays({
          [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: disable,
        }),
      ).toBeUndefined()
      expect(
        resolveDirectEditorRunRetentionDays({
          [MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV]: disable,
        }),
      ).toBeUndefined()
      expect(
        resolveDirectEditorRunRetentionMaxRuns({
          [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: disable,
        }),
      ).toBeUndefined()
    }

    expect(
      resolveDirectEditorPendingMergeTtlDays({
        [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: '7',
      }),
    ).toBe(7)
    // Unparseable values fall back to the defaults so a typo never turns
    // retention off silently.
    expect(
      resolveDirectEditorPendingMergeTtlDays({
        [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: 'abc',
      }),
    ).toBe(14)
    expect(
      resolveDirectEditorRunRetentionMaxRuns({
        [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '2.9',
      }),
    ).toBe(2)
  })
})

describe('pending-merge TTL auto-expiry', () => {
  test('expires pending merges older than the default TTL through the real abort path', async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'pm-expired', ageMs: 20 * DAY_MS })
    await seedPendingMerge(root, { runId: 'pm-fresh', ageMs: 1 * DAY_MS })

    const result = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: {},
    })

    expect(result.status).toBe('swept')
    expect(result.ttlDays).toBe(14)
    expect(result.checked).toBe(2)
    expect(result.expired).toEqual(['pm-expired'])
    expect(result.failures).toEqual([])

    // Same terminal state the manual abort produces...
    expect(await exists(directEditorPendingMergeDir(root, 'pm-expired'))).toBe(false)
    const run = await readMatOSDirectAssetEditorRun(root, 'pm-expired')
    expect(run).toMatchObject({
      status: 'noop',
      // ...but marked so operators can tell auto-expiry from manual aborts.
      statusReason: DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON,
    })
    const resolution = JSON.parse(
      await readFile(
        join(directEditorRunDir(root, 'pm-expired'), 'merge-resolution.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(resolution.status).toBe('aborted')
    expect(resolution.reason).toBe(DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON)

    // Younger than the TTL: untouched and still applicable.
    expect(await exists(directEditorPendingMergeDir(root, 'pm-fresh'))).toBe(true)
    expect((await readMatOSDirectAssetEditorRun(root, 'pm-fresh'))?.status).toBe(
      'pending_merge',
    )
  })

  test("'0' and 'off' disable expiry entirely", async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'pm-old', ageMs: 60 * DAY_MS })
    for (const value of ['0', 'off']) {
      const result = await expireMatOSDirectAssetEditorPendingMerges({
        cwd: root,
        abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
        env: { [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: value },
      })
      expect(result.status).toBe('disabled')
      expect(await exists(directEditorPendingMergeDir(root, 'pm-old'))).toBe(true)
    }
  })

  test('custom TTL is honored', async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'pm-20d', ageMs: 20 * DAY_MS })

    const kept = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: { [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: '30' },
    })
    expect(kept.expired).toEqual([])
    expect(await exists(directEditorPendingMergeDir(root, 'pm-20d'))).toBe(true)

    const expired = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: { [MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV]: '7' },
    })
    expect(expired.expired).toEqual(['pm-20d'])
    expect(await exists(directEditorPendingMergeDir(root, 'pm-20d'))).toBe(false)
  })

  test('expiry work per sweep is bounded, oldest first', async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'pm-oldest', ageMs: 40 * DAY_MS })
    await seedPendingMerge(root, { runId: 'pm-middle', ageMs: 30 * DAY_MS })
    await seedPendingMerge(root, { runId: 'pm-newest', ageMs: 20 * DAY_MS })

    const result = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: {},
      maxExpirations: 2,
    })

    expect(result.expired).toEqual(['pm-oldest', 'pm-middle'])
    expect(await exists(directEditorPendingMergeDir(root, 'pm-newest'))).toBe(true)
  })

  test('records without parseable timestamps are never auto-expired', async () => {
    const root = await tempRoot()
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: root,
      record: {
        ...pendingMergeRecord({ runId: 'pm-no-time', createdAt: '' }),
        createdAt: '',
        updatedAt: '',
      },
    })

    const result = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: {},
    })

    expect(result.checked).toBe(1)
    expect(result.expired).toEqual([])
    expect(await exists(directEditorPendingMergeDir(root, 'pm-no-time'))).toBe(true)
  })

  test('manual aborts keep the legacy marker and expiry residue is cleaned up', async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'pm-manual', ageMs: 2 * DAY_MS })

    const aborted = await abortMatOSDirectAssetEditorPendingMerge({
      cwd: root,
      runId: 'pm-manual',
    })
    expect(aborted?.status).toBe('aborted')
    expect(
      (await readMatOSDirectAssetEditorRun(root, 'pm-manual'))?.statusReason,
    ).toBe('pending_merge_aborted')
    const resolution = JSON.parse(
      await readFile(
        join(directEditorRunDir(root, 'pm-manual'), 'merge-resolution.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(resolution.status).toBe('aborted')
    expect('reason' in resolution).toBe(false)

    // Crash residue: a record already persisted as aborted whose directory
    // was never removed. The sweep deletes it once it is old enough.
    await seedPendingMerge(root, {
      runId: 'pm-aborted-residue',
      ageMs: 2 * DAY_MS,
      status: 'aborted',
      withRunRecord: false,
    })
    await seedPendingMerge(root, {
      runId: 'pm-aborted-fresh',
      ageMs: 0,
      status: 'aborted',
      withRunRecord: false,
    })
    const sweep = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: {},
    })
    expect(sweep.removedAbortedResidue).toEqual(['pm-aborted-residue'])
    expect(
      await exists(directEditorPendingMergeDir(root, 'pm-aborted-residue')),
    ).toBe(false)
    expect(
      await exists(directEditorPendingMergeDir(root, 'pm-aborted-fresh')),
    ).toBe(true)
  })
})

describe('run-directory retention', () => {
  test('prunes only runs that fail BOTH the age and newest-count keeps', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'old-a', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'old-b', 'failed', 35 * DAY_MS)
    await seedRunDir(root, 'fresh-a', 'noop', 0)
    await seedRunDir(root, 'fresh-b', 'noop', 0)
    await seedRunDir(root, 'fresh-c', 'noop', 0)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '3' },
    })

    expect(result.status).toBe('swept')
    expect(result.scannedRunDirs).toBe(5)
    expect(result.prunedRunDirs).toEqual(['old-a', 'old-b'])
    expect(await exists(directEditorRunDir(root, 'old-a'))).toBe(false)
    expect(await exists(directEditorRunDir(root, 'fresh-a'))).toBe(true)
  })

  test('old runs inside the newest-count window are kept', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'old-1', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'old-2', 'noop', 41 * DAY_MS)
    await seedRunDir(root, 'old-3', 'noop', 42 * DAY_MS)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '3' },
    })

    expect(result.prunedRunDirs).toEqual([])
    expect(await exists(directEditorRunDir(root, 'old-2'))).toBe(true)
  })

  test('young runs beyond the newest-count window are kept while the age dimension is on', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 5; index += 1) {
      await seedRunDir(root, `young-${index}`, 'noop', (index + 2) * HOUR_MS)
    }

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '2' },
    })

    expect(result.prunedRunDirs).toEqual([])
  })

  test("days 'off' leaves the count dimension in sole control", async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'count-3h', 'noop', 3 * HOUR_MS)
    await seedRunDir(root, 'count-4h', 'noop', 4 * HOUR_MS)
    await seedRunDir(root, 'count-5h', 'noop', 5 * HOUR_MS)
    await seedRunDir(root, 'count-6h', 'noop', 6 * HOUR_MS)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: {
        [MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV]: 'off',
        [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '2',
      },
    })

    expect(result.prunedRunDirs).toEqual(['count-6h', 'count-5h'])
    expect(await exists(directEditorRunDir(root, 'count-3h'))).toBe(true)
    expect(await exists(directEditorRunDir(root, 'count-4h'))).toBe(true)
  })

  test("max-runs 'off' leaves the age dimension in sole control", async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'age-old-1', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'age-old-2', 'failed', 45 * DAY_MS)
    await seedRunDir(root, 'age-fresh', 'noop', 0)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: 'off' },
    })

    expect(result.prunedRunDirs).toEqual(['age-old-2', 'age-old-1'])
    expect(await exists(directEditorRunDir(root, 'age-fresh'))).toBe(true)
  })

  test('both dimensions off disables the sweep completely', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'disabled-old', 'noop', 90 * DAY_MS)
    const leak = join(directEditorRunsDir(root), 'input.json.tmp.1.2.leak')
    await writeFile(leak, '{}', 'utf8')
    await backdatePath(leak, 2 * DAY_MS)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: {
        [MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV]: '0',
        [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: 'off',
      },
    })

    expect(result.status).toBe('disabled')
    expect(await exists(directEditorRunDir(root, 'disabled-old'))).toBe(true)
    expect(await exists(leak)).toBe(true)
  })

  test('never prunes interrupted checkpoints or pending-merge-referenced runs', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'interrupted-edited', 'edited', 40 * DAY_MS)
    await seedRunDir(root, 'interrupted-validated', 'validated', 39 * DAY_MS)
    await seedRunDir(root, 'conflict-run', 'pending_merge', 38 * DAY_MS)
    await seedRunDir(root, 'referenced-run', 'noop', 37 * DAY_MS)
    await seedRunDir(root, 'prunable-run', 'noop', 36 * DAY_MS)
    await seedRunDir(root, 'fresh-run', 'noop', 0)
    // Unresolved pending merge referencing an otherwise prunable run.
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: root,
      record: pendingMergeRecord({
        runId: 'referenced-run',
        createdAt: isoAgo(1 * DAY_MS),
      }),
    })

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
    })

    expect(result.prunedRunDirs).toEqual(['prunable-run'])
    expect(result.keptInterrupted).toBe(2)
    expect(result.keptPendingMerge).toBe(2)
    expect(await exists(directEditorRunDir(root, 'interrupted-edited'))).toBe(true)
    expect(await exists(directEditorRunDir(root, 'interrupted-validated'))).toBe(true)
    expect(await exists(directEditorRunDir(root, 'conflict-run'))).toBe(true)
    expect(await exists(directEditorRunDir(root, 'referenced-run'))).toBe(true)
  })

  test('keeps the newest 20 accepted runs regardless of age', async () => {
    const root = await tempRoot()
    const names: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const name = `accepted-${String(index).padStart(2, '0')}`
      names.push(name)
      // accepted-00 is newest (40d), accepted-24 oldest (64d).
      await seedRunDir(root, name, 'accepted', (40 + index) * DAY_MS)
    }

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '2' },
    })

    // Newest 2 kept by count, next 18 kept as accepted provenance (newest 20
    // accepted total), oldest 5 pruned.
    expect(result.prunedRunDirs).toEqual(
      ['accepted-24', 'accepted-23', 'accepted-22', 'accepted-21', 'accepted-20'],
    )
    expect(result.keptAcceptedProvenance).toBe(18)
    for (const name of names.slice(0, 20)) {
      expect(await exists(directEditorRunDir(root, name))).toBe(true)
    }
  })

  test('keeps all accepted runs when fewer than 20 exist', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 5; index += 1) {
      await seedRunDir(root, `few-accepted-${index}`, 'accepted', (40 + index) * DAY_MS)
    }

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
    })

    expect(result.prunedRunDirs).toEqual([])
    expect(result.keptAcceptedProvenance).toBe(4)
  })

  test('prunes old unreadable run directories beyond both windows', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'fresh-anchor', 'noop', 0)
    const corruptDir = join(directEditorRunsDir(root), 'corrupt-run')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'run.json'), '{"runId": "corrupt-run", "sta', 'utf8')
    await backdatePath(join(corruptDir, 'run.json'), 40 * DAY_MS)
    await backdatePath(corruptDir, 40 * DAY_MS)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
    })

    expect(result.prunedRunDirs).toEqual(['corrupt-run'])
    expect(await exists(corruptDir)).toBe(false)
  })

  test('removes leaked atomic-write temps older than one day', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'leaky-run', 'noop', 0)
    const runDir = directEditorRunDir(root, 'leaky-run')
    const oldInnerLeak = join(runDir, 'input.json.tmp.4242.1.aaa')
    const freshInnerLeak = join(runDir, 'run.json.tmp.4242.2.bbb')
    const rootLeak = join(directEditorRunsDir(root), 'input.json.tmp.4242.3.ccc')
    await writeFile(oldInnerLeak, '{}', 'utf8')
    await writeFile(freshInnerLeak, '{}', 'utf8')
    await writeFile(rootLeak, '{}', 'utf8')
    await backdatePath(oldInnerLeak, 2 * DAY_MS)
    await backdatePath(rootLeak, 2 * DAY_MS)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: {},
    })

    expect(result.removedLeakedTmpFiles).toBe(2)
    expect(await exists(oldInnerLeak)).toBe(false)
    expect(await exists(rootLeak)).toBe(false)
    // Younger than one day: could still be an in-flight write.
    expect(await exists(freshInnerLeak)).toBe(true)
    // Real record files are untouched.
    expect(await exists(join(runDir, 'run.json'))).toBe(true)
    expect(await exists(join(runDir, 'input.json'))).toBe(true)
  })

  test('prune work per sweep is bounded, oldest first', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 5; index += 1) {
      await seedRunDir(root, `backlog-${index}`, 'noop', (40 + index) * DAY_MS)
    }
    await seedRunDir(root, 'backlog-fresh', 'noop', 0)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
      maxPrunedDirs: 2,
    })

    expect(result.examinedCandidates).toBe(2)
    expect(result.prunedRunDirs).toEqual(['backlog-4', 'backlog-3'])
    expect(await exists(directEditorRunDir(root, 'backlog-0'))).toBe(true)
  })

  test('never deletes anything modified within the last hour', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'floor-newest', 'noop', 0)
    await seedRunDir(root, 'floor-30min', 'noop', 30 * 60 * 1000)

    const result = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: root,
      env: {
        [MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV]: 'off',
        [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1',
      },
    })

    expect(result.prunedRunDirs).toEqual([])
    expect(await exists(directEditorRunDir(root, 'floor-30min'))).toBe(true)
  })
})

describe('empty claim session dir sweep', () => {
  test('removes aged empty claim dirs but keeps fresh or occupied ones', async () => {
    const root = await tempRoot()
    // A real claim acquire/release leaves the per-session directory behind
    // empty (claim file removed on release): the exact accumulation shape,
    // created through the real claim API so the layout stays pinned.
    await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'released-session',
        triggerKey: 'trigger-released',
      },
      async () => 'done',
    )
    const claimsRoot = evolutionMonitorClaimsRoot(root)
    const dirs = await readdir(claimsRoot)
    expect(dirs).toHaveLength(1)
    const releasedDir = join(claimsRoot, dirs[0]!)
    expect(await readdir(releasedDir)).toHaveLength(0)
    const oldTime = new Date(Date.now() - 2 * HOUR_MS)
    await utimes(releasedDir, oldTime, oldTime)

    // Fresh empty dir: could belong to a claim being acquired right now.
    const freshDir = join(claimsRoot, 'fresh-session')
    await mkdir(freshDir, { recursive: true })

    // Aged dir that still holds a claim file: never removed.
    const heldDir = join(claimsRoot, 'held-session')
    await mkdir(heldDir, { recursive: true })
    await writeFile(join(heldDir, 'abc.claim'), '{}\n', 'utf8')
    await utimes(heldDir, oldTime, oldTime)

    const result = await removeEmptyMatOSEvolutionClaimSessionDirs({ cwd: root })
    expect(result.status).toBe('swept')
    expect(result.removedEmptyDirs).toEqual([dirs[0]!])
    expect(result.failures).toEqual([])

    const remaining = new Set(await readdir(claimsRoot))
    expect(remaining.has(dirs[0]!)).toBe(false)
    expect(remaining.has('fresh-session')).toBe(true)
    expect(remaining.has('held-session')).toBe(true)

    // A claim can still be acquired for a swept session (the writer retries
    // once on ENOENT after recreating its directory).
    const reacquired = await withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'released-session',
        triggerKey: 'trigger-released',
      },
      async () => 'again',
    )
    expect(reacquired).toBe('again')
  })

  test('removal work per sweep is bounded', async () => {
    const root = await tempRoot()
    const claimsRoot = evolutionMonitorClaimsRoot(root)
    const oldTime = new Date(Date.now() - 2 * HOUR_MS)
    for (const name of ['s1', 's2', 's3']) {
      const dir = join(claimsRoot, name)
      await mkdir(dir, { recursive: true })
      await utimes(dir, oldTime, oldTime)
    }
    const bounded = await removeEmptyMatOSEvolutionClaimSessionDirs({
      cwd: root,
      maxRemovals: 2,
    })
    expect(bounded.removedEmptyDirs).toHaveLength(2)
    expect((await readdir(claimsRoot)).length).toBe(1)
  })
})

describe('combined retention runner', () => {
  test('runs both halves and never throws, even for an empty cwd', async () => {
    const root = await tempRoot()
    await seedPendingMerge(root, { runId: 'combined-pm', ageMs: 20 * DAY_MS })
    await seedRunDir(root, 'combined-old', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'combined-fresh', 'noop', 0)

    const report = await runMatOSDirectAssetEditorRetention({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
    })

    expect(report.pendingMerges).toMatchObject({
      status: 'swept',
      expired: ['combined-pm'],
    })
    // The expired pending merge's run record was rewritten seconds ago, so
    // only the stale noop run is prunable in this pass.
    expect(report.runDirectories).toMatchObject({
      status: 'swept',
      prunedRunDirs: ['combined-old'],
    })

    // The combined pass also sweeps empty claim session dirs.
    const claimsRoot = evolutionMonitorClaimsRoot(root)
    const agedEmptyClaimDir = join(claimsRoot, 'combined-claims-session')
    await mkdir(agedEmptyClaimDir, { recursive: true })
    const oldTime = new Date(Date.now() - 2 * HOUR_MS)
    await utimes(agedEmptyClaimDir, oldTime, oldTime)
    const second = await runMatOSDirectAssetEditorRetention({
      cwd: root,
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
    })
    expect(second.claimSessionDirs).toMatchObject({
      status: 'swept',
      removedEmptyDirs: ['combined-claims-session'],
    })
    expect(await exists(agedEmptyClaimDir)).toBe(false)

    const empty = await runMatOSDirectAssetEditorRetention({
      cwd: join(root, 'does-not-exist'),
      abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
      env: {},
    })
    expect(empty.pendingMerges).toMatchObject({ status: 'swept', checked: 0 })
    expect(empty.runDirectories).toMatchObject({ status: 'swept', scannedRunDirs: 0 })
    expect(empty.claimSessionDirs).toMatchObject({
      status: 'swept',
      scannedDirs: 0,
      removedEmptyDirs: [],
    })
  })
})

// End-to-end: the finalize path of a real (roleRunner-driven) direct-editor
// run schedules the fire-and-forget retention pass, which expires a seeded
// stale pending merge through the real abort path and prunes a stale run dir.
describe('post-run retention hook', () => {
  async function writeProjectConfig(root: string): Promise<void> {
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  async function writeExperience(root: string): Promise<void> {
    const dir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'compute-queue-selection',
    )
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute-queue-selection',
          type: 'experience',
          name: 'Compute queue selection',
          version: '0.1.0',
          description: 'Choose local idle GPUs before remote queues.',
          entry: 'EXPERIENCE.md',
          tags: ['generated', 'learning', 'draft', 'experience'],
          metadata: {
            sourceFormat: 'matos-experience-llm-v1',
            mergeKey: 'compute:queue-selection:compatibility',
            recommendedActions: ['Prefer local idle GPUs first.'],
            scenario: {
              domain: 'compute',
              taskType: 'resource-selection',
              failureMode: 'incompatible-queue',
            },
            evidenceRefs: ['trace:queue-selection-test'],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(
      join(dir, 'EXPERIENCE.md'),
      '# Compute queue selection\n\nPrefer local idle GPUs before remote queues.\n',
      'utf8',
    )
  }

  async function writeCoreComputeRole(root: string): Promise<void> {
    const dir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          description: 'Compute role.',
          entry: 'ROLE.md',
          overlayOf: 'role:compute@0.1.0',
          tags: ['compute'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(dir, 'ROLE.md'), '# Compute\n\nChoose remote queues.\n', 'utf8')
  }

  async function writeHiddenCoreRole(root: string): Promise<void> {
    const dir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'direct-asset-editor',
    )
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'direct-asset-editor',
          type: 'role',
          name: 'Direct Asset Editor',
          version: '0.1.0',
          description: 'Hidden editor role.',
          entry: 'ROLE.md',
          overlayOf: 'role:direct-asset-editor@0.1.0',
          metadata: { hidden: true },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(dir, 'ROLE.md'), '# Hidden\n\nDo not target this role.\n', 'utf8')
  }

  const acceptSemanticJudge: MatOSSemanticAcceptanceJudge = async input => ({
    schemaVersion: 1,
    verdict: 'accept',
    confidence: 0.91,
    reason: 'Low-risk retention hook test edit.',
    resolvedUserProblem: true,
    overfitRisk: 'low',
    assetPollutionRisk: 'low',
    missingEvidence: [],
    recommendedFollowup: [],
    cache: {
      key: `retention-cache-${input.runId}`,
      hit: false,
      path: `.matos/evolution/direct-editor/semantic-cache/retention-${input.runId}.json`,
      promptVersion: 'test',
      modelId: 'test-model',
      inputHash: `retention-hash-${input.runId}`,
    },
    judgeRoleExitCode: 0,
    createdAt: new Date().toISOString(),
  })

  test(
    'a finalized run opportunistically expires stale pending merges and prunes stale run dirs',
    async () => {
      const root = await tempRoot()
      await writeProjectConfig(root)
      await writeExperience(root)
      await writeCoreComputeRole(root)
      await writeHiddenCoreRole(root)
      await seedPendingMerge(root, { runId: 'hook-expired-pm', ageMs: 20 * DAY_MS })
      await seedRunDir(root, 'hook-stale-run', 'noop', 40 * DAY_MS)

      const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => ({
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No direct edits performed; experience is sufficient.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      })

      const run = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'retention-hook-run',
        roleRunner,
        semanticJudge: acceptSemanticJudge,
        env: { [MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV]: '1' },
      })
      expect(run?.status).toBe('noop')

      // The hook is fire-and-forget after the terminal record write; poll
      // until the background sweep has done its work.
      const deadline = Date.now() + 20_000
      const pmDir = directEditorPendingMergeDir(root, 'hook-expired-pm')
      const staleDir = directEditorRunDir(root, 'hook-stale-run')
      while (Date.now() < deadline) {
        if (!(await exists(pmDir)) && !(await exists(staleDir))) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(await exists(pmDir)).toBe(false)
      expect(await exists(staleDir)).toBe(false)
      expect(
        (await readMatOSDirectAssetEditorRun(root, 'hook-expired-pm'))?.statusReason,
      ).toBe(DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON)
      // The just-finalized run itself is never a victim of its own sweep.
      expect(await exists(directEditorRunDir(root, 'retention-hook-run'))).toBe(true)
    },
    testTimeoutMs(60_000),
  )
})
