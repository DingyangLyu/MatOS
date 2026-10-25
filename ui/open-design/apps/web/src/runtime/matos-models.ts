// Native MatOS provider-model catalog for the composer model picker. The
// daemon bridge (`/api/matos/models`) projects `matos workbench models list`.

export interface MatOSModelOption {
  /** `--model` value; null selects the deployment default. */
  id: string | null;
  label: string;
  description: string;
  isDefault: boolean;
}

let modelsCache: { at: number; models: MatOSModelOption[] } | null = null;
let modelsInflight: Promise<MatOSModelOption[]> | null = null;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

function normalizeModel(raw: unknown): MatOSModelOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (!label) return null;
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null,
    label,
    description: typeof record.description === 'string' ? record.description : '',
    isDefault: record.isDefault === true,
  };
}

/**
 * Resolve the native provider-model catalog (`matos workbench models list`
 * through the daemon bridge). Returns `[]` (never throws) when the bridge is
 * unavailable so the model picker can simply hide itself.
 */
export async function fetchMatOSModels(): Promise<MatOSModelOption[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  if (modelsInflight) return modelsInflight;
  modelsInflight = (async () => {
    try {
      const resp = await fetch('/api/matos/models', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) throw new Error(`GET /api/matos/models failed (${resp.status})`);
      const data = (await resp.json()) as { available?: boolean; models?: unknown };
      if (data.available === false || !Array.isArray(data.models)) return [];
      const models = data.models
        .map(normalizeModel)
        .filter((model): model is MatOSModelOption => model !== null);
      if (models.length > 0) modelsCache = { at: Date.now(), models };
      return models;
    } catch {
      return modelsCache?.models ?? [];
    } finally {
      modelsInflight = null;
    }
  })();
  return modelsInflight;
}
