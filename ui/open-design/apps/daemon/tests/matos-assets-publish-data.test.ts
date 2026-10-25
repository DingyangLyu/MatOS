import { realpathSync } from 'node:fs';
// POST /api/matos/assets/publish-data is a thin proxy over
// `matos assets publish-data --json`: the document body is written to a temp
// entry file under the MatOS workspace (never argv), forwarded as
// `--entry-file`, and cleaned up after the CLI returns. The fake matos bin
// records argv and copies the entry file it received, so the test can assert
// the temp-file mechanism round-trips the document while the real
// route/exec transport runs unmodified.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workDir: string;
let argvLog: string;
let entryCapture: string;
let server: http.Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'od-matos-publish-data-')));
  argvLog = path.join(workDir, 'argv.log');
  entryCapture = path.join(workDir, 'entry-capture.json');
  const fakeMatos = path.join(workDir, 'fake-matos.sh');
  await writeFile(
    fakeMatos,
    [
      '#!/bin/bash',
      `echo "$@" >> ${JSON.stringify(argvLog)}`,
      'if [[ "$2" == "publish-data" ]]; then',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [[ "$prev" == "--entry-file" && -f "$arg" ]]; then',
      `      cp "$arg" ${JSON.stringify(entryCapture)}`,
      '    fi',
      '    if [[ "$arg" == "dup-id" ]]; then',
      '      echo "publish-data: data:dup-id@0.1.0 already exists" >&2',
      '      exit 1',
      '    fi',
      '    prev="$arg"',
      '  done',
      `  cat ${JSON.stringify(path.join(workDir, 'publish-ok.json'))}`,
      'else',
      '  echo \'{"assets":[]}\'',
      'fi',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);
  await writeFile(
    path.join(workDir, 'publish-ok.json'),
    JSON.stringify({
      ok: true,
      ref: 'data:vlab-scene-her-demo@0.1.0',
      id: 'vlab-scene-her-demo',
      packId: 'virtual-lab-scenes',
      version: '0.1.0',
      entryName: 'scene.json',
      entryBytes: 128,
      manifestPath:
        '.matos/assets/packs/virtual-lab-scenes/data/vlab-scene-her-demo/asset.json',
      entryPath:
        '.matos/assets/packs/virtual-lab-scenes/data/vlab-scene-her-demo/scene.json',
      overwritten: false,
      validation: { ok: true, errorCount: 0 },
    }),
    'utf8',
  );

  process.env.MATOS_BIN = fakeMatos;
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  // The temp entry file lands below the MatOS workspace; keep tests inside
  // the temp dir.
  process.env.MATOS_ASSETS_CWD = workDir;
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');

  const app: Express = express();
  // Mirror the server's global JSON body limit (4mb) so the route's own
  // 2 MiB document cap — not the body parser — produces the 413 under test.
  app.use(express.json({ limit: '4mb' }));
  await mkdir(path.join(workDir, 'own-project'));
  registerMatOSAssetRoutes(app, { resolveProjectCwd: id => id === 'own' ? path.join(workDir, 'own-project') : undefined });
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

describe('MatOS asset bridge publish-data', () => {
  it('publishes inside the selected project and rejects a foreign project', async () => {
    const body = JSON.stringify({id:'project-experiment',name:'Experiment',document:{kind:'matos-lab-experiment',version:1}});
    const response = await fetch(`${baseUrl}/api/matos/assets/publish-data?projectId=own`, {method:'POST',headers:{'Content-Type':'application/json'},body});
    expect(response.status).toBe(200);
    expect((await argvLines()).at(-1)).toContain(path.join(workDir, 'own-project', '.matos', 'tmp'));
    const count = (await argvLines()).length;
    expect((await fetch(`${baseUrl}/api/matos/assets/publish-data?projectId=foreign`, {method:'POST',headers:{'Content-Type':'application/json'},body})).status).toBe(400);
    expect((await argvLines()).length).toBe(count);
  });
  it('writes the document to a temp entry file, forwards flags, and cleans up', async () => {
    const document = {
      schemaVersion: 1,
      name: 'HER benchtop demo',
      devices: [{ ref: 'data:vlab-tube-rack', position: [0, 0.4, 0] }],
    };
    const resp = await fetch(`${baseUrl}/api/matos/assets/publish-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'vlab-scene-her-demo',
        name: 'Virtual Lab Scene: HER benchtop demo',
        pack: 'virtual-lab-scenes',
        entryName: 'scene.json',
        tags: ['virtual-lab-scene', 'virtual-lab'],
        description: 'Saved from the lab sandbox.',
        document,
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; ref: string };
    expect(body.ok).toBe(true);
    expect(body.ref).toBe('data:vlab-scene-her-demo@0.1.0');

    const call = (await argvLines()).find((line) => line.includes('publish-data --id vlab-scene-her-demo'));
    expect(call).toBeDefined();
    expect(call).toContain('--id vlab-scene-her-demo');
    expect(call).toContain('--entry-name scene.json');
    expect(call).toContain('--pack virtual-lab-scenes');
    expect(call).toContain('--tag virtual-lab-scene');
    expect(call).toContain('--tag virtual-lab');
    expect(call).toContain('--description Saved from the lab sandbox.');
    expect(call).toContain('--json');
    expect(call).not.toContain('--overwrite');

    // The document body never rides argv: it went through a temp entry file
    // under the workspace, which the CLI saw with the full JSON content...
    const entryFileArg = /--entry-file (\S+)/.exec(call ?? '')?.[1];
    expect(entryFileArg).toBeDefined();
    expect(entryFileArg!.startsWith(path.join(workDir, '.matos', 'tmp') + path.sep)).toBe(true);
    const captured = JSON.parse(await readFile(entryCapture, 'utf8')) as typeof document;
    expect(captured).toEqual(document);
    // ...and which the route removed once the CLI returned.
    await expect(stat(entryFileArg!)).rejects.toThrow();
  });

  it('passes string documents through unchanged and forwards overwrite/version', async () => {
    const raw = '{"custom": "string document"}';
    const resp = await fetch(`${baseUrl}/api/matos/assets/publish-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'vlab-scene-her-demo',
        name: 'Scene v2',
        entryName: 'scene.json',
        version: '0.2.0',
        overwrite: true,
        document: raw,
      }),
    });
    expect(resp.status).toBe(200);
    expect(await readFile(entryCapture, 'utf8')).toBe(raw);
    const call = (await argvLines())
      .reverse()
      .find((line) => line.includes('publish-data'));
    expect(call).toContain('--version 0.2.0');
    expect(call).toContain('--overwrite');
  });

  it('rejects missing id/name/document before spawning the CLI', async () => {
    const before = (await argvLines()).length;
    for (const payload of [
      { name: 'No id', document: { a: 1 } },
      { id: 'no-name', document: { a: 1 } },
      { id: 'no-doc', name: 'No document' },
      { id: 'empty-doc', name: 'Empty document', document: '   ' },
    ]) {
      const resp = await fetch(`${baseUrl}/api/matos/assets/publish-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(resp.status).toBe(400);
    }
    expect((await argvLines()).length).toBe(before);
  });

  it('caps the document size with 413 before spawning the CLI', async () => {
    const before = (await argvLines()).length;
    const resp = await fetch(`${baseUrl}/api/matos/assets/publish-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'huge-doc',
        name: 'Huge doc',
        document: 'x'.repeat(2 * 1024 * 1024 + 1),
      }),
    });
    expect(resp.status).toBe(413);
    expect((await argvLines()).length).toBe(before);
  });

  it('surfaces CLI failures such as duplicate ids as client errors', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/publish-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'dup-id', name: 'Dup', document: { a: 1 } }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(String(body.error?.message ?? '')).toContain('already exists');
  });
});
