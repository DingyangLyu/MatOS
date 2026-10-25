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

import { appendFile, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { listMatOSDirectAssetEditorRunRecords } from './directAssetEditorRecords.js'
import { computeMatOSEvolutionEffectivenessRecurrence } from './evolutionEffectiveness.js'

const NOW = new Date('2026-08-10T00:00:00.000Z')

function hoursBefore(base: Date, hours: number): string {
  return new Date(base.getTime() - hours * 60 * 60 * 1000).toISOString()
}

async function writeRun(
  root: string,
  options: {
    runId: string
    status?: string
    createdAt?: string
    updatedAt?: string
    trigger?: { kind: string; key: string }
  },
): Promise<void> {
  const createdAt = options.createdAt ?? hoursBefore(NOW, 48)
  const updatedAt = options.updatedAt ?? createdAt
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', options.runId)
  await mkdir(dir, { recursive: true })
  const record = {
    runId: options.runId,
    status: options.status ?? 'accepted',
    createdAt,
    updatedAt,
    scope: 'user',
    input: {
      generatedAt: createdAt,
      scope: 'user',
      editableRoots: ['.matos/assets'],
      ...(options.trigger
        ? {
            currentEvolutionContext: {
              trigger: { ...options.trigger, summary: 'Trigger summary.' },
            },
          }
        : {}),
      experiences: [],
      targetAssets: [],
    },
    editorOutput: {
      summary: 'Updated a knowledge asset.',
      modifiedFiles: ['knowledge/runbook/KNOWLEDGE.md'],
      createdAssets: [],
      updatedAssets: ['knowledge:runbook@0.1.0'],
      disabledAssets: [],
      evidenceRefs: [],
    },
    modifiedFiles: ['knowledge/runbook/KNOWLEDGE.md'],
    createdAssets: [],
    updatedAssets: ['knowledge:runbook@0.1.0'],
    disabledAssets: [],
    evidenceRefs: [],
    roleExitCode: 0,
    sourceAcceptance: [{ sourceId: 'test-source', commit: 'a'.repeat(40), ok: true, pushed: true, validationOk: true, acceptedBranch: 'accepted/test/stable' }],
  }
  await writeFile(join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

async function appendMonitorRecordLine(
  root: string,
  sessionId: string,
  options: {
    recordId: string
    triggerKind: string
    triggerKey: string
    createdAt: string
    status?: string
    directEditorRunId?: string
  },
): Promise<string> {
  const dir = join(root, '.matos', 'evolution', 'monitor', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'records.jsonl')
  await appendFile(
    path,
    `${JSON.stringify({
      recordId: options.recordId,
      sessionId,
      triggerKind: options.triggerKind,
      triggerKey: options.triggerKey,
      status: options.status ?? 'detected',
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      summary: 'Monitor record.',
      ...(options.directEditorRunId
        ? { directEditorRunId: options.directEditorRunId }
        : {}),
    })}\n`,
    'utf8',
  )
  return path
}

describe('computeMatOSEvolutionEffectivenessRecurrence', () => {
  test('requires a completed turn with the accepted asset revision before reporting quiet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-exposure-'))
    await writeRun(root, { runId: 'exposed', updatedAt: hoursBefore(NOW, 24), trigger: { kind: 'tool-failure', key: 'tool-failure:submit:timeout:1' } })
    const sessionDir = join(root, 'sessions')
    await mkdir(sessionDir)
    const env = { MATOS_SESSION_DIR: sessionDir }
    const events = [
      { id: 'before-context', type: 'matos.turn.context.assembled', sessionId: 's', turnId: 'before', timestamp: hoursBefore(NOW, 25), data: { projectedAssets: [{ assetRef: 'knowledge:runbook@0.1.0', sourceId: 'test-source', sourceCommit: 'b'.repeat(40) }] } },
      { id: 'before-end', type: 'matos.turn.completed', sessionId: 's', turnId: 'before', timestamp: hoursBefore(NOW, 24.9), data: { isError: true } },
      { id: 'after-context', type: 'matos.turn.context.assembled', sessionId: 's', turnId: 'after', timestamp: hoursBefore(NOW, 20), data: { projectedAssets: [{ assetRef: 'knowledge:runbook@0.1.0' }] } },
      { id: 'after-end', type: 'matos.turn.completed', sessionId: 's', turnId: 'after', timestamp: hoursBefore(NOW, 19), data: { isError: false } },
    ]
    await writeFile(join(sessionDir, 's.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
    const unversioned = await computeMatOSEvolutionEffectivenessRecurrence({ cwd: root, now: NOW, env })
    expect(unversioned.unknown).toBe(1)
    const projected = events[2]!.data.projectedAssets![0]!
    Object.assign(projected, { sourceId: 'test-source', sourceCommit: 'a'.repeat(40) })
    await writeFile(join(sessionDir, 's.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
    const confirmed = await computeMatOSEvolutionEffectivenessRecurrence({ cwd: root, now: NOW, env })
    expect(confirmed.quiet).toBe(1)
    expect(confirmed.effectivenessProven).toBe(false)
    expect(confirmed.perRun[0]?.exposure).toMatchObject({ before: { completedTurns: 1, failedTurns: 1 }, after: { completedTurns: 1, failedTurns: 0 }, revisionConfirmedCompletedTurns: 1 })
    const monitorPath = await appendMonitorRecordLine(root, 'damaged', { recordId: 'unrelated', triggerKind: 'session-end', triggerKey: 'unrelated', createdAt: hoursBefore(NOW, 2) })
    await appendFile(monitorPath, '{broken\n')
    const corrupt = await computeMatOSEvolutionEffectivenessRecurrence({ cwd: root, now: NOW, env })
    expect(corrupt.scan.corrupt).toBe(1)
    expect(corrupt.perRun[0]?.unknownReason).toBe('incomplete-scan')
    await writeFile(monitorPath, '')
    events[3]!.timestamp = hoursBefore(NOW, -1)
    await writeFile(join(sessionDir, 's.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
    const future = await computeMatOSEvolutionEffectivenessRecurrence({ cwd: root, now: NOW, env })
    expect(future.perRun[0]?.exposure?.revisionConfirmedCompletedTurns).toBe(0)
    expect(future.quiet).toBe(0)
  })

  test('ignores own completion records without mistaking missing exposure for success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const acceptedAt = hoursBefore(NOW, 24)
    await writeRun(root, {
      runId: 'run-quiet',
      status: 'accepted',
      createdAt: hoursBefore(NOW, 25),
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-1' },
    })
    // Pre-acceptance lifecycle record: same key, before the boundary.
    await appendMonitorRecordLine(root, 'sess-1', {
      recordId: 'monitor-detected',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-1',
      createdAt: hoursBefore(NOW, 25),
    })
    // Completion bookkeeping written just AFTER acceptance with the same key
    // and the run's own id: must not count as recurrence (real monitor writes
    // this record milliseconds after run.updatedAt).
    await appendMonitorRecordLine(root, 'sess-1', {
      recordId: 'monitor-complete',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-1',
      status: 'direct-edit-complete',
      createdAt: hoursBefore(NOW, 23.99),
      directEditorRunId: 'run-quiet',
    })

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })

    expect(result.acceptedTotal).toBe(1)
    expect(result.quiet).toBe(0)
    expect(result.recurred).toBe(0)
    expect(result.unknown).toBe(1)
    expect(result.recurrenceRate).toBe(0)
    expect(result.perRun).toHaveLength(1)
    expect(result.perRun[0]).toMatchObject({
      runId: 'run-quiet',
      status: 'accepted',
      triggerKey: 'session-end:sess-1',
      acceptedAt,
      classification: 'unknown',
      unknownReason: 'no-confirmed-post-acceptance-exposure',
    })
    expect(result.scan.scanSkipped).toBe(false)
    expect(result.scan.sessionsScanned).toBe(1)
  })

  test('detects exact-key recurrence after acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const acceptedAt = hoursBefore(NOW, 24)
    const recurredAt = hoursBefore(NOW, 10)
    await writeRun(root, {
      runId: 'run-recurred',
      status: 'accepted',
      createdAt: hoursBefore(NOW, 25),
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-2' },
    })
    await appendMonitorRecordLine(root, 'sess-2', {
      recordId: 'monitor-before',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-2',
      createdAt: hoursBefore(NOW, 26),
    })
    await appendMonitorRecordLine(root, 'sess-2', {
      recordId: 'monitor-refire',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-2',
      createdAt: recurredAt,
    })

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })

    expect(result.acceptedTotal).toBe(1)
    expect(result.recurred).toBe(1)
    expect(result.quiet).toBe(0)
    expect(result.recurrenceRate).toBe(1)
    expect(result.perRun[0]).toMatchObject({
      runId: 'run-recurred',
      classification: 'recurred',
      recurredAt,
      matchedBy: 'exact-key',
      matchingRecordCount: 1,
    })

    // Pre-loaded runs must produce the same aggregates as the disk path.
    const preloaded = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
      runs: await listMatOSDirectAssetEditorRunRecords(root),
    })
    expect(preloaded.acceptedTotal).toBe(1)
    expect(preloaded.recurred).toBe(1)
  })

  test('counts another run lifecycle with the same key as recurrence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const acceptedAt = hoursBefore(NOW, 24)
    await writeRun(root, {
      runId: 'run-first',
      status: 'accepted',
      createdAt: hoursBefore(NOW, 25),
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-3' },
    })
    // The same trigger key later went through a whole new evolution run: this
    // completion record belongs to run-second, so for run-first it is a
    // genuine post-acceptance recurrence.
    await appendMonitorRecordLine(root, 'sess-3', {
      recordId: 'monitor-second-complete',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-3',
      status: 'direct-edit-complete',
      createdAt: hoursBefore(NOW, 5),
      directEditorRunId: 'run-second',
    })

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })

    expect(result.recurred).toBe(1)
    expect(result.perRun[0]).toMatchObject({
      runId: 'run-first',
      classification: 'recurred',
    })
  })

  test('keeps the tool failure fingerprint when dropping a volatile time bucket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const acceptedAt = hoursBefore(NOW, 24)
    await writeRun(root, {
      runId: 'run-tool-failure',
      status: 'accepted_merged',
      createdAt: hoursBefore(NOW, 25),
      updatedAt: acceptedAt,
      trigger: {
        kind: 'tool-failure',
        key: 'tool-failure:BashTool:aaaa1111:100',
      },
    })
    await writeRun(root, {
      runId: 'run-session-end',
      status: 'accepted',
      createdAt: hoursBefore(NOW, 25),
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-4' },
    })
    // Same tool with a different failure is not recurrence of this repair.
    await appendMonitorRecordLine(root, 'sess-later', {
      recordId: 'monitor-family',
      triggerKind: 'tool-failure',
      triggerKey: 'tool-failure:BashTool:bbbb2222:222',
      createdAt: hoursBefore(NOW, 8),
    })
    const differentFailure = await computeMatOSEvolutionEffectivenessRecurrence({ cwd: root, env: {}, now: NOW })
    expect(differentFailure.recurred).toBe(0)
    await appendMonitorRecordLine(root, 'sess-later', {
      recordId: 'monitor-same-fingerprint', triggerKind: 'tool-failure',
      triggerKey: 'tool-failure:BashTool:aaaa1111:222', createdAt: hoursBefore(NOW, 7),
    })
    // Different tool: not a family match.
    await appendMonitorRecordLine(root, 'sess-later', {
      recordId: 'monitor-other-tool',
      triggerKind: 'tool-failure',
      triggerKey: 'tool-failure:OtherTool:cccc3333:333',
      createdAt: hoursBefore(NOW, 8),
    })
    // Different session-end key: session-end has no family matching.
    await appendMonitorRecordLine(root, 'sess-later', {
      recordId: 'monitor-other-session',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-other',
      createdAt: hoursBefore(NOW, 8),
    })

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })

    expect(result.acceptedTotal).toBe(2)
    expect(result.recurred).toBe(1)
    expect(result.quiet).toBe(0)
    expect(result.unknown).toBe(1)
    expect(result.recurrenceRate).toBe(1)
    const byRunId = new Map(result.perRun.map(entry => [entry.runId, entry]))
    expect(byRunId.get('run-tool-failure')).toMatchObject({
      classification: 'recurred',
      matchedBy: 'tool-failure-fingerprint',
    })
    expect(byRunId.get('run-session-end')).toMatchObject({
      classification: 'unknown',
    })
  })

  test('classifies accepted runs without a trigger key as unknown and skips the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    await writeRun(root, {
      runId: 'run-no-trigger',
      status: 'accepted',
      createdAt: hoursBefore(NOW, 24),
      updatedAt: hoursBefore(NOW, 24),
    })
    await appendMonitorRecordLine(root, 'sess-any', {
      recordId: 'monitor-any',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-any',
      createdAt: hoursBefore(NOW, 1),
    })

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })

    expect(result.acceptedTotal).toBe(1)
    expect(result.unknown).toBe(1)
    expect(result.recurrenceRate).toBe(0)
    expect(result.perRun[0]).toMatchObject({
      runId: 'run-no-trigger',
      classification: 'unknown',
      unknownReason: 'missing-trigger-key',
    })
    // Nothing to match, so the monitor tree is not read at all.
    expect(result.scan.scanSkipped).toBe(true)
    expect(result.scan.sessionsSeen).toBe(0)
    expect(result.scan.sessionsScanned).toBe(0)
  })

  test('applies the env-configurable lookback window and ignores non-accepted statuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const oldAcceptedAt = hoursBefore(NOW, 40 * 24)
    await writeRun(root, {
      runId: 'run-old-accepted',
      status: 'accepted',
      createdAt: oldAcceptedAt,
      updatedAt: oldAcceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-old' },
    })
    for (const status of ['edited', 'validated', 'rolled_back', 'failed', 'noop']) {
      await writeRun(root, {
        runId: `run-${status}`,
        status,
        createdAt: hoursBefore(NOW, 24),
        updatedAt: hoursBefore(NOW, 24),
        trigger: { kind: 'session-end', key: `session-end:sess-${status}` },
      })
    }

    const defaultLookback = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })
    expect(defaultLookback.lookbackDays).toBe(30)
    expect(defaultLookback.acceptedTotal).toBe(0)
    expect(defaultLookback.perRun).toHaveLength(0)

    const widerLookback = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: { MATOS_EVOLUTION_EFFECTIVENESS_LOOKBACK_DAYS: '60' },
      now: NOW,
    })
    expect(widerLookback.lookbackDays).toBe(60)
    expect(widerLookback.acceptedTotal).toBe(1)
    expect(widerLookback.perRun[0]?.runId).toBe('run-old-accepted')
  })

  test('caps perRun output while aggregates count all accepted runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    for (let index = 0; index < 3; index += 1) {
      await writeRun(root, {
        runId: `run-cap-${index}`,
        status: 'accepted',
        createdAt: hoursBefore(NOW, 30 - index),
        updatedAt: hoursBefore(NOW, 30 - index),
        trigger: { kind: 'session-end', key: `session-end:sess-cap-${index}` },
      })
    }

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: { MATOS_EVOLUTION_EFFECTIVENESS_MAX_PER_RUN: '2' },
      now: NOW,
    })

    expect(result.acceptedTotal).toBe(3)
    expect(result.unknown).toBe(3)
    expect(result.perRun).toHaveLength(2)
    expect(result.perRunTruncated).toBe(true)
    // Newest acceptance first.
    expect(result.perRun.map(entry => entry.runId)).toEqual([
      'run-cap-2',
      'run-cap-1',
    ])
  })

  test('skips stale-mtime session files and applies the session scan cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-effectiveness-'))
    const acceptedAtDate = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
    const acceptedAt = acceptedAtDate.toISOString()
    await writeRun(root, {
      runId: 'run-bounded',
      status: 'accepted',
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-bounded' },
    })
    // A matching post-acceptance record in a file whose mtime predates the
    // acceptance boundary: impossible in production (records.jsonl is
    // append-only), used here to prove the mtime skip avoids reading the file.
    const stalePath = await appendMonitorRecordLine(root, 'sess-stale', {
      recordId: 'monitor-stale',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-bounded',
      createdAt: hoursBefore(NOW, 1),
    })
    const staleDate = new Date(acceptedAtDate.getTime() - 48 * 60 * 60 * 1000)
    await utimes(stalePath, staleDate, staleDate)
    // Two fresh sessions; with the cap at 1, only the newest-mtime file is
    // read, and the matching record hides in the older fresh session.
    const olderFreshPath = await appendMonitorRecordLine(root, 'sess-fresh-older', {
      recordId: 'monitor-fresh-older',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-bounded',
      createdAt: hoursBefore(NOW, 2),
    })
    const olderFreshDate = new Date(acceptedAtDate.getTime() + 60 * 60 * 1000)
    await utimes(olderFreshPath, olderFreshDate, olderFreshDate)
    const newestFreshPath = await appendMonitorRecordLine(root, 'sess-fresh-newest', {
      recordId: 'monitor-fresh-newest',
      triggerKind: 'session-end',
      triggerKey: 'session-end:sess-unrelated',
      createdAt: hoursBefore(NOW, 1),
    })
    const newestFreshDate = new Date(acceptedAtDate.getTime() + 2 * 60 * 60 * 1000)
    await utimes(newestFreshPath, newestFreshDate, newestFreshDate)

    const result = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: { MATOS_EVOLUTION_EFFECTIVENESS_MAX_SESSIONS: '1' },
      now: NOW,
    })

    expect(result.scan.sessionsSeen).toBe(3)
    expect(result.scan.sessionsSkippedOldMtime).toBe(1)
    expect(result.scan.sessionsSkippedByCap).toBe(1)
    expect(result.scan.sessionsScanned).toBe(1)
    // Missing observations must not produce a reassuring quiet classification.
    expect(result.quiet).toBe(0)
    expect(result.unknown).toBe(1)
    expect(result.perRun[0]?.unknownReason).toBe('incomplete-scan')
    expect(result.recurred).toBe(0)

    const uncapped = await computeMatOSEvolutionEffectivenessRecurrence({
      cwd: root,
      env: {},
      now: NOW,
    })
    // Without the cap the older fresh session is read and recurrence appears;
    // the stale-mtime file remains skipped.
    expect(uncapped.scan.sessionsSkippedOldMtime).toBe(1)
    expect(uncapped.scan.sessionsScanned).toBe(2)
    expect(uncapped.recurred).toBe(1)
  })
})
