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

import { chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildEvolutionRoleCacheInfo,
  buildEvolutionRoleInvocation,
  evolutionProviderCredentialsPreflight,
  extractEvolutionRoleSdkResult,
  isEvolutionRoleAuthenticationFailure,
  isEvolutionRoleContextOverflowFailure,
  isEvolutionRoleQuotaFailure,
  isEvolutionRoleRateLimitFailure,
  pruneEvolutionCacheDirEntries,
  readCachedEvolutionRoleRun,
  resolveEvolutionRoleExecutionEnv,
  resolveEvolutionRoleModelEnv,
  roleModelId,
  runEvolutionRole,
  writeCachedEvolutionRoleRun,
} from './evolutionRoleRunner.js'

async function withFakeExecPath<T>(
  script: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'matos-fake-agent-runtime-'))
  const runtime = join(dir, 'fake-runtime.sh')
  await writeFile(runtime, script)
  await chmod(runtime, 0o755)
  const originalExecPath = process.execPath
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: runtime,
  })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: originalExecPath,
    })
  }
}

function sdkResultLine(result: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', is_error: false, ...result })
}

const EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS = 15_000

describe('MatOS evolution role runner', () => {
  test('does not treat quoted trajectory authentication errors as provider failures after a successful role run', () => {
    expect(
      isEvolutionRoleAuthenticationFailure({
        exitCode: 0,
        resultText:
          '{"shouldUseFeedback":true,"summary":"The source task returned 401 authentication failed"}',
        stdout:
          '{"type":"result","result":"critic accepted the credential failure as evidence"}',
        stderr: '',
      }),
    ).toBe(false)

    expect(
      isEvolutionRoleAuthenticationFailure({
        exitCode: 1,
        resultText: 'Failed to authenticate. API Error: 401',
        stdout: '',
        stderr: '',
      }),
    ).toBe(true)
  })

  test('classifies provider context-length 400s as overflow, not authentication failure', () => {
    const overflowResult = {
      exitCode: 1,
      resultText:
        'API Error: 400 {"error":{"message":"This model\'s maximum context length is 1048565 tokens. However, you requested 3425297 tokens (3393297 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      stdout: '',
      stderr: '',
    }

    // Real users hit this exact provider 400 in long sessions; classifying it
    // as an auth failure skipped the deterministic fallback and permanently
    // failed every later trigger with a misleading summary.
    expect(isEvolutionRoleAuthenticationFailure(overflowResult)).toBe(false)
    expect(isEvolutionRoleContextOverflowFailure(overflowResult)).toBe(true)

    expect(
      isEvolutionRoleContextOverflowFailure({
        exitCode: 0,
        resultText: 'maximum context length quoted from evidence',
        stdout: '',
        stderr: '',
      }),
    ).toBe(false)
  })

  test('classifies provider 402 insufficient balance as quota failure, not authentication', () => {
    // Real 2026-07-14 production shape: DeepSeek returned 402 Insufficient
    // Balance with code invalid_request_error, and the old classifier reported
    // it as "could not authenticate", pointing operators at credentials
    // instead of billing.
    const quotaResult = {
      exitCode: 1,
      resultText:
        'API Error: 402 {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
      stdout: '',
      stderr: '',
    }
    expect(isEvolutionRoleQuotaFailure(quotaResult)).toBe(true)
    expect(isEvolutionRoleAuthenticationFailure(quotaResult)).toBe(false)
    expect(isEvolutionRoleContextOverflowFailure(quotaResult)).toBe(false)

    expect(
      isEvolutionRoleQuotaFailure({
        exitCode: 1,
        resultText:
          'API Error: 429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}',
        stdout: '',
        stderr: '',
      }),
    ).toBe(true)

    // A successful critic run may quote balance failures from the trajectory
    // it is analyzing; that is evidence, not a provider failure.
    expect(
      isEvolutionRoleQuotaFailure({
        exitCode: 0,
        resultText:
          '{"shouldUseFeedback":true,"summary":"the tool call failed with API Error: 402 Insufficient Balance"}',
        stdout: '',
        stderr: '',
      }),
    ).toBe(false)
  })

  test('defaults pure hidden evolution roles to the configured fast model', () => {
    const env = {
      MATOS_DSH_MODEL: 'deepseek-pro',
      MATOS_EVOLUTION_FAST_MODEL: 'deepseek-flash',
    }
    const modelEnv = resolveEvolutionRoleModelEnv({
      roleReference: 'role:user-feedback-critic',
      env,
    })

    expect(modelEnv).toEqual({ MATOS_DSH_MODEL: 'deepseek-flash' })
    expect(roleModelId({ ...env, ...modelEnv })).toBe('deepseek-flash')
  })

  test('does not downgrade stateful direct editor roles to the fast model', () => {
    const env = {
      MATOS_DSH_MODEL: 'deepseek-pro',
      MATOS_EVOLUTION_FAST_MODEL: 'deepseek-flash',
    }

    expect(
      resolveEvolutionRoleModelEnv({
        roleReference: 'role:direct-asset-editor',
        env,
      }),
    ).toEqual({})
  })

  test('lets explicit evolution role model overrides win over the fast default', () => {
    const env = {
      MATOS_DSH_MODEL: 'deepseek-pro',
      MATOS_EVOLUTION_FAST_MODEL: 'deepseek-flash',
      MATOS_EVOLUTION_ROLE_MODEL: 'deepseek-pro-explicit',
    }

    expect(
      resolveEvolutionRoleModelEnv({
        roleReference: 'role:user-feedback-critic',
        env,
      }),
    ).toEqual({ MATOS_DSH_MODEL: 'deepseek-pro-explicit' })
  })

  test('respects per-invocation trace model overrides', () => {
    const env = {
      MATOS_DSH_MODEL: 'deepseek-pro',
      MATOS_EVOLUTION_FAST_MODEL: 'deepseek-flash',
    }

    expect(
      resolveEvolutionRoleModelEnv({
        roleReference: 'role:user-feedback-critic',
        env,
        traceEnv: { MATOS_DSH_MODEL: 'deepseek-pro' },
      }),
    ).toEqual({})
  })

  test('passes the resolved fast model as a startup --model override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-fast-model-'))
    const previous = {
      MATOS_DSH_MODEL: process.env.MATOS_DSH_MODEL,
      MATOS_EVOLUTION_ROLE_MODEL: process.env.MATOS_EVOLUTION_ROLE_MODEL,
      MATOS_EVOLUTION_FAST_MODEL: process.env.MATOS_EVOLUTION_FAST_MODEL,
    }
    process.env.MATOS_DSH_MODEL = 'deepseek-pro'
    process.env.MATOS_EVOLUTION_FAST_MODEL = 'deepseek-flash'
    delete process.env.MATOS_EVOLUTION_ROLE_MODEL
    try {
      const invocation = await buildEvolutionRoleInvocation({
        cwd: root,
        role: 'user-feedback-critic',
        prompt: 'Return JSON only.',
        jobId: 'job-fast-model-startup-override',
        hidden: true,
        maxTurns: 1,
      })

      expect(invocation.env.MATOS_DSH_MODEL).toBe('deepseek-flash')
      expect(invocation.agentArgs).toContain('--model')
      expect(invocation.agentArgs[invocation.agentArgs.indexOf('--model') + 1])
        .toBe('deepseek-flash')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('extracts usage and cost from SDK result messages for hidden cost ledgering', () => {
    const result = extractEvolutionRoleSdkResult({
      type: 'result',
      subtype: 'success',
      session_id: 'hidden-session-1',
      result: '{"ok":true}',
      total_cost_usd: 0.042,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 30,
      },
      modelUsage: {
        'deepseek-v4-pro': {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          webSearchRequests: 0,
          costUSD: 0.042,
        },
      },
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
    })

    expect(result).toMatchObject({
      resultText: '{"ok":true}',
      upstreamSessionId: 'hidden-session-1',
      totalCostUsd: 0.042,
      durationMs: 1200,
      durationApiMs: 1100,
      numTurns: 1,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 30,
      },
    })
    expect(result?.modelUsage).toEqual({
      'deepseek-v4-pro': {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 30,
        webSearchRequests: 0,
        costUSD: 0.042,
      },
    })
  })

  test('redacts secret-like content before persisting the role-run cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-cache-redact-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for redaction test.',
      jobId: 'job-redact',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const cache = await buildEvolutionRoleCacheInfo({ invocation, source })
    expect(cache).toBeDefined()
    const secret = 'sk-ABCDEFGHIJKLMNOP1234567890'
    await writeCachedEvolutionRoleRun({
      cwd: root,
      cache: cache!,
      result: {
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        resultText: `token ${secret}`,
        parsedResult: { note: `token ${secret}` },
        stdout: `stdout ${secret}`,
        stderr: `stderr ${secret}`,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 3,
        },
        totalCostUsd: 0.001,
      },
    })
    const raw = await readFile(join(root, cache!.path), 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).toContain('[redacted]')
    const cached = await readCachedEvolutionRoleRun({ cwd: root, cache: cache! })
    expect(JSON.stringify(cached?.parsedResult)).not.toContain(secret)
    expect(cached?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
    })
    expect(cached?.totalCostUsd).toBe(0.001)
  })

  test('builds a direct asset editor invocation through existing MatOS run projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-'))
    const invocation = await buildEvolutionRoleInvocation({
      cwd: root,
      role: 'direct-asset-editor',
      prompt: 'Return compact JSON with keys: summary, modifiedFiles.',
      jobId: 'job-direct-editor-test',
      hidden: true,
      traceEnv: {
        MATOS_TRACE_ID: 'trace-role-test',
        MATOS_PARENT_SESSION_ID: 'session-parent-test',
      },
    })

    expect(invocation.roleReference).toBe('role:direct-asset-editor')
    expect(invocation.args).toContain('--output-format')
    expect(invocation.args).toContain('stream-json')
    expect(invocation.args).toContain('--no-session-persistence')
    expect(invocation.env.MATOS_EVOLUTION_JOB_ID).toBe('job-direct-editor-test')
    expect(invocation.env.MATOS_TRACE_ID).toBe('trace-role-test')
    expect(invocation.args[0]).toEndWith('/src/entrypoints/agent.ts')
    expect(invocation.env.NODE_ENV).toBeUndefined()
  })

  test('marks hidden evolution role invocations as non-persistent hidden runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-hidden-'))
    const invocation = await buildEvolutionRoleInvocation({
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only.',
      jobId: 'job-user-feedback-critic-hidden',
      hidden: true,
    })

    expect(invocation.roleReference).toBe('role:user-feedback-critic')
    expect(invocation.args).toContain('--no-session-persistence')
    expect(invocation.env.MATOS_INTERNAL_HIDDEN_RUN).toBe('1')
    expect(invocation.env.MATOS_ALGO_TELEMETRY).toBe('0')
    expect(invocation.env.MATOS_ALGO_CAPTURE).toBe('0')
  })

  test('does not bind hidden evolution workers to the visible project member roster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-project-'))
    const criticDir = join(
      root,
      '.matos',
      'assets',
      'roles',
      'user-feedback-critic',
    )
    await mkdir(criticDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(root, '.matos', 'project.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        id: 'hidden-evolution-project',
        name: 'Hidden evolution project',
        team: [
          { roleRef: 'role:compute@1.0.0', memberId: 'agent-compute' },
        ],
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(criticDir, 'asset.json'),
      `${JSON.stringify({
        id: 'user-feedback-critic',
        type: 'role',
        name: 'User feedback critic',
        version: '1.0.0',
        entry: 'prompt.md',
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(criticDir, 'prompt.md'),
      'Evaluate user feedback and return JSON only.\n',
      'utf8',
    )

    const invocation = await buildEvolutionRoleInvocation({
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only.',
      jobId: 'job-hidden-project-critic',
      hidden: true,
      maxTurns: 1,
    })

    expect(invocation.roleReference).toBe('role:user-feedback-critic')
    expect(invocation.env.MATOS_INTERNAL_HIDDEN_RUN).toBe('1')
    expect(invocation.agentArgs).not.toContain('--settings')
  })

  test('strips inherited project member binding from hidden stage env that the project gate rejects', async () => {
    // Reproduces the recorded production session shape: cwd inside a project
    // whose roster binds agent-compute to role:compute, with the session's
    // member binding exported in env. The visible role-launch path rejects the
    // internal critic role with the exact recorded errors; the hidden stage
    // invocation must build and must not forward the member binding.
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-member-gate-'))
    const criticDir = join(
      root,
      '.matos',
      'assets',
      'roles',
      'user-feedback-critic',
    )
    await mkdir(criticDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(root, '.matos', 'project.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        id: 'member-gate-project',
        name: 'Member gate project',
        team: [
          { roleRef: 'role:compute@1.0.0', memberId: 'agent-compute' },
        ],
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(criticDir, 'asset.json'),
      `${JSON.stringify({
        id: 'user-feedback-critic',
        type: 'role',
        name: 'User feedback critic',
        version: '1.0.0',
        entry: 'prompt.md',
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(criticDir, 'prompt.md'),
      'Evaluate user feedback and return JSON only.\n',
      'utf8',
    )

    const previous = {
      MATOS_PROJECT_MEMBER_ID: process.env.MATOS_PROJECT_MEMBER_ID,
      MATOS_PROJECT_ORIGIN_ROLE_REF: process.env.MATOS_PROJECT_ORIGIN_ROLE_REF,
      MATOS_PROJECT_WRITE_LOCK_HELD: process.env.MATOS_PROJECT_WRITE_LOCK_HELD,
      MATOS_PROJECT_WRITE_LOCK_CWD: process.env.MATOS_PROJECT_WRITE_LOCK_CWD,
      MATOS_RUNTIME_DATA_DIR: process.env.MATOS_RUNTIME_DATA_DIR,
    }
    process.env.MATOS_PROJECT_MEMBER_ID = 'agent-compute'
    process.env.MATOS_PROJECT_ORIGIN_ROLE_REF = 'role:compute'
    process.env.MATOS_PROJECT_WRITE_LOCK_HELD = 'session-parent'
    process.env.MATOS_PROJECT_WRITE_LOCK_CWD = root
    process.env.MATOS_RUNTIME_DATA_DIR = join(root, 'runtime')
    try {
      // Production family 1a: inherited member binding rejects the critic.
      await expect(
        buildEvolutionRoleInvocation({
          cwd: root,
          role: 'user-feedback-critic',
          prompt: 'Return JSON only.',
          jobId: 'job-member-gate-visible',
          maxTurns: 1,
        }),
      ).rejects.toThrow(
        "MatOS project member 'agent-compute' is not bound to role:user-feedback-critic",
      )

      const invocation = await buildEvolutionRoleInvocation({
        cwd: root,
        role: 'user-feedback-critic',
        prompt: 'Return JSON only.',
        jobId: 'job-member-gate-hidden',
        hidden: true,
        maxTurns: 1,
        traceEnv: { MATOS_SCOPE_REF: 'user:member-gate' },
      })
      expect(invocation.roleReference).toBe('role:user-feedback-critic')
      expect(invocation.env.MATOS_PROJECT_MEMBER_ID).toBeUndefined()
      expect(invocation.env.MATOS_PROJECT_ORIGIN_ROLE_REF).toBeUndefined()
      expect(invocation.env.MATOS_PROJECT_WRITE_LOCK_HELD).toBeUndefined()
      expect(invocation.env.MATOS_PROJECT_WRITE_LOCK_CWD).toBeUndefined()
      // Scope env survives for scoped provider/profile resolution.
      expect(invocation.env.MATOS_SCOPE_REF).toBe('user:member-gate')

      // Production family 1b: without a member id the roster gate still
      // rejects the non-member internal role on the visible path.
      delete process.env.MATOS_PROJECT_MEMBER_ID
      await expect(
        buildEvolutionRoleInvocation({
          cwd: root,
          role: 'user-feedback-critic',
          prompt: 'Return JSON only.',
          jobId: 'job-member-gate-visible-no-member',
          maxTurns: 1,
        }),
      ).rejects.toThrow(
        "MatOS role is not a member of project 'member-gate-project': role:user-feedback-critic",
      )
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('provider credentials preflight reports a machine-readable reason without leaking secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-preflight-'))
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
    }

    const missing = await evolutionProviderCredentialsPreflight({
      cwd: root,
      env: baseEnv,
    })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('provider_credentials_unavailable')

    const secret = 'sk-preflight-valid-003'
    const available = await evolutionProviderCredentialsPreflight({
      cwd: root,
      env: {
        ...baseEnv,
        DEEPSEEK_BASE_URL: 'https://deployment.example/anthropic',
        DEEPSEEK_API_KEY: secret,
        MATOS_DSH_MODEL: 'deployment-model',
      },
    })
    expect(available.ok).toBe(true)
    expect(available.reason).toBeUndefined()
    // The preflight result is written into monitor records: presence metadata
    // only, never secret values.
    expect(JSON.stringify(missing)).not.toContain(secret)
    expect(JSON.stringify(available)).not.toContain(secret)

    // An empty-string secret is a missing credential, not a usable one.
    const emptySecret = await evolutionProviderCredentialsPreflight({
      cwd: root,
      env: {
        ...baseEnv,
        DEEPSEEK_BASE_URL: 'https://deployment.example/anthropic',
        DEEPSEEK_API_KEY: '   ',
      },
    })
    expect(emptySecret.ok).toBe(false)
    expect(emptySecret.reason).toBe('provider_credentials_unavailable')
  })

  test('passes scoped permission args to hidden direct editor invocations before the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-scoped-'))
    const invocation = await buildEvolutionRoleInvocation({
      cwd: root,
      role: 'direct-asset-editor',
      prompt: 'Return JSON only.',
      jobId: 'job-direct-editor-scoped',
      hidden: true,
      extraArgs: [
        '--permission-mode',
        'dontAsk',
        '--allowed-tools',
        'Read(/tmp/matos-direct-editor-scope/**),Write(/tmp/matos-direct-editor-scope/**)',
      ],
    })

    expect(invocation.agentArgs).toContain('--permission-mode')
    expect(invocation.agentArgs).toContain('dontAsk')
    expect(invocation.agentArgs).toContain('--allowed-tools')
    expect(invocation.agentArgs).toContain(
      'Read(/tmp/matos-direct-editor-scope/**),Write(/tmp/matos-direct-editor-scope/**)',
    )
    expect(invocation.agentArgs).not.toContain('--dangerously-skip-permissions')
    expect(invocation.agentArgs.indexOf('--allowed-tools')).toBeLessThan(
      invocation.agentArgs.indexOf('-p'),
    )
  })

  test('materializes long evolution prompts to a file to avoid argv limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-long-prompt-'))
    const prompt = `Return JSON only.\\n${'full trace event '.repeat(12000)}`
    const invocation = await buildEvolutionRoleInvocation({
      cwd: root,
      role: 'user-feedback-critic',
      prompt,
      jobId: 'job-long-prompt',
      hidden: true,
    })

    expect(invocation.args).not.toContain(prompt)
    const promptFile = invocation.args.find(arg =>
      arg.includes('evolution-prompt-'),
    )
    expect(promptFile).toBeString()
    expect(await readFile(promptFile!, 'utf8')).toContain('full trace event')
    expect(invocation.args.at(-2)).toBe('-p')
    expect(invocation.args.at(-1)).toContain('MatOS evolution task context')
  })

  test('reuses cached pure evolution role results without spawning another LLM run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-cache-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for cache test.',
      jobId: 'job-user-feedback-critic-cache',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const cache = await buildEvolutionRoleCacheInfo({ invocation, source })

    expect(cache).toBeDefined()
    const cachePath = join(root, cache!.path)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          cache,
          result: {
            exitCode: 0,
            roleReference: 'role:user-feedback-critic',
            resultText: '{"shouldWrite":false,"reason":"cached"}',
            parsedResult: { shouldWrite: false, reason: 'cached' },
            stdout: '',
            stderr: '',
          },
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const result = await runEvolutionRole(source)

    expect(result.exitCode).toBe(0)
    expect(result.parsedResult).toEqual({ shouldWrite: false, reason: 'cached' })
    expect(result.cache?.hit).toBe(true)
    expect(result.cache?.key).toBe(cache!.key)
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('ignores expired evolution role cache entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-cache-ttl-'))
    const previousTtl = process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
    process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = '1000'
    try {
      const source = {
        cwd: root,
        role: 'user-feedback-critic',
        prompt: 'Return JSON only for cache ttl test.',
        jobId: 'job-user-feedback-critic-cache-ttl',
        hidden: true,
        maxTurns: 2,
      }
      const invocation = await buildEvolutionRoleInvocation(source)
      const cache = await buildEvolutionRoleCacheInfo({ invocation, source })
      expect(cache).toBeDefined()
      const cachePath = join(root, cache!.path)
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(
        cachePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            cache,
            result: {
              exitCode: 0,
              roleReference: 'role:user-feedback-critic',
              resultText: '{"shouldWrite":false,"reason":"stale"}',
              parsedResult: { shouldWrite: false, reason: 'stale' },
              stdout: '',
              stderr: '',
            },
            createdAt: new Date(Date.now() - 60_000).toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const cached = await readCachedEvolutionRoleRun({ cwd: root, cache: cache! })
      expect(cached).toBeUndefined()
    } finally {
      if (previousTtl === undefined) {
        delete process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
      } else {
        process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = previousTtl
      }
    }
  })

  test('reuses cached empty pure role results so invalid LLM output is not retried forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-empty-cache-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for empty cache test.',
      jobId: 'job-feedback-critic-empty-cache',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const cache = await buildEvolutionRoleCacheInfo({ invocation, source })

    expect(cache).toBeDefined()
    const cachePath = join(root, cache!.path)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          cache,
          result: {
            exitCode: 0,
            roleReference: 'role:user-feedback-critic',
            stdout: '',
            stderr: '',
          },
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const result = await runEvolutionRole(source)

    expect(result.exitCode).toBe(0)
    expect(result.resultText).toBeUndefined()
    expect(result.parsedResult).toBeUndefined()
    expect(result.cache?.hit).toBe(true)
    expect(result.cache?.key).toBe(cache!.key)
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('reuses manually seeded failed role cache entries on read without spawning another LLM run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-failed-cache-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for failed cache test.',
      jobId: 'job-feedback-critic-failed-cache',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const cache = await buildEvolutionRoleCacheInfo({ invocation, source })

    expect(cache).toBeDefined()
    const cachePath = join(root, cache!.path)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          cache,
          result: {
            exitCode: 1,
            roleReference: 'role:user-feedback-critic',
            stdout: '',
            stderr: 'cached failure',
          },
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const result = await runEvolutionRole(source)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('cached failure')
    expect(result.cache?.hit).toBe(true)
    expect(result.cache?.key).toBe(cache!.key)
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('does not cache direct asset editor invocations because they edit files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-no-cache-'))
    const source = {
      cwd: root,
      role: 'direct-asset-editor',
      prompt: 'Return JSON only.',
      jobId: 'job-direct-editor-no-cache',
      hidden: true,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const cache = await buildEvolutionRoleCacheInfo({ invocation, source })

    expect(cache).toBeUndefined()
  })

  test('separates pure role caches by provider endpoint and secret fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-provider-cache-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for provider cache test.',
      jobId: 'job-feedback-critic-provider-cache',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const first = await buildEvolutionRoleCacheInfo({
      invocation: {
        ...invocation,
        env: {
          ...invocation.env,
          DEEPSEEK_BASE_URL: 'https://provider-a.example/anthropic',
          DEEPSEEK_API_KEY: 'sk-provider-a',
        },
      },
      source,
    })
    const second = await buildEvolutionRoleCacheInfo({
      invocation: {
        ...invocation,
        env: {
          ...invocation.env,
          DEEPSEEK_BASE_URL: 'https://provider-a.example/anthropic',
          DEEPSEEK_API_KEY: 'sk-provider-b',
        },
      },
      source,
    })
    const third = await buildEvolutionRoleCacheInfo({
      invocation: {
        ...invocation,
        env: {
          ...invocation.env,
          DEEPSEEK_BASE_URL: 'https://provider-c.example/anthropic',
          DEEPSEEK_API_KEY: 'sk-provider-b',
        },
      },
      source,
    })

    expect(first?.key).toBeString()
    expect(second?.key).toBeString()
    expect(third?.key).toBeString()
    expect(first?.key).not.toBe(second?.key)
    expect(second?.key).not.toBe(third?.key)
  })

  test('uses stable cache material so descriptive prompt wording does not break pure role cache hits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-material-cache-'))
    const baseSource = {
      cwd: root,
      role: 'user-feedback-critic',
      jobId: 'job-feedback-critic-material-cache',
      hidden: true,
      maxTurns: 2,
      cacheKeyMaterial: {
        cacheVersion: 'test-v1',
        session: { sessionId: 'real-session', eventCount: 756 },
        trajectoryDigest: 'same-real-trajectory',
      },
    }
    const firstSource = {
      ...baseSource,
      prompt: 'Analyze this session. Trigger summary: critic-only.',
    }
    const secondSource = {
      ...baseSource,
      prompt: 'Analyze this session. Trigger summary: full self-evolution.',
    }
    const thirdSource = {
      ...baseSource,
      prompt: secondSource.prompt,
      cacheKeyMaterial: {
        ...baseSource.cacheKeyMaterial,
        trajectoryDigest: 'changed-real-trajectory',
      },
    }

    const invocation = await buildEvolutionRoleInvocation(firstSource)
    const first = await buildEvolutionRoleCacheInfo({
      invocation,
      source: firstSource,
    })
    const second = await buildEvolutionRoleCacheInfo({
      invocation: {
        ...invocation,
        agentArgs: invocation.agentArgs.map(arg =>
          arg === firstSource.prompt ? secondSource.prompt : arg,
        ),
      },
      source: secondSource,
    })
    const third = await buildEvolutionRoleCacheInfo({
      invocation: {
        ...invocation,
        agentArgs: invocation.agentArgs.map(arg =>
          arg === firstSource.prompt ? thirdSource.prompt : arg,
        ),
      },
      source: thirdSource,
    })

    expect(first?.key).toBeString()
    expect(first?.key).toBe(second?.key)
    expect(third?.key).not.toBe(first?.key)
  })

  test('classifies 429/529 rate-limit and overloaded errors as retryable, not auth or quota', () => {
    const rateLimited = {
      exitCode: 1,
      resultText:
        'API Error: 429 {"error":{"type":"rate_limit_error","message":"Rate limited"}}',
      stdout: '',
      stderr: '',
    }
    expect(isEvolutionRoleRateLimitFailure(rateLimited)).toBe(true)
    expect(isEvolutionRoleAuthenticationFailure(rateLimited)).toBe(false)
    expect(isEvolutionRoleQuotaFailure(rateLimited)).toBe(false)

    expect(
      isEvolutionRoleRateLimitFailure({
        exitCode: 1,
        resultText:
          'API Error: 529 {"error":{"type":"overloaded_error","message":"Overloaded"}}',
        stdout: '',
        stderr: '',
      }),
    ).toBe(true)

    // Success output quoting rate limits is trajectory evidence, not a failure.
    expect(
      isEvolutionRoleRateLimitFailure({
        exitCode: 0,
        resultText: 'the trajectory shows API Error: 429 rate_limit_error',
        stdout: '',
        stderr: '',
      }),
    ).toBe(false)

    // Billing-quota 429s stay in the quota class so they are not retried.
    const quota429 = {
      exitCode: 1,
      resultText:
        'API Error: 429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}',
      stdout: '',
      stderr: '',
    }
    expect(isEvolutionRoleRateLimitFailure(quota429)).toBe(false)
    expect(isEvolutionRoleQuotaFailure(quota429)).toBe(true)
  })

  test('settles a JSON-only role as success when the result-close SIGTERM ends the child', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-evolution-role-result-close-'),
    )
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' '${sdkResultLine({ result: '{"ok":true}' })}'`,
      'exec sleep 30',
      '',
    ].join('\n')
    const result = await withFakeExecPath(script, () =>
      runEvolutionRole({
        cwd: root,
        role: 'self-evolution-worker',
        prompt: 'Return JSON only.',
        jobId: 'job-result-close-success',
        hidden: true,
        maxTurns: 1,
      }),
    )
    expect(result.resultText).toBe('{"ok":true}')
    expect(result.parsedResult).toEqual({ ok: true })
    // The runner killed a hung child after a valid result; the SIGTERM death
    // exit code must not overwrite the model verdict.
    expect(result.exitCode).toBe(0)
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('preserves the parsed result and usage when the role run hits the main timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-timeout-'))
    const previousTimeout = process.env.MATOS_EVOLUTION_ROLE_TIMEOUT_MS
    process.env.MATOS_EVOLUTION_ROLE_TIMEOUT_MS = '2000'
    try {
      const script = [
        '#!/bin/sh',
        `printf '%s\\n' '${sdkResultLine({
          result: '{"verdict":"accept"}',
          usage: {
            input_tokens: 11,
            output_tokens: 3,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
          },
          total_cost_usd: 0.012,
        })}'`,
        'exec sleep 30',
        '',
      ].join('\n')
      const result = await withFakeExecPath(script, () =>
        runEvolutionRole({
          cwd: root,
          // Not a JSON-only role: no result-close shortcut, so the run must
          // hit the timeout while a complete result already streamed.
          role: 'semantic-acceptance-judge',
          prompt: 'Return JSON only.',
          jobId: 'job-timeout-keeps-result',
          hidden: true,
          maxTurns: 1,
        }),
      )
      expect(result.exitCode).toBe(1)
      expect(result.timedOut).toBe(true)
      expect(result.stderr).toContain('timed out')
      expect(result.resultText).toBe('{"verdict":"accept"}')
      expect(result.parsedResult).toEqual({ verdict: 'accept' })
      expect(result.usage).toEqual({
        input_tokens: 11,
        output_tokens: 3,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2,
      })
      expect(result.totalCostUsd).toBe(0.012)
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.MATOS_EVOLUTION_ROLE_TIMEOUT_MS
      } else {
        process.env.MATOS_EVOLUTION_ROLE_TIMEOUT_MS = previousTimeout
      }
    }
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('cleans up materialized prompt and cli-arg files after the role run settles', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-evolution-role-material-cleanup-'),
    )
    const prompt = `Return JSON only.\n${'evolution evidence line '.repeat(1000)}`
    expect(prompt.length).toBeGreaterThan(16_000)
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' '${sdkResultLine({ result: '{"ok":true}' })}'`,
      'exit 0',
      '',
    ].join('\n')
    const result = await withFakeExecPath(script, () =>
      runEvolutionRole({
        cwd: root,
        role: 'self-evolution-worker',
        prompt,
        jobId: 'job-material-cleanup',
        hidden: true,
        maxTurns: 1,
      }),
    )
    expect(result.exitCode).toBe(0)
    // The long prompt was materialized under .matos/runtime/cli-args; nothing
    // may remain there (prompt file or projection cli-arg files) after settle.
    const leftovers = await readdir(
      join(root, '.matos', 'runtime', 'cli-args'),
    ).catch(() => [] as string[])
    expect(leftovers).toEqual([])
  }, EVOLUTION_ROLE_REAL_ASSET_TIMEOUT_MS)

  test('writes role cache entries atomically and throttles prune scans between writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-prune-'))
    const previousTtl = process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
    process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = '60000'
    try {
      const sourceA = {
        cwd: root,
        role: 'user-feedback-critic',
        prompt: 'Return JSON A.',
        jobId: 'job-prune-a',
        hidden: true,
        maxTurns: 2,
      }
      const sourceB = { ...sourceA, prompt: 'Return JSON B.', jobId: 'job-prune-b' }
      const invocationA = await buildEvolutionRoleInvocation(sourceA)
      const cacheA = await buildEvolutionRoleCacheInfo({
        invocation: invocationA,
        source: sourceA,
      })
      const invocationB = await buildEvolutionRoleInvocation(sourceB)
      const cacheB = await buildEvolutionRoleCacheInfo({
        invocation: invocationB,
        source: sourceB,
      })
      expect(cacheA).toBeDefined()
      expect(cacheB).toBeDefined()
      const roleResult = {
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        resultText: '{"ok":true}',
        parsedResult: { ok: true },
        stdout: '',
        stderr: '',
      }
      // First write stamps the prune throttle for this cache directory.
      await writeCachedEvolutionRoleRun({
        cwd: root,
        cache: cacheA!,
        result: roleResult,
      })
      const cacheDir = join(root, '.matos', 'evolution', 'role-run-cache')
      const expiredPath = join(cacheDir, 'role-expired-entry.json')
      await writeFile(
        expiredPath,
        `${JSON.stringify({ schemaVersion: 1, createdAt: new Date(0).toISOString() })}\n`,
        'utf8',
      )
      await writeCachedEvolutionRoleRun({
        cwd: root,
        cache: cacheB!,
        result: roleResult,
      })
      const entries = (await readdir(cacheDir)).sort()
      // Atomic rename leaves no temp files behind.
      expect(entries.filter(entry => entry.includes('.tmp'))).toEqual([])
      // The expired entry survives the second write because the prune scan is
      // throttled after the first write stamped this directory.
      expect(entries).toContain('role-expired-entry.json')
      expect(entries).toContain(`${cacheA!.key}.json`)
      expect(entries).toContain(`${cacheB!.key}.json`)
    } finally {
      if (previousTtl === undefined) {
        delete process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
      } else {
        process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = previousTtl
      }
    }
  })

  test('cache dir prune removes expired json entries and aged writeFileAtomic tmp residue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matos-evolution-cache-prune-'))
    const expiredJson = join(dir, 'role-expired.json')
    const freshJson = join(dir, 'role-fresh.json')
    // Crash residue from writeFileAtomic (writer died between write and
    // rename); these names never end in .json, so the old prune kept them
    // forever.
    const agedTmp = join(dir, 'role-crashed.json.00000000-0000-0000-0000-000000000000.tmp')
    const freshTmp = join(dir, 'role-inflight.json.11111111-1111-1111-1111-111111111111.tmp')
    await writeFile(
      expiredJson,
      `${JSON.stringify({ schemaVersion: 1, createdAt: new Date(0).toISOString() })}\n`,
      'utf8',
    )
    await writeFile(
      freshJson,
      `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    await writeFile(agedTmp, '{', 'utf8')
    await writeFile(freshTmp, '{', 'utf8')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(agedTmp, old, old)

    await pruneEvolutionCacheDirEntries(dir)

    const names = (await readdir(dir)).sort()
    expect(names).toEqual([
      'role-fresh.json',
      'role-inflight.json.11111111-1111-1111-1111-111111111111.tmp',
    ])
  })

  test('fingerprints every value of multi-value path options so tmp paths cannot break cache hits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-role-multi-path-'))
    const source = {
      cwd: root,
      role: 'user-feedback-critic',
      prompt: 'Return JSON only for the multi path test.',
      jobId: 'job-multi-path',
      hidden: true,
      maxTurns: 2,
    }
    const invocation = await buildEvolutionRoleInvocation(source)
    const writeConfig = async (name: string, content: string) => {
      const path = join(root, name)
      await writeFile(path, content, 'utf8')
      return path
    }
    // Same contents under run-unique tmp-style names, plus one changed config.
    const firstA = await writeConfig('mcp-11111111.json', '{"mcpServers":{"a":{}}}')
    const firstB = await writeConfig('mcp-22222222.json', '{"mcpServers":{"b":{}}}')
    const secondA = await writeConfig('mcp-33333333.json', '{"mcpServers":{"a":{}}}')
    const secondB = await writeConfig('mcp-44444444.json', '{"mcpServers":{"b":{}}}')
    const changedB = await writeConfig(
      'mcp-55555555.json',
      '{"mcpServers":{"changed":{}}}',
    )
    const withMcpConfigs = (values: string[]) => ({
      ...invocation,
      agentArgs: ['--mcp-config', ...values, ...invocation.agentArgs],
    })
    const first = await buildEvolutionRoleCacheInfo({
      invocation: withMcpConfigs([firstA, firstB]),
      source,
    })
    const second = await buildEvolutionRoleCacheInfo({
      invocation: withMcpConfigs([secondA, secondB]),
      source,
    })
    const third = await buildEvolutionRoleCacheInfo({
      invocation: withMcpConfigs([secondA, changedB]),
      source,
    })
    expect(first?.key).toBeString()
    // Identical contents at different paths must produce the same key.
    expect(first?.key).toBe(second?.key)
    // Changing the content of a trailing value must change the key.
    expect(third?.key).not.toBe(first?.key)
  })
})
