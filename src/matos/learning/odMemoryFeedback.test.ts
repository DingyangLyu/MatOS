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

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { appendMonitorRecord } from './evolutionMonitorRecords.js'
import {
  odMemoryFeedbackTriggerKey,
  odMemoryIdFromTriggerKey,
  submitMatOSOdMemoryFeedback,
  type MatOSOdMemoryFeedbackResult,
} from './odMemoryFeedback.js'

const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MATOS_BENCHMARK_MODE: '',
  MATOS_DISABLE_EVOLUTION: '',
  MATOS_DISABLE_EVOLUTION_WORKER: '',
  MATOS_DISABLE_EVOLUTION_JOBS: '',
  MATOS_DISABLE_REFLECTION_FORK: '',
  MATOS_DISABLE_SELF_EVOLUTION: '',
  MATOS_DISABLE_ALWAYS_ON_LEARNING: '',
  MATOS_SESSION_DIR: '',
  MATOS_EVOLUTION_MONITOR_DIR: '',
}

function baseInput(cwd: string) {
  return {
    cwd,
    memoryId: 'rule_dark_theme_charts',
    memoryType: 'rule',
    title: 'Prefer dark theme charts',
    detail: 'Assertion: charts default to the dark theme.\nCheck: rendered chart backgrounds are dark.',
    extractionSource: 'manual',
    env: CLEAN_ENV,
  }
}

describe('odMemoryFeedback', () => {
  test('appends a redacted bridge event and dispatches the user-feedback worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-feedback-'))
    const spawnCalls: unknown[] = []
    const result = await submitMatOSOdMemoryFeedback(baseInput(cwd), {
      spawnWorker: input => {
        spawnCalls.push(input)
        return true
      },
      now: () => new Date('2026-07-08T10:00:00Z'),
    })

    expect(result.status).toBe('spawned')
    expect(result.sessionId).toBe('od-memory-feedback-2026-07-08')
    expect(result.triggerKey?.startsWith('user-feedback:od-memory:rule_dark_theme_charts:')).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    const dispatched = spawnCalls[0] as {
      sessionPath: string
      trigger: { kind: string; key: string; eventId?: string }
    }
    expect(dispatched.trigger.kind).toBe('user-feedback')
    expect(dispatched.trigger.key).toBe(result.triggerKey ?? '')
    expect(dispatched.trigger.eventId).toBe(result.eventId ?? '')

    const raw = await readFile(result.sessionPath ?? '', 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    const event = JSON.parse(lines[0] ?? '{}') as {
      type: string
      sessionId: string
      execution?: string
      data: Record<string, unknown>
    }
    expect(event.type).toBe('matos.feedback.recorded')
    expect(event.sessionId).toBe('od-memory-feedback-2026-07-08')
    expect(event.execution).toBe('od-memory-bridge')
    expect(event.data.memoryId).toBe('rule_dark_theme_charts')
    expect(event.data.memoryType).toBe('rule')
    expect(event.data.extractionSource).toBe('manual')
  })

  test('concurrent submissions append intact JSONL lines to the shared per-day bridge session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-concurrent-'))
    const now = () => new Date('2026-07-09T09:00:00Z')
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        submitMatOSOdMemoryFeedback(
          {
            ...baseInput(cwd),
            memoryId: `rule_concurrent_${index}`,
            detail: `Assertion ${index}: charts stay dark. ${'padding '.repeat(80)}`,
          },
          { spawnWorker: () => true, now },
        ),
      ),
    )
    expect(results.every(result => result.status === 'spawned')).toBe(true)
    const sessionPath = results[0]?.sessionPath ?? ''
    const raw = await readFile(sessionPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    // Every concurrent append landed as one full line: no interleaved or
    // truncated half-records, and no submission was lost.
    expect(lines).toHaveLength(12)
    const memoryIds = new Set<string>()
    for (const line of lines) {
      const event = JSON.parse(line) as { data?: { memoryId?: string } }
      if (typeof event.data?.memoryId === 'string') {
        memoryIds.add(event.data.memoryId)
      }
    }
    expect(memoryIds.size).toBe(12)
    // The append lock directory was released.
    const lockExists = await stat(`${sessionPath}.lock`)
      .then(() => true)
      .catch(() => false)
    expect(lockExists).toBe(false)
  })

  test('reports duplicate when a monitor record already covers the same content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-dup-'))
    const input = baseInput(cwd)
    const triggerKey = odMemoryFeedbackTriggerKey({
      memoryId: input.memoryId,
      title: input.title,
      detail: input.detail,
    })
    await appendMonitorRecord(cwd, {
      recordId: 'record-1',
      sessionId: 'od-memory-feedback-2026-07-07',
      triggerKind: 'user-feedback',
      triggerKey,
      status: 'direct-edit-complete',
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:05:00Z',
      summary: 'previously processed',
    })

    const spawnCalls: unknown[] = []
    const result = await submitMatOSOdMemoryFeedback(input, {
      spawnWorker: () => {
        spawnCalls.push(true)
        return true
      },
    })
    expect(result.status).toBe('duplicate')
    expect(spawnCalls).toHaveLength(0)
  })

  test('changed content produces a new trigger key and dispatches again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-rev-'))
    const input = baseInput(cwd)
    const firstKey = odMemoryFeedbackTriggerKey({
      memoryId: input.memoryId,
      title: input.title,
      detail: input.detail,
    })
    await appendMonitorRecord(cwd, {
      recordId: 'record-1',
      sessionId: 'od-memory-feedback-2026-07-07',
      triggerKind: 'user-feedback',
      triggerKey: firstKey,
      status: 'direct-edit-complete',
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:05:00Z',
      summary: 'previous revision',
    })

    const results: MatOSOdMemoryFeedbackResult[] = []
    results.push(
      await submitMatOSOdMemoryFeedback(
        { ...input, detail: `${input.detail}\nAlso: axis labels stay light gray.` },
        { spawnWorker: () => true },
      ),
    )
    expect(results[0]?.status).toBe('spawned')
    expect(results[0]?.triggerKey).not.toBe(firstKey)
  })

  test('suppressed env skips both the event append and the worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-supp-'))
    const result = await submitMatOSOdMemoryFeedback(
      {
        ...baseInput(cwd),
        env: { ...CLEAN_ENV, MATOS_DISABLE_SELF_EVOLUTION: '1' },
      },
      { spawnWorker: () => true },
    )
    expect(result.status).toBe('suppressed')
    expect(result.sessionPath).toBeUndefined()
  })

  test('rejects invalid memory ids and types without writing anything', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-od-memory-invalid-'))
    const badId = await submitMatOSOdMemoryFeedback(
      { ...baseInput(cwd), memoryId: '../escape' },
      { spawnWorker: () => true },
    )
    expect(badId.status).toBe('invalid')
    const badType = await submitMatOSOdMemoryFeedback(
      { ...baseInput(cwd), memoryType: 'exotic' },
      { spawnWorker: () => true },
    )
    expect(badType.status).toBe('invalid')
  })

  test('trigger key round-trips the memory id', () => {
    const key = odMemoryFeedbackTriggerKey({
      memoryId: 'profile_role',
      title: 'User role',
      detail: 'Senior FE engineer',
    })
    expect(odMemoryIdFromTriggerKey(key)).toBe('profile_role')
    expect(odMemoryIdFromTriggerKey('session-end:foo')).toBeUndefined()
  })
})
