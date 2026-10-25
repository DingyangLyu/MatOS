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

import { appendFile, mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  appendMonitorRecord,
  compactMonitorRecordsFileIfOversized,
  parseMonitorRecordsJsonl,
  readMonitorRecordsForSession,
  selectMonitorRecordsToKeep,
  type MatOSSelfEvolutionMonitorRecord,
} from './evolutionMonitorRecords.js'

function record(
  index: number,
  overrides: Partial<MatOSSelfEvolutionMonitorRecord> = {},
): MatOSSelfEvolutionMonitorRecord {
  return {
    recordId: `monitor-${index}`,
    sessionId: 'session-records-1',
    triggerKind: 'user-feedback',
    triggerKey: `user-feedback:event-${index}`,
    status: 'noop',
    createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    summary: `summary ${index}`,
    ...overrides,
  }
}

async function withMonitorEnv(
  env: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'matos-monitor-records-'))
  const monitorDir = join(root, 'monitor-sessions')
  const previous = new Map<string, string | undefined>()
  const next = { MATOS_EVOLUTION_MONITOR_DIR: monitorDir, ...env }
  for (const [key, value] of Object.entries(next)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    await run(root)
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('MatOS evolution monitor records storage', () => {
  test('serializes concurrent appends into parseable JSONL lines', async () => {
    await withMonitorEnv({}, async root => {
      const records = Array.from({ length: 16 }, (_, index) =>
        record(index, { summary: 'concurrent '.repeat(50) }),
      )
      await Promise.all(records.map(item => appendMonitorRecord(root, item)))

      const raw = await readFile(
        join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
          'records.jsonl',
        ),
        'utf8',
      )
      const lines = raw.split('\n').filter(Boolean)
      // Every line parses (no interleaved half-records) and no record is lost.
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
      const parsed = parseMonitorRecordsJsonl(raw)
      expect(new Set(parsed.map(item => item.recordId)).size).toBe(16)
    })
  })

  test('compacts oversized records files to the newest window plus stable trigger retention', async () => {
    await withMonitorEnv(
      {
        MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES: '4000',
        MATOS_EVOLUTION_MONITOR_RECORDS_KEEP: '5',
      },
      async root => {
        // An early concluded session-end record must survive compaction so its
        // trigger stays suppressed; early event-keyed records may be archived.
        await appendMonitorRecord(
          root,
          record(0, {
            triggerKind: 'session-end',
            triggerKey: 'session-end:session-records-1',
            status: 'direct-edit-complete',
          }),
        )
        for (let index = 1; index <= 40; index += 1) {
          await appendMonitorRecord(
            root,
            record(index, { summary: `padding ${'x'.repeat(220)}` }),
          )
        }

        const sessionDir = join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
        )
        const hot = parseMonitorRecordsJsonl(
          await readFile(join(sessionDir, 'records.jsonl'), 'utf8'),
        )
        const archived = parseMonitorRecordsJsonl(
          await readFile(join(sessionDir, 'records-archive.jsonl'), 'utf8'),
        )

        expect(hot.length).toBeLessThan(41)
        expect(hot.map(item => item.recordId)).toContain('monitor-0')
        expect(hot.map(item => item.recordId)).toContain('monitor-40')
        expect(archived.length).toBeGreaterThan(0)
        expect(archived.map(item => item.recordId)).not.toContain('monitor-0')
        // Reads keep working from the compacted hot file.
        const read = await readMonitorRecordsForSession(root, 'session-records-1')
        expect(read.map(item => item.recordId)).toContain('monitor-40')
        expect(read.map(item => item.recordId)).toContain('monitor-0')
        // No hot+archive record was lost overall.
        const union = new Set([
          ...hot.map(item => item.recordId),
          ...archived.map(item => item.recordId),
        ])
        expect(union.size).toBe(41)
      },
    )
  })

  test('keeps newest records and stable-kind latest records when selecting the compaction window', () => {
    const records = [
      record(0, {
        triggerKind: 'workflow-failure',
        triggerKey: 'workflow-failure:evidence-1',
        status: 'direct-edit-complete',
      }),
      ...Array.from({ length: 20 }, (_, index) => record(index + 1)),
    ]
    const { kept, archived } = selectMonitorRecordsToKeep(records, 4)
    const keptIds = kept.map(item => item.recordId)
    expect(keptIds).toContain('monitor-0')
    expect(keptIds).toContain('monitor-20')
    expect(keptIds).toContain('monitor-17')
    expect(archived.map(item => item.recordId)).toContain('monitor-1')
    // Event-keyed kinds do not pin ancient records: only the newest window
    // plus the stable workflow-failure record remain.
    expect(kept.length).toBe(5)
  })

  test('compaction bounds the hot records file by bytes, not only by record count', async () => {
    await withMonitorEnv(
      {
        MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES: '1500',
        MATOS_EVOLUTION_MONITOR_RECORDS_KEEP: '200',
      },
      async root => {
        for (let index = 0; index < 30; index += 1) {
          await appendMonitorRecord(
            root,
            record(index, { summary: `padding ${'y'.repeat(200)}` }),
          )
        }

        const sessionDir = join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
        )
        const rawHot = await readFile(join(sessionDir, 'records.jsonl'), 'utf8')
        // The keep-count alone (200) would never compact; the byte cap must.
        expect(Buffer.byteLength(rawHot, 'utf8')).toBeLessThan(2500)
        const hot = parseMonitorRecordsJsonl(rawHot)
        expect(hot.map(item => item.recordId)).toContain('monitor-29')
        const archived = parseMonitorRecordsJsonl(
          await readFile(join(sessionDir, 'records-archive.jsonl'), 'utf8'),
        )
        const union = new Set(
          [...hot, ...archived].map(item => item.recordId),
        )
        expect(union.size).toBe(30)
      },
    )
  })

  test('archive rotates once at its size cap instead of growing without bound', async () => {
    await withMonitorEnv(
      {
        MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES: '1200',
        MATOS_EVOLUTION_MONITOR_RECORDS_KEEP: '2',
        MATOS_EVOLUTION_MONITOR_ARCHIVE_MAX_BYTES: '1500',
      },
      async root => {
        for (let index = 0; index < 40; index += 1) {
          await appendMonitorRecord(
            root,
            record(index, { summary: `padding ${'z'.repeat(200)}` }),
          )
        }

        const sessionDir = join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
        )
        const archiveInfo = await stat(
          join(sessionDir, 'records-archive.jsonl'),
        )
        // The hot archive stays near its cap (cap plus at most one batch).
        expect(archiveInfo.size).toBeLessThan(3000)
        const rotated = await stat(
          join(sessionDir, 'records-archive.1.jsonl'),
        )
        expect(rotated.size).toBeGreaterThan(0)
      },
    )
  })

  test('compaction sweeps aged compact tmp residue from crashed compactors', async () => {
    await withMonitorEnv(
      {
        MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES: '1500',
        MATOS_EVOLUTION_MONITOR_RECORDS_KEEP: '5',
      },
      async root => {
        const sessionDir = join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
        )
        await mkdir(sessionDir, { recursive: true })
        // Crash residue: a compactor died between its tmp write and rename.
        const agedTmp = join(sessionDir, 'records.jsonl.compact-9999-1')
        // A fresh tmp could belong to a live concurrent compactor.
        const freshTmp = join(sessionDir, 'records.jsonl.compact-9999-2')
        await writeFile(agedTmp, '{"partial":', 'utf8')
        await writeFile(freshTmp, '{"partial":', 'utf8')
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
        await utimes(agedTmp, old, old)

        // Enough appends to push records.jsonl past the byte cap, which is the
        // exact situation the crashed compactor leaves behind.
        for (let index = 0; index < 20; index += 1) {
          await appendMonitorRecord(
            root,
            record(index, { summary: `padding ${'x'.repeat(200)}` }),
          )
        }

        const names = await readdir(sessionDir)
        expect(names).not.toContain('records.jsonl.compact-9999-1')
        expect(names).toContain('records.jsonl.compact-9999-2')
        // The real records survived compaction intact.
        const hot = parseMonitorRecordsJsonl(
          await readFile(join(sessionDir, 'records.jsonl'), 'utf8'),
        )
        expect(hot.length).toBeGreaterThan(0)
      },
    )
  })

  test('compaction preserves records appended between the read and the rename', async () => {
    await withMonitorEnv(
      {
        MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES: '500',
        MATOS_EVOLUTION_MONITOR_RECORDS_KEEP: '2',
      },
      async () => {
        const sessionDir = join(
          process.env.MATOS_EVOLUTION_MONITOR_DIR!,
          'session-records-1',
        )
        await mkdir(sessionDir, { recursive: true })
        const path = join(sessionDir, 'records.jsonl')
        const seeded = Array.from({ length: 6 }, (_, index) =>
          record(index, { summary: `seed ${'s'.repeat(120)}` }),
        )
        await writeFile(
          path,
          seeded.map(item => JSON.stringify(item)).join('\n') + '\n',
          'utf8',
        )
        // Simulate a lock-timeout writer appending while compaction is between
        // its read and its rename: the appended record must survive.
        const raced = record(99, { summary: 'raced lockless append' })
        await compactMonitorRecordsFileIfOversized(sessionDir, path, {
          beforeRename: async () => {
            await appendFile(path, `${JSON.stringify(raced)}\n`, 'utf8')
          },
        })

        const hot = parseMonitorRecordsJsonl(await readFile(path, 'utf8'))
        expect(hot.map(item => item.recordId)).toContain('monitor-99')
        expect(hot.map(item => item.recordId)).toContain('monitor-5')
      },
    )
  })
})
