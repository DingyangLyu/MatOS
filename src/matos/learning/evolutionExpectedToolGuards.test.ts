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
import type { MatOSEvent } from '../sessions/eventTypes.js'
import {
  isMatOSExpectedToolGuardEvent,
  matOSExpectedToolGuardErrorKind,
} from './evolutionExpectedToolGuards.js'
import { classifySelfEvolutionTrigger } from './evolutionMonitor.js'

function toolCompletedEvent(data: Record<string, unknown>): MatOSEvent {
  return {
    id: 'event-guard-1',
    schemaVersion: 1,
    traceId: 'trace-guard-1',
    sessionId: 'session-guard-1',
    timestamp: '2026-08-13T00:00:00.000Z',
    type: 'matos.tool.call.completed',
    data,
  }
}

describe('MatOS expected tool guard errorKind resolution', () => {
  test('prefers the structured data.errorKind over contradictory rendered text', () => {
    const event = toolCompletedEvent({
      toolName: 'mcp__matos_asset__hpc_submit',
      isError: true,
      errorKind: 'active_task_collision',
      // Contradictory legacy text: without the structured field this would
      // classify as scheduler_failure and NOT be guarded.
      resultPreview: '{"ok":false,"errorKind":"scheduler_failure"}',
    })
    expect(matOSExpectedToolGuardErrorKind(event)).toBe('active_task_collision')
    expect(isMatOSExpectedToolGuardEvent(event)).toBe(true)
    // The guard suppresses the tool-failure evolution trigger end to end.
    expect(classifySelfEvolutionTrigger(event, [event])).toBeUndefined()
  })

  test('structured errorKind wins even when text embeds a guarded kind', () => {
    const event = toolCompletedEvent({
      toolName: 'Bash',
      isError: true,
      errorKind: 'unknown',
      resultPreview:
        '{"ok":false,"errorKind":"active_task_collision","retryable":false}',
    })
    expect(matOSExpectedToolGuardErrorKind(event)).toBe('unknown')
    expect(isMatOSExpectedToolGuardEvent(event)).toBe(false)
    expect(classifySelfEvolutionTrigger(event, [event])).toMatchObject({
      kind: 'tool-failure',
    })
  })

  test('source-classified actionable kinds are not treated as expected guards', () => {
    for (const errorKind of [
      'permission-denied',
      'not-found',
      'timeout',
      'invalid-args',
      'provider-auth',
      'unknown',
    ]) {
      const event = toolCompletedEvent({
        toolName: 'Bash',
        isError: true,
        errorKind,
        resultPreview: 'rendered failure text',
      })
      expect(isMatOSExpectedToolGuardEvent(event)).toBe(false)
      expect(classifySelfEvolutionTrigger(event, [event])).toMatchObject({
        kind: 'tool-failure',
      })
    }
  })

  test('legacy events without structured errorKind still classify via rendered text', () => {
    const topLevelJson = toolCompletedEvent({
      isError: true,
      resultPreview:
        '{"ok":false,"errorKind":"active_task_collision","retryable":false}',
    })
    expect(matOSExpectedToolGuardErrorKind(topLevelJson)).toBe(
      'active_task_collision',
    )
    expect(isMatOSExpectedToolGuardEvent(topLevelJson)).toBe(true)

    const nestedBlock = toolCompletedEvent({
      isError: false,
      resultPreview:
        '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision"}}',
    })
    expect(matOSExpectedToolGuardErrorKind(nestedBlock)).toBe(
      'active_task_collision',
    )
    expect(isMatOSExpectedToolGuardEvent(nestedBlock)).toBe(true)

    const regexFallback = toolCompletedEvent({
      isError: true,
      error:
        'submit refused: {"errorKind": "active_task_collision", "retryable": false}',
    })
    expect(matOSExpectedToolGuardErrorKind(regexFallback)).toBe(
      'active_task_collision',
    )
    expect(isMatOSExpectedToolGuardEvent(regexFallback)).toBe(true)

    const outputPreviewField = toolCompletedEvent({
      isError: true,
      outputPreview: '{"errorKind":"active_task_collision"}',
    })
    expect(matOSExpectedToolGuardErrorKind(outputPreviewField)).toBe(
      'active_task_collision',
    )

    const noKind = toolCompletedEvent({
      isError: true,
      resultPreview: 'unexpected parser crash',
    })
    expect(matOSExpectedToolGuardErrorKind(noKind)).toBeUndefined()
    expect(isMatOSExpectedToolGuardEvent(noKind)).toBe(false)
  })
})
