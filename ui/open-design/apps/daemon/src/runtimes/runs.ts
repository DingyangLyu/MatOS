// @ts-nocheck
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRunToolBundleForRun,
  summarizeRunToolBundle,
} from '../run-tool-bundle.js';
import { projectWorkspaceProvenance } from '../workspace-contract.js';

/** Cancellation stops user-visible error/text output while preserving usage and tool records. */
export function shouldSuppressCanceledRunOutput(cancelRequested, event, data) {
  return Boolean(cancelRequested) && (
    event === 'error' ||
    (event === 'agent' && ['error', 'text_delta', 'thinking_delta'].includes(data?.type))
  );
}


export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
export const INTERRUPTED_RUN_ERROR_CODE = 'RUN_INTERRUPTED_BY_DAEMON_RESTART';
export const INTERRUPTED_RUN_ERROR_MESSAGE =
  'MatOS workspace restarted before this response completed. Earlier tool results were preserved; continue the conversation to resume safely.';

const SAFE_PERSISTED_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_MAX_RECOVERY_LOG_BYTES = 16 * 1024 * 1024;

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractErrorDetails(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
  return {
    error: readString(nested.message) ?? readString(payload.message),
    errorCode: readString(nested.code) ?? readString(payload.code),
  };
}

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
  shutdownGraceMs = 3_000,
  // Absolute directory under which per-run event JSONL logs are written
  // (one file per run at <runsLogDir>/<runId>/events.jsonl). When null,
  // event persistence is disabled and statusBody.eventsLogPath = null —
  // legacy behavior. The path is surfaced through MCP get_run so an
  // external coding agent can `tail` the file in its own shell during
  // a long OD generation, instead of polling blindly and giving up.
  runsLogDir = null,
  resolvePersistedRunMetadata = null,
  listPersistedRunIds = null,
  recoverInterruptedRun = null,
  onRecoveredRun = null,
  maxRecoveryLogBytes = DEFAULT_MAX_RECOVERY_LOG_BYTES,
}) {
  const runs = new Map();

  const create = (meta = {}, forcedId = null) => {
    const now = Date.now();
    const id = typeof forcedId === 'string' && forcedId ? forcedId : randomUUID();
    const run = {
      id,
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      userMessageId: typeof meta.userMessageId === 'string' && meta.userMessageId ? meta.userMessageId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      projectMetadata:
        meta.projectMetadata && typeof meta.projectMetadata === 'object' && !Array.isArray(meta.projectMetadata)
          ? meta.projectMetadata
          : null,
      workspace: projectWorkspaceProvenance(meta.projectMetadata),
      toolBundle: normalizeRunToolBundleForRun(meta.toolBundle),
      browserUse: meta.browserUse && typeof meta.browserUse === 'object' ? meta.browserUse : null,
      model: typeof meta.model === 'string' && meta.model ? meta.model : null,
      reasoning: typeof meta.reasoning === 'string' && meta.reasoning ? meta.reasoning : null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      childPid: null,
      processGroupId: null,
      childExitObservedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      errorCode: null,
      cancelRequested: false,
      retryRestartTimer: null,
      stdinOpen: false,
      eventsLogPath: runsLogDir ? path.join(runsLogDir, id, 'events.jsonl') : null,
      eventsLogStream: null,
      // Set once finish() has closed the log stream, so a late post-finish emit
      // can't lazily re-open a stream nothing will ever close (FD leak).
      eventsLogClosed: false,
    };
    runs.set(run.id, run);
    return run;
  };

  const scheduleCleanup = (run) => {
    setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) runs.delete(run.id);
    }, ttlMs).unref?.();
  };

  const persistedRunLogPath = (id) => {
    if (!runsLogDir || typeof id !== 'string' || !SAFE_PERSISTED_RUN_ID.test(id)) {
      return null;
    }
    const root = path.resolve(runsLogDir);
    const candidate = path.resolve(root, id, 'events.jsonl');
    return candidate.startsWith(root + path.sep) ? candidate : null;
  };

  const readPersistedRunEvents = (logPath) => {
    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0) return null;
    const configuredLimit = Number(maxRecoveryLogBytes);
    const byteLimit = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : DEFAULT_MAX_RECOVERY_LOG_BYTES;
    const truncated = stat.size > byteLimit;
    let text = '';
    try {
      if (!truncated) {
        text = fs.readFileSync(logPath, 'utf8');
      } else {
        const fd = fs.openSync(logPath, 'r');
        try {
          const buffer = Buffer.allocUnsafe(byteLimit);
          const offset = stat.size - byteLimit;
          const bytesRead = fs.readSync(fd, buffer, 0, byteLimit, offset);
          text = buffer.subarray(0, bytesRead).toString('utf8');
          const firstNewline = text.indexOf('\n');
          text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      return null;
    }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (
          record &&
          Number.isInteger(record.id) &&
          record.id > 0 &&
          typeof record.event === 'string' &&
          record.event
        ) {
          records.push({
            id: record.id,
            event: record.event,
            data: record.data,
            timestamp: Number.isFinite(record.timestamp) ? record.timestamp : stat.mtimeMs,
          });
        }
      } catch {
        // A daemon can die mid-write and leave one incomplete trailing line.
        // Earlier complete records remain authoritative and recoverable.
      }
    }
    if (records.length === 0) return null;
    return {
      records: records.slice(-maxEvents),
      truncated,
      mtimeMs: stat.mtimeMs,
    };
  };

  const recoverPersistedRun = (id) => {
    const logPath = persistedRunLogPath(id);
    if (!logPath) return null;
    const persisted = readPersistedRunEvents(logPath);
    let durableMetadata = {};
    if (typeof resolvePersistedRunMetadata === 'function') {
      try {
        const resolved = resolvePersistedRunMetadata(id);
        if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
          durableMetadata = resolved;
        }
      } catch {
        // Event-log recovery still provides an honest terminal state even if
        // the optional SQLite correlation lookup is unavailable.
      }
    }
    if (!persisted && Object.keys(durableMetadata).length === 0) return null;

    const persistedRecords = persisted?.records ?? [];
    const startRecord = persistedRecords.find((record) => record.event === 'start');
    const startData = startRecord?.data && typeof startRecord.data === 'object'
      ? startRecord.data
      : {};
    const meta = { ...startData, ...durableMetadata };
    const run = create(meta, id);
    run.events = persistedRecords;
    const persistedCursor = Number(durableMetadata.lastRunEventId);
    run.nextEventId = Math.max(
      0,
      Number.isFinite(persistedCursor) ? persistedCursor : 0,
      ...persistedRecords.map((record) => record.id),
    ) + 1;
    const metadataCreatedAt = Number(
      durableMetadata.messageStartedAt ?? durableMetadata.messageCreatedAt,
    );
    const metadataUpdatedAt = Number(
      durableMetadata.messageEndedAt ??
      durableMetadata.messageStartedAt ??
      durableMetadata.messageCreatedAt,
    );
    run.createdAt = persistedRecords[0]?.timestamp ??
      (Number.isFinite(metadataCreatedAt) ? metadataCreatedAt : persisted?.mtimeMs ?? Date.now());
    run.updatedAt = persistedRecords.at(-1)?.timestamp ??
      (Number.isFinite(metadataUpdatedAt) ? metadataUpdatedAt : persisted?.mtimeMs ?? run.createdAt);
    run.eventsLogPath = logPath;
    run.eventsLogStream = null;
    run.eventsLogClosed = true;
    run.child = null;
    run.childPid = null;
    run.processGroupId = null;

    for (const record of persistedRecords) {
      if (record.event !== 'error') continue;
      const details = extractErrorDetails(record.data);
      if (details.error) run.error = details.error;
      if (details.errorCode) run.errorCode = details.errorCode;
    }

    const terminalRecord = [...persistedRecords]
      .reverse()
      .find((record) =>
        record.event === 'end' &&
        record.data &&
        typeof record.data === 'object' &&
        TERMINAL_RUN_STATUSES.has(record.data.status),
      );
    let interrupted = false;
    const appendedRecords = [];
    const appendRecoveredRecords = (records) => {
      if (records.length === 0) return;
      appendedRecords.push(...records);
      run.events.push(...records);
      if (run.events.length > maxEvents) {
        run.events.splice(0, run.events.length - maxEvents);
      }
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(
          logPath,
          records.map((record) => JSON.stringify(record)).join('\n') + '\n',
          'utf8',
        );
      } catch {
        // The recovered in-memory record still prevents a raw 404. A read-only
        // filesystem is reported through normal workspace diagnostics.
      }
    };
    if (terminalRecord) {
      run.status = terminalRecord.data.status;
      run.exitCode = typeof terminalRecord.data.code === 'number'
        ? terminalRecord.data.code
        : null;
      run.signal = typeof terminalRecord.data.signal === 'string'
        ? terminalRecord.data.signal
        : null;
      run.resumable = terminalRecord.data.resumable === true;
    } else if (
      (durableMetadata.persistedRunStatus === 'succeeded' ||
        durableMetadata.persistedRunStatus === 'canceled') ||
      (durableMetadata.persistedRunStatus === 'failed' && run.error)
    ) {
      // SQLite can reach a truthful terminal state just before the daemon dies
      // while the buffered `end` JSONL write is still in flight. Preserve that
      // known result; only runs with no terminal evidence become restart
      // interruptions.
      run.status = durableMetadata.persistedRunStatus;
      run.exitCode = run.status === 'succeeded' ? 0 : run.status === 'failed' ? 1 : null;
      run.signal = run.status === 'canceled' ? 'SIGTERM' : null;
      run.resumable = false;
      const timestamp = Number.isFinite(Number(durableMetadata.messageEndedAt))
        ? Number(durableMetadata.messageEndedAt)
        : Date.now();
      const recoveredEnd = {
        id: run.nextEventId++,
        event: 'end',
        data: {
          code: run.exitCode,
          signal: run.signal,
          status: run.status,
          resumable: false,
        },
        timestamp,
      };
      appendRecoveredRecords([recoveredEnd]);
      run.updatedAt = timestamp;
    } else {
      interrupted = true;
      let recovery = null;
      if (typeof recoverInterruptedRun === 'function') {
        try {
          recovery = recoverInterruptedRun(run);
        } catch {
          recovery = null;
        }
      }
      run.resumable = recovery === true || recovery?.resumable === true;
      const errorPayload = createSseErrorPayload(
        INTERRUPTED_RUN_ERROR_CODE,
        INTERRUPTED_RUN_ERROR_MESSAGE,
        {
          retryable: true,
          details: { reason: 'daemon_restart', preservedEventCount: run.events.length },
        },
      );
      const timestamp = Date.now();
      const errorRecord = {
        id: run.nextEventId++,
        event: 'error',
        data: errorPayload,
        timestamp,
      };
      const endRecord = {
        id: run.nextEventId++,
        event: 'end',
        data: { code: 1, signal: null, status: 'failed', resumable: run.resumable },
        timestamp,
      };
      appendRecoveredRecords([errorRecord, endRecord]);
      run.status = 'failed';
      run.exitCode = 1;
      run.signal = null;
      run.error = INTERRUPTED_RUN_ERROR_MESSAGE;
      run.errorCode = INTERRUPTED_RUN_ERROR_CODE;
      run.updatedAt = timestamp;
    }

    scheduleCleanup(run);
    if (typeof onRecoveredRun === 'function') {
      try {
        onRecoveredRun(run, {
          interrupted,
          appendedRecords,
          logTruncated: persisted?.truncated ?? false,
        });
      } catch {
        // Recovery must remain available even when message reconciliation is
        // temporarily blocked by SQLite or another optional host service.
      }
    }
    return run;
  };

  const get = (id) => runs.get(id) ?? recoverPersistedRun(id);

  // Lazily open the per-run event log on first emit. The directory may
  // not exist yet; mkdir is recursive so it's safe to call repeatedly.
  // Disk failures are best-effort — if we can't write, the run still
  // proceeds (SSE clients keep getting events from memory).
  const ensureLogStream = (run) => {
    if (!run.eventsLogPath) return null;
    if (run.eventsLogStream) return run.eventsLogStream;
    // finish() has already closed + nulled this run's log stream. Re-opening it
    // here for a late event (async child-close diagnostic, trailing tool
    // callback) would leak a file descriptor that nothing ever
    // closes. We gate on the explicit `eventsLogClosed` flag — NOT on terminal
    // status — so finish()'s own `end` emit (which runs while status is already
    // terminal but before the stream is closed) can still open + write + close
    // the log for a run that had no prior events. Late events still reach
    // memory + SSE clients below; we just stop persisting them to the closed
    // log. (#3408 P1 FD-leak fix; cf. #4163.)
    if (run.eventsLogClosed) return null;
    try {
      fs.mkdirSync(path.dirname(run.eventsLogPath), { recursive: true });
      run.eventsLogStream = fs.createWriteStream(run.eventsLogPath, { flags: 'a' });
      // Don't crash the daemon on a stream-level error; just stop
      // trying to use this stream so subsequent emits silently skip.
      run.eventsLogStream.on('error', () => {
        try { run.eventsLogStream?.destroy(); } catch { /* ignore */ }
        run.eventsLogStream = null;
      });
      return run.eventsLogStream;
    } catch {
      return null;
    }
  };

  const emit = (run, event, data) => {
    // An abort emitted while the child handles our cancellation is expected.
    if (shouldSuppressCanceledRunOutput(run.cancelRequested, event, data)) return;
    if (event === 'error') {
      const details = extractErrorDetails(data);
      if (details.error) run.error = details.error;
      if (details.errorCode) run.errorCode = details.errorCode;
    }
    const id = run.nextEventId++;
    const record = { id, event, data, timestamp: Date.now() };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    const stream = ensureLogStream(run);
    if (stream) {
      try {
        stream.write(JSON.stringify(record) + '\n');
      } catch {
        // Stream-level write errors are caught by the on('error') above;
        // swallowing here keeps the SSE fan-out below from being skipped.
      }
    }
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    userMessageId: run.userMessageId ?? null,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cancelRequested: !!run.cancelRequested,
    childPid: typeof run.child?.pid === 'number' ? run.child.pid : run.childPid ?? null,
    processGroupId: run.processGroupId ?? null,
    childExited: !run.child || run.child.exitCode !== null || run.child.signalCode !== null,
    childExitObservedAt: run.childExitObservedAt ?? null,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    resumable: run.resumable ?? false,
    eventsLogPath: run.eventsLogPath ?? null,
    workspace: projectWorkspaceProvenance(run.projectMetadata),
    toolBundle: summarizeRunToolBundle(run.toolBundle),
    ...(run.promptCache ? { promptCache: run.promptCache } : {}),
    ...(run.browserUse ? { browserUse: run.browserUse } : {}),
  });

  const finish = (run, status, code: number | null = null, signal: string | null = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    // The child's abort/close callback can race cancel()'s exit waiter.
    if (run.cancelRequested) status = 'canceled';
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    emit(run, 'end', { code, signal, status, resumable: run.resumable ?? false });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    // Close the event log stream now that no more events will be
    // emitted for this run. The file stays on disk for tail/grep.
    try { run.eventsLogStream?.end(); } catch { /* ignore */ }
    run.eventsLogStream = null;
    // Any event emitted after this point must not lazily re-open the log.
    run.eventsLogClosed = true;
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    let sent = 0;
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
        sent++;
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      // Guarantee a reattaching client sees a terminal signal even if its
      // cursor is at or past the final event id — otherwise the SSE
      // stream ends silently and the client falls back to status-only fetch.
      if (sent === 0 && run.events.length > 0) {
        const last = run.events[run.events.length - 1];
        sse.send(last.event, last.data, last.id);
      }
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const list = ({ projectId, conversationId, status } = {}) => {
    if (typeof listPersistedRunIds === 'function') {
      try {
        const persistedIds = listPersistedRunIds({ projectId, conversationId, status });
        for (const id of Array.isArray(persistedIds) ? persistedIds : []) {
          if (typeof id === 'string' && id && !runs.has(id)) get(id);
        }
      } catch {
        // The in-memory list remains usable when optional persistence lookup
        // is unavailable.
      }
    }
    return Array.from(runs.values()).filter((run) => {
      if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
      if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
      if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
      if (typeof status === 'string' && status) return run.status === status;
      return true;
    });
  };

  const childHasExited = (child) => !child || child.exitCode !== null || child.signalCode !== null;

  const recordChildExitObserved = (run) => {
    if (!run.childExitObservedAt) run.childExitObservedAt = Date.now();
  };

  const waitForChildExit = (child, timeoutMs) => {
    if (!child) return Promise.resolve(true);
    if (childHasExited(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('close', onClose);
        child.off?.('exit', onClose);
        resolve(exited);
      };
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      child.once?.('close', onClose);
      child.once?.('exit', onClose);
    });
  };

  const forceWaitMs = () => {
    const raw = Number(process.env.OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 500;
  };

  const killChild = (run, signal) => {
    if (!run.child || childHasExited(run.child)) return false;
    if (process.platform !== 'win32' && Number.isInteger(run.processGroupId)) {
      try {
        process.kill(-run.processGroupId, signal);
        return true;
      } catch (err) {
        if (err?.code !== 'ESRCH') {
          // Fall through to the direct child signal path below. This keeps
          // cancellation working if the child was not spawned as a process
          // group leader for any reason.
        }
      }
    }
    try {
      return run.child.kill(signal);
    } catch {
      return false;
    }
  };

  const cancelGraceMs = () => {
    const raw = Number(process.env.OD_CHAT_RUN_CANCEL_GRACE_MS || process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 3000;
  };

  const finishCanceledFromChildState = (run, fallbackSignal = 'SIGTERM') => {
    const child = run.child;
    if (childHasExited(child)) recordChildExitObserved(run);
    finish(
      run,
      'canceled',
      child?.exitCode ?? null,
      child?.signalCode ?? fallbackSignal,
    );
    return statusBody(run);
  };

  const closeRunStdin = (run) => {
    if (!run?.stdinOpen) return;
    const stdin = run.child?.stdin;
    if (stdin && !stdin.destroyed) {
      try {
        stdin.end();
      } catch {
        // Best-effort: cancellation still falls back to process signals below.
      }
    }
    run.stdinOpen = false;
  };

  // A same-run retry can be waiting out its backoff window (server.ts
  // scheduleRetryRestart). Cancellation/shutdown must drop that pending restart
  // so a cancelled run is not resurrected after the timer fires.
  const clearPendingRetryRestart = (run) => {
    if (run?.retryRestartTimer) {
      clearTimeout(run.retryRestartTimer);
      run.retryRestartTimer = null;
    }
  };

  const cancel = async (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return statusBody(run);
    run.cancelRequested = true;
    run.updatedAt = Date.now();
    clearPendingRetryRestart(run);
    closeRunStdin(run);
    if (!run.child) {
      finish(run, 'canceled', null, 'SIGTERM');
      return statusBody(run);
    }

    killChild(run, 'SIGTERM');
    if (await waitForChildExit(run.child, cancelGraceMs())) {
      return finishCanceledFromChildState(run, 'SIGTERM');
    }
    killChild(run, 'SIGKILL');
    await waitForChildExit(run.child, forceWaitMs());
    return finishCanceledFromChildState(run, 'SIGKILL');
  };

  const shutdownActive = async ({ graceMs = shutdownGraceMs } = {}) => {
    const activeRuns = Array.from(runs.values()).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    await Promise.all(activeRuns.map(async (run) => {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      clearPendingRetryRestart(run);
      closeRunStdin(run);
      killChild(run, 'SIGTERM');
      finish(run, 'canceled', null, 'SIGTERM');
      if (run.child && !(await waitForChildExit(run.child, graceMs))) {
        killChild(run, 'SIGKILL');
        await waitForChildExit(run.child, 500);
      }
    }));
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  // Drop a run from the in-memory registry without emitting any terminal
  // event. Used by callers that prepared a run optimistically (created the
  // record before some external precondition was checked) and need to undo
  // the create without surfacing the run via `/api/runs`. Only valid before
  // the run reaches a terminal status — terminal runs use scheduleCleanup
  // and would already have notified any subscribers.
  const drop = (run) => {
    if (!run) return;
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    runs.delete(run.id);
    for (const sse of run.clients) {
      try { sse.end(); } catch { /* best-effort detach */ }
    }
    run.clients.clear();
    // Resolve any pending waiters with a synthetic "canceled" status so
    // they unblock instead of hanging forever — the run is being dropped
    // because nothing will ever start.
    run.status = 'canceled';
    run.updatedAt = Date.now();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
  };

  return {
    create,
    start,
    get,
    list,
    stream,
    cancel,
    shutdownActive,
    wait,
    emit,
    finish,
    fail,
    drop,
    signalChild: killChild,
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
  };
}
