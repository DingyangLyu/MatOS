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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSEvent, MatOSEventSource } from '../sessions/eventTypes.js'
import {
  classifySelfEvolutionTrigger,
  directEditorImportBlockedByConcurrentChange,
  directEditorScopeForSelfEvolution,
  listMatOSSelfEvolutionMonitorRecords,
  observeMatOSSelfEvolutionEvent,
  runMatOSSelfEvolutionForSession,
  runMatOSSelfEvolutionForWorkflowEvidence,
  resolveMatOSSelfEvolutionMonitorRoots,
} from './evolutionMonitor.js'
import type {
  MatOSDirectAssetEditor,
  MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import type { MatOSExperienceRefiner } from './experienceAssets.js'
import type { MatOSTurnFeedbackClassifier } from './turnFeedbackClassifier.js'
import type {
  MatOSUserFeedbackAnalysis,
  MatOSUserFeedbackAnalyzer,
} from './userFeedbackSignals.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'
import { withMatOSEvolutionTriggerClaim } from './evolutionTriggerClaim.js'

function sessionEvent(
  id: string,
  type: MatOSEvent['type'],
  data: Record<string, unknown>,
): MatOSEvent {
  return {
    id,
    schemaVersion: 1,
    traceId: 'trace-monitor-1',
    sessionId: 'session-monitor-1',
    timestamp: '2026-06-05T00:00:00.000Z',
    roleRef: 'role:compute',
    type,
    data,
  }
}

async function writeSession(root: string, events: MatOSEvent[]): Promise<string> {
  const dir = join(root, '.matos', 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session-monitor-1.jsonl')
  await writeFile(
    path,
    events.map(event => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  )
  return path
}

function directEditFeedbackAnalysis(input: {
  eventId: string
  summary: string
  assetTypes?: string[]
}): MatOSUserFeedbackAnalysis {
  const signalId = `direct-edit-${input.eventId}`
  return {
    schemaVersion: 1,
    shouldUseFeedback: true,
    summary: input.summary,
    signals: [
      {
        id: signalId,
        kind: 'correction',
        severity: 'medium',
        explicitness: 'explicit',
        claim: 'A supported reusable correction should update a MatOS asset.',
        target: {
          assetTypes: input.assetTypes ?? ['role'],
          roleRefs: [],
          toolNames: [],
          workflowRefs: [],
        },
        evidenceExcerpt: 'supported reusable correction',
        sourceEventRefs: [`event:${input.eventId}`],
        confidence: 0.9,
      },
    ],
    decisions: [
      {
        signalId,
        reasonableness: 'strong',
        evidenceSupport: 'supported',
        generalizability: 'global',
        risk: 'low',
        recommendedAction: 'direct_edit',
        why: 'The correction is supported, reusable, and low risk.',
        counterArguments: [],
        confidence: 0.9,
      },
    ],
  }
}

describe('MatOS self-evolution monitor', () => {
  test('detects concurrent direct-editor import blocks', () => {
    expect(
      directEditorImportBlockedByConcurrentChange({
        status: 'failed',
        stderr:
          'Direct asset editor import skipped because editable assets changed during the isolated editor run.',
      }),
    ).toBe(true)
    expect(
      directEditorImportBlockedByConcurrentChange({
        status: 'rolled_back',
        stderr: 'semantic judge rejected the edit',
      }),
    ).toBe(false)
  })

  test('classifies realtime trigger events', () => {
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('turn-1', 'matos.turn.started', {
          prompt: '不对，这里做错了，需要修改。',
        }),
      ),
    ).toMatchObject({ kind: 'user-feedback' })
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('turn-preview-1', 'matos.turn.started', {
          promptPreview: '我对你的表现不是很满意，这次 workflow 演示做得不好。',
        }),
      ),
    ).toMatchObject({ kind: 'user-feedback' })
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('tool-1', 'matos.tool.call.completed', {
          toolName: 'hpc_submit',
          isError: true,
        }),
      ),
    ).toMatchObject({ kind: 'tool-failure' })
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('failed-1', 'matos.session.failed', { exitCode: 1 }),
      ),
    ).toMatchObject({ kind: 'session-end' })

    const repeated = Array.from({ length: 4 }, (_, index) =>
      sessionEvent(`tool-repeat-${index}`, 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: false,
      }),
    )
    expect(classifySelfEvolutionTrigger(repeated.at(-1)!, repeated)).toMatchObject({
      kind: 'agent-repeated-action',
    })
  })

  test('correlates completed tool calls and targets native tool assets', () => {
    const events = [
      sessionEvent('tool-started', 'matos.tool.call.started', {
        toolUseId: 'toolu-hpc-1',
        toolName: 'mcp__matos_asset__hpc_submit',
      }),
      sessionEvent('tool-completed', 'matos.tool.call.completed', {
        toolUseId: 'toolu-hpc-1',
        isError: true,
        resultPreview: '{"ok":false,"errorKind":"scheduler_failure"}',
      }),
    ]

    expect(
      classifySelfEvolutionTrigger(events[1]!, events),
    ).toMatchObject({
      kind: 'tool-failure',
      targetAssetTypes: ['tool'],
      targetAssetRefs: ['tool:hpc-submit'],
    })
  })

  test('does not evolve when an expected active-task guard blocks a submit', () => {
    const event = sessionEvent(
      'tool-active-collision',
      'matos.tool.call.completed',
      {
        toolName: 'mcp__matos_asset__hpc_submit',
        isError: true,
        resultPreview:
          '{"ok":false,"errorKind":"active_task_collision","retryable":false}',
      },
    )

    expect(classifySelfEvolutionTrigger(event, [event])).toBeUndefined()
  })

  test('skips session-end evolution when all tool errors are expected guards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-expected-guard-session-'))
    // Two turns keep the session out of the minimal-signal trivial-session
    // skip so the trigger quality gate (the guard-only check under test) is
    // actually reached.
    const events = [
      sessionEvent('turn-guarded', 'matos.turn.started', {
        prompt: 'Submit this exact prepared HPC task.',
      }),
      sessionEvent('tool-guarded', 'matos.tool.call.completed', {
        toolName: 'mcp__matos_asset__hpc_generate_yaml',
        isError: false,
        resultPreview:
          '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision","retryable":false}}',
      }),
      sessionEvent('turn-guarded-2', 'matos.turn.started', {
        prompt: 'Check the queue entry for the submitted task.',
      }),
      sessionEvent('session-guarded', 'matos.session.completed', {
        exitCode: 0,
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'session-end',
          key: 'session-end:session-monitor-1',
          eventId: 'session-guarded',
          summary: 'The guarded session completed.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return undefined
        },
      },
    )

    expect(feedbackCalls).toBe(0)
    expect(records).toHaveLength(1)
    expect(records?.[0]).toMatchObject({
      status: 'skipped-low-quality-trigger',
    })
    expect(records?.[0]?.summary).toContain('expected-tool-guard-only')
  })

  test('does not hide a real tool failure behind an expected guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-guard-plus-failure-'))
    const events = [
      sessionEvent('tool-guarded', 'matos.tool.call.completed', {
        toolName: 'mcp__matos_asset__hpc_generate_yaml',
        isError: false,
        resultPreview:
          '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision"}}',
      }),
      sessionEvent('tool-real-failure', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: true,
        resultPreview: 'unexpected parser crash',
      }),
      sessionEvent('session-mixed', 'matos.session.completed', { exitCode: 0 }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'session-end',
          key: 'session-end:session-monitor-1',
          eventId: 'session-mixed',
          summary: 'The mixed-result session completed.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: false,
            summary: 'The real failure was analyzed.',
            signals: [],
            decisions: [],
          }
        },
      },
    )

    expect(feedbackCalls).toBe(1)
  })

  test('passes a strict native tool target into the direct editor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-native-tool-target-'))
    const events = [
      sessionEvent('submit-started', 'matos.tool.call.started', {
        toolUseId: 'toolu-submit-target',
        toolName: 'mcp__matos_asset__hpc_submit',
      }),
      sessionEvent('submit-failed', 'matos.tool.call.completed', {
        toolUseId: 'toolu-submit-target',
        isError: true,
        resultPreview: '{"ok":false,"errorKind":"scheduler_failure"}',
      }),
    ]
    const trigger = classifySelfEvolutionTrigger(events[1]!, events)
    expect(trigger).toBeDefined()
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: trigger!,
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () =>
          directEditFeedbackAnalysis({
            eventId: 'submit-failed',
            summary: 'The scheduler failure needs a reusable correction.',
            assetTypes: ['knowledge'],
          }),
        directEditor: async input => {
          directInputs.push(input)
          return undefined
        },
      },
    )

    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]?.evolutionContext?.targetContract).toMatchObject({
      mode: 'strict',
      expectedTypes: ['tool'],
      preferredRefs: ['tool:hpc-submit'],
      source: 'explicit',
    })
  })

  test('does not run observed self-evolution in benchmark mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-monitor-benchmark-'))
    const sessionPath = await writeSession(root, [])
    const previous = process.env.MATOS_BENCHMARK_MODE
    let classifierCalls = 0
    process.env.MATOS_BENCHMARK_MODE = '1'
    try {
      await observeMatOSSelfEvolutionEvent({
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        event: sessionEvent('turn-benchmark', 'matos.turn.started', {
          prompt: 'This is broken and should be fixed for future runs.',
        }),
        deps: {
          turnFeedbackClassifier: async () => {
            classifierCalls += 1
            return {
              schemaVersion: 1,
              isFeedback: true,
              kinds: ['frustration'],
              confidence: 1,
              summary: 'benchmark should suppress this classifier',
            }
          },
        },
      })
    } finally {
      if (previous === undefined) {
        delete process.env.MATOS_BENCHMARK_MODE
      } else {
        process.env.MATOS_BENCHMARK_MODE = previous
      }
    }

    expect(classifierCalls).toBe(0)
  })

  test('aggregates noisy realtime trigger keys instead of using each event id', () => {
    const repeated = Array.from({ length: 4 }, (_, index) =>
      sessionEvent(`tool-repeat-a-${index}`, 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: false,
      }),
    )
    const nextRepeated = [
      ...repeated.slice(1),
      sessionEvent('tool-repeat-b-3', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: false,
      }),
    ]
    const firstRepeatedTrigger = classifySelfEvolutionTrigger(
      repeated.at(-1)!,
      repeated,
    )
    const secondRepeatedTrigger = classifySelfEvolutionTrigger(
      nextRepeated.at(-1)!,
      nextRepeated,
    )

    expect(firstRepeatedTrigger?.key).toBe(secondRepeatedTrigger?.key)
    expect(firstRepeatedTrigger?.key).not.toContain('tool-repeat-a-3')
    expect(secondRepeatedTrigger?.key).not.toContain('tool-repeat-b-3')

    const firstFailure = classifySelfEvolutionTrigger(
      sessionEvent('failure-a', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: true,
        resultPreview: 'same mkdir permission failure',
      }),
    )
    const secondFailure = classifySelfEvolutionTrigger(
      sessionEvent('failure-b', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: true,
        resultPreview: 'same mkdir permission failure',
      }),
    )
    expect(firstFailure?.key).toBe(secondFailure?.key)
    expect(firstFailure?.key).not.toContain('failure-a')
    expect(secondFailure?.key).not.toContain('failure-b')
  })

  test('does not treat ordinary planning language as user feedback', () => {
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('turn-plan', 'matos.turn.started', {
          prompt: '我觉得这个 workflow 应该先用本地 GPU，然后再提交远程队列。',
        }),
      ),
    ).toBeUndefined()
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('turn-should', 'matos.turn.started', {
          prompt: 'This workflow should use cache for repeated research steps.',
        }),
      ),
    ).toBeUndefined()
    expect(
      classifySelfEvolutionTrigger(
        sessionEvent('turn-pass', 'matos.turn.started', {
          prompt: 'Please make sure all tests pass before rollout.',
        }),
      ),
    ).toBeUndefined()
  })

  test('uses strong frustration terms as user feedback signals', () => {
    for (const [index, prompt] of [
      'wtf, this workflow broke again',
      'this is fucking broken',
      'damn, the same queue bug came back',
      'shit, the PDF viewer is blank again',
    ].entries()) {
      expect(
        classifySelfEvolutionTrigger(
          sessionEvent(`turn-frustration-${index}`, 'matos.turn.started', {
            prompt,
          }),
        ),
      ).toMatchObject({ kind: 'user-feedback' })
    }
  })

  test('skips ENOSPC infrastructure failures before hidden LLM self-evolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-gate-'))
    const events = [
      sessionEvent('tool-enospc', 'matos.tool.call.completed', {
        toolName: 'Bash',
        toolUseId: 'toolu_enospc',
        isError: true,
        exitCode: 1,
        resultPreview:
          'OSError: [Errno 28] No space left on device while installing into /root/.cache/pip',
        stderrPreview:
          'ENOSPC: no space left on device, mkdir /root/.claude/session-env',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    let refinerCalls = 0
    let directCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:bash:enospc',
          eventId: 'tool-enospc',
          summary: 'Bash failed and should be analyzed.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: 'should not run',
            signals: [],
            decisions: [],
          }
        },
        refiner: async () => {
          refinerCalls += 1
          return { shouldWrite: false, reason: 'should not run' }
        },
        directEditor: async () => {
          directCalls += 1
          throw new Error('direct editor should not run')
        },
      },
    )

    expect(feedbackCalls).toBe(0)
    expect(refinerCalls).toBe(0)
    expect(directCalls).toBe(0)
    expect(records?.map(record => record.status)).toEqual([
      'skipped-low-quality-trigger',
    ])
    expect(records?.[0]?.summary).toContain('low-quality')
    expect(records?.[0]?.summary).toMatch(/disk|ENOSPC|space/i)
  })

  test('skips release smoke exit125 session failures before hidden LLM self-evolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-gate-'))
    const events = [
      sessionEvent('session-started', 'matos.session.started', {
        command: 'matos run --max-turns 1 "smoke"',
      }),
      sessionEvent('session-failed', 'matos.session.failed', {
        exitCode: 125,
        stderrPreview:
          'release smoke test failed with exit125 and zero assistant output during image refresh',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'session-end',
          key: 'session-end:session-monitor-1',
          eventId: 'session-failed',
          summary: 'The session failed and should be analyzed.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: 'should not run',
            signals: [],
            decisions: [],
          }
        },
      },
    )

    expect(feedbackCalls).toBe(0)
    expect(records?.map(record => record.status)).toEqual([
      'skipped-low-quality-trigger',
    ])
    expect(records?.[0]?.summary).toMatch(/smoke|exit125|low-quality/i)
  })

  test('skips provider auth failures before hidden LLM self-evolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-gate-'))
    const events = [
      sessionEvent('tool-provider-auth', 'matos.tool.call.completed', {
        toolName: 'model_request',
        isError: true,
        resultPreview:
          'API Error: 401 Invalid authentication credentials from provider.',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:model-request:auth',
          eventId: 'tool-provider-auth',
          summary: 'The model provider request failed.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: 'should not run',
            signals: [],
            decisions: [],
          }
        },
      },
    )

    expect(feedbackCalls).toBe(0)
    expect(records?.map(record => record.status)).toEqual([
      'skipped-low-quality-trigger',
    ])
    expect(records?.[0]?.summary).toMatch(/provider|auth|low-quality/i)
  })

  test('does not skip explicit user feedback even when it mentions operational failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-gate-'))
    const events = [
      sessionEvent('turn-feedback', 'matos.turn.started', {
        prompt:
          '这个不是单纯的 smoke 失败，你需要记住以后遇到同类 workflow 要先检查真实日志。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-feedback',
          eventId: 'turn-feedback',
          summary: 'User feedback should be analyzed for self-evolution.',
        },
      },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: false,
            summary: 'The user gave explicit feedback.',
            signals: [],
            decisions: [],
          }
        },
      },
    )

    expect(feedbackCalls).toBe(1)
    expect(records?.map(record => record.status)).not.toContain(
      'skipped-low-quality-trigger',
    )
    expect(records?.map(record => record.status)).toContain('analysis-complete')
  })

  test('records generated scoped asset sync errors even for trivial successful sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-generated-sync-error-'))
    const generatedScopeParent = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'unknown',
      'bad-asset',
    )
    await mkdir(generatedScopeParent, { recursive: true })
    await writeFile(
      join(generatedScopeParent, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'bad-asset',
          type: 'unsupported-type',
          name: 'Bad Asset',
          version: '1.0.0',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const events = [
      sessionEvent('session-started', 'matos.session.started', {
        command: 'matos run "hello"',
      }),
      sessionEvent('session-completed', 'matos.session.completed', {
        exitCode: 0,
      }),
    ]
    const sessionPath = await writeSession(root, events)

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'session-end',
          key: 'session-end:session-monitor-1',
          eventId: 'session-completed',
          summary: 'The session completed and should be checked for reusable experience.',
        },
      },
      {
        env: {
          NODE_ENV: 'test',
          MATOS_SCOPE_ID: 'user:alice',
          MATOS_EVOLUTION_GENERATED_SCOPE_SYNC: 'on',
        },
        feedbackAnalyzer: async () => {
          throw new Error('trivial successful sessions should not reach the hidden LLM')
        },
      },
    )

    expect(records?.map(record => record.status)).toEqual(['failed'])
    expect(records?.[0]?.summary).toMatch(/Generated scoped asset sync failed/i)
  })

  test('records incremental evolution progress and avoids duplicate trigger runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-monitor-'))
    const events = [
      sessionEvent('turn-early', 'matos.turn.started', {
        prompt: `早期完整背景-${'a'.repeat(1400)}-MONITOR-EARLY-END`,
      }),
      sessionEvent('tool-fail', 'matos.tool.call.completed', {
        toolName: 'hpc_submit',
        toolUseId: 'toolu_fail',
        isError: true,
        resultPreview: 'queue rejects CustomTask',
      }),
      sessionEvent('turn-late', 'matos.turn.started', {
        prompt: `后续用户纠正-${'b'.repeat(1400)}-MONITOR-LATE-END`,
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const feedbackInputs: Parameters<MatOSUserFeedbackAnalyzer>[0][] = []
    const refinerInputs: Parameters<MatOSExperienceRefiner>[0][] = []
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []

    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async input => {
      feedbackInputs.push(input)
      return directEditFeedbackAnalysis({
        eventId: 'tool-fail',
        summary: 'Monitor critic full output MONITOR-CRITIC-END',
      })
    }
    const refiner: MatOSExperienceRefiner = async input => {
      refinerInputs.push(input)
      return {
        shouldWrite: true,
        id: 'monitor-queue-failure',
        mergeKey: 'monitor:queue:failure',
        name: 'Monitor queue failure',
        summary: 'Monitor generated reusable experience.',
        scenario: {
          domain: 'compute',
          taskType: 'queue-submit',
          failureMode: 'tool-failure',
          appliesWhen: ['queue submit fails'],
          doesNotApplyWhen: ['queue submit succeeds'],
        },
        problemSignals: ['tool failure'],
        failureModes: [
          {
            name: 'queue failure',
            symptoms: ['submit failed'],
            rootCause: 'missing compatibility check',
            avoidance: ['check queue first'],
          },
        ],
        recommendedActions: ['check queue compatibility'],
        avoidRepeating: ['resubmitting blindly'],
        checklist: ['compatibility checked'],
        examples: [{ outcome: 'failure' }],
      }
    }
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return {
        runId: 'direct-monitor-run',
        status: 'edited',
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z',
        scope: 'core',
        input: {
          generatedAt: '2026-06-05T00:00:00.000Z',
          scope: 'core',
          editableRoots: ['matos-assets/packs/matos-core'],
          experiences: [],
          targetAssets: [],
          currentEvolutionContext: {
            events: Array.from({ length: 20 }, (_, index) => ({
              ...events[index % events.length]!,
              data: { prompt: 'large-monitor-context '.repeat(400) },
              sourcePath: sessionPath,
            })),
          },
        },
        editorOutput: {
          summary: `direct edit complete ${'large-editor-summary '.repeat(1000)}`,
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@1.0.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:monitor-queue-failure@0.1.0'],
          expectedBehaviorChange: 'large expected behavior '.repeat(1000),
        },
        modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
        createdAssets: [],
        updatedAssets: ['role:compute@1.0.0'],
        disabledAssets: [],
        evidenceRefs: ['experience:monitor-queue-failure@0.1.0'],
        roleExitCode: 0,
        validation: {
          ok: false,
          gateProfile: 'full',
          assetValidation: {
            ok: false,
            errors: Array.from({ length: 200 }, (_, index) => ({
              code: `large-validation-${index}`,
              message: 'large validation payload '.repeat(100),
            })),
          },
          secretScan: { ok: true, findings: [] },
          workflowValidation: [],
        },
        stderr: 'large direct editor stderr '.repeat(20_000),
      }
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:tool-fail',
          eventId: 'tool-fail',
          summary: 'Tool failure should trigger analysis.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
      },
    )
    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:tool-fail',
          eventId: 'tool-fail',
          summary: 'Duplicate tool failure should be ignored.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
      },
    )

    expect(feedbackInputs).toHaveLength(1)
    expect(feedbackInputs[0]?.events.map((event: MatOSEventSource) => event.id)).toEqual([
      'turn-early',
      'tool-fail',
      'turn-late',
    ])
    expect(refinerInputs).toHaveLength(0)
    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({ cwd: root, scope: 'core' })

    const records = (await listMatOSSelfEvolutionMonitorRecords(root)).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    )
    expect(records.map(record => record.status)).toEqual([
      'detected',
      'analysis-complete',
      'direct-edit-complete',
    ])
    expect(records[1]?.feedbackAnalysis?.summary).toContain('MONITOR-CRITIC-END')
    expect(records[2]?.directEditorRunId).toBe('direct-monitor-run')
    expect(records[2]?.directEditorRun?.stderr?.length ?? 0).toBeLessThan(5000)
    expect(
      (records[2]?.directEditorRun as unknown as { input?: { currentEvolutionContext?: unknown } })
        ?.input?.currentEvolutionContext,
    ).toBeUndefined()
    const rawMonitor = await readFile(
      join(
        root,
        '.matos',
        'evolution',
        'monitor',
        'sessions',
        'session-monitor-1',
        'records.jsonl',
      ),
      'utf8',
    )
    expect(Buffer.byteLength(rawMonitor, 'utf8')).toBeLessThan(180_000)
  })

  test('rebaselines and retries direct editor once when stable baseline is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-auto-rebaseline-'))
    const events = [
      sessionEvent('turn-feedback', 'matos.turn.started', {
        prompt: '不对，这里应该沉淀到 compute role 里。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () =>
      directEditFeedbackAnalysis({
        eventId: 'turn-feedback',
        summary: 'User gave reusable correction.',
      })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'auto-rebaseline',
      mergeKey: 'compute:auto-rebaseline',
      name: 'Auto Rebaseline',
      summary: 'Reusable compute role correction.',
      scenario: {
        domain: 'compute',
        taskType: 'role-correction',
        failureMode: 'stale guidance',
        appliesWhen: ['compute role misses this correction'],
        doesNotApplyWhen: ['compute role already includes the correction'],
      },
      problemSignals: ['stale role guidance'],
      failureModes: [
        {
          name: 'stale compute role',
          symptoms: ['compute role misses reusable correction'],
          rootCause: 'role guidance not updated after user correction',
          avoidance: ['update compute role guidance'],
        },
      ],
      recommendedActions: ['Update compute role guidance'],
      avoidRepeating: ['leaving the correction only in transcript history'],
      checklist: ['compute role guidance updated'],
      examples: [],
    })
    const directRuns: string[] = []
    const directEditor: MatOSDirectAssetEditor = async () => {
      directRuns.push('edit')
      if (directRuns.length === 1) {
        return {
          runId: 'direct-auto-rebaseline-blocked',
          status: 'blocked',
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-05T00:00:00.000Z',
            scope: 'core',
            editableRoots: [],
            experiences: [],
            targetAssets: [],
          },
          editorOutput: {
            summary: 'Direct asset editor skipped because current assets are dirty.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 1,
          stderr:
            'Refusing dirty direct asset editor run: current assets differ from the stable snapshot.',
        }
      }
      return {
        runId: 'direct-auto-rebaseline-accepted',
        status: 'edited',
        createdAt: '2026-06-05T00:00:01.000Z',
        updatedAt: '2026-06-05T00:00:01.000Z',
        scope: 'core',
        input: {
          generatedAt: '2026-06-05T00:00:01.000Z',
          scope: 'core',
          editableRoots: [],
          experiences: [],
          targetAssets: [],
        },
        editorOutput: {
          summary: 'Edited compute role after automatic rebaseline.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@1.0.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:auto-rebaseline@0.1.0'],
        },
        modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
        createdAssets: [],
        updatedAssets: ['role:compute@1.0.0'],
        disabledAssets: [],
        evidenceRefs: ['experience:auto-rebaseline@0.1.0'],
        roleExitCode: 0,
      }
    }
    const rebaselineInputs: unknown[] = []

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-feedback',
          eventId: 'turn-feedback',
          summary: 'User feedback should trigger analysis.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        directEditorRebaseline: async input => {
          rebaselineInputs.push(input)
          return {
            status: 'updated',
            scope: 'core',
            previousStableSnapshot: 'asset-snapshot-old',
            previousStableCommit: '0'.repeat(40),
          }
        },
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
      },
    )

    expect(directRuns).toHaveLength(2)
    expect(rebaselineInputs).toHaveLength(1)
    const records = (await listMatOSSelfEvolutionMonitorRecords(root)).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    )
    expect(records.map(record => record.status)).toEqual([
      'detected',
      'analysis-complete',
      'direct-edit-complete',
    ])
    expect(records[2]?.summary).toContain('after rebaselining')
    expect(records[2]?.directEditorRunId).toBe('direct-auto-rebaseline-accepted')
  })

  test('recovers interrupted direct editor runs before a later noop critic can skip them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-recover-direct-editor-'))
    const events = [
      sessionEvent('turn-feedback', 'matos.turn.started', {
        prompt: '不对，这个 VASP 赝势路径经验应该沉淀下来。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const recoveredRun: MatOSDirectAssetEditorRunRecord = {
      runId: 'direct-editor-interrupted',
      status: 'accepted',
      statusReason: 'interrupted_finalize_recovered',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:01.000Z',
      scope: 'user',
      input: {
        generatedAt: '2026-06-05T00:00:00.000Z',
        scope: 'user',
        scopeRef: 'user:alice',
        editableRoots: [
          '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
        ],
        experiences: [],
        targetAssets: [],
      },
      editorOutput: {
        summary: 'Recovered VASP pseudopotential preflight knowledge.',
        modifiedFiles: [
          '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp/KNOWLEDGE.md',
        ],
        createdAssets: ['knowledge:alice-vasp-pseudopotential-preflight@0.1.0'],
        updatedAssets: [],
        disabledAssets: [],
        evidenceRefs: [
          'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
        ],
      },
      modifiedFiles: [
        '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp/KNOWLEDGE.md',
      ],
      createdAssets: ['knowledge:alice-vasp-pseudopotential-preflight@0.1.0'],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [
        'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
      ],
      roleExitCode: 0,
    }
    const recoveryInputs: unknown[] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: false,
      summary: 'The continuation is a noop after the interrupted edit.',
      signals: [],
      decisions: [],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: false,
      summary: 'No new reusable experience in the continuation.',
    })
    const directEditor: MatOSDirectAssetEditor = async () => {
      throw new Error('direct editor should not run for noop continuation')
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-feedback',
          eventId: 'turn-feedback',
          summary: 'Continuation after interrupted direct edit.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        directEditorRecover: async input => {
          recoveryInputs.push(input)
          return { recovered: [recoveredRun], skipped: [] }
        },
        env: {
          NODE_ENV: 'test',
          MATOS_USER_ID: 'alice',
          MATOS_SCOPE_ID: 'user:alice',
        },
      },
    )

    expect(recoveryInputs).toHaveLength(1)
    expect(recoveryInputs[0]).toMatchObject({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      limit: 3,
    })
    const records = (await listMatOSSelfEvolutionMonitorRecords(root)).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    )
    expect(records[0]?.status).toBe('direct-edit-complete')
    expect(records[0]?.summary).toContain(
      'Recovered interrupted direct asset editor run direct-editor-interrupted',
    )
    expect(records[0]?.directEditorRunId).toBe('direct-editor-interrupted')
    expect(records.map(record => record.status)).toContain('noop')
  })

  test('uses scope-owned monitor dir when configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-monitor-dir-'))
    const monitorRoot = join(root, 'scope-monitor', 'sessions')
    const previousMonitorDir = process.env.MATOS_EVOLUTION_MONITOR_DIR
    const previousSessionDir = process.env.MATOS_SESSION_DIR
    process.env.MATOS_EVOLUTION_MONITOR_DIR = monitorRoot
    delete process.env.MATOS_SESSION_DIR
    try {
      const events = [
        sessionEvent('turn-feedback', 'matos.turn.started', {
          prompt: '垃圾，这次演示做错了。',
        }),
      ]
      const sessionPath = await writeSession(root, events)
      const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'Configured monitor root was used.',
        signals: [],
        decisions: [],
      })
      const refiner: MatOSExperienceRefiner = async () => ({
        shouldWrite: false,
        summary: 'No reusable experience for this unit test.',
      })

      await runMatOSSelfEvolutionForSession(
        {
          cwd: root,
          sessionId: 'session-monitor-1',
          sessionPath,
          trigger: {
            kind: 'user-feedback',
            key: 'user-feedback:turn-feedback',
            eventId: 'turn-feedback',
            summary: 'User feedback should trigger analysis.',
          },
        },
        { feedbackAnalyzer, refiner, env: { NODE_ENV: 'test' } },
      )

      expect(resolveMatOSSelfEvolutionMonitorRoots(root)[0]).toBe(monitorRoot)
      const raw = await readFile(
        join(monitorRoot, 'session-monitor-1', 'records.jsonl'),
        'utf8',
      )
      expect(raw).toContain('Configured monitor root was used.')
      const listed = await listMatOSSelfEvolutionMonitorRecords(root)
      expect(listed.map(record => record.status)).toContain('analysis-complete')
    } finally {
      if (previousMonitorDir === undefined) {
        delete process.env.MATOS_EVOLUTION_MONITOR_DIR
      } else {
        process.env.MATOS_EVOLUTION_MONITOR_DIR = previousMonitorDir
      }
      if (previousSessionDir === undefined) {
        delete process.env.MATOS_SESSION_DIR
      } else {
        process.env.MATOS_SESSION_DIR = previousSessionDir
      }
    }
  })

  test('skips low-quality workflow evidence before hidden LLM self-evolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-evolution-gate-'))
    const evidence: MatOSWorkflowEvidence = {
      schemaVersion: 1,
      evidenceId: 'workflow-evidence-smoke',
      runId: 'workflow-run-smoke',
      workflowRef: 'workflow:release-smoke@0.1.0',
      status: 'failed',
      traceId: 'trace-workflow-smoke',
      sourceRefs: ['workflow-event:workflow-run-smoke#failed'],
      nodeSummary: [
        {
          nodeId: 'smoke',
          status: 'failed',
          attempts: 1,
          hasError: true,
        },
      ],
      eventTypes: ['workflow.node.failed'],
      artifactRefs: [],
      suggestedAssetTypes: ['workflow', 'benchmark'],
      recovery: {
        classification: 'non_actionable',
        recommendedAction:
          'release smoke test failed with exit125 and zero assistant output during image refresh',
        reason: 'deployment smoke signal',
      },
      occurrenceCount: 1,
      createdAt: '2026-06-05T00:00:00.000Z',
      path: '/workspace/group/shared/workflow-evidence-smoke.json',
    }
    let feedbackCalls = 0
    let maintainCalls = 0

    const records = await runMatOSSelfEvolutionForWorkflowEvidence(
      { cwd: root, evidence },
      {
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: 'should not run',
            signals: [],
            decisions: [],
          }
        },
        maintainWorkflow: async () => {
          maintainCalls += 1
          return []
        },
      },
    )

    expect(feedbackCalls).toBe(0)
    expect(maintainCalls).toBe(0)
    expect(records?.map(record => record.status)).toEqual([
      'skipped-low-quality-trigger',
    ])
    expect(records?.[0]?.triggerKind).toBe('workflow-failure')
  })

  test('records workflow failure evolution with complete evidence and prior LLM output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-evolution-monitor-'))
    const evidence: MatOSWorkflowEvidence = {
      schemaVersion: 1,
      evidenceId: 'workflow-evidence-full',
      runId: 'workflow-run-full',
      workflowRef: 'workflow:compute-submit@0.1.0',
      status: 'failed',
      traceId: 'trace-workflow-full',
      sourceRefs: ['workflow-event:workflow-run-full#failed-node'],
      nodeSummary: [
        {
          nodeId: 'submit',
          status: 'failed',
          attempts: 3,
          hasError: true,
        },
      ],
      eventTypes: ['workflow.node.failed'],
      artifactRefs: [
        {
          id: 'stderr',
          nodeId: 'submit',
          path: `/workspace/group/shared/${'a'.repeat(1200)}-WORKFLOW-ARTIFACT-FULL-END`,
          kind: 'stderr',
        },
      ],
      recovery: {
        classification: 'retryable',
        recommendedAction: `Switch to local idle GPU before remote queue. ${'r'.repeat(1200)}-WORKFLOW-RECOVERY-FULL-END`,
        nodeId: 'submit',
        reason: 'Queue remained pending and user requested local GPU priority.',
      },
      suggestedAssetTypes: ['workflow', 'skill'],
      occurrenceCount: 2,
      relatedEvidenceIds: ['workflow-evidence-old'],
      relatedRunIds: ['workflow-run-old'],
      createdAt: '2026-06-05T00:00:00.000Z',
      path: '/tmp/workflow-evidence-full.json',
    }
    const feedbackInputs: unknown[] = []
    const workflowInputs: unknown[] = []
    const directInputs: unknown[] = []

    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async input => {
      feedbackInputs.push(input)
      expect(JSON.stringify(input.events)).toContain('WORKFLOW-RECOVERY-FULL-END')
      expect(JSON.stringify(input.priorLLMOutputs)).toContain(
        'WORKFLOW-ARTIFACT-FULL-END',
      )
      return directEditFeedbackAnalysis({
        eventId: evidence.evidenceId,
        summary: `Workflow critic kept full evidence. ${'c'.repeat(1200)}-WORKFLOW-CRITIC-FULL-END`,
        assetTypes: ['workflow'],
      })
    }
    const maintainWorkflow = async (input: {
      cwd: string
      evidence: MatOSWorkflowEvidence
      feedbackAnalysis?: unknown
    }) => {
      workflowInputs.push(input)
      expect(input.evidence.recovery?.recommendedAction).toContain(
        'WORKFLOW-RECOVERY-FULL-END',
      )
      expect(JSON.stringify(input.feedbackAnalysis)).toContain(
        'WORKFLOW-CRITIC-FULL-END',
      )
      return ['experience:workflow-submit-failure@0.1.0']
    }
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      expect(input.scope).toBe('core')
      expect(JSON.stringify(input.evolutionContext)).toContain(
        'WORKFLOW-ARTIFACT-FULL-END',
      )
      expect(JSON.stringify(input.evolutionContext)).toContain(
        'WORKFLOW-CRITIC-FULL-END',
      )
      return {
        runId: 'direct-workflow-run',
        status: 'edited',
        createdAt: '2026-06-05T00:00:01.000Z',
        updatedAt: '2026-06-05T00:00:01.000Z',
        scope: 'core',
        input: {
          generatedAt: '2026-06-05T00:00:01.000Z',
          scope: 'core',
          editableRoots: [],
          experiences: [],
          targetAssets: [],
        },
        editorOutput: {
          summary: 'Edited workflow asset.',
          modifiedFiles: ['matos-assets/packs/matos-core/workflows/compute/WORKFLOW.md'],
          createdAssets: [],
          updatedAssets: ['workflow:compute-submit@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:workflow-submit-failure@0.1.0'],
        },
        modifiedFiles: ['matos-assets/packs/matos-core/workflows/compute/WORKFLOW.md'],
        createdAssets: [],
        updatedAssets: ['workflow:compute-submit@0.1.0'],
        disabledAssets: [],
        evidenceRefs: ['experience:workflow-submit-failure@0.1.0'],
        roleExitCode: 0,
      }
    }

    await runMatOSSelfEvolutionForWorkflowEvidence(
      { cwd: root, evidence },
      {
        feedbackAnalyzer,
        maintainWorkflow,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core' },
      },
    )

    expect(feedbackInputs).toHaveLength(1)
    expect(workflowInputs).toHaveLength(0)
    expect(directInputs).toHaveLength(1)
    const records = (await listMatOSSelfEvolutionMonitorRecords(root)).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    )
    expect(records.map(record => record.status)).toEqual([
      'detected',
      'analysis-complete',
      'direct-edit-complete',
    ])
    expect(records[0]?.triggerKind).toBe('workflow-failure')
    expect(records[2]?.directEditorRunId).toBe('direct-workflow-run')
  })

  test('normalizes legacy dirty direct-editor monitor failures as blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-monitor-legacy-dirty-'))
    const sessionId = 'legacy-dirty-session'
    const monitorDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'sessions',
      sessionId,
    )
    await mkdir(monitorDir, { recursive: true })
    await writeFile(
      join(monitorDir, 'records.jsonl'),
      `${JSON.stringify({
        recordId: 'monitor-legacy-dirty',
        sessionId,
        triggerKind: 'user-feedback',
        triggerKey: 'user-feedback:event-1',
        status: 'failed',
        createdAt: '2026-06-17T01:26:29.842Z',
        updatedAt: '2026-06-17T01:26:29.842Z',
        summary: 'Direct asset editor did not apply changes (status: failed).',
        directEditorRunId: 'direct-editor-legacy-dirty',
        directEditorRun: {
          runId: 'direct-editor-legacy-dirty',
          status: 'failed',
          createdAt: '2026-06-17T01:26:29.815Z',
          updatedAt: '2026-06-17T01:26:29.815Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-17T01:25:31.964Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experienceCount: 1,
            targetAssetCount: 1,
          },
          editorOutput: {
            summary: 'Direct asset editor skipped because current assets are dirty.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 0,
          stderr:
            'Refusing dirty direct asset editor run: current assets differ from the stable snapshot.',
        },
      })}\n`,
      'utf8',
    )

    const [record] = await listMatOSSelfEvolutionMonitorRecords(root)

    expect(record?.status).toBe('direct-edit-blocked')
    expect(record?.summary).toContain('blocked')
    expect(record?.directEditorRun?.status).toBe('blocked')
  })

  test('normalizes legacy concurrent-import monitor failures as import-blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-monitor-legacy-import-'))
    const sessionId = 'legacy-import-session'
    const monitorDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'sessions',
      sessionId,
    )
    await mkdir(monitorDir, { recursive: true })
    await writeFile(
      join(monitorDir, 'records.jsonl'),
      `${JSON.stringify({
        recordId: 'monitor-legacy-import',
        sessionId,
        triggerKind: 'user-feedback',
        triggerKey: 'user-feedback:event-1',
        status: 'failed',
        createdAt: '2026-06-15T01:01:00.000Z',
        updatedAt: '2026-06-15T01:01:00.000Z',
        summary: 'Direct asset editor did not apply changes (status: failed).',
        directEditorRunId: 'direct-editor-legacy-import',
        directEditorRun: {
          runId: 'direct-editor-legacy-import',
          status: 'failed',
          createdAt: '2026-06-15T01:00:00.000Z',
          updatedAt: '2026-06-15T01:01:00.000Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-15T01:00:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experienceCount: 1,
            targetAssetCount: 1,
          },
          editorOutput: {
            summary: 'A valid edit was produced but could not be imported.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            createdAssets: [],
            updatedAssets: ['role:compute@1.0.1'],
            disabledAssets: [],
            evidenceRefs: ['experience:compute@0.1.0'],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 1,
          stderr:
            'Direct asset editor import skipped because editable assets changed during the isolated editor run.',
        },
      })}\n`,
      'utf8',
    )

    const [record] = await listMatOSSelfEvolutionMonitorRecords(root)

    expect(record?.status).toBe('direct-edit-import-blocked')
    expect(record?.summary).toContain('import was blocked')
    expect(record?.directEditorRun?.status).toBe('blocked')
  })

  test('deduplicates concurrent runs for the same trigger key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-concurrent-'))
    const events = [
      sessionEvent('turn-concurrent', 'matos.turn.started', {
        prompt: '失败了，应该记录一次即可。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'One concurrent analysis.',
        signals: [],
        decisions: [],
      }
    }
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: false,
      name: '',
      summary: '',
      id: '',
      scenario: {
        domain: '',
        taskType: '',
        failureMode: '',
        appliesWhen: [],
        doesNotApplyWhen: [],
      },
      failureModes: [],
      recommendedActions: [],
      examples: [],
    })
    const trigger = {
      kind: 'session-end' as const,
      key: 'session-end:session-monitor-1',
      summary: 'Concurrent session close.',
    }

    await Promise.all([
      runMatOSSelfEvolutionForSession(
        { cwd: root, sessionId: 'session-monitor-1', sessionPath, trigger },
        { feedbackAnalyzer, refiner, env: { NODE_ENV: 'test' } },
      ),
      runMatOSSelfEvolutionForSession(
        { cwd: root, sessionId: 'session-monitor-1', sessionPath, trigger },
        { feedbackAnalyzer, refiner, env: { NODE_ENV: 'test' } },
      ),
    ])

    expect(feedbackCalls).toBe(1)
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(records.filter(record => record.status === 'detected')).toHaveLength(1)
  })

  test('cooldowns noisy trigger families even after failed background processing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-failed-cooldown-'))
    const events = [
      sessionEvent('tool-repeat-failed', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: false,
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      throw new Error('critic unavailable')
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'agent-repeated-action',
          key: 'agent-repeated-action:Bash:bucket-a',
          eventId: 'tool-repeat-a',
          summary: 'Repeated Bash calls.',
        },
      },
      { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )
    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'agent-repeated-action',
          key: 'agent-repeated-action:Bash:bucket-b',
          eventId: 'tool-repeat-b',
          summary: 'Repeated Bash calls again.',
        },
      },
      { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )

    expect(feedbackCalls).toBe(1)
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(records.filter(record => record.status === 'failed')).toHaveLength(1)
  })

  test('semantic turn classifier triggers feedback runs that keywords miss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-turn-trigger-'))
    const event = sessionEvent('turn-semantic-1', 'matos.turn.started', {
      prompt: '怎么每次都要我提醒你先激活 matos 环境，换个思路吧',
    })
    expect(classifySelfEvolutionTrigger(event)).toBeUndefined()
    const sessionPath = await writeSession(root, [event])

    const classifierInputs: Parameters<MatOSTurnFeedbackClassifier>[0][] = []
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async input => {
      classifierInputs.push(input)
      return {
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['frustration', 'correction'],
        confidence: 0.9,
        summary: 'Repeated environment reminder.',
      }
    }
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'Semantic turn feedback analyzed.',
      signals: [],
      decisions: [],
    })
    const refiner: MatOSExperienceRefiner = async () => ({ shouldWrite: false })

    await observeMatOSSelfEvolutionEvent({
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      event,
      deps: {
        turnFeedbackClassifier,
        feedbackAnalyzer,
        refiner,
        env: { NODE_ENV: 'test' },
      },
    })

    expect(classifierInputs).toHaveLength(1)
    expect(classifierInputs[0]).toMatchObject({
      sessionId: 'session-monitor-1',
      eventId: 'turn-semantic-1',
    })
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    const detected = records.find(record => record.status === 'detected')
    expect(detected).toMatchObject({
      triggerKind: 'user-feedback',
      triggerKey: 'user-feedback:turn-semantic-1',
    })
    expect(detected?.summary).toContain('semantic turn classifier')
  })

  test('semantic classifier verdicts below the bar do not start evolution runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-turn-negative-'))
    const event = sessionEvent('turn-semantic-2', 'matos.turn.started', {
      prompt: '帮我算一下 BaTiO3 的能带结构，用之前那套参数',
    })
    const sessionPath = await writeSession(root, [event])

    let classifierCalls = 0
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async () => {
      classifierCalls += 1
      return {
        schemaVersion: 1,
        isFeedback: false,
        kinds: [],
        confidence: 0.95,
      }
    }

    await observeMatOSSelfEvolutionEvent({
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      event,
      deps: { turnFeedbackClassifier, env: { NODE_ENV: 'test' } },
    })

    expect(classifierCalls).toBe(1)
    expect(await listMatOSSelfEvolutionMonitorRecords(root)).toHaveLength(0)
  })

  test('skips trivial successful workspace lifecycle sessions before hidden LLM work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-trivial-session-'))
    const events = [
      sessionEvent('session-started', 'matos.session.started', {
        command: 'matos workspace start',
      }),
      sessionEvent('workspace-start', 'matos.workspace.start.requested', {
        scopeRef: 'user:local',
      }),
      sessionEvent('workspace-started', 'matos.workspace.started', {
        scopeRef: 'user:local',
      }),
      sessionEvent('session-completed', 'matos.session.completed', {
        exitCode: 0,
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0

    const result = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'session-end',
          key: 'session-end:session-monitor-1',
          eventId: 'session-completed',
          summary: 'The session completed and should be checked.',
        },
      },
      {
        feedbackAnalyzer: async () => {
          feedbackCalls += 1
          return {
            schemaVersion: 1,
            shouldUseFeedback: false,
            summary: 'No signal.',
            signals: [],
            decisions: [],
          }
        },
        env: { NODE_ENV: 'test' },
      },
    )

    expect(result).toBeUndefined()
    expect(feedbackCalls).toBe(0)
    expect(await listMatOSSelfEvolutionMonitorRecords(root)).toHaveLength(0)
  })

  test('routes user scoped sessions to user direct editor scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-user-scope-'))
    const assetRoot = await mkdtemp(
      join(tmpdir(), 'matos-self-evolution-user-asset-root-'),
    )
    const events = [
      sessionEvent('turn-user-feedback', 'matos.turn.started', {
        scopeRef: 'user:alice',
        prompt: '这个用户自己的 compute 资产应该优先使用本地 GPU。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'User wants a private compute preference.',
      signals: [
        {
          id: 'user-compute-local-gpu',
          kind: 'instruction',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Prefer local GPUs for this user.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '优先使用本地 GPU',
          sourceEventRefs: ['turn-user-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'user-compute-local-gpu',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The request is a reusable scoped preference.',
          counterArguments: [],
          confidence: 0.86,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'user-compute-local-gpu',
      mergeKey: 'user:compute:local-gpu',
      name: 'User compute local GPU preference',
      summary: 'Prefer local GPUs for this user scope.',
      scenario: {
        domain: 'compute',
        taskType: 'role-preference',
        failureMode: 'shared-default-overrides-user-preference',
        appliesWhen: ['the user asks for local GPU preference'],
        doesNotApplyWhen: ['a project policy requires a remote queue'],
      },
      problemSignals: ['user scoped preference'],
      failureModes: [
        {
          name: 'shared default overrides user preference',
          symptoms: ['agent chooses shared/default compute policy'],
          rootCause: 'user scoped compute guidance is missing',
          avoidance: ['record local GPU preference in user assets'],
        },
      ],
      recommendedActions: ['Prefer local GPUs for this user scope.'],
      avoidRepeating: ['Do not write user-specific preferences into core assets.'],
      checklist: ['Check MATOS_SCOPE_ID before direct asset editing.'],
      examples: [
        {
          traceRef: 'trace-monitor-1',
          outcome: 'correction',
          excerpt: '优先使用本地 GPU',
          sourceRefs: ['turn-user-feedback'],
        },
      ],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }
    const generatedSyncInputs: unknown[] = []
    let generatedSyncCallCount = 0

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-user-feedback',
          eventId: 'turn-user-feedback',
          summary: 'User feedback should update user assets.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        generatedScopedAssetSync: async input => {
          generatedSyncInputs.push(input)
          generatedSyncCallCount += 1
          return {
            ok: true,
            scope: input.scope,
            scopeRef: input.scopeRef,
            runId: input.runId,
            generatedRoot: join(root, '.matos', 'assets', 'generated'),
            matchedGitSourceCount: 1,
            copiedAssets:
              generatedSyncCallCount === 1
                ? []
                : [
                    {
                      type: 'experience' as const,
                      id: 'user-compute-local-gpu',
                      version: '0.1.0',
                      generatedDir: join(root, 'generated', 'experience'),
                      targetDir: join(root, 'git', 'experience'),
                      canonicalRef: 'experience:user-compute-local-gpu@0.1.0',
                    },
                  ],
            skippedAssets: [],
          }
        },
        env: {
          NODE_ENV: 'test',
          MATOS_SCOPE_ID: 'user:alice',
          MATOS_ASSETS_CWD: assetRoot,
        },
      },
    )

    expect(generatedSyncInputs).toHaveLength(0)
    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({
      cwd: assetRoot,
      scope: 'user',
      scopeRef: 'user:alice',
    })
    const records = (await listMatOSSelfEvolutionMonitorRecords(root)).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    )
    expect(records.map(record => record.status)).toEqual([
      'detected',
      'analysis-complete',
      'noop',
    ])
    expect(records[2]?.summary).toContain('Direct asset editor had no applicable target')
  })

  test('normalizes user:local fallback sessions to the real user id when available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-local-scope-normalize-'))
    const events = [
      {
        ...sessionEvent('turn-user-local-feedback', 'matos.turn.started', {
          scopeRef: 'user:local',
          prompt: '这个用户自己的 compute 资产应该记住我偏好本地 GPU。',
        }),
        userId: 'admin-main',
      },
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'User wants a private compute preference.',
      signals: [
        {
          id: 'user-local-compute-gpu',
          kind: 'preference',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Prefer local GPUs for this user.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '偏好本地 GPU',
          sourceEventRefs: ['turn-user-local-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'user-local-compute-gpu',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The request is a reusable scoped preference.',
          counterArguments: [],
          confidence: 0.86,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'user-local-compute-gpu',
      mergeKey: 'user:compute:local-gpu',
      name: 'User local scope compute preference',
      summary: 'Prefer local GPUs for the real user scope.',
      scenario: {
        domain: 'compute',
        taskType: 'role-preference',
        failureMode: 'fallback-scope-shadowed-real-user',
        appliesWhen: ['the event scope is user:local but the real user id is known'],
        doesNotApplyWhen: ['no real user id is available'],
      },
      problemSignals: ['user:local fallback scope'],
      failureModes: [
        {
          name: 'generated assets sync to user:local',
          symptoms: ['No matching Gitea asset source for user:local'],
          rootCause: 'fallback scope was not normalized to the real account scope',
          avoidance: ['prefer MATOS_USER_ID over user:local fallback'],
        },
      ],
      recommendedActions: ['Use the real user scope for scoped direct edits.'],
      avoidRepeating: ['Do not sync generated assets into user:local when MATOS_USER_ID exists.'],
      checklist: ['Check MATOS_USER_ID before accepting user:local.'],
      examples: [
        {
          traceRef: 'trace-monitor-1',
          outcome: 'correction',
          excerpt: '偏好本地 GPU',
          sourceRefs: ['turn-user-local-feedback'],
        },
      ],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-user-local-feedback',
          eventId: 'turn-user-local-feedback',
          summary: 'User feedback should update real user assets.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'user:local', MATOS_USER_ID: 'admin-main' },
      },
    )

    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:admin-main',
    })
  })

  test('lets scoped experience-only feedback target direct asset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-scoped-experience-only-'))
    const events = [
      sessionEvent('turn-user-feedback', 'matos.turn.started', {
        scopeRef: 'user:alice',
        prompt: '以后我自己的 compute 任务优先用本地 GPU。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary:
        'A low-risk user-scoped compute preference should be encoded for this user.',
      signals: [
        {
          id: 'user-compute-local-gpu-one-off',
          kind: 'preference',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Prefer local GPUs for this user.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '我自己的 compute 任务优先用本地 GPU',
          sourceEventRefs: ['turn-user-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'user-compute-local-gpu-one-off',
          reasonableness: 'plausible',
          evidenceSupport: 'supported',
          generalizability: 'one_off',
          risk: 'low',
          recommendedAction: 'experience_only',
          why:
            'The feedback is user-scoped and low risk, but the critic conservatively marked it as one-off.',
          counterArguments: [],
          confidence: 0.75,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'user-compute-local-gpu-one-off',
      mergeKey: 'user:compute:local-gpu-one-off',
      name: 'User compute local GPU one-off preference',
      summary: 'Prefer local GPUs for this user scope.',
      scenario: {
        domain: 'compute',
        taskType: 'role-preference',
        failureMode: 'missing-user-preference',
        appliesWhen: ['the user asks for a private compute preference'],
        doesNotApplyWhen: ['a project policy forbids local GPU use'],
      },
      problemSignals: ['user scoped preference'],
      failureModes: [
        {
          name: 'missing user preference',
          symptoms: ['agent ignores a private compute preference'],
          rootCause: 'the scoped preference has not been encoded yet',
          avoidance: ['write the preference into scoped assets'],
        },
      ],
      recommendedActions: ['Prefer local GPUs for this user scope.'],
      avoidRepeating: ['Do not write this preference into core assets.'],
      checklist: ['Keep the edit scoped to user:alice.'],
      examples: [],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-user-feedback',
          eventId: 'turn-user-feedback',
          summary: 'User feedback should update scoped assets.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'user:alice' },
      },
    )

    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({
      scope: 'user',
      scopeRef: 'user:alice',
    })
    expect(directInputs[0]?.evolutionContext?.targetContract).toMatchObject({
      mode: 'advisory',
      expectedTypes: ['role'],
      preferredRefs: ['role:compute'],
      source: 'feedback',
    })
  })

  test('uses user id env as the self-evolution scope fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-user-id-fallback-'))
    const events = [
      sessionEvent('turn-user-feedback', 'matos.turn.started', {
        prompt: '这个用户自己的 compute 资产应该优先使用本地 GPU。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'User wants a private compute preference.',
      signals: [
        {
          id: 'user-compute-local-gpu',
          kind: 'instruction',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Prefer local GPUs for this user.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '优先使用本地 GPU',
          sourceEventRefs: ['turn-user-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'user-compute-local-gpu',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The request is a reusable scoped preference.',
          counterArguments: [],
          confidence: 0.86,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'user-compute-local-gpu',
      mergeKey: 'user:compute:local-gpu',
      name: 'User compute local GPU preference',
      summary: 'Prefer local GPUs for this user scope.',
      scenario: {
        domain: 'compute',
        taskType: 'role-preference',
        failureMode: 'shared-default-overrides-user-preference',
        appliesWhen: ['the user asks for local GPU preference'],
        doesNotApplyWhen: ['a project policy requires a remote queue'],
      },
      problemSignals: ['user scoped preference'],
      failureModes: [
        {
          name: 'shared default overrides user preference',
          symptoms: ['agent chooses shared/default compute policy'],
          rootCause: 'user scoped compute guidance is missing',
          avoidance: ['record local GPU preference in user assets'],
        },
      ],
      recommendedActions: ['Prefer local GPUs for this user scope.'],
      avoidRepeating: ['Do not write user-specific preferences into core assets.'],
      checklist: ['Check runtime user id before direct asset editing.'],
      examples: [],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-user-feedback',
          eventId: 'turn-user-feedback',
          summary: 'User feedback should update user assets.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_USER_ID: 'alice' },
      },
    )

    expect(directInputs).toHaveLength(1)
    expect(directInputs[0]).toMatchObject({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
    })
  })

  test('blocks direct asset edits when self-evolution scope is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-missing-scope-'))
    const events = [
      sessionEvent('turn-missing-scope-feedback', 'matos.turn.started', {
        prompt: '这个用户自己的 compute 资产应该优先使用本地 GPU。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'A scoped preference was provided without a scope marker.',
      signals: [
        {
          id: 'missing-scope-compute-local-gpu',
          kind: 'instruction',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Prefer local GPUs for this user.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '优先使用本地 GPU',
          sourceEventRefs: ['turn-missing-scope-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'missing-scope-compute-local-gpu',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The request is reusable, but the runtime scope is missing.',
          counterArguments: [],
          confidence: 0.86,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'missing-scope-compute-local-gpu',
      mergeKey: 'user:compute:local-gpu',
      name: 'Missing scope compute local GPU preference',
      summary: 'Prefer local GPUs for this user scope.',
      scenario: {
        domain: 'compute',
        taskType: 'role-preference',
        failureMode: 'missing-scope-would-write-core',
        appliesWhen: ['the user asks for a scoped preference'],
        doesNotApplyWhen: ['the runtime scope is explicit'],
      },
      problemSignals: ['user scoped preference without runtime scope'],
      failureModes: [
        {
          name: 'missing scope writes core',
          symptoms: ['direct editor targets core assets'],
          rootCause: 'self-evolution scope was unavailable',
          avoidance: ['block direct editing until scope is explicit'],
        },
      ],
      recommendedActions: ['Do not direct-edit assets without explicit scope.'],
      avoidRepeating: ['Do not fall back to core assets when scope is missing.'],
      checklist: ['Require MATOS_SCOPE_ID or event scopeRef.'],
      examples: [
        {
          traceRef: 'trace-monitor-1',
          outcome: 'correction',
          excerpt: '优先使用本地 GPU',
          sourceRefs: ['turn-missing-scope-feedback'],
        },
      ],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-missing-scope-feedback',
          eventId: 'turn-missing-scope-feedback',
          summary: 'User feedback should not update core without scope.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test' },
      },
    )

    const records = await listMatOSSelfEvolutionMonitorRecords(root)

    expect(directInputs).toHaveLength(0)
    expect(
      records.some(
        record =>
          record.status === 'direct-edit-blocked' &&
          record.summary.includes('blocked_by_policy'),
      ),
    ).toBe(true)
  })

  test('blocks direct asset edits when self-evolution scope is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-self-evolution-unsupported-scope-'))
    const events = [
      sessionEvent('turn-unsupported-scope-feedback', 'matos.turn.started', {
        prompt: '这个 deployment scope 不应该被当成 core 资产来改。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    const directInputs: Parameters<MatOSDirectAssetEditor>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'Feedback was provided under an unsupported scope.',
      signals: [
        {
          id: 'unsupported-scope-core-fallback',
          kind: 'instruction',
          severity: 'medium',
          explicitness: 'explicit',
          claim: 'Do not fall back to core for unsupported scopes.',
          target: {
            assetTypes: ['role'],
            roleRefs: ['role:compute'],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: '不应该被当成 core 资产来改',
          sourceEventRefs: ['turn-unsupported-scope-feedback'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'unsupported-scope-core-fallback',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The feedback would be reusable only if the scope were supported.',
          counterArguments: [],
          confidence: 0.84,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'unsupported-scope-core-fallback',
      mergeKey: 'unsupported-scope:core-fallback',
      name: 'Unsupported scope core fallback',
      summary: 'Unsupported scopes must not fall back to core direct edits.',
      scenario: {
        domain: 'compute',
        taskType: 'scope-policy',
        failureMode: 'unsupported-scope-core-fallback',
        appliesWhen: ['scope is unsupported'],
        doesNotApplyWhen: ['scope is user/team/project/core'],
      },
      problemSignals: ['unsupported scope'],
      failureModes: [
        {
          name: 'unsupported scope falls back to core',
          symptoms: ['core assets are edited'],
          rootCause: 'scope parsing defaulted to core',
          avoidance: ['block direct editing for unsupported scopes'],
        },
      ],
      recommendedActions: ['Require a supported scope before direct editing.'],
      avoidRepeating: ['Do not map unsupported scopes to core.'],
      checklist: ['Reject unsupported MATOS_SCOPE_ID values.'],
      examples: [
        {
          traceRef: 'trace-monitor-unsupported',
          outcome: 'blocked',
          excerpt: '不应该被当成 core 资产来改',
          sourceRefs: ['turn-unsupported-scope-feedback'],
        },
      ],
    })
    const directEditor: MatOSDirectAssetEditor = async input => {
      directInputs.push(input)
      return undefined
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-unsupported',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-unsupported-scope-feedback',
          eventId: 'turn-unsupported-scope-feedback',
          summary: 'Unsupported scope should not update core.',
        },
      },
      {
        feedbackAnalyzer,
        refiner,
        directEditor,
        env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'deployment' },
      },
    )

    const records = await listMatOSSelfEvolutionMonitorRecords(root)

    expect(directInputs).toHaveLength(0)
    expect(
      records.some(
        record =>
          record.status === 'direct-edit-blocked' &&
          record.summary.includes('unsupported_scope:deployment'),
      ),
    ).toBe(true)
  })

  test('keyword fast path and gating skip the semantic classifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-turn-skip-'))
    let classifierCalls = 0
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async () => {
      classifierCalls += 1
      return {
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['correction'],
        confidence: 0.9,
      }
    }
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: false,
      summary: 'No actionable feedback.',
      signals: [],
      decisions: [],
    })
    const refiner: MatOSExperienceRefiner = async () => ({ shouldWrite: false })

    const keywordEvent = sessionEvent('turn-keyword-1', 'matos.turn.started', {
      prompt: '不对，这里做错了，需要修改。',
    })
    const sessionPath = await writeSession(root, [keywordEvent])
    await observeMatOSSelfEvolutionEvent({
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      event: keywordEvent,
      deps: {
        turnFeedbackClassifier,
        feedbackAnalyzer,
        refiner,
        env: { NODE_ENV: 'test' },
      },
    })
    expect(classifierCalls).toBe(0)
    expect(
      (await listMatOSSelfEvolutionMonitorRecords(root)).filter(
        record => record.status === 'detected',
      ),
    ).toHaveLength(1)

    for (const [id, prompt] of [
      ['turn-short', '继续'],
      ['turn-slash', '/compact 清理一下上下文吧这个太长了'],
    ] as const) {
      const gatedEvent = sessionEvent(id, 'matos.turn.started', { prompt })
      await observeMatOSSelfEvolutionEvent({
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        event: gatedEvent,
        deps: {
          turnFeedbackClassifier,
          feedbackAnalyzer,
          refiner,
          env: { NODE_ENV: 'test' },
        },
      })
    }
    expect(classifierCalls).toBe(0)

    const disabledEvent = sessionEvent('turn-disabled', 'matos.turn.started', {
      prompt: '怎么每次都要我提醒你先激活环境，太累了',
    })
    await observeMatOSSelfEvolutionEvent({
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      event: disabledEvent,
      deps: {
        turnFeedbackClassifier,
        feedbackAnalyzer,
        refiner,
        env: {
          NODE_ENV: 'test',
          MATOS_EVOLUTION_TURN_SEMANTIC_CLASSIFIER: 'off',
        },
      },
    })
    expect(classifierCalls).toBe(0)
  })

  test('trigger claim blocks overlapping evolution runs for the same trigger key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-monitor-claim-block-'))
    const events = [sessionEvent('session-end-1', 'matos.session.completed', {})]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'Claim overlap should not reach the critic.',
        signals: [],
        decisions: [],
      }
    }
    const trigger = {
      kind: 'session-end' as const,
      key: 'session-end:session-monitor-1',
      summary: 'Session close while another claim is held.',
    }
    const hold = withMatOSEvolutionTriggerClaim(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        triggerKey: trigger.key,
      },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 150))
        return 'holding'
      },
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    const blocked = await runMatOSSelfEvolutionForSession(
      { cwd: root, sessionId: 'session-monitor-1', sessionPath, trigger },
      { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )
    await hold

    expect(blocked).toBeUndefined()
    expect(feedbackCalls).toBe(0)
    expect(await listMatOSSelfEvolutionMonitorRecords(root)).toHaveLength(0)
  })

  test('semantic candidate triggers are re-classified before the hidden pipeline runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-candidate-confirm-'))
    const event = sessionEvent('turn-candidate-1', 'matos.turn.started', {
      prompt: '怎么每次都要我提醒你先激活 matos 环境，换个思路吧',
    })
    const sessionPath = await writeSession(root, [event])
    let classifierCalls = 0
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async () => {
      classifierCalls += 1
      return {
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['frustration', 'correction'],
        confidence: 0.9,
        summary: 'Repeated environment reminder.',
      }
    }
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Semantic candidate analyzed.',
        signals: [],
        decisions: [],
      }
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-candidate-1',
          eventId: 'turn-candidate-1',
          summary:
            'Potential user feedback matched the realtime turn-feedback heuristic and should be analyzed for self-evolution.',
          semanticCandidate: true,
        },
      },
      { turnFeedbackClassifier, feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )

    expect(classifierCalls).toBe(1)
    expect(feedbackCalls).toBe(1)
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    const detected = records.find(record => record.status === 'detected')
    expect(detected).toMatchObject({
      triggerKind: 'user-feedback',
      triggerKey: 'user-feedback:turn-candidate-1',
    })
    expect(detected?.summary).toContain('semantic turn classifier')
  })

  test('semantic candidate triggers rejected by the classifier conclude with a skipped record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-candidate-reject-'))
    const event = sessionEvent('turn-candidate-2', 'matos.turn.started', {
      prompt: '帮我算一下 BaTiO3 的能带结构，用之前那套参数',
    })
    const sessionPath = await writeSession(root, [event])
    let classifierCalls = 0
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async () => {
      classifierCalls += 1
      return {
        schemaVersion: 1,
        isFeedback: false,
        kinds: [],
        confidence: 0.95,
      }
    }
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Should never be reached.',
        signals: [],
        decisions: [],
      }
    }
    const candidateInput = {
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      trigger: {
        kind: 'user-feedback' as const,
        key: 'user-feedback:turn-candidate-2',
        eventId: 'turn-candidate-2',
        summary:
          'Potential user feedback matched the realtime turn-feedback heuristic and should be analyzed for self-evolution.',
        semanticCandidate: true,
      },
    }

    await runMatOSSelfEvolutionForSession(candidateInput, {
      turnFeedbackClassifier,
      feedbackAnalyzer,
      env: { NODE_ENV: 'test' },
    })

    expect(classifierCalls).toBe(1)
    expect(feedbackCalls).toBe(0)
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      status: 'skipped-low-quality-trigger',
      triggerKind: 'user-feedback',
      triggerKey: 'user-feedback:turn-candidate-2',
    })

    // The concluded skip suppresses re-spawned workers for the same candidate.
    await runMatOSSelfEvolutionForSession(candidateInput, {
      turnFeedbackClassifier,
      feedbackAnalyzer,
      env: { NODE_ENV: 'test' },
    })
    expect(classifierCalls).toBe(1)
  })

  test('semantic candidate triggers without their source event conclude without classification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-candidate-missing-'))
    const sessionPath = await writeSession(root, [
      sessionEvent('turn-other', 'matos.turn.started', {
        prompt: '先跑一遍基线计算',
      }),
    ])
    let classifierCalls = 0
    const turnFeedbackClassifier: MatOSTurnFeedbackClassifier = async () => {
      classifierCalls += 1
      return {
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['correction'],
        confidence: 0.9,
      }
    }
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Should never be reached.',
        signals: [],
        decisions: [],
      }
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-ghost',
          eventId: 'turn-ghost',
          summary:
            'Potential user feedback matched the realtime turn-feedback heuristic and should be analyzed for self-evolution.',
          semanticCandidate: true,
        },
      },
      { turnFeedbackClassifier, feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )

    expect(classifierCalls).toBe(0)
    expect(feedbackCalls).toBe(0)
    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(records.map(record => record.status)).toEqual([
      'skipped-low-quality-trigger',
    ])
  })

  test('user-feedback triggers cool down per session after a recent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-cooldown-'))
    const events = [
      sessionEvent('turn-fb-a', 'matos.turn.started', {
        prompt: '不对，这里做错了，需要修改。',
      }),
      sessionEvent('turn-fb-b', 'matos.turn.started', {
        prompt: '还是不对，这次报错了。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Feedback analyzed.',
        signals: [],
        decisions: [],
      }
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-fb-a',
          eventId: 'turn-fb-a',
          summary: 'User feedback should be analyzed.',
        },
      },
      { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )
    expect(feedbackCalls).toBe(1)

    const second = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-fb-b',
          eventId: 'turn-fb-b',
          summary: 'A second feedback turn arrived moments later.',
        },
      },
      { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
    )

    expect(second).toBeUndefined()
    expect(feedbackCalls).toBe(1)
  })

  test('user-feedback cooldown of zero restores per-event triggering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-user-feedback-cooldown-off-'))
    const events = [
      sessionEvent('turn-fb-a', 'matos.turn.started', {
        prompt: '不对，这里做错了，需要修改。',
      }),
      sessionEvent('turn-fb-b', 'matos.turn.started', {
        prompt: '还是不对，这次报错了。',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Feedback analyzed.',
        signals: [],
        decisions: [],
      }
    }
    const deps = {
      feedbackAnalyzer,
      env: {
        NODE_ENV: 'test',
        MATOS_EVOLUTION_USER_FEEDBACK_COOLDOWN_MS: '0',
      },
    }

    for (const eventId of ['turn-fb-a', 'turn-fb-b']) {
      await runMatOSSelfEvolutionForSession(
        {
          cwd: root,
          sessionId: 'session-monitor-1',
          sessionPath,
          trigger: {
            kind: 'user-feedback',
            key: `user-feedback:${eventId}`,
            eventId,
            summary: 'User feedback should be analyzed.',
          },
        },
        deps,
      )
    }

    expect(feedbackCalls).toBe(2)
  })

  test('does not run the editor when the critic asks for more evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-feedback-no-direct-edit-'))
    const event = sessionEvent('turn-needs-evidence', 'matos.turn.started', {
      prompt: '这个结果看起来可能不对，但我还没有定位原因。',
    })
    const sessionPath = await writeSession(root, [event])
    let directEditorCalls = 0

    const records = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'session-monitor-1',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-needs-evidence',
          eventId: 'turn-needs-evidence',
          summary: 'Potential feedback should be analyzed.',
        },
      },
      {
        env: {
          NODE_ENV: 'test',
          MATOS_SCOPE_ID: 'core',
          // 'off' disables the cap for this test; '0' is now the kill-switch
          // meaning zero automatic hidden runs.
          MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: 'off',
        },
        feedbackAnalyzer: async () => ({
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'The concern is useful but not ready for a durable edit.',
          signals: [
            {
              id: 'needs-evidence',
              kind: 'concern',
              severity: 'medium',
              explicitness: 'explicit',
              claim: 'The result may be incorrect.',
              target: {
                assetTypes: ['role'],
                roleRefs: ['role:compute'],
                toolNames: [],
                workflowRefs: [],
              },
              evidenceExcerpt: '可能不对，但我还没有定位原因',
              sourceEventRefs: ['event:turn-needs-evidence'],
              confidence: 0.7,
            },
          ],
          decisions: [
            {
              signalId: 'needs-evidence',
              reasonableness: 'plausible',
              evidenceSupport: 'partially_supported',
              generalizability: 'one_off',
              risk: 'medium',
              recommendedAction: 'needs_more_evidence',
              why: 'No concrete reusable correction has been established.',
              counterArguments: [],
              confidence: 0.7,
            },
          ],
        }),
        directEditor: async () => {
          directEditorCalls += 1
          return undefined
        },
      },
    )

    expect(directEditorCalls).toBe(0)
    expect(records?.map(record => record.status)).toEqual([
      'detected',
      'analysis-complete',
      'noop',
    ])
    expect(records?.at(-1)?.summary).toContain('did not select eligible evidence')
  })

  test('stops automatic critic calls after the per-user daily limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-feedback-daily-limit-'))
    const sessionPath = await writeSession(root, [
      sessionEvent('turn-budget-a', 'matos.turn.started', {
        prompt: '不对，这里需要修改。',
      }),
      sessionEvent('turn-budget-b', 'matos.turn.started', {
        prompt: '还是不对。',
      }),
    ])
    let feedbackCalls = 0
    const deps = {
      env: {
        NODE_ENV: 'test',
        MATOS_SCOPE_ID: 'user:budget-test',
        MATOS_EVOLUTION_BUDGET_DIR: join(root, 'daily-budget'),
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '1',
        MATOS_EVOLUTION_USER_FEEDBACK_COOLDOWN_MS: '0',
      },
      feedbackAnalyzer: async () => {
        feedbackCalls += 1
        return {
          schemaVersion: 1 as const,
          shouldUseFeedback: false,
          summary: 'No durable edit required.',
          signals: [],
          decisions: [],
        }
      },
    }

    await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'budget-session-a',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-budget-a',
          eventId: 'turn-budget-a',
          summary: 'First automatic feedback run.',
        },
      },
      deps,
    )
    const denied = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'budget-session-b',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-budget-b',
          eventId: 'turn-budget-b',
          summary: 'Second automatic feedback run.',
        },
      },
      deps,
    )

    expect(feedbackCalls).toBe(1)
    expect(denied?.map(record => record.status)).toEqual(['budget-denied'])
    expect(denied?.[0]?.summary).toContain('Daily hidden self-evolution limit reached')

    // The budget-denied record is a terminal conclusion: re-observing the
    // same trigger key must be suppressed by the concluded-status check
    // (no pseudo-active record, no extra pipeline run, no extra records).
    const refired = await runMatOSSelfEvolutionForSession(
      {
        cwd: root,
        sessionId: 'budget-session-b',
        sessionPath,
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-budget-b',
          eventId: 'turn-budget-b',
          summary: 'Re-fired trigger after the budget denial.',
        },
      },
      deps,
    )
    expect(refired).toBeUndefined()
    expect(feedbackCalls).toBe(1)
    const allRecords = await listMatOSSelfEvolutionMonitorRecords(root)
    const deniedSessionRecords = allRecords.filter(
      record => record.sessionId === 'budget-session-b',
    )
    expect(deniedSessionRecords.map(record => record.status)).toEqual([
      'budget-denied',
    ])
  })

  test('tool-failure family cooldown ignores volatile failure fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-tool-failure-family-'))
    const events = [
      sessionEvent('tool-fail-a', 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: true,
        resultPreview: 'queue rejects CustomTask',
      }),
    ]
    const sessionPath = await writeSession(root, events)
    let feedbackCalls = 0
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      feedbackCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'Tool failure analyzed.',
        signals: [],
        decisions: [],
      }
    }
    const run = (key: string) =>
      runMatOSSelfEvolutionForSession(
        {
          cwd: root,
          sessionId: 'session-monitor-1',
          sessionPath,
          trigger: {
            kind: 'tool-failure',
            key,
            eventId: 'tool-fail-a',
            summary: 'Tool failed and should be analyzed.',
          },
        },
        { feedbackAnalyzer, env: { NODE_ENV: 'test' } },
      )

    await run('tool-failure:Bash:fp-aaaa:2891001')
    expect(feedbackCalls).toBe(1)
    // Same tool, different volatile fingerprint/time bucket: still cooled down.
    await run('tool-failure:Bash:fp-bbbb:2891002')
    expect(feedbackCalls).toBe(1)
    // A different tool is a different family and still runs.
    await run('tool-failure:hpc-submit:fp-cccc:2891001')
    expect(feedbackCalls).toBe(2)
  })

  test('observe merges the in-flight event when the session file has not flushed it yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-monitor-observe-merge-'))
    const onDisk = Array.from({ length: 3 }, (_, index) =>
      sessionEvent(`tool-repeat-a-${index}`, 'matos.tool.call.completed', {
        toolName: 'Bash',
        isError: false,
      }),
    )
    const inFlight = sessionEvent('tool-repeat-b', 'matos.tool.call.completed', {
      toolName: 'Bash',
      isError: false,
    })
    const sessionPath = await writeSession(root, onDisk)
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: false,
      summary: 'Repeated tool calls only.',
      signals: [],
      decisions: [],
    })
    const refiner: MatOSExperienceRefiner = async () => ({ shouldWrite: false })

    await observeMatOSSelfEvolutionEvent({
      cwd: root,
      sessionId: 'session-monitor-1',
      sessionPath,
      event: inFlight,
      deps: {
        feedbackAnalyzer,
        refiner,
        env: { NODE_ENV: 'test' },
      },
    })

    const records = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(
      records.some(record => record.triggerKind === 'agent-repeated-action'),
    ).toBe(true)
  })
})

describe('self-evolution direct editor scope', () => {
  const SCOPE_ENV_KEYS = [
    'MATOS_SCOPE_REF',
    'MATOS_SCOPE_ID',
    'MATOS_USER_ID',
    'MATOS_GATEWAY_USER_ID',
    'MATOS_WORKSPACE_USER_ID',
    'MATOS_ACCOUNT_ID',
  ]

  test('falls back to the process environment when the worker passes no env', () => {
    const saved = Object.fromEntries(SCOPE_ENV_KEYS.map(key => [key, process.env[key]]))
    try {
      for (const key of SCOPE_ENV_KEYS) delete process.env[key]
      process.env.MATOS_SCOPE_REF = 'user:local'
      process.env.MATOS_USER_ID = 'local'
      expect(directEditorScopeForSelfEvolution({ events: [] })).toEqual({
        scope: 'user',
        scopeRef: 'user:local',
      })
    } finally {
      for (const key of SCOPE_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })

  test('an explicit env still wins, and an empty one stays unscoped', () => {
    expect(
      directEditorScopeForSelfEvolution({ events: [], env: { MATOS_SCOPE_REF: 'project:demo' } }),
    ).toEqual({ scope: 'project', scopeRef: 'project:demo' })
    expect(directEditorScopeForSelfEvolution({ events: [], env: {} })).toEqual({
      blockedReason: 'missing_scope',
    })
  })
})

describe('self-evolution approval mode gate', () => {
  async function guardedSession(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix))
    const events = [
      sessionEvent('turn-guarded', 'matos.turn.started', {
        prompt: 'Submit this exact prepared HPC task.',
      }),
      sessionEvent('tool-guarded', 'matos.tool.call.completed', {
        toolName: 'mcp__matos_asset__hpc_generate_yaml',
        isError: false,
        resultPreview:
          '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision","retryable":false}}',
      }),
      sessionEvent('turn-guarded-2', 'matos.turn.started', {
        prompt: 'Check the queue entry for the submitted task.',
      }),
      sessionEvent('session-guarded', 'matos.session.completed', { exitCode: 0 }),
    ]
    return { root, sessionPath: await writeSession(root, events) }
  }

  function sessionEndInput(root: string, sessionPath: string) {
    return {
      cwd: root,
      sessionId: 'session-approval-gate',
      sessionPath,
      trigger: {
        kind: 'session-end' as const,
        key: 'session-end:session-approval-gate',
        eventId: 'session-guarded',
        summary: 'The guarded session completed.',
      },
    }
  }

  test('off stops automatic triggers before any pipeline stage', async () => {
    const { root, sessionPath } = await guardedSession('matos-evolution-gate-off-')
    let feedbackCalls = 0
    const records = await runMatOSSelfEvolutionForSession(sessionEndInput(root, sessionPath), {
      env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core', MATOS_EVOLUTION_APPROVAL_MODE: 'off' },
      feedbackAnalyzer: async () => {
        feedbackCalls += 1
        return undefined
      },
    })
    expect(records).toBeUndefined()
    expect(feedbackCalls).toBe(0)
  })

  test('manual still runs the pipeline', async () => {
    const { root, sessionPath } = await guardedSession('matos-evolution-gate-manual-')
    const records = await runMatOSSelfEvolutionForSession(sessionEndInput(root, sessionPath), {
      env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core', MATOS_EVOLUTION_APPROVAL_MODE: 'manual' },
      feedbackAnalyzer: async () => undefined,
    })
    expect(records?.[0]).toMatchObject({ status: 'skipped-low-quality-trigger' })
  })
})
