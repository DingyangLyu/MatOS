import express from 'express';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { registerMatOSOpsRoutes } from '../../src/routes/matos-ops.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startOpsRoute(input: NonNullable<Parameters<typeof registerMatOSOpsRoutes>[1]>) {
  const app = express();
  registerMatOSOpsRoutes(app, input);
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('matos ops route cache', () => {
  it('single-flights cold reads and returns stale telemetry during refresh', async () => {
    let now = 0;
    let generation = 0;
    const firstGate = deferred();
    const refreshGate = deferred();
    const execute = vi.fn(async (args: string[]) => {
      if (generation === 0) await firstGate.promise;
      if (generation === 1) await refreshGate.promise;
            return { ok: true, generation };
    });
    const loadWorkflowRuns = vi.fn(async () => []);
    const route = await startOpsRoute({
      execute,
      now: () => now,
      freshMs: 10,
      staleMs: 100,
      loadWorkflowRuns,
      readGpuStatus: async () => null,
      readSystemStatus: () => ({
        cpuCount: 1,
        load1: 0,
        load5: 0,
        load15: 0,
        totalMemBytes: 1,
        freeMemBytes: 1,
      }),
    });
    try {
      const first = fetch(`${route.baseUrl}/api/matos/ops`);
      const concurrent = fetch(`${route.baseUrl}/api/matos/ops`);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      firstGate.resolve();
      const cold = await Promise.all([first, concurrent].map(async (request) => request.then((r) => r.json())));
      expect(cold[0]).toEqual(cold[1]);
      expect(loadWorkflowRuns).toHaveBeenCalledTimes(1);

      generation = 1;
      now = 11;
      const stale = await (await fetch(`${route.baseUrl}/api/matos/ops`)).json() as {
        evolve: { generation: number };
      };
      expect(stale.evolve.generation).toBe(0);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(loadWorkflowRuns).toHaveBeenCalledTimes(2);

      const concurrentStale = await (await fetch(`${route.baseUrl}/api/matos/ops`)).json() as {
        evolve: { generation: number };
      };
      expect(concurrentStale.evolve.generation).toBe(0);
      expect(execute).toHaveBeenCalledTimes(2);

      refreshGate.resolve();
      await vi.waitFor(async () => {
        now = 12;
        const current = await (await fetch(`${route.baseUrl}/api/matos/ops`)).json() as {
          evolve: { generation: number };
        };
        expect(current.evolve.generation).toBe(1);
      });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      firstGate.resolve();
      refreshGate.resolve();
      await route.close();
    }
  });
});
