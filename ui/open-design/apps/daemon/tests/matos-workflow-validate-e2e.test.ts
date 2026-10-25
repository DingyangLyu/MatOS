import { realpathSync } from 'node:fs';
// Real-CLI regression for the Workflow Studio validate bridge.
//
// The reported bug: clicking 校验/运行 on a work-in-progress canvas (e.g. an
// agent node without a role yet) surfaced a raw
// `matos workflow draft replace-definition failed: Invalid workflow draft
// definition: ...` 502 blob instead of the structured invalid strip. The
// native draft store keeps drafts always-valid, so that CLI hard failure is
// the expected shape for incomplete graphs — the bridge must translate it.
//
// Runs the real `bin/matos` CLI against isolated MATOS_ASSETS_CWD /
// MATOS_RUNTIME_DATA_DIR temp roots (no mocks, per repo testing policy).

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_MATOS_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../bin/matos',
);

let workDir: string;
let server: http.Server | null = null;
let baseUrl = '';
const originalEnv = { ...process.env };

beforeAll(async () => {
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'od-matos-wf-validate-')));
  await mkdir(path.join(workDir, 'proj'), { recursive: true });
  await mkdir(path.join(workDir, 'runtime'), { recursive: true });
  for (const id of ['project-a', 'project-b']) {
    await mkdir(path.join(workDir, id, '.matos'), { recursive: true });
    await writeFile(path.join(workDir, id, '.matos/matos.json'), JSON.stringify({ version: 1, includeDefaultAssetRoots: false,
      assetRoots: [path.join(workDir, id, '.matos/assets')], assetSources: [], execution: { runtimeDataDir: path.join(workDir, `${id}-runtime`) },
    }));
  }

  process.env.MATOS_BIN = REPO_MATOS_BIN;
  process.env.MATOS_ASSETS_CWD = path.join(workDir, 'proj');
  process.env.MATOS_RUNTIME_DATA_DIR = path.join(workDir, 'runtime');
  process.env.MATOS_WORKFLOW_RUNS_DIR = path.join(workDir, 'runs');
  process.env.MATOS_RUNTIME_COMPILED = '0';
  process.env.MATOS_GITEA_DISABLE_OPERATOR_ENV = '1';
  delete process.env.MATOS_SCOPE_REF;
  delete process.env.MATOS_SCOPE_ID;
  await mkdir(path.join(workDir, 'proj/.matos'), { recursive: true });
  await writeFile(path.join(workDir, 'proj/.matos/matos.json'), JSON.stringify({
    version: 1, assetRoots: ['assets'], assetSources: [], includeDefaultAssetRoots: false,
  }));

  const { registerMatOSWorkflowRoutes } = await import('../src/routes/matos-workflow.js');
  const app: Express = express();
  app.use(express.json());
  registerMatOSWorkflowRoutes(app, { resolveProjectCwd: id => ['project-a', 'project-b'].includes(id) ? path.join(workDir, id) : undefined });
  baseUrl = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  process.env = originalEnv;
  await rm(workDir, { recursive: true, force: true });
});

async function validate(definition: unknown): Promise<{
  status: number;
  body: {
    validation?: { ok: boolean; errors: Array<{ code: string; message: string }> };
    error?: { message?: string };
  };
}> {
  const resp = await fetch(`${baseUrl}/api/matos/workflow/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definition, label: 'e2e:demo.workflow.json' }),
  });
  return { status: resp.status, body: (await resp.json()) as never };
}

describe.skipIf(!existsSync(REPO_MATOS_BIN))('workflow validate bridge (real CLI)', () => {
  async function post(endpoint: string, input: unknown): Promise<Record<string, any>> {
    const response = await fetch(`${baseUrl}/api/matos/workflow/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const payload = await response.json() as Record<string, any>;
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload;
  }

  it.each([true, false])('runs project canvas commands in the selected runtime despite inherited original cwd (explicit workspace root: %s)', async (explicitRoot) => {
    const previous = process.env.MATOS_ORIGINAL_CWD;
    const previousAssetsCwd = process.env.MATOS_ASSETS_CWD;
    process.env.MATOS_ORIGINAL_CWD = path.join(workDir, 'proj');
    if (!explicitRoot) delete process.env.MATOS_ASSETS_CWD;
    try {
      const definition = { schemaVersion: 1, name: 'project-cwd', policy: { approvalMode: 'bypass' },
        nodes: [{ id: 'location', type: 'exec', command: 'pwd', dependsOn: [] }], outputs: { cwd: { value: '{{ nodes.location.outputs.stdout }}' } },
      };
      const ref = (await post('publish?projectId=project-a', { label: 'location.workflow.json', definition })).published.workflowRef;
      const runId = (await post('run?projectId=project-a', { ref })).run.runId;
      let run: any;
      await expect.poll(async () => {
        const response = await fetch(`${baseUrl}/api/matos/workflow/run/${runId}?projectId=project-a`);
        run = (await response.json() as any).run; return run.status;
      }, { timeout: 60_000, interval: 1000 }).toBe('completed');
      // Exec nodes use the native scope's managed workspace, not the source
      // tree itself. Its root must come from project A's config.
      expect(run.outputs.cwd.trim().startsWith(path.join(workDir, 'project-a-runtime') + path.sep)).toBe(true);
      expect((await fetch(`${baseUrl}/api/matos/workflow/run/${runId}?projectId=project-b`)).ok).toBe(false);
      expect((await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/events?projectId=project-b`)).ok).toBe(false);
      expect((await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/node/location?projectId=project-b`)).ok).toBe(false);
      const foreignControl = await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/control?projectId=project-b`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
      });
      expect(foreignControl.ok).toBe(false);
      const foreignFork = await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/fork?projectId=project-b`, { method: 'POST' });
      expect(foreignFork.ok).toBe(false);
      const fork = await post(`run/${runId}/fork?projectId=project-a`, {});
      expect(Object.keys(fork).sort()).toEqual(['definition', 'draftId']);
      expect(fork.draftId).toBeTruthy();
      expect(fork.definition.nodes[0].command).toBe('pwd');
      expect(fork.definition.outputs).toEqual(definition.outputs);
      const original = await (await fetch(`${baseUrl}/api/matos/workflow/run/${runId}?projectId=project-a`)).json() as any;
      expect(original.run.status).toBe('completed');
      expect(original.run.outputs).toEqual(run.outputs);
      const foreignRuns = await (await fetch(`${baseUrl}/api/matos/workflow/runs?projectId=project-b`)).json() as { runs: Array<{ runId: string }> };
      expect(foreignRuns.runs.some(entry => entry.runId === runId)).toBe(false);
      // The user's whole-workspace view still sees this same native run.
      process.env.MATOS_ASSETS_CWD = previousAssetsCwd;
      expect((await fetch(`${baseUrl}/api/matos/workflow/run/${runId}`)).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MATOS_ORIGINAL_CWD; else process.env.MATOS_ORIGINAL_CWD = previous;
      if (previousAssetsCwd === undefined) delete process.env.MATOS_ASSETS_CWD; else process.env.MATOS_ASSETS_CWD = previousAssetsCwd;
    }
  }, 180_000);

  it('publishes an immutable version, preflights parameters, executes and resumes a human gate through native CLI', async () => {
    const published = await post('publish', { label: 'e2e:interactive.workflow.json', definition: {
      schemaVersion: 1, name: 'interactive', parameters: { sample: { type: 'string', required: true } },
      policy: { approvalMode: 'bypass' },
      nodes: [
        { id: 'prepare', type: 'exec', command: "printf '%s' '{{ parameters.sample }}'", dependsOn: [] },
        { id: 'review', type: 'human', prompt: 'Confirm sample', dependsOn: ['prepare'] },
        { id: 'finish', type: 'exec', command: 'printf done', dependsOn: ['review'] },
      ], outputs: { result: { value: '{{ nodes.finish.outputs.stdout }}' } },
    } });
    expect(published.validation.ok).toBe(true);
    expect(published.published.workflowRef).toMatch(/@0\.1\.0-canvas\./);
    const ref = published.published.workflowRef;
    expect((await post('preflight', { ref, parameters: {} })).preflight.runnable).toBe(false);
    expect((await post('preflight', { ref, parameters: { sample: 'NaCl' } })).preflight.runnable).toBe(true);
    const started = await post('run', { ref, parameters: { sample: 'NaCl' } });
    const runId = started.run.runId;
    expect(runId).toBeTruthy();
    const inspect = async () => (await (await fetch(`${baseUrl}/api/matos/workflow/run/${runId}`)).json() as any).run;
    let run: any;
    await expect.poll(async () => { run = await inspect(); return run.status; }, { timeout: 60_000, interval: 1000 }).toBe('waiting_input');
    expect(run.graph.nodes.map((node: any) => node.id)).toEqual(['prepare', 'review', 'finish']);
    const prepared = await (await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/node/prepare`)).json() as any;
    expect(prepared.node.output.stdout).toBe('NaCl');
    await post(`run/${runId}/control`, { action: 'respond', nodeId: 'review', message: 'approved' });
    await expect.poll(async () => { run = await inspect(); return run.status; }, { timeout: 60_000, interval: 1000 }).toBe('completed');
    expect(run.outputs.result).toBe('done');
    const events = await (await fetch(`${baseUrl}/api/matos/workflow/run/${runId}/events`)).json() as any;
    expect(events.events.some((event: any) => event.type === 'workflow.node.completed')).toBe(true);
  }, 240_000);

  it('rejects wrong asset types and flag-shaped run IDs', async () => {
    for (const ref of ['role:compute', '--help']) {
      const response = await fetch(`${baseUrl}/api/matos/workflow/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
      expect(response.status).toBe(400);
    }
    expect((await fetch(`${baseUrl}/api/matos/workflow/run/--help`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/matos/workflow/run/--help/fork`, { method: 'POST' })).status).toBe(400);
  });

  it('serializes concurrent publications of one document and isolates identical names in different documents', async () => {
    const definition = { schemaVersion: 1, name: 'Same name', parameters: {}, outputs: {}, nodes: [{ id: 'step', type: 'exec', command: 'printf first', dependsOn: [] }] };
    const results = await Promise.all([
      post('publish', { label: 'project:a/workflow.json', definition }),
      post('publish', { label: 'project:a/workflow.json', definition: { ...definition, nodes: [{ ...definition.nodes[0], command: 'printf second' }] } }),
      post('publish', { label: 'project:b/workflow.json', definition }),
    ]);
    const refs = results.map((result) => result.published.workflowRef);
    expect(new Set(refs).size).toBe(3);
    expect(refs[0].split('@')[0]).not.toBe(refs[2].split('@')[0]);
    const { execMatOSJson } = await import('../src/services/matos-cli.js');
    for (const [index, command] of ['printf first', 'printf second', 'printf first'].entries()) {
      const shown = await execMatOSJson(['workflow', 'show', refs[index], '--json']) as { definition: { nodes: Array<{ command: string }> } };
      expect(shown.definition.nodes[0]!.command).toBe(command);
    }
  }, 180_000);
  it('returns a structured invalid verdict for an incomplete canvas graph', async () => {
    const { status, body } = await validate({
      schemaVersion: 1,
      name: 'wip-canvas',
      nodes: [
        { id: 'agent_1', type: 'agent', dependsOn: [] },
        { id: 'compute_1', type: 'compute', dependsOn: ['agent_1'] },
      ],
      parameters: {},
      outputs: {},
    });

    expect(status).toBe(200);
    expect(body.validation?.ok).toBe(false);
    const messages = (body.validation?.errors ?? []).map((entry) => entry.message);
    expect(messages.some((message) => message.includes('Agent node requires role'))).toBe(true);
  }, 90_000);

  it('validates a complete definition through the same draft path', async () => {
    const { status, body } = await validate({
      schemaVersion: 1,
      name: 'ok-canvas',
      version: '0.1.0',
      nodes: [{ id: 'hello', type: 'exec', command: 'echo ok', dependsOn: [] }],
      parameters: {},
      outputs: {},
    });

    expect(status).toBe(200);
    expect(body.validation?.ok).toBe(true);
  }, 90_000);

  it('surfaces missing scoped publication authority instead of returning an unusable ref', async () => {
    const cwd = path.join(workDir, 'missing-source');
    await mkdir(path.join(cwd, '.matos'), { recursive: true });
    await writeFile(path.join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1,
      includeDefaultAssetRoots: false, assetRoots: [path.join(cwd, '.matos/assets')], assetSources: [],
    }));
    const overrides = { MATOS_ASSETS_CWD: cwd, MATOS_SCOPE_REF: 'user:workflow-publish-regression',
      MATOS_WORKFLOW_SCOPED_GITEA_SYNC: '1', MATOS_GITEA_DISABLE_OPERATOR_ENV: '1',
    };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      const response = await fetch(`${baseUrl}/api/matos/workflow/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          label: 'missing-source.workflow.json', definition: { schemaVersion: 1, name: 'missing-source',
            nodes: [{ id: 'step', type: 'exec', command: 'printf ok', dependsOn: [] }],
          },
        }),
      });
      const body = await response.json() as Record<string, any>;
      expect(response.status, JSON.stringify(body)).toBe(502);
      expect(body.error.message).toMatch(/publication failed/i);
      expect(body.error.message).toMatch(/(accepted runtime asset|scoped|asset source)/i);
      expect(body.published).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 180_000);

  it('keeps concurrent valid and invalid definitions isolated on the same canvas', async () => {
    const [invalid, valid] = await Promise.all([
      validate({ schemaVersion: 1, name: 'invalid', nodes: [{ id: 'agent', type: 'agent' }] }),
      validate({ schemaVersion: 1, name: 'valid', nodes: [{ id: 'echo', type: 'exec', command: 'echo ok' }] }),
    ]);
    expect(invalid.status).toBe(200);
    expect(invalid.body.validation?.ok).toBe(false);
    expect(valid.status).toBe(200);
    expect(valid.body.validation?.ok).toBe(true);
  }, 180_000);

  it('does not report success when the scoped asset cannot be published', async () => {
    const before = { ...process.env };
    Object.assign(process.env, {
      MATOS_SCOPE_REF: 'user:unprovisioned-test', MATOS_GITEA_BASE_URL: 'http://127.0.0.1:9',
      MATOS_GITEA_TOKEN: '', MATOS_GATEWAY_GITEA_TOKEN: '', MATOS_GITEA_TOKEN_FILE: '',
      MATOS_GATEWAY_GITEA_TOKEN_FILE: '', MATOS_WORKFLOW_SCOPED_GITEA_SYNC: '1',
    });
    try {
      const response = await fetch(`${baseUrl}/api/matos/workflow/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'publish-failure', definition: {
          schemaVersion: 1, name: 'publish-failure', nodes: [{ id: 'echo', type: 'exec', command: 'echo ok' }],
        } }),
      });
      const body = await response.json() as { published?: unknown; error?: { message: string } };
      expect(response.status).toBe(502);
      expect(body.published).toBeUndefined();
      expect(body.error?.message).toMatch(/publication failed/i);
    } finally { process.env = before; }
  }, 180_000);

  it('concurrent publication either preserves the requested definition or reports a revision conflict', async () => {
    const responses = await Promise.all(['first', 'second'].map(async (id) => {
      const response = await fetch(`${baseUrl}/api/matos/workflow/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'same-publish-canvas', id: `published-${id}`, definition: {
          schemaVersion: 1, name: id, nodes: [{ id, type: 'exec', command: `echo ${id}` }],
        } }),
      });
      const body = await response.json() as { published?: { assetKey: string }; error?: { code: string } };
      expect([200, 409]).toContain(response.status);
      if (response.status === 409) {
        expect(body.error?.code).toBe('WORKFLOW_DRAFT_CONFLICT');
      } else {
        const ref = body.published!.assetKey;
        expect(ref).toMatch(new RegExp(`^workflow:published-${id}-[a-f0-9]{12}-[a-f0-9]{16}@0\\.1\\.0-canvas\\.[a-f0-9]{16}$`));
        const { execMatOSJson } = await import('../src/services/matos-cli.js');
        const definition = (await execMatOSJson(['workflow', 'show', ref, '--json'])) as { definition: { nodes: Array<{ id: string; command: string }> } };
        expect(definition.definition.nodes[0]!.id).toBe(id);
        expect(definition.definition.nodes[0]!.command).toBe(`echo ${id}`);
      }
      return response.status;
    }));
    expect(responses).toContain(200);
  }, 180_000);

  it('reads only the requested tail of a log larger than the CLI output buffer', async () => {
    const dir = path.join(workDir, 'runs/large-log');
    await mkdir(dir, { recursive: true });
    const event = JSON.stringify({ type: 'workflow.node.completed', data: { stdout: 'x'.repeat(4096) } }) + '\n';
    await writeFile(path.join(dir, 'events.jsonl'), event.repeat(Math.ceil(65 * 1024 ** 2 / event.length)) +
      JSON.stringify({ id: 'last', type: 'workflow.run.completed', data: {} }) + '\n');
    // Concurrent requests must not reuse another tail length's cached result.
    const responses = await Promise.all([1, 2].map(tail =>
      fetch(`${baseUrl}/api/matos/workflow/run/large-log/events?tail=${tail}`)));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [one, two] = await Promise.all(responses.map(response => response.json())) as Array<{ events: Array<{ id?: string }> }>;
    expect(one).toMatchObject({ events: [{ id: 'last' }] });
    expect(two!.events).toHaveLength(2);
    expect(two!.events[1]!.id).toBe('last');
    for (const tail of ['0', '1001', 'NaN', '1.5', 'invalid']) {
      expect((await fetch(`${baseUrl}/api/matos/workflow/run/large-log/events?tail=${tail}`)).status).toBe(400);
    }
  }, 90_000);
});
