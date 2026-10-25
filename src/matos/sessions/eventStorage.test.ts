import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { createMatOSEventRecorder } from './eventRecorder.js'
import {
  appendMatOSSessionEvent,
  serializeBoundedMatOSSessionEvent,
  sweepStaleMatOSSessionAppendResidue,
} from './eventStorage.js'
import type { MatOSEvent } from './eventTypes.js'
import {
  listMatOSSessions,
  listMatOSSessionsFromDir,
  readMatOSSessionEvents,
} from './sessionIndex.js'
import { recordMatOSTraceEventFromEnv } from './traceBridge.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function baseEvent(overrides: Partial<MatOSEvent> = {}): MatOSEvent {
  return {
    id: 'event-storage-1',
    schemaVersion: 1,
    traceId: 'trace-storage-1',
    sessionId: 'session-storage-1',
    timestamp: '2026-08-13T00:00:00.000Z',
    type: 'matos.turn.started',
    data: {},
    ...overrides,
  }
}

describe('MatOS session event storage', () => {
  test('bounds oversized records by compacting data and preserving the envelope', () => {
    const compacted = JSON.parse(
      serializeBoundedMatOSSessionEvent(
        baseEvent({ data: { blob: 'x'.repeat(10_000), keep: 7 } }),
        8192,
      ),
    ) as MatOSEvent
    expect(compacted.type).toBe('matos.turn.started')
    expect(compacted.sessionId).toBe('session-storage-1')
    expect(compacted.data.storageTruncated).toBe(true)
    expect(compacted.data.keep).toBe(7)
    expect(String(compacted.data.blob).length).toBeLessThan(10_000)
    expect(String(compacted.data.blob)).toContain('[truncated')
    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(
      8192,
    )

    // Data that stays oversized even after compaction degrades to an
    // envelope-only record with a short preview instead of an unbounded line.
    const fallback = JSON.parse(
      serializeBoundedMatOSSessionEvent(
        baseEvent({ data: { blob: 'y'.repeat(5000) } }),
        2048,
      ),
    ) as MatOSEvent
    expect(fallback.type).toBe('matos.turn.started')
    expect(fallback.sessionId).toBe('session-storage-1')
    expect(fallback.data.storageTruncated).toBe(true)
    expect(typeof fallback.data.originalDataBytes).toBe('number')
    expect(String(fallback.data.preview).length).toBeLessThanOrEqual(2048)
  })

  test('recorder persists an oversized event as a bounded parseable line', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-oversize-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run probe',
      cwd: root,
    })
    await recorder.record({
      type: 'matos.turn.started',
      data: { prompt: 'p'.repeat(1024 * 1024) },
    })

    const raw = await readFile(recorder.path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(256 * 1024)
      expect(() => JSON.parse(line)).not.toThrow()
    }
    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    const turn = events.find(event => event.type === 'matos.turn.started')
    expect(turn?.data.storageTruncated).toBe(true)
    expect(String(turn?.data.prompt)).toContain('[truncated')
  })

  test('concurrent in-process writers do not interleave or lose records', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-concurrent-'))
    const sessionsDir = join(root, 'sessions')
    process.env.MATOS_SESSION_DIR = sessionsDir
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run probe',
      cwd: root,
      sessionId: 'session-concurrent-1',
      traceId: 'trace-concurrent-1',
    })
    process.env.MATOS_TRACE_ID = 'trace-concurrent-1'
    process.env.MATOS_SESSION_ID = 'session-concurrent-1'

    await Promise.all([
      ...Array.from({ length: 60 }, (_, index) =>
        recorder.record({
          type: 'matos.tool.call.started',
          data: { toolUseId: `recorder-${index}`, filler: 'f'.repeat(256) },
        }),
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        recordMatOSTraceEventFromEnv(
          {
            type: 'matos.tool.call.completed',
            data: { toolUseId: `bridge-${index}`, filler: 'g'.repeat(256) },
          },
          root,
        ),
      ),
    ])

    const raw = await readFile(recorder.path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(101)
    const ids = new Set<string>()
    const toolUseIds = new Set<string>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as MatOSEvent
      expect(typeof parsed.type).toBe('string')
      ids.add(parsed.id)
      const toolUseId = parsed.data?.toolUseId
      if (typeof toolUseId === 'string') {
        toolUseIds.add(toolUseId)
      }
    }
    expect(ids.size).toBe(101)
    expect(toolUseIds.size).toBe(100)
  })

  test('forced always-lock mode still serializes concurrent writers', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    process.env.MATOS_SESSION_APPEND_LOCK = 'always'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-alwayslock-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run probe',
      cwd: root,
    })
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        recorder.record({
          type: 'matos.tool.call.started',
          data: { toolUseId: `locked-${index}` },
        }),
      ),
    )
    const raw = await readFile(recorder.path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(31)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // Always-lock mode never creates writer registries.
    const entries = await readdir(join(root, '.matos', 'sessions'))
    expect(entries.some(name => name.endsWith('.writers'))).toBe(false)
  })

  test('solo writer probes the registry and garbage-collects dead stale writers', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-stale-'))
    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const sessionId = 'session-stale-1'
    const registryDir = join(sessionsDir, `${sessionId}.jsonl.writers`)
    await mkdir(registryDir, { recursive: true })
    // Dead pid (beyond default pid_max) with a 10-minute-old heartbeat.
    const staleSentinel = join(registryDir, '9999999.deadbeef.writer')
    await writeFile(staleSentinel, '9999999 2026-08-13T00:00:00.000Z\n', 'utf8')
    const past = new Date(Date.now() - 10 * 60_000)
    await utimes(staleSentinel, past, past)

    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run probe',
      cwd: root,
      sessionId,
    })
    await recorder.record({ type: 'matos.turn.started', data: { prompt: 'x' } })

    const names = await readdir(registryDir)
    expect(names).not.toContain('9999999.deadbeef.writer')
    expect(names.filter(name => name.endsWith('.writer'))).toHaveLength(1)
    const events = await readMatOSSessionEvents(root, sessionId)
    expect(events.map(event => event.type)).toEqual([
      'matos.session.started',
      'matos.turn.started',
    ])
  })

  test('uncontended fast path is materially cheaper than always-lock appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-bench-'))
    await mkdir(join(root, 'sessions'), { recursive: true })
    const fastPath = join(root, 'sessions', 'bench-fast.jsonl')
    const lockedPath = join(root, 'sessions', 'bench-locked.jsonl')
    const autoEnv: Record<string, string | undefined> = {}
    const lockedEnv: Record<string, string | undefined> = {
      MATOS_SESSION_APPEND_LOCK: 'always',
    }
    const event = (index: number): MatOSEvent =>
      baseEvent({
        id: `bench-${index}`,
        type: 'matos.tool.call.started',
        data: { toolUseId: `bench-${index}`, filler: 'b'.repeat(400) },
      })

    // Warm both paths (registration, file creation) outside the measurement.
    await appendMatOSSessionEvent(fastPath, event(-1), autoEnv)
    await appendMatOSSessionEvent(lockedPath, event(-1), lockedEnv)

    // Interleave measured blocks so host load drift hits both paths equally.
    const rounds = 4
    const perRound = 25
    let fastTotalMs = 0
    let lockedTotalMs = 0
    for (let round = 0; round < rounds; round += 1) {
      let t0 = Bun.nanoseconds()
      for (let index = 0; index < perRound; index += 1) {
        await appendMatOSSessionEvent(lockedPath, event(round * perRound + index), lockedEnv)
      }
      lockedTotalMs += (Bun.nanoseconds() - t0) / 1e6
      t0 = Bun.nanoseconds()
      for (let index = 0; index < perRound; index += 1) {
        await appendMatOSSessionEvent(fastPath, event(round * perRound + index), autoEnv)
      }
      fastTotalMs += (Bun.nanoseconds() - t0) / 1e6
    }
    const appends = rounds * perRound
    console.log(
      `[bench] uncontended append: fast=${(fastTotalMs / appends).toFixed(3)}ms/append ` +
        `always-lock=${(lockedTotalMs / appends).toFixed(3)}ms/append ` +
        `(${appends} appends each, ratio ${(lockedTotalMs / fastTotalMs).toFixed(2)}x)`,
    )

    // Both files stayed valid JSONL with every record present.
    for (const [path, label] of [
      [fastPath, 'fast'],
      [lockedPath, 'locked'],
    ] as const) {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
      expect(lines).toHaveLength(appends + 1)
      for (const line of lines) {
        expect(() => JSON.parse(line), `${label} line parse`).not.toThrow()
      }
    }

    // The fast path drops two metadata mutations per append; require a
    // conservative margin so host load noise cannot flake the assertion.
    expect(fastTotalMs).toBeLessThan(lockedTotalMs * 0.9)
  }, 60_000)

  test('concurrent cross-process appenders keep every record parseable', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-multiproc-'))
    const sessionsDir = join(root, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    process.env.MATOS_SESSION_DIR = sessionsDir
    const sessionId = 'session-multiproc-1'
    const traceId = 'trace-multiproc-1'
    const childCount = 2
    const perChild = 25
    const soloParentEvents = 10

    const bridgePath = fileURLToPath(new URL('./traceBridge.ts', import.meta.url))
    const worktreeRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const scriptPath = join(root, 'child-appender.ts')
    await writeFile(
      scriptPath,
      [
        `const { recordMatOSTraceEventFromEnv } = await import(${JSON.stringify(bridgePath)})`,
        'const count = Number(process.argv[2])',
        'const label = process.argv[3]',
        'for (let index = 0; index < count; index += 1) {',
        '  const ok = await recordMatOSTraceEventFromEnv({',
        "    type: 'matos.tool.call.completed',",
        "    data: { toolUseId: `${label}-${index}`, toolName: 'Probe', filler: 'h'.repeat(300) },",
        '  })',
        '  if (!ok) {',
        '    console.error(`append ${label}-${index} failed`)',
        '    process.exit(1)',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    )

    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run multiproc-probe',
      cwd: root,
      sessionId,
      traceId,
    })
    // Phase A: parent writes alone first, so it is a solo incumbent on the
    // unlocked fast path when the children join mid-stream.
    for (let index = 0; index < soloParentEvents; index += 1) {
      await recorder.record({
        type: 'matos.tool.call.started',
        data: { toolUseId: `parent-solo-${index}`, filler: 'p'.repeat(300) },
      })
    }

    // Phase B: children join (joiner grace + locked appends) while the parent
    // keeps appending concurrently; the parent must flip to locked mode via
    // its per-append registry probe without corrupting a single record.
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      MATOS_SESSION_DIR: sessionsDir,
      MATOS_TRACE_ID: traceId,
      MATOS_SESSION_ID: sessionId,
      MATOS_EVOLUTION_PROVIDER: 'off',
    }
    const children = Array.from({ length: childCount }, (_, index) =>
      Bun.spawn({
        cmd: [process.execPath, scriptPath, String(perChild), `child${index}`],
        cwd: worktreeRoot,
        env: childEnv,
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    )
    // The parent keeps appending until both children have exited, so parent
    // writes overlap the children's whole append phase (spawn + joiner grace
    // included), not just its beginning.
    let childrenDone = false
    const childrenExited = Promise.all(children.map(child => child.exited)).then(
      () => {
        childrenDone = true
      },
    )
    let parentSharedEvents = 0
    while (!childrenDone && parentSharedEvents < 400) {
      await recorder.record({
        type: 'matos.tool.call.started',
        data: {
          toolUseId: `parent-shared-${parentSharedEvents}`,
          filler: 'p'.repeat(300),
        },
      })
      parentSharedEvents += 1
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    await childrenExited
    for (const child of children) {
      expect(await child.exited).toBe(0)
    }
    expect(parentSharedEvents).toBeGreaterThan(0)

    const raw = await readFile(recorder.path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(
      1 + soloParentEvents + parentSharedEvents + childCount * perChild,
    )
    const toolUseIds = new Set<string>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as MatOSEvent
      expect(typeof parsed.type).toBe('string')
      expect(parsed.sessionId).toBe(sessionId)
      const toolUseId = parsed.data?.toolUseId
      if (typeof toolUseId === 'string') {
        toolUseIds.add(toolUseId)
      }
    }
    for (let index = 0; index < soloParentEvents; index += 1) {
      expect(toolUseIds.has(`parent-solo-${index}`)).toBe(true)
    }
    for (let index = 0; index < parentSharedEvents; index += 1) {
      expect(toolUseIds.has(`parent-shared-${index}`)).toBe(true)
    }
    for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
      for (let index = 0; index < perChild; index += 1) {
        expect(toolUseIds.has(`child${childIndex}-${index}`)).toBe(true)
      }
    }

    // Registry hygiene: gracefully exited children unlinked their sentinels;
    // only this (still running) parent process remains registered.
    const registryNames = await readdir(`${recorder.path}.writers`)
    expect(registryNames.filter(name => name.endsWith('.writer'))).toHaveLength(1)
  }, 30_000)

  test('caps runaway file growth with one marker while keeping lifecycle events', async () => {
    process.env.MATOS_EVOLUTION_PROVIDER = 'off'
    process.env.MATOS_SESSION_FILE_MAX_BYTES = '900'
    const root = await mkdtemp(join(tmpdir(), 'matos-event-storage-cap-'))
    const recorder = await createMatOSEventRecorder(root, {
      command: 'matos run cap-probe',
      cwd: root,
    })
    for (let index = 0; index < 10; index += 1) {
      await recorder.record({
        type: 'matos.turn.started',
        data: { prompt: 'p'.repeat(120), index },
      })
    }
    await recorder.record({
      type: 'matos.session.completed',
      data: { exitCode: 0 },
    })

    const events = await readMatOSSessionEvents(root, recorder.sessionId)
    const types = events.map(event => event.type)
    expect(types[0]).toBe('matos.session.started')
    expect(types.at(-1)).toBe('matos.session.completed')
    expect(types.filter(type => type === 'matos.session.storage.capped')).toHaveLength(
      1,
    )
    expect(types.filter(type => type === 'matos.turn.started').length).toBeLessThan(
      10,
    )
    const marker = events.find(
      event => event.type === 'matos.session.storage.capped',
    )
    expect(marker?.sessionId).toBe(recorder.sessionId)
    expect(marker?.data.maxFileBytes).toBe(900)
    expect(marker?.data.firstDroppedEventType).toBe('matos.turn.started')

    const sessions = await listMatOSSessions(root)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.status).toBe('completed')
  })

  test('sweeps orphaned append locks and dead writer registries without touching live ones', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'matos-event-storage-sweep-'))
    const oldTime = new Date(Date.now() - 60 * 60_000)
    // A pid above the Linux pid_max ceiling (2^22) that can never be alive.
    const deadPid = 99_999_999

    // Crash residue: lock dir orphaned by a writer that died mid-append.
    const orphanLock = join(sessionsDir, 'crashed.jsonl.lock')
    await mkdir(orphanLock)
    await utimes(orphanLock, oldTime, oldTime)

    // A fresh lock dir could be held by a live append right now.
    const freshLock = join(sessionsDir, 'active.jsonl.lock')
    await mkdir(freshLock)

    // Dead writer registry: stale heartbeat AND dead pid.
    const deadRegistry = join(sessionsDir, 'crashed.jsonl.writers')
    await mkdir(deadRegistry)
    const deadSentinel = join(deadRegistry, `${deadPid}.aaaa.writer`)
    await writeFile(deadSentinel, `${deadPid} stale\n`, 'utf8')
    await utimes(deadSentinel, oldTime, oldTime)
    await utimes(deadRegistry, oldTime, oldTime)

    // Stale heartbeat but the pid (this test process) is visibly alive: the
    // registry must survive, matching the append path's liveness rule.
    const suspendedRegistry = join(sessionsDir, 'suspended.jsonl.writers')
    await mkdir(suspendedRegistry)
    const suspendedSentinel = join(suspendedRegistry, `${process.pid}.bbbb.writer`)
    await writeFile(suspendedSentinel, `${process.pid} stale\n`, 'utf8')
    await utimes(suspendedSentinel, oldTime, oldTime)
    await utimes(suspendedRegistry, oldTime, oldTime)

    // Fresh heartbeat (e.g. a container-side writer in another pid
    // namespace): kept even though its pid is not visible here.
    const heartbeatRegistry = join(sessionsDir, 'heartbeat.jsonl.writers')
    await mkdir(heartbeatRegistry)
    await writeFile(
      join(heartbeatRegistry, `${deadPid - 1}.cccc.writer`),
      `${deadPid - 1} fresh\n`,
      'utf8',
    )
    await utimes(heartbeatRegistry, oldTime, oldTime)

    const result = await sweepStaleMatOSSessionAppendResidue(sessionsDir)
    expect(result.removedLockDirs).toEqual(['crashed.jsonl.lock'])
    expect(result.removedWriterDirs).toEqual(['crashed.jsonl.writers'])
    expect(result.removedSentinels).toBe(1)

    const remaining = new Set(await readdir(sessionsDir))
    expect(remaining.has('crashed.jsonl.lock')).toBe(false)
    expect(remaining.has('crashed.jsonl.writers')).toBe(false)
    expect(remaining.has('active.jsonl.lock')).toBe(true)
    expect(remaining.has('suspended.jsonl.writers')).toBe(true)
    expect(remaining.has('heartbeat.jsonl.writers')).toBe(true)

    // Second pass changes nothing: the sweep is idempotent and the survivors
    // are all gated as live/fresh.
    const secondPass = await sweepStaleMatOSSessionAppendResidue(sessionsDir)
    expect(secondPass.removedLockDirs).toEqual([])
    expect(secondPass.removedWriterDirs).toEqual([])
  })

  test('residue sweep is bounded per run and triggered off session listings', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'matos-event-storage-sweep-bound-'))
    const oldTime = new Date(Date.now() - 60 * 60_000)
    for (const name of ['a.jsonl.lock', 'b.jsonl.lock', 'c.jsonl.lock']) {
      const lockDir = join(sessionsDir, name)
      await mkdir(lockDir)
      await utimes(lockDir, oldTime, oldTime)
    }

    const bounded = await sweepStaleMatOSSessionAppendResidue(sessionsDir, {
      maxEntries: 2,
    })
    expect(bounded.scannedEntries).toBe(2)
    expect(bounded.removedLockDirs).toHaveLength(2)

    // Listing a sessions directory reclaims the rest in the background.
    await writeFile(join(sessionsDir, 'real.jsonl'), '', 'utf8')
    const sessions = await listMatOSSessionsFromDir(sessionsDir)
    expect(sessions).toHaveLength(1)
    const deadline = Date.now() + 5_000
    let names = await readdir(sessionsDir)
    while (
      names.some(name => name.endsWith('.jsonl.lock')) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 50))
      names = await readdir(sessionsDir)
    }
    expect(names.some(name => name.endsWith('.jsonl.lock'))).toBe(false)
  })
})
