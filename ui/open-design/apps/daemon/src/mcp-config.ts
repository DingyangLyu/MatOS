// External MCP server configuration storage + spawn-time wiring.
//
// MatOS acts as an MCP CLIENT to one or more external MCP servers
// (Higgsfield openclaw, GitHub, filesystem, anything the user configures).
// At spawn time we hand those servers to the MatOS runtime through a
// project-cwd `.mcp.json` so the agent surfaces their tools to the model.
//
// Storage: <dataDir>/mcp-config.json with shape `{ servers: [...] }`. The
// dataDir resolution mirrors app-config.ts so OD_DATA_DIR / packaged daemon
// runtime layouts route this file alongside the rest of the runtime state.
//
// We deliberately keep the schema close to Claude Code's `.mcp.json` and
// Cursor's MCP config — those are the de-facto interchange formats — so
// users can copy-paste between MatOS and other tools without
// translation.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Wire-level MCP types. Mirrors `packages/contracts/src/api/mcp.ts` — the
// daemon and web import-from-contracts side both round-trip the same JSON
// shape, but NodeNext + the contracts package's mixed bundler-emit setup
// would force a `./api/mcp` subpath export here. Keeping the canonical
// definitions in `contracts` (consumed by the web app) and re-stating the
// minimal mirror in the daemon keeps the existing module-resolution shape
// for the rest of the codebase intact. Both sides MUST stay in sync.
export type McpTransport = 'stdio' | 'sse' | 'http';
export type McpAuthMode = 'none' | 'oauth';

export interface McpServerConfig {
  id: string;
  label?: string;
  templateId?: string;
  transport: McpTransport;
  enabled: boolean;
  authMode?: McpAuthMode;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface McpTemplateField {
  key: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  secret?: boolean;
}

// Mirrors `McpTemplateCategory` in `packages/contracts/src/api/mcp.ts`.
// Stable string union; both sides MUST stay in sync (the web UI uses this
// to group + order entries in the picker).
export type McpTemplateCategory =
  | 'materials-science'
  | 'research-literature'
  | 'image-generation'
  | 'image-editing'
  | 'web-capture'
  | 'ui-components'
  | 'data-viz'
  | 'publishing'
  | 'utilities';

export interface McpTemplate {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  authMode?: McpAuthMode;
  category: McpTemplateCategory;
  homepage?: string;
  // One-liner prompt shown in the UI so the user has a concrete starting
  // example for each preset. Mirrors the field in `packages/contracts`.
  example?: string;
  command?: string;
  args?: string[];
  envFields?: McpTemplateField[];
  url?: string;
  headerFields?: McpTemplateField[];
}

const VALID_TRANSPORTS: ReadonlySet<McpTransport> = new Set([
  'stdio',
  'sse',
  'http',
]);
const VALID_AUTH_MODES: ReadonlySet<McpAuthMode> = new Set(['none', 'oauth']);

// Slug rule for server ids. The id flows into agent-facing config files
// (Claude Code's `mcpServers` map keys, ACP `name`) and in some cases into
// argv / env, so we keep it strictly alphanumeric + `-` / `_`.
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function configFile(dataDir: string): string {
  return path.join(dataDir, 'mcp-config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeStringMap(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (typeof k !== 'string' || !k.trim()) continue;
    if (typeof v !== 'string') continue;
    // Drop empty / whitespace-only values. Persisting them is worse than
    // omitting them: the spawn-time merge treats a present header as
    // "user pinned this", which would block our daemon-issued OAuth
    // Bearer from being injected. The UI also has placeholder fields
    // (e.g. an "Authorization=" template row) the user can leave blank
    // — those should never make it into the saved config.
    if (v.trim() === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/g, '');
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  const mapped = /^::ffff:(127(?:\.\d{1,3}){3})$/i.exec(host)?.[1];
  return Boolean(mapped);
}

export function inferMcpAuthModeForUrl(rawUrl: string | undefined): McpAuthMode {
  if (!rawUrl) return 'oauth';
  try {
    return isLoopbackHost(new URL(rawUrl).hostname) ? 'none' : 'oauth';
  } catch {
    return 'oauth';
  }
}

function sanitizeMcpAuthMode(raw: unknown): McpAuthMode | undefined {
  return typeof raw === 'string' && VALID_AUTH_MODES.has(raw as McpAuthMode)
    ? (raw as McpAuthMode)
    : undefined;
}

function effectiveMcpAuthMode(server: McpServerConfig): McpAuthMode {
  if (server.transport !== 'http' && server.transport !== 'sse') return 'none';
  return server.authMode ?? inferMcpAuthModeForUrl(server.url);
}

/**
 * Validate a single user-supplied entry. Drops invalid fields so a typo in
 * one server doesn't tank the whole config. Returns null when the entry is
 * unsalvageable (no id, or no transport-required fields).
 */
export function sanitizeMcpServer(raw: unknown): McpServerConfig | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!SERVER_ID_PATTERN.test(id)) return null;
  const transport = typeof raw.transport === 'string' ? (raw.transport as McpTransport) : 'stdio';
  if (!VALID_TRANSPORTS.has(transport)) return null;

  const next: McpServerConfig = {
    id,
    transport,
    enabled: raw.enabled !== false,
  };
  if (typeof raw.label === 'string' && raw.label.trim()) {
    next.label = raw.label.trim();
  }
  if (typeof raw.templateId === 'string' && raw.templateId.trim()) {
    next.templateId = raw.templateId.trim();
  }

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return null;
    next.command = raw.command.trim();
    const args = sanitizeStringArray(raw.args);
    if (args) next.args = args;
    const env = sanitizeStringMap(raw.env);
    if (env) next.env = env;
  } else {
    if (typeof raw.url !== 'string' || !raw.url.trim()) return null;
    // Reject anything that isn't an http(s) URL — protects against accidental
    // `file://` / `javascript:` slipping into a config file.
    let parsed: URL;
    try {
      parsed = new URL(raw.url.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    next.url = parsed.toString();
    next.authMode = sanitizeMcpAuthMode(raw.authMode) ?? inferMcpAuthModeForUrl(next.url);
    const headers = sanitizeStringMap(raw.headers);
    if (headers) next.headers = headers;
  }
  return next;
}

export function sanitizeMcpConfig(raw: unknown): McpConfig {
  if (!isPlainObject(raw)) return { servers: [] };
  const list = Array.isArray(raw.servers) ? raw.servers : [];
  const seen = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const entry of list) {
    const ok = sanitizeMcpServer(entry);
    if (!ok) continue;
    if (seen.has(ok.id)) continue; // de-dupe by id
    seen.add(ok.id);
    out.push(ok);
  }
  return { servers: out };
}

export async function readMcpConfig(dataDir: string): Promise<McpConfig> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return sanitizeMcpConfig(parsed);
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return { servers: [] };
    if (e.name === 'SyntaxError') {
      console.error('[mcp-config] Corrupted JSON, returning empty:', e.message);
      return { servers: [] };
    }
    throw err;
  }
}

const writeLocks = new Map<string, Promise<unknown>>();

export async function writeMcpConfig(
  dataDir: string,
  body: unknown,
): Promise<McpConfig> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, body));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function doWrite(dataDir: string, body: unknown): Promise<McpConfig> {
  const next = sanitizeMcpConfig(body);
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  return next;
}

// ───────────────────────────────────────────────────────────────────────
// Spawn-time wiring helpers.
// ───────────────────────────────────────────────────────────────────────

/**
 * True when `cwd` is a daemon-managed project directory under PROJECTS_DIR
 * (= safe to write `.mcp.json` into without risk of clobbering a user-owned
 * file). Git-linked projects whose cwd points at the user's own repo, and
 * the no-project fallback that resolves to PROJECT_ROOT, both return false
 * — the daemon must NOT write external-MCP config into either of those.
 */
export function isManagedProjectCwd(
  cwd: string | null | undefined,
  projectsDir: string,
): boolean {
  if (!cwd || typeof cwd !== 'string') return false;
  if (typeof projectsDir !== 'string' || projectsDir.length === 0) return false;
  // Runtime paths may use a short socket alias while project paths are real.
  // Resolve both sides so aliases stay managed and outward symlinks do not.
  const canonical = (value: string) => {
    try { return realpathSync.native(value); }
    catch { return path.resolve(value); }
  };
  const root = canonical(projectsDir);
  const target = canonical(cwd);
  return target !== root && target.startsWith(root + path.sep);
}

/**
 * Project-cwd `.mcp.json` shape that Claude Code auto-loads on spawn (the
 * same format Claude Desktop and Cursor use). Returns null when the user
 * has no enabled servers — in that case the caller should NOT write the
 * file (and should clean up any stale one).
 *
 * `tokens` is an optional map of `serverId -> bearer access token`, used
 * for HTTP/SSE servers that completed the daemon's web OAuth flow. When a
 * token is present we inject `Authorization: Bearer <token>` into the
 * server's headers — this is what bypasses the per-spawn `mcp-remote`
 * dance and lets Claude Code talk directly to the upstream MCP using
 * pre-authenticated credentials. User-supplied headers always win on
 * conflict so they can pin a specific token if they really want to.
 */
export function buildClaudeMcpJson(
  servers: McpServerConfig[],
  tokens: Record<string, string> = {},
): unknown | null {
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of enabled) {
    if (s.transport === 'stdio') {
      const entry: Record<string, unknown> = { command: s.command };
      if (s.args && s.args.length > 0) entry.args = s.args;
      if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
      out[s.id] = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: s.transport, // 'sse' | 'http'
        url: s.url,
      };
      const headers = mergeAuthHeader(
        s.headers,
        effectiveMcpAuthMode(s) === 'oauth' ? tokens[s.id] : undefined,
      );
      if (headers && Object.keys(headers).length > 0) entry.headers = headers;
      out[s.id] = entry;
    }
  }
  return { mcpServers: out };
}

/** Build a headers object that includes the daemon-issued bearer token when
 * the user hasn't already supplied a NON-EMPTY Authorization header. A
 * blank Authorization (empty string / whitespace only) is treated as
 * "not pinned" — historically the template UI persisted empty values from
 * unfilled fields, and we never want a blank Authorization to suppress a
 * valid OAuth Bearer (the upstream MCP would refuse the connection and
 * fall back to its in-tool re-auth dance). Real user-pinned values still
 * win so manually-set PATs aren't silently overwritten. */
function mergeAuthHeader(
  existing: Record<string, string> | undefined,
  bearer: string | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let userAuth: string | null = null;
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (k.toLowerCase() === 'authorization') {
      if (typeof v === 'string' && v.trim() !== '') {
        userAuth = v;
        merged[k] = v;
      }
      // empty / whitespace authorization is ignored, NOT carried through
      continue;
    }
    merged[k] = v;
  }
  if (bearer && !userAuth) {
    merged['Authorization'] = `Bearer ${bearer}`;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// ───────────────────────────────────────────────────────────────────────
// Built-in templates surfaced in the Settings "Add MCP server" picker.
// Picking one fills the form with defaults; the resulting McpServerConfig
// flows through the same persistence path as a fully-custom entry.
// ───────────────────────────────────────────────────────────────────────

export const MCP_TEMPLATES: McpTemplate[] = [
  // ── materials-science ───────────────────────────────────────────────
  {
    id: 'materials-project',
    label: 'Materials Project',
    description:
      'Search, visualize and pull structures / properties from the Materials Project database (bandgaps, formation energies, elastic tensors, phase diagrams, crystal structures). Runs via the Path Integral `mcp-science` launcher. Requires a free Materials Project API key from next-gen.materialsproject.org → Dashboard → API. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'materials-science',
    homepage: 'https://github.com/pathintegral-institute/mcp.science/tree/main/servers/materials-project',
    example:
      'Find stable oxide perovskites with a bandgap between 1.5 and 2.5 eV and list their formation energies.',
    command: 'uvx',
    args: ['mcp-science', 'materials-project'],
    envFields: [
      {
        key: 'MP_API_KEY',
        label: 'Materials Project API key',
        required: true,
        placeholder: '<mp-api-key>',
        secret: true,
      },
    ],
  },
  {
    id: 'optimade',
    label: 'OPTIMADE (multi-database structure search)',
    description:
      'Query crystal structures across every public OPTIMADE provider at once — Materials Project, Materials Cloud, COD, OQMD, AFLOW, NOMAD and more — with a single natural-language request. The agent generates the OPTIMADE filter, runs it against the providers, saves the returned JSON locally and summarizes the hits. No API key for the public mirrors. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'materials-science',
    homepage: 'https://github.com/dianfengxiaobo/optimade-mcp-server',
    example:
      'Search all OPTIMADE databases for ternary Li-Fe-O structures and save the first 20 matches.',
    command: 'uvx',
    args: ['optimade-mcp-server'],
  },
  {
    id: 'pubchem',
    label: 'PubChem (chemical compounds)',
    description:
      'Look up chemical compounds in PubChem by name, SMILES or CID — molecular properties, 2D/3D structures, identifiers and downloadable SDF/MOL/XYZ files. Useful when a materials or chemistry task needs molecular reference data or a starting geometry. No API key required. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'materials-science',
    homepage: 'https://github.com/JackKuo666/PubChem-MCP-Server',
    example:
      'Get the SMILES, molecular weight and 3D XYZ geometry for lithium hexafluorophosphate.',
    command: 'uvx',
    args: ['pubchem-mcp-server'],
  },
  {
    id: 'gpaw-computation',
    label: 'GPAW (DFT calculations)',
    description:
      'Run density-functional-theory (DFT) calculations through the GPAW package directly from chat — relaxations, energies and electronic-structure properties on small systems. Best paired with a structure pulled from Materials Project / OPTIMADE. Compute-heavy jobs run locally, so keep systems small. Needs the `uvx` Python launcher and a working GPAW toolchain.',
    transport: 'stdio',
    category: 'materials-science',
    homepage: 'https://github.com/pathintegral-institute/mcp.science/tree/main/servers/gpaw-computation',
    example:
      'Relax this 8-atom silicon cell with GPAW and report the total energy and final lattice parameters.',
    command: 'uvx',
    args: ['mcp-science', 'gpaw-computation'],
  },

  // ── research-literature ─────────────────────────────────────────────
  {
    id: 'arxiv',
    label: 'arXiv (search + read papers)',
    description:
      'Search arXiv and pull full paper content into the conversation through a simple MCP interface — search by topic / author / date, then fetch and read the text of a specific paper. The literature workhorse for a research task. No API key required. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'research-literature',
    homepage: 'https://github.com/blazickjp/arxiv-mcp-server',
    example:
      'Find the 5 most-cited recent arXiv papers on machine-learning interatomic potentials and summarize their methods.',
    command: 'uvx',
    args: ['arxiv-mcp-server'],
  },
  {
    id: 'paper-search',
    label: 'Paper Search (multi-source)',
    description:
      'Search and download academic papers across arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, OpenAlex, CrossRef and more — a free-first multi-source connector that deduplicates results and falls back across open-access links. Broader coverage than arXiv alone when a task spans several fields. No API key required for the open sources. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'research-literature',
    homepage: 'https://github.com/openags/paper-search-mcp',
    example:
      'Search across arXiv, Semantic Scholar and OpenAlex for "solid-state electrolyte interphase" and download the top open-access PDFs.',
    command: 'uvx',
    args: ['paper-search-mcp'],
  },
  {
    id: 'web-fetch',
    label: 'Web Fetch (HTML / PDF → text)',
    description:
      'Fetch and process HTML, PDF and plain-text content from any URL so the agent can quote or summarize it — handy for reading a paper landing page, a database record, a docs page or a supplementary PDF that the other connectors do not cover. Runs via the Path Integral `mcp-science` launcher. No API key required. Needs the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'research-literature',
    homepage: 'https://github.com/pathintegral-institute/mcp.science/tree/main/servers/web-fetch',
    example:
      'Fetch this PDF supplementary file and extract the reported synthesis temperatures into a table.',
    command: 'uvx',
    args: ['mcp-science', 'web-fetch'],
  },

  // ── data-viz ────────────────────────────────────────────────────────
  {
    id: 'antv-chart',
    label: 'AntV Chart',
    description:
      'AntV-powered chart generator covering 26+ chart types: bar, line, pie, area, dual-axes, sankey, treemap, word cloud, district / pin / path maps, fishbone diagrams and more. Use whenever a design artifact needs a real chart instead of a sketched placeholder.',
    transport: 'stdio',
    category: 'data-viz',
    homepage: 'https://github.com/antvis/mcp-server-chart',
    example:
      'Plot monthly active users for the last 12 months as a smooth line chart with markers.',
    command: 'npx',
    args: ['-y', '@antv/mcp-server-chart'],
  },
  {
    id: 'mermaid',
    label: 'Mermaid diagrams',
    description:
      'Render Mermaid (flowchart, sequence, class, state, gantt, ER…) diagrams to PNG / SVG via Puppeteer. Natural extension of the markdown rendering in chat — gives the agent a way to materialize architecture / process diagrams as proper image artifacts.',
    transport: 'stdio',
    category: 'data-viz',
    homepage: 'https://github.com/peng-shawn/mermaid-mcp-server',
    example:
      'Render a sequence diagram of: user → web → daemon → SQLite for the "save artifact" flow.',
    command: 'npx',
    args: ['-y', '@peng-shawn/mermaid-mcp-server'],
  },
  {
    id: 'mcp-dashboards',
    label: 'MCP Dashboards (45+ chart types)',
    description:
      'Renders 45+ interactive chart types as HTML directly in chat: bar, line, pie, candlestick, sankey, geo maps, radar, funnel, treemap and more — plus full KPI dashboards with drill-down, live API polling, 20 themes, and export to PNG / PPT / A4. Goes wider than AntV for "dashboard"-shaped artifacts; use it when a static chart is not enough.',
    transport: 'stdio',
    category: 'data-viz',
    homepage: 'https://github.com/KyuRish/mcp-dashboards',
    example:
      'Build a 4-card KPI dashboard with monthly revenue, churn, MAU, and a sankey of acquisition funnels — export it as PNG.',
    command: 'npx',
    args: ['-y', 'mcp-dashboards', '--stdio'],
  },
  {
    id: 'excalidraw-architect',
    label: 'Excalidraw Architect (hand-drawn diagrams)',
    description:
      'Hand-drawn-style architecture diagrams via Excalidraw + a Sugiyama auto-layout engine — no overlapping boxes, no tangled arrows. Built-in styling for 50+ technologies (Kafka, Postgres, Redis, S3, Lambda, K8s…). Iterate with natural language ("add a cache in front of the DB"), then export to SVG / PNG. Different aesthetic from Mermaid: warmer, less "generated". Requires the `uvx` Python launcher.',
    transport: 'stdio',
    category: 'data-viz',
    homepage: 'https://github.com/BV-Venky/excalidraw-architect-mcp',
    example:
      'Create a high-level diagram of a microservices e-commerce backend: API Gateway, Auth, Users, Orders, Postgres, Redis, Kafka.',
    command: 'uvx',
    args: ['excalidraw-architect-mcp'],
  },

  // ── publishing ──────────────────────────────────────────────────────
  {
    id: 'edgeone-pages',
    label: 'EdgeOne Pages (publish HTML)',
    description:
      'Deploy raw HTML to Tencent EdgeOne Pages and get back a public URL. Lets the agent ship a generated landing page or design preview as a shareable link in one tool call — no account or token needed for the basic deploy_html flow. Provide an EDGEONE_PAGES_API_TOKEN if you want deploy_folder / project-update tools as well.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://github.com/TencentEdgeOne/edgeone-pages-mcp',
    example:
      'Deploy this HTML page to EdgeOne Pages and reply with the public URL.',
    command: 'npx',
    args: ['-y', 'edgeone-pages-mcp@latest'],
    envFields: [
      {
        key: 'EDGEONE_PAGES_API_TOKEN',
        label: 'API token (optional, enables folder deploys)',
        placeholder: 'EdgeOne Pages API token',
        secret: true,
      },
      {
        key: 'EDGEONE_PAGES_PROJECT_NAME',
        label: 'Project name (optional, updates an existing project)',
        placeholder: 'my-existing-project',
      },
    ],
  },
  {
    id: 'pagedrop',
    label: 'PageDrop (instant HTML hosting)',
    description:
      'Deploy raw HTML, Markdown, PDF or a ZIP archive to a permanent public URL — no signup, no key, no account. Complements EdgeOne Pages for users who want a true zero-friction publish path. Optional password protection, custom slug, OG tags and TTL.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://pagedrop.dev/',
    example:
      'Deploy this HTML to PageDrop with the slug "demo-2026" and reply with the public URL.',
    command: 'npx',
    args: ['-y', 'pagedrop-mcp'],
  },
  {
    id: 'pdfspark',
    label: 'PDFSpark (HTML / URL → PDF)',
    description:
      'Free HTML-to-PDF and URL-to-PDF conversion via Playwright — no signup, no key. Supports merging, splitting, page formatting (A4 / Letter / margins / orientation), watermarks, headers, footers, AES-256 encryption and metadata. Pairs naturally with the publishing flow when the agent needs a downloadable PDF version of a generated page.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://pdfspark.dev/',
    example:
      'Convert https://example.com/blog-post to an A4 PDF with 18mm margins and add a "DRAFT" watermark.',
    command: 'npx',
    args: ['-y', 'pdfspark-api'],
  },
  {
    id: 'ogforge',
    label: 'OGForge (Open Graph image generator)',
    description:
      'Free, no-signup MCP for generating Open Graph / share-card images. 6 built-in themes (dark, light, gradient, cyberpunk, minimal, bold), all 1,668 Lucide icons, multiple output formats (PNG / WebP / JPEG / SVG), sizes from 200px to 2400px. The "share-preview image" lane in your publishing pipeline.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://ogforge.dev/',
    example:
      'Generate a 1200×630 dark-theme OG image titled "MatOS 1.0" with a subtitle "Design with agents", with a Lucide "sparkles" icon.',
    command: 'npx',
    args: ['-y', 'ogforge-api'],
  },
  {
    id: 'qrmint',
    label: 'QRMint (styled QR codes)',
    description:
      'Free, no-signup MCP for styled QR codes: custom colors, embedded logos, frames, batch generation. Drop on a poster, a slide, a print bundle, a packaging mockup — wherever a flat-black QR would look out of place.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://qrmcp.dev/',
    example:
      'Generate a brand-orange (#FF5722) QR code pointing to https://opendesign.app, with our logo at /absolute/path/to/logo.png embedded in the center.',
    command: 'npx',
    args: ['-y', 'qr-mcp'],
  },
  {
    id: 'slideshot',
    label: 'Slideshot (HTML → PDF / PNG / WebP / PPTX)',
    description:
      'Convert AI-generated HTML carousels into high-resolution PNG / WebP / PDF / PPTX. 7 built-in themes (generic, branded, instagram-carousel, infographic, pitch-deck, dark-modern, editorial). Killer companion for "design a slide deck" or "build an Instagram carousel" workflows — and the rendered output is real Puppeteer pixels, not a screenshot.',
    transport: 'stdio',
    category: 'publishing',
    homepage: 'https://github.com/06ketan/slideshot',
    example:
      'Generate a 6-slide pitch-deck about "AI-native design tools" and render it as both PDF and 4× PNG.',
    command: 'npx',
    args: ['-y', 'slideshot-mcp'],
  },
  {
    id: 'deckrun',
    label: 'Deckrun (Markdown → PDF / video / audio)',
    description:
      'Hosted MCP that converts Deckrun Markdown into pixel-perfect branded PDFs, narrated MP4 videos, and MP3 audio from one source. The free tier exposes `get_slide_format` + `generate_slide_deck` (PDF) with no API key required and no signup — just connect and go. Add a paid `DECKRUN_API_KEY` later for video / audio generation, themes, voices and async jobs.',
    transport: 'http',
    authMode: 'none',
    category: 'publishing',
    homepage: 'https://agenticdecks.com',
    example:
      'Create a 6-slide deck about the future of edge computing as a branded PDF, then reply with the public URL.',
    url: 'https://deckrun-mcp-free.agenticdecks.com/mcp/',
    headerFields: [
      {
        key: 'Authorization',
        label: 'Authorization (override, e.g. paid tier Bearer token)',
        placeholder: 'Bearer dk_live_…  ← only needed for the paid tier',
        secret: true,
      },
    ],
  },

  // ── utilities ───────────────────────────────────────────────────────
  {
    id: 'filesystem',
    label: 'Filesystem',
    description:
      'Read, write and list files in a sandboxed directory. Useful for letting the agent operate on a folder outside your MatOS project.',
    transport: 'stdio',
    category: 'utilities',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    example:
      'List the markdown files under the allowed directory and tell me what each one is about.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<allowed-dir>'],
  },
  {
    id: 'github',
    label: 'GitHub',
    description:
      'Read repos, issues, PRs and write back via the GitHub API. Requires a personal access token with the scopes you want the agent to use.',
    transport: 'stdio',
    category: 'utilities',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    example:
      'Show me the 5 most recent open issues labeled "bug" in modelcontextprotocol/servers.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envFields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        required: true,
        placeholder: 'ghp_…',
        secret: true,
      },
    ],
  },
  {
    id: 'fetch',
    label: 'Fetch (HTTP)',
    description:
      'Lets the agent fetch arbitrary URLs and convert HTML to markdown. Read-only.',
    transport: 'stdio',
    category: 'utilities',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    example:
      'Fetch https://news.ycombinator.com and summarize the top front-page stories.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  {
    id: 'a11y',
    label: 'A11y (Web accessibility / WCAG)',
    description:
      'Web accessibility testing via Deque axe-core + Puppeteer: test any URL or HTML snippet against WCAG 2.0 / 2.1 / 2.2 (A / AA / AAA), check color-contrast pairs, validate ARIA usage and detect orientation lock. Closes the craft loop — agent renders an artifact, captures it, runs an a11y check, then fixes what fails.',
    transport: 'stdio',
    category: 'utilities',
    homepage: 'https://github.com/ronantakizawa/a11ymcp',
    example:
      'Test https://stripe.com against WCAG 2.1 AA at a 1280×800 viewport and list every violation grouped by impact.',
    command: 'npx',
    args: ['-y', 'a11y-mcp-server'],
  },
];
