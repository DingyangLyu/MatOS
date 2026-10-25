import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createMatOSEventRecorder } from './eventRecorder.js'
import {
  listMatOSSessions,
  listMatOSSessionsFromDir,
  readMatOSSessionEvents,
  readMatOSSessionEventSources,
  readMatOSSessionEventsFromPath,
} from './sessionIndex.js'
import { recordMatOSTraceEventFromEnv } from './traceBridge.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('MatOS sessions', () => {
  test('writes append-only session events and reads them back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run "hello"',
      cwd: root,
    })

    await recorder.record({
      type: 'matos.turn.started',
      data: { prompt: 'hello' },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0 },
    })
    await recorder.close()

    const sessions = await listMatOSSessions(root)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe(recorder.sessionId)

    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    expect(events.map(event => event.type)).toEqual([
      'matos.session.started',
      'matos.turn.started',
      'matos.session.completed',
    ])
  })

  test('does not derive legacy learning signal events during recording', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-self-evolution-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run "fix this"',
      cwd: root,
      traceId: 'trace-self-evolution-no-signals',
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: {
        prompt: '不对，应该使用 /workspace/group/shared/input.json，然后没问题',
      },
    })
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0 },
    })
    await recorder.close()

    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    expect(events.map(event => event.type)).toEqual([
      'matos.session.started',
      'matos.turn.started',
      'matos.session.completed',
    ])
    expect(
      events.some(event => (event.type as string) === 'matos.learning.signal'),
    ).toBe(false)
  })

  test('uses MATOS_SESSION_DIR for scope-owned container session records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-env-'))
    const sessionDir = join(root, 'scope-sessions')
    process.env.MATOS_SESSION_DIR = sessionDir

    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run "hello"',
      cwd: root,
    })
    await recorder.record({
      type: 'matos.turn.completed',
      data: { exitCode: 0 },
    })

    expect(recorder.path.startsWith(sessionDir)).toBe(true)
    const sessions = await listMatOSSessions(root)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.path.startsWith(sessionDir)).toBe(true)
    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    expect(events.map(event => event.type)).toEqual([
      'matos.session.started',
      'matos.turn.completed',
    ])
  })

  test('adds trace metadata and redacts sensitive event payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-trace-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run --role compute "hello"',
      cwd: root,
      traceId: 'trace-release-1',
      userId: 'alice',
      scopeRef: 'user:alice',
      runtimeRef: 'runtime:matos-agent-lite',
      execution: 'container',
      roleRef: 'role:compute',
    })

    await recorder.record({
      type: 'matos.tool.call.started',
      data: {
        toolName: 'submit_job',
        input: {
          material: 'Si',
          ANTHROPIC_AUTH_TOKEN: 'secret-token',
          nested: {
            apiKey: 'secret-key',
            keep: 'visible',
          },
        },
      },
    })

    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      traceId: 'trace-release-1',
      sessionId: recorder.sessionId,
      userId: 'alice',
      scopeRef: 'user:alice',
      runtimeRef: 'runtime:matos-agent-lite',
      execution: 'container',
      roleRef: 'role:compute',
    })
    expect(recorder.traceContext).toMatchObject({
      traceId: 'trace-release-1',
      sessionId: recorder.sessionId,
      userId: 'alice',
    })
    expect(recorder.traceEnv.MATOS_TRACE_ID).toBe('trace-release-1')
    expect(recorder.traceEnv.MATOS_PARENT_SESSION_ID).toBe(recorder.sessionId)

    const toolEvent = events.find(event => event.type === 'matos.tool.call.started')
    expect(toolEvent?.data).toEqual({
      toolName: 'submit_job',
      input: {
        material: 'Si',
        ANTHROPIC_AUTH_TOKEN: '[redacted]',
        nested: {
          apiKey: '[redacted]',
          keep: 'visible',
        },
      },
    })
  })

  test('counts duplicated tool start records by unique toolUseId in summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-sessions-tool-count-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run probe',
      cwd: root,
    })

    await recorder.record({
      type: 'matos.tool.call.started',
      data: {
        source: 'sdk-stream',
        toolUseId: 'toolu-1',
        toolName: 'Read',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.started',
      data: {
        source: 'cmatos.toolExecution',
        toolUseId: 'toolu-1',
        toolName: 'Read',
      },
    })
    await recorder.record({
      type: 'matos.tool.call.completed',
      data: {
        toolUseId: 'toolu-1',
        toolName: 'Read',
      },
    })
    await recorder.close()

    const [summary] = await listMatOSSessions(root)
    expect(summary?.toolCallCount).toBe(1)
  })

  test('appends trace events from inherited MatOS runtime environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-bridge-'))
    const sessionDir = join(root, 'sessions')
    process.env.MATOS_SESSION_DIR = sessionDir
    process.env.MATOS_TRACE_ID = 'trace-bridge-1'
    process.env.MATOS_SESSION_ID = 'session-bridge-1'
    process.env.MATOS_USER_ID = 'alice'
    process.env.MATOS_SCOPE_ID = 'user:alice'
    process.env.MATOS_ROLE_REF = 'role:compute'

    await recordMatOSTraceEventFromEnv({
      type: 'matos.transcript.linked',
      data: {
        transcriptPath: '/tmp/transcript.jsonl',
        newMessageCount: 2,
      },
    })
    await recordMatOSTraceEventFromEnv({
      type: 'matos.tool.call.completed',
      data: {
        toolUseId: 'toolu_1',
        toolName: 'Read',
        isError: false,
        durationMs: 12,
      },
    })

    const events = await readMatOSSessionEvents(root, 'session-bridge-1')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      traceId: 'trace-bridge-1',
      sessionId: 'session-bridge-1',
      userId: 'alice',
      scopeRef: 'user:alice',
      roleRef: 'role:compute',
      type: 'matos.transcript.linked',
      data: {
        transcriptPath: '/tmp/transcript.jsonl',
        newMessageCount: 2,
      },
    })
    expect(events[1]).toMatchObject({
      type: 'matos.tool.call.completed',
      data: {
        toolUseId: 'toolu_1',
        toolName: 'Read',
        isError: false,
        durationMs: 12,
      },
    })
  })

  test('does not derive legacy learning events from inherited trace events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-bridge-no-signals-'))
    const sessionDir = join(root, 'sessions')
    process.env.MATOS_SESSION_DIR = sessionDir
    process.env.MATOS_TRACE_ID = 'trace-bridge-no-signals'
    process.env.MATOS_SESSION_ID = 'session-bridge-no-signals'

    await recordMatOSTraceEventFromEnv({
      type: 'matos.turn.started',
      data: {
        prompt: '没问题，使用 /workspace/group/shared/example.json',
      },
    })

    const events = await readMatOSSessionEvents(root, 'session-bridge-no-signals')
    expect(events.map(event => event.type)).toEqual(['matos.turn.started'])
  })

  test('does not fail runtime work when inherited trace storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-bridge-fail-'))
    const sessionFile = join(root, 'sessions-as-file')
    await writeFile(sessionFile, '', 'utf8')
    process.env.MATOS_SESSION_DIR = sessionFile
    process.env.MATOS_TRACE_ID = 'trace-bridge-fail-1'
    process.env.MATOS_SESSION_ID = 'session-bridge-fail-1'

    await expect(
      recordMatOSTraceEventFromEnv({
        type: 'matos.tool.call.started',
        data: { toolName: 'Read' },
      }),
    ).resolves.toBe(false)
  })

  test('reader survives truncated tails, interleaved corrupt lines, and non-event JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-corrupt-'))
    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const path = join(sessionsDir, 'session-corrupt-1.jsonl')
    const started = JSON.stringify({
      id: 'e1',
      sessionId: 'session-corrupt-1',
      timestamp: '2026-08-13T00:00:00.000Z',
      type: 'matos.session.started',
      data: { command: 'matos run probe', cwd: '/workspace/group/shared' },
    })
    const tool = JSON.stringify({
      id: 'e2',
      sessionId: 'session-corrupt-1',
      timestamp: '2026-08-13T00:00:01.000Z',
      type: 'matos.tool.call.started',
      // intentionally no data field: shape damage that still parses as JSON
    })
    const completed = JSON.stringify({
      id: 'e3',
      sessionId: 'session-corrupt-1',
      timestamp: '2026-08-13T00:00:02.000Z',
      type: 'matos.session.completed',
      data: { exitCode: 0 },
    })
    // Two half-records spliced onto one line (observed corruption mode for
    // concurrent O_APPEND writers on FUSE-backed vePFS), JSON-parseable
    // non-events, and a truncated final line without newline.
    const interleaved = `${started.slice(0, 40)}${completed.slice(0, 30)}`
    // A crashed writer on FUSE-backed storage can also leave NUL padding:
    // one record with a NUL-run glued to it, and a pure NUL tail line.
    await writeFile(
      path,
      [
        started,
        'null',
        '42',
        '"loose string"',
        '{}',
        '{"type":123}',
        interleaved,
        tool,
        `${JSON.stringify({
          id: 'e2b',
          sessionId: 'session-corrupt-1',
          timestamp: '2026-08-13T00:00:01.500Z',
          type: 'matos.turn.started',
          data: {},
        })}\u0000\u0000\u0000`,
        completed,
        `${completed.slice(0, 25)}\u0000\u0000\u0000\u0000`,
      ].join('\n'),
      'utf8',
    )

    const events = await readMatOSSessionEventsFromPath(path)
    expect(events.map(event => event.type)).toEqual([
      'matos.session.started',
      'matos.tool.call.started',
      // NUL-padded but otherwise complete record is salvaged, not dropped.
      'matos.turn.started',
      'matos.session.completed',
    ])
    expect(events[1]?.data).toEqual({})

    const sessions = await listMatOSSessionsFromDir(sessionsDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-corrupt-1',
      eventCount: 4,
      turnCount: 1,
      status: 'completed',
      toolCallCount: 1,
    })

    const sources = await readMatOSSessionEventSources(
      sessions,
      'session-corrupt-1',
    )
    expect(sources).toHaveLength(4)
  })

  test('secret-looking values never land in the persisted session file', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    const root = await mkdtemp(join(tmpdir(), 'matos-session-secret-scan-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run --api-key=super-secret-cli-value probe',
      cwd: root,
      userId: 'alice',
      scopeRef: 'user:alice',
      runtimeRef: 'runtime:matos-openvscode-stable',
      execution: 'local',
      roleRef: 'role:compute',
    })
    await recorder.record({
      type: 'matos.tool.call.started',
      data: {
        toolName: 'submit_job',
        ANTHROPIC_AUTH_TOKEN: 'secret-token-value-1',
        note: 'auth used Bearer AbCdEfGhIjKlMnOpQr012345',
        config: 'password=hunter2secret',
        apiEnv: { OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwx1234' },
      },
    })

    const raw = await readFile(recorder.path, 'utf8')
    for (const secret of [
      'super-secret-cli-value',
      'secret-token-value-1',
      'AbCdEfGhIjKlMnOpQr012345',
      'hunter2secret',
      'sk-abcdefghijklmnopqrstuvwx1234',
    ]) {
      expect(raw).not.toContain(secret)
    }

    // Trace context propagates to children through non-secret MATOS_* env only.
    expect(recorder.traceEnv).toMatchObject({
      MATOS_TRACE_ID: recorder.traceId,
      MATOS_SESSION_ID: recorder.sessionId,
      MATOS_USER_ID: 'alice',
      MATOS_SCOPE_ID: 'user:alice',
      MATOS_RUNTIME_PROFILE_REF: 'runtime:matos-openvscode-stable',
      MATOS_EXECUTION: 'local',
      MATOS_ROLE_REF: 'role:compute',
    })
    for (const [key, value] of Object.entries(recorder.traceEnv)) {
      expect(key.startsWith('MATOS_')).toBe(true)
      expect(
        /(token|secret|password|api[-_]?key|credential)/i.test(key),
      ).toBe(false)
      expect(value).not.toContain('secret-token')
    }
  })

  test('can append to an inherited trace without repeating session.started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-session-inherited-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run inner',
      cwd: root,
      traceId: 'trace-inherited-1',
      sessionId: 'session-inherited-1',
      suppressSessionStarted: true,
    })

    await recorder.record({
      type: 'matos.turn.started',
      traceContext: { turnId: 'turn-inherited-1' },
      data: { prompt: 'inner' },
    })

    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    expect(events.map(event => event.type)).toEqual(['matos.turn.started'])
    expect(events[0]).toMatchObject({
      sessionId: 'session-inherited-1',
      traceId: 'trace-inherited-1',
      turnId: 'turn-inherited-1',
    })
  })
})
