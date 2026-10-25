import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalSameOrigin } from '../../src/origin-validation.js';
import { registerStaticResourceRoutes } from '../../src/routes/static-resource.js';
import type { DetectAgentsOptions } from '../../src/runtimes/detection.js';
import type { DetectedAgent } from '../../src/runtimes/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const MATOS_AGENT = {
  id: 'matos',
  name: 'MatOS',
  bin: 'matos',
  versionArgs: ['--version'],
  models: [{ id: 'default', label: 'Default' }],
  modelsSource: 'live',
  available: true,
  streamFormat: 'claude-stream-json',
} as unknown as DetectedAgent;

type AgentStreamDetector = (
  env?: Record<string, Record<string, string>>,
  options?: DetectAgentsOptions,
) => AsyncGenerator<DetectedAgent>;

async function startAgentRoute(input: {
  detector: AgentStreamDetector;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-cache-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const app = express();
  let server!: http.Server;
  const catalog = registerStaticResourceRoutes(app, {
    http: {
      createSseResponse: () => undefined,
      isLocalSameOrigin,
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      resolvedPortRef: {
        get current() {
          const address = server?.address();
          return typeof address === 'object' && address ? address.port : 0;
        },
      },
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: message, code }),
      sendMulterError: () => undefined,
    },
    paths: {
      ARTIFACTS_DIR: path.join(tempRoot, 'artifacts'),
      DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'design-templates'),
      OD_BIN: path.join(tempRoot, 'od'),
      PROJECT_ROOT: tempRoot,
      PROJECTS_DIR: path.join(tempRoot, 'projects'),
      RUNTIME_DATA_DIR: dataDir,
      RUNTIME_DATA_DIR_CANONICAL: dataDir,
      SKILLS_DIR: path.join(tempRoot, 'skills'),
      USER_DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'user-design-templates'),
      USER_SKILLS_DIR: path.join(tempRoot, 'user-skills'),
    },
    resources: {
      listAllSkills: async () => [],
      listAllDesignTemplates: async () => [],
      listAllSkillLikeEntries: async () => [],
      mimeFor: () => 'application/octet-stream',
    },
    agentDetection: {
      detectAgentsStream: input.detector,
      ...(input.now ? { now: input.now } : {}),
      ...(input.freshMs !== undefined ? { freshMs: input.freshMs } : {}),
      ...(input.staleMs !== undefined ? { staleMs: input.staleMs } : {}),
    },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    invalidateAgentCache: catalog.invalidateAgentCache,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent catalog route cache', () => {
  it('invalidates pre-install results and prevents an older in-flight probe restoring them', async () => {
    vi.stubEnv('MATOS_AGENT_ONLY', '1');
    const staleStarted = deferred<void>();
    const staleGate = deferred<void>();
    let calls = 0;
    const detector: AgentStreamDetector = async function* () {
      const call = ++calls;
      if (call === 2) {
        staleStarted.resolve();
        await staleGate.promise;
      }
      yield { ...MATOS_AGENT, available: call >= 3 };
    };
    const route = await startAgentRoute({ detector });
    try {
      const read = async () => (await (await fetch(`${route.baseUrl}/api/agents`)).json()) as { agents: DetectedAgent[] };
      expect((await read()).agents[0]?.available).toBe(false);
      route.invalidateAgentCache();
      const staleRequest = read();
      await staleStarted.promise;
      route.invalidateAgentCache();
      expect((await read()).agents[0]?.available).toBe(true);
      staleGate.resolve();
      await staleRequest;
      expect((await read()).agents[0]?.available).toBe(true);
      expect(calls).toBe(3);
    } finally {
      staleGate.resolve();
      await route.close();
    }
  });

  it('flushes an SSE heartbeat before a cold probe and pre-filters to MatOS', async () => {
    vi.stubEnv('MATOS_AGENT_ONLY', '1');
    const gate = deferred<void>();
    const optionsSeen: DetectAgentsOptions[] = [];
    const detector: AgentStreamDetector = async function* (_env, options = {}) {
      optionsSeen.push(options);
      await gate.promise;
      yield MATOS_AGENT;
    };
    const route = await startAgentRoute({ detector });
    try {
      const response = await Promise.race([
        fetch(`${route.baseUrl}/api/agents?stream=1`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE headers were not flushed')), 250),
        ),
      ]);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(': connected');
      await vi.waitFor(() => expect(optionsSeen).toEqual([{ agentIds: ['matos'] }]));

      gate.resolve();
      let rest = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).toContain('event: agent');
      expect(rest).toContain('event: done');
    } finally {
      gate.resolve();
      await route.close();
    }
  });

  it('single-flights concurrent cold requests and reuses the fresh result', async () => {
    vi.stubEnv('MATOS_AGENT_ONLY', '1');
    const gate = deferred<void>();
    let calls = 0;
    const detector: AgentStreamDetector = async function* () {
      calls += 1;
      await gate.promise;
      yield MATOS_AGENT;
    };
    const route = await startAgentRoute({ detector });
    try {
      const first = fetch(`${route.baseUrl}/api/agents`);
      const second = fetch(`${route.baseUrl}/api/agents`);
      await vi.waitFor(() => expect(calls).toBe(1));
      gate.resolve();

      const bodies = await Promise.all([first, second].map(async (pending) => (await pending).json()));
      expect(bodies).toEqual([
        { agents: [expect.objectContaining({ id: 'matos' })] },
        { agents: [expect.objectContaining({ id: 'matos' })] },
      ]);
      expect(await (await fetch(`${route.baseUrl}/api/agents`)).json()).toEqual({
        agents: [expect.objectContaining({ id: 'matos' })],
      });
      expect(calls).toBe(1);
    } finally {
      await route.close();
    }
  });

  it('returns stale agents without waiting for the single background refresh', async () => {
    vi.stubEnv('MATOS_AGENT_ONLY', '1');
    let now = 0;
    let calls = 0;
    const refreshGate = deferred<void>();
    const detector: AgentStreamDetector = async function* () {
      calls += 1;
      if (calls > 1) await refreshGate.promise;
      yield MATOS_AGENT;
    };
    const route = await startAgentRoute({
      detector,
      now: () => now,
      freshMs: 10,
      staleMs: 100,
    });
    try {
      expect((await (await fetch(`${route.baseUrl}/api/agents`)).json() as any).agents).toHaveLength(1);
      now = 11;
      const response = await fetch(`${route.baseUrl}/api/agents`);
      expect((await response.json() as any).agents).toHaveLength(1);
      await vi.waitFor(() => expect(calls).toBe(2));
      expect(calls).toBe(2);
      refreshGate.resolve();
    } finally {
      refreshGate.resolve();
      await route.close();
    }
  });
});
