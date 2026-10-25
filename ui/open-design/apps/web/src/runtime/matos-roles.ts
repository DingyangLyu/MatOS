// MatOS conversation-role catalog shared by the Home composer role picker.
//
// The Home card that upstream Open Design used for design-system selection is
// a MatOS *role* selection in this product: the picked `role:<id>` ref is
// stamped on the created project and forwarded to every `matos` run as
// `--role`. This module owns the `/api/matos/roles` fetch (daemon bridge over
// `matos assets list --json`) plus a module-level cache, so pickers can mount
// repeatedly (Home unmounts on every tab switch) without re-walking the MatOS
// asset registry.

import { useEffect, useState } from 'react';

export interface MatOSRoleRuntimeSettings {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
}

export interface MatOSRoleSummary {
  /** Canonical role ref when known, e.g. `role:compute@1.0.3`. */
  ref: string;
  id: string;
  version?: string | null;
  name: string;
  description: string | null;
  tags: string[];
  /** Mounted-asset refs (`type:id[@ver]`) composed by the role at runtime. */
  dependencies: string[];
  /** Role-level runtime overrides (`matos roles runtime set`), null when unset. */
  runtime: MatOSRoleRuntimeSettings | null;
}

// An unavailable catalog must not advertise roles from a different bundle.
// The picker has its own default-role row; a successful cached catalog can
// still serve through a transient refresh outage.
export const MATOS_FALLBACK_ROLES: MatOSRoleSummary[] = [];

function normalizeRuntime(raw: unknown): MatOSRoleRuntimeSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const runtime: MatOSRoleRuntimeSettings = {
    model: str(record.model),
    effort: str(record.effort) ?? (typeof record.effort === 'number' ? String(record.effort) : null),
    permissionMode: str(record.permissionMode),
    maxTurns:
      typeof record.maxTurns === 'number' && Number.isInteger(record.maxTurns) && record.maxTurns > 0
        ? record.maxTurns
        : null,
  };
  const empty =
    runtime.model === null &&
    runtime.effort === null &&
    runtime.permissionMode === null &&
    runtime.maxTurns === null;
  return empty ? null : runtime;
}

function normalizeRole(raw: unknown): MatOSRoleSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const version = typeof record.version === 'string' && record.version.trim() ? record.version.trim() : null;
  const rawRef = typeof record.ref === 'string' && record.ref.trim() ? record.ref.trim() : `role:${id}`;
  const ref = rawRef.includes('@') || !version ? rawRef : `${rawRef}@${version}`;
  return {
    ref,
    id,
    version,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
    description:
      typeof record.description === 'string' && record.description.trim()
        ? record.description.trim()
        : null,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((t): t is string => typeof t === 'string')
      : [],
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
    runtime: normalizeRuntime(record.runtime),
  };
}

export async function fetchMatOSRoles(options: { refresh?: boolean } = {}): Promise<MatOSRoleSummary[]> {
  const resp = await fetch(options.refresh ? '/api/matos/roles?refresh=1' : '/api/matos/roles', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`GET /api/matos/roles failed (${resp.status})`);
  const data = (await resp.json()) as { roles?: unknown };
  const rows = Array.isArray(data.roles) ? data.roles : [];
  return rows
    .map(normalizeRole)
    .filter((role): role is MatOSRoleSummary => role !== null);
}

// The registry walk behind the bridge can take 10s+ on a cold bun start, so a
// resolved catalog is cached and shared between picker mounts. The MatOS
// asset registry is the DYNAMIC role source of truth — new role assets keep
// landing while the app is open (self-evolution, user packs, Gitea syncs) —
// so the cache carries a TTL instead of pinning the first response for the
// whole page session: a stale entry serves immediately (no popover flash)
// while the next open refetches. A failed refresh keeps the stale catalog so
// a daemon hiccup never blanks the picker.
const ROLES_CACHE_TTL_MS = 60_000;
let rolesCache: { at: number; roles: MatOSRoleSummary[] } | null = null;
let rolesInflight: Promise<MatOSRoleSummary[]> | null = null;

function rolesCacheFresh(): boolean {
  return rolesCache !== null && Date.now() - rolesCache.at < ROLES_CACHE_TTL_MS;
}

export function loadMatOSRoles(options: { refresh?: boolean } = {}): Promise<MatOSRoleSummary[]> {
  if (!options.refresh && rolesCache && rolesCacheFresh()) return Promise.resolve(rolesCache.roles);
  if (rolesInflight) return rolesInflight;
  const stale = rolesCache;
  rolesInflight = fetchMatOSRoles({ refresh: options.refresh })
    .then((roles) => {
      rolesCache = {
        at: Date.now(),
        roles,
      };
      return rolesCache.roles;
    })
    .catch(() => stale?.roles ?? MATOS_FALLBACK_ROLES)
    .finally(() => {
      rolesInflight = null;
    });
  return rolesInflight;
}

/** Test-only: reset the module cache between cases. */
export function resetMatOSRolesCacheForTests(): void {
  rolesCache = null;
  rolesInflight = null;
}

/**
 * Role catalog hook. `enabled=false` defers the fetch (pickers pass their
 * popover-open state so the registry walk only happens on first open). While
 * enabled, a stale cache is served immediately and refreshed in the
 * background, so an expanding asset registry shows up on the next open
 * without a page reload.
 */
export function useMatOSRoles(
  enabled = true,
  options: { refresh?: boolean } = {},
): { roles: MatOSRoleSummary[]; loading: boolean } {
  const [roles, setRoles] = useState<MatOSRoleSummary[]>(() => rolesCache?.roles ?? []);
  const [loading, setLoading] = useState(() => rolesCache === null);
  useEffect(() => {
    if (!enabled || (!options.refresh && rolesCacheFresh())) return;
    let cancelled = false;
    if (!rolesCache) setLoading(true);
    void loadMatOSRoles({ refresh: options.refresh }).then((loaded) => {
      if (cancelled) return;
      setRoles(loaded);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, options.refresh]);
  return { roles, loading };
}
