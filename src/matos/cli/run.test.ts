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

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildMatOSChildEnv,
  buildMatOSRunInvocation,
  cleanupMatOSRunInvocationMaterialization,
  getSdkFailureText,
  isHiddenMatOSRunEnv,
  MATOS_ASSET_LOADED_EVENT_LIMIT,
  matOSInvocationAssetTrace,
  matOSInvocationAssetTraceEnv,
  parseMatOSRunArgs,
  recordMatOSAssetLoadedEvents,
  recordSdkLine,
  runMatOSAgentTask,
  sdkMessageToMatOSEvents,
  sdkResultExitCodeFromLine,
  sdkRunCompletionSignalFromLine,
} from './run.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('matos run event mapping', () => {
  test('serializes selected and task-projected assets for per-turn traces', () => {
    const invocation = {
      selectedAssetKeys: [
        'role:compute@1.0.0',
        'knowledge:hpc-submit-runbook@1.0.0',
      ],
      projection: {
        assetEvents: [
          { type: 'selected' as const, assetKey: 'role:compute@1.0.0' },
          {
            type: 'projected' as const,
            assetKey: 'knowledge:hpc-submit-runbook@1.0.0',
            reason: 'relevant-knowledge',
          },
        ],
      },
    }
    const trace = matOSInvocationAssetTrace(invocation)
    const env = matOSInvocationAssetTraceEnv(invocation)

    expect(trace).toEqual({
      selectedAssetRefs: [
        'role:compute@1.0.0',
        'knowledge:hpc-submit-runbook@1.0.0',
      ],
      projectedAssets: [
        {
          assetRef: 'knowledge:hpc-submit-runbook@1.0.0',
          reason: 'relevant-knowledge',
        },
      ],
    })
    expect(JSON.parse(env.MATOS_PROJECTED_ASSETS!)).toEqual(
      trace.projectedAssets,
    )

    const [context] = sdkMessageToMatOSEvents(
      { type: 'system', subtype: 'init', model: 'deepseek-v4-flash' },
      trace,
    )
    expect(context?.data).toMatchObject(trace)
  })

  test('maps SDK system init messages to a turn-scoped context event', () => {
    const events = sdkMessageToMatOSEvents(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'upstream-session',
        cwd: '/workspace/group/project',
        model: 'deepseek-v4-flash',
        permissionMode: 'bypassPermissions',
        tools: ['Read', 'Bash'],
        mcp_servers: ['matos_asset'],
        slash_commands: ['init'],
        agents: ['compute'],
        skills: ['vasp'],
        plugins: ['matos'],
        uuid: 'system-init-uuid',
      },
      { turnId: 'turn-run-1' },
    )

    expect(events).toEqual([
      {
        type: 'matos.turn.context.assembled',
        traceContext: { turnId: 'turn-run-1' },
        data: {
          source: 'cmatos.sdk-stream',
          upstreamSessionId: 'upstream-session',
          uuid: 'system-init-uuid',
          cwd: '/workspace/group/project',
          model: 'deepseek-v4-flash',
          permissionMode: 'bypassPermissions',
          toolCount: 2,
          mcpClientCount: 1,
          commandCount: 1,
          agentCount: 1,
          skillCount: 1,
          pluginCount: 1,
        },
      },
    ])
  })

  test('overrides the session role on SDK events after a runtime role switch', () => {
    const events = sdkMessageToMatOSEvents(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'role switched' }],
        },
      },
      { turnId: 'turn-role-switch', roleRef: 'role:workflow-builder' },
    )

    expect(events).toEqual([
      {
        type: 'matos.agent.message',
        traceContext: {
          turnId: 'turn-role-switch',
          roleRef: 'role:workflow-builder',
        },
        data: {
          source: 'cmatos.sdk-stream',
          upstreamSessionId: undefined,
          uuid: undefined,
          contentBlockTypes: ['text'],
          textPreview: 'role switched',
          toolUses: [],
        },
      },
    ])
  })

  test('maps SDK user tool_result messages to completed tool events', () => {
    const events = sdkMessageToMatOSEvents(
      {
        type: 'user',
        session_id: 'upstream-session',
        uuid: 'user-tool-result-uuid',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'tool finished successfully',
              is_error: false,
            },
          ],
        },
        tool_use_result: { stdout: 'tool finished successfully' },
      },
      { turnId: 'turn-run-1' },
    )

    expect(events).toEqual([
      {
        type: 'matos.tool.call.completed',
        traceContext: { turnId: 'turn-run-1' },
        data: {
          source: 'cmatos.sdk-stream',
          upstreamSessionId: 'upstream-session',
          uuid: 'user-tool-result-uuid',
          toolUseId: 'toolu_1',
          isError: false,
          resultPreview: 'tool finished successfully',
        },
      },
    ])
  })

  test('can suppress SDK stream tool lifecycle events when child execution traces tools', () => {
    const events = sdkMessageToMatOSEvents(
      {
        type: 'assistant',
        session_id: 'upstream-session',
        uuid: 'assistant-tool-use-uuid',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'printf duplicate' },
            },
          ],
        },
      },
      { turnId: 'turn-run-1', includeToolLifecycle: false },
    )

    expect(events).toEqual([
      {
        type: 'matos.agent.message',
        traceContext: { turnId: 'turn-run-1' },
        data: {
          source: 'cmatos.sdk-stream',
          upstreamSessionId: 'upstream-session',
          uuid: 'assistant-tool-use-uuid',
          contentBlockTypes: ['tool_use'],
          textPreview: undefined,
          toolUses: [{ toolUseId: 'toolu_1', toolName: 'Bash' }],
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('printf duplicate')
  })

  test('maps stream-json SDK messages to MatOS events', () => {
    const events = sdkMessageToMatOSEvents({
      type: 'result',
      subtype: 'success',
      session_id: 'upstream-session',
      result: 'OK',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.0042,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 10,
      },
      modelUsage: {
        'deepseek-v4-pro': {
          inputTokens: 100,
          outputTokens: 20,
        },
      },
      permission_denials: [],
      uuid: 'result-uuid',
    })

    expect(events).toEqual([
      {
        type: 'matos.session.completed',
        data: {
          upstreamSessionId: 'upstream-session',
          result: 'OK',
          isError: false,
          durationMs: 10,
          numTurns: 1,
          totalCostUsd: 0.0042,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
          modelUsage: {
            'deepseek-v4-pro': {
              inputTokens: 100,
              outputTokens: 20,
            },
          },
        },
      },
    ])
  })

  test('treats successful result envelopes with error payloads as failed sessions', () => {
    const events = sdkMessageToMatOSEvents({
      type: 'result',
      subtype: 'success',
      session_id: 'upstream-session',
      result: '模型不存在',
      is_error: true,
      duration_ms: 5,
      num_turns: 1,
      total_cost_usd: 0,
    })

    expect(events).toEqual([
      {
        type: 'matos.session.failed',
        data: {
          upstreamSessionId: 'upstream-session',
          subtype: 'success',
          isError: true,
          errors: undefined,
          result: '模型不存在',
          source: 'cmatos.sdk-stream',
          totalCostUsd: 0,
        },
      },
    ])
  })

  test('passes through non-json child stdout lines instead of crashing trace recording', async () => {
    const recorded: unknown[] = []
    const record = await recordSdkLine(
      '您可以继续使用 MatOS',
      {
        record: async (event: unknown) => {
          recorded.push(event)
        },
      } as never,
    )

    expect(record).toEqual({ plainText: '您可以继续使用 MatOS' })
    expect(recorded).toEqual([])
  })

  test('returns a concise failure text for non-success SDK result envelopes', async () => {
    const recorded: unknown[] = []
    const record = await recordSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        session_id: 'upstream-session',
        is_error: true,
        errors: ['Reached maximum number of turns (4)'],
      }),
      {
        record: async (event: unknown) => {
          recorded.push(event)
        },
      } as never,
    )

    expect(record).toEqual({
      upstreamSessionId: 'upstream-session',
      failureText: 'MatOS run failed: Reached maximum number of turns (4)',
    })
    expect(recorded).toEqual([
      {
        type: 'matos.session.failed',
        data: {
          upstreamSessionId: 'upstream-session',
          subtype: 'error_max_turns',
          isError: true,
          errors: ['Reached maximum number of turns (4)'],
          result: undefined,
          source: 'cmatos.sdk-stream',
          totalCostUsd: 0,
        },
      },
    ])
  })

  test('returns full assistant text for progressive stdout streaming', async () => {
    const recorded: unknown[] = []
    const record = await recordSdkLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'upstream-session',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First part of the answer.' },
            { type: 'text', text: 'Second part of the answer.' },
          ],
        },
      }),
      {
        record: async (event: unknown) => {
          recorded.push(event)
        },
      } as never,
      { includeToolLifecycle: false },
    )

    expect(record.assistantText).toBe(
      'First part of the answer.\nSecond part of the answer.',
    )
    // The recorded trace event still stores only the bounded preview, not the
    // full streamed text.
    expect(recorded).toHaveLength(1)
  })

  test('returns token-level partial text for stream_event deltas without recording trace events', async () => {
    const recorded: unknown[] = []
    const recorder = {
      record: async (event: unknown) => {
        recorded.push(event)
      },
    } as never

    const first = await recordSdkLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      }),
      recorder,
    )
    const second = await recordSdkLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      }),
      recorder,
    )

    expect(first).toEqual({ partialText: 'Hel' })
    expect(second).toEqual({ partialText: 'lo' })
    // Token deltas must not flood the session/trace JSONL.
    expect(recorded).toEqual([])

    // Non-text deltas (such as tool input JSON) are ignored for streaming.
    const toolDelta = await recordSdkLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        },
      }),
      recorder,
    )
    expect(toolDelta).toEqual({})
    expect(recorded).toEqual([])
  })

  test('returns redacted tool progress text for headless run logs', async () => {
    const recorded: unknown[] = []
    const recorder = {
      record: async (event: unknown) => {
        recorded.push(event)
      },
    } as never

    const started = await recordSdkLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'upstream-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: {
                command: 'DEEPSEEK_API_KEY=secret-value python3 solve.py',
              },
            },
          ],
        },
      }),
      recorder,
      { includeToolLifecycle: false, includeToolProgress: true },
    )
    const completed = await recordSdkLine(
      JSON.stringify({
        type: 'user',
        session_id: 'upstream-session',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'finished with OPENAI_API_KEY=secret-value',
              is_error: false,
            },
          ],
        },
      }),
      recorder,
      { includeToolLifecycle: false, includeToolProgress: true },
    )

    expect(started.progressText).toContain('[MatOS] tool start Bash toolu_1')
    expect(started.progressText).toContain('DEEPSEEK_API_KEY=[redacted]')
    expect(completed.progressText).toContain('[MatOS] tool result toolu_1 ok')
    expect(completed.progressText).toContain('OPENAI_API_KEY=[redacted]')
    expect(recorded).toHaveLength(1)
  })

  test('run command uses a real child process contract without faking model output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-contract-'))
    expect(root).toContain('matos-run-contract-')
  })

  test('child process env exposes the local matos command and trace context', () => {
    const env = buildMatOSChildEnv(
      { PATH: '/usr/bin' },
      {
        MATOS_TRACE_ID: 'trace-child-1',
        MATOS_PARENT_SESSION_ID: 'session-parent',
      },
    )

    expect(env.PATH?.split(':')[0]).toMatch(/\/bin$/)
    expect(env.PATH).toContain('/usr/bin')
    expect(env.MATOS_TRACE_ID).toBe('trace-child-1')
    expect(env.MATOS_PARENT_SESSION_ID).toBe('session-parent')
    expect(env.MATOS_DISABLE_QUERYENGINE_TRACE_BRIDGE).toBe('1')
    expect(env.MATOS_DISABLE_CHILD_TURN_STARTED_TRACE).toBe('1')
  })

  test('detects hidden internal run env used by background evolution refiners', () => {
    expect(isHiddenMatOSRunEnv({ MATOS_INTERNAL_HIDDEN_RUN: '1' })).toBe(true)
    expect(isHiddenMatOSRunEnv({})).toBe(false)
  })

  test('parses optional role without changing task passthrough semantics', () => {
    expect(
      parseMatOSRunArgs(['--role', 'role:planner', 'screen materials', '--max-turns', '1']),
    ).toEqual({
      prompt: 'screen materials',
      role: 'role:planner',
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--max-turns', '1'],
    })

    expect(parseMatOSRunArgs(['screen materials', '--max-turns', '1'])).toEqual({
      prompt: 'screen materials',
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--max-turns', '1'],
    })

    expect(
      parseMatOSRunArgs(['--role', 'compute', '--max-turns', '1', 'screen materials']),
    ).toEqual({
      prompt: 'screen materials',
      role: 'compute',
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--max-turns', '1'],
    })

    expect(
      parseMatOSRunArgs([
        '--role',
        'compute',
        '--resume',
        '810dca51-ed45-4944-93e2-120d178632d4',
        'continue the project chat',
      ]),
    ).toEqual({
      prompt: 'continue the project chat',
      role: 'compute',
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--resume', '810dca51-ed45-4944-93e2-120d178632d4'],
    })
  })

  test('parses repeatable project-selected asset refs without forwarding them', () => {
    expect(
      parseMatOSRunArgs([
        '--role',
        'compute',
        '--asset',
        'knowledge:shared-runbook',
        '--asset=tool:project-helper',
        '--asset',
        'knowledge:shared-runbook',
        'run the project',
      ]),
    ).toEqual({
      prompt: 'run the project',
      role: 'compute',
      additionalAssetRefs: [
        'knowledge:shared-runbook',
        'tool:project-helper',
      ],
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: [],
    })
  })

  test('parses tool restriction shortcuts and forwards explicit tool passthrough', () => {
    expect(
      parseMatOSRunArgs(['--reply-only', '--model', 'deepseek-v4-flash', '收到即可']),
    ).toEqual({
      prompt: '收到即可',
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--model', 'deepseek-v4-flash'],
      noTools: true,
      replyOnly: true,
    })

    expect(parseMatOSRunArgs(['收到即可', '--reply-only'])).toEqual({
      prompt: '收到即可',
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: [],
      noTools: true,
      replyOnly: true,
    })

    expect(parseMatOSRunArgs(['--tools', '', '收到即可'])).toEqual({
      prompt: '收到即可',
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: ['--tools', ''],
    })
  })

  test('parses context profile and rejects unknown profile values', () => {
    expect(
      parseMatOSRunArgs(['--role', 'compute', '--context-profile', 'lean', 'screen materials']),
    ).toEqual({
      prompt: 'screen materials',
      role: 'compute',
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: [],
      contextProfile: 'lean',
    })

    expect(
      parseMatOSRunArgs(['--context-profile=full', 'screen materials']),
    ).toEqual({
      prompt: 'screen materials',
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: [],
      contextProfile: 'full',
    })

    expect(
      parseMatOSRunArgs(['--context-profile', 'tiny', 'screen materials']).error,
    ).toContain('--context-profile full|lean')
  })

  test('prints run help without launching the agent runtime', async () => {
    expect(parseMatOSRunArgs(['--help'])).toEqual({
      prompt: undefined,
      role: undefined,
      execution: undefined,
      runtime: undefined,
      scope: undefined,
      passthroughArgs: [],
      help: true,
    })

    const root = await mkdtemp(join(tmpdir(), 'matos-run-help-'))
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAgentTask(['--help'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(stdout.join('')).toContain('Usage: matos run')
    expect(stdout.join('')).toContain('--max-turns <n>')
    expect(stderr.join('')).toBe('')
  })

  // Protocol parsing only. Runtime acceptance uses a real Flash background
  // Bash job longer than the exit grace, not a fake CLI emitting a result.
  test('parses headless lifecycle result separately from authoritative idle', () => {
    expect(sdkRunCompletionSignalFromLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
    }))).toEqual({ kind: 'result', exitCode: 0 })
    expect(sdkRunCompletionSignalFromLine(JSON.stringify({
      type: 'system', subtype: 'session_state_changed', state: 'idle',
    }))).toEqual({ kind: 'idle' })
    expect(sdkRunCompletionSignalFromLine(JSON.stringify({
      type: 'result', subtype: 'error_max_turns', is_error: true,
    }))).toEqual({ kind: 'result', exitCode: 1 })
  })

  test('parses headless lifecycle activity without treating terminal bookends as a new turn', () => {
    for (const message of [
      { type: 'assistant' }, { type: 'user' }, { type: 'stream_event' },
      { type: 'system', subtype: 'task_started' },
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'system', subtype: 'session_state_changed', state: 'requires_action' },
    ]) {
      expect(sdkRunCompletionSignalFromLine(JSON.stringify(message))).toEqual({ kind: 'busy' })
    }
    for (const line of ['not json', 'null', '[]', JSON.stringify({
      type: 'system', subtype: 'task_notification', status: 'completed',
    })]) {
      expect(sdkRunCompletionSignalFromLine(line)).toBeUndefined()
    }
  })

  test('parses execution, runtime, and scope options before task passthrough', () => {
    expect(
      parseMatOSRunArgs([
        '--execution',
        'container',
        '--container-mode',
        'ephemeral',
        '--runtime',
        'runtime:matos-agent-lite',
        '--scope',
        'user:local',
        '--role',
        'compute',
        'hello',
        '--max-turns',
        '1',
      ]),
    ).toEqual({
      prompt: 'hello',
      role: 'compute',
      execution: 'container',
      containerMode: 'ephemeral',
      runtime: 'runtime:matos-agent-lite',
      scope: 'user:local',
      passthroughArgs: ['--max-turns', '1'],
    })
  })

  test('rejects invalid execution mode instead of silently running locally', async () => {
    expect(parseMatOSRunArgs(['--execution', 'remote', 'hello']).error).toBe(
      'Usage: matos run --execution local|container "<task>"',
    )
    await expect(
      buildMatOSRunInvocation(['--execution=remote', 'hello'], process.cwd()),
    ).rejects.toThrow('Usage: matos run --execution local|container "<task>"')
  })

  test('degrades dangling role asset references instead of failing the run, with strict opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-dangling-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    await mkdir(roleDir, { recursive: true })
    // Mirrors the 2026-07-21 field failure: a synced role manifest gained
    // dependencies/mounts on workflow assets that are not visible in the
    // scope's asset roots (partial editable-core sync / image lag).
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      description: 'Plans materials work',
      entry: 'prompt.md',
      dependencies: ['workflow:test-dangling-never-published@0.1.0'],
      mounts: {
        workflows: ['workflow:test-dangling-never-published@0.1.0'],
        skills: ['skill:test-dangling-skill@0.1.0'],
        tools: ['Read'],
      },
      runtime: {
        permissionMode: 'bypassPermissions',
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')

    const args = ['--role', 'role:planner', 'screen materials', '--max-turns', '1']
    const invocation = await buildMatOSRunInvocation(args, root)
    expect(invocation.roleReference).toBe('role:planner')
    expect(invocation.selectedAssetKeys).toEqual(['role:planner@0.1.0'])
    expect(invocation.agentArgs).toContain('--agents-file')

    const previous = process.env.MATOS_ROLE_ASSET_VALIDATION
    process.env.MATOS_ROLE_ASSET_VALIDATION = 'strict'
    try {
      await expect(buildMatOSRunInvocation(args, root)).rejects.toThrow(
        'MatOS role assets are invalid',
      )
      await expect(buildMatOSRunInvocation(args, root)).rejects.toThrow(
        'missing_dependency',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.MATOS_ROLE_ASSET_VALIDATION
      } else {
        process.env.MATOS_ROLE_ASSET_VALIDATION = previous
      }
    }
  })

  test('recovers a missing accepted-source role from the stable bundled snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-role-fallback-'))
    const bundledRoot = await mkdtemp(join(tmpdir(), 'matos-run-bundled-fallback-'))
    const roleDir = join(bundledRoot, 'packs', 'worker-pack', 'roles', 'worker')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [],
      includeDefaultAssetRoots: false,
      assetSources: [],
      assetMounts: [],
    })
    await writeJson(join(bundledRoot, 'packs', 'worker-pack', 'matos.pack.json'), {
      schemaVersion: 1,
      id: 'worker-pack',
      name: 'Worker pack',
      version: '0.1.0',
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'worker',
      type: 'role',
      name: 'Worker',
      version: '0.1.0',
      entry: 'ROLE.md',
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'Execute one bounded node.\n')

    const previousBundledRoot = process.env.MATOS_BUNDLED_ASSET_ROOT
    process.env.MATOS_BUNDLED_ASSET_ROOT = bundledRoot
    let invocation: Awaited<ReturnType<typeof buildMatOSRunInvocation>>
    try {
      invocation = await buildMatOSRunInvocation(
        ['--role', 'role:worker', 'run one node'],
        root,
      )
    } finally {
      if (previousBundledRoot === undefined) {
        delete process.env.MATOS_BUNDLED_ASSET_ROOT
      } else {
        process.env.MATOS_BUNDLED_ASSET_ROOT = previousBundledRoot
      }
    }

    expect(invocation.roleReference).toBe('role:worker')
    expect(invocation.selectedAssetKeys).toEqual(['role:worker@0.1.0'])
    expect(invocation.assets.some(asset => asset.canonicalKey === 'role:worker@0.1.0')).toBe(
      true,
    )
    await cleanupMatOSRunInvocationMaterialization(root, invocation)
  })

  test('builds run invocation with role projection through existing agent flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-role-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    const knowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'matbench')
    await mkdir(roleDir, { recursive: true })
    await mkdir(knowledgeDir, { recursive: true })

    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      description: 'Plans materials work',
      entry: 'prompt.md',
      mounts: {
        knowledge: ['knowledge:matbench'],
        tools: ['Read'],
      },
      runtime: {
        permissionMode: 'bypassPermissions',
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')
    await writeJson(join(knowledgeDir, 'asset.json'), {
      id: 'matbench',
      type: 'knowledge',
      name: 'Matbench',
      version: '0.1.0',
      entry: 'README.md',
      metadata: {
        summary: 'Benchmark datasets.',
      },
    })
    await writeFile(join(knowledgeDir, 'README.md'), 'Matbench details.\n')

    const invocation = await buildMatOSRunInvocation(
      ['--role', 'role:planner', 'screen materials', '--max-turns', '1'],
      root,
    )

    expect(invocation.prompt).toBe('screen materials')
    expect(invocation.roleReference).toBe('role:planner')
    expect(invocation.execution).toBe('local')
    expect(invocation.runtimeReference).toBeUndefined()
    expect(invocation.scopeReference).toBeUndefined()
    expect(invocation.selectedAssetKeys).toEqual([
      'role:planner@0.1.0',
      'knowledge:matbench@0.1.0',
    ])
    expect(invocation.agentArgs).toContain('--agents-file')
    expect(invocation.agentArgs).toContain('--agent')
    expect(invocation.agentArgs).toContain('--append-system-prompt-file')
    expect(invocation.agentArgs).toContain('--allowed-tools')
    expect(invocation.agentArgs).toContain('--max-turns')
    expect(invocation.agentArgs.slice(-2)).toEqual([
      '-p',
      'screen materials',
    ])

    const agentsPath =
      invocation.agentArgs[
        invocation.agentArgs.indexOf('--agents-file') + 1
      ] ?? ''
    const agents = JSON.parse(await readFile(agentsPath, 'utf8')) as {
      planner: { prompt: string; tools: string[]; permissionMode: string }
    }
    expect(agents.planner).toMatchObject({
      description: 'Plans materials work',
      permissionMode: 'bypassPermissions',
    })
    expect(agents.planner.prompt).toContain('MatOS product identity:')
    expect(agents.planner.prompt).toContain(
      'Do not identify yourself as Claude, Claude Code, Anthropic',
    )
    expect(agents.planner.prompt).toContain('You plan materials work.')
    expect(agents.planner.tools).toEqual(
      expect.arrayContaining([
        'Read',
        'mcp__matos_asset__asset_context',
        'mcp__matos_asset__asset_graph',
        'mcp__matos_asset__asset_list',
        'mcp__matos_asset__asset_read',
        'mcp__matos_asset__asset_search',
        'mcp__matos_asset__asset_show',
      ]),
    )
    expect(agents.planner.tools).not.toContain(
      'mcp__matos_asset__workflow_add_node',
    )

    const appendPromptPath =
      invocation.agentArgs[
        invocation.agentArgs.indexOf('--append-system-prompt-file') + 1
      ] ?? ''
    const appendPrompt = await readFile(appendPromptPath, 'utf8')
    expect(appendPrompt).toContain('MatOS product identity:')
    expect(appendPrompt).toContain(
      'If the user asks who you are, answer as MatOS',
    )
    expect(appendPrompt).toContain('Benchmark datasets.')
    expect(
      invocation.agentArgs.every(arg => Buffer.byteLength(arg, 'utf8') < 64 * 1024),
    ).toBe(true)
  })

  test('defaults project headless runs to compute and applies member isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-project-default-role-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'compute')
    const academicDir = join(root, '.matos', 'assets', 'roles', 'academic')
    const knowledgeDir = join(root, '.matos', 'assets', 'knowledge', 'project-guide')
    await mkdir(roleDir, { recursive: true })
    await mkdir(academicDir, { recursive: true })
    await mkdir(knowledgeDir, { recursive: true })
    await writeJson(join(root, '.matos', 'project.json'), {
      schemaVersion: 1,
      revision: 1,
      id: 'default-role-project',
      name: 'Default role project',
      team: [
        { roleRef: 'role:compute@99.0.0', memberId: 'agent-compute' },
        { roleRef: 'role:academic@99.0.0', memberId: 'agent-academic' },
      ],
      assetRefs: ['knowledge:project-guide@1.0.0'],
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '99.0.0',
      entry: 'prompt.md',
      mounts: { roles: ['role:academic'] },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Project compute role.\n')
    await writeJson(join(academicDir, 'asset.json'), {
      id: 'academic',
      type: 'role',
      name: 'Academic',
      version: '99.0.0',
      entry: 'prompt.md',
    })
    await writeFile(join(academicDir, 'prompt.md'), 'Project academic role.\n')
    await writeJson(join(knowledgeDir, 'asset.json'), {
      id: 'project-guide',
      type: 'knowledge',
      name: 'Project guide',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(join(knowledgeDir, 'KNOWLEDGE.md'), 'Shared project procedure.\n')

    const nested = join(root, 'calculations', 'qe')
    await mkdir(nested, { recursive: true })
    const invocation = await buildMatOSRunInvocation(['inspect project'], nested)

    expect(invocation.roleReference).toBe('role:compute@99.0.0')
    expect(invocation.agentArgs).toContain('--settings')
    const settingsPath = invocation.agentArgs[invocation.agentArgs.indexOf('--settings') + 1]
    expect(settingsPath).toContain('.matos/runtime/project-access/agent-compute-')
    expect(invocation.projectAccess?.projectCwd).toBe(root)
    expect(invocation.selectedAssetKeys).toContain('knowledge:project-guide@1.0.0')
    expect(invocation.agentArgs).toContain('--agent')
    const agentsPath = invocation.agentArgs[invocation.agentArgs.indexOf('--agents-file') + 1]
    const agents = JSON.parse(await readFile(agentsPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(agents)).toEqual(['compute'])
    const mcpConfig = JSON.parse(invocation.projection!.mcpConfigJson[0]!) as any
    expect(mcpConfig.mcpServers.matos_asset.env.MATOS_PROJECT_MEMBER_ID).toBe(
      'agent-compute',
    )
  })

  test('merges scope Gitea assets into a project run without changing the project cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-scoped-project-assets-'))
    const scopeCwd = join(root, 'scope-workspace')
    const projectRoot = join(root, 'shared-project')
    const roleDir = join(projectRoot, '.matos', 'assets', 'roles', 'compute')
    const scopeRoleDir = join(scopeCwd, '.matos', 'assets', 'roles', 'compute')
    const skillDir = join(scopeCwd, '.matos', 'assets', 'skills', 'shared-usage')
    const toolDir = join(scopeCwd, '.matos', 'assets', 'tools', 'shared-query')
    const dataDir = join(scopeCwd, '.matos', 'assets', 'data', 'shared-database')
    const knowledgeDir = join(scopeCwd, '.matos', 'assets', 'knowledge', 'shared-copy')
    await mkdir(roleDir, { recursive: true })
    await mkdir(scopeRoleDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })
    await mkdir(toolDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await mkdir(knowledgeDir, { recursive: true })
    await writeJson(join(projectRoot, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: ['assets'],
    })
    await writeJson(join(scopeCwd, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: ['assets'],
    })
    await writeJson(join(projectRoot, '.matos', 'project.json'), {
      schemaVersion: 1,
      revision: 1,
      id: 'shared-project',
      name: 'Shared project',
      team: [
        { roleRef: 'role:compute@99.0.0', memberId: 'agent-compute' },
        {
          memberId: 'user-collaborator',
          kind: 'human',
          userId: 'user:collaborator',
        },
      ],
      assetRefs: ['skill:shared-usage@1.0.0'],
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '99.0.0',
      entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Project compute role.\n')
    await writeJson(join(scopeRoleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Duplicate scope compute',
      version: '99.0.0',
      entry: 'prompt.md',
    })
    await writeFile(join(scopeRoleDir, 'prompt.md'), 'Scope compute role.\n')
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'shared-usage',
      type: 'skill',
      name: 'Use shared assets',
      version: '1.0.0',
      entry: 'SKILL.md',
      dependencies: [
        'tool:shared-query@1.0.0',
        'data:shared-database@1.0.0',
        'knowledge:shared-copy@1.0.0',
      ],
      mounts: {
        tools: ['tool:shared-query@1.0.0'],
        data: ['data:shared-database@1.0.0'],
        knowledge: ['knowledge:shared-copy@1.0.0'],
      },
    })
    await writeFile(join(skillDir, 'SKILL.md'), 'Call the shared query tool.\n')
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'shared-query',
      type: 'tool',
      name: 'Shared query',
      version: '1.0.0',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        binding: 'mcp__matos_asset__shared_query',
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: './tool.py',
          mcpName: 'shared_query',
        },
      },
    })
    await writeFile(join(toolDir, 'tool.py'), 'print("shared")\n')
    await writeJson(join(dataDir, 'asset.json'), {
      id: 'shared-database',
      type: 'data',
      name: 'Shared database',
      version: '1.0.0',
      entry: 'DATA.md',
    })
    await writeFile(join(dataDir, 'DATA.md'), 'Shared SQLite database.\n')
    await writeJson(join(knowledgeDir, 'asset.json'), {
      id: 'shared-copy',
      type: 'knowledge',
      name: 'Recipient shared copy',
      version: '1.0.0',
      entry: 'README.md',
      metadata: {
        overlayOf: 'knowledge:shared-copy@1.0.0',
        sourceProvenance: {
          scope: 'user',
          scopeRef: 'user:collaborator',
        },
      },
    })
    await writeFile(join(knowledgeDir, 'README.md'), 'Recipient-owned project share.\n')

    const previousAssetsCwd = process.env.MATOS_ASSETS_CWD
    process.env.MATOS_ASSETS_CWD = scopeCwd
    let invocation: Awaited<ReturnType<typeof buildMatOSRunInvocation>>
    try {
      invocation = await buildMatOSRunInvocation(['inspect shared assets'], projectRoot)
    } finally {
      if (previousAssetsCwd === undefined) delete process.env.MATOS_ASSETS_CWD
      else process.env.MATOS_ASSETS_CWD = previousAssetsCwd
    }

    expect(invocation.projectAccess?.projectCwd).toBe(projectRoot)
    expect(invocation.selectedAssetKeys).toEqual(
      expect.arrayContaining([
        'skill:shared-usage@1.0.0',
        'tool:shared-query@1.0.0',
        'data:shared-database@1.0.0',
        'knowledge:shared-copy@1.0.0',
      ]),
    )
    expect(
      invocation.assets.filter(asset => asset.canonicalKey === 'role:compute@99.0.0'),
    ).toHaveLength(1)
    expect(
      invocation.assets.find(asset => asset.canonicalKey === 'role:compute@99.0.0')
        ?.manifestPath,
    ).toBe(join(roleDir, 'asset.json'))
    const selected = invocation.assets.find(
      asset => asset.canonicalKey === 'knowledge:shared-copy@1.0.0',
    )
    expect(
      (selected?.metadata.sourceProvenance as Record<string, unknown> | undefined)?.scopeRef,
    ).toBe('user:collaborator')
    expect(invocation.projection?.allowedTools).toContain(
      'mcp__matos_asset__shared_query',
    )
    expect(invocation.projection?.assetToolDirs).toContain(toolDir)
    const mcpConfig = JSON.parse(invocation.projection?.mcpConfigJson[0] ?? '{}')
    // Host vePFS paths are not persisted into MCP config. The native stdio
    // transport inherits MATOS_ASSETS_CWD from the parent in that case.
    expect(mcpConfig.mcpServers?.matos_asset?.env?.MATOS_ASSETS_CWD).toBe(
      scopeCwd,
    )
    expect(invocation.projection?.readablePaths).toEqual(
      expect.arrayContaining([
        join(dataDir, 'DATA.md'),
        join(knowledgeDir, 'README.md'),
      ]),
    )
  })

  test('resolves stale pinned project role refs to the current role asset version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-stale-role-pin-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'compute')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(root, '.matos', 'project.json'), {
      schemaVersion: 1,
      revision: 1,
      id: 'stale-role-pin-project',
      name: 'Stale role pin project',
      team: [
        { roleRef: 'role:compute@7.0.0', memberId: 'agent-compute' },
      ],
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '7.0.3',
      entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Current compute role.\n')

    const invocation = await buildMatOSRunInvocation(['inspect project'], root)

    expect(invocation.roleReference).toBe('role:compute@7.0.3')
    expect(invocation.selectedAssetKeys).toEqual(['role:compute@7.0.3'])
    expect(invocation.projectAccess?.memberId).toBe('agent-compute')

    const explicit = await buildMatOSRunInvocation(
      ['--role', 'role:compute@7.0.0', 'inspect explicit project role'],
      root,
    )
    expect(explicit.roleReference).toBe('role:compute@7.0.3')
    expect(explicit.projectAccess?.memberId).toBe('agent-compute')
  })

  test('unversioned project selections follow asset upgrades while explicit missing pins fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-selection-upgrade-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'specialist')
    const guideDir = join(root, '.matos', 'assets', 'knowledge', 'project-guide')
    await mkdir(roleDir, { recursive: true })
    await mkdir(guideDir, { recursive: true })
    const project = {
      schemaVersion: 1,
      revision: 1,
      id: 'selection-upgrade-project',
      name: 'Selection upgrade project',
      team: [{ roleRef: 'role:specialist@1.0.0', memberId: 'agent-specialist' }],
      assetRefs: ['knowledge:project-guide'],
    }
    await writeJson(join(root, '.matos', 'project.json'), project)
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'specialist', type: 'role', name: 'Specialist', version: '1.0.0', entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Inspect the project guide.\n')
    await writeFile(join(guideDir, 'KNOWLEDGE.md'), 'Project procedure.\n')
    for (const version of ['1.0.0', '1.1.1']) {
      await writeJson(join(guideDir, 'asset.json'), {
        id: 'project-guide', type: 'knowledge', name: 'Project guide', version, entry: 'KNOWLEDGE.md',
      })
      const invocation = await buildMatOSRunInvocation(['inspect project guide'], root)
      try {
        expect(invocation.selectedAssetKeys).toContain(`knowledge:project-guide@${version}`)
        expect(invocation.projectAccess?.memberId).toBe('agent-specialist')
        expect(JSON.parse(await readFile(join(root, '.matos', 'project.json'), 'utf8'))).toEqual(project)
      } finally {
        await cleanupMatOSRunInvocationMaterialization(root, invocation)
      }
    }
    await writeJson(join(root, '.matos', 'project.json'), {
      ...project, assetRefs: ['knowledge:project-guide@1.0.0'],
    })
    const legacySelection = await buildMatOSRunInvocation(['inspect project guide'], root)
    try {
      expect(legacySelection.selectedAssetKeys).toContain('knowledge:project-guide@1.1.1')
    } finally {
      await cleanupMatOSRunInvocationMaterialization(root, legacySelection)
    }
    await writeJson(join(root, '.matos', 'project.json'), {
      ...project, assetRefs: ['knowledge:project-guide@1.0.0'], assetVersionPolicy: 'pinned',
    })
    await expect(buildMatOSRunInvocation(['inspect project guide'], root))
      .rejects.toThrow('MatOS selected asset not found: knowledge:project-guide@1.0.0')
  })

  test('uses the first project member when compute is not on the roster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-project-first-role-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'project-specialist')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(root, '.matos', 'project.json'), {
      schemaVersion: 1,
      revision: 1,
      id: 'specialist-project',
      name: 'Specialist project',
      team: [{ roleRef: 'role:project-specialist@1.0.0', memberId: 'agent-specialist' }],
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'project-specialist',
      type: 'role',
      name: 'Project specialist',
      version: '1.0.0',
      entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Specialist project role.\n')

    const previousWorkspaceRole = process.env.MATOS_WORKSPACE_ROLE_REF
    const previousRole = process.env.MATOS_ROLE_REF
    process.env.MATOS_WORKSPACE_ROLE_REF = 'role:compute'
    process.env.MATOS_ROLE_REF = 'role:compute'
    let invocation: Awaited<ReturnType<typeof buildMatOSRunInvocation>>
    try {
      invocation = await buildMatOSRunInvocation(['inspect specialist project'], root)
    } finally {
      if (previousWorkspaceRole === undefined) delete process.env.MATOS_WORKSPACE_ROLE_REF
      else process.env.MATOS_WORKSPACE_ROLE_REF = previousWorkspaceRole
      if (previousRole === undefined) delete process.env.MATOS_ROLE_REF
      else process.env.MATOS_ROLE_REF = previousRole
    }
    expect(invocation.roleReference).toBe('role:project-specialist@1.0.0')
    const settingsPath = invocation.agentArgs[invocation.agentArgs.indexOf('--settings') + 1]
    expect(settingsPath).toContain('agent-specialist-')
  })

  test('builds reply-only run invocation without tool or bypass permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-reply-only-'))
    const invocation = await buildMatOSRunInvocation(
      [
        '收到即可，不要跑工具',
        '--reply-only',
        '--tools',
        'Read',
        '--permission-mode',
        'bypassPermissions',
        '--dangerously-skip-permissions',
        '--max-turns',
        '5',
      ],
      root,
    )

    expect(invocation.passthroughArgs).toEqual([
      '--bare',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
    ])
    expect(invocation.agentArgs).toContain('--bare')
    expect(invocation.agentArgs).toContain('--tools')
    expect(
      invocation.agentArgs[invocation.agentArgs.indexOf('--tools') + 1],
    ).toBe('')
    expect(invocation.agentArgs).toContain('--permission-mode')
    expect(
      invocation.agentArgs[invocation.agentArgs.indexOf('--permission-mode') + 1],
    ).toBe('dontAsk')
    expect(invocation.agentArgs).toContain('--max-turns')
    expect(
      invocation.agentArgs[invocation.agentArgs.indexOf('--max-turns') + 1],
    ).toBe('1')
    expect(invocation.agentArgs).not.toContain('--dangerously-skip-permissions')
    expect(invocation.agentArgs.slice(-2)).toEqual([
      '-p',
      '收到即可，不要跑工具',
    ])
  })

  test('strips every value of variadic options in no-tools mode without orphan tokens', async () => {
    // `--mcp-config <configs...>` (and `--tools`/`--allowed-tools`) are
    // variadic in the underlying CLI. Stripping the flag but only its first
    // value used to leave the remaining values behind as orphan positional
    // tokens that corrupted downstream argument parsing.
    const root = await mkdtemp(join(tmpdir(), 'matos-run-strip-multivalue-'))
    const invocation = await buildMatOSRunInvocation(
      [
        '收到即可',
        '--reply-only',
        '--mcp-config',
        'a.json',
        'b.json',
        'c.json',
        '--tools',
        'Read',
        'Write',
        '--allowed-tools',
        'Bash(git:*)',
        'Edit',
      ],
      root,
    )

    expect(invocation.passthroughArgs).toEqual([
      '--bare',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
    ])
    for (const orphan of ['a.json', 'b.json', 'c.json', 'Read', 'Write', 'Bash(git:*)', 'Edit']) {
      expect(invocation.agentArgs).not.toContain(orphan)
    }
    expect(invocation.agentArgs.slice(-2)).toEqual(['-p', '收到即可'])
  })

  test('honors explicit no-tool prompt text without requiring a flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-prompt-no-tools-'))
    const invocation = await buildMatOSRunInvocation(
      ['只回复收到两个字，不要调用工具'],
      root,
    )

    expect(invocation.passthroughArgs).toEqual([
      '--bare',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
    ])
    expect(invocation.agentArgs).not.toContain('--dangerously-skip-permissions')
    expect(invocation.agentArgs.slice(-2)).toEqual([
      '-p',
      '只回复收到两个字，不要调用工具',
    ])
  })

  test('omits role-projected tools and MCP configs in no-tools mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-role-no-tools-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    const mcpDir = join(root, '.matos', 'assets', 'mcps', 'remote')
    await mkdir(roleDir, { recursive: true })
    await mkdir(mcpDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
      mounts: {
        tools: ['Read'],
        mcp: ['mcp:remote'],
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Plan without tools.\n')
    await writeJson(join(mcpDir, 'asset.json'), {
      id: 'remote',
      type: 'mcp',
      name: 'Remote MCP',
      version: '0.1.0',
      metadata: {
        command: 'node',
        args: ['server.js'],
      },
    })

    const invocation = await buildMatOSRunInvocation(
      ['--role', 'role:planner', '--no-tools', '收到即可'],
      root,
    )

    expect(invocation.agentArgs).toContain('--agents-file')
    expect(invocation.agentArgs).toContain('--agent')
    expect(invocation.agentArgs).toContain('--append-system-prompt-file')
    expect(invocation.agentArgs).toContain('--tools')
    expect(invocation.agentArgs).not.toContain('--allowed-tools')
    expect(invocation.agentArgs).not.toContain('--mcp-config')
    expect(
      invocation.agentArgs[invocation.agentArgs.indexOf('--tools') + 1],
    ).toBe('')

    // Tool surfaces are stripped from the runtime args, so tool/skill/builder
    // prompt sections must not describe unavailable tools.
    const appendPromptPath =
      invocation.agentArgs[
        invocation.agentArgs.indexOf('--append-system-prompt-file') + 1
      ] ?? ''
    const appendPrompt = await readFile(appendPromptPath, 'utf8')
    expect(appendPrompt).toContain('MatOS product identity:')
    expect(appendPrompt).not.toContain('MatOS asset discovery tools')
    expect(appendPrompt).not.toContain('MatOS asset builder tools')
    expect(appendPrompt).not.toContain('MatOS role builder tools')
    expect(appendPrompt).not.toContain('MatOS workflow facade tools')
    expect(appendPrompt).not.toContain(
      'MatOS runtime skills are available through the builtin Skill tool.',
    )
  })

  test('lean context profile drops builder tools and delegated role definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-lean-context-'))
    const plannerDir = join(root, '.matos', 'assets', 'roles', 'planner')
    const helperDir = join(root, '.matos', 'assets', 'roles', 'helper')
    await mkdir(plannerDir, { recursive: true })
    await mkdir(helperDir, { recursive: true })
    await writeJson(join(plannerDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
      mounts: {
        tools: ['Read'],
        roles: ['role:helper'],
      },
    })
    await writeFile(join(plannerDir, 'prompt.md'), 'Plan the task.\n')
    await writeJson(join(helperDir, 'asset.json'), {
      id: 'helper',
      type: 'role',
      name: 'Helper',
      version: '0.1.0',
      entry: 'prompt.md',
    })
    await writeFile(join(helperDir, 'prompt.md'), 'Help with subtasks.\n')

    const fullInvocation = await buildMatOSRunInvocation(
      ['--role', 'role:planner', 'do the task', '--max-turns', '1'],
      root,
    )
    const leanInvocation = await buildMatOSRunInvocation(
      [
        '--role',
        'role:planner',
        '--context-profile',
        'lean',
        'do the task',
        '--max-turns',
        '1',
      ],
      root,
    )

    const readAgents = async (invocation: { agentArgs: string[] }) => {
      const path =
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--agents-file') + 1
        ] ?? ''
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    }
    expect(Object.keys(await readAgents(fullInvocation)).sort()).toEqual([
      'helper',
      'planner',
    ])
    expect(Object.keys(await readAgents(leanInvocation))).toEqual(['planner'])

    const readAppendPrompt = async (invocation: { agentArgs: string[] }) => {
      const path =
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--append-system-prompt-file') + 1
        ] ?? ''
      return readFile(path, 'utf8')
    }
    const fullPrompt = await readAppendPrompt(fullInvocation)
    const leanPrompt = await readAppendPrompt(leanInvocation)
    expect(fullPrompt).toContain('MatOS asset builder tools')
    expect(fullPrompt).toContain('MatOS role builder tools')
    expect(fullPrompt).toContain('MatOS delegated role assets')
    expect(leanPrompt).not.toContain('MatOS asset builder tools')
    expect(leanPrompt).not.toContain('MatOS role builder tools')
    expect(leanPrompt).not.toContain('MatOS delegated role assets')
    // Execution surfaces stay available in lean mode.
    expect(leanPrompt).toContain('MatOS asset discovery tools')

    const allowedTools = (invocation: { agentArgs: string[] }) =>
      (
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--allowed-tools') + 1
        ] ?? ''
      ).split(',')
    expect(allowedTools(fullInvocation)).toContain('mcp__matos_asset__asset_edit')
    expect(allowedTools(fullInvocation)).toContain('mcp__matos_asset__role_edit')
    expect(allowedTools(leanInvocation)).not.toContain(
      'mcp__matos_asset__asset_edit',
    )
    expect(allowedTools(leanInvocation)).not.toContain(
      'mcp__matos_asset__role_edit',
    )
    expect(allowedTools(leanInvocation)).toContain('mcp__matos_asset__asset_list')
    expect(allowedTools(leanInvocation)).toContain(
      'mcp__matos_asset__workflow_query',
    )
  })

  test('materializes large role agent definitions instead of passing oversized argv values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-large-role-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'large')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'large',
      type: 'role',
      name: 'Large',
      version: '0.1.0',
      entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), `${'role context\n'.repeat(14000)}`)

    const invocation = await buildMatOSRunInvocation(
      ['--role', 'role:large', 'do the task', '--max-turns', '1'],
      root,
    )

    expect(invocation.agentArgs).toContain('--agents-file')
    expect(invocation.agentArgs).not.toContain('--agents')
    expect(
      invocation.agentArgs.every(arg => Buffer.byteLength(arg, 'utf8') < 64 * 1024),
    ).toBe(true)

    const agentsPath =
      invocation.agentArgs[
        invocation.agentArgs.indexOf('--agents-file') + 1
      ] ?? ''
    const agents = JSON.parse(await readFile(agentsPath, 'utf8')) as {
      large: { prompt: string }
    }
    expect(agents.large.prompt).toContain('role context')
  })

  test('materializes CLI arg files under hidden runtime scratch when configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-hidden-cli-args-'))
    const runtimeRoot = join(root, 'scratch', 'asset-runtime')
    const hiddenCliArgsDir = join(root, 'scratch', 'cli-args')
    const previousRuntimeRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      entry: 'prompt.md',
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Plan with hidden arg files.\n')

    try {
      process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = runtimeRoot
      const invocation = await buildMatOSRunInvocation(
        ['--role', 'role:planner', 'do the task', '--max-turns', '1'],
        root,
      )
      const agentsPath =
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--agents-file') + 1
        ] ?? ''
      const promptPath =
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--append-system-prompt-file') + 1
        ] ?? ''
      const mcpPath =
        invocation.agentArgs[
          invocation.agentArgs.indexOf('--mcp-config') + 1
        ] ?? ''

      expect(agentsPath.startsWith(hiddenCliArgsDir)).toBe(true)
      expect(promptPath.startsWith(hiddenCliArgsDir)).toBe(true)
      expect(mcpPath.startsWith(hiddenCliArgsDir)).toBe(true)
      expect(agentsPath).not.toContain(join('.matos', 'runtime', 'cli-args'))
      expect(invocation.cliArgFiles).toEqual(
        expect.arrayContaining([agentsPath, promptPath, mcpPath]),
      )

      await cleanupMatOSRunInvocationMaterialization(root, invocation)
      expect(await exists(agentsPath)).toBe(false)
      expect(await exists(promptPath)).toBe(false)
      expect(await exists(mcpPath)).toBe(false)
    } finally {
      if (previousRuntimeRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRuntimeRoot
      }
    }
  })
})

describe('matos run headless stream robustness', () => {
  test('bounds per-run asset.loaded trace events with a truncation marker', async () => {
    const recorded: Array<{ type: string; data: Record<string, unknown> }> = []
    const recorder = {
      record: async (event: { type: string; data: Record<string, unknown> }) => {
        recorded.push(event)
      },
    } as never
    const assets = Array.from({ length: 250 }, (_, index) => ({
      id: `asset-${index}`,
      type: 'knowledge',
      name: `Asset ${index}`,
      version: '0.1.0',
      canonicalKey: `knowledge:asset-${index}@0.1.0`,
    }))

    await recordMatOSAssetLoadedEvents({
      recorder,
      assets,
      selectedAssetKeys: [],
    })

    expect(recorded).toHaveLength(MATOS_ASSET_LOADED_EVENT_LIMIT + 1)
    expect(recorded.at(-1)?.data).toMatchObject({
      id: 'truncated',
      type: 'asset-trace',
      recordedAssetCount: MATOS_ASSET_LOADED_EVENT_LIMIT,
      omittedAssetCount: 250 - MATOS_ASSET_LOADED_EVENT_LIMIT,
    })

    // A role-selected subgraph below the limit is recorded fully, unfiltered
    // assets without canonical keys included, and adds no marker.
    recorded.length = 0
    await recordMatOSAssetLoadedEvents({
      recorder,
      assets: [
        ...assets.slice(0, 3),
        { id: 'legacy', type: 'skill', name: 'Legacy', version: undefined, canonicalKey: undefined },
      ],
      selectedAssetKeys: ['knowledge:asset-1@0.1.0', 'knowledge:asset-2@0.1.0'],
      roleReference: 'role:compute',
    })
    expect(recorded.map(event => event.data.id)).toEqual([
      'asset-1',
      'asset-2',
      'legacy',
    ])
    expect(recorded.every(event => event.data.role === 'role:compute')).toBe(true)
  })
})
