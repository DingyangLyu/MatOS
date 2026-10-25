import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatRunService } from '../../src/runtimes/runs.js';

describe('chat run service shutdown', () => {
  it('retains structured error details on failed run status bodies', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });

    const wait = runs.wait(run);
    runs.emit(run, 'error', {
      message: 'Agent stalled without emitting any new output for 1s.',
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'Agent stalled without emitting any new output for 1s.',
        retryable: true,
      },
    });
    runs.finish(run, 'failed', 1, null);

    expect(runs.statusBody(run)).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
    await expect(wait).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
  });


  it('ignores subsequent finish attempts after the run reaches a terminal state', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });

    const wait = runs.wait(run);
    runs.finish(run, 'succeeded', 0, null);
    runs.finish(run, 'failed', 1, 'SIGTERM');

    expect(run.status).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(run.signal).toBeNull();
    expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(1);
    await expect(wait).resolves.toMatchObject({ status: 'succeeded', exitCode: 0, signal: null });
  });
  it('keeps cancellation terminal when a real child reports an abort before close', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-abort' });
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => process.exit(143)); process.stdout.write('ready'); setInterval(() => {}, 1000);",
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once('data', () => resolve());
        child.once('error', reject);
      });
      Object.assign(run, { child, status: 'running' });
      child.once('close', (code, signal) => {
        runs.emit(run, 'agent', { type: 'text_delta', delta: 'DSH turn aborted' });
        runs.emit(run, 'error', {
          message: 'DSH turn aborted',
          error: { code: 'AGENT_EXECUTION_FAILED', message: 'DSH turn aborted' },
        });
        runs.finish(run, 'failed', code, signal);
      });
      const result = await runs.cancel(run);
      expect(result.status).toBe('canceled');
      expect(result.childExited).toBe(true);
      expect(result.error).toBeNull();
      expect(run.events.some((record: { data: { delta?: string } }) => record.data.delta === 'DSH turn aborted')).toBe(false);
      expect(run.events.filter((event: { event: string }) => event.event === 'error')).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('filters active runs by conversation within the same project', () => {
    const runs = createRuns();
    const runA = runs.create({ projectId: 'project-1', conversationId: 'conv-a' });
    const runB = runs.create({ projectId: 'project-1', conversationId: 'conv-b' });
    runA.status = 'running';
    runB.status = 'running';

    expect(
      runs.list({ projectId: 'project-1', conversationId: 'conv-b', status: 'active' }),
    ).toEqual([runB]);
  });
  it('cancels a queued run immediately without waiting for child process shutdown', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-queued' });

    const wait = runs.wait(run);
    await runs.cancel(run);

    expect(run.status).toBe('canceled');
    expect(run.cancelRequested).toBe(true);
    expect(run.signal).toBe('SIGTERM');
    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: { status: 'canceled', signal: 'SIGTERM' },
    });
    await expect(wait).resolves.toMatchObject({
      status: 'canceled',
      signal: 'SIGTERM',
    });
  });

  describe('cancel kill fallback', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('sends SIGTERM immediately and escalates to SIGKILL after the cancel grace window', async () => {
      vi.useFakeTimers();
      vi.stubEnv('OD_CHAT_RUN_CANCEL_GRACE_MS', '25');
      const runs = createRuns();
      const child = new FakeChildProcess({ closeOn: 'SIGKILL' });
      const run = runs.create();
      run.status = 'running';
      (run as any).child = child;

      const cancelPromise = runs.cancel(run);

      expect(run.cancelRequested).toBe(true);
      expect(child.signals).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(24);
      expect(child.signals).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(1);
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
      await cancelPromise;
      expect(run.status).toBe('canceled');
      expect(run.signal).toBe('SIGKILL');
    });

    it('closes child stdin before signaling a canceled run', async () => {
      const runs = createRuns();
      const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
      const run = runs.create();
      run.status = 'running';
      run.stdinOpen = true;
      (run as any).child = child;

      await runs.cancel(run);

      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      expect(run.stdinOpen).toBe(false);
      expect(child.lifecycle.slice(0, 2)).toEqual(['stdin.end', 'SIGTERM']);
      expect(child.signals).toEqual(['SIGTERM']);
    });


    it('waits for a real process group to exit before returning canceled status', async () => {
      if (process.platform === 'win32') return;
      vi.stubEnv('OD_CHAT_RUN_CANCEL_GRACE_MS', '25');
      vi.stubEnv('OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS', '250');
      const script = [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);\"], { stdio: 'ignore' });",
        "process.stdout.write(JSON.stringify({ pid: process.pid, childPid: child.pid }) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join('\n');
      const child = spawn(process.execPath, ['-e', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        const line = await readOneLine(child.stdout);
        const payload = JSON.parse(line) as { childPid: number };
        const runs = createRuns();
        const run = runs.create();
        run.status = 'running';
        (run as any).child = child;
        (run as any).childPid = child.pid;
        (run as any).processGroupId = child.pid;

        const status = await runs.cancel(run);

        expect(status.status).toBe('canceled');
        expect(status.childPid).toBe(child.pid);
        expect(status.processGroupId).toBe(child.pid);
        expect(status.childExited).toBe(true);
        expect(status.signal).toBe('SIGKILL');
        await expectPidGone(payload.childPid);
      } finally {
        try {
          if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
  });


  it('stores Browser Use availability on run status bodies', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-a',
      browserUse: {
        requested: true,
        available: false,
        reason: 'no-matching-browser-backend',
        diagnostics: {
          registryPath: '/tmp/codex-browser-use',
          registryExists: false,
          socketCount: 0,
          candidateCount: 0,
          staleCount: 0,
          currentSessionIdPresent: null,
          probeFailureCategory: 'registry-missing',
          staleThresholdMs: 600_000,
        },
      },
    });

    expect(runs.statusBody(run)).toMatchObject({
      browserUse: {
        requested: true,
        available: false,
        reason: 'no-matching-browser-backend',
        diagnostics: {
          registryPath: '/tmp/codex-browser-use',
          probeFailureCategory: 'registry-missing',
        },
      },
    });
  });

  it('summarizes OD-owned project storage on run status bodies', () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-a' });

    expect(runs.statusBody(run).workspace).toEqual({
      storage: {
        kind: 'od-owned',
        baseDir: null,
      },
      provenance: null,
    });
  });

  it('summarizes user-local folder provenance on run status bodies', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-a',
      projectMetadata: {
        importedFrom: 'folder',
        baseDir: '/Users/alice/site',
      },
    });

    expect(runs.statusBody(run).workspace).toEqual({
      storage: {
        kind: 'folder-backed',
        baseDir: '/Users/alice/site',
      },
      provenance: {
        kind: 'user-local',
        writeback: 'in-place',
      },
    });
  });

  it('recomputes workspace from updated project metadata on status bodies', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'routine-pending-project',
      conversationId: 'routine-pending-conversation',
    });

    expect(runs.statusBody(run).workspace).toEqual({
      storage: {
        kind: 'od-owned',
        baseDir: null,
      },
      provenance: null,
    });

    run.projectId = 'real-project';
    run.projectMetadata = {
      importedFrom: 'folder',
      baseDir: '/Users/alice/reused-project',
    };

    expect(runs.statusBody(run).workspace).toEqual({
      storage: {
        kind: 'folder-backed',
        baseDir: '/Users/alice/reused-project',
      },
      provenance: {
        kind: 'user-local',
        writeback: 'in-place',
      },
    });
  });

  it('summarizes orchestrator scratch workspace provenance on run status bodies', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-a',
      projectMetadata: {
        importedFrom: 'folder',
        baseDir: '/tmp/od-scratch',
        orchestratorWorkspace: {
          kind: 'scratch',
          sourceLabel: 'checkout:main',
          sourceRef: 'main@abc123',
          baseRevision: 'abc123',
          writeback: 'external',
        },
      },
    });

    expect(runs.statusBody(run).workspace).toEqual({
      storage: {
        kind: 'folder-backed',
        baseDir: '/tmp/od-scratch',
      },
      provenance: {
        kind: 'orchestrator-scratch',
        sourceLabel: 'checkout:main',
        sourceRef: 'main@abc123',
        baseRevision: 'abc123',
        writeback: 'external',
      },
    });
  });

  it('stores a run-scoped tool bundle and returns a redacted status summary', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-a',
      toolBundle: {
        mcpServers: [
          {
            id: 'run-tools',
            transport: 'stdio',
            command: 'node',
            args: ['server.js', '--token=secret'],
            env: { API_TOKEN: 'secret' },
          },
        ],
      },
    }) as any;

    expect(run.toolBundle.mcpServers).toHaveLength(1);
    expect(run.toolBundle.mcpServers[0]).toMatchObject({
      id: 'run-tools',
      command: 'node',
      env: { API_TOKEN: 'secret' },
    });

    const status = runs.statusBody(run);
    expect(status.toolBundle).toEqual({
      mcpServers: [
        {
          id: 'run-tools',
          transport: 'stdio',
          enabled: true,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('server.js');
  });

  it('cancels active runs and terminates their child process during daemon shutdown', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });
    run.status = 'running';
    (run as any).child = child;

    const wait = runs.wait(run);
    await runs.shutdownActive({ graceMs: 10 });

    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.status).toBe('canceled');
    expect(run.cancelRequested).toBe(true);
    expect(run.signal).toBe('SIGTERM');
    await expect(wait).resolves.toMatchObject({ status: 'canceled', signal: 'SIGTERM' });
    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: { status: 'canceled', signal: 'SIGTERM' },
    });
  });

  it('escalates to SIGKILL when a child ignores the shutdown SIGTERM grace window', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGKILL' });
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;

    await runs.shutdownActive({ graceMs: 1 });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(run.status).toBe('canceled');
  });


  it('closes child stdin for active runs during shutdown before signaling them', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const run = runs.create();
    run.status = 'running';
    run.stdinOpen = true;
    (run as any).child = child;

    await runs.shutdownActive({ graceMs: 10 });

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(run.stdinOpen).toBe(false);
    expect(child.lifecycle.slice(0, 2)).toEqual(['stdin.end', 'SIGTERM']);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});


function createRuns() {
  return createChatRunService({
    createSseResponse: () => ({
      send: vi.fn(() => true),
      end: vi.fn(),
      cleanup: vi.fn(),
    }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
  });
}

function readOneLine(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.reject(new Error('missing stdout'));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for child readiness')), 1000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(buffer.slice(0, newline));
      }
    });
    stream.on('error', reject);
  });
}

async function expectPidGone(pid: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected pid ${pid} to be gone`);
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  signals: string[] = [];
  lifecycle: string[] = [];
  stdin = {
    destroyed: false,
    end: vi.fn(() => {
      this.lifecycle.push('stdin.end');
      this.stdin.destroyed = true;
    }),
  };

  constructor(private readonly options: { closeOn: 'SIGTERM' | 'SIGKILL' }) {
    super();
  }

  kill(signal: string): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.lifecycle.push(signal);
    if (signal === this.options.closeOn) {
      this.signalCode = signal;
      queueMicrotask(() => {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
      });
    }
    return true;
  }
}

// Persist every SSE event the daemon emits to a per-run JSONL file at
// <runsLogDir>/<runId>/events.jsonl. The path is surfaced on statusBody
// as `eventsLogPath`, which is what the MCP `get_run` tool returns to
// the external coding agent — so Codex / Cursor / Zed can `tail` the
// file in their own shell during a long-running OD generation, instead
// of cancelling the run because polling shows nothing changing.
describe('run event log persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runs-log-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function createRunsWithLog(runsLogDir: string | null) {
    return createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
      // runs.ts is `// @ts-nocheck`, so the inferred type for the
      // `runsLogDir = null` default narrows to literal `null` from the
      // outside; cast to bypass and pass the real string. Production
      // callers (server.ts) use a string path directly.
      runsLogDir: runsLogDir as unknown as null,
    });
  }

  it('writes each emitted event as a JSONL line under runsLogDir/<runId>/events.jsonl', async () => {
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    runs.emit(run, 'agent', { type: 'text_delta', delta: 'hello' });
    runs.emit(run, 'agent', { type: 'text_delta', delta: ' world' });
    runs.finish(run, 'succeeded', 0, null);

    // Wait for the write stream to fully flush to disk. The stream is
    // buffered through libuv; .end() is async and only resolves once
    // the kernel has accepted everything. Poll for the expected line
    // count with a short cap to keep the test snappy.
    const logPath = path.join(tmpDir, run.id, 'events.jsonl');
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(logPath)) {
        const text = fs.readFileSync(logPath, 'utf8').trim();
        lines = text ? text.split('\n') : [];
        if (lines.length >= 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(logPath)).toBe(true);
    expect(lines.length).toBe(3); // 2 agent + 1 end
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ event: 'agent', data: { type: 'text_delta', delta: 'hello' } });
    expect(parsed[1]).toMatchObject({ event: 'agent', data: { type: 'text_delta', delta: ' world' } });
    expect(parsed[2]).toMatchObject({ event: 'end', data: { status: 'succeeded' } });
  });

  it('exposes eventsLogPath on statusBody when runsLogDir is configured', () => {
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    const body = runs.statusBody(run);
    expect(body.eventsLogPath).toBe(path.join(tmpDir, run.id, 'events.jsonl'));
  });

  it('reports eventsLogPath: null when runsLogDir is not configured (back-compat)', () => {
    const runs = createRunsWithLog(null);
    const run = runs.create({ projectId: 'p1' });

    const body = runs.statusBody(run);
    expect(body.eventsLogPath).toBeNull();
  });

  it('does not touch the filesystem when runsLogDir is not configured', () => {
    const runs = createRunsWithLog(null);
    const run = runs.create({ projectId: 'p1' });
    runs.emit(run, 'agent', { type: 'text_delta', delta: 'x' });
    runs.finish(run, 'succeeded', 0, null);

    // The tmpDir we'd otherwise have written under stays empty
    // because we configured runsLogDir=null.
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('does not re-open the event log stream for events emitted after the run finished (FD-leak guard)', () => {
    // finish() closes the per-run events.jsonl write stream and nulls it. The
    // stream is opened lazily on emit, so an event emitted AFTER finish (a late
    // async child-close diagnostic, a trailing tool callback, telemetry) would
    // re-open a NEW write stream that finish() — guarded against re-running on a
    // terminal run — never closes. Each such late emit then leaks one file
    // descriptor; over a long-lived daemon this exhausts the fd table and
    // posix_spawn starts returning EBADF (#3408 P1, distinct from the stdio
    // leak fixed in #4163).
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    runs.emit(run, 'agent', { type: 'text_delta', delta: 'hi' }); // opens the stream
    runs.finish(run, 'succeeded', 0, null); // closes + nulls the stream
    expect(run.eventsLogStream).toBeNull();

    // A late event must NOT lazily re-open a stream that will never be closed.
    runs.emit(run, 'diagnostic', { type: 'runtime_close' });
    expect(run.eventsLogStream).toBeNull();
  });

  it("still writes finish()'s own end event for a run that finished with no prior events", async () => {
    // Regression for the FD-leak guard: finish() sets status terminal before
    // emitting `end`, so the guard must NOT block that in-progress emit — a
    // no-output failure / queued-run cancellation, where `end` is the only
    // event, must still leave a forensic events.jsonl on disk.
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    runs.finish(run, 'canceled', null, 'SIGTERM'); // no prior emit; end is the only event

    const logPath = path.join(tmpDir, run.id, 'events.jsonl');
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(logPath)) {
        const text = fs.readFileSync(logPath, 'utf8').trim();
        lines = text ? text.split('\n') : [];
        if (lines.length >= 1) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(logPath)).toBe(true);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: 'end', data: { status: 'canceled' } });
    // …but the stream is closed and a later emit still must not re-open it.
    expect(run.eventsLogStream).toBeNull();
    runs.emit(run, 'diagnostic', { type: 'runtime_close' });
    expect(run.eventsLogStream).toBeNull();
  });

  it('recovers a persisted terminal run after the daemon in-memory registry is lost', () => {
    const runId = '8fb07f3a-3b5f-4ae3-8982-d0fe0c279390';
    const logDir = path.join(tmpDir, runId);
    const logPath = path.join(logDir, 'events.jsonl');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, [
      JSON.stringify({
        id: 1,
        event: 'start',
        data: { runId, agentId: 'matos', projectId: 'project-1', model: 'role:compute@1.0.26' },
        timestamp: 100,
      }),
      JSON.stringify({
        id: 2,
        event: 'end',
        data: { code: 0, signal: null, status: 'succeeded', resumable: false },
        timestamp: 200,
      }),
    ].join('\n') + '\n');

    const recoveredRuns = createRunsWithLog(tmpDir);
    const recovered = recoveredRuns.get(runId) as any;

    expect(recovered).not.toBeNull();
    expect(recoveredRuns.statusBody(recovered)).toMatchObject({
      id: runId,
      projectId: 'project-1',
      agentId: 'matos',
      status: 'succeeded',
      exitCode: 0,
    });
    expect(recovered.events).toHaveLength(2);
    expect(fs.readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('turns an unterminated persisted run into a resumable daemon-restart interruption', () => {
    const runId = '14a8f7ec-ac05-4065-8ac9-d881950e141d';
    const logDir = path.join(tmpDir, runId);
    const logPath = path.join(logDir, 'events.jsonl');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, [
      JSON.stringify({
        id: 1008,
        event: 'agent',
        data: { type: 'tool_result', toolUseId: 'tool-1', content: 'calculation finished', isError: false },
        timestamp: 100,
      }),
      JSON.stringify({
        id: 1009,
        event: 'agent',
        data: { type: 'status', label: 'compacting' },
        timestamp: 200,
      }),
    ].join('\n') + '\n');
    const recoverInterruptedRun = vi.fn(() => ({ resumable: true }));
    const onRecoveredRun = vi.fn();
    const recoveredRuns = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string, init: object = {}) => ({
        message,
        error: { code, message, ...init },
      }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
      runsLogDir: tmpDir as unknown as null,
      resolvePersistedRunMetadata: () => ({
        projectId: 'project-1',
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        agentId: 'matos',
        model: 'role:compute@1.0.26',
      }),
      recoverInterruptedRun,
      onRecoveredRun,
    } as never);

    const recovered = recoveredRuns.get(runId) as any;
    const status = recoveredRuns.statusBody(recovered);

    expect(recoverInterruptedRun).toHaveBeenCalledWith(recovered);
    expect(onRecoveredRun).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({ interrupted: true }),
    );
    expect(status).toMatchObject({
      id: runId,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      status: 'failed',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      resumable: true,
    });
    expect(recovered.events.slice(-2)).toMatchObject([
      {
        id: 1010,
        event: 'error',
        data: { error: { code: 'RUN_INTERRUPTED_BY_DAEMON_RESTART' } },
      },
      {
        id: 1011,
        event: 'end',
        data: { status: 'failed', resumable: true },
      },
    ]);
    const persisted = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(persisted.slice(-2).map((record) => record.event)).toEqual(['error', 'end']);

    // A second daemon restart sees the durable terminal events and must not
    // append another interruption pair or advance the cursor again.
    const restartedAgain = createRunsWithLog(tmpDir);
    const recoveredAgain = restartedAgain.get(runId) as any;
    expect(recoveredAgain.events.at(-1)).toMatchObject({ id: 1011, event: 'end' });
    expect(fs.readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('recovers a queued/running SQLite run even when it died before writing its first event', () => {
    const runId = '94992d50-46e1-4278-926a-dfe798dd7fb0';
    const onRecoveredRun = vi.fn();
    const recoveredRuns = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string, init: object = {}) => ({
        message,
        error: { code, message, ...init },
      }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
      runsLogDir: tmpDir as unknown as null,
      resolvePersistedRunMetadata: () => ({
        projectId: 'project-1',
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        agentId: 'matos',
        persistedRunStatus: 'running',
        messageCreatedAt: 100,
        messageStartedAt: 120,
      }),
      listPersistedRunIds: () => [runId],
      onRecoveredRun,
    } as never);

    // Listing active runs asks SQLite for candidates. The missing in-memory
    // run is sealed as interrupted, so it no longer leaks back as "running".
    expect(recoveredRuns.list({ status: 'active' })).toEqual([]);
    const recovered = recoveredRuns.get(runId) as any;
    expect(recoveredRuns.statusBody(recovered)).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      createdAt: 120,
    });
    expect(recovered.events.map((record: { event: string }) => record.event)).toEqual(['error', 'end']);
    expect(onRecoveredRun).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({ interrupted: true }),
    );
    expect(
      fs.existsSync(path.join(tmpDir, runId, 'events.jsonl')),
    ).toBe(true);
  });

  it('does not leak real file descriptors across many finished runs with late emits', async () => {
    // fd-level proof of the leak (the actual cause of spawn EBADF), not just the
    // JS-object proxy above. Repeatedly: open the log, finish, then emit late.
    // On the buggy code each late emit re-opens a WriteStream whose fd stays
    // open as long as the run object is referenced — so N iterations leak ~N
    // fds. With the fix the count stays flat. Linux/macOS expose the process's
    // open fds at /dev/fd; skip elsewhere (Windows has no equivalent dir).
    const fdDir = '/dev/fd';
    if (!fs.existsSync(fdDir)) return;
    const countFds = () => fs.readdirSync(fdDir).length;

    const runs = createRunsWithLog(tmpDir);
    const closed: Promise<void>[] = [];
    const kept: unknown[] = []; // hold run refs so leaked streams can't be GC'd
    const ITER = 60;
    const before = countFds();
    for (let i = 0; i < ITER; i++) {
      const run = runs.create({ projectId: 'p1', conversationId: `c${i}` });
      kept.push(run);
      runs.emit(run, 'agent', { type: 'text_delta', delta: 'x' });
      const stream = run.eventsLogStream as fs.WriteStream | null;
      if (stream) {
        closed.push(new Promise<void>((resolve) => stream.once('close', resolve)));
      }
      runs.finish(run, 'succeeded', 0, null);
      runs.emit(run, 'diagnostic', { type: 'runtime_close' }); // late — must not re-open
    }
    // Wait for actual stream closure; fixed delays are flaky on network filesystems.
    await Promise.all(closed);
    const after = countFds();
    // Generous noise margin, far below ITER. On the buggy code this grows by
    // ~ITER (each late emit re-opened a never-closed stream).
    expect(after - before).toBeLessThan(15);
    expect(kept.length).toBe(ITER);
  });
});
