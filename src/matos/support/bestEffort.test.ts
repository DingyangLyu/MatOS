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

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { bestEffort } from './bestEffort.js'
import type { MatOSCrashRecord } from './crashCapture.js'

let opsDir = ''
let previousOpsDir: string | undefined

beforeEach(async () => {
  previousOpsDir = process.env.MATOS_OPS_DIR
  opsDir = await mkdtemp(join(tmpdir(), 'matos-best-effort-'))
  process.env.MATOS_OPS_DIR = opsDir
})

afterEach(async () => {
  if (previousOpsDir === undefined) {
    delete process.env.MATOS_OPS_DIR
  } else {
    process.env.MATOS_OPS_DIR = previousOpsDir
  }
  await rm(opsDir, { recursive: true, force: true })
})

async function swallowedRecords(): Promise<MatOSCrashRecord[]> {
  const raw = await readFile(
    join(opsDir, 'crashes', 'crashes.jsonl'),
    'utf8',
  ).catch(() => '')
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as MatOSCrashRecord)
}

describe('bestEffort', () => {
  test('returns the resolved value for promise and function forms', async () => {
    expect(await bestEffort('ok-promise', Promise.resolve(41))).toBe(41)
    expect(await bestEffort('ok-async-fn', async () => 42)).toBe(42)
    expect(await bestEffort('ok-sync-fn', () => 43)).toBe(43)
  })

  test('swallows rejections, returns undefined, and records kind swallowed', async () => {
    const label = `swallow-${randomUUID()}`
    const result = await bestEffort(
      label,
      Promise.reject(new Error('durable write failed')),
    )
    expect(result).toBeUndefined()

    const records = await swallowedRecords()
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.kind).toBe('swallowed')
    expect(record.origin).toBe('best-effort')
    expect(record.label).toBe(label)
    expect(record.message).toContain('durable write failed')
  })

  test('swallows synchronous throws from the function form', async () => {
    const label = `sync-throw-${randomUUID()}`
    const result = await bestEffort(label, () => {
      throw new Error('sync boom')
    })
    expect(result).toBeUndefined()
    const records = await swallowedRecords()
    expect(records.filter(record => record.label === label)).toHaveLength(1)
  })

  test('samples at most one record per label per minute, per label', async () => {
    const labelA = `sample-a-${randomUUID()}`
    const labelB = `sample-b-${randomUUID()}`

    for (let index = 0; index < 5; index += 1) {
      await bestEffort(labelA, Promise.reject(new Error(`a-${index}`)))
    }
    await bestEffort(labelB, Promise.reject(new Error('b-0')))

    const records = await swallowedRecords()
    expect(records.filter(record => record.label === labelA)).toHaveLength(1)
    expect(records.filter(record => record.label === labelB)).toHaveLength(1)
    // The first failure per label is the one that lands.
    expect(
      records.find(record => record.label === labelA)?.message,
    ).toContain('a-0')
  })
})
