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

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  classifyMatOSToolErrorKind,
  matOSEmbeddedToolErrorKindFromText,
  withMatOSToolCompletionErrorKind,
} from './toolErrorKind.js'
import { recordSdkLine, sdkMessageToMatOSEvents } from '../cli/run.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import type { MatOSEvent } from '../sessions/eventTypes.js'

function toolResultSdkMessage(input: {
  content: string
  isError: boolean
}): Record<string, unknown> {
  return {
    type: 'user',
    session_id: 'upstream-errorkind',
    uuid: 'user-errorkind-uuid',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_errorkind_1',
          content: input.content,
          is_error: input.isError,
        },
      ],
    },
  }
}

function completedEventData(
  events: ReturnType<typeof sdkMessageToMatOSEvents>,
): Record<string, unknown> {
  const completed = events.find(
    event => event.type === 'matos.tool.call.completed',
  )
  expect(completed).toBeDefined()
  return completed!.data as Record<string, unknown>
}

describe('MatOS tool errorKind classification', () => {
  test('extracts tool-embedded errorKind from JSON, nested blocks, and raw text', () => {
    expect(
      matOSEmbeddedToolErrorKindFromText(
        '{"ok":false,"errorKind":"scheduler_failure"}',
      ),
    ).toBe('scheduler_failure')
    expect(
      matOSEmbeddedToolErrorKindFromText(
        '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision"}}',
      ),
    ).toBe('active_task_collision')
    expect(
      matOSEmbeddedToolErrorKindFromText(
        'submit refused: {"errorKind":"active_task_collision","retryable":false}',
      ),
    ).toBe('active_task_collision')
    expect(matOSEmbeddedToolErrorKindFromText('plain failure text')).toBe(
      undefined,
    )
  })

  test('classifies from the structured error object before any text', () => {
    expect(
      classifyMatOSToolErrorKind({
        error: Object.assign(new Error('open failed'), { code: 'EACCES' }),
      }),
    ).toBe('permission-denied')
    expect(
      classifyMatOSToolErrorKind({
        error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
      }),
    ).toBe('not-found')
    expect(
      classifyMatOSToolErrorKind({
        error: Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }),
      }),
    ).toBe('timeout')
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    expect(classifyMatOSToolErrorKind({ error: abortError })).toBe('cancelled')
    expect(
      classifyMatOSToolErrorKind({
        error: Object.assign(new Error('api'), { status: 401 }),
      }),
    ).toBe('provider-auth')
  })

  test('classifies rendered error messages by pattern family', () => {
    const cases: Array<[string, string]> = [
      ['EACCES: permission denied, open \'/etc/shadow\'', 'permission-denied'],
      ['zsh: permission denied: ./run.sh', 'permission-denied'],
      ['No such tool available: FooTool', 'not-found'],
      ['/bin/sh: matlab: command not found', 'not-found'],
      ['ENOENT: no such file or directory, stat \'/x/y\'', 'not-found'],
      ['Command timed out after 2m 0.0s', 'timeout'],
      ['connect ETIMEDOUT 10.0.0.1:443', 'timeout'],
      ['InputValidationError: expected string, received number', 'invalid-args'],
      ['tool validation failed: path is required', 'invalid-args'],
      ['Invalid API key · Please run /login', 'provider-auth'],
      ['401 Unauthorized: authentication_error', 'provider-auth'],
      ['some completely novel breakage', 'unknown'],
    ]
    for (const [message, expected] of cases) {
      expect(classifyMatOSToolErrorKind({ error: message })).toBe(expected)
    }
  })

  test('tool-embedded errorKind wins over contradictory error text', () => {
    expect(
      classifyMatOSToolErrorKind({
        error: 'permission denied while submitting',
        resultText:
          '{"ok":false,"errorKind":"active_task_collision","retryable":false}',
      }),
    ).toBe('active_task_collision')
  })

  test('finds an embedded errorKind past the 500-char preview cutoff', () => {
    const longTail = `${'log line. '.repeat(80)}{"errorKind":"scheduler_failure","retryable":true}`
    expect(longTail.length).toBeGreaterThan(500)
    expect(classifyMatOSToolErrorKind({ resultText: longTail })).toBe(
      'scheduler_failure',
    )
  })

  test('structured wrapper flags classify denials and interrupts', () => {
    expect(
      classifyMatOSToolErrorKind({ denied: true, error: 'nope' }),
    ).toBe('permission-denied')
    expect(
      classifyMatOSToolErrorKind({ interrupted: true, error: 'stopped' }),
    ).toBe('cancelled')
  })

  test('withMatOSToolCompletionErrorKind enriches only failed completions', () => {
    const success = { isError: false, resultPreview: 'ok' }
    expect(withMatOSToolCompletionErrorKind(success)).toBe(success)

    const preClassified = { isError: true, errorKind: 'custom_kind' }
    expect(withMatOSToolCompletionErrorKind(preClassified)).toBe(preClassified)

    expect(
      withMatOSToolCompletionErrorKind({
        isError: true,
        error: 'InputValidationError: bad input',
      }),
    ).toMatchObject({ errorKind: 'invalid-args' })

    // The thrown error object outranks an unhelpful rendered message.
    expect(
      withMatOSToolCompletionErrorKind(
        { isError: true, error: 'boom' },
        Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }),
      ),
    ).toMatchObject({ errorKind: 'timeout' })

    expect(
      withMatOSToolCompletionErrorKind({ isError: true, error: 'boom' }),
    ).toMatchObject({ errorKind: 'unknown' })
  })

  test('sdk stream mapping records errorKind at the source for failing tool results', () => {
    const failing = sdkMessageToMatOSEvents(
      toolResultSdkMessage({
        content: "EACCES: permission denied, open '/root/protected'",
        isError: true,
      }),
    )
    expect(completedEventData(failing)).toMatchObject({
      isError: true,
      errorKind: 'permission-denied',
    })

    const success = sdkMessageToMatOSEvents(
      toolResultSdkMessage({ content: 'all good', isError: false }),
    )
    expect(completedEventData(success)).toMatchObject({ isError: false })
    expect(completedEventData(success)).not.toHaveProperty('errorKind')
  })

  test('sdk stream mapping classifies from the full result text, not the truncated preview', () => {
    const content = `${'noise '.repeat(100)}{"errorKind":"active_task_collision","retryable":false}`
    expect(content.length).toBeGreaterThan(500)
    const data = completedEventData(
      sdkMessageToMatOSEvents(toolResultSdkMessage({ content, isError: true })),
    )
    // The preview is truncated before the embedded errorKind appears, so only
    // recording-time classification over the full text can capture it.
    expect((data.resultPreview as string).length).toBe(500)
    expect(data.resultPreview as string).not.toContain('errorKind')
    expect(data.errorKind).toBe('active_task_collision')
  })

  test('real event recorder persists the source-classified errorKind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-errorkind-recorder-'))
    const previousDisable = process.env.MATOS_DISABLE_EVOLUTION
    process.env.MATOS_DISABLE_EVOLUTION = '1'
    try {
      const recorder = await createMatOSEventRecorder(root, {
        sessionId: 'session-errorkind-source',
        command: 'matos-test',
        cwd: root,
        suppressSessionStarted: true,
      })
      await recordSdkLine(
        JSON.stringify(
          toolResultSdkMessage({
            content: 'Error: connect ETIMEDOUT 10.1.2.3:443',
            isError: true,
          }),
        ),
        recorder,
      )
      const raw = await readFile(recorder.path, 'utf8')
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as MatOSEvent)
      const completed = events.find(
        event => event.type === 'matos.tool.call.completed',
      )
      expect(completed?.data).toMatchObject({
        isError: true,
        errorKind: 'timeout',
      })
    } finally {
      if (previousDisable === undefined) {
        delete process.env.MATOS_DISABLE_EVOLUTION
      } else {
        process.env.MATOS_DISABLE_EVOLUTION = previousDisable
      }
    }
  })
})
