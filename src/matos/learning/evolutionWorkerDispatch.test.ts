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

import { describe, expect, test } from 'bun:test'
import {
  HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS,
  evolutionWorkerEntrypointRunnableByRuntime,
  evolutionWorkerSuppressedByEnv,
  hiddenEvolutionWorkerEnv,
  sessionTriggerEvolutionWorkerArgs,
} from './evolutionWorkerDispatch.js'

describe('MatOS evolution worker dispatch', () => {
  test('suppresses background workers for benchmark and legacy disable env flags', () => {
    for (const key of [
      'MATOS_BENCHMARK_MODE',
      'MATOS_DISABLE_EVOLUTION',
      'MATOS_DISABLE_EVOLUTION_WORKER',
      'MATOS_DISABLE_EVOLUTION_JOBS',
      'MATOS_DISABLE_REFLECTION_FORK',
      'MATOS_DISABLE_ALWAYS_ON_LEARNING',
      'MATOS_DISABLE_SELF_EVOLUTION',
    ]) {
      expect(evolutionWorkerSuppressedByEnv({ [key]: '1' })).toBe(true)
    }
  })

  test('does not suppress background workers without an explicit disable flag', () => {
    expect(evolutionWorkerSuppressedByEnv({})).toBe(false)
    expect(evolutionWorkerSuppressedByEnv({ MATOS_BENCHMARK_MODE: '0' })).toBe(
      false,
    )
  })

  test('suppresses background workers when the evolution provider is disabled by env', () => {
    for (const value of ['disabled', 'none', 'off', ' Disabled ']) {
      expect(
        evolutionWorkerSuppressedByEnv({ MATOS_EVOLUTION_PROVIDER: value }),
      ).toBe(true)
    }
    expect(
      evolutionWorkerSuppressedByEnv({
        MATOS_EVOLUTION_PROVIDER: 'direct-editor',
      }),
    ).toBe(false)
    expect(
      evolutionWorkerSuppressedByEnv({ MATOS_EVOLUTION_PROVIDER: '' }),
    ).toBe(false)
  })

  test('session trigger worker args carry the semantic candidate marker and event id', () => {
    const base = {
      cwd: '/tmp/example',
      sessionId: 'session-1',
      sessionPath: '/tmp/example/session.jsonl',
    }
    const candidateArgs = sessionTriggerEvolutionWorkerArgs({
      ...base,
      trigger: {
        kind: 'user-feedback',
        key: 'user-feedback:turn-1',
        eventId: 'turn-1',
        summary: 'Potential user feedback candidate.',
        semanticCandidate: true,
      },
    })
    expect(candidateArgs).toContain('--semantic-candidate')
    const eventIdIndex = candidateArgs.indexOf('--event-id')
    expect(eventIdIndex).toBeGreaterThan(-1)
    expect(candidateArgs[eventIdIndex + 1]).toBe('turn-1')

    const plainArgs = sessionTriggerEvolutionWorkerArgs({
      ...base,
      trigger: {
        kind: 'manual-evolve',
        key: 'manual-evolve:session-1:request-1',
        summary: 'Manual evolve.',
      },
    })
    expect(plainArgs).not.toContain('--semantic-candidate')
    expect(plainArgs).not.toContain('--event-id')
  })

  test('session trigger worker args round-trip every trigger field through the worker parser', async () => {
    const { parseMatOSEvolutionWorkerArgs } = await import(
      '../../entrypoints/matos-evolution-worker.js'
    )
    const args = sessionTriggerEvolutionWorkerArgs({
      cwd: '/tmp/example',
      sessionId: 'session-1',
      sessionPath: '/tmp/example/session.jsonl',
      hidden: true,
      trigger: {
        kind: 'tool-failure',
        key: 'tool-failure:hpc-submit:abc:1',
        eventId: 'event-9',
        summary: 'submit failed',
        targetAssetTypes: ['tool'],
        targetAssetRefs: ['tool:hpc-submit'],
        experienceOnly: true,
        semanticCandidate: true,
      },
    })
    const parsed = parseMatOSEvolutionWorkerArgs(args.slice(1))
    expect(parsed.mode).toBe('session-trigger')
    if (parsed.mode !== 'session-trigger') {
      throw new Error('expected session-trigger mode')
    }
    // A dropped field here means the spawned production worker silently
    // diverges from the tested inline path (the dead strict-contract bug).
    expect(parsed.targetAssetTypes).toEqual(['tool'])
    expect(parsed.targetAssetRefs).toEqual(['tool:hpc-submit'])
    expect(parsed.experienceOnly).toBe(true)
    expect(parsed.semanticCandidate).toBe(true)
    expect(parsed.eventId).toBe('event-9')
    expect(parsed.hidden).toBe(true)
  })

  test('hidden worker env drops project member binding but keeps scope and provider env', () => {
    const env = hiddenEvolutionWorkerEnv({
      MATOS_PROJECT_MEMBER_ID: 'agent-compute',
      MATOS_PROJECT_ORIGIN_ROLE_REF: 'role:compute',
      MATOS_PROJECT_WRITE_LOCK_HELD: 'session-1',
      MATOS_PROJECT_WRITE_LOCK_CWD: '/workspace/group/shared/mace',
      MATOS_PROJECT_ID: 'mace',
      MATOS_PROJECT_CWD: '/workspace/group/shared/mace',
      MATOS_USER_ID: 'frank',
      MATOS_SCOPE_ID: 'user:frank',
      MATOS_SESSION_DIR: '/workspace/state/sessions',
      DEEPSEEK_API_KEY: 'sk-worker-env-keep',
    })

    for (const key of HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
    // Scope, user, project identity, session dir, and provider credentials
    // must survive: scoped provider-profile resolution and monitor-record
    // routing legitimately depend on them.
    expect(env.MATOS_PROJECT_ID).toBe('mace')
    expect(env.MATOS_PROJECT_CWD).toBe('/workspace/group/shared/mace')
    expect(env.MATOS_USER_ID).toBe('frank')
    expect(env.MATOS_SCOPE_ID).toBe('user:frank')
    expect(env.MATOS_SESSION_DIR).toBe('/workspace/state/sessions')
    expect(env.DEEPSEEK_API_KEY).toBe('sk-worker-env-keep')
    expect(env.MATOS_INTERNAL_HIDDEN_RUN).toBe('1')
    expect(env.MATOS_BACKGROUND_EVOLUTION_WORKER).toBe('1')
  })

  test('typescript worker entrypoints only spawn under a bun runtime', () => {
    expect(
      evolutionWorkerEntrypointRunnableByRuntime(
        '/app/src/entrypoints/matos-evolution-worker.ts',
        { execPath: '/usr/bin/node', bunVersion: undefined },
      ),
    ).toBe(false)
    expect(
      evolutionWorkerEntrypointRunnableByRuntime(
        '/app/src/entrypoints/matos-evolution-worker.ts',
        { execPath: '/usr/local/bin/bun', bunVersion: undefined },
      ),
    ).toBe(true)
    expect(
      evolutionWorkerEntrypointRunnableByRuntime(
        '/app/dist/entrypoints/matos-evolution-worker.mjs',
        { execPath: '/usr/bin/node', bunVersion: undefined },
      ),
    ).toBe(true)
    // A bun runtime with an overridden execPath is still able to run .ts entries.
    expect(
      evolutionWorkerEntrypointRunnableByRuntime(
        '/app/src/entrypoints/matos-evolution-worker.ts',
        { execPath: '/tmp/fake-runtime.sh', bunVersion: '1.2.0' },
      ),
    ).toBe(true)
  })
})
