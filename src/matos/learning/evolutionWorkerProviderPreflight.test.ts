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

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  parseMatOSEvolutionWorkerArgs,
  runMatOSEvolutionWorker,
} from '../../entrypoints/matos-evolution-worker.js'
import { parseMonitorRecordsJsonl } from './evolutionMonitorRecords.js'

// Every env key the worker preflight consults, plus the provider keys a
// polluted test shell could otherwise leak into the "no credential" case.
const PREFLIGHT_ENV_KEYS = [
  'NODE_ENV',
  'MATOS_EVOLUTION_PROVIDER_PREFLIGHT',
  'MATOS_EVOLUTION_PROVIDER',
  'MATOS_BENCHMARK_MODE',
  'MATOS_DISABLE_EVOLUTION',
  'MATOS_DISABLE_EVOLUTION_WORKER',
  'MATOS_DISABLE_EVOLUTION_JOBS',
  'MATOS_DISABLE_REFLECTION_FORK',
  'MATOS_DISABLE_SELF_EVOLUTION',
  'MATOS_DISABLE_ALWAYS_ON_LEARNING',
  'MATOS_DEPLOY_ENV_FILE',
  'MATOS_EVOLUTION_MONITOR_DIR',
  'MATOS_SESSION_DIR',
  'MATOS_RUNTIME_DATA_DIR',
  'MATOS_SCOPE_REF',
  'MATOS_SCOPE_ID',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_KEY',
  'MATOS_DSH_MODEL',
  'MATOS_PROVIDER_BROKER_MODE',
] as const

async function withPreflightEnv(
  env: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const key of PREFLIGHT_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  // Keep the hidden pipeline inert even when the worker itself proceeds.
  process.env.NODE_ENV = 'test'
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  try {
    await run()
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

async function makeSessionWorkerFixture(): Promise<{
  root: string
  monitorRoot: string
  parsed: ReturnType<typeof parseMatOSEvolutionWorkerArgs>
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-evolution-worker-preflight-'))
  const sessionPath = join(root, 'session.jsonl')
  await writeFile(sessionPath, '', 'utf8')
  const parsed = parseMatOSEvolutionWorkerArgs([
    'session-trigger',
    '--cwd',
    root,
    '--session-id',
    'session-preflight-1',
    '--session-path',
    sessionPath,
    '--trigger-kind',
    'user-feedback',
    '--trigger-key',
    'user-feedback:turn-1',
    '--summary',
    'Potential user feedback candidate.',
  ])
  return { root, monitorRoot: join(root, 'monitor-root'), parsed }
}

async function readPreflightRecords(
  monitorRoot: string,
  sessionId: string,
): Promise<ReturnType<typeof parseMonitorRecordsJsonl>> {
  const raw = await readFile(
    join(monitorRoot, sessionId, 'records.jsonl'),
    'utf8',
  ).catch(() => '')
  return parseMonitorRecordsJsonl(raw)
}

describe('MatOS evolution worker provider preflight', () => {
  test('concludes provider_credentials_unavailable without starting the pipeline when no credential exists', async () => {
    const { root, monitorRoot, parsed } = await makeSessionWorkerFixture()
    await withPreflightEnv(
      {
        MATOS_EVOLUTION_PROVIDER_PREFLIGHT: '1',
        MATOS_EVOLUTION_MONITOR_DIR: monitorRoot,
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
      },
      async () => {
        expect(await runMatOSEvolutionWorker(parsed)).toBe(false)
        const records = await readPreflightRecords(
          monitorRoot,
          'session-preflight-1',
        )
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          sessionId: 'session-preflight-1',
          triggerKind: 'user-feedback',
          triggerKey: 'user-feedback:turn-1',
          status: 'failed',
        })
        expect(records[0]?.error).toStartWith('provider_credentials_unavailable')
        expect(records[0]?.summary).toContain('LLM stage was not started')
      },
    )
  })

  test('dispatches normally when a deployment credential is available', async () => {
    const { root, monitorRoot, parsed } = await makeSessionWorkerFixture()
    const secret = 'sk-worker-preflight-valid-001'
    await withPreflightEnv(
      {
        MATOS_EVOLUTION_PROVIDER_PREFLIGHT: '1',
        MATOS_EVOLUTION_MONITOR_DIR: monitorRoot,
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
        DEEPSEEK_BASE_URL: 'https://deployment.example/anthropic',
        DEEPSEEK_API_KEY: secret,
        MATOS_DSH_MODEL: 'deployment-model',
      },
      async () => {
        // NODE_ENV=test keeps the dispatched pipeline itself inert; the worker
        // must still report a successful dispatch.
        expect(await runMatOSEvolutionWorker(parsed)).toBe(true)
        const records = await readPreflightRecords(
          monitorRoot,
          'session-preflight-1',
        )
        expect(
          records.filter(record =>
            record.error?.startsWith('provider_credentials_unavailable'),
          ),
        ).toHaveLength(0)
        for (const record of records) {
          expect(JSON.stringify(record)).not.toContain(secret)
        }
      },
    )
  })

  test('does not write skip records for hidden session runs that never start the pipeline', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-evolution-worker-preflight-hidden-'),
    )
    const sessionPath = join(root, 'session.jsonl')
    await writeFile(sessionPath, '', 'utf8')
    const monitorRoot = join(root, 'monitor-root')
    const parsed = parseMatOSEvolutionWorkerArgs([
      'session-close',
      '--cwd',
      root,
      '--session-id',
      'session-preflight-hidden',
      '--session-path',
      sessionPath,
      '--hidden',
    ])
    await withPreflightEnv(
      {
        MATOS_EVOLUTION_PROVIDER_PREFLIGHT: '1',
        MATOS_EVOLUTION_MONITOR_DIR: monitorRoot,
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
      },
      async () => {
        expect(await runMatOSEvolutionWorker(parsed)).toBe(true)
        const records = await readPreflightRecords(
          monitorRoot,
          'session-preflight-hidden',
        )
        expect(records).toHaveLength(0)
      },
    )
  })

  test('stays inert in test env without an explicit preflight opt-in', async () => {
    const { root, monitorRoot, parsed } = await makeSessionWorkerFixture()
    await withPreflightEnv(
      {
        MATOS_EVOLUTION_MONITOR_DIR: monitorRoot,
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
      },
      async () => {
        expect(await runMatOSEvolutionWorker(parsed)).toBe(true)
        const records = await readPreflightRecords(
          monitorRoot,
          'session-preflight-1',
        )
        expect(records).toHaveLength(0)
      },
    )
  })

  test('records the workflow-evidence trigger identity the pipeline itself would use', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-evolution-worker-preflight-workflow-'),
    )
    const monitorRoot = join(root, 'monitor-root')
    const evidencePath = join(root, 'workflow-evidence.json')
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        schemaVersion: 1,
        evidenceId: 'workflow-evidence-preflight',
        runId: 'workflow-run-preflight',
        workflowRef: 'workflow:compute-submit@0.1.0',
        status: 'failed',
        traceId: 'trace-workflow-preflight',
        sourceRefs: [],
        nodeSummary: [
          { nodeId: 'submit', status: 'failed', attempts: 1, hasError: true },
        ],
        eventTypes: ['workflow.node.failed'],
        artifactRefs: [],
        suggestedAssetTypes: ['workflow'],
      }, null, 2)}\n`,
      'utf8',
    )
    const parsed = parseMatOSEvolutionWorkerArgs([
      'workflow-evidence',
      '--cwd',
      root,
      '--evidence',
      evidencePath,
    ])
    await withPreflightEnv(
      {
        MATOS_EVOLUTION_PROVIDER_PREFLIGHT: '1',
        MATOS_EVOLUTION_MONITOR_DIR: monitorRoot,
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
      },
      async () => {
        expect(await runMatOSEvolutionWorker(parsed)).toBe(false)
        const records = await readPreflightRecords(
          monitorRoot,
          'trace-workflow-preflight',
        )
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          sessionId: 'trace-workflow-preflight',
          triggerKind: 'workflow-failure',
          triggerKey: 'workflow-failure:workflow-evidence-preflight',
          status: 'failed',
        })
        expect(records[0]?.error).toStartWith('provider_credentials_unavailable')
      },
    )
  })
})
