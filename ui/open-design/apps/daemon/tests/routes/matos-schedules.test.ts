import express from 'express';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeScheduleRecord,
  normalizeWorkflowOptions,
  registerMatOSScheduleRoutes,
} from '../../src/routes/matos-schedules.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startScheduleRoute(
  input: NonNullable<Parameters<typeof registerMatOSScheduleRoutes>[1]>,
) {
  const app = express();
  app.use(express.json());
  registerMatOSScheduleRoutes(app, { ...input, startAutotick: false });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('matos schedules bridge helpers', () => {
  it('normalizes a native cron trigger record into the flat schedule shape', () => {
    const summary = normalizeScheduleRecord({
      triggerId: 'trg-1',
      workflowRef: 'workflow:relax@0.1.0',
      appId: 'matos-schedule',
      eventId: 'matos.schedule.cron',
      name: 'Nightly relax',
      config: { crontab: '0 0 3 * * *', timezone: 'Asia/Shanghai' },
      payload: { parameters: { structure: 'cu.cif' } },
      status: 1,
      createTime: 1000,
      updateTime: 2000,
      scheduler: {
        cron: '0 0 3 * * *',
        nextFireAt: 5000,
        lastFiredAt: 4000,
        lastRunId: 'run-9',
        updatedAt: 4001,
      },
    });
    expect(summary).toEqual({
      triggerId: 'trg-1',
      workflowRef: 'workflow:relax@0.1.0',
      name: 'Nightly relax',
      cron: '0 0 3 * * *',
      timezone: 'Asia/Shanghai',
      enabled: true,
      parameters: { structure: 'cu.cif' },
      nextFireAt: 5000,
      lastFiredAt: 4000,
      lastRunId: 'run-9',
      lastError: null,
      createTime: 1000,
      updateTime: 2000,
    });
  });

  it('treats status 0 as paused and tolerates the legacy `cron` config key', () => {
    const summary = normalizeScheduleRecord({
      triggerId: 'trg-2',
      workflowRef: 'workflow:demo@1.0.0',
      name: 'Paused',
      config: { cron: '30 2 * * *' },
      payload: {},
      status: 0,
      createTime: 1,
      updateTime: 2,
    });
    expect(summary?.enabled).toBe(false);
    expect(summary?.cron).toBe('30 2 * * *');
    expect(summary?.timezone).toBeNull();
    expect(summary?.parameters).toEqual({});
    expect(summary?.nextFireAt).toBeNull();
  });

  it('rejects records missing a trigger id or workflow ref', () => {
    expect(normalizeScheduleRecord({ workflowRef: 'workflow:x@1.0.0' })).toBeNull();
    expect(normalizeScheduleRecord({ triggerId: 'trg-3' })).toBeNull();
    expect(normalizeScheduleRecord('nope')).toBeNull();
  });

  it('extracts enabled workflow options, skipping disabled ones and de-duping', () => {
    const options = normalizeWorkflowOptions({
      resources: [
        { ref: 'workflow:b@1.0.0', name: 'Beta', lifecycle: 'enabled' },
        { ref: 'workflow:a@1.0.0', name: 'Alpha', status: 'active' },
        { ref: 'workflow:c@1.0.0', name: 'Retired', lifecycle: 'disabled' },
        { ref: 'workflow:b@1.0.0', name: 'Beta dupe', lifecycle: 'enabled' },
        { name: 'No ref' },
      ],
    });
    expect(options).toEqual([
      { ref: 'workflow:a@1.0.0', name: 'Alpha' },
      { ref: 'workflow:b@1.0.0', name: 'Beta' },
    ]);
  });

  it('degrades to an empty option list for malformed payloads', () => {
    expect(normalizeWorkflowOptions(null)).toEqual([]);
    expect(normalizeWorkflowOptions({ resources: 'nope' })).toEqual([]);
  });
});

describe('matos schedules route cache', () => {
  it('single-flights cold reads and serves stale data during one refresh', async () => {
    let now = 0;
    let generation = 0;
    const firstGate = deferred();
    const refreshGate = deferred();
    const calls: string[] = [];
    const execute = vi.fn(async (args: string[]) => {
      const command = args.slice(0, 3).join(' ');
      calls.push(command);
      if (generation === 0) await firstGate.promise;
      if (generation === 1) await refreshGate.promise;
      if (args.includes('triggers')) {
        return {
          triggers: [{
            triggerId: `trigger-${generation}`,
            workflowRef: 'workflow:demo@1.0.0',
            config: { crontab: '* * * * *' },
            status: 1,
          }],
        };
      }
      return {
        resources: [{
          ref: 'workflow:demo@1.0.0',
          name: `Demo ${generation}`,
          lifecycle: 'enabled',
        }],
      };
    });
    const route = await startScheduleRoute({
      execute,
      now: () => now,
      freshMs: 10,
      staleMs: 100,
    });
    try {
      const first = fetch(`${route.baseUrl}/api/matos/schedules`);
      const concurrent = fetch(`${route.baseUrl}/api/matos/schedules`);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      firstGate.resolve();
      const coldBodies = await Promise.all([first, concurrent].map(async (request) => request.then((r) => r.json())));
      expect(coldBodies[0]).toEqual(coldBodies[1]);
      expect(execute).toHaveBeenCalledTimes(2);

      generation = 1;
      now = 11;
      const staleFirst = await (await fetch(`${route.baseUrl}/api/matos/schedules`)).json() as {
        triggers: Array<{ triggerId: string }>;
      };
      const staleSecond = await (await fetch(`${route.baseUrl}/api/matos/schedules`)).json() as {
        triggers: Array<{ triggerId: string }>;
      };
      expect(staleFirst.triggers[0]?.triggerId).toBe('trigger-0');
      expect(staleSecond.triggers[0]?.triggerId).toBe('trigger-0');
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));

      refreshGate.resolve();
      await vi.waitFor(async () => {
        now = 12;
        const current = await (await fetch(`${route.baseUrl}/api/matos/schedules`)).json() as {
          triggers: Array<{ triggerId: string }>;
        };
        expect(current.triggers[0]?.triggerId).toBe('trigger-1');
      });
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      firstGate.resolve();
      refreshGate.resolve();
      await route.close();
    }
  });
});
