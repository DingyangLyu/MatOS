type JsonObject = Record<string, unknown>;

interface ProjectSummary {
  id: string;
  name: string;
  metadata?: JsonObject;
}

interface ProjectsPayload {
  projects?: ProjectSummary[];
}

interface ActiveContext {
  active?: boolean;
  projectId?: string;
  projectName?: string | null;
  fileName?: string | null;
  ageMs?: number | null;
}

export type ResolvedProject = {
  id: string;
  name: string;
  source: 'uuid' | 'id' | 'exact' | 'slug' | 'substring';
};

interface ProjectListCache {
  baseUrl: string;
  t: number;
  list: ProjectSummary[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_LIST_TTL_MS = 5000;
let projectListCache: ProjectListCache | null = null;

async function fetchProjectList(baseUrl: string): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (
    projectListCache &&
    projectListCache.baseUrl === baseUrl &&
    now - projectListCache.t < PROJECT_LIST_TTL_MS
  ) {
    return projectListCache.list;
  }
  const data = await getJson<ProjectsPayload>(`${baseUrl}/api/projects`);
  const list = Array.isArray(data?.projects) ? data.projects : [];
  projectListCache = { baseUrl, t: now, list };
  return list;
}

export async function resolveProjectArg(
  baseUrl: string,
  arg: unknown,
): Promise<{ id: string; resolved: ResolvedProject | null; active: ActiveContext | null }> {
  if (typeof arg === 'string' && arg.length > 0) {
    const resolved = await resolveProjectId(baseUrl, arg);
    return { id: resolved.id, resolved, active: null };
  }
  let active: ActiveContext;
  try {
    active = await getJson<ActiveContext>(`${baseUrl}/api/active`);
  } catch (err) {
    throw new Error(
      `project arg omitted and active context lookup failed: ${errorMessage(err)}. Pass project="<id-or-name>".`,
    );
  }
  if (!active || active.active === false || !active.projectId) {
    throw new Error(
      'project arg omitted and MatOS has no active project. The active context expires about 5 minutes after the last user interaction with MatOS - the user may need to click into a project to wake it up. Otherwise pass project="<id-or-name>".',
    );
  }
  return { id: active.projectId, resolved: null, active };
}

export async function resolveProjectId(baseUrl: string, arg: unknown): Promise<ResolvedProject> {
  if (typeof arg !== 'string' || !arg) {
    throw new Error('project is required (string).');
  }
  if (UUID_RE.test(arg)) return { id: arg, name: arg, source: 'uuid' as const };

  const list = await fetchProjectList(baseUrl);
  if (list.length === 0) {
    throw new Error('no projects on this daemon');
  }

  const lower = arg.toLowerCase();
  const norm = (s: unknown): string =>
    String(s || '')
      .toLowerCase()
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/[\s_-]+/g, '-');
  const target = norm(arg);

  const idMatch = list.find((p) => p.id === arg);
  if (idMatch) return { id: idMatch.id, name: idMatch.name, source: 'id' as const };

  const exact = list.filter((p) => String(p.name || '').toLowerCase() === lower);
  if (exact.length === 1) {
    const p = exact[0]!;
    return { id: p.id, name: p.name, source: 'exact' as const };
  }

  const slugged = list.filter((p) => norm(p.name) === target);
  if (slugged.length === 1) {
    const p = slugged[0]!;
    return { id: p.id, name: p.name, source: 'slug' as const };
  }

  const subs = list.filter((p) =>
    String(p.name || '').toLowerCase().includes(lower),
  );
  if (subs.length === 1) {
    const p = subs[0]!;
    return { id: p.id, name: p.name, source: 'substring' as const };
  }
  if (subs.length > 1) {
    const opts = subs.map((p) => `${p.name} (${p.id})`).join(', ');
    throw new Error(
      `multiple projects match "${arg}": ${opts}. Pass the UUID instead.`,
    );
  }
  throw new Error(`no project matches "${arg}"`);
}

export function withActiveEcho<T extends JsonObject>(
  payload: T,
  active: ActiveContext | null,
  resolved?: ResolvedProject | null,
): T & JsonObject {
  const result = active ? { ...payload, usedActiveContext: activeEchoPayload(active) } : payload;
  if (resolved && (resolved.source === 'slug' || resolved.source === 'substring')) {
    return { ...result, resolvedProject: { id: resolved.id, name: resolved.name } };
  }
  return result;
}

function activeEchoPayload(active: ActiveContext) {
  return {
    projectId: active.projectId,
    projectName: active.projectName ?? null,
    fileName: active.fileName ?? null,
    ageMs: active.ageMs ?? null,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`daemon ${resp.status} on ${url}: ${body || resp.statusText}`);
  }
  return (await resp.json()) as T;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
