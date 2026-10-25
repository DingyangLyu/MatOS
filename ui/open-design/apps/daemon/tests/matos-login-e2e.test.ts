/**
 * REAL end-to-end test for the BYOK login bridge (/api/matos/login/*).
 *
 * No mocks (repo testing policy): it mounts the real routes on a mini express
 * app and drives the real `matos login` CLI. The "user's own key" is the
 * deployment DeepSeek key read from the local environment file — a genuinely
 * valid provider credential — and the whole run happens on an ISOLATED scope
 * (MATOS_SCOPE_REF=user:byok-e2e-<pid>) so the deployment's own user:local
 * profile is never touched. `login set` is followed by a REAL provider
 * round-trip (`login test` inside the set handler), then reset cleans up.
 *
 * Requires provider credentials; skips with a reported blocker otherwise.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';

import { registerMatOSLoginRoutes } from '../src/routes/matos-login.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

function readUserKey(): string | null {
  try {
    const text = readFileSync(path.join(REPO_ROOT, '.env.deploy'), 'utf8');
    const match = /^DEEPSEEK_API_KEY=(.+)$/m.exec(text);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

const USER_KEY = readUserKey();
const E2E_SCOPE = `user:byok-e2e-${process.pid}`;

function withProductionNodeEnv<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  return run().finally(() => {
    process.env.NODE_ENV = prev;
  });
}

function startMiniServer(): Promise<{ baseUrl: string; server: http.Server }> {
  const app = express();
  app.use(express.json());
  registerMatOSLoginRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

async function postJson(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await resp.json()) as Record<string, unknown>;
}

describe.skipIf(!USER_KEY)('BYOK login bridge (real CLI, isolated scope)', () => {
  let server: http.Server | null = null;
  let baseUrl = '';
  const prevScope = process.env.MATOS_SCOPE_REF;

  beforeAll(async () => {
    // The bridge resolves the scope from the daemon process env — pin an
    // isolated one so this test cannot mutate the deployment profile.
    process.env.MATOS_SCOPE_REF = E2E_SCOPE;
    const started = await startMiniServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    // Cleanup: drop the isolated profile, then restore the process scope.
    await withProductionNodeEnv(() => postJson(`${baseUrl}/api/matos/login/reset`)).catch(
      () => undefined,
    );
    if (prevScope === undefined) delete process.env.MATOS_SCOPE_REF;
    else process.env.MATOS_SCOPE_REF = prevScope;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it(
    'stores the user provider, validates it against the real endpoint, and resets',
    { timeout: 300_000 },
    async () => {
      await withProductionNodeEnv(async () => {
        // 1. Save + verify (real provider round-trip inside the handler).
        const saved = await postJson(`${baseUrl}/api/matos/login/set`, {
          providerType: 'messages-compatible',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: USER_KEY,
          model: 'deepseek-v4-flash',
          fastModel: 'deepseek-v4-flash',
        });
        expect(saved.ok).toBe(true);
        const savedStatus = saved.status as Record<string, unknown>;
        expect(savedStatus.source).toBe('user');
        expect(savedStatus.status).toBe('validated');
        expect(savedStatus.hasSecret).toBe(true);
        // The key must never echo back.
        expect(JSON.stringify(saved)).not.toContain(USER_KEY);

        // 2. Status reflects the active user profile.
        const statusResp = await fetch(`${baseUrl}/api/matos/login/status`);
        const status = (await statusResp.json()) as Record<string, unknown>;
        expect((status.status as Record<string, unknown>).source).toBe('user');
        expect((status.status as Record<string, unknown>).model).toBe('deepseek-v4-flash');
        expect(JSON.stringify(status)).not.toContain(USER_KEY);

        // 3. Standalone test endpoint round-trips the provider again.
        const tested = await postJson(`${baseUrl}/api/matos/login/test`);
        expect(tested.ok).toBe(true);

        // 4. Reset restores the deployment default.
        const reset = await postJson(`${baseUrl}/api/matos/login/reset`);
        expect(reset.ok).toBe(true);
        const afterReset = (await (await fetch(`${baseUrl}/api/matos/login/status`)).json()) as
          Record<string, unknown>;
        expect((afterReset.status as Record<string, unknown>).source).toBe('deployment-default');
      });
    },
  );

  it('rejects malformed save requests without touching the CLI', async () => {
    const bad = await postJson(`${baseUrl}/api/matos/login/set`, {
      baseUrl: 'not-a-url',
      apiKey: 'k',
      model: 'm',
    });
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe('string');
  });
});
