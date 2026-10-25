// Protocol/filesystem regression fixtures; real DSH inference is verified separately.
import type http from 'node:http';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  promises as fsp,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  composeLiveInstructionPrompt,
  describeStablePromptCache,
  resolveChatExtraAllowedDirs,
  resolveResearchCommandContract,
  startServer,
} from '../src/server.js';
import { skillCwdAliasSegment } from '../src/cwd-aliases.js';
import { getAgentDef } from '../src/agents.js';
import { upsertMessage } from '../src/db.js';


async function withFakeAgent<T>(
  binName: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'od-chat-route-bin-'));
  const oldPath = process.env.PATH;
  try {
    if (process.platform === 'win32') {
      const runner = join(dir, `${binName}-test-runner.cjs`);
      await fsp.writeFile(runner, script);
      await fsp.writeFile(
        join(dir, `${binName}.cmd`),
        `@echo off\r\nnode "${runner}" %*\r\n`,
      );
    } else {
      const bin = join(dir, binName);
      await fsp.writeFile(bin, `#!/usr/bin/env node\n${script}`);
      await fsp.chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
    killProcessesUsingPath(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function killProcessesUsingPath(pathFragment: string): void {
  if (process.platform === 'win32') return;
  let output = '';
  try {
    output = execFileSync('pgrep', ['-f', pathFragment], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

describe('/api/chat', () => {
  let server: http.Server;
  let baseUrl: string;
  const originalPath = process.env.PATH;
  const originalAgentHome = process.env.OD_AGENT_HOME;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalAgentHome == null) {
      delete process.env.OD_AGENT_HOME;
    } else {
      process.env.OD_AGENT_HOME = originalAgentHome;
    }
  });

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reference an out-of-scope response while starting a run', async () => {
    process.env.PATH = '';
    const emptyAgentHome = mkdtempSync(join(tmpdir(), 'od-empty-agent-home-'));
    tempDirs.push(emptyAgentHome);
    process.env.OD_AGENT_HOME = emptyAgentHome;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'matos',
        message: 'hello',
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).not.toContain('res is not defined');
    expect(body).toContain('AGENT_UNAVAILABLE');
  });

  it('sends MatOS only user-authored text and suppresses every Open Design prompt layer', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'matos-native-prompt-'));
    tempDirs.push(captureDir);
    const capturePath = join(captureDir, 'prompt.txt');
    const projectId = `matos-native-prompt-${randomUUID()}`;
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'MatOS native prompt authority',
        skillId: null,
      }),
    });
    expect(projectResponse.status).toBe(200);
    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    const conversations = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversations.conversations[0]?.id;
    expect(conversationId).toBeTruthy();
    const previousCapturePath = process.env.OD_CAPTURE_PROMPT_PATH;
    process.env.OD_CAPTURE_PROMPT_PATH = capturePath;
    try {
      await withFakeAgent(
        'matos',
        `
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('matos-test');
  process.exit(0);
}
let input = '';
let replied = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (replied || !input.includes('\\n')) return;
  replied = true;
  const line = input.slice(0, input.indexOf('\\n'));
  const frame = JSON.parse(line);
  fs.writeFileSync(process.env.OD_CAPTURE_PROMPT_PATH, frame.message.content[0].text, 'utf8');
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'matos-msg-1' } } }));
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }));
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native prompt ok' } } }));
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
  console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: 'end_turn' }));
  setTimeout(() => process.exit(0), 20);
});
`,
        async () => {
          const userText = 'Run a silicon band-structure calculation.';
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'matos',
              projectId,
              conversationId,
              message: `## user\n${userText}`,
              currentPrompt: userText,
              systemPrompt: 'legacy caller system prompt: use the browser',
              skillIds: ['faq-page'],
              titleGeneration: { enabled: true },
              research: { enabled: true },
              context: {
                workspaceItems: [{ id: 'terminal-1', kind: 'terminal', label: 'Terminal' }],
              },
            }),
          });
          expect(createResponse.status).toBe(202);
          const created = await createResponse.json() as { runId: string };
          const { runId } = created;
          const statusBody = await waitForRunStatus(baseUrl, runId);
          expect(statusBody.status).toBe('succeeded');

          const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`);
          const eventsBody = await readSseUntil(eventsResponse, 'event: final');
          expect(eventsBody).not.toContain('pipeline_stage_');
          expect(eventsBody).not.toContain('browser_use_unavailable');

          const prompt = readFileSync(capturePath, 'utf8');
          expect(prompt).toBe(`## user\n${userText}`);
          for (const marker of [
            '# Instructions',
            '# User request',
            'OD core directives',
            'MatOS core directives',
            'Runtime tool environment',
            'legacy caller system prompt',
            'faq-page',
            '<od-title>',
            'Selected run context',
            'question-form',
            'TodoWrite',
          ]) {
            expect(prompt).not.toContain(marker);
          }
        },
      );
    } finally {
      if (previousCapturePath === undefined) delete process.env.OD_CAPTURE_PROMPT_PATH;
      else process.env.OD_CAPTURE_PROMPT_PATH = previousCapturePath;
    }
  });

  it('marks json stream runs failed when an error frame exits with code 0', async () => {
    const conversationId = `conv-${randomUUID()}`;

    await withFakeAgent(
      'matos',
      `
console.log(JSON.stringify({
  type: 'assistant',
  error: 'unknown',
  message: { content: [{ type: 'text', text: 'model not found: test-model' }] },
}));
process.exit(0);
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'matos',
            conversationId,
            message: 'hello',
          }),
        });
        const body = await response.text();

        expect(response.ok).toBe(true);
        expect(body).toContain('AGENT_EXECUTION_FAILED');
        expect(body).toContain('model not found: test-model');
        expect(body).toContain('"status":"failed"');
        expect(body).not.toContain('"status":"succeeded"');

        const runsResponse = await fetch(
          `${baseUrl}/api/runs?conversationId=${encodeURIComponent(conversationId)}`,
        );
        const runsBody = (await runsResponse.json()) as {
          runs: Array<{ conversationId: string | null; status: string; exitCode: number | null }>;
        };

        expect(runsBody.runs).toHaveLength(1);
        expect(runsBody.runs[0]).toMatchObject({
          conversationId,
          status: 'failed',
          exitCode: 1,
        });
      },
    );
  });


  it('reuses an existing assistant message row instead of creating a duplicate when assistantMessageId is supplied', async () => {
    if (!process.env.OD_DATA_DIR) {
      throw new Error('OD_DATA_DIR is required for assistant message reuse tests');
    }
    const projectId = `proj-${randomUUID()}`;
    const assistantMessageId = `assistant-${randomUUID()}`;

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Assistant row reuse fixture' }),
    });
    expect(createProjectResponse.ok).toBe(true);

    const conversationsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversationsResponse.ok).toBe(true);
    const conversationsBody = await conversationsResponse.json() as {
      conversations: Array<{ id: string }>;
    };
    const conversationId = conversationsBody.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const dbFile = resolve(process.env.OD_DATA_DIR, 'app.sqlite');
    const sqlite = new Database(dbFile);
    try {
      upsertMessage(sqlite as never, conversationId!, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        runStatus: 'failed',
        startedAt: Date.now() - 1_000,
        endedAt: Date.now() - 500,
      });
    } finally {
      sqlite.close();
    }

    await withFakeAgent(
      'matos',
      `
process.stdin.resume();
process.stdin.once('data', () => {
  console.log(JSON.stringify({ type: 'step_start' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reused-assistant-row-ok' }] } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
  process.exit(0);
});
`,
      async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'matos',
            projectId,
            conversationId,
            assistantMessageId,
            message: 'retry this turn',
          }),
        });
        const body = await response.text();
        expect(response.ok).toBe(true);
        expect(body).toContain('reused-assistant-row-ok');
      },
    );

    const verifyDb = new Database(dbFile, { readonly: true });
    try {
      const rows = verifyDb
        .prepare(`SELECT id, content, run_id FROM messages WHERE conversation_id = ? AND role = 'assistant'`)
        .all(conversationId) as Array<{ id: string; content: string; run_id: string | null }>;
      expect(rows.filter((row) => row.id === assistantMessageId)).toHaveLength(1);
      expect(rows.some((row) => row.id !== assistantMessageId && row.content.includes('reused-assistant-row-ok'))).toBe(false);
      await expect.poll(() => (verifyDb.prepare('SELECT content FROM messages WHERE id = ?').get(assistantMessageId) as { content: string } | undefined)?.content).toContain('reused-assistant-row-ok');
    } finally {
      verifyDb.close();
    }
  });


  it('marks reasoning-only stream runs failed when no assistant output is produced', async () => {
    const reasoningLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'I should inspect the project before answering.',
          },
        ],
      },
    });
    const resultLine = JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 0 },
    });

    await withFakeAgent(
      'matos',
      `
console.log(${JSON.stringify(reasoningLine)});
console.log(${JSON.stringify(resultLine)});
process.exit(0);
`,
      async () => {
        const createResponse = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'matos',
            message: 'think but do not answer',
          }),
        });
        expect(createResponse.status).toBe(202);
        const { runId } = await createResponse.json() as { runId: string };

        const eventsController = new AbortController();
        const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
          signal: eventsController.signal,
        });
        const eventsBody = await readSseUntil(
          eventsResponse,
          'Agent completed without producing any output',
        );
        eventsController.abort();
        const statusBody = await waitForRunStatus(baseUrl, runId);

        expect(eventsBody).toContain('"type":"thinking_delta"');
        expect(eventsBody).toContain('AGENT_EXECUTION_FAILED');
        expect(eventsBody).toContain('Agent completed without producing any output');
        expect(eventsBody).not.toContain('"status":"succeeded"');
        expect(statusBody.status).toBe('failed');
      },
    );
  });


  it('fails stalled json-stream runs after the inactivity timeout elapses', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '500';
    try {
      await withFakeAgent(
        'matos',
        `
console.log(JSON.stringify({ type: 'step_start' }));
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'matos',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const eventsController = new AbortController();
          const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
            signal: eventsController.signal,
          });
          const eventsBody = await readSseUntil(eventsResponse, 'event: error');
          eventsController.abort();
          const statusBody = await waitForRunStatus(baseUrl, runId);

          expect(eventsBody).toContain('event: error');
          expect(eventsBody).toContain('Agent stalled without emitting any new output');
          expect(eventsBody).toContain('Phase details: spawned agent matos;');
          expect(eventsBody).not.toContain('spawned agent binary');
          expect(eventsBody).toMatch(/stdout arrived: (yes|no)/);
          expect(statusBody.status).toBe('failed');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('keeps MatOS stream runs alive while structured output is still flowing', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '3000';
    try {
      await withFakeAgent(
        'matos',
        `
const lines = [
  JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' }, ttft_ms: 10 } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, duration_ms: 700, stop_reason: 'end_turn' }),
];
let index = 0;
console.log(lines[index++]);
const timer = setInterval(() => {
  if (index >= lines.length) {
    clearInterval(timer);
    process.exit(0);
    return;
  }
  console.log(lines[index++]);
}, 750);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'matos',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const statusBody = await waitForRunStatus(baseUrl, runId);
          expect(statusBody.status).toBe('succeeded');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });


  it('caps oversized inactivity overrides so Node does not fire the timer immediately', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '10000000000';
    try {
      await withFakeAgent(
        'matos',
        `
setTimeout(() => {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
  process.exit(0);
}, 50);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'matos',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const statusBody = await waitForRunStatus(baseUrl, runId);
          expect(statusBody.status).toBe('succeeded');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });

  it('marks stalled runs failed even when the child ignores SIGTERM', async () => {
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '500';
    try {
      await withFakeAgent(
        'matos',
        `
console.log(JSON.stringify({ type: 'step_start' }));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
        async () => {
          const createResponse = await fetch(`${baseUrl}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: 'matos',
              message: 'hello',
            }),
          });
          expect(createResponse.status).toBe(202);
          const { runId } = await createResponse.json() as { runId: string };

          const eventsController = new AbortController();
          const eventsResponse = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
            signal: eventsController.signal,
          });
          const eventsBody = await readSseUntil(eventsResponse, 'event: error');
          eventsController.abort();
          const statusBody = await waitForRunStatus(baseUrl, runId);

          expect(eventsBody).toContain('Agent stalled without emitting any new output');
          expect(statusBody.status).toBe('failed');
        },
      );
    } finally {
      if (previous == null) {
        delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      } else {
        process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
      }
    }
  });


});

describe('daemon run creation during shutdown', () => {
  it('rejects new run creation while shutdown cleanup is still in flight', async () => {
    const previousGrace = process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS;
    process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS = '100';
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown: () => Promise<void>;
    };
    try {
      await withFakeAgent(
        'matos',
        `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
        async () => {
          const activeResponse = await fetch(`${started.url}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'matos', message: 'hello' }),
          });
          expect(activeResponse.status).toBe(202);
          const { runId } = await activeResponse.json() as { runId: string };
          await waitForRunStatus(started.url, runId, (status) => status === 'running');

          const shutdownPromise = started.shutdown();

          const runResponse = await fetch(`${started.url}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'matos', message: 'late run' }),
          });
          const chatResponse = await fetch(`${started.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'matos', message: 'late chat' }),
          });

          expect(runResponse.status).toBe(503);
          expect(chatResponse.status).toBe(503);
          await shutdownPromise;
        },
      );
    } finally {
      if (previousGrace == null) {
        delete process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS;
      } else {
        process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS = previousGrace;
      }
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});

async function readSseUntil(response: Response, marker: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { done, value } = await reader.read();
    if (done) return body;
    body += decoder.decode(value, { stream: true });
    if (body.includes(marker)) return body;
  }
  return body;
}

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
  done: (status: string) => boolean = (status) => status !== 'queued' && status !== 'running',
): Promise<{ status: string }> {
  let lastStatus = 'unknown';
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const statusResponse = await fetch(`${baseUrl}/api/runs/${runId}`);
    const statusBody = await statusResponse.json() as { status: string };
    lastStatus = statusBody.status;
    if (done(statusBody.status)) return statusBody;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not reach expected status; last status: ${lastStatus}`);
}

describe('chat prompt helpers', () => {
  it('defaults enabled research without an explicit query to the current message', () => {
    const prompt = resolveResearchCommandContract(
      { enabled: true },
      'EV market 2025 trends',
    );

    expect(prompt).toContain('Canonical query for this run:');
    expect(prompt).toContain('EV market 2025 trends');
    expect(prompt).toContain('the first tool action must be the research command');
  });

  it('describes stable prompt cache hits and miss reasons', () => {
    expect(describeStablePromptCache({
      isResuming: false,
      storedStablePromptHash: null,
      currentStableHash: 'hash-a',
    })).toEqual({
      stablePromptHash: 'hash-a',
      hit: false,
      missReason: 'new-session',
    });

    expect(describeStablePromptCache({
      isResuming: true,
      storedStablePromptHash: 'hash-a',
      currentStableHash: 'hash-a',
    })).toEqual({
      stablePromptHash: 'hash-a',
      hit: true,
      missReason: null,
    });

    expect(describeStablePromptCache({
      isResuming: true,
      storedStablePromptHash: 'hash-a',
      currentStableHash: 'hash-b',
    })).toEqual({
      stablePromptHash: 'hash-b',
      hit: false,
      missReason: 'stable-prompt-changed',
    });
  });


  it('keeps resource and linked dirs for MatOS agents', () => {
    const existingDirs = new Set([
      '/repo/skills',
      '/linked/reference',
    ]);
    const dirs = resolveChatExtraAllowedDirs({
      skillsDir: '/repo/skills',
      linkedDirs: ['/linked/reference'],
      existsSync: (dir: string) => existingDirs.has(dir),
    });

    expect(dirs).toEqual([
      '/repo/skills',
      '/linked/reference',
    ]);
  });
});
