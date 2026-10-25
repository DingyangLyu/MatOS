// Coverage for the /api/test/connection route using fake CLI bins for
// deterministic agent outcomes.

import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as platform from '@open-design/platform';
import {
  createAgentSink,
  isSmokeOkReply,
  mergeNoProxyWithLoopbackDefaults,
  proxyDispatcherRequestInit,
  redactSecrets,
  resolveConnectionTestTimeoutMs,
  testAgentConnection,
} from '../src/connectionTest.js';
import { startServer } from '../src/server.js';
import { rememberLiveModels } from '../src/runtimes/models.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface StartedServer {
  url: string;
  server: http.Server;
}

const realFetch = globalThis.fetch;
let baseUrl: string;
let server: http.Server;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/plain', ...(init?.headers ?? {}) },
  });
}

function passThroughOrUpstream(handler: (url: string, init?: FetchInit) => Response | Promise<Response>) {
  return vi.fn((input: FetchInput, init?: FetchInit) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    return Promise.resolve(handler(url, init));
  });
}

async function withFakeAgent<T>(
  binName: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-bin-'));
  const oldPath = process.env.PATH;
  try {
    if (process.platform === 'win32') {
      const runner = path.join(dir, `${binName}-test-runner.cjs`);
      await fsp.writeFile(runner, script);
      await fsp.writeFile(
        path.join(dir, `${binName}.cmd`),
        `@echo off\r\nnode "${runner}" %*\r\n`,
      );
    } else {
      const bin = path.join(dir, binName);
      await fsp.writeFile(bin, `#!/usr/bin/env node\n${script}`);
      await fsp.chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function withFakeMatOS<T>(script: string, run: () => Promise<T>): Promise<T> {
  return withFakeAgent('matos', script, run);
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForPidToExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
  baseUrl = started.url;
  server = started.server;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));


describe('POST /api/test/connection agent mode', () => {


  it('spawns agent tests with draft allowlisted CLI env', async () => {
    const markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-env-'));
    const envFile = path.join(markerDir, 'env.json');
    const matosModel = 'deepseek-flash';
    try {
      await withFakeMatOS(
        `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  MATOS_DSH_MODEL: process.env.MATOS_DSH_MODEL || null,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || null,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || null,
  SHOULD_NOT_PASS: process.env.OD_CONNECTION_TEST_SHOULD_NOT_PASS || null,
}));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
setImmediate(() => process.exit(0));
`,
        async () => {
          // Settings -> Local CLI -> Advanced is an explicit low-level CLI
          // env override. API keys configured there are passed to the child,
          // while unrelated env keys remain filtered by app-config allowlists.
          const res = await realFetch(`${baseUrl}/api/test/connection`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'agent',
              agentId: 'matos',
              agentCliEnv: {
                matos: {
                  MATOS_DSH_MODEL: matosModel,
                  DEEPSEEK_BASE_URL: 'https://proxy.example.com/anthropic',
                  DEEPSEEK_API_KEY: 'test-provider-key',
                  OD_CONNECTION_TEST_SHOULD_NOT_PASS: 'leaked',
                },
              },
            }),
          });
          expect(res.status).toBe(200);
          await expect(res.json()).resolves.toMatchObject({
            ok: true,
            kind: 'success',
            agentName: 'MatOS',
          });
          await expect(fsp.readFile(envFile, 'utf8')).resolves.toBe(
            JSON.stringify({
              MATOS_DSH_MODEL: matosModel,
              DEEPSEEK_BASE_URL: 'https://proxy.example.com/anthropic',
              DEEPSEEK_API_KEY: 'test-provider-key',
              SHOULD_NOT_PASS: null,
            }),
          );
        },
      );
    } finally {
      await fsp.rm(markerDir, { recursive: true, force: true });
    }
  });


  it('classifies split agent model-error text after buffering the full response', async () => {
    await withFakeMatOS(
      `
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Error:' }] } }));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' model not found' }] } }));
`,
      async () => {
        const res = await realFetch(`${baseUrl}/api/test/connection`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'agent', agentId: 'matos', model: 'missing-model' }),
        });
        await expect(res.json()).resolves.toMatchObject({
          ok: false,
          kind: 'not_found_model',
          model: 'missing-model',
        });
      },
    );
  });

  it('reports structured agent stream errors without treating them as success', async () => {
    await withFakeMatOS(
      `console.log(JSON.stringify({ type: 'assistant', error: 'unknown', message: { content: [{ type: 'text', text: 'MatOS requires a newer version of the runtime.' }] } }));`,
      async () => {
        const result = await testAgentConnection({ agentId: 'matos' });
        expect(result).toMatchObject({
          ok: false,
          kind: 'agent_spawn_failed',
          agentName: 'MatOS',
        });
        expect(result.detail).toContain('requires a newer version');
      },
    );
  });


  it('uses MATOS_BIN overrides when testing agent connections', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-matos-bin-'));
    const oldPath = process.env.PATH;
    try {
      const bin = path.join(dir, 'matos-next');
      await fsp.writeFile(
        bin,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));\n`,
      );
      await fsp.chmod(bin, 0o755);
      process.env.PATH = oldPath ?? '';

      const result = await testAgentConnection({
        agentId: 'matos',
        agentCliEnv: {
          matos: {
            MATOS_BIN: bin,
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        kind: 'success',
        agentName: 'MatOS',
        diagnostics: { binaryPath: bin },
      });

    } finally {
      process.env.PATH = oldPath;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the available MatOS path when a configured executable is missing', async () => {
    await withFakeMatOS(
      `console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));\n`,
      async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-matos-invalid-'));
        try {
          const invalidBin = path.join(dir, 'matos-missing');
          const result = await testAgentConnection({
            agentId: 'matos',
            agentCliEnv: {
              matos: {
                MATOS_BIN: invalidBin,
              },
            },
          });

          expect(result).toMatchObject({
            ok: true,
            kind: 'success',
            agentName: 'MatOS',
            sample: 'ok',
            diagnostics: { binaryPath: expect.any(String) },
          });
        } finally {
          await fsp.rm(dir, { recursive: true, force: true });
        }
      },
    );
  });


  it('rejects invalid custom model ids before spawning an agent', async () => {
    const markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-argv-'));
    const argvFile = path.join(markerDir, 'argv.json');
    try {
      await withFakeMatOS(
        `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
`,
        async () => {
          const res = await realFetch(`${baseUrl}/api/test/connection`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'agent',
              agentId: 'matos',
              model: '--not-a-model',
              reasoning: 'totally-invalid-effort',
            }),
          });
          expect(res.status).toBe(200);
          await expect(res.json()).resolves.toMatchObject({
            ok: false,
            kind: 'invalid_model_id',
            model: '--not-a-model',
            agentName: 'MatOS',
          });

          await expect(fsp.access(argvFile)).rejects.toThrow();
        },
      );
    } finally {
      await fsp.rm(markerDir, { recursive: true, force: true });
    }
  });

  it('drops invalid agent reasoning options before spawning an agent', async () => {
    const markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-argv-'));
    const argvFile = path.join(markerDir, 'argv.json');
    try {
      await withFakeMatOS(
        `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
`,
        async () => {
          const res = await realFetch(`${baseUrl}/api/test/connection`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'agent',
              agentId: 'matos',
              model: 'role:compute',
              reasoning: 'totally-invalid-effort',
            }),
          });
          expect(res.status).toBe(200);
          await expect(res.json()).resolves.toMatchObject({
            ok: true,
            kind: 'success',
            model: 'role:compute',
          });

          const args = JSON.parse(await fsp.readFile(argvFile, 'utf8')) as string[];
          expect(args).toEqual(expect.arrayContaining(['--role', 'role:compute']));
          expect(args.some((arg) => arg.includes('model_reasoning_effort'))).toBe(false);
          expect(args.some((arg) => arg.includes('totally-invalid-effort'))).toBe(false);
        },
      );
    } finally {
      await fsp.rm(markerDir, { recursive: true, force: true });
    }
  });

  it('reports unknown when the agent emits only raw schema-drift output', async () => {
    await withFakeMatOS(
      `console.log(JSON.stringify({ type: 'future.event', payload: { text: 'ok' } }));`,
      async () => {
        const result = await testAgentConnection({ agentId: 'matos' });
        expect(result).toMatchObject({
          ok: false,
          kind: 'unknown',
          agentName: 'MatOS',
        });
      },
    );
  });

  it('hard-cancels aborted agent probes before cleaning up', async () => {
    const markerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-marker-'));
    const pidFile = path.join(markerDir, 'pid');
    const termFile = path.join(markerDir, 'term');
    try {
      await withFakeMatOS(
        `
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  console.log('matos 9.9.9');
  process.exit(0);
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(termFile)}, 'term');
});
setInterval(() => {}, 1000);
`,
        async () => {
          const controller = new AbortController();
          const pending = testAgentConnection({
            agentId: 'matos',
            signal: controller.signal,
          });
          await Promise.race([
            waitForFile(pidFile, 15_000),
            pending.then((result) => {
              throw new Error(
                `Agent probe finished before fake agent wrote pid: ${JSON.stringify(result)}`,
              );
            }),
          ]);
          controller.abort();
          await expect(pending).resolves.toMatchObject({
            ok: false,
            kind: 'timeout',
          });
        },
      );
      if (process.platform !== 'win32') {
        await expect(fsp.readFile(termFile, 'utf8')).resolves.toBe('term');
      }
      const pid = Number(await fsp.readFile(pidFile, 'utf8'));
      if (process.platform === 'win32') {
        process.kill(pid, 'SIGKILL');
        await waitForPidToExit(pid);
      } else {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      await fsp.rm(markerDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('reports agent_not_installed for an unknown agent id', async () => {
    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent', agentId: 'this-agent-does-not-exist' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('agent_not_installed');
    expect(body.model).toBe('default');
  });

  it('rejects requests missing agentId with HTTP 400', async () => {
    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent' }),
    });
    expect(res.status).toBe(400);
  });

  // Regression coverage for #2248: the daemon must return structured
  // diagnostics next to the existing `kind`/`detail` strings so Settings
  // and CLI consumers don't have to scrape the human-readable detail
  // line to know what phase failed, which binary path was used, or what
  // the child's exit metadata was. The legacy fields stay unchanged so
  // older clients keep rendering.


});

describe('connection test helpers', () => {
  it('redacts the exact submitted provider key when it appears in body text', () => {
    const detail = redactSecrets(
      'Incorrect API key provided: sk-test-raw-secret.',
      ['sk-test-raw-secret'],
    );

    expect(detail).toBe('Incorrect API key provided: [REDACTED].');
    expect(detail).not.toContain('sk-test-raw-secret');
  });

  it('does not resolve the agent smoke test from thinking deltas', async () => {
    vi.useFakeTimers();
    const sink = createAgentSink();
    sink.send('agent', { type: 'thinking_delta', delta: 'thinking first' });
    let settled = false;
    sink.result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    sink.send('agent', { type: 'text_delta', delta: 'ok' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(sink.result).resolves.toEqual({ kind: 'text', text: 'ok' });
  });

  it('rejects the agent smoke test from structured stream errors', async () => {
    const sink = createAgentSink();
    sink.send('agent', {
      type: 'error',
      message: "The 'deepseek-v4' model requires a newer version of MatOS.",
    });

    await expect(sink.result).resolves.toMatchObject({
      kind: 'streamError',
      error: expect.objectContaining({
        message: "The 'deepseek-v4' model requires a newer version of MatOS.",
      }),
    });
  });

  it('debounces agent text chunks before resolving', async () => {
    vi.useFakeTimers();
    const sink = createAgentSink();
    sink.send('agent', { type: 'text_delta', delta: 'Error:' });
    await vi.advanceTimersByTimeAsync(499);
    sink.send('agent', { type: 'text_delta', delta: ' model not found' });
    await vi.advanceTimersByTimeAsync(500);

    await expect(sink.result).resolves.toEqual({
      kind: 'text',
      text: 'Error: model not found',
    });
  });

  it('requires the smoke reply to be exactly ok after whitespace and case', () => {
    expect(isSmokeOkReply('ok')).toBe(true);
    expect(isSmokeOkReply(' OK \n')).toBe(true);
    expect(isSmokeOkReply('ok.')).toBe(false);
    expect(
      isSmokeOkReply(
        "There's an issue with the selected model (abcde). It may not exist.",
      ),
    ).toBe(false);
  });
});

describe('connection test timeout overrides', () => {
  it('returns the fallback when the override is missing or empty', () => {
    expect(
      resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
        OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: '',
      }),
    ).toBe(45_000);
  });

  it('honors a positive integer override', () => {
    expect(
      resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
        OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: '120000',
      }),
    ).toBe(120_000);
  });

  it('warns and falls back on non-numeric, zero, negative, or non-integer overrides', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of ['fast', '0', '-1', '1.5', 'NaN']) {
        expect(
          resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
            OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: bad,
          }),
        ).toBe(45_000);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Regression: a previous version of resolveConnectionTestTimeoutMs
  // accepted any positive integer, but Node's setTimeout silently
  // clamps delays above 2^31-1 to ~1 ms (with a TimeoutOverflowWarning).
  // An override that meant to extend the budget would instead make
  // every connection test fail almost immediately — the safety
  // timeout would be effectively disarmed.
  it('rejects values above the Node setTimeout maximum (2^31-1)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tooLarge = '3000000000'; // ~50 minutes; exceeds 2_147_483_647 ms
      expect(
        resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
          OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: tooLarge,
        }),
      ).toBe(45_000);
      // The exact maximum is still accepted; anything past it is not.
      expect(
        resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
          OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: '2147483647',
        }),
      ).toBe(2_147_483_647);
      expect(
        resolveConnectionTestTimeoutMs('OD_CONNECTION_TEST_AGENT_TIMEOUT_MS', 45_000, {
          OD_CONNECTION_TEST_AGENT_TIMEOUT_MS: '2147483648',
        }),
      ).toBe(45_000);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
