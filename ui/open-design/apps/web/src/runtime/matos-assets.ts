// Shared browser-side cache for the MatOS asset catalog.
//
// The daemon already keeps a scoped registry listing warm. Keeping the same
// listing in this module also makes Home -> Assets navigation instant and
// prevents each UI surface from starting its own request.

export interface MatOSAssetRoleRuntime {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
}

export interface MatOSAssetBoundary {
  visibility: 'public' | 'private' | 'collaborative';
  owner: 'matos' | 'current-scope' | 'project';
  editable: boolean;
  sharedCopy: boolean;
  selfEvolved: boolean;
  evolutionRuns: number;
  latestEvolutionAt: string | null;
}

export type MatOSAssetBoundaryFilter =
  | 'all'
  | 'public'
  | 'mine'
  | 'shared'
  | 'evolved'
  | 'project';

export interface MatOSAssetSummary {
  ref: string;
  /** Exact type-qualified identity from the registry. Older cached daemon
   * payloads may omit it, so picker code must retain the version fallback. */
  canonicalKey?: string | null;
  id: string;
  type: string;
  source: string | null;
  name: string;
  version: string | null;
  description: string | null;
  tags: string[];
  packId: string | null;
  entry: string | null;
  status: string | null;
  dependencies: string[];
  runtime: MatOSAssetRoleRuntime | null;
  git: { sourceId: string | null; scope: string | null; webUrl: string | null };
  /** Optional only for compatibility with a stale browser cache from before
   * the daemon started projecting the authoritative boundary. */
  boundary?: MatOSAssetBoundary;
}

export function versionlessMatOSAssetRef(value: string): string {
  const separator = value.indexOf(':');
  const version = value.lastIndexOf('@');
  return separator > 0 && version > separator ? value.slice(0, version) : value;
}

/** Catalog rows need exact refs for React keys, details and explicit pins.
 * Project persistence separately applies follow-accepted or pinned policy;
 * a displayed catalog version must not implicitly become a project pin. */
export function matOSAssetSelectionRef(asset: Pick<
  MatOSAssetSummary,
  'canonicalKey' | 'id' | 'ref' | 'type' | 'version'
>): string {
  const canonical = asset.canonicalKey?.trim();
  if (canonical) return canonical;
  const identity = `${asset.type}:${asset.id}`;
  return asset.version ? `${identity}@${asset.version}` : asset.ref || identity;
}

export function assetBoundaryOf(asset: {
  source: string | null;
  tags: string[];
  git: { scope: string | null; sourceId?: string | null; webUrl?: string | null };
  boundary?: MatOSAssetBoundary;
}): MatOSAssetBoundary {
  if (asset.boundary) return asset.boundary;
  const mine = asset.git.scope === 'user';
  const project = !mine && (
    asset.source === 'project' || ['team', 'project'].includes(asset.git.scope ?? '')
  );
  return {
    visibility: project ? 'collaborative' : mine ? 'private' : 'public',
    owner: project ? 'project' : mine ? 'current-scope' : 'matos',
    editable: mine,
    sharedCopy: mine && asset.tags.includes('forked') && asset.tags.includes('project-share'),
    selfEvolved: false,
    evolutionRuns: 0,
    latestEvolutionAt: null,
  };
}

export function matchesMatOSAssetBoundary(
  asset: {
    source: string | null;
    tags: string[];
    git: { scope: string | null };
    boundary?: MatOSAssetBoundary;
  },
  filter: MatOSAssetBoundaryFilter,
): boolean {
  if (filter === 'all') return true;
  const boundary = assetBoundaryOf(asset);
  if (filter === 'public') return boundary.visibility === 'public';
  if (filter === 'mine') {
    return (
      boundary.visibility === 'private' &&
      boundary.owner === 'current-scope' &&
      !boundary.sharedCopy
    );
  }
  if (filter === 'shared') return boundary.sharedCopy;
  if (filter === 'evolved') return boundary.selfEvolved;
  return boundary.visibility === 'collaborative';
}

let cachedAssets: MatOSAssetSummary[] | undefined;
let cachedAssetsAt = 0;
let inflight: Promise<MatOSAssetSummary[]> | undefined;
let requestGeneration = 0;

const CLIENT_CACHE_TTL_MS = 60_000;

function requestAssets(): Promise<MatOSAssetSummary[]> {
  const generation = ++requestGeneration;
  const request = (async () => {
    const resp = await fetch('/api/matos/assets', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: { message?: string } };
        if (body?.error?.message) message = body.error.message;
      } catch {
        // Keep the HTTP status message.
      }
      throw new Error(message);
    }
    const body = (await resp.json()) as { assets?: MatOSAssetSummary[] };
    if (!Array.isArray(body.assets)) throw new Error('invalid MatOS asset listing');
    return body.assets;
  })();

  inflight = request;
  void request.then(
    (assets) => {
      if (generation === requestGeneration) {
        cachedAssets = assets;
        cachedAssetsAt = Date.now();
      }
    },
    () => {
      // A failed background refresh must not discard the last usable listing.
    },
  ).finally(() => {
    if (generation === requestGeneration) inflight = undefined;
  });
  return request;
}

export function getCachedMatOSAssets(): MatOSAssetSummary[] | undefined {
  return cachedAssets;
}

export function clearMatOSAssetsCache(): void {
  requestGeneration += 1;
  cachedAssets = undefined;
  cachedAssetsAt = 0;
  inflight = undefined;
}

export async function fetchMatOSAssets(
  options: { refresh?: boolean; projectId?: string } = {},
): Promise<MatOSAssetSummary[]> {
  if (options.projectId) {
    const params = new URLSearchParams({ projectId: options.projectId });
    if (options.refresh) params.set('refresh', '1');
    const resp = await fetch(`/api/matos/assets?${params.toString()}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: { message?: string } | string };
        if (typeof body?.error === 'string') message = body.error;
        else if (body?.error?.message) message = body.error.message;
      } catch {
        // Keep the HTTP status message.
      }
      throw new Error(message);
    }
    const body = (await resp.json()) as { assets?: MatOSAssetSummary[] };
    if (!Array.isArray(body.assets)) throw new Error('invalid MatOS asset listing');
    return body.assets;
  }
  if (options.refresh) {
    clearMatOSAssetsCache();
    const generation = requestGeneration;
    const resp = await fetch('/api/matos/assets?refresh=1', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: { message?: string } };
        if (body?.error?.message) message = body.error.message;
      } catch {
        // Keep the HTTP status message.
      }
      throw new Error(message);
    }
    const body = (await resp.json()) as { assets?: MatOSAssetSummary[] };
    if (!Array.isArray(body.assets)) throw new Error('invalid MatOS asset listing');
    if (generation === requestGeneration) {
      cachedAssets = body.assets;
      cachedAssetsAt = Date.now();
    }
    return body.assets;
  }

  if (cachedAssets !== undefined) {
    if (Date.now() - cachedAssetsAt >= CLIENT_CACHE_TTL_MS && !inflight) {
      void requestAssets().catch(() => {});
    }
    return cachedAssets;
  }
  return inflight ?? requestAssets();
}
