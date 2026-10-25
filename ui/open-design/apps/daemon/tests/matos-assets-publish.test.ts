// Asset editor publish regression: an owned accepted-ref checkout is the
// source of both the detail view and the editable file. A second `assets show`
// between PUT and commit materializes accepted truth again and discards the
// dirty edit. This test makes `assets show` deliberately reset the fixture so
// the real route proves it reuses the server-authorized mutation lease and
// accepts the immutable commit returned by commit-source.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REF = 'knowledge:shared-copy';
const SOURCE_ID = 'matos-user-assets-alice';
const CANDIDATE_COMMIT = 'a'.repeat(40);
const MARKER = 'alice-independent-evolution';

let workDir: string;
let assetDir: string;
let entryFile: string;
let argvLog: string;
let validationGate: string;
let server: http.Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'od-matos-assets-publish-'));
  assetDir = path.join(
    workDir,
    '.matos',
    'source-cache',
    'scopes',
    'users',
    'alice',
    'git',
    SOURCE_ID,
    'knowledge',
    'shared-copy',
  );
  entryFile = path.join(assetDir, 'KNOWLEDGE.md');
  argvLog = path.join(workDir, 'argv.log');
  validationGate = path.join(workDir, 'validation.block');
  const originalFile = path.join(workDir, 'original.md');
  const showPayload = path.join(workDir, 'show.json');
  const fakeMatos = path.join(workDir, 'fake-matos.sh');

  await mkdir(assetDir, { recursive: true });
  await writeFile(originalFile, '# Shared copy\n\nOriginal.\n', 'utf8');
  await writeFile(entryFile, await readFile(originalFile), 'utf8');
  await writeFile(
    path.join(assetDir, 'asset.json'),
    `${JSON.stringify({
      id: 'shared-copy',
      type: 'knowledge',
      name: 'Shared copy',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    showPayload,
    JSON.stringify({
      asset: {
        id: 'shared-copy',
        type: 'knowledge',
        name: 'Shared copy',
        version: '1.0.0',
        entry: 'KNOWLEDGE.md',
        absolutePath: assetDir,
        metadata: {
          sourceProvenance: {
            sourceId: SOURCE_ID,
            scope: 'user',
            scopeRef: 'user:alice',
          },
        },
      },
    }),
    'utf8',
  );
  await writeFile(
    fakeMatos,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
      'case "$*" in',
      '  "assets show "*)',
      // Simulate accepted-ref materialization. A repeated show after the PUT
      // is destructive by design and reproduces the production failure.
      `    if [[ "${'${MATOS_ASSET_SOURCE_PRESERVE_DIRTY:-}'}" != "1" ]]; then cp ${JSON.stringify(originalFile)} ${JSON.stringify(entryFile)}; fi`,
      `    cat ${JSON.stringify(showPayload)}`,
      '    ;;',
      '  "assets validate "*)',
      `    while [[ -f ${JSON.stringify(validationGate)} ]]; do sleep 0.02; done`,
      '    if [[ "${MATOS_ASSET_SOURCE_PRESERVE_DIRTY:-}" != "1" ]]; then',
      `      cp ${JSON.stringify(originalFile)} ${JSON.stringify(entryFile)}`,
      '      printf \'%s\\n\' \'validation rematerialized accepted truth\' >&2',
      '      exit 1',
      '    fi',
      `    grep -q ${JSON.stringify(MARKER)} ${JSON.stringify(entryFile)}`,
      '    printf \'%s\\n\' \'{"ok":true,"errors":[]}\'',
      '    ;;',
      '  "assets git commit-source "*)',
      `    if ! grep -q ${JSON.stringify(MARKER)} ${JSON.stringify(entryFile)}; then`,
      '      printf \'%s\\n\' \'dirty edit was discarded before commit-source\' >&2',
      '      exit 1',
      '    fi',
      `    printf '%s\\n' ${JSON.stringify(JSON.stringify({
        ok: true,
        sourceId: SOURCE_ID,
        branch: 'main',
        action: 'committed',
        dirtyBefore: true,
        changedPaths: ['knowledge/shared-copy/KNOWLEDGE.md'],
        commit: CANDIDATE_COMMIT,
        pushed: true,
      }))}`,
      '    ;;',
      '  "assets git accept "*)',
      `    printf '%s\\n' ${JSON.stringify(JSON.stringify({
        ok: true,
        sourceId: SOURCE_ID,
        commit: CANDIDATE_COMMIT,
        acceptedBranch: `accepted/${SOURCE_ID}/stable`,
        validation: { ok: true, errors: [] },
        pushed: true,
      }))}`,
      '    ;;',
      '  *)',
      '    printf \'unexpected fake matos invocation: %s\\n\' "$*" >&2',
      '    exit 1',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);

  process.env.MATOS_BIN = fakeMatos;
  process.env.MATOS_ASSETS_CWD = workDir;
  process.env.MATOS_SCOPE_REF = 'user:alice';
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');

  const app: Express = express();
  app.use(express.json({ limit: '4mb' }));
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

describe('MatOS asset editor publish', () => {
  it('preserves the saved edit and accepts the exact committed candidate', async () => {
    const put = await fetch(
      `${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}/file`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'KNOWLEDGE.md',
          content: `# Shared copy\n\nOriginal.\n\n${MARKER}\n`,
        }),
      },
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as unknown).toMatchObject({
      ok: true,
      validation: { ok: true },
    });
    expect(await readFile(entryFile, 'utf8')).toContain(MARKER);

    const publish = await fetch(
      `${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}/publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Evolve my private shared copy' }),
      },
    );
    expect(publish.status).toBe(200);
    expect((await publish.json()) as unknown).toMatchObject({
      ok: true,
      sourceId: SOURCE_ID,
      commit: { commit: CANDIDATE_COMMIT, pushed: true },
      accept: { commit: CANDIDATE_COMMIT, ok: true },
    });
    expect(await readFile(entryFile, 'utf8')).toContain(MARKER);

    const calls = (await readFile(argvLog, 'utf8')).trim().split('\n');
    expect(calls.filter((call) => call.startsWith('assets show '))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('assets git commit-source '))).toHaveLength(1);
    const accept = calls.find((call) => call.startsWith('assets git accept '));
    expect(accept).toContain(`--ref ${CANDIDATE_COMMIT}`);
    expect(accept).not.toContain('--ref main');
  });

  it('rejects a concurrent stale edit without replacing the winning content', async () => {
    const detail = await (await fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}`)).json() as { files: Array<{ name: string; content: string }> };
    const base = detail.files.find((file) => file.name === 'KNOWLEDGE.md')!.content;
    const writes = await Promise.all(['first', 'second'].map((label) => fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'KNOWLEDGE.md', expectedContent: base, content: `${base}\n${MARKER}\n${label}` }),
    })));
    expect(writes.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = writes[0]!.status === 200 ? 'first' : 'second';
    expect(await readFile(entryFile, 'utf8')).toBe(`${base}\n${MARKER}\n${winner}`);
  });

  it('waits for an in-flight editor save before publishing its source checkout', async () => {
    const previousLog = await readFile(argvLog, 'utf8');
    const content = `${await readFile(entryFile, 'utf8')}\n${MARKER}\nserialized publish`;
    await writeFile(validationGate, 'blocked');
    const save = fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'KNOWLEDGE.md', content }),
    });
    let publish: Promise<Response> | undefined;
    let prematurePublish = false;
    try {
      await expect.poll(async () => (await readFile(argvLog, 'utf8')).slice(previousLog.length)).toContain('assets validate');
      publish = fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(REF)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      prematurePublish = (await readFile(argvLog, 'utf8')).slice(previousLog.length).includes('assets git commit-source');
    } finally {
      await rm(validationGate, { force: true });
      expect((await save).status).toBe(200);
      if (publish) expect((await publish).status).toBe(200);
    }
    expect(prematurePublish).toBe(false);
    expect(await readFile(entryFile, 'utf8')).toBe(content);
  });
});
