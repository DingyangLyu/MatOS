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

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import type { EvolutionRoleInvocationInput } from './evolutionRoleRunner.js'
import type { MatOSEvolutionSharedPromptCacheRoleRunner } from './evolutionSharedPromptCache.js'
import {
  directEditableFeedbackDecisions,
  normalizeMatOSUserFeedbackAnalysis,
  runMatOSUserFeedbackAnalysis,
  runMatOSUserFeedbackAnalysisWithDiagnostics,
  type MatOSUserFeedbackCriticRoleRunner,
} from './userFeedbackSignals.js'

function event(
  id: string,
  type: MatOSEventSource['type'],
  data: Record<string, unknown>,
): MatOSEventSource {
  return {
    id,
    schemaVersion: 1,
    traceId: 'trace-feedback-1',
    sessionId: 'session-feedback-1',
    timestamp: '2026-06-05T00:00:00.000Z',
    execution: 'interactive',
    roleRef: 'role:compute',
    type,
    data,
    sourcePath: '/workspace/group/shared/.matos/sessions/session-feedback-1.jsonl',
  }
}

describe('MatOS user feedback analysis', () => {
  test('parses string confidence so low string confidence stays out of direct edits', () => {
    const analysis = normalizeMatOSUserFeedbackAnalysis({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'feedback',
      signals: [
        {
          id: 'sig-low',
          kind: 'instruction',
          claim: 'prefer local gpu',
          evidenceExcerpt: '本地gpu优先',
        },
        {
          id: 'sig-high',
          kind: 'instruction',
          claim: 'prefer local gpu',
          evidenceExcerpt: '本地gpu优先',
        },
      ],
      decisions: [
        {
          signalId: 'sig-low',
          why: 'low confidence string',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          confidence: '0.3',
        },
        {
          signalId: 'sig-high',
          why: 'high confidence string',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          confidence: '0.9',
        },
      ],
    })
    expect(analysis?.shouldUseFeedback).toBe(true)
    const ids = directEditableFeedbackDecisions(analysis).map(
      decision => decision.signalId,
    )
    // "0.9" parses to 0.9 and clears the >= 0.5 gate; "0.3" parses to 0.3 and
    // must NOT be silently upgraded to the passing default.
    expect(ids).toContain('sig-high')
    expect(ids).not.toContain('sig-low')
  })

  test('preserves MCP targets as tool-like direct-edit candidates', () => {
    const analysis = normalizeMatOSUserFeedbackAnalysis({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'mcp launch config feedback',
      signals: [
        {
          id: 'sig-mcp',
          kind: 'correction',
          severity: 'high',
          explicitness: 'explicit',
          claim:
            'The atomistic MACE MCP server should evolve its startup preflight.',
          target: {
            assetTypes: ['mcp', 'tool', 'plugin'],
            assetRefs: ['mcp:atomistic-mcp-mace@0.1.0'],
            mcpRefs: ['mcp:atomistic-mcp-mace'],
            toolRefs: ['tool:conda-environment-catalog'],
            toolNames: ['mcp__matos_asset__atomistic_mace'],
          },
          evidenceExcerpt:
            'MCP startup failed because the configured conda env was missing.',
          sourceEventRefs: ['event:mcp-startup-failed'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'sig-mcp',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'global',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why:
            'The MCP server launch config is a reusable tool surface and should be repaired as an asset.',
          counterArguments: [],
          confidence: 0.9,
        },
      ],
    })

    expect(analysis?.signals[0]?.target.assetTypes).toEqual(['mcp', 'tool'])
    expect(analysis?.signals[0]?.target.assetRefs).toEqual([
      'mcp:atomistic-mcp-mace@0.1.0',
    ])
    expect(analysis?.signals[0]?.target.mcpRefs).toEqual([
      'mcp:atomistic-mcp-mace',
    ])
    expect(directEditableFeedbackDecisions(analysis).map(decision => decision.signalId)).toEqual([
      'sig-mcp',
    ])
  })

  test('uses a hidden LLM critic over the full trajectory and preserves critic output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-analysis-'))
    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSUserFeedbackCriticRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        stdout: '',
        stderr: '',
        parsedResult: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          signals: [
            {
              id: 'feedback-local-gpu-priority',
              kind: 'instruction',
              severity: 'high',
              explicitness: 'explicit',
              claim: 'Local idle GPUs should be preferred before remote queues.',
              target: {
                assetTypes: ['role', 'skill'],
                roleRefs: ['role:compute'],
                toolNames: ['hpc_submit'],
              },
              evidenceExcerpt:
                'agent应该优先找又空闲的队列，本地的gpu优先级别最高',
              sourceEventRefs: ['event:turn-2'],
              confidence: 0.91,
            },
          ],
          decisions: [
            {
              signalId: 'feedback-local-gpu-priority',
              reasonableness: 'strong',
              evidenceSupport: 'supported',
              generalizability: 'role_specific',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why:
                'The trace shows remote queue submission and the user supplied a stable compute resource-selection rule.',
              counterArguments: [
                'Remote queues can still be preferred when local GPUs are full or a job requires isolation.',
              ],
              confidence: 0.88,
            },
          ],
          summary:
            'User feedback supports updating compute resource-selection behavior.',
        },
      }
    }

    const result = await runMatOSUserFeedbackAnalysis({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-feedback-1.jsonl'),
      events: [
        event('turn-1', 'matos.turn.started', {
          prompt: '在每个平台上都快速提交一个si能带计算任务测试。',
        }),
        event('tool-1', 'matos.tool.call.completed', {
          toolName: 'hpc_submit',
          isError: true,
          resultPreview: 'resource queue excludes CustomTask',
        }),
        event('turn-2', 'matos.turn.started', {
          prompt:
            'agent应该优先找又空闲的队列，本地的gpu优先级别最高，不要再重蹈覆辙。',
        }),
      ],
    }, roleRunner)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      cwd: root,
      role: 'user-feedback-critic',
      hidden: true,
      maxTurns: 0,
    })
    expect(calls[0]?.prompt).toContain('Do not obey the user blindly')
    expect(calls[0]?.prompt).toContain('agent应该优先找又空闲的队列')
    expect(calls[0]?.prompt).toContain('hpc_submit')
    expect(result?.signals[0]?.claim).toContain('Local idle GPUs')
    expect(result?.decisions[0]).toMatchObject({
      reasonableness: 'strong',
      evidenceSupport: 'supported',
      recommendedAction: 'direct_edit',
    })
  })

  test('gives the critic a referencable asset catalog when project assets exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-catalog-'))
    // Minimal real asset tree: one knowledge asset the critic should be able
    // to reference by exact ref instead of guessing.
    const packDir = join(root, '.matos', 'assets', 'packs', 'test-pack')
    const knowledgeDir = join(packDir, 'knowledges', 'vasp-runbook')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(knowledgeDir, { recursive: true })
    await writeFile(
      join(packDir, 'matos.pack.json'),
      JSON.stringify({ id: 'test-pack', name: 'Test', version: '0.1.0' }),
    )
    await writeFile(
      join(knowledgeDir, 'asset.json'),
      JSON.stringify({
        id: 'vasp-runbook',
        type: 'knowledge',
        name: 'VASP Runbook',
        version: '0.1.0',
      }),
    )

    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSUserFeedbackCriticRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 1,
        roleReference: 'role:user-feedback-critic',
        stdout: '',
        stderr: '',
      }
    }
    await runMatOSUserFeedbackAnalysis({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-catalog-1.jsonl'),
      events: [
        event('turn-1', 'matos.turn.started', { prompt: 'test prompt' }),
      ],
    }, roleRunner)

    // A failing critic is retried; every attempt carries the same catalog.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const prompt = calls[0]?.prompt ?? ''
    // The catalog rule and the actual ref both reach the critic, and the
    // cache material carries the same catalog so prompt/cache stay coherent.
    expect(prompt).toContain('Referencable asset catalog')
    expect(prompt).toContain('knowledge:vasp-runbook')
    expect(JSON.stringify(calls[0]?.cacheKeyMaterial ?? {})).toContain(
      'knowledge:vasp-runbook',
    )
  })

  test('uses shared evidence prefix without resending the full trajectory when available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-shared-prefix-'))
    const calls: EvolutionRoleInvocationInput[] = []
    const sharedRunner = (async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        stdout: '',
        stderr: '',
        parsedResult: {
          schemaVersion: 1,
          shouldUseFeedback: false,
          summary: 'No actionable feedback.',
          signals: [],
          decisions: [],
        },
      }
    }) as MatOSEvolutionSharedPromptCacheRoleRunner
    sharedRunner.usesSharedEvidencePrefix = true
    sharedRunner.sharedEvidencePrefixKey = 'shared-prefix-test'
    sharedRunner.sharedEvidenceCwd = root

    await runMatOSUserFeedbackAnalysis(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-shared.jsonl'),
        events: [
          event('turn-shared', 'matos.turn.started', {
            prompt: 'FULL-TRAJECTORY-SHOULD-NOT-BE-RESENT',
          }),
        ],
      },
      sharedRunner,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('matos-evolution-shared-evidence-prefix')
    expect(calls[0]?.prompt).not.toContain('TrajectoryPackage:')
    expect(calls[0]?.prompt).not.toContain('FULL-TRAJECTORY-SHOULD-NOT-BE-RESENT')
  })

  test('returns critic diagnostics and deterministic fallback when role output cannot be normalized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-diagnostics-'))
    const result = await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-bad.jsonl'),
        events: [
          event('turn-bad-json', 'matos.turn.started', {
            prompt: '这里不对，需要你以后避免重复。',
          }),
        ],
      },
      async () => ({
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        resultText: 'not json',
        stdout: 'raw stdout with sk-1234567890abcdef',
        stderr: 'model returned text',
        upstreamSessionId: 'hidden-critic-session',
        cache: {
          key: 'role-cache-key',
          hit: false,
          path: '.matos/evolution/role-run-cache/role-cache-key.json',
          promptVersion: 'test-prompt-version',
          roleReference: 'role:user-feedback-critic',
          modelId: 'deepseek-v4-pro',
          inputHash: 'a'.repeat(64),
        },
      }),
    )

    expect(result.analysis).toMatchObject({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: expect.stringContaining('deterministic fallback preserved'),
      signals: [
        expect.objectContaining({
          id: 'fallback-feedback-1',
          kind: 'correction',
          confidence: 0.35,
        }),
      ],
      decisions: [
        expect.objectContaining({
          signalId: 'fallback-feedback-1',
          recommendedAction: 'needs_more_evidence',
          generalizability: 'one_off',
        }),
      ],
    })
    expect(result.diagnostics).toMatchObject({
      stage: 'user-feedback-critic',
      roleReference: 'role:user-feedback-critic',
      exitCode: 0,
      parsedResultPresent: false,
      normalizedAnalysisPresent: false,
      fallbackUsed: true,
      upstreamSessionId: 'hidden-critic-session',
      cache: {
        key: 'role-cache-key',
        hit: false,
        modelId: 'deepseek-v4-pro',
      },
    })
    expect(JSON.stringify(result.diagnostics)).not.toContain('sk-1234567890abcdef')
  })

  test('bounds huge session trajectories and prior records inside the critic prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-budget-'))
    const hugeEvents = Array.from({ length: 3_000 }, (_, index) =>
      event(`turn-${index}`, 'matos.turn.started', {
        prompt: index === 2_999 ? '这个结果不对，请修一下。' : `task ${index}`,
        payload: 'x'.repeat(2_000),
      }),
    )
    const priorRecords = Array.from({ length: 400 }, (_, index) => ({
      recordId: `monitor-${index}`,
      sessionId: 'session-feedback-1',
      triggerKind: 'turn-feedback',
      triggerKey: `turn-feedback:${index}`,
      status: 'failed',
      createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      updatedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      summary: 's'.repeat(2_000),
      error: 'e'.repeat(4_000),
    }))
    let capturedPrompt = ''
    await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-huge.jsonl'),
        events: hugeEvents,
        priorLLMOutputs: {
          trigger: { kind: 'turn-feedback', key: 'turn-feedback:2999' },
          monitorRecords: priorRecords,
        },
      },
      async input => {
        capturedPrompt = input.prompt
        return {
          exitCode: 0,
          roleReference: 'role:user-feedback-critic',
          resultText: '{"schemaVersion":1,"shouldUseFeedback":false,"summary":"ok","signals":[],"decisions":[]}',
          parsedResult: {
            schemaVersion: 1,
            shouldUseFeedback: false,
            summary: 'ok',
            signals: [],
            decisions: [],
          },
          stdout: '',
          stderr: '',
        }
      },
    )

    // The raw session is ~6MB of events plus ~2.4MB of prior records; real
    // users hit provider context-length 400s from this exact shape. The
    // budgeted prompt must stay bounded while keeping the newest feedback.
    expect(capturedPrompt.length).toBeLessThan(700_000)
    expect(capturedPrompt).toContain('这个结果不对，请修一下。')
    expect(capturedPrompt).toContain('trajectoryElidedEventCount')
    expect(capturedPrompt).toContain('elidedMonitorRecordCount')
    expect(capturedPrompt).not.toContain('monitor-0')
  })

  test('retries an unparseable critic output before falling back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-retry-'))
    const jobIds: string[] = []
    const result = await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-retry.jsonl'),
        events: [
          event('turn-retry', 'matos.turn.started', {
            prompt: 'From now on always report band gaps in kJ/mol too.',
          }),
        ],
      },
      async input => {
        jobIds.push(input.jobId)
        return jobIds.length < 3
          ? {
              exitCode: 0,
              roleReference: 'role:user-feedback-critic',
              resultText: 'not json',
              stdout: '',
              stderr: '',
            }
          : {
              exitCode: 0,
              roleReference: 'role:user-feedback-critic',
              resultText: '{}',
              parsedResult: {
                schemaVersion: 1,
                shouldUseFeedback: false,
                summary: 'critic answered on the third attempt',
                signals: [],
                decisions: [],
              },
              stdout: '',
              stderr: '',
            }
      },
    )

    expect(jobIds).toHaveLength(3)
    expect(new Set(jobIds).size).toBe(3)
    expect(result.analysis?.summary).toBe('critic answered on the third attempt')
    expect(result.diagnostics).toMatchObject({ attempts: 3, normalizedAnalysisPresent: true })
    expect(result.diagnostics).not.toHaveProperty('fallbackUsed')
  })

  test('does not retry the critic when it cannot authenticate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-auth-once-'))
    let calls = 0
    await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-auth-once.jsonl'),
        events: [event('turn-auth-once', 'matos.turn.started', { prompt: 'Remember this correction.' })],
      },
      async () => {
        calls += 1
        return {
          exitCode: 1,
          roleReference: 'role:user-feedback-critic',
          resultText: 'Failed to authenticate. API Error: 401 {"error":{"message":"Authentication Fails"}}',
          stdout: '',
          stderr: '',
        }
      },
    )
    expect(calls).toBe(1)
  })

  test('does not fallback when the critic cannot authenticate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-auth-failure-'))
    const result = await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-auth.jsonl'),
        events: [
          event('turn-auth', 'matos.turn.started', {
            prompt: 'Explicit user feedback: remember this correction.',
          }),
        ],
      },
      async () => ({
        exitCode: 1,
        roleReference: 'role:user-feedback-critic',
        resultText:
          'Failed to authenticate. API Error: 401 {"error":{"message":"Authentication Fails, Your api key is invalid"}}',
        stdout: '',
        stderr: '',
      }),
    )

    expect(result.analysis).toBeUndefined()
    expect(result.diagnostics).toMatchObject({
      stage: 'user-feedback-critic',
      exitCode: 1,
      normalizedAnalysisPresent: false,
      authFailure: true,
    })
    expect(result.diagnostics).not.toHaveProperty('fallbackUsed')
  })

  test('does not fallback when the provider rejects for insufficient balance or quota', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-quota-failure-'))
    // Real 2026-07-14 production failure shape: every later hidden stage hits
    // the same 402, so the deterministic fallback would only queue guaranteed
    // editor failures while the misleading auth summary hid the billing fix.
    const result = await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-quota.jsonl'),
        events: [
          event('turn-quota', 'matos.turn.started', {
            prompt: 'Explicit user feedback: remember this correction.',
          }),
        ],
      },
      async () => ({
        exitCode: 1,
        roleReference: 'role:user-feedback-critic',
        resultText:
          'API Error: 402 {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
        stdout: '',
        stderr: '',
      }),
    )

    expect(result.analysis).toBeUndefined()
    expect(result.diagnostics).toMatchObject({
      stage: 'user-feedback-critic',
      exitCode: 1,
      normalizedAnalysisPresent: false,
      quotaFailure: true,
    })
    expect(result.diagnostics).not.toHaveProperty('authFailure')
    expect(result.diagnostics).not.toHaveProperty('fallbackUsed')
  })

  test('fallback records no feedback when critic output is unparseable for a routine session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-fallback-noop-'))
    const result = await runMatOSUserFeedbackAnalysisWithDiagnostics(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-noop.jsonl'),
        events: [
          event('session-start', 'matos.session.started', {
            command: 'matos --role compute',
          }),
          event('session-end', 'matos.session.completed', {
            exitCode: 0,
          }),
        ],
      },
      async () => ({
        exitCode: 0,
        roleReference: 'role:user-feedback-critic',
        resultText: 'not json',
        stdout: '',
        stderr: '',
      }),
    )

    expect(result.analysis).toMatchObject({
      shouldUseFeedback: false,
      summary: expect.stringContaining('fallback found no explicit user-feedback'),
      signals: [],
      decisions: [],
    })
    expect(result.diagnostics).toMatchObject({
      parsedResultPresent: false,
      normalizedAnalysisPresent: false,
      fallbackUsed: true,
    })
  })

  test('passes every trajectory event and full redacted field detail to the critic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-full-trajectory-'))
    const calls: EvolutionRoleInvocationInput[] = []
    const longPrompt = `早期关键背景-${'x'.repeat(1600)}-EARLY-END`
    const latePrompt = `后期纠正：做错了，需要完整保留全部轨迹-${'y'.repeat(1600)}-LATE-END`
    const events = [
      event('turn-early', 'matos.turn.started', { prompt: longPrompt }),
      ...Array.from({ length: 210 }, (_, index) =>
        event(`tool-${index}`, 'matos.tool.call.completed', {
          toolName: 'Bash',
          toolUseId: `toolu_${index}`,
          isError: false,
          resultPreview: `intermediate-${index}`,
        }),
      ),
      event('turn-late', 'matos.turn.started', { prompt: latePrompt }),
    ]

    await runMatOSUserFeedbackAnalysis(
      {
        cwd: root,
        sessionPath: join(root, '.matos', 'sessions', 'session-feedback-full.jsonl'),
        events,
        priorLLMOutputs: {
          previousMonitorRecord: {
            analysis: 'LLM1 previous incremental judgment must stay visible.',
            detail: 'PREVIOUS-LLM-DETAIL-END',
          },
        },
      },
      async input => {
        calls.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:user-feedback-critic',
          stdout: '',
          stderr: '',
          parsedResult: {
            schemaVersion: 1,
            shouldUseFeedback: false,
            summary: 'no actionable feedback',
            signals: [],
            decisions: [],
          },
        }
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('turn-early')
    expect(calls[0]?.prompt).toContain('tool-0')
    expect(calls[0]?.prompt).toContain('tool-209')
    expect(calls[0]?.prompt).toContain('EARLY-END')
    expect(calls[0]?.prompt).toContain('LATE-END')
    expect(calls[0]?.prompt).toContain('PREVIOUS-LLM-DETAIL-END')
  })

  test('only passes reasonable supported non-one-off low-risk feedback to direct edit', () => {
    const direct = directEditableFeedbackDecisions({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'mixed feedback',
      signals: [
        {
          id: 'supported',
          kind: 'correction',
          severity: 'high',
          explicitness: 'explicit',
          claim: 'Check queue compatibility before submit.',
          target: {
            assetTypes: ['skill'],
            roleRefs: [],
            toolNames: ['hpc_submit'],
            workflowRefs: [],
          },
          evidenceExcerpt: '应该先检查队列是否支持 CustomTask',
          sourceEventRefs: ['event:turn-1'],
          confidence: 0.9,
        },
        {
          id: 'angry-only',
          kind: 'frustration',
          severity: 'high',
          explicitness: 'implicit',
          claim: 'The system is bad.',
          target: {
            assetTypes: ['role'],
            roleRefs: [],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '这也太垃圾了',
          sourceEventRefs: ['event:turn-2'],
          confidence: 0.55,
        },
      ],
      decisions: [
        {
          signalId: 'supported',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'Trace evidence supports this failure-avoidance rule.',
          counterArguments: [],
          confidence: 0.9,
        },
        {
          signalId: 'angry-only',
          reasonableness: 'weak',
          evidenceSupport: 'unsupported',
          generalizability: 'one_off',
          risk: 'medium',
          recommendedAction: 'experience_only',
          why: 'Emotion alone does not justify asset edits.',
          counterArguments: ['No concrete action was requested.'],
          confidence: 0.6,
        },
      ],
    })

    expect(direct.map(item => item.signalId)).toEqual(['supported'])
  })

  test('only relaxes scoped experience-only or one-off feedback for explicit signals', () => {
    const analysis = normalizeMatOSUserFeedbackAnalysis({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'scoped feedback',
      signals: [
        {
          id: 'explicit-owner-preference',
          kind: 'preference',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'This user wants compute to prefer GLM for summaries.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '以后我自己的 compute 总结优先用 GLM。',
          sourceEventRefs: ['event:turn-explicit'],
          confidence: 0.86,
        },
        {
          id: 'implicit-friction',
          kind: 'frustration',
          severity: 'medium',
          explicitness: 'implicit',
          claim: 'The user may dislike the current chat formatting.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '这个看起来怪怪的。',
          sourceEventRefs: ['event:turn-implicit'],
          confidence: 0.7,
        },
      ],
      decisions: [
        {
          signalId: 'explicit-owner-preference',
          reasonableness: 'plausible',
          evidenceSupport: 'partially_supported',
          generalizability: 'one_off',
          risk: 'low',
          recommendedAction: 'experience_only',
          why: 'It is narrow globally but safe as an owner-scoped preference.',
          counterArguments: [],
          confidence: 0.74,
        },
        {
          signalId: 'implicit-friction',
          reasonableness: 'plausible',
          evidenceSupport: 'partially_supported',
          generalizability: 'one_off',
          risk: 'low',
          recommendedAction: 'experience_only',
          why: 'Implicit friction is not enough to directly edit assets.',
          counterArguments: [],
          confidence: 0.74,
        },
      ],
    })

    expect(
      directEditableFeedbackDecisions(analysis, { scoped: true }).map(
        decision => decision.signalId,
      ),
    ).toEqual(['explicit-owner-preference'])
    expect(
      directEditableFeedbackDecisions(analysis, {
        scoped: true,
        ownedSourceEventRefs: ['turn-implicit'],
      }).map(decision => decision.signalId),
    ).toEqual(['explicit-owner-preference', 'implicit-friction'])
    expect(directEditableFeedbackDecisions(analysis).map(decision => decision.signalId)).toEqual([])
  })

  test('ignores malformed owner source refs without crashing direct-edit routing', () => {
    const analysis = {
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'malformed event refs should not crash routing',
      signals: [
        {
          id: 'owned-signal',
          kind: 'preference',
          severity: 'medium',
          explicitness: 'implicit',
          claim: 'Scoped owner feedback should be editable when owned.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: 'use my scoped preference',
          sourceEventRefs: [undefined, 'event:turn-owned'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'owned-signal',
          reasonableness: 'plausible',
          evidenceSupport: 'supported',
          generalizability: 'one_off',
          risk: 'low',
          recommendedAction: 'experience_only',
          why: 'Owner scoped feedback may relax to direct edit.',
          counterArguments: [],
          confidence: 0.8,
        },
      ],
    } as never

    expect(() =>
      directEditableFeedbackDecisions(analysis, {
        scoped: true,
        ownedSourceEventRefs: [undefined, 'turn-owned'] as never,
      }),
    ).not.toThrow()
    expect(
      directEditableFeedbackDecisions(analysis, {
        scoped: true,
        ownedSourceEventRefs: [undefined, 'turn-owned'] as never,
      }).map(decision => decision.signalId),
    ).toEqual(['owned-signal'])
  })

  test('does not reject ordinary ids that contain task-config as secret tokens', () => {
    const result = normalizeMatOSUserFeedbackAnalysis({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'config feedback',
      signals: [
        {
          id: 'hpc-task-config-errors-repeated',
          kind: 'correction',
          severity: 'high',
          explicitness: 'explicit',
          claim: 'HPC task configuration should be preflighted.',
          target: {
            assetTypes: ['skill'],
            roleRefs: ['role:compute'],
            toolNames: ['hpc_submit'],
            workflowRefs: [],
          },
          evidenceExcerpt: 'Repeated task configuration errors wasted retries.',
          sourceEventRefs: ['event:tool-1'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'hpc-task-config-errors-repeated',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The id is not a secret; it only contains task-config.',
          counterArguments: [],
          confidence: 0.9,
        },
      ],
    })

    expect(result?.shouldUseFeedback).toBe(true)
    expect(result?.signals[0]?.id).toBe('hpc-task-config-errors-repeated')
  })
})
