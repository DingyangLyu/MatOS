// Version-agnostic MatOS role-ref matching.
//
// Role refs are canonical asset keys (`role:compute`) that MAY carry a pinned
// version (`role:compute@0.3.0`). Self-evolution and asset publishing bump
// versions, so a conversation/roster/metadata map created against
// `role:compute@0.1.0` must keep matching the same member when the catalog now
// says `role:compute@0.2.0`. Every UI-side comparison of role refs must go
// through these helpers — exact `===` on refs is how duplicate member DMs and
// "member not found" bindings happened after a role version bump. The daemon
// side has its own mirror of this rule (roleIdentity in the project routes).

/** `role:compute@0.2.0` -> `role:compute` (trimmed; empty stays empty). */
export function roleRefIdentity(ref: string): string {
  const trimmed = ref.trim();
  const at = trimmed.indexOf('@');
  return at >= 0 ? trimmed.slice(0, at) : trimmed;
}

/** Version-agnostic ref equality; null/undefined never match. */
export function sameRoleRef(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  return roleRefIdentity(a) === roleRefIdentity(b);
}

/** First list entry whose ref matches version-agnostically. */
export function findByRoleRef<T extends { ref: string }>(
  list: readonly T[],
  ref: string | null | undefined,
): T | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  const identity = roleRefIdentity(ref);
  return list.find((entry) => roleRefIdentity(entry.ref) === identity);
}

/**
 * Record lookup keyed by role ref (`metadata.memberNames`/`memberBriefs`).
 * Exact key first (cheap, and the common case), then a version-agnostic scan.
 */
export function roleRefRecordValue<T>(
  record: Record<string, T> | null | undefined,
  ref: string | null | undefined,
): T | undefined {
  if (!record || typeof ref !== 'string' || !ref) return undefined;
  if (ref in record) return record[ref];
  const identity = roleRefIdentity(ref);
  for (const [key, value] of Object.entries(record)) {
    if (roleRefIdentity(key) === identity) return value;
  }
  return undefined;
}

/**
 * Resolve a requested ref to the canonical entry of a roster (the project's
 * `memberRefs`). Returns the ROSTER's spelling so downstream metadata-key
 * lookups and persisted rows stay aligned with the project authority.
 */
export function canonicalRosterRef(
  roster: readonly string[] | null | undefined,
  ref: string | null | undefined,
): string | null {
  if (!roster || typeof ref !== 'string' || !ref) return null;
  const identity = roleRefIdentity(ref);
  return roster.find((entry) => roleRefIdentity(entry) === identity) ?? null;
}

/** Add a required role to a roster without duplicating another pinned version. */
export function includeRoleRef(
  roster: readonly string[] | null | undefined,
  ref: string | null | undefined,
): string[] {
  const members = [...(roster ?? [])];
  if (typeof ref !== 'string' || !ref.trim()) return members;
  const required = ref.trim();
  if (!members.some((member) => sameRoleRef(member, required))) members.push(required);
  return members;
}

/** Read and version-dedupe the role roster projected onto project metadata. */
export function projectRoleRefsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { members?: unknown }).members;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const members: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const ref = value.trim();
    if (!ref.startsWith('role:')) continue;
    const identity = roleRefIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    members.push(ref);
  }
  return members;
}

/**
 * Roles selected as project assets are runnable project roles too. Keep the
 * explicit member roster first (it still owns the sidebar/group-chat order),
 * then append selected `role:` assets without duplicating a differently
 * pinned version. This lets a recipient use a private role forked with a
 * shared project instead of silently falling back to Compute.
 */
export function projectRunnableRoleRefs(
  memberRefs: readonly string[] | null | undefined,
  assetRefs: readonly string[] | null | undefined,
): string[] {
  const roles = projectRoleRefsFromMetadata({ members: memberRefs ?? [] });
  const seen = new Set(roles.map(roleRefIdentity));
  for (const value of assetRefs ?? []) {
    if (typeof value !== 'string') continue;
    const ref = value.trim();
    if (!ref.startsWith('role:')) continue;
    const identity = roleRefIdentity(ref);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    roles.push(ref);
  }
  return roles;
}

/**
 * Resolve ordered role candidates inside a project boundary. Callers provide
 * candidates from strongest to weakest, normally conversation/group binding,
 * project-local selection, then the Home/global preference. The project's
 * spelling wins so pinned-version metadata remains coherent.
 */
export function resolveProjectRoleSelection(
  roster: readonly string[] | null | undefined,
  candidates: readonly (string | null | undefined)[],
): string | null {
  const members = projectRoleRefsFromMetadata({ members: roster ?? [] });
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const candidate = value.trim();
    if (!candidate.startsWith('role:')) continue;
    if (members.length === 0) return candidate;
    const canonical = canonicalRosterRef(members, candidate);
    if (canonical) return canonical;
  }
  return members[0] ?? null;
}

/**
 * Resolve a MatOS run role inside a project roster. A stale global role pick
 * must never cross the project's membership boundary; use the first project
 * member instead. Legacy projects with no roster keep their requested role.
 */
export function resolveProjectRunRoleRef(
  roster: readonly string[] | null | undefined,
  requestedRef: string | null | undefined,
): string | null {
  return resolveProjectRoleSelection(roster, [requestedRef]);
}
