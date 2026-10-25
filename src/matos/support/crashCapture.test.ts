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

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  MATOS_CRASH_LOG_ROTATE_BYTES,
  recordMatOSFatalExit,
  resolveMatOSCrashLogPath,
  type MatOSCrashRecord,
} from './crashCapture.js'

const FIXTURE_PATH = join(import.meta.dir, 'crashCapture.fixture.ts')
const PLANTED_SECRET = 'super-secret-crash-token-abc123'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function makeOpsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-crash-capture-'))
  roots.push(root)
  return join(root, 'ops')
}

async function runFixture(
  mode: string,
  opsDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [FIXTURE_PATH, mode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATOS_OPS_DIR: opsDir,
        MATOS_FAKE_PROVIDER_TOKEN: PLANTED_SECRET,
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', code => resolve({ code: code ?? -1, stderr }))
    child.on('error', () => resolve({ code: -1, stderr }))
  })
}

async function readCrashRecords(opsDir: string): Promise<MatOSCrashRecord[]> {
  const raw = await readFile(
    join(opsDir, 'crashes', 'crashes.jsonl'),
    'utf8',
  )
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as MatOSCrashRecord)
}

describe('MatOS crash capture', () => {
  test('real uncaught exception appends a redacted crash record and stays fatal', async () => {
    const opsDir = await makeOpsDir()
    const result = await runFixture('throw', opsDir)

    expect(result.code).not.toBe(0)
    // Default fatal reporting is preserved (the monitor observes, never handles).
    expect(result.stderr).toContain('fixture-throw')

    const records = await readCrashRecords(opsDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.kind).toBe('crash')
    expect(record.origin).toBe('uncaughtException')
    expect(record.component).toBe('crash-fixture')
    expect(record.pid).toBeGreaterThan(0)
    expect(record.argv.length).toBeLessThanOrEqual(3)
    expect(record.message).toContain('fixture-throw')
    expect(record.stack ?? '').toContain('crashCapture.fixture')
    expect(typeof record.uptimeSeconds).toBe('number')
    expect(record.memoryRssBytes ?? 0).toBeGreaterThan(0)
    // Redaction: the planted secret never lands in the record.
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(PLANTED_SECRET)
    expect(record.message).toContain('[redacted:MATOS_FAKE_PROVIDER_TOKEN]')
  }, 30_000)

  test('real unhandled rejection is recorded once and stays fatal', async () => {
    const opsDir = await makeOpsDir()
    const result = await runFixture('rejection', opsDir)

    expect(result.code).not.toBe(0)

    const records = await readCrashRecords(opsDir)
    // The rethrow that restores default fatality must not double-record.
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.kind).toBe('crash')
    expect(record.origin).toBe('unhandledRejection')
    expect(record.message).toContain('fixture-rejection')
    expect(JSON.stringify(record)).not.toContain(PLANTED_SECRET)
  }, 30_000)

  test('explicit fatal-exit call site records kind fatal-exit', async () => {
    const opsDir = await makeOpsDir()
    const result = await runFixture('fatal-exit', opsDir)

    expect(result.code).toBe(3)

    const records = await readCrashRecords(opsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.kind).toBe('fatal-exit')
    expect(records[0]!.message).toContain('fixture-fatal-exit')
    expect(JSON.stringify(records[0])).not.toContain(PLANTED_SECRET)
  }, 30_000)

  test('recent log tail is embedded and redacted when cheaply available', async () => {
    const opsDir = await makeOpsDir()
    const logPath = join(opsDir, 'component.log')
    await mkdir(opsDir, { recursive: true })
    await writeFile(
      logPath,
      `boot ok\nusing credential ${PLANTED_SECRET} for provider\nready\n`,
    )
    await runFixture('throw', opsDir, { CRASH_FIXTURE_RECENT_LOG: logPath })

    const records = await readCrashRecords(opsDir)
    expect(records).toHaveLength(1)
    const tail = records[0]!.recentLogTail ?? []
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.join('\n')).toContain('ready')
    expect(tail.join('\n')).not.toContain(PLANTED_SECRET)
    expect(tail.join('\n')).toContain('[redacted:MATOS_FAKE_PROVIDER_TOKEN]')
  }, 30_000)

  test('crash log rotates at the size cap and keeps one archive', async () => {
    const opsDir = await makeOpsDir()
    const crashesDir = join(opsDir, 'crashes')
    await mkdir(crashesDir, { recursive: true })
    const crashesPath = join(crashesDir, 'crashes.jsonl')
    await writeFile(
      crashesPath,
      Buffer.alloc(MATOS_CRASH_LOG_ROTATE_BYTES + 1024, 0x78),
    )

    const previousOpsDir = process.env.MATOS_OPS_DIR
    process.env.MATOS_OPS_DIR = opsDir
    try {
      expect(resolveMatOSCrashLogPath()).toBe(crashesPath)
      const written = recordMatOSFatalExit({
        component: 'rotation-test',
        error: new Error('rotation-probe'),
      })
      expect(written).toBe(true)
    } finally {
      if (previousOpsDir === undefined) {
        delete process.env.MATOS_OPS_DIR
      } else {
        process.env.MATOS_OPS_DIR = previousOpsDir
      }
    }

    const archive = await stat(`${crashesPath}.1`)
    expect(archive.size).toBeGreaterThanOrEqual(MATOS_CRASH_LOG_ROTATE_BYTES)
    const records = await readCrashRecords(opsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.message).toContain('rotation-probe')
    const fresh = await stat(crashesPath)
    expect(fresh.size).toBeLessThan(64 * 1024)
  })
})
