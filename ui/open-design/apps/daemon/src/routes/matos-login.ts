// MatOS BYOK login bridge. Thin adapter over the native `matos login`
// surface so the web Settings can store/validate the user's OWN provider
// (base URL + API key + model) as the per-scope MatOS provider profile.
//
// Why this path and not just env injection: a `matos login` profile is the
// runtime's highest-priority provider source — resolveMatOSProviderEnv clears
// the deployment provider env (including model presets) before applying it,
// so the user's key/model always wins. Env injection (agentCliEnv) remains a
// deployment-default-level override and can be shadowed by presets.
//
// Secret handling: the API key travels request body → child process env
// (`MATOS_LOGIN_KEY`) → `matos login set --api-key-env MATOS_LOGIN_KEY`.
// It never appears in argv, is never logged, and never echoes back — status
// responses only carry `hasSecret`.

import { execFile } from 'node:child_process';
import type { Express, Request, Response } from 'express';
import {
  EXEC_TIMEOUT_MS,
  MATOS_BIN,
  isRecord,
  matosCliEnv,
  matosCwd,
  parseMatOSJson,
} from '../services/matos-cli.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const KEY_ENV_NAME = 'MATOS_LOGIN_KEY';
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:[\]/+-]{0,127}$/i;

function execLoginJson(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      MATOS_BIN,
      ['login', ...args, '--json'],
      {
        cwd: matosCwd(),
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: matosCliEnv({ ...process.env, ...extraEnv }),
      },
      (error, stdout) => {
        // `login test` exits non-zero on validation failure but still prints
        // the structured verdict; prefer the payload over the exit code.
        try {
          resolvePromise(parseMatOSJson(String(stdout || '')));
        } catch {
          rejectPromise(
            error instanceof Error
              ? new Error(`matos login ${args[0]} failed`)
              : new Error('matos login returned no JSON payload'),
          );
        }
      },
    );
  });
}

/** Redacted projection: status/profile fields only, never secret values. */
export function projectLoginStatus(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return { ok: false };
  const status = isRecord(raw.status) ? raw.status : {};
  const pick = (key: string) =>
    typeof status[key] === 'string' || typeof status[key] === 'boolean'
      ? { [key]: status[key] }
      : {};
  return {
    ok: raw.ok === true,
    status: {
      ...pick('providerType'),
      ...pick('baseUrl'),
      ...pick('model'),
      ...pick('source'),
      ...pick('status'),
      ...pick('hasSecret'),
      ...pick('validatedAt'),
      ...pick('lastValidationError'),
    },
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}

export interface MatOSLoginSetInput {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export function validateLoginSetInput(raw: unknown): MatOSLoginSetInput | { error: string } {
  if (!isRecord(raw)) return { error: 'request body is required' };
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!apiKey) return { error: 'apiKey is required' };
  if (apiKey.length > 512) return { error: 'apiKey is too long' };
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return { error: 'baseUrl must be an http(s) URL' };
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (model && !MODEL_PATTERN.test(model)) return { error: 'model is invalid' };
  return { apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) };
}

export function registerMatOSLoginRoutes(app: Express): void {
  app.get('/api/matos/login/status', (_req: Request, res: Response) => {
    void execLoginJson(['status'])
      .then((payload) => res.json(projectLoginStatus(payload)))
      .catch((error) => {
        res.status(502).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  app.post('/api/matos/login/set', (req: Request, res: Response) => {
    void (async () => {
      const input = validateLoginSetInput(req.body);
      if ('error' in input) {
        res.status(400).json({ ok: false, error: input.error });
        return;
      }
      const args = [
        'set',
        '--api-key-env',
        KEY_ENV_NAME,
        ...(input.baseUrl ? ['--base-url', input.baseUrl] : []),
        ...(input.model ? ['--model', input.model] : []),
      ];
      const setResult = projectLoginStatus(
        await execLoginJson(args, { [KEY_ENV_NAME]: input.apiKey }),
      );
      if (setResult.ok !== true) {
        res.status(422).json(setResult);
        return;
      }
      // Immediately validate with a real provider round-trip so "saved"
      // always means "works" (or carries the provider's actual error).
      const testResult = projectLoginStatus(await execLoginJson(['test']));
      res.json(testResult);
    })().catch((error) => {
      res.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  app.post('/api/matos/login/test', (_req: Request, res: Response) => {
    void execLoginJson(['test'])
      .then((payload) => res.json(projectLoginStatus(payload)))
      .catch((error) => {
        res.status(502).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  app.post('/api/matos/login/reset', (_req: Request, res: Response) => {
    void execLoginJson(['reset'])
      .then((payload) => res.json({ ok: isRecord(payload) ? payload.ok === true : false }))
      .catch((error) => {
        res.status(502).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
