// Workflow card previews: the bridge turns the cached compact listing into
// batch DAG skeletons by reading each workflow's definition file directly
// (no per-asset CLI spawn). Assets with unreadable/redacted paths or YAML
// entries silently drop out — tiles fall back to icon + text.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workDir: string;
let server: http.Server | null = null;
let baseUrl = '';

const DEFINITION = {
  schemaVersion: 1,
  name: 'halide-screen',
  nodes: [
    { id: 'plan', type: 'agent', dependsOn: [], label: 'Plan screen' },
    { id: 'relax', type: 'compute', dependsOn: ['plan'] },
    { id: 'gate', type: 'guard', dependsOn: ['relax'] },
    { id: 'report', type: 'agent', dependsOn: ['gate'] },
  ],
  edges: [{ from: 'plan', to: 'report', condition: 'skip' }],
};

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'od-matos-wf-previews-'));

  const wfDir = path.join(workDir, 'assets', 'workflows', 'halide-screen');
  await mkdir(wfDir, { recursive: true });
  await writeFile(path.join(wfDir, 'workflow.json'), JSON.stringify(DEFINITION), 'utf8');

  // A YAML-entry workflow (the shape most released assets ship) so the
  // bridge's YAML parse path is exercised end-to-end.
  const yamlDir = path.join(workDir, 'assets', 'workflows', 'yaml-flow');
  await mkdir(yamlDir, { recursive: true });
  await writeFile(
    path.join(yamlDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: yaml-flow',
      'nodes:',
      '  plan:',
      '    type: agent',
      '    dependsOn: []',
      '  run:',
      '    type: exec',
      '    dependsOn: [plan]',
      '',
    ].join('\n'),
    'utf8',
  );

  const brokenDir = path.join(workDir, 'assets', 'workflows', 'broken');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'workflow.json'), '{not json', 'utf8');

  const listing = {
    assets: [
      {
        id: 'halide-screen',
        type: 'workflow',
        name: 'Halide screen',
        entry: 'workflow.json',
        // The CLI redacts the cwd prefix as `<workspace>`; the bridge must
        // expand it back before reading the definition.
        absolutePath: '<workspace>/assets/workflows/halide-screen',
        lifecycle: { status: 'enabled' },
        metadata: {},
      },
      {
        id: 'broken',
        type: 'workflow',
        name: 'Broken definition',
        entry: 'workflow.json',
        absolutePath: '<workspace>/assets/workflows/broken',
        lifecycle: { status: 'enabled' },
        metadata: {},
      },
      {
        id: 'redacted',
        type: 'workflow',
        name: 'Internal workflow',
        entry: 'workflow.json',
        absolutePath: '<internal>',
        lifecycle: { status: 'enabled' },
        metadata: {},
      },
      {
        id: 'yaml-flow',
        type: 'workflow',
        name: 'YAML workflow',
        entry: 'workflow.yaml',
        absolutePath: '<workspace>/assets/workflows/yaml-flow',
        lifecycle: { status: 'enabled' },
        metadata: {},
      },
      {
        id: 'not-a-workflow',
        type: 'skill',
        name: 'Skill row',
        entry: 'SKILL.md',
        absolutePath: '<workspace>/assets/skills/x',
        lifecycle: { status: 'enabled' },
        metadata: {},
      },
      ...Array.from({ length: 125 }, (_, index) => ({
        id: `catalog-${index}`, type: 'workflow', name: `Catalog ${index}`,
        version: '1.2.3', entry: 'workflow.json',
        absolutePath: '<workspace>/assets/workflows/halide-screen',
        lifecycle: { status: 'enabled' }, metadata: {},
      })),
    ],
  };
  const fakeMatos = path.join(workDir, 'fake-matos.sh');
  await writeFile(
    fakeMatos,
    ['#!/bin/bash', `cat ${JSON.stringify(path.join(workDir, 'assets.json'))}`, ''].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);
  await writeFile(path.join(workDir, 'assets.json'), JSON.stringify(listing), 'utf8');

  process.env.MATOS_BIN = fakeMatos;
  process.env.MATOS_ASSETS_CWD = workDir;
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');

  const app: Express = express();
  app.use(express.json());
  registerMatOSAssetRoutes(app);
  baseUrl = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  delete process.env.MATOS_ASSETS_CWD;
  await rm(workDir, { recursive: true, force: true });
});

describe('MatOS workflow previews bridge', () => {
  it('returns DAG skeletons for readable workflow definitions only', async () => {
    const res = await fetch(`${baseUrl}/api/matos/workflow-previews`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      previews: Array<{
        ref: string;
        nodeCount: number;
        edgeCount: number;
        nodes: Array<{ id: string; type: string; label: string }>;
        edges: Array<{ from: string; to: string }>;
      }>;
    };
    // broken (parse error), redacted (<internal>), and the skill row all drop
    // out; the JSON and YAML definitions both resolve.
    const byRef = new Map(body.previews.map((p) => [p.ref, p]));
    expect([...byRef.keys()].filter(ref => !ref.startsWith('workflow:catalog-')).sort()).toEqual([
      'workflow:halide-screen',
      'workflow:yaml-flow',
    ]);
    // The YAML entry parses through the same skeleton reducer.
    const yaml = byRef.get('workflow:yaml-flow')!;
    expect(yaml.nodes.map((n) => n.id)).toEqual(['plan', 'run']);
    expect(yaml.edges).toEqual([{ from: 'plan', to: 'run' }]);

    const preview = byRef.get('workflow:halide-screen')!;
    expect(preview.nodeCount).toBe(4);
    expect(preview.nodes.map((n) => n.type)).toEqual(['agent', 'compute', 'guard', 'agent']);
    // label falls back to the node id when absent.
    expect(preview.nodes[0]).toEqual({ id: 'plan', type: 'agent', label: 'Plan screen' });
    expect(preview.nodes[1]!.label).toBe('relax');
    // Explicit edges merge with dependsOn-derived ones, deduped.
    expect(preview.edges).toEqual([
      { from: 'plan', to: 'report' },
      { from: 'plan', to: 'relax' },
      { from: 'relax', to: 'gate' },
      { from: 'gate', to: 'report' },
    ]);
    expect(preview.edgeCount).toBe(4);
  });

  it('includes the end of large catalogs and pins preview versions without dropping legacy refs', async () => {
    const response = await fetch(`${baseUrl}/api/matos/workflow-previews`);
    const body = await response.json() as { previews: Array<{ ref: string; canonicalKey: string }> };
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.previews).toHaveLength(127);
    expect(body.previews.find(row => row.ref === 'workflow:catalog-124')?.canonicalKey).toBe('workflow:catalog-124@1.2.3');
    expect(new Set(body.previews.map(row => row.ref)).size).toBe(127);
  });
});

describe('workflowPreviewFromDocument', () => {
  it('caps nodes, keeps full counts, and drops edges outside the kept set', async () => {
    const { workflowPreviewFromDocument } = await import('../src/routes/matos-assets.js');
    const nodes = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      type: 'exec',
      dependsOn: i > 0 ? [`n${i - 1}`] : [],
    }));
    const preview = workflowPreviewFromDocument('workflow:big', { nodes })!;
    expect(preview.nodeCount).toBe(30);
    expect(preview.nodes).toHaveLength(24);
    expect(preview.edgeCount).toBe(29);
    // Edges touching dropped nodes (n24…n29) are filtered from the payload.
    expect(preview.edges).toHaveLength(23);
  });

  it('normalizes map-form nodes and rejects nodeless documents', async () => {
    const { workflowPreviewFromDocument } = await import('../src/routes/matos-assets.js');
    const preview = workflowPreviewFromDocument('workflow:map', {
      nodes: { plan: { type: 'agent' }, run: { type: 'exec', dependsOn: ['plan'] } },
    })!;
    expect(preview.nodes.map((n) => n.id)).toEqual(['plan', 'run']);
    expect(preview.edges).toEqual([{ from: 'plan', to: 'run' }]);
    expect(workflowPreviewFromDocument('workflow:none', { nodes: [] })).toBeNull();
    expect(workflowPreviewFromDocument('workflow:bad', 'nope')).toBeNull();
  });
});
