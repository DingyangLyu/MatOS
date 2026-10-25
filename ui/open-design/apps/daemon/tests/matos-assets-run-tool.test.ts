// POST /api/matos/assets/run-tool is a thin proxy over
// `matos assets run-tool <tool-ref> --input-file <tmp> --json`: the input
// document is written to a temp file under the MatOS workspace (never argv —
// decompose payloads carry megabyte base64 mesh soups), forwarded as
// `--input-file`, and cleaned up after the CLI returns. The fake matos bin
// records argv and copies the input file it received, so the test asserts
// the temp-file mechanism round-trips the browser's exact decompose payload
// while the real route/exec transport runs unmodified.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workDir: string;
let argvLog: string;
let inputCapture: string;
let server: http.Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'od-matos-run-tool-'));
  argvLog = path.join(workDir, 'argv.log');
  inputCapture = path.join(workDir, 'input-capture.json');
  const fakeMatos = path.join(workDir, 'fake-matos.sh');
  await writeFile(
    fakeMatos,
    [
      '#!/bin/bash',
      `echo "$@" >> ${JSON.stringify(argvLog)}`,
      'if [[ "$2" == "run-tool" ]]; then',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [[ "$prev" == "--input-file" && -f "$arg" ]]; then',
      `      cp "$arg" ${JSON.stringify(inputCapture)}`,
      '    fi',
      '    prev="$arg"',
      '  done',
      '  if [[ "$3" == "tool:no-such-tool" ]]; then',
      '    echo "run-tool: MatOS tool asset not found or not enabled: tool:no-such-tool" >&2',
      '    exit 1',
      '  fi',
      '  if [[ "$3" == "tool:venv-down" ]]; then',
      // ok:false structured payload rides stdout with exit 1 — the route
      // must forward it as the response body, not turn it into an error.
      '    echo \'{"ok":false,"tool":"tool:venv-down@0.1.0","exitCode":69,"timedOut":false,"result":{"ok":false,"error":"cad-import venv not found"}}\'',
      '    exit 1',
      '  fi',
      `  cat ${JSON.stringify(path.join(workDir, 'run-ok.json'))}`,
      'else',
      '  echo \'{"assets":[]}\'',
      'fi',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);
  await writeFile(
    path.join(workDir, 'run-ok.json'),
    JSON.stringify({
      ok: true,
      tool: 'tool:cad-import@0.1.0',
      mcpName: 'cad_import',
      exitCode: 0,
      timedOut: false,
      result: {
        ok: true,
        action: 'decompose',
        hulls: ['0 0 0  0.1 0 0  0 0.1 0  0 0 0.1', '0.2 0 0  0.3 0 0  0.2 0.1 0'],
        decompositionState: 'decomposed',
        simulated: true,
      },
    }),
    'utf8',
  );

  process.env.MATOS_BIN = fakeMatos;
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  process.env.MATOS_ASSETS_CWD = workDir;
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');

  const app: Express = express();
  app.use(express.json({ limit: '16mb' }));
  registerMatOSAssetRoutes(app);
  baseUrl = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

async function argvLines(): Promise<string[]> {
  try {
    return (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('MatOS asset bridge run-tool', () => {
  it('writes the input to a temp file, forwards the tool ref, and returns the CLI payload', async () => {
    // The browser's exact pending-server backfill shape.
    const input = {
      action: 'decompose',
      positionsB64: Buffer.from(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
      ).toString('base64'),
      maxHulls: 16,
    };
    const resp = await fetch(`${baseUrl}/api/matos/assets/run-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'tool:cad-import', input }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      tool: string;
      result: { hulls: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe('tool:cad-import@0.1.0');
    expect(body.result.hulls).toHaveLength(2);

    const call = (await argvLines()).find((line) => line.includes('run-tool'));
    expect(call).toBeDefined();
    expect(call).toContain('run-tool tool:cad-import');
    expect(call).toContain('--json');

    // The input document never rides argv: it went through a temp file under
    // the workspace, which the CLI saw with the exact JSON content...
    const inputFileArg = /--input-file (\S+)/.exec(call ?? '')?.[1];
    expect(inputFileArg).toBeDefined();
    expect(inputFileArg!.startsWith(path.join(workDir, '.matos', 'tmp') + path.sep)).toBe(true);
    const captured = JSON.parse(await readFile(inputCapture, 'utf8')) as typeof input;
    expect(captured).toEqual(input);
    // ...and which the route removed once the CLI returned.
    await expect(stat(inputFileArg!)).rejects.toThrow();
  });

  it('forwards structured ok:false tool failures as the response body', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/run-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'tool:venv-down', input: { action: 'decompose' } }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      result: { error: string };
    };
    expect(body.ok).toBe(false);
    expect(body.result.error).toContain('venv not found');
  });

  it('surfaces unknown tool refs as client errors with the CLI message', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/run-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'tool:no-such-tool', input: {} }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(String(body.error?.message ?? '')).toContain('not found or not enabled');
  });

  it('rejects malformed refs and non-object input before spawning the CLI', async () => {
    const before = (await argvLines()).length;
    for (const payload of [
      { input: {} },
      { tool: 'cad-import', input: {} },
      { tool: 'skill:not-a-tool', input: {} },
      { tool: 'tool:cad-import' },
      { tool: 'tool:cad-import', input: 'text' },
      { tool: 'tool:cad-import', input: [1, 2] },
    ]) {
      const resp = await fetch(`${baseUrl}/api/matos/assets/run-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(resp.status).toBe(400);
    }
    expect((await argvLines()).length).toBe(before);
  });

  it('caps the input size with 413 before spawning the CLI', async () => {
    const before = (await argvLines()).length;
    const resp = await fetch(`${baseUrl}/api/matos/assets/run-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'tool:cad-import',
        input: { positionsB64: 'x'.repeat(8 * 1024 * 1024 + 64) },
      }),
    });
    expect(resp.status).toBe(413);
    expect((await argvLines()).length).toBe(before);
  });
});
