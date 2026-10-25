import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execMatOSJson, execMatOSJsonReport } from '../../src/services/matos-cli.js';
import { registerMatOSWorkflowRoutes } from '../../src/routes/matos-workflow.js';

vi.mock('../../src/services/matos-cli.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/matos-cli.js')>(),
  execMatOSJson: vi.fn(async (_args: string[], options?: { cwd?: string }) => ({
    runId: 'run-shared', status: 'completed', outputs: { project: options?.cwd }, validation: { ok: true },
  })),
  execMatOSJsonReport: vi.fn(async () => ({ run: { runId: 'run-shared', status: 'completed' } })),
}));
let directory: string, base: string, server: Server;
beforeAll(async () => {
  directory = realpathSync(await mkdtemp(join(tmpdir(), 'workflow-scope-')));
  await mkdir(join(directory, 'a')); await mkdir(join(directory, 'b'));
  const app = express(); app.use(express.json());
  registerMatOSWorkflowRoutes(app, { resolveProjectCwd: id => ['a', 'b'].includes(id) ? join(directory, id) : undefined });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/matos/workflow`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

it('rejects unknown and invalid projects without falling back to workspace cwd', async () => {
  vi.mocked(execMatOSJson).mockClear();
  for (const query of ['projectId=foreign', 'projectId=..%2Fsecret', 'projectId=a&projectId=b']) {
    expect((await fetch(`${base}/run/run-shared?${query}`)).ok).toBe(false);
  }
  expect(execMatOSJson).not.toHaveBeenCalled();
});
it('partitions poll cache by project even for identical run IDs', async () => {
  vi.mocked(execMatOSJson).mockClear();
  for (const projectId of ['a', 'b', 'a', 'b']) {
    const response = await fetch(`${base}/run/run-shared?projectId=${projectId}`);
    expect(response.ok).toBe(true);
  }
  expect(vi.mocked(execMatOSJson).mock.calls.map(call => call[1]?.cwd)).toEqual([join(directory, 'a'), join(directory, 'b')]);
});
it('binds run and control commands to the selected project', async () => {
  vi.mocked(execMatOSJson).mockClear();
  vi.mocked(execMatOSJsonReport).mockClear();
  for (const [endpoint, body] of [['run', { ref: 'workflow:example' }], ['run/run-shared/control', { action: 'cancel' }]] as const) {
    const response = await fetch(`${base}/${endpoint}?projectId=b`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  }
  expect(execMatOSJson).toHaveBeenCalledTimes(2);
  expect(execMatOSJsonReport).toHaveBeenCalledWith(['workflow', 'cancel', 'run-shared', '--json'], { cwd: join(directory, 'b') });
  expect(vi.mocked(execMatOSJson).mock.calls.every(call => call[1]?.cwd === join(directory, 'b'))).toBe(true);
});
it('returns the inspected failure after a control command produced a non-success run report', async () => {
  vi.mocked(execMatOSJsonReport).mockResolvedValueOnce({ run: { runId: 'run-shared', status: 'failed' } });
  vi.mocked(execMatOSJson).mockResolvedValueOnce({ runId: 'run-shared', status: 'failed',
    nodes: { load: { status: 'failed', error: 'Instrument job failed' } } });
  const response = await fetch(`${base}/run/run-shared/control?projectId=a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'retry-node', nodeId: 'load' }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { run: { status: string } };
  expect(body.run.status).toBe('failed');
});
it('binds every draft mutation to the selected project', async () => {
  vi.mocked(execMatOSJson).mockClear();
  const response = await fetch(`${base}/validate?projectId=a`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      label: 'same.workflow.json', definition: { schemaVersion: 1, name: 'example', nodes: [] },
    }),
  });
  expect(response.ok).toBe(true);
  expect(execMatOSJson).toHaveBeenCalledTimes(2);
  expect(vi.mocked(execMatOSJson).mock.calls.every(call => call[1]?.cwd === join(directory, 'a'))).toBe(true);
});
