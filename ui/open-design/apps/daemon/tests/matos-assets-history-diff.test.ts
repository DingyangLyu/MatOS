// Real HTTP -> native MatOS CLI -> native Git history, without a fake CLI.
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatOSAssetArchiveDetail, MatOSAssetArchiveList } from '@open-design/contracts';

const exec = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const bin = path.join(repository, 'bin/matos');
const assetRef = 'knowledge:archive-http@1.0.0';
let cwd = '';
let assetDir = '';
let server: http.Server | undefined;
let baseUrl = '';
let before: { snapshotId: string; commit: string };
let after: { snapshotId: string; commit: string };
const saved = { ...process.env };

async function cli(args: string[]) {
  const result = await exec(bin, args, { cwd, env: { ...process.env, MATOS_RUNTIME_COMPILED: '0', MATOS_ORIGINAL_CWD: cwd }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
}

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'matos-archive-http-'));
  assetDir = path.join(cwd, '.matos/assets/packs/example/knowledge/entry');
  await mkdir(assetDir, { recursive: true });
  for (const key of Object.keys(process.env)) if (/^(MATOS_|OD_MATOS_|ANTHROPIC_|OPENAI_|DEEPSEEK_)/.test(key)) delete process.env[key];
  process.env.MATOS_BIN = bin;
  process.env.MATOS_ASSETS_CWD = cwd;
  process.env.MATOS_RUNTIME_COMPILED = '0';
  process.env.MATOS_GITEA_DISABLE_OPERATOR_ENV = '1';
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  await writeFile(path.join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false }));
  await writeFile(path.join(cwd, '.matos/assets/packs/example/matos.pack.json'), JSON.stringify({ id: 'example', name: 'Example', version: '1.0.0' }));
  await writeFile(path.join(assetDir, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'knowledge', id: 'archive-http', name: 'Archive HTTP', version: '1.0.0', entry: 'KNOWLEDGE.md' }));
  await writeFile(path.join(assetDir, 'KNOWLEDGE.md'), '# Original procedure\n');
  before = (await cli(['assets', 'history', 'snapshot', '--scope', 'project', '--json'])).snapshot;
  await writeFile(path.join(assetDir, 'KNOWLEDGE.md'), '# Revised procedure\n');
  after = (await cli(['assets', 'history', 'snapshot', '--scope', 'project', '--json'])).snapshot;
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');
  const app = express();
  app.use(express.json());
  registerMatOSAssetRoutes(app);
  baseUrl = await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (cwd) await rm(cwd, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('native archive HTTP bridge', () => {
  it('shows scoped revisions and diffs without an authoring .git directory', async () => {
    const history = await fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(assetRef)}/history`);
    expect(history.status).toBe(200);
    const body = await history.json() as { git: { commits: Array<{ hash: string }> } };
    expect(body.git.commits.map(commit => commit.hash)).toContain(before.commit);
    const response = await fetch(`${baseUrl}/api/matos/assets/${encodeURIComponent(assetRef)}/history/${after.commit}`);
    const detail = await response.json() as { scope: string; patch: string };
    expect(response.status).toBe(200);
    expect(detail.scope).toBe('asset');
    expect(detail.patch).toContain('-# Original procedure');
    expect(detail.patch).toContain('+# Revised procedure');
    expect(JSON.stringify(detail)).not.toContain(cwd);
  }, 90_000);

  it('keeps deleted asset contents accessible and rejects malformed write requests', async () => {
    await rm(assetDir, { recursive: true });
    const list = await (await fetch(`${baseUrl}/api/matos/assets-archive?asset=knowledge:archive-http`)).json() as MatOSAssetArchiveList;
    expect(list.revisions).toHaveLength(2);
    const id = list.revisions[0]!.revisionId;
    const detail = await (await fetch(`${baseUrl}/api/matos/assets-archive/${id}`)).json() as MatOSAssetArchiveDetail;
    expect(detail.files.some(file => file.path === 'KNOWLEDGE.md')).toBe(true);
    const invalid = await fetch(`${baseUrl}/api/matos/assets-archive/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }) });
    expect(invalid.status).toBe(400);
    expect((await fetch(`${baseUrl}/api/matos/assets-archive/not-a-revision`)).status).toBe(400);
  }, 90_000);
});
