// Real HTTP -> native CLI -> derived SQLite over isolated transcript fixtures.
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, expect, test } from 'vitest';

const saved = { ...process.env };
let server: Server, url: string, root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'matos-usage-http-'));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  for (const key of Object.keys(process.env)) if (/^(MATOS_|OD_MATOS_|ANTHROPIC_|OPENAI_|DEEPSEEK_|CLAUDE_CONFIG_DIR)/.test(key)) delete process.env[key];
  Object.assign(process.env, { MATOS_BIN: join(repo, 'bin/matos'), MATOS_ASSETS_CWD: root, MATOS_RUNTIME_COMPILED: '0', MATOS_SCOPE_REF: 'user:alice', MATOS_GITEA_DISABLE_OPERATOR_ENV: '1' });
  await mkdir(join(root, '.matos'), { recursive: true });
  await writeFile(join(root, '.matos/matos.json'), JSON.stringify({ version: 1, assetRoots: [], includeDefaultAssetRoots: false, execution: { runtimeDataDir: join(root, 'runtime') } }));
  const transcripts = join(root, 'runtime/scopes/users/alice/home/projects/w');
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(transcripts, 's.jsonl'), [0, 5].map(output => JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z', sessionId: 's', message: { id: 'api-response', model: 'deepseek-flash', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20 } } })).join('\n'));
  const { registerMatOSUserStatsRoutes } = await import('../src/routes/matos-user-stats.js');
  const app = express(); registerMatOSUserStatsRoutes(app);
  url = await new Promise<string>(done => { server = app.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)); });
});
afterAll(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
test('returns native deduplicated scoped usage, coalescing parallel requests', async () => {
  const responses = await Promise.all([1, 2, 3].map(() => fetch(`${url}/api/matos/user-stats?from=2026-09-01&to=2026-09-01`)));
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  expect(responses[0]!.headers.get('cache-control')).toBe('private, no-store');
  const bodies = await Promise.all(responses.map(r => r.json()));
  expect(bodies[0]).toMatchObject({ schemaVersion: 1, totalTokens: 35, foregroundTokens: 35, backgroundTokens: 0, timeZone: 'UTC' });
  expect(bodies[1]).toEqual(bodies[0]); expect(bodies[2]).toEqual(bodies[0]);
  expect(JSON.stringify(bodies)).not.toContain(root);
}, 120_000);
test('rejects invalid dates and client-supplied scope/path overrides before launching CLI', async () => {
  for (const query of ['from=2026-02-30', 'from=2026-09-02&to=2026-09-01', 'scope=user:bob', 'cwd=/etc', 'from=2026-09-01&from=2026-09-02']) {
    expect((await fetch(`${url}/api/matos/user-stats?${query}`)).status).toBe(400);
  }
});
