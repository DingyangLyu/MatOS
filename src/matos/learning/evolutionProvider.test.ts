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

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildMatOSManualEvolutionTrigger,
  listMatOSEvolutionProviderIds,
  registerMatOSEvolutionProvider,
  resolveMatOSEvolutionProvider,
  scheduleMatOSBackgroundEvolutionTask,
  spawnManualSessionEvolutionWorker,
  spawnSessionCloseEvolutionWorker,
  spawnWorkflowEvidenceEvolutionWorker,
  type MatOSEvolutionProvider,
} from './evolutionProvider.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('MatOS evolution provider registry', () => {
  test('uses direct-editor as the default provider and keeps legacy aliases', () => {
    const defaultProvider = resolveMatOSEvolutionProvider({})
    expect(defaultProvider.id).toBe('direct-editor')

    const legacyExperienceProvider = resolveMatOSEvolutionProvider({
      MATOS_EVOLUTION_PROVIDER: 'experience',
    })
    expect(legacyExperienceProvider.id).toBe('direct-editor')

    const nativeProvider = resolveMatOSEvolutionProvider({
      MATOS_EVOLUTION_PROVIDER: 'native',
    })
    expect(nativeProvider.id).toBe('direct-editor')
  })

  test('selects disabled and custom registered providers by id', async () => {
    expect(
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: 'disabled' })
        .enabled,
    ).toBe(false)
    expect(
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: 'off' }).id,
    ).toBe('disabled')

    const provider: MatOSEvolutionProvider = {
      id: 'test-provider',
      enabled: true,
      scheduleSessionCloseJobs: async () => undefined,
      createWorkflowEvidenceJobs: async () => undefined,
    }

    registerMatOSEvolutionProvider(provider)

    expect(listMatOSEvolutionProviderIds()).toContain('test-provider')
    const selected = resolveMatOSEvolutionProvider({
      MATOS_EVOLUTION_PROVIDER: 'test-provider',
    })
    expect(selected.id).toBe('test-provider')
  })

  test('schedules background evolution without running synchronously', async () => {
    let calls = 0
    process.env.MATOS_BACKGROUND_EVOLUTION_DELAY_MS = '1'

    scheduleMatOSBackgroundEvolutionTask(async () => {
      calls += 1
    })

    expect(calls).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toBe(1)
  })

  test('suppresses background evolution fallback in benchmark mode', async () => {
    let calls = 0
    process.env.MATOS_BACKGROUND_EVOLUTION_DELAY_MS = '1'
    process.env.MATOS_BENCHMARK_MODE = '1'

    scheduleMatOSBackgroundEvolutionTask(async () => {
      calls += 1
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toBe(0)
  })

  test('detached evolution worker spawn failures are isolated from foreground callers', async () => {
    const originalExecPath = process.execPath
    const missingCwd = join(tmpdir(), `matos-missing-cwd-${Date.now()}`)
    const evidence = {
      schemaVersion: 1 as const,
      evidenceId: 'workflow-evidence-test',
      runId: 'run-test',
      workflowRef: 'workflow:test',
      status: 'failed',
      traceId: 'trace-test',
      sourceRefs: ['workflow-run:run-test'],
      nodeSummary: [],
      eventTypes: [],
      artifactRefs: [],
      suggestedAssetTypes: ['workflow' as const],
      createdAt: new Date(0).toISOString(),
      path: '/tmp/workflow-evidence-test.json',
    }
    expect(() =>
      spawnSessionCloseEvolutionWorker({
        cwd: missingCwd,
        sessionId: 'session-test',
        sessionPath: '/tmp/session-test.jsonl',
        hidden: true,
      }),
    ).not.toThrow()
    expect(() =>
      spawnWorkflowEvidenceEvolutionWorker({
        cwd: missingCwd,
        evidence,
      }),
    ).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 20))

    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: '/definitely/missing/matos-evolution-worker-runtime',
    })
    try {
      expect(
        spawnSessionCloseEvolutionWorker({
          cwd: process.cwd(),
          sessionId: 'session-test',
          sessionPath: '/tmp/session-test.jsonl',
          hidden: true,
        }),
      ).toBe(true)
      expect(
        spawnWorkflowEvidenceEvolutionWorker({
          cwd: process.cwd(),
          evidence,
        }),
      ).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        value: originalExecPath,
      })
    }
  })

  test('manual evolve worker preserves targets without marking the monitor run hidden', async () => {
    const originalExecPath = process.execPath
    const root = await mkdtemp(join(tmpdir(), 'matos-manual-evolve-worker-'))
    const capturePath = join(root, 'args.txt')
    const fakeRuntime = join(root, 'fake-runtime.sh')
    await writeFile(
      fakeRuntime,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturePath)}\n`,
    )
    await chmod(fakeRuntime, 0o755)
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: fakeRuntime,
    })
    try {
      const trigger = buildMatOSManualEvolutionTrigger({
        cwd: root,
        sessionId: 'session-test',
        sessionPath: join(root, 'session-test.jsonl'),
        assetTypes: ['workflow', 'skill'],
        requestId: 'request-test',
      })
      expect(
        spawnManualSessionEvolutionWorker({
          cwd: root,
          sessionId: 'session-test',
          sessionPath: join(root, 'session-test.jsonl'),
          assetTypes: ['workflow', 'skill'],
          trigger,
        }),
      ).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      const args = await readFile(capturePath, 'utf8')
      expect(args).toContain('session-trigger')
      expect(args).toContain('--target-asset-types')
      expect(args).toContain('skill,workflow')
      expect(args).not.toContain('--hidden')
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        value: originalExecPath,
      })
    }
  })

  test('normalizes provider ids and fails safe to disabled for unknown values', () => {
    // Case/whitespace variants of known ids still resolve.
    expect(
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: ' Disabled ' }).id,
    ).toBe('disabled')
    expect(
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: 'OFF' }).id,
    ).toBe('disabled')
    expect(
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: 'Direct-Editor' }).id,
    ).toBe('direct-editor')

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      // The typo "disable" previously fell through to the ENABLED default
      // provider — hidden LLM runs the operator explicitly tried to turn off.
      const disable = resolveMatOSEvolutionProvider({
        MATOS_EVOLUTION_PROVIDER: 'disable',
      })
      expect(disable.id).toBe('disabled')
      expect(disable.enabled).toBe(false)
      // Unknown values warn once, then stay silent for the same value.
      resolveMatOSEvolutionProvider({ MATOS_EVOLUTION_PROVIDER: 'disable' })
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain('disable')
    } finally {
      console.warn = originalWarn
    }
  })
})
