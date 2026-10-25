import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

type RunStatus = {
  id: string;
  projectId: string;
  conversationId: string;
  assistantMessageId: string;
  agentId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  errorCode: string | null;
  eventsLogPath: string;
};

type RunEvent = {
  event: string;
  data: Record<string, unknown>;
};

describe('same-run retry runtime', () => {
  const originalEnv = snapshotEnv();
  let started: StartedServer | null = null;
  let binDir: string | null = null;

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    if (binDir) await rm(binDir, { recursive: true, force: true });
    binDir = null;
    restoreEnv(originalEnv);
  });

  it('retries a transient first-token failure inside the same run', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-run-retry-runtime-bin-'));
    const fakeClaude = await writeFlakyClaude(binDir, 'matos-flaky');


    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    await putConfig(started.url, {
      agentId: 'matos',
      agentCliEnv: { matos: { MATOS_BIN: fakeClaude } },
    });

    const run = await createAndWaitForRun(started.url);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.id).toBeTruthy();

    const events = await waitForRunEvents(run.eventsLogPath, (records) =>
      records.filter((event) => event.event === 'start').length === 2 &&
      records.filter((event) => event.event === 'end').length === 1,
    );
    expect(events.filter((event) => event.event === 'start')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'end')).toHaveLength(1);
  });

  it('retries a silent first-token stall caught by the inactivity watchdog', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-run-retry-stall-bin-'));
    const { bin: fakeClaude, argsLogPath } = await writeStallingClaude(binDir, 'matos-stall');

    // Trip the no-output inactivity watchdog quickly so the first (silent)
    // attempt stalls at first_token_wait and the same-run retry can fire. Kept
    // comfortably above node cold-start so the recovered retry attempt's own
    // watchdog does not also trip before it emits its first token.
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '400';

    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    await putConfig(started.url, {
      agentId: 'matos',
      agentCliEnv: { matos: { MATOS_BIN: fakeClaude } },
    });

    const run = await createAndWaitForRun(started.url);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.id).toBeTruthy();

    const events = await waitForRunEvents(run.eventsLogPath, (records) =>
      records.filter((event) => event.event === 'start').length === 2 &&
      records.filter((event) => event.event === 'end').length === 1,
    );
    // Two spawns (silent stall + recovered retry), one terminal end.
    expect(events.filter((event) => event.event === 'start')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'end')).toHaveLength(1);

    const attemptArgs = (await readClaudeAttemptArgs(argsLogPath)).filter(
      (args) => args.includes('--session-id') || args.includes('--resume'),
    );
    expect(attemptArgs).toHaveLength(2);
    for (const args of attemptArgs) {
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
    }
    const firstAttemptSessionId = sessionIdArg(attemptArgs[0] ?? []);
    const secondAttemptSessionId = sessionIdArg(attemptArgs[1] ?? []);
    expect(firstAttemptSessionId).toBeTruthy();
    expect(secondAttemptSessionId).toBeTruthy();
    expect(secondAttemptSessionId).not.toBe(firstAttemptSessionId);
  });

  it('persists running on the assistant message while the agent is active', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-run-message-state-bin-'));
    const fakeClaude = await writeSlowClaude(binDir, 'matos-slow');


    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    await putConfig(started.url, {
      agentId: 'matos',
      agentCliEnv: { matos: { MATOS_BIN: fakeClaude } },
    });

    const projectId = `running_state_${randomUUID()}`;
    const projectResponse = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Running state smoke',
        metadata: { kind: 'prototype' },
        skipDiscoveryBrief: true,
      }),
    });
    expect(projectResponse.status).toBe(200);
    const project = await projectResponse.json() as { conversationId: string };
    const assistantMessageId = `assistant_running_${randomUUID()}`;

    const runResponse = await fetch(`${started.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        conversationId: project.conversationId,
        assistantMessageId,
        clientRequestId: `client_running_${randomUUID()}`,
        agentId: 'matos',
        message: 'hold the run open briefly',
        currentPrompt: 'hold the run open briefly',
      }),
    });
    expect(runResponse.status).toBe(202);
    const created = await runResponse.json() as { runId: string };

    await waitForStatus(started.url, created.runId, 'running');
    const messagesResponse = await fetch(
      `${started.url}/api/projects/${projectId}/conversations/${project.conversationId}/messages?view=chat`,
    );
    expect(messagesResponse.status).toBe(200);
    const messages = await messagesResponse.json() as {
      messages: Array<{ id: string; runStatus?: string }>;
    };
    expect(messages.messages.find((message) => message.id === assistantMessageId)?.runStatus)
      .toBe('running');

    expect((await waitForRun(started.url, created.runId)).status).toBe('succeeded');
  });
});

function snapshotEnv(): Record<string, string | undefined> {
  return {
    OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS: process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS,
  };
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function writeFlakyClaude(dir: string, name: string): Promise<string> {
  const bin = path.join(dir, name);
  const counterPath = path.join(dir, `${name}-attempts`);
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const counterPath = ${JSON.stringify(counterPath)};
if (process.argv.includes('--version')) {
  console.log('matos-code 1.0.0-retry-runtime');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('Usage: matos -p [--include-partial-messages] [--add-dir DIR]');
  process.exit(0);
}
let attempts = 0;
try { attempts = Number(fs.readFileSync(counterPath, 'utf8')) || 0; } catch {}
fs.writeFileSync(counterPath, String(attempts + 1));
if (attempts === 0) {
  process.stderr.write('HTTP 503 Service Unavailable: upstream provider unavailable before first token.\\n');
  setTimeout(() => process.exit(1), 20);
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'matos-retry-test' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-retry-success',
      content: [{ type: 'text', text: 'Recovered after retry.' }],
      stop_reason: 'end_turn'
    }
  }));
  setTimeout(() => process.exit(0), 20);
}
`, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

async function writeSlowClaude(dir: string, name: string): Promise<string> {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('matos-code 1.0.0-running-state');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('Usage: matos -p [--include-partial-messages] [--add-dir DIR]');
  process.exit(0);
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'matos-running-state-test' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-running-state-success',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }]
    }
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
}, 750);
`);
  await chmod(bin, 0o755);
  return bin;
}

async function writeStallingClaude(
  dir: string,
  name: string,
): Promise<{ bin: string; argsLogPath: string }> {
  const bin = path.join(dir, name);
  const counterPath = path.join(dir, `${name}-attempts`);
  const argsLogPath = path.join(dir, `${name}-args.jsonl`);
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const counterPath = ${JSON.stringify(counterPath)};
const argsLogPath = ${JSON.stringify(argsLogPath)};
if (process.argv.includes('--version')) {
  console.log('matos-code 1.0.0-retry-stall');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('Usage: matos -p [--include-partial-messages] [--add-dir DIR]');
  process.exit(0);
}
let attempts = 0;
try { attempts = Number(fs.readFileSync(counterPath, 'utf8')) || 0; } catch {}
fs.writeFileSync(counterPath, String(attempts + 1));
fs.appendFileSync(argsLogPath, JSON.stringify(process.argv.slice(2)) + '\\n');
if (attempts === 0) {
  // First attempt: emit nothing on stdout/stderr and hang well past the
  // inactivity watchdog window so the daemon classifies a silent first-token
  // stall. Exit cleanly when the watchdog SIGTERMs us (default Node behavior),
  // and keep a long fallback timer so we never self-exit before the watchdog.
  setTimeout(() => process.exit(0), 60000);
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'matos-retry-test' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-retry-stall-success',
      content: [{ type: 'text', text: 'Recovered after watchdog retry.' }],
      stop_reason: 'end_turn'
    }
  }));
  setTimeout(() => process.exit(0), 20);
}
`, 'utf8');
  await chmod(bin, 0o755);
  return { bin, argsLogPath };
}

async function putConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${url}/api/app-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

async function createAndWaitForRun(url: string): Promise<RunStatus> {
  const projectId = `retry_runtime_${randomUUID()}`;
  const projectResponse = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: 'Retry runtime smoke',
      metadata: { kind: 'prototype' },
      skipDiscoveryBrief: true,
    }),
  });
  expect(projectResponse.status).toBe(200);
  const projectBody = await projectResponse.json() as { conversationId: string };
  const assistantMessageId = `assistant_retry_${randomUUID()}`;
  const runResponse = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      projectId,
      conversationId: projectBody.conversationId,
      assistantMessageId,
      clientRequestId: `client_retry_${randomUUID()}`,
      agentId: 'matos',
      message: 'please retry a transient runtime failure',
      currentPrompt: 'please retry a transient runtime failure',
    }),
  });
  expect(runResponse.status).toBe(202);
  const body = await runResponse.json() as { runId: string };
  return await waitForRun(url, body.runId);
}

async function waitForRun(url: string, runId: string): Promise<RunStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const run = await response.json() as RunStatus;
    if (run.status === 'failed' || run.status === 'succeeded' || run.status === 'canceled') {
      return run;
    }
    await delay(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

async function waitForStatus(url: string, runId: string, expected: string): Promise<RunStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const run = await response.json() as RunStatus;
    if (run.status === expected) return run;
    if (run.status === 'failed' || run.status === 'succeeded' || run.status === 'canceled') {
      throw new Error(`run ${runId} reached ${run.status} before ${expected}`);
    }
    await delay(25);
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

async function readRunEvents(file: string): Promise<RunEvent[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

async function waitForRunEvents(
  file: string,
  ready: (events: RunEvent[]) => boolean,
): Promise<RunEvent[]> {
  const startedAt = Date.now();
  let events: RunEvent[] = [];
  while (Date.now() - startedAt < 5_000) {
    events = await readRunEvents(file);
    if (ready(events)) return events;
    await delay(25);
  }
  return events;
}

async function readClaudeAttemptArgs(file: string): Promise<string[][]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function sessionIdArg(args: string[]): string | null {
  const index = args.indexOf('--session-id');
  return index >= 0 ? args[index + 1] ?? null : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
