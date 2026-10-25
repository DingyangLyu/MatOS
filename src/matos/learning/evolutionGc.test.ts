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

// Real-implementation tests for plan-first evolution storage GC: dry-run plan
// correctness, apply keep rules, protected records, out-of-root refusal, and
// monitor session pruning/rotation. Everything runs against seeded temp
// evolution roots; no LLM calls are involved.

import { mkdir, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { runMatOSEvolveCommand } from '../cli/evolve.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  directEditorRunDir,
  directEditorRunsDir,
  writeMatOSDirectAssetEditorPendingMergeRecord,
} from './directAssetEditorRecords.js'
import type { MatOSDirectAssetEditorPendingMergeRecord } from './directAssetEditor.js'
import { parseMonitorRecordsJsonl } from './evolutionMonitorRecords.js'
import {
  DEFAULT_EVOLUTION_GC_KEEP_DAYS,
  DEFAULT_EVOLUTION_GC_KEEP_RUNS,
  MATOS_EVOLVE_GC_APPLY_ENV,
  resolveEvolutionGcDeleteTarget,
  runMatOSEvolutionGc,
} from './evolutionGc.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempRoot(): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-evolution-gc-' })
  roots.push(root)
  return root
}

function isoAgo(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function backdatePath(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

async function backdateTree(dir: string, ageMs: number): Promise<void> {
  for (const name of await readdir(dir)) {
    await backdatePath(join(dir, name), ageMs)
  }
  await backdatePath(dir, ageMs)
}

async function seedRunDir(
  root: string,
  runId: string,
  status: string,
  ageMs: number,
): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
  await mkdir(dir, { recursive: true })
  // pending_merge records without asset edits normalize to noop on read.
  const modifiedFiles =
    status === 'pending_merge' ? ['user-assets/roles/compute/ROLE.md'] : []
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      runId,
      status,
      createdAt: isoAgo(ageMs),
      updatedAt: isoAgo(ageMs),
      scope: 'user',
      editorOutput: {
        summary: 'GC test run.',
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
      ...(status === 'edited' || status === 'validated'
        ? { beforeSnapshot: 'snapshot-test' }
        : {}),
    }),
    'utf8',
  )
  await backdateTree(dir, ageMs)
}

function pendingMergeRecord(input: {
  runId: string
  createdAt: string
}): MatOSDirectAssetEditorPendingMergeRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    status: 'pending',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    scope: 'user',
    scopeRef: 'user:alice',
    mergeMode: 'conflict',
    dirtyFilesAtStart: [],
    conflicts: [
      {
        path: 'user-assets/roles/compute/ROLE.md',
        reason: 'same hunk changed',
      },
    ],
    files: [
      {
        path: 'user-assets/roles/compute/ROLE.md',
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

function defaultMonitorRoot(root: string): string {
  return join(root, '.matos', 'evolution', 'monitor', 'sessions')
}

async function seedMonitorSession(
  monitorRoot: string,
  sessionId: string,
  ageMs: number,
  options: { recordCount?: number; summaryBytes?: number } = {},
): Promise<string> {
  const dir = join(monitorRoot, sessionId)
  await mkdir(dir, { recursive: true })
  const recordCount = options.recordCount ?? 2
  const summary = 'x'.repeat(options.summaryBytes ?? 40)
  const lines: string[] = []
  for (let index = 0; index < recordCount; index += 1) {
    lines.push(
      JSON.stringify({
        recordId: `${sessionId}-r${index}`,
        sessionId,
        triggerKind: 'tool-failure',
        triggerKey: `tool-failure:${sessionId}-${index}`,
        status: 'noop',
        createdAt: isoAgo(ageMs),
        updatedAt: isoAgo(ageMs),
        summary,
      }),
    )
  }
  await writeFile(join(dir, 'records.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  await backdateTree(dir, ageMs)
  return dir
}

describe('evolution gc dry-run planning', () => {
  test('defaults are keep-days 30 / keep-runs 200 and the plan deletes nothing', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'old-a', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'old-b', 'failed', 35 * DAY_MS)
    await seedRunDir(root, 'fresh-a', 'noop', 2 * HOUR_MS)
    await seedMonitorSession(defaultMonitorRoot(root), 'stale-sess', 40 * DAY_MS)
    await seedMonitorSession(defaultMonitorRoot(root), 'fresh-sess', 2 * HOUR_MS)

    const report = await runMatOSEvolutionGc({ cwd: root, env: {}, apply: false })

    expect(report.mode).toBe('evolution-gc')
    expect(report.dryRun).toBe(true)
    expect(report.keepDays).toBe(DEFAULT_EVOLUTION_GC_KEEP_DAYS)
    expect(report.keepRuns).toBe(DEFAULT_EVOLUTION_GC_KEEP_RUNS)
    // Everything is inside the newest-200 count keep, so nothing is planned
    // even though old-a/old-b fail the age keep: whichever keeps MORE wins.
    expect(report.runs.scanned).toBe(3)
    expect(report.runs.planned).toEqual([])
    expect(report.runs.kept.withinKeepRuns).toBe(2)
    expect(report.runs.kept.withinKeepDays).toBe(1)

    const strict = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: false,
      keepRuns: 1,
    })
    // Oldest first in the plan; nothing deleted in dry-run.
    expect(strict.runs.planned.map(entry => entry.runId)).toEqual(['old-a', 'old-b'])
    expect(strict.runs.planned[0]).toMatchObject({ status: 'noop' })
    expect(strict.runs.planned[0]!.ageDays).toBeGreaterThan(39)
    expect(strict.runs.pruned).toEqual([])
    expect(await exists(directEditorRunDir(root, 'old-a'))).toBe(true)
    expect(await exists(directEditorRunDir(root, 'old-b'))).toBe(true)

    const monitorResult = strict.monitor.find(
      item => item.root === defaultMonitorRoot(root),
    )
    expect(monitorResult).toBeDefined()
    expect(monitorResult!.scannedSessions).toBe(2)
    expect(monitorResult!.planned.map(entry => entry.sessionId)).toEqual([
      'stale-sess',
    ])
    expect(monitorResult!.pruned).toEqual([])
    expect(await exists(join(defaultMonitorRoot(root), 'stale-sess'))).toBe(true)
    expect(strict.notes.join(' ')).toContain('dry-run')
  })

  test('either keep rule alone is enough to keep a directory', async () => {
    const root = await tempRoot()
    // Old but within keep-runs: kept.
    await seedRunDir(root, 'old-kept-1', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'old-kept-2', 'noop', 41 * DAY_MS)
    const byCount = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: false,
      keepRuns: 2,
      keepDays: 30,
    })
    expect(byCount.runs.planned).toEqual([])
    expect(byCount.runs.kept.withinKeepRuns).toBe(2)

    // Beyond keep-runs but young enough: kept by age.
    await seedRunDir(root, 'young-3', 'noop', 3 * HOUR_MS)
    await seedRunDir(root, 'young-4', 'noop', 4 * HOUR_MS)
    const byAge = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: false,
      keepRuns: 1,
      keepDays: 30,
    })
    // The two 40d runs fail both rules now (only newest-1 kept by count).
    expect(byAge.runs.planned.map(entry => entry.runId)).toEqual([
      'old-kept-2',
      'old-kept-1',
    ])
    expect(byAge.runs.kept.withinKeepDays).toBe(2)

    // keep-days 0 and keep-runs 0 disable both keeps; only the 1-hour safety
    // floor protects the 30-minute-old run.
    await seedRunDir(root, 'young-30min', 'noop', 30 * 60 * 1000)
    const floor = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: false,
      keepRuns: 0,
      keepDays: 0,
    })
    expect(floor.runs.planned.map(entry => entry.runId)).toEqual([
      'old-kept-2',
      'old-kept-1',
      'young-4',
      'young-3',
    ])
    expect(floor.runs.kept.safetyFloor).toBe(1)
  })
})

describe('evolution gc apply', () => {
  test('apply prunes only unprotected candidates and respects keep rules', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'prunable-run', 'noop', 40 * DAY_MS)
    await seedRunDir(root, 'interrupted-edited', 'edited', 41 * DAY_MS)
    await seedRunDir(root, 'interrupted-validated', 'validated', 42 * DAY_MS)
    await seedRunDir(root, 'conflict-run', 'pending_merge', 43 * DAY_MS)
    await seedRunDir(root, 'referenced-run', 'noop', 44 * DAY_MS)
    await seedRunDir(root, 'accepted-old', 'accepted', 45 * DAY_MS)
    await seedRunDir(root, 'fresh-run', 'noop', 2 * HOUR_MS)
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: root,
      record: pendingMergeRecord({
        runId: 'referenced-run',
        createdAt: isoAgo(1 * DAY_MS),
      }),
    })
    // The asset-history git dir sits outside the gc roots and must survive
    // any configuration.
    const assetHistoryDir = join(root, '.matos', 'asset-history.git')
    await mkdir(assetHistoryDir, { recursive: true })
    await writeFile(join(assetHistoryDir, 'config'), '[core]\n', 'utf8')
    await backdateTree(assetHistoryDir, 90 * DAY_MS)

    const report = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: true,
      keepRuns: 1,
      keepDays: 30,
    })

    expect(report.dryRun).toBe(false)
    expect(report.runs.planned.map(entry => entry.runId)).toEqual(['prunable-run'])
    expect(report.runs.pruned).toEqual(['prunable-run'])
    expect(report.runs.kept.interrupted).toBe(2)
    expect(report.runs.kept.pendingMerge).toBe(2)
    // Fewer than the 20-accepted floor exist, so accepted runs are kept
    // conservatively.
    expect(report.runs.kept.acceptedProvenance).toBe(1)
    expect(report.runs.failures).toEqual([])
    expect(report.protected.pendingMergeReferencedRuns).toBe(1)

    expect(await exists(directEditorRunDir(root, 'prunable-run'))).toBe(false)
    for (const kept of [
      'interrupted-edited',
      'interrupted-validated',
      'conflict-run',
      'referenced-run',
      'accepted-old',
      'fresh-run',
    ]) {
      expect(await exists(directEditorRunDir(root, kept))).toBe(true)
    }
    expect(await exists(join(assetHistoryDir, 'config'))).toBe(true)
    expect(report.protected.assetHistoryDir).toBe(assetHistoryDir)
  })

  test('keeps the newest 20 accepted runs as provenance and prunes older ones', async () => {
    const root = await tempRoot()
    const names: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const name = `accepted-${String(index).padStart(2, '0')}`
      names.push(name)
      // accepted-00 newest (40d), accepted-24 oldest (64d).
      await seedRunDir(root, name, 'accepted', (40 + index) * DAY_MS)
    }

    const report = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: true,
      keepRuns: 2,
      keepDays: 30,
    })

    expect(report.runs.pruned).toEqual([
      'accepted-24',
      'accepted-23',
      'accepted-22',
      'accepted-21',
      'accepted-20',
    ])
    expect(report.runs.kept.acceptedProvenance).toBe(18)
    for (const name of names.slice(0, 20)) {
      expect(await exists(directEditorRunDir(root, name))).toBe(true)
    }
  })

  test('prunes stale monitor sessions and rotates oversized kept records.jsonl', async () => {
    const root = await tempRoot()
    const monitorRoot = defaultMonitorRoot(root)
    await seedMonitorSession(monitorRoot, 'stale-sess', 40 * DAY_MS)
    await seedMonitorSession(monitorRoot, 'fresh-small', 2 * HOUR_MS)
    // Kept session whose records.jsonl exceeds the 2MB rotation threshold:
    // 25 records x ~100KB.
    const oversizedDir = await seedMonitorSession(monitorRoot, 'fresh-oversized', 0, {
      recordCount: 25,
      summaryBytes: 100_000,
    })
    const recordsPath = join(oversizedDir, 'records.jsonl')
    const sizeBefore = (await stat(recordsPath)).size
    expect(sizeBefore).toBeGreaterThan(2_000_000)

    const dryRun = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: false,
      keepRuns: 2,
      keepDays: 30,
    })
    const dryMonitor = dryRun.monitor.find(item => item.root === monitorRoot)
    expect(dryMonitor!.planned.map(entry => entry.sessionId)).toEqual(['stale-sess'])
    expect(dryMonitor!.plannedCompactions).toEqual(['fresh-oversized'])
    expect(dryMonitor!.compacted).toEqual([])
    expect((await stat(recordsPath)).size).toBe(sizeBefore)

    const applied = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: true,
      keepRuns: 2,
      keepDays: 30,
    })
    const appliedMonitor = applied.monitor.find(item => item.root === monitorRoot)
    expect(appliedMonitor!.pruned).toEqual(['stale-sess'])
    expect(appliedMonitor!.compacted).toEqual(['fresh-oversized'])
    expect(appliedMonitor!.failures).toEqual([])

    expect(await exists(join(monitorRoot, 'stale-sess'))).toBe(false)
    expect(await exists(join(monitorRoot, 'fresh-small'))).toBe(true)
    // Rotation kept the newest records in place and archived the remainder.
    const sizeAfter = (await stat(recordsPath)).size
    expect(sizeAfter).toBeLessThan(sizeBefore)
    expect(parseMonitorRecordsJsonl(
      await Bun.file(recordsPath).text(),
    ).length).toBeLessThan(25)
    expect(await exists(join(oversizedDir, 'records-archive.jsonl'))).toBe(true)
  })

  test('scans an env-configured monitor root in addition to the default root', async () => {
    const root = await tempRoot()
    const customRoot = join(root, 'custom-monitor', 'sessions')
    await seedMonitorSession(customRoot, 'custom-stale', 40 * DAY_MS)

    const report = await runMatOSEvolutionGc({
      cwd: root,
      env: { MATOS_EVOLUTION_MONITOR_DIR: customRoot },
      apply: true,
      keepRuns: 0,
      keepDays: 30,
    })

    const customResult = report.monitor.find(item => item.root === customRoot)
    expect(customResult).toBeDefined()
    expect(customResult!.pruned).toEqual(['custom-stale'])
    expect(await exists(join(customRoot, 'custom-stale'))).toBe(false)
  })
})

describe('evolution gc safety guards', () => {
  test('delete targets that escape the gc root are refused', async () => {
    const root = await tempRoot()
    const runsRoot = directEditorRunsDir(root)
    await mkdir(runsRoot, { recursive: true })
    for (const hostile of ['../outside', '..', 'a/b', 'a\\b', '']) {
      expect(() => resolveEvolutionGcDeleteTarget(runsRoot, hostile)).toThrow()
    }
    expect(resolveEvolutionGcDeleteTarget(runsRoot, 'run-1')).toBe(
      join(runsRoot, 'run-1'),
    )
  })

  test('symlinked entries are skipped and their targets survive apply', async () => {
    const root = await tempRoot()
    const outside = join(root, 'outside-precious')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'precious\n', 'utf8')
    await backdateTree(outside, 90 * DAY_MS)
    const runsRoot = directEditorRunsDir(root)
    await mkdir(runsRoot, { recursive: true })
    await symlink(outside, join(runsRoot, 'evil-link'))
    await seedRunDir(root, 'old-real-run', 'noop', 40 * DAY_MS)

    const report = await runMatOSEvolutionGc({
      cwd: root,
      env: {},
      apply: true,
      keepRuns: 0,
      keepDays: 0,
    })

    expect(report.runs.planned.map(entry => entry.runId)).toEqual(['old-real-run'])
    expect(report.runs.pruned).toEqual(['old-real-run'])
    expect(await exists(join(outside, 'keep.txt'))).toBe(true)
    expect(await exists(join(runsRoot, 'evil-link'))).toBe(true)
  })
})

describe('matos evolve gc CLI gating', () => {
  test('default invocation is dry-run; --apply or MATOS_EVOLVE_GC_APPLY=1 applies; --dry-run always wins', async () => {
    const root = await tempRoot()
    await seedRunDir(root, 'cli-old', 'noop', 40 * DAY_MS)

    const dryOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['gc', '--keep-days', '30', '--keep-runs', '0', '--json'],
        {
          cwd: root,
          stdout: chunk => dryOutput.push(chunk),
          stderr: () => {},
          env: {},
        },
      ),
    ).toBe(0)
    const dryParsed = JSON.parse(dryOutput.join('')) as {
      dryRun: boolean
      keepDays: number
      keepRuns: number
      runs: { planned: Array<{ runId: string }>; pruned: string[] }
    }
    expect(dryParsed.dryRun).toBe(true)
    expect(dryParsed.keepDays).toBe(30)
    expect(dryParsed.keepRuns).toBe(0)
    expect(dryParsed.runs.planned.map(entry => entry.runId)).toEqual(['cli-old'])
    expect(dryParsed.runs.pruned).toEqual([])
    expect(await exists(directEditorRunDir(root, 'cli-old'))).toBe(true)

    // --dry-run wins even when the env opt-in is set.
    const envDryOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['gc', '--dry-run', '--keep-days', '30', '--keep-runs', '0', '--json'],
        {
          cwd: root,
          stdout: chunk => envDryOutput.push(chunk),
          stderr: () => {},
          env: { [MATOS_EVOLVE_GC_APPLY_ENV]: '1' },
        },
      ),
    ).toBe(0)
    expect(
      (JSON.parse(envDryOutput.join('')) as { dryRun: boolean }).dryRun,
    ).toBe(true)
    expect(await exists(directEditorRunDir(root, 'cli-old'))).toBe(true)

    // Env opt-in applies without --apply.
    const envApplyOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['gc', '--keep-days', '30', '--keep-runs', '0', '--json'],
        {
          cwd: root,
          stdout: chunk => envApplyOutput.push(chunk),
          stderr: () => {},
          env: { [MATOS_EVOLVE_GC_APPLY_ENV]: '1' },
        },
      ),
    ).toBe(0)
    const envApplyParsed = JSON.parse(envApplyOutput.join('')) as {
      dryRun: boolean
      runs: { pruned: string[] }
    }
    expect(envApplyParsed.dryRun).toBe(false)
    expect(envApplyParsed.runs.pruned).toEqual(['cli-old'])
    expect(await exists(directEditorRunDir(root, 'cli-old'))).toBe(false)

    // --apply flag applies too.
    await seedRunDir(root, 'cli-old-2', 'noop', 40 * DAY_MS)
    const applyOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['gc', '--apply', '--keep-days=30', '--keep-runs=0', '--json'],
        {
          cwd: root,
          stdout: chunk => applyOutput.push(chunk),
          stderr: () => {},
          env: {},
        },
      ),
    ).toBe(0)
    expect(
      (JSON.parse(applyOutput.join('')) as { runs: { pruned: string[] } }).runs
        .pruned,
    ).toEqual(['cli-old-2'])
    expect(await exists(directEditorRunDir(root, 'cli-old-2'))).toBe(false)
  })
})
