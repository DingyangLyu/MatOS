// MatOS asset bridge listing behavior: compact CLI projection, cached +
// stale-while-revalidate reads, and gzip transfer for the big catalog JSON.
//
// The bridge shells out to the `matos` binary; tests point MATOS_BIN at a
// tiny fake executable that records its argv and prints a fixed registry, so
// the real execFile transport, cache, and route code all run unmodified.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workDir: string;
let argvLog: string;
let server: http.Server | null = null;
let baseUrl = '';
const resolvedProjectIds: string[] = [];

const FAKE_ASSETS = {
  assets: [
    {
      id: 'materials-planner',
      type: 'role',
      name: 'Materials planner',
      version: '0.1.0',
      description: 'plans materials work',
      tags: ['planning'],
      packId: 'matos-core',
      entry: 'ROLE.md',
      lifecycle: { status: 'enabled' },
      dependencies: ['skill:vasp-relax@0.1.0'],
      runtime: {},
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-core-assets',
          scope: 'core',
          gitea: { webUrl: 'https://gitea.example/matos-core/assets' },
        },
      },
    },
    {
      id: 'vasp-relax',
      type: 'skill',
      name: 'VASP relax',
      version: '0.1.0',
      description: 'x'.repeat(20_000),
      tags: [],
      packId: 'matos-core',
      entry: 'SKILL.md',
      lifecycle: { status: 'enabled' },
      dependencies: [],
      metadata: {},
    },
  ],
};

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'od-matos-assets-bridge-'));
  argvLog = path.join(workDir, 'argv.log');
  const fakeMatos = path.join(workDir, 'fake-matos.sh');
  await writeFile(
    fakeMatos,
    [
      '#!/bin/bash',
      `echo "$@" >> ${JSON.stringify(argvLog)}`,
      `cat ${JSON.stringify(path.join(workDir, 'assets.json'))}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeMatos, 0o755);
  await writeFile(path.join(workDir, 'assets.json'), JSON.stringify(FAKE_ASSETS), 'utf8');
  await mkdir(path.join(workDir, '.matos'), { recursive: true });
  await writeFile(
    path.join(workDir, '.matos', 'matos.json'),
    JSON.stringify({ sources: [{ id: 'user-assets', runtimeRef: { commit: 'before' } }] }),
    'utf8',
  );

  // MATOS_BIN is read at module load, so set env BEFORE importing the route
  // module; prewarm stays off so cache behavior is driven by the test alone.
  process.env.MATOS_BIN = fakeMatos;
  process.env.MATOS_ASSETS_CWD = workDir;
  process.env.OD_MATOS_ASSETS_PREWARM = '0';
  process.env.MATOS_ASSETS_BRIDGE_CACHE_MS = '150';
  const { registerMatOSAssetRoutes } = await import('../src/routes/matos-assets.js');

  const app: Express = express();
  app.use(express.json());
  registerMatOSAssetRoutes(app, {
    resolveProjectCwd: (projectId) => {
      resolvedProjectIds.push(projectId);
      return projectId === 'project-a' ? workDir : undefined;
    },
  });
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

async function argvLines(): Promise<string[]> {
  try {
    return (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('MatOS asset bridge listing', () => {
  it('lists via the compact CLI projection and caches the listing', async () => {
    const first = await fetch(`${baseUrl}/api/matos/assets`);
    expect(first.status).toBe(200);
    const body = await first.json() as { assets: Array<Record<string, unknown>> };
    expect(body.assets.map((a) => a.ref).sort()).toEqual([
      'role:materials-planner',
      'skill:vasp-relax',
    ]);
    // Git provenance survives the compact projection.
    const role = body.assets.find((a) => a.ref === 'role:materials-planner') as {
      git: { sourceId: string | null; webUrl: string | null };
    };
    expect(role.git.sourceId).toBe('matos-core-assets');
    expect(role.git.webUrl).toBe('https://gitea.example/matos-core/assets');

    const callsAfterFirst = (await argvLines()).length;
    expect((await argvLines())[0]).toBe('assets list --json --compact');

    // Second read within the TTL: served from cache, no extra CLI call.
    const second = await fetch(`${baseUrl}/api/matos/roles`);
    expect(second.status).toBe(200);
    expect((await argvLines()).length).toBe(callsAfterFirst);
  });

  it('bypasses the listing cache when refresh=1 is requested', async () => {
    const before = (await argvLines()).length;
    const res = await fetch(`${baseUrl}/api/matos/roles?refresh=1`);
    expect(res.status).toBe(200);
    expect((await argvLines()).length).toBeGreaterThan(before);
  });

  it('invalidates the listing cache when the accepted asset config changes', async () => {
    const importedRole = {
      ...FAKE_ASSETS.assets[0],
      id: 'imported-private-role',
      name: 'Imported private role',
      version: '0.2.0',
    };
    await writeFile(
      path.join(workDir, 'assets.json'),
      JSON.stringify({ assets: [...FAKE_ASSETS.assets, importedRole] }),
      'utf8',
    );
    await writeFile(
      path.join(workDir, '.matos', 'matos.json'),
      JSON.stringify({ sources: [{ id: 'user-assets', runtimeRef: { commit: 'after' } }] }),
      'utf8',
    );

    const before = (await argvLines()).length;
    const res = await fetch(`${baseUrl}/api/matos/roles`);
    expect(res.status).toBe(200);
    const body = await res.json() as { roles: Array<{ id: string }> };
    expect(body.roles.some((role) => role.id === 'imported-private-role')).toBe(true);
    expect((await argvLines()).length).toBe(before + 1);

    // Restore the fixture/cache for the remaining shared-server tests.
    await writeFile(path.join(workDir, 'assets.json'), JSON.stringify(FAKE_ASSETS), 'utf8');
    await writeFile(
      path.join(workDir, '.matos', 'matos.json'),
      JSON.stringify({ sources: [{ id: 'user-assets', runtimeRef: { commit: 'restored' } }] }),
      'utf8',
    );
    expect((await fetch(`${baseUrl}/api/matos/roles`)).status).toBe(200);
  });

  it('resolves a project id server-side and caches its project-scoped listing separately', async () => {
    const before = (await argvLines()).length;
    const first = await fetch(`${baseUrl}/api/matos/assets?projectId=project-a`);
    expect(first.status).toBe(200);
    expect(resolvedProjectIds.at(-1)).toBe('project-a');
    expect((await argvLines()).length).toBe(before + 1);

    const second = await fetch(`${baseUrl}/api/matos/assets?projectId=project-a`);
    expect(second.status).toBe(200);
    expect((await argvLines()).length).toBe(before + 1);

    const missing = await fetch(`${baseUrl}/api/matos/assets?projectId=missing`);
    expect(missing.status).toBe(404);
  });

  it('serves stale instantly after the TTL and refreshes in the background', async () => {
    const before = (await argvLines()).length;
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/matos/assets`);
    expect(res.status).toBe(200);
    // Stale hit must not wait for the CLI walk.
    expect(Date.now() - started).toBeLessThan(120);

    // The background single-flight refresh lands shortly after.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await argvLines()).length).toBeGreaterThan(before);
  });

  it('gzips the catalog for gzip-accepting clients and round-trips the body', async () => {
    const res = await fetch(`${baseUrl}/api/matos/assets`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    // fetch transparently decodes; verify the wire encoding + vary header.
    expect(res.headers.get('vary')).toMatch(/accept-encoding/i);
    const body = await res.json() as { assets: unknown[] };
    expect(body.assets).toHaveLength(2);
  });

  it('skips gzip for clients that do not accept it', async () => {
    const res = await fetch(`${baseUrl}/api/matos/assets`, {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    const body = await res.json() as { assets: unknown[] };
    expect(body.assets).toHaveLength(2);
  });
});

describe('sendJsonMaybeGzip', () => {
  it('compresses large bodies and leaves small ones plain', async () => {
    const { sendJsonMaybeGzip, JSON_GZIP_MIN_BYTES } = await import('../src/http/json-gzip.js');
    const sent: Array<{ headers: Record<string, string>; body: Buffer | string }> = [];
    const fakeRes = (headers: Record<string, string>) => ({
      set(h: Record<string, string> | string, v?: string) {
        if (typeof h === 'string') headers[h.toLowerCase()] = String(v);
        else for (const [k, val] of Object.entries(h)) headers[k.toLowerCase()] = val;
        return this;
      },
      send(body: Buffer | string) {
        sent.push({ headers, body });
      },
    });

    const big = { data: 'y'.repeat(JSON_GZIP_MIN_BYTES * 2) };
    const h1: Record<string, string> = {};
    sendJsonMaybeGzip(
      { headers: { 'accept-encoding': 'gzip, deflate' } } as never,
      fakeRes(h1) as never,
      big,
    );
    expect(h1['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(sent[0]!.body as Buffer).toString('utf8'))).toEqual(big);

    const h2: Record<string, string> = {};
    sendJsonMaybeGzip(
      { headers: { 'accept-encoding': 'gzip' } } as never,
      fakeRes(h2) as never,
      { small: true },
    );
    expect(h2['content-encoding']).toBeUndefined();
    expect(String(sent[1]!.body)).toBe('{"small":true}');
  });
});
