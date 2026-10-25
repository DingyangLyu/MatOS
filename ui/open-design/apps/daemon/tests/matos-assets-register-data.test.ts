// POST /api/matos/assets/register-data is a thin proxy over
// `matos assets register-data --json`: it forwards provenance fields as CLI
// flags, invalidates the listing cache, and surfaces CLI validation failures
// as client errors instead of 502s. The fake matos bin records argv and
// replays canned JSON so the real route/exec transport runs unmodified.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workDir: string;
let argvLog: string;
let server: http.Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'od-matos-register-data-'));
  argvLog = path.join(workDir, 'argv.log');
  const fakeMatos = path.join(workDir, 'fake-matos.sh');
  await writeFile(
    fakeMatos,
    [
      '#!/bin/bash',
      `echo "$@" >> ${JSON.stringify(argvLog)}`,
      'if [[ "$2" == "register-data" ]]; then',
      '  for arg in "$@"; do',
      '    if [[ "$arg" == "dup-id" ]]; then',
      '      echo "register-data: data:dup-id@1.0.0 already exists" >&2',
      '      exit 1',
      '    fi',
      '  done',
      `  cat ${JSON.stringify(path.join(workDir, 'register-ok.json'))}`,
      'elif [[ "$3" == "intake-draft" ]]; then',
      `  cat ${JSON.stringify(path.join(workDir, 'intake-preview.json'))}`,
      'elif [[ "$2" == "intake-adopt" ]]; then',
      '  echo \'{"ok":true,"packId":"toy-mlip-tool","scopeRef":"user:local","adoptedRefs":["tool:toy-mlip-tool@0.1.0"]}\'',
      'elif [[ "$3" == "intake-draft-apply" ]]; then',
      `  cat ${JSON.stringify(path.join(workDir, 'intake-apply.json'))}`,
      'else',
      '  echo \'{"assets":[]}\'',
      'fi',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);
  await writeFile(
    path.join(workDir, 'intake-preview.json'),
    JSON.stringify({
      mode: 'external-intake-draft-pack-preview',
      validation: { ok: true, issues: [] },
      plan: {
        targetPack: { packId: 'toy-mlip-tool' },
        proposedAssets: [
          { type: 'tool', id: 'toy-mlip-tool', ref: 'tool:toy-mlip-tool@0.1.0', primary: true, confidence: 'high' },
        ],
      },
      transaction: { confirmationFingerprint: 'f'.repeat(64) },
    }),
    'utf8',
  );
  await writeFile(
    path.join(workDir, 'intake-apply.json'),
    JSON.stringify({ applied: true, plan: { targetPack: { packId: 'toy-mlip-tool' } } }),
    'utf8',
  );
  await writeFile(
    path.join(workDir, 'register-ok.json'),
    JSON.stringify({
      ok: true,
      ref: 'data:her-pt-cations@1.0.0',
      id: 'her-pt-cations',
      packId: 'registered-data',
      payloadStatus: 'verified',
      doi: '10.5281/zenodo.7026971',
      validation: { ok: true, errorCount: 0 },
    }),
    'utf8',
  );

  process.env.MATOS_BIN = fakeMatos;
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  // Uploads land below the MatOS workspace; keep tests inside the temp dir.
  process.env.MATOS_ASSETS_CWD = workDir;
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
  await rm(workDir, { recursive: true, force: true });
});

async function argvLines(): Promise<string[]> {
  try {
    return (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('MatOS asset bridge register-data', () => {
  it('forwards provenance fields to the CLI and returns its JSON result', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/register-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'her-pt-cations',
        name: 'Alkaline HER Pt cations MD',
        doi: '10.5281/zenodo.7026971',
        urls: ['https://zenodo.org/records/7026971'],
        path: '/workspace/knowledge/material-bench-datasets/her',
        domain: 'Catalysis',
        tags: ['materials', 'catalysis'],
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; ref: string; payloadStatus: string };
    expect(body.ok).toBe(true);
    expect(body.ref).toBe('data:her-pt-cations@1.0.0');
    expect(body.payloadStatus).toBe('verified');

    const call = (await argvLines()).find((line) => line.includes('register-data'));
    expect(call).toBeDefined();
    expect(call).toContain('--id her-pt-cations');
    expect(call).toContain('--doi 10.5281/zenodo.7026971');
    expect(call).toContain('--url https://zenodo.org/records/7026971');
    expect(call).toContain('--path /workspace/knowledge/material-bench-datasets/her');
    expect(call).toContain('--tag materials');
    expect(call).toContain('--tag catalysis');
    expect(call).toContain('--json');
  });

  it('rejects missing id/name before spawning the CLI', async () => {
    const before = (await argvLines()).length;
    const resp = await fetch(`${baseUrl}/api/matos/assets/register-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No id' }),
    });
    expect(resp.status).toBe(400);
    expect((await argvLines()).length).toBe(before);
  });

  it('surfaces CLI failures such as duplicate ids as client errors', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/register-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'dup-id', name: 'Dup', urls: ['https://example.org/x'] }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(String(body.error?.message ?? '')).toContain('already exists');
  });
});

describe('MatOS asset bridge universal import', () => {
  it('previews any intake source through the draft-pack CLI', async () => {
    const resp = await fetch(`${baseUrl}/api/matos/assets/import-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'https://github.com/org/toy-mlip-tool',
        executable: true,
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      plan: { proposedAssets: Array<{ ref: string }> };
      transaction: { confirmationFingerprint: string };
    };
    expect(body.plan.proposedAssets[0]?.ref).toBe('tool:toy-mlip-tool@0.1.0');
    expect(body.transaction.confirmationFingerprint).toBe('f'.repeat(64));
    const call = (await argvLines()).find((line) => line.includes('intake-draft https://github.com/org/toy-mlip-tool'));
    expect(call).toBeDefined();
    expect(call).toContain('--executable');
    expect(call).toContain('--json');
  });

  it('applies with the confirmation fingerprint and requires it', async () => {
    const missing = await fetch(`${baseUrl}/api/matos/assets/import-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'x.zip' }),
    });
    expect(missing.status).toBe(400);

    const resp = await fetch(`${baseUrl}/api/matos/assets/import-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'x.zip', fingerprint: 'f'.repeat(64) }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { applied: boolean };
    expect(body.applied).toBe(true);
    const call = (await argvLines()).find((line) => line.includes('intake-draft-apply x.zip'));
    expect(call).toContain(`--fingerprint ${'f'.repeat(64)}`);
  });

  it('adds a confirmed import to the scoped assets unless told to keep drafts', async () => {
    process.env.MATOS_SCOPE_REF = 'user:local';
    try {
      const resp = await fetch(`${baseUrl}/api/matos/assets/import-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'y.zip', fingerprint: 'f'.repeat(64) }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { adoption: { ok: boolean; adoptedRefs: string[] } };
      expect(body.adoption).toEqual({ ok: true, adoptedRefs: ['tool:toy-mlip-tool@0.1.0'] });
      expect((await argvLines()).includes('assets intake-adopt toy-mlip-tool --json')).toBe(true);

      const adoptCalls = async () =>
        (await argvLines()).filter((line) => line.includes('intake-adopt')).length;
      const before = await adoptCalls();
      const kept = await fetch(`${baseUrl}/api/matos/assets/import-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'y.zip', fingerprint: 'f'.repeat(64), adopt: false }),
      });
      expect(((await kept.json()) as { adoption: unknown }).adoption).toBeNull();
      expect(await adoptCalls()).toBe(before);
    } finally {
      delete process.env.MATOS_SCOPE_REF;
    }
  });

  it('uploads archives into the MatOS intake uploads directory', async () => {
    const payload = new FormData();
    payload.set('file', new File([new Uint8Array([80, 75, 3, 4])], 'my data.zip'));
    const resp = await fetch(`${baseUrl}/api/matos/assets/import-upload`, {
      method: 'POST',
      body: payload,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; path: string; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.path).toContain('/.matos/intake/uploads/');
    // Each upload gets its own directory, so the file keeps its name.
    expect(path.basename(body.path)).toBe('my-data.zip');
    expect(body.bytes).toBe(4);
  });

  it('uploads a directory atomically while preserving relative paths', async () => {
    const payload = new FormData();
    payload.set('relativePaths', JSON.stringify([
      'powder-db/schema.csv',
      'powder-db/nested/rows.jsonl',
    ]));
    payload.append('files', new File(['id,value\n1,2\n'], 'schema.csv'));
    payload.append('files', new File(['{"id":1}\n'], 'rows.jsonl'));

    const resp = await fetch(`${baseUrl}/api/matos/assets/import-upload-folder`, {
      method: 'POST',
      body: payload,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; path: string; files: number; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.files).toBe(2);
    expect(body.bytes).toBe(22);
    // The source is the dropped folder itself, so intake names assets after it.
    expect(path.basename(body.path)).toBe('powder-db');
    await expect(readFile(path.join(body.path, 'schema.csv'), 'utf8'))
      .resolves.toBe('id,value\n1,2\n');
    await expect(readFile(path.join(body.path, 'nested/rows.jsonl'), 'utf8'))
      .resolves.toBe('{"id":1}\n');
  });

  it('removes an incomplete directory upload instead of exposing a partial source', async () => {
    const uploadsDir = path.join(workDir, '.matos', 'intake', 'uploads');
    const before = (await readdir(uploadsDir)).filter((name) => name.startsWith('folder-')).sort();
    const payload = new FormData();
    payload.set('relativePaths', JSON.stringify(['dataset/first.csv', 'dataset/missing.csv']));
    payload.append('files', new File(['first'], 'first.csv'));

    const resp = await fetch(`${baseUrl}/api/matos/assets/import-upload-folder`, {
      method: 'POST',
      body: payload,
    });
    expect(resp.status).toBe(400);
    const after = (await readdir(uploadsDir)).filter((name) => name.startsWith('folder-')).sort();
    expect(after).toEqual(before);
  });

  it('rejects unsafe directory upload paths', async () => {
    const payload = new FormData();
    payload.set('relativePaths', JSON.stringify(['dataset/../escape.txt']));
    payload.append('files', new File(['nope'], 'escape.txt'));
    const resp = await fetch(`${baseUrl}/api/matos/assets/import-upload-folder`, {
      method: 'POST',
      body: payload,
    });
    expect(resp.status).toBe(400);
  });
});
