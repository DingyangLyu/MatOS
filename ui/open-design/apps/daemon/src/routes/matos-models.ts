// MatOS provider-model catalog bridge. Thin adapter over the native
// `matos workbench models list --json` so the web chat can offer
// per-conversation model switching. Model authority stays in the CLI/runtime:
// this route only projects the catalog; the picked model travels back on each
// run request as `providerModel` and reaches the CLI as `--model <id>`.
//
// BYOK: the catalog runs under the user's configured MatOS provider env
// (Settings → MatOS model access), so a user on their own key/model sees
// THEIR provider's catalog. The cache is keyed by a redacted fingerprint of
// that env so switching providers refreshes the catalog immediately.

import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  execMatOSJson,
  isRecord,
  matosUserCliEnv,
  stringOrNull,
} from '../services/matos-cli.js';

const MODELS_CACHE_TTL_MS = Number(process.env.MATOS_MODELS_CACHE_MS || 5 * 60_000);

export interface MatOSWebModelOption {
  /** `--model` value; null selects the deployment default (flag omitted). */
  id: string | null;
  label: string;
  description: string;
  isDefault: boolean;
}

interface MatOSWebModelsPayload {
  available: boolean;
  models: MatOSWebModelOption[];
  generatedAt: string;
}

export function projectMatOSWebModel(raw: unknown): MatOSWebModelOption | null {
  if (!isRecord(raw)) return null;
  const label = stringOrNull(raw.label);
  if (!label) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  return {
    id,
    label,
    description: stringOrNull(raw.description) || '',
    isDefault: raw.isDefault === true,
  };
}

async function loadWebModels(env: NodeJS.ProcessEnv): Promise<MatOSWebModelOption[]> {
  const payload = await execMatOSJson(['workbench', 'models', 'list', '--json'], { env });
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const out: MatOSWebModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of payload.models) {
    const model = projectMatOSWebModel(raw);
    if (!model) continue;
    const key = model.id ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

// Non-reversible cache key for the provider env actually in effect. Only the
// provider-shaping variables participate; values (incl. secrets) are hashed,
// never stored or compared in the clear.
const MODEL_ENV_FINGERPRINT_KEYS = [
  'MATOS_MODEL_PROVIDER',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const;

export function modelEnvFingerprint(env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256');
  for (const key of MODEL_ENV_FINGERPRINT_KEYS) {
    hash.update(`${key}=${env[key] ?? ''}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

let modelsCache: { at: number; envFingerprint: string; payload: MatOSWebModelsPayload } | null =
  null;
let modelsRefresh: { envFingerprint: string; promise: Promise<MatOSWebModelsPayload> } | null =
  null;

// The catalog projection spawns a full matos CLI (~1s). Single-flight the
// refresh per env fingerprint and serve stale entries while it runs; warmup
// below hides the first-call latency after daemon boot.
function refreshWebModels(
  env: NodeJS.ProcessEnv,
  envFingerprint: string,
): Promise<MatOSWebModelsPayload> {
  if (!modelsRefresh || modelsRefresh.envFingerprint !== envFingerprint) {
    const promise = (async () => {
      const models = await loadWebModels(env);
      const payload: MatOSWebModelsPayload = {
        available: models.length > 0,
        models,
        generatedAt: new Date().toISOString(),
      };
      if (models.length > 0) modelsCache = { at: Date.now(), envFingerprint, payload };
      return payload;
    })();
    modelsRefresh = { envFingerprint, promise };
    // Housekeeping must not create an orphaned rejection: `promise.finally()`
    // returns a NEW promise that re-throws the refresh failure, and nobody
    // awaits that derived chain. With unhandled rejections terminating the
    // daemon, a mere `matos workbench models
    // list` failure (e.g. an older baked CLI without the subcommand) killed
    // the whole daemon ~2s after listening. Swallow the error on this side
    // branch; callers of `modelsRefresh.promise` still see the rejection.
    promise
      .catch(() => {})
      .finally(() => {
        if (modelsRefresh?.promise === promise) modelsRefresh = null;
      });
  }
  return modelsRefresh.promise;
}

export function warmMatOSModelsCache(): void {
  void (async () => {
    const env = await matosUserCliEnv();
    await refreshWebModels(env, modelEnvFingerprint(env));
  })().catch(() => {
    // Warmup is best-effort; the route degrades quietly on demand.
  });
}

export function registerMatOSModelRoutes(app: Express): void {
  app.get('/api/matos/models', (_req: Request, res: Response) => {
    void (async () => {
      const env = await matosUserCliEnv();
      const envFingerprint = modelEnvFingerprint(env);
      if (modelsCache && modelsCache.envFingerprint === envFingerprint) {
        if (Date.now() - modelsCache.at >= MODELS_CACHE_TTL_MS) {
          // Stale-while-revalidate: the picker gets the previous catalog
          // instantly; a provider change flips the fingerprint and skips this.
          refreshWebModels(env, envFingerprint).catch(() => {});
        }
        res.json(modelsCache.payload);
        return;
      }
      res.json(await refreshWebModels(env, envFingerprint));
    })().catch((error) => {
      // Degrade quietly: the picker hides itself when the catalog is
      // unavailable. Never block the chat surface on this bridge.
      res.status(200).json({
        available: false,
        models: [],
        generatedAt: new Date().toISOString(),
        error: {
          code: 'MATOS_MODELS',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
}
