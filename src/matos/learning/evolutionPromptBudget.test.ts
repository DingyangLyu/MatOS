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
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import type { MatOSSelfEvolutionMonitorRecord } from './evolutionMonitorRecords.js'
import {
  boundMatOSEvolutionEventsForPrompt,
  compactMatOSEvolutionMonitorRecordsForPrompt,
  compactMatOSEvolutionPriorLLMOutputsForPrompt,
} from './evolutionPromptBudget.js'

function event(
  index: number,
  data: Record<string, unknown> = {},
): MatOSEventSource {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    type: 'matos.turn.started',
    data,
    sourcePath: '/tmp/session-1.jsonl',
  }
}

function monitorRecord(
  index: number,
  overrides: Partial<MatOSSelfEvolutionMonitorRecord> = {},
): MatOSSelfEvolutionMonitorRecord {
  return {
    recordId: `monitor-${index}`,
    sessionId: 'session-1',
    triggerKind: 'turn-feedback',
    triggerKey: `turn-feedback:${index}`,
    status: 'analysis-complete',
    createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    summary: `summary ${index}`,
    ...overrides,
  } as MatOSSelfEvolutionMonitorRecord
}

describe('MatOS evolution prompt budget', () => {
  test('keeps small event lists untouched', () => {
    const events = [event(1, { prompt: 'hello' }), event(2, { ok: true })]
    const bounded = boundMatOSEvolutionEventsForPrompt(events)
    expect(bounded.events).toEqual(events)
    expect(bounded.elidedEventCount).toBe(0)
    expect(bounded.truncatedEventCount).toBe(0)
  })

  test('truncates oversized event data while preserving prompt text and scope attribution', () => {
    const events = [
      event(1, {
        prompt: '请修一下这个工具',
        scopeRef: 'user:alice',
        blob: 'x'.repeat(50_000),
      }),
    ]
    const bounded = boundMatOSEvolutionEventsForPrompt(events, {
      MATOS_EVOLUTION_PROMPT_EVENT_CHAR_LIMIT: '2000',
    })
    expect(bounded.truncatedEventCount).toBe(1)
    const data = bounded.events[0]!.data
    expect(data.matosPromptTruncated).toBe(true)
    expect(data.prompt).toBe('请修一下这个工具')
    expect(data.scopeRef).toBe('user:alice')
    expect(JSON.stringify(bounded.events[0]).length).toBeLessThan(10_000)
  })

  test('elides the oldest events under a total budget while keeping the newest', () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      event(index, { payload: 'y'.repeat(400) }),
    )
    const bounded = boundMatOSEvolutionEventsForPrompt(events, {
      MATOS_EVOLUTION_PROMPT_TRAJECTORY_CHAR_BUDGET: '5000',
    })
    expect(bounded.elidedEventCount).toBeGreaterThan(0)
    expect(bounded.events.length + bounded.elidedEventCount).toBe(50)
    expect(bounded.events.at(-1)?.id).toBe('event-49')
    // Chronological order is preserved.
    const ids = bounded.events.map(item => item.id)
    expect(ids).toEqual([...ids].sort((a, b) =>
      Number(a.split('-')[1]) - Number(b.split('-')[1]),
    ))
    // A serialized budget bounds the kept slice (plus one event of slack).
    const total = bounded.events.reduce(
      (sum, item) => sum + JSON.stringify(item).length,
      0,
    )
    expect(total).toBeLessThan(5000 + JSON.stringify(bounded.events[0]).length)
  })

  test('always keeps at least the newest event even when it exceeds the budget alone', () => {
    const events = [event(1, { blob: 'z'.repeat(9_000) })]
    const bounded = boundMatOSEvolutionEventsForPrompt(events, {
      MATOS_EVOLUTION_PROMPT_TRAJECTORY_CHAR_BUDGET: '100',
      MATOS_EVOLUTION_PROMPT_EVENT_CHAR_LIMIT: '500',
    })
    expect(bounded.events.length).toBe(1)
    expect(bounded.elidedEventCount).toBe(0)
  })

  test('compacts prior monitor records to a recent bounded projection', () => {
    const records = Array.from({ length: 80 }, (_, index) =>
      monitorRecord(index, {
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: `analysis ${index} ${'a'.repeat(600)}`,
          signals: [],
          decisions: [
            {
              signalId: 's1',
              reasonableness: 'plausible',
              evidenceSupport: 'supported',
              generalizability: 'role_specific',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why: 'why',
              counterArguments: [],
              confidence: 0.6,
            },
          ],
        },
        llmDiagnostics: [
          {
            stage: 'user-feedback-critic',
            roleReference: 'role:user-feedback-critic',
            exitCode: 0,
            parsedResultPresent: true,
            normalizedAnalysisPresent: true,
            stdoutPreview: 'p'.repeat(900),
          },
        ],
      }),
    )
    const compact = compactMatOSEvolutionMonitorRecordsForPrompt(records, {
      MATOS_EVOLUTION_PROMPT_MONITOR_RECORD_LIMIT: '10',
    })
    expect(compact.records.length).toBe(10)
    expect(compact.elidedRecordCount).toBe(70)
    expect(compact.records.at(-1)?.recordId).toBe('monitor-79')
    const serialized = JSON.stringify(compact.records)
    // Full analyses/diagnostics are projected away.
    expect(serialized).not.toContain('llmDiagnostics')
    expect(serialized).not.toContain('stdoutPreview')
    expect(compact.records.at(-1)?.recommendedActions).toEqual(['direct_edit'])
    expect(compact.records.at(-1)?.feedbackSummary).toContain('[truncated')
  })

  test('compacts monitorRecords inside priorLLMOutputs payloads', () => {
    const priorLLMOutputs = {
      trigger: { kind: 'turn-feedback', key: 'turn-feedback:1' },
      monitorRecords: Array.from({ length: 60 }, (_, index) =>
        monitorRecord(index),
      ),
    }
    const compacted = compactMatOSEvolutionPriorLLMOutputsForPrompt(
      priorLLMOutputs,
      { MATOS_EVOLUTION_PROMPT_MONITOR_RECORD_LIMIT: '5' },
    ) as Record<string, unknown>
    expect(compacted.trigger).toEqual(priorLLMOutputs.trigger)
    expect((compacted.monitorRecords as unknown[]).length).toBe(5)
    expect(compacted.elidedMonitorRecordCount).toBe(55)
    // Non-object payloads pass through untouched.
    expect(compactMatOSEvolutionPriorLLMOutputsForPrompt(undefined)).toBe(
      undefined,
    )
    expect(compactMatOSEvolutionPriorLLMOutputsForPrompt({ trigger: 1 })).toEqual(
      { trigger: 1 },
    )
  })
})
