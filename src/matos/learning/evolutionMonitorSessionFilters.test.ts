import { describe, expect, test } from 'bun:test'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import { shouldSkipTrivialSuccessfulSessionEvolution } from './evolutionMonitorSessionFilters.js'

function sourceEvent(
  id: string,
  type: MatOSEventSource['type'],
  data: Record<string, unknown>,
): MatOSEventSource {
  return {
    id,
    schemaVersion: 1,
    traceId: 'trace-filter-1',
    sessionId: 'session-filter-1',
    timestamp: '2026-06-05T00:00:00.000Z',
    roleRef: 'role:workspace',
    type,
    data,
    sourcePath: '/tmp/session-filter-1.jsonl',
  }
}

const sessionEndTrigger = {
  kind: 'session-end' as const,
  key: 'session-end:session-filter-1',
  summary: 'The session completed and should be checked for reusable experience.',
}

describe('MatOS trivial successful session filter', () => {
  test('benign zero-valued error counters do not defeat the trivial skip', () => {
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('started', 'matos.session.started', {
            command: 'matos workspace start',
          }),
          sourceEvent('doctor', 'matos.workspace.doctor.completed', {
            errorCount: 0,
            errors: [],
            failureRate: 0,
          }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(true)
  })

  test('structured failure signals still block the trivial skip', () => {
    const base = [
      sourceEvent('started', 'matos.session.started', {}),
      sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
    ]
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          ...base,
          sourceEvent('doctor-error', 'matos.workspace.doctor.completed', {
            isError: true,
          }),
        ],
      }),
    ).toBe(false)
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          ...base,
          sourceEvent('doctor-exit', 'matos.workspace.doctor.completed', {
            exitCode: 2,
          }),
        ],
      }),
    ).toBe(false)
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          ...base,
          sourceEvent('doctor-message', 'matos.workspace.doctor.completed', {
            error: 'workspace volume mount failed',
          }),
        ],
      }),
    ).toBe(false)
  })

  test('non-session-end triggers never skip', () => {
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:turn-1',
          summary: 'User feedback.',
        },
        events: [
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(false)
  })

  test('successful single-turn sessions with no signal skip (sentinel runs)', () => {
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn', 'matos.turn.started', {
            prompt: 'Reply with exactly: matos-openai-ok',
          }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(true)
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn', 'matos.turn.started', { prompt: '算个能带' }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(true)
  })

  test('expected-tool-guard outcomes defer to the quality gate instead of the silent trivial skip', () => {
    // A guard-blocked submit has no isError/error fields, but the quality
    // gate must get the chance to record its 'expected-tool-guard-only' skip.
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn', 'matos.turn.started', {
            prompt: 'Submit this exact prepared HPC task.',
          }),
          sourceEvent('tool', 'matos.tool.call.completed', {
            toolName: 'mcp__matos_asset__hpc_generate_yaml',
            isError: false,
            resultPreview:
              '{"ok":true,"submissionBlocked":{"errorKind":"active_task_collision","retryable":false}}',
          }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(false)
  })

  test('minimum-signal gate keeps learning-worthy sessions', () => {
    // Multi-turn sessions stay analyzed.
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn-1', 'matos.turn.started', { prompt: '算个能带' }),
          sourceEvent('turn-2', 'matos.turn.started', { prompt: '继续优化收敛' }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(false)
    // Failure signals stay analyzed.
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn', 'matos.turn.started', { prompt: '算个能带' }),
          sourceEvent('tool', 'matos.tool.call.completed', { isError: true }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(false)
    // Feedback-looking prompts stay analyzed even in a single turn.
    expect(
      shouldSkipTrivialSuccessfulSessionEvolution({
        trigger: sessionEndTrigger,
        events: [
          sourceEvent('turn', 'matos.turn.started', {
            prompt: '这里又报错了，修一下',
          }),
          sourceEvent('completed', 'matos.session.completed', { exitCode: 0 }),
        ],
      }),
    ).toBe(false)
  })
})
