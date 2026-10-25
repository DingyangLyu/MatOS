// MatOS asset registry bridge.
//
// The MatOS product UI maps native MatOS assets — knowledges, tools (incl.
// MCP servers), skills, roles, and workflows — onto an Assets workbench.
// This module is a thin transport adapter over the `matos` CLI JSON
// surfaces: listing/show go through `matos assets ... --json`, entry-file
// edits are written into the asset's Gitea-backed source checkout, and all
// git governance actions (validate / commit / accepted-ref advance) shell
// out to `matos assets validate|git ... --json`. No asset business logic
// lives here, and mutations never touch Gitea directly.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import multer from 'multer';
import type { Express, Request, Response } from 'express';
import { parse as parseYaml } from 'yaml';
import type { MatOSWorkflowPreview } from '@open-design/contracts';
import {
  MATOS_BIN,
  execMatOSJson,
  execMatOSJsonReport,
  isRecord,
  matosCliEnv,
  matosCwd,
  parseMatOSJson,
  stringOrNull,
} from '../services/matos-cli.js';
import { sendJsonMaybeGzip } from '../http/json-gzip.js';
import { isHiddenMatOSRoleId } from '../runtimes/defs/matos.js';
import { matosProjectScope } from '../services/matos-project-scope.js';
import { registerMatOSAssetArchiveRoutes } from './matos-asset-archive.js';

// Publishing materializes a whole source checkout, so serialize editor writes
// and publications in this daemon's user scope, not only by individual file.
const assetMutations = new Map<string, Promise<unknown>>();
async function serializeAssetMutation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = assetMutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  assetMutations.set(key, next);
  try {
    return await next;
  } finally {
    if (assetMutations.get(key) === next) assetMutations.delete(key);
  }
}

// Entry/manifest files the editor may read or write. Everything else in an
// asset directory (datasets, binaries, caches) stays out of the bridge.
const EDITABLE_FILE_NAMES = new Set([
  'asset.json',
  'SKILL.md',
  'ROLE.md',
  'KNOWLEDGE.md',
  'TOOL.md',
  'DATA.md',
  'README.md',
  'workflow.json',
  'workflow.yaml',
  'suite.json',
  'tool.json',
  'mcp.json',
  'matos.contribution.json',
]);
const EDITABLE_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);
const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

export type MatOSBridgeAssetType =
  | 'knowledge'
  | 'data'
  | 'tool'
  | 'mcp'
  | 'skill'
  | 'role'
  | 'workflow'
  | 'benchmark'
  | 'benchmark-suite'
  | 'evaluation'
  | 'runtime';

// Every product-facing registry type is bridged, including the lab-flavored
// ones (instrument drivers/SOPs live as tagged tool/workflow/knowledge
// assets; benchmarks/evaluations/runtimes are types of their own). The two
// internal provenance types stay out on purpose: `experience` is the legacy
// self-evolution evidence layer and `evolution-proposal` is an internal
// pipeline artifact — neither is a user-editable product asset.
export const MATOS_BRIDGE_ASSET_TYPES: MatOSBridgeAssetType[] = [
  'knowledge',
  'data',
  'tool',
  'mcp',
  'skill',
  'role',
  'workflow',
  'benchmark',
  'benchmark-suite',
  'evaluation',
  'runtime',
];

// Families staged out of the user-facing catalog for now (product decision:
// benchmarks/evaluations and runtimes are not released to end users yet).
// They stay bridgeable through an explicit `?types=` request so internal
// and admin surfaces can still reach them, but the default listing — what
// the Assets workbench, Home gallery, and relationship map consume — skips
// them.
export const MATOS_BRIDGE_STAGED_ASSET_TYPES: MatOSBridgeAssetType[] = [
  'benchmark',
  'benchmark-suite',
  'evaluation',
  'runtime',
];

export const MATOS_BRIDGE_DEFAULT_ASSET_TYPES: MatOSBridgeAssetType[] =
  MATOS_BRIDGE_ASSET_TYPES.filter(
    (type) => !MATOS_BRIDGE_STAGED_ASSET_TYPES.includes(type),
  );

/**
 * The CLI redacts the working directory as `<workspace>` in JSON output;
 * expand it back so the daemon (which shares the filesystem with the CLI)
 * can read/write entry files.
 */
export function expandWorkspacePath(value: string | undefined, cwd: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('<workspace>')) {
    return path.join(cwd, value.slice('<workspace>'.length));
  }
  return value;
}

/**
 * Role-level runtime overrides from the role asset manifest's `runtime`
 * block (written by `matos roles runtime set`). These flow into the role's
 * runtime composition (`agent.model` / `agent.effort` / …), so surfacing
 * them here lets the workbench read AND edit the same source of truth the
 * `matos --role` launch path consumes.
 */
export interface MatOSRoleRuntimeSettings {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
}

export function normalizeRoleRuntimeSettings(raw: unknown): MatOSRoleRuntimeSettings | null {
  if (!isRecord(raw)) return null;
  const effortRaw = raw.effort;
  const effort =
    typeof effortRaw === 'string' && effortRaw.trim()
      ? effortRaw.trim()
      : typeof effortRaw === 'number'
        ? String(effortRaw)
        : null;
  const maxTurns =
    typeof raw.maxTurns === 'number' && Number.isInteger(raw.maxTurns) && raw.maxTurns > 0
      ? raw.maxTurns
      : null;
  const settings: MatOSRoleRuntimeSettings = {
    model: stringOrNull(raw.model),
    effort,
    permissionMode: stringOrNull(raw.permissionMode),
    maxTurns,
  };
  const empty =
    settings.model === null &&
    settings.effort === null &&
    settings.permissionMode === null &&
    settings.maxTurns === null;
  return empty ? null : settings;
}

export interface MatOSBridgeAssetSummary {
  ref: string;
  canonicalKey: string | null;
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
  runtime: MatOSRoleRuntimeSettings | null;
  git: {
    sourceId: string | null;
    scope: string | null;
    webUrl: string | null;
  };
  boundary: MatOSBridgeAssetBoundary;
}

export interface MatOSBridgeAssetBoundary {
  visibility: 'public' | 'private' | 'collaborative';
  owner: 'matos' | 'current-scope' | 'project';
  editable: boolean;
  sharedCopy: boolean;
  selfEvolved: boolean;
  evolutionRuns: number;
  latestEvolutionAt: string | null;
}

export interface MatOSAssetEvolutionSummary {
  runCount: number;
  latestAt: string | null;
}

export type MatOSAssetEvolutionIndex = ReadonlyMap<string, MatOSAssetEvolutionSummary>;

function versionlessAssetRef(value: string): string | null {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0) return null;
  const version = trimmed.lastIndexOf('@');
  return version > separator ? trimmed.slice(0, version) : trimmed;
}

/** Build the user-facing self-evolution index from accepted direct-editor
 * records only. Rolled-back, pending, failed, and merely validated edits must
 * never make an asset look evolved in the product UI. */
export function indexAcceptedAssetEvolutionRuns(
  records: unknown[],
): Map<string, MatOSAssetEvolutionSummary> {
  const result = new Map<string, MatOSAssetEvolutionSummary>();
  for (const raw of records) {
    if (!isRecord(raw) || !['accepted', 'accepted_merged'].includes(String(raw.status ?? ''))) {
      continue;
    }
    const refs = [
      ...(Array.isArray(raw.createdAssets) ? raw.createdAssets : []),
      ...(Array.isArray(raw.updatedAssets) ? raw.updatedAssets : []),
    ]
      .filter((value): value is string => typeof value === 'string')
      .map(versionlessAssetRef)
      .filter((value): value is string => value !== null);
    const at = stringOrNull(raw.updatedAt) ?? stringOrNull(raw.createdAt);
    for (const ref of new Set(refs)) {
      const previous = result.get(ref);
      result.set(ref, {
        runCount: (previous?.runCount ?? 0) + 1,
        latestAt:
          at && (!previous?.latestAt || at > previous.latestAt)
            ? at
            : previous?.latestAt ?? null,
      });
    }
  }
  return result;
}

function assetBoundary(
  raw: Record<string, unknown>,
  ref: string,
  tags: string[],
  options: { scopeRef?: string; evolution?: MatOSAssetEvolutionIndex },
): MatOSBridgeAssetBoundary {
  const scopeRef = options.scopeRef ?? currentDaemonScopeRef();
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const provenance = metadata && isRecord(metadata.sourceProvenance)
    ? metadata.sourceProvenance
    : undefined;
  const sourceScope = provenance ? stringOrNull(provenance.scope) : null;
  const sourceScopeRef = provenance ? stringOrNull(provenance.scopeRef) : null;
  // Gitea-backed user assets are surfaced by the registry's project source
  // adapter too, so `raw.source === "project"` alone does not mean that the
  // asset is project-shared. Explicit source provenance is authoritative;
  // only provenance-less project-local records fall back to `raw.source`.
  const projectLocal = !sourceScope && stringOrNull(raw.source) === 'project';
  const published = Boolean(sourceScope && ['core', 'shared', 'global'].includes(sourceScope));
  const currentOwned = Boolean(
    sourceScope &&
    sourceScopeRef &&
    scopeRef &&
    ['user', 'team', 'project'].includes(sourceScope) &&
    sourceScopeRef === scopeRef,
  );
  const visibility: MatOSBridgeAssetBoundary['visibility'] = projectLocal || ['team', 'project'].includes(sourceScope ?? '')
    ? 'collaborative'
    : sourceScope === 'user'
      ? 'private'
      : 'public';
  const owner: MatOSBridgeAssetBoundary['owner'] = projectLocal
    ? 'project'
    : currentOwned
      ? 'current-scope'
      : 'matos';
  const sharedCopy =
    owner === 'current-scope' &&
    tags.includes('forked') &&
    tags.includes('project-share');
  const evolution = owner === 'matos' ? undefined : options.evolution?.get(ref);
  const editable = authorizeMatOSAssetMutation(raw, scopeRef).ok;
  return {
    visibility: published ? 'public' : visibility,
    owner,
    editable,
    sharedCopy,
    selfEvolved: Boolean(evolution && evolution.runCount > 0),
    evolutionRuns: evolution?.runCount ?? 0,
    latestEvolutionAt: evolution?.latestAt ?? null,
  };
}

export function normalizeAssetRecord(
  raw: unknown,
  options: { scopeRef?: string; evolution?: MatOSAssetEvolutionIndex } = {},
): MatOSBridgeAssetSummary | null {
  if (!isRecord(raw)) return null;
  const id = stringOrNull(raw.id);
  const type = stringOrNull(raw.type);
  if (!id || !type) return null;
  const canonicalKey = stringOrNull(raw.canonicalKey);
  const provenance = isRecord(raw.metadata) && isRecord(raw.metadata.sourceProvenance)
    ? raw.metadata.sourceProvenance
    : undefined;
  const gitea = provenance && isRecord(provenance.gitea) ? provenance.gitea : undefined;
  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : undefined;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const ref = `${type}:${id}`;
  return {
    ref,
    canonicalKey,
    id,
    type,
    source: stringOrNull(raw.source),
    name: stringOrNull(raw.name) ?? id,
    version: stringOrNull(raw.version),
    description: stringOrNull(raw.description),
    tags,
    packId: stringOrNull(raw.packId),
    entry: stringOrNull(raw.entry),
    status: lifecycle ? stringOrNull(lifecycle.status) : null,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
    runtime: type === 'role' ? normalizeRoleRuntimeSettings(raw.runtime) : null,
    git: {
      sourceId: provenance ? stringOrNull(provenance.sourceId) : null,
      scope: provenance ? stringOrNull(provenance.scope) : null,
      webUrl: gitea ? stringOrNull(gitea.webUrl) : null,
    },
    boundary: assetBoundary(raw, ref, tags, options),
  };
}

export function isEditableAssetFileName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (EDITABLE_FILE_NAMES.has(name)) return true;
  return EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export type MatOSAssetMutationAuthorization =
  | { ok: true; sourceId: string }
  | { ok: false; reason: string };

export function matOSAssetPublishCandidateCommit(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error('matos assets git commit-source returned no result');
  }
  const commit = stringOrNull(value.commit)?.trim().toLowerCase();
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error('matos assets git commit-source returned no candidate commit');
  }
  return commit;
}

function currentDaemonScopeRef(): string {
  return (
    process.env.MATOS_SCOPE_REF?.trim() ||
    process.env.MATOS_SCOPE_ID?.trim() ||
    ''
  );
}

/** Scope metadata is the primary UI mutation boundary; Gitea PAT permissions
 * remain the remote enforcement boundary. */
export function authorizeMatOSAssetMutation(
  record: Record<string, unknown>,
  scopeRef = currentDaemonScopeRef(),
): MatOSAssetMutationAuthorization {
  const separator = scopeRef.indexOf(':');
  const scope = separator > 0 ? scopeRef.slice(0, separator) : '';
  if (!scopeRef || !['user', 'team', 'project'].includes(scope)) {
    return { ok: false, reason: 'this daemon has no writable scoped identity' };
  }
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const provenance = metadata && isRecord(metadata.sourceProvenance)
    ? metadata.sourceProvenance
    : undefined;
  const sourceId = provenance ? stringOrNull(provenance.sourceId) : null;
  const sourceScope = provenance ? stringOrNull(provenance.scope) : null;
  const sourceScopeRef = provenance ? stringOrNull(provenance.scopeRef) : null;
  if (!sourceId || sourceScope !== scope || sourceScopeRef !== scopeRef) {
    return {
      ok: false,
      reason: `asset source is not owned by ${scopeRef}`,
    };
  }
  return { ok: true, sourceId };
}

export function authorizeMatOSAssetRead(
  record: Record<string, unknown>,
  scopeRef = currentDaemonScopeRef(),
  bundledRoot = process.env.MATOS_BUNDLED_ASSET_ROOT,
): { ok: true } | { ok: false; reason: string } {
  // Project-local assets (Data Center pins, `assets register-data` output,
  // draft packs) live below .matos/ in the daemon's own MatOS workspace and
  // carry no Gitea source provenance; the daemon owns that workspace.
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const provenance = metadata && isRecord(metadata.sourceProvenance)
    ? metadata.sourceProvenance
    : undefined;
  // Installed public packs have no remote-source provenance. Authorize their
  // canonical files only beneath the operator-selected bundle root; explicit
  // foreign provenance always retains the normal scope boundary below.
  if (record.source === 'pack' && !metadata?.sourceProvenance && bundledRoot && typeof record.absolutePath === 'string') {
    try {
      const root = fs.realpathSync(bundledRoot);
      const relative = path.relative(root, fs.realpathSync(record.absolutePath));
      if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return { ok: true };
    } catch { /* Missing or inaccessible bundles stay unreadable. */ }
  }
  if (stringOrNull(record.source) === 'project' && !metadata?.sourceProvenance) {
    return { ok: true };
  }
  const sourceScope = provenance ? stringOrNull(provenance.scope) : null;
  const sourceScopeRef = provenance ? stringOrNull(provenance.scopeRef) : null;
  if (sourceScope && ['core', 'shared', 'global'].includes(sourceScope)) {
    return { ok: true };
  }
  if (
    scopeRef &&
    sourceScope &&
    ['user', 'team', 'project'].includes(sourceScope) &&
    sourceScopeRef === scopeRef
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `asset source is not readable by ${scopeRef || 'this daemon'}`,
  };
}

/**
 * Contribution preflight findings are already workspace-relative and
 * secret-free on the CLI side; pass through only the display fields the
 * browser renders, with a hard cap so a pathological result cannot flood
 * the UI payload.
 */

/**
 * A local contribution record is user-owned state, but keep the bridge shape
 * explicit: no branch names, evidence paths, or staging paths — only what the
 * "my contributions" panel renders.
 */

/**
 * The native CLI result also carries local source-cache and staging paths for
 * operator automation. The browser only needs the public contribution state;
 * keep host/container internals behind the daemon boundary.
 */

async function assertMatOSAssetMutationPath(
  assetDir: string,
  cwd = matosCwd(),
): Promise<void> {
  const [realCwd, realAssetDir] = await Promise.all([
    realpath(cwd).catch(() => path.resolve(cwd)),
    realpath(assetDir).catch(() => path.resolve(assetDir)),
  ]);
  const rel = path.relative(realCwd, realAssetDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('asset source checkout is outside the scoped workspace');
  }
}

async function listEditableFiles(assetDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(assetDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isEditableAssetFileName(entry.name)) continue;
    try {
      const stats = await stat(path.join(assetDir, entry.name));
      if (stats.size <= MAX_EDITABLE_FILE_BYTES) out.push(entry.name);
    } catch {
      // Skip unreadable entries.
    }
  }
  return out.sort();
}

/**
 * Whether a registry row is a user-selectable conversation role: type `role`,
 * lifecycle enabled (absent lifecycle counts as enabled, matching the
 * workbench listing), and not one of the hidden internal/admin worker roles.
 */
export function selectableMatOSConversationRole(asset: MatOSBridgeAssetSummary): boolean {
  if (asset.type !== 'role') return false;
  if (asset.status !== null && asset.status !== 'enabled') return false;
  return !isHiddenMatOSRoleId(asset.id);
}

export function isMatOSBridgeAssetRef(value: string): boolean {
  return /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*(@[A-Za-z0-9.+-]+)?$/.test(value);
}

/**
 * Internal preflight "smoke" assets exist so roles/workflows can run a
 * lightweight real domain check before drafting execution claims. They are
 * dependency-wired but not user-facing catalog items, so the Home showcase and
 * workbench list hide them (id suffix `-smoke` or an explicit `smoke` tag).
 */
export function isSmokeCatalogAsset(asset: MatOSBridgeAssetSummary): boolean {
  const id = asset.id.toLowerCase();
  if (id.endsWith('-smoke') || id.endsWith('/smoke') || id === 'smoke') return true;
  return Array.isArray(asset.tags) && asset.tags.some((tag) => tag.toLowerCase() === 'smoke');
}

// UI-boundary validation for role runtime edits. The CLI itself stays
// permissive (operator surface); the bridge only forwards values the
// runtime actually understands.
const ROLE_RUNTIME_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const ROLE_RUNTIME_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

export interface MatOSRoleRuntimePatch {
  /** string = set, null = clear, undefined = leave untouched. */
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** number = set, null = clear (CLI sentinel 0), undefined = untouched. */
  maxTurns?: number | null;
}

/**
 * Validate a role runtime patch from the web UI and build the matching
 * `matos roles runtime set` argv. Returns an error string for invalid input
 * and null argv when the patch is empty.
 */
export function buildRoleRuntimeSetArgs(
  roleRef: string,
  patch: MatOSRoleRuntimePatch,
): { args: string[] | null; error: string | null } {
  const args: string[] = ['roles', 'runtime', 'set', roleRef];
  let touched = false;
  if (patch.model !== undefined) {
    const model = patch.model === null ? '' : patch.model.trim();
    if (model.length > 200 || /[\r\n]/.test(model)) {
      return { args: null, error: 'model must be a single line of at most 200 characters' };
    }
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._/:@\[\]-]*$/.test(model)) {
      return { args: null, error: 'model contains unsupported characters' };
    }
    args.push('--model', model);
    touched = true;
  }
  if (patch.effort !== undefined) {
    const effort = patch.effort === null ? '' : patch.effort.trim();
    if (effort && !ROLE_RUNTIME_EFFORTS.has(effort)) {
      return { args: null, error: 'effort must be one of low, medium, high, max' };
    }
    args.push('--effort', effort);
    touched = true;
  }
  if (patch.permissionMode !== undefined) {
    const mode = patch.permissionMode === null ? '' : patch.permissionMode.trim();
    if (mode && !ROLE_RUNTIME_PERMISSION_MODES.has(mode)) {
      return {
        args: null,
        error: 'permissionMode must be one of default, acceptEdits, plan, bypassPermissions',
      };
    }
    args.push('--permission-mode', mode);
    touched = true;
  }
  if (patch.maxTurns !== undefined) {
    if (
      patch.maxTurns !== null &&
      (!Number.isInteger(patch.maxTurns) || patch.maxTurns < 1 || patch.maxTurns > 1000)
    ) {
      return { args: null, error: 'maxTurns must be an integer between 1 and 1000 (null clears)' };
    }
    // CLI clear sentinel for max-turns is 0.
    args.push('--max-turns', String(patch.maxTurns ?? 0));
    touched = true;
  }
  if (!touched) return { args: null, error: null };
  args.push('--json');
  return { args, error: null };
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { code: 'MATOS_ASSETS', message } });
}

// ---------------------------------------------------------------------------
// Workflow card previews — tiny DAG skeletons for the Home/catalog tiles
// ---------------------------------------------------------------------------

// Bound per-definition work and concurrent reads, not the catalog prefix:
// truncating the catalog hides complex workflows before the UI can rank them.
const WORKFLOW_PREVIEW_CONCURRENCY = 8;
const WORKFLOW_PREVIEW_MAX_NODES = 24;
const WORKFLOW_PREVIEW_MAX_FILE_BYTES = 1024 * 1024;

export type { MatOSWorkflowPreview } from '@open-design/contracts';
type MatOSWorkflowPreviewNode = MatOSWorkflowPreview['nodes'][number];

/**
 * Reduce a raw workflow definition document to the node/edge skeleton the
 * card mini-map renders: node id/type/label plus `dependsOn`-derived and
 * explicit edges, capped to the first {@link WORKFLOW_PREVIEW_MAX_NODES}
 * nodes (edges outside the kept set are dropped but still counted).
 */
export function workflowPreviewFromDocument(
  ref: string,
  raw: unknown,
): MatOSWorkflowPreview | null {
  if (!isRecord(raw)) return null;
  const rawNodes: Array<Record<string, unknown>> = Array.isArray(raw.nodes)
    ? raw.nodes.filter(isRecord)
    : isRecord(raw.nodes)
      ? Object.entries(raw.nodes).map(([id, node]) => (isRecord(node) ? { ...node, id } : { id }))
      : [];
  if (rawNodes.length === 0) return null;

  const nodes: MatOSWorkflowPreviewNode[] = rawNodes.map((node, index) => {
    const id =
      typeof node.id === 'string' && node.id.trim() ? node.id.trim() : `node_${index + 1}`;
    const label =
      typeof node.label === 'string' && node.label.trim() ? node.label.trim() : id;
    return {
      id,
      type: typeof node.type === 'string' && node.type.trim() ? node.type.trim() : 'exec',
      label,
    };
  });

  const edgeKeys = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const pushEdge = (from: unknown, to: unknown) => {
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return;
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };
  if (Array.isArray(raw.edges)) {
    for (const edge of raw.edges) {
      if (isRecord(edge)) pushEdge(edge.from, edge.to);
    }
  }
  for (const node of rawNodes) {
    const id = typeof node.id === 'string' ? node.id : null;
    if (!id || !Array.isArray(node.dependsOn)) continue;
    for (const dep of node.dependsOn) pushEdge(dep, id);
  }

  const keptNodes = nodes.slice(0, WORKFLOW_PREVIEW_MAX_NODES);
  const keptIds = new Set(keptNodes.map((node) => node.id));
  return {
    ref,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: keptNodes,
    edges: edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to)),
  };
}

// Definition files are re-read only when their mtime moves; a registry with
// ~60 workflows costs one stat per file per request, not one read+parse.
const workflowPreviewCache = new Map<
  string,
  { mtimeMs: number; preview: MatOSWorkflowPreview | null }
>();

async function loadWorkflowPreview(
  ref: string,
  definitionPath: string,
): Promise<MatOSWorkflowPreview | null> {
  let mtimeMs: number;
  try {
    const stats = await stat(definitionPath);
    if (!stats.isFile() || stats.size > WORKFLOW_PREVIEW_MAX_FILE_BYTES) return null;
    mtimeMs = stats.mtimeMs;
  } catch {
    return null;
  }
  const cached = workflowPreviewCache.get(definitionPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.preview ? { ...cached.preview, ref } : null;
  let preview: MatOSWorkflowPreview | null = null;
  try {
    const text = await readFile(definitionPath, 'utf8');
    // Most released workflow assets use a YAML entry (`workflow.yaml`); a few
    // use `workflow.json`. `yaml.parse` reads both, so parse by extension.
    const doc = /\.ya?ml$/i.test(definitionPath) ? parseYaml(text) : JSON.parse(text);
    preview = workflowPreviewFromDocument(ref, doc);
  } catch {
    preview = null;
  }
  workflowPreviewCache.set(definitionPath, { mtimeMs, preview });
  return preview;
}

// `matos assets list` walks the full registry (10s+ on a cold bun start), so
// cache the raw listing. Reads are stale-while-revalidate: once warm, an
// expired cache still answers instantly while ONE background CLI call
// refreshes it, so browsing the workbench never blocks on a registry walk.
// `--compact` keeps every structural field (dependencies/mounts/runtime/
// lifecycle + sourceProvenance) but drops the rest of the metadata blob —
// ~80% of the payload on real deployments. Mutations clear the cache.
let listCache: {
  at: number;
  payload: unknown;
  registryConfigSignature: string;
} | null = null;
let listRefreshInFlight: Promise<unknown> | null = null;
const projectListCache = new Map<string, { at: number; payload: unknown }>();
const projectListRefreshInFlight = new Map<string, Promise<unknown>>();

/** Drop cached listings after an out-of-band asset change (e.g. an approved evolution). */
export function invalidateMatOSAssetBridgeCaches(): void {
  listCache = null;
  projectListCache.clear();
  evolutionIndexCache.clear();
}
const assetRecordReadsInFlight = new Set<Promise<unknown>>();
const pendingAssetMutations = new Map<
  string,
  { sourceId: string; assetDir: string; scopeRef: string }
>();
const LIST_CACHE_TTL_MS = Number(process.env.MATOS_ASSETS_BRIDGE_CACHE_MS || 30_000);
const EVOLUTION_INDEX_MAX_RUNS = 2_048;
const evolutionIndexCache = new Map<
  string,
  { at: number; index: Map<string, MatOSAssetEvolutionSummary> }
>();
const evolutionIndexRefreshInFlight = new Map<
  string,
  Promise<Map<string, MatOSAssetEvolutionSummary>>
>();

async function readAssetEvolutionIndex(cwd: string): Promise<Map<string, MatOSAssetEvolutionSummary>> {
  const runsRoot = path.join(cwd, '.matos', 'evolution', 'direct-editor', 'runs');
  let runDirs: string[] = [];
  try {
    runDirs = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, EVOLUTION_INDEX_MAX_RUNS);
  } catch {
    return new Map();
  }
  const records: unknown[] = [];
  // Bounded parallel reads keep a large, long-lived user history from
  // serially delaying the asset catalog on networked filesystems.
  for (let offset = 0; offset < runDirs.length; offset += 32) {
    const batch = await Promise.all(
      runDirs.slice(offset, offset + 32).map(async (runId) => {
        try {
          return JSON.parse(await readFile(path.join(runsRoot, runId, 'run.json'), 'utf8')) as unknown;
        } catch {
          return null;
        }
      }),
    );
    records.push(...batch.filter((record) => record !== null));
  }
  return indexAcceptedAssetEvolutionRuns(records);
}

function refreshAssetEvolutionIndex(cwd: string): Promise<Map<string, MatOSAssetEvolutionSummary>> {
  const key = path.resolve(cwd);
  const active = evolutionIndexRefreshInFlight.get(key);
  if (active) return active;
  const refresh = readAssetEvolutionIndex(key)
    .then((index) => {
      evolutionIndexCache.set(key, { at: Date.now(), index });
      return index;
    })
    .finally(() => {
      if (evolutionIndexRefreshInFlight.get(key) === refresh) {
        evolutionIndexRefreshInFlight.delete(key);
      }
    });
  evolutionIndexRefreshInFlight.set(key, refresh);
  return refresh;
}

async function assetEvolutionIndexCached(
  cwds: string[],
  force = false,
): Promise<Map<string, MatOSAssetEvolutionSummary>> {
  const unique = [...new Set(cwds.map((cwd) => path.resolve(cwd)))];
  const indices = await Promise.all(unique.map(async (cwd) => {
    const cached = evolutionIndexCache.get(cwd);
    if (force || !cached) return refreshAssetEvolutionIndex(cwd);
    if (Date.now() - cached.at >= LIST_CACHE_TTL_MS) {
      void refreshAssetEvolutionIndex(cwd).catch(() => {});
    }
    return cached.index;
  }));
  const merged = new Map<string, MatOSAssetEvolutionSummary>();
  for (const index of indices) {
    for (const [ref, summary] of index) {
      const previous = merged.get(ref);
      merged.set(ref, {
        runCount: (previous?.runCount ?? 0) + summary.runCount,
        latestAt:
          summary.latestAt && (!previous?.latestAt || summary.latestAt > previous.latestAt)
            ? summary.latestAt
            : previous?.latestAt ?? null,
      });
    }
  }
  return merged;
}

export function matosAssetBridgeCliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    // The CLI redaction protects user-facing terminal output. This daemon is
    // the trusted scoped adapter and needs the container-visible path and
    // entry filename to read an asset; neither absolutePath nor sourcePath is
    // included in the browser response.
    MATOS_HIDE_INTERNAL_ASSET_SOURCE: '0',
    MATOS_ASSET_BRIDGE_PATHS: '1',
  };
}

export function matosAssetBridgeEditCliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...matosAssetBridgeCliEnv(env),
    // `assets validate` normally rematerializes accepted refs and cleans
    // their worktrees. The editor has just written an uncommitted candidate
    // into that checkout, so its trusted validation subprocess must inspect
    // (and preserve) the candidate instead. This flag is never inherited by
    // normal role/run/runtime materialization.
    MATOS_ASSET_SOURCE_PRESERVE_DIRTY: '1',
  };
}

export function matosAssetBridgeReadCliEnv(
  preservePendingEdits: boolean,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return preservePendingEdits
    ? matosAssetBridgeEditCliEnv(env)
    : matosAssetBridgeCliEnv(env);
}

function currentMatOSAssetBridgeReadCliEnv(): NodeJS.ProcessEnv {
  return matosAssetBridgeReadCliEnv(pendingAssetMutations.size > 0);
}

async function resolveAssetRecord(ref: string): Promise<Record<string, unknown>> {
  const read = execMatOSJson(
    ['assets', 'show', ref, '--json'],
    { env: currentMatOSAssetBridgeReadCliEnv() },
  );
  assetRecordReadsInFlight.add(read);
  try {
    const payload = await read;
    if (!isRecord(payload) || !isRecord(payload.asset)) {
      throw new Error(`matos assets show ${ref} returned no asset`);
    }
    return payload.asset;
  } finally {
    assetRecordReadsInFlight.delete(read);
  }
}

async function waitForAssetBridgeReads(): Promise<void> {
  const reads = [
    ...(listRefreshInFlight ? [listRefreshInFlight] : []),
    ...projectListRefreshInFlight.values(),
    ...assetRecordReadsInFlight,
  ];
  if (reads.length > 0) await Promise.allSettled(reads);
}

async function registryConfigSignature(cwd = matosCwd()): Promise<string> {
  try {
    const config = await readFile(path.join(cwd, '.matos', 'matos.json'));
    return createHash('sha256').update(config).digest('hex');
  } catch {
    // Missing/unreadable is itself a stable state. If provisioning or an
    // invitation later creates the config, its content hash differs and the
    // listing cache is invalidated immediately.
    return 'unavailable';
  }
}

function refreshListCache(signature?: string): Promise<unknown> {
  if (listRefreshInFlight) return listRefreshInFlight;
  listRefreshInFlight = (signature === undefined
    ? registryConfigSignature()
    : Promise.resolve(signature))
    .then(async (resolvedSignature) => {
      const payload = await execMatOSJson(
        ['assets', 'list', '--json', '--compact'],
        { env: currentMatOSAssetBridgeReadCliEnv() },
      );
      listCache = {
        at: Date.now(),
        payload,
        registryConfigSignature: resolvedSignature,
      };
      return payload;
    })
    .finally(() => {
      listRefreshInFlight = null;
    });
  return listRefreshInFlight;
}

async function listAssetsCached(force = false): Promise<unknown> {
  const signature = await registryConfigSignature();
  if (force || !listCache || listCache.registryConfigSignature !== signature) {
    const payload = await refreshListCache(signature);
    // A previous single-flight refresh may have started just before the
    // accepted config changed. Do not return that older registry snapshot to
    // the import recipient; follow it with one refresh for the new signature.
    if (listCache?.registryConfigSignature !== signature) {
      return refreshListCache(signature);
    }
    return payload;
  }
  if (Date.now() - listCache.at >= LIST_CACHE_TTL_MS) {
    // Serve stale immediately; refresh in the background (errors surface on
    // the next forced/cold read instead of failing this request).
    void refreshListCache().catch(() => {});
  }
  return listCache.payload;
}

function listProjectAssetsCached(cwd: string, force = false): Promise<unknown> {
  const key = path.resolve(cwd);
  const cached = projectListCache.get(key);
  if (!force && cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
    return Promise.resolve(cached.payload);
  }
  const active = projectListRefreshInFlight.get(key);
  if (active) return active;
  const refresh = execMatOSJson(
    ['assets', 'list', '--json', '--compact'],
    { cwd: key, env: currentMatOSAssetBridgeReadCliEnv() },
  )
    .then((payload) => {
      projectListCache.set(key, { at: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      if (projectListRefreshInFlight.get(key) === refresh) {
        projectListRefreshInFlight.delete(key);
      }
    });
  projectListRefreshInFlight.set(key, refresh);
  return refresh;
}

/**
 * A project directory is an independent MatOS registry root. That is useful
 * for project-local assets, but it also means a plain `assets list` from the
 * project can omit the current user's accepted private source (for example
 * when the project opts out of default roots). The project picker needs both
 * views: project/public assets from the project and private assets owned by
 * this daemon's user scope.
 *
 * Keep project-local assets authoritative on an exact canonical collision;
 * otherwise the user's scoped copy replaces a public copy of the same asset.
 * Only server-classified current-scope private rows are admitted, so this
 * merge cannot expose another user's source merely because it appeared in a
 * broader registry listing.
 */
export function mergeProjectAndCurrentScopeAssets(
  projectAssets: MatOSBridgeAssetSummary[],
  scopedAssets: MatOSBridgeAssetSummary[],
): MatOSBridgeAssetSummary[] {
  const merged = new Map<string, MatOSBridgeAssetSummary>();
  const identity = (asset: MatOSBridgeAssetSummary) =>
    asset.canonicalKey ?? `${asset.ref}@${asset.version ?? ''}`;

  for (const asset of projectAssets) {
    merged.set(identity(asset), asset);
  }
  for (const asset of scopedAssets) {
    if (
      asset.boundary.visibility !== 'private' ||
      asset.boundary.owner !== 'current-scope'
    ) {
      continue;
    }
    const key = identity(asset);
    const existing = merged.get(key);
    if (existing?.boundary.owner === 'project') {
      continue;
    }
    merged.set(key, asset);
  }
  return [...merged.values()];
}

/**
 * Version-agnostic `role:<id>` -> catalog display name index, from the same
 * cached registry listing the `/api/matos/roles` picker serves. The group
 * chat dispatcher uses it so daemon-side mention/handoff parsing recognizes
 * the same member names the web roster header showed (project alias first,
 * then this catalog name, then the bare id). Failures degrade to an empty
 * index — parsing still matches aliases, refs, and bare role ids.
 */
export async function matosRoleDisplayNames(): Promise<Map<string, string>> {
  try {
    const payload = await listAssetsCached();
    const rows = isRecord(payload) && Array.isArray(payload.assets) ? payload.assets : [];
    const names = new Map<string, string>();
    for (const row of rows) {
      const asset = normalizeAssetRecord(row);
      if (!asset || asset.type !== 'role') continue;
      names.set(`role:${asset.id}`, asset.name);
    }
    return names;
  } catch {
    return new Map();
  }
}

const INTAKE_FOLDER_UPLOAD_MAX_FILES = 5_000;
const INTAKE_UPLOAD_MAX_FILE_BYTES = 512 * 1024 * 1024;

type IntakeFolderUploadRequest = Request & {
  _matosIntakeUploadRoot?: string;
  _matosIntakeRelativePaths?: string[];
  _matosIntakeUploadIndex?: number;
};

function normalizeIntakeUploadRelativePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('every uploaded file requires a relative path');
  const normalized = value.normalize('NFC').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('uploaded file paths must be relative');
  }
  const parts = normalized.split('/');
  if (
    parts.length > 64 ||
    parts.some((part) =>
      !part ||
      part === '.' ||
      part === '..' ||
      /[\u0000-\u001f\u007f]/.test(part) ||
      Buffer.byteLength(part, 'utf8') > 255
    )
  ) {
    throw new Error(`unsafe uploaded file path: ${normalized.slice(0, 160)}`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > 4_096) {
    throw new Error('uploaded file path is too long');
  }
  return parts.join('/');
}

function intakeFolderRelativePaths(req: IntakeFolderUploadRequest): string[] {
  if (req._matosIntakeRelativePaths) return req._matosIntakeRelativePaths;
  const raw = req.body?.relativePaths;
  if (typeof raw !== 'string') throw new Error('relativePaths must be sent before file parts');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > INTAKE_FOLDER_UPLOAD_MAX_FILES) {
    throw new Error(`relativePaths must contain 1-${INTAKE_FOLDER_UPLOAD_MAX_FILES} entries`);
  }
  const relativePaths = parsed.map(normalizeIntakeUploadRelativePath);
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new Error('uploaded folder contains duplicate relative paths');
  }
  req._matosIntakeRelativePaths = relativePaths;
  return relativePaths;
}

export function registerMatOSAssetRoutes(
  app: Express,
  options: {
    resolveProjectCwd?: (projectId: string) => string | undefined | Promise<string | undefined>;
    // Project-scoped evolutions live in project directories; the workspace
    // catalog counts them too so its "self-evolved" marks are complete.
    listProjectCwds?: () => string[] | Promise<string[]>;
  } = {},
): void {
  const evolutionCwds = async (projectCwd?: string): Promise<string[]> =>
    projectCwd
      ? [matosCwd(), projectCwd]
      : [matosCwd(), ...((await options.listProjectCwds?.()) ?? [])];
  // Saving an entry file necessarily writes into the accepted source checkout
  // that `assets show` resolved. Keep the already-authorized source identity
  // for the following publish request: resolving the asset again would run a
  // fresh accepted-ref materialization and discard the uncommitted edit before
  // `commit-source` can capture it. The lease contains server-derived values
  // only (never a client-provided source id), is scoped to this daemon, and is
  // removed after a successful accepted-ref advance.
  // Pre-warm the registry listing shortly after boot so the FIRST Assets/Home
  // catalog request already hits the cache instead of waiting out a cold
  // `matos` walk (10s+ on real deployments). Delayed a few seconds to stay
  // off the daemon's startup critical path; failures are silent because the
  // next real request retries through the same single-flight refresh.
  // OD_MATOS_ASSETS_PREWARM=0 disables it (tests, matos-less dev shells).
  const prewarmDisabled = /^(0|off|false|disabled)$/i.test(
    String(process.env.OD_MATOS_ASSETS_PREWARM ?? '').trim(),
  );
  if (!prewarmDisabled) {
    const prewarm = setTimeout(() => {
      void refreshListCache().catch(() => {});
    }, 3_000);
    prewarm.unref?.();
  }

  // List assets of the released product asset types (internal provenance
  // types — experience, evolution-proposal — are never listed; staged
  // families — benchmarks/evaluations/runtimes — only on explicit request).
  app.get('/api/matos/assets', (req: Request, res: Response) => {
    void (async () => {
      const typesParam = String(req.query.types ?? '').trim();
      const requested = new Set(
        typesParam
          ? typesParam.split(',').map((t) => t.trim()).filter(Boolean)
          : MATOS_BRIDGE_DEFAULT_ASSET_TYPES,
      );
      const projectId = String(req.query.projectId ?? '').trim();
      let projectCwd: string | undefined;
      if (projectId) {
        if (projectId.length > 200 || /[\u0000-\u001f\u007f]/u.test(projectId)) {
          sendError(res, 400, 'invalid project id');
          return;
        }
        projectCwd = await options.resolveProjectCwd?.(projectId);
        if (!projectCwd) {
          sendError(res, 404, 'project not found');
          return;
        }
      }
      const forceRefresh = req.query.refresh === '1';
      const [payload, scopedPayload] = projectCwd
        ? await Promise.all([
            listProjectAssetsCached(projectCwd, forceRefresh),
            listAssetsCached(forceRefresh),
          ])
        : [await listAssetsCached(forceRefresh), null];
      const evolution = await assetEvolutionIndexCached(
        await evolutionCwds(projectCwd),
        forceRefresh,
      );
      const normalizeRows = (rawPayload: unknown) => {
        const rows = isRecord(rawPayload) && Array.isArray(rawPayload.assets)
          ? rawPayload.assets
          : [];
        return rows
        .map((row) => normalizeAssetRecord(row, { evolution }))
        .filter((asset): asset is MatOSBridgeAssetSummary => asset !== null);
      };
      const projectAssets = normalizeRows(payload);
      const assets = (projectCwd
        ? mergeProjectAndCurrentScopeAssets(projectAssets, normalizeRows(scopedPayload))
        : projectAssets)
        .filter((asset) => requested.has(asset.type))
        // Internal preflight "smoke" assets (e.g. tool:mathub-domain-smoke) are
        // dependency-wired into roles/workflows but are not user-facing catalog
        // items; hide them from the Home showcase + workbench list so they stop
        // cluttering the gallery. They still resolve as dependency edges.
        .filter((asset) => !isSmokeCatalogAsset(asset));
      // The full catalog (grid + relationship-map views) is hundreds of KB of
      // JSON; gzip cuts the public-gateway transfer ~8x.
      sendJsonMaybeGzip(req, res, { assets });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Batch DAG skeletons from the compact registry listing; unreadable
  // definitions are absent and tiles fall back to icon + text.
  app.get('/api/matos/workflow-previews', (req: Request, res: Response) => {
    void (async () => {
      const payload = await listAssetsCached(req.query.refresh === '1');
      const rows = isRecord(payload) && Array.isArray(payload.assets) ? payload.assets : [];
      const cwd = matosCwd();
      const jobs: Array<Promise<MatOSWorkflowPreview | null>> = [];
      for (const row of rows) {
        if (!isRecord(row) || row.type !== 'workflow') continue;
        const id = stringOrNull(row.id);
        if (!id) continue;
        const assetDir = expandWorkspacePath(stringOrNull(row.absolutePath) ?? undefined, cwd);
        if (!assetDir || !path.isAbsolute(assetDir)) continue;
        const entry = stringOrNull(row.entry) ?? 'workflow.json';
        // Definitions are JSON or YAML (most released workflows ship
        // `workflow.yaml`); skip prose/other entries.
        if (!/\.(json|ya?ml)$/i.test(entry)) continue;
        jobs.push((async () => {
          const preview = await loadWorkflowPreview(`workflow:${id}`, path.join(assetDir, entry));
          if (!preview) return null;
          const version = stringOrNull(row.version);
          const canonicalKey = stringOrNull(row.canonicalKey) ?? (version ? `workflow:${id}@${version}` : undefined);
          return { ...preview, ...(canonicalKey ? { canonicalKey } : {}) };
        })());
        if (jobs.length % WORKFLOW_PREVIEW_CONCURRENCY === 0) await Promise.all(jobs.slice(-WORKFLOW_PREVIEW_CONCURRENCY));
      }
      const previews = (await Promise.all(jobs)).filter(
        (preview): preview is MatOSWorkflowPreview => preview !== null,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      sendJsonMaybeGzip(req, res, { previews });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Conversation-role catalog for the Home composer role picker. A thin
  // projection of the same cached registry listing: only `role` assets that
  // are user-selectable (enabled + not an internal self-evolution/admin
  // worker). Refs are canonical/pinned (`role:<id>@<version>`) so project
  // membership records keep the same spelling that workbench sync resolves;
  // UI-side comparisons remain version-agnostic for old saved picks.
  app.get('/api/matos/roles', (req: Request, res: Response) => {
    void (async () => {
      const payload = await listAssetsCached(req.query.refresh === '1');
      const rows = isRecord(payload) && Array.isArray(payload.assets) ? payload.assets : [];
      const roles = rows
        .map((row) => normalizeAssetRecord(row))
        .filter((asset): asset is MatOSBridgeAssetSummary => asset !== null)
        .filter((asset) => selectableMatOSConversationRole(asset))
        .map((asset) => ({
          ref:
            asset.canonicalKey ??
            (asset.version ? `role:${asset.id}@${asset.version}` : `role:${asset.id}`),
          identityRef: `role:${asset.id}`,
          id: asset.id,
          name: asset.name,
          description: asset.description,
          tags: asset.tags,
          packId: asset.packId,
          version: asset.version,
          // Mounted-asset refs (`type:id[@ver]`) so the picker preview can
          // summarize what the role composes without a per-role detail call.
          dependencies: asset.dependencies,
          // Role-level runtime overrides (model/effort/permissionMode/maxTurns)
          // so pickers and the workbench editor share one catalog read.
          runtime: asset.runtime,
        }));
      sendJsonMaybeGzip(req, res, { roles });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Role-level runtime overrides (model / effort / permission mode / max
  // turns). Writes go through `matos roles runtime set` so the role asset
  // manifest stays the single source of truth the `matos --role` launch
  // path composes from. `null` clears an override back to the deployment
  // default (CLI sentinel: empty string / --max-turns 0).
  app.put('/api/matos/roles/:id/runtime', (req: Request, res: Response) => {
    void (async () => {
      const id = String(req.params.id ?? '');
      const ref = id.startsWith('role:') ? id : `role:${id}`;
      if (!isMatOSBridgeAssetRef(ref) || isHiddenMatOSRoleId(ref.slice('role:'.length))) {
        sendError(res, 400, 'invalid role ref');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: MatOSRoleRuntimePatch = {};
      for (const key of ['model', 'effort', 'permissionMode'] as const) {
        if (!(key in body)) continue;
        const value = body[key];
        if (value !== null && typeof value !== 'string') {
          sendError(res, 400, `${key} must be a string or null`);
          return;
        }
        patch[key] = value;
      }
      if ('maxTurns' in body) {
        const value = body.maxTurns;
        if (value !== null && typeof value !== 'number') {
          sendError(res, 400, 'maxTurns must be a number or null');
          return;
        }
        patch.maxTurns = value;
      }
      const { args, error } = buildRoleRuntimeSetArgs(ref, patch);
      if (error) {
        sendError(res, 400, error);
        return;
      }
      if (!args) {
        sendError(res, 400, 'no runtime fields to update');
        return;
      }
      const record = await resolveAssetRecord(ref);
      const authorization = authorizeMatOSAssetMutation(record);
      if (!authorization.ok) {
        sendError(res, 403, authorization.reason);
        return;
      }
      const payload = await execMatOSJson(args);
      listCache = null;
      const runtime = isRecord(payload)
        ? normalizeRoleRuntimeSettings(payload.runtime)
        : null;
      res.json({
        ok: true,
        role: ref,
        changed: isRecord(payload) ? payload.changed === true : false,
        runtime,
      });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Asset detail: registry record + editable entry files with content.
  app.get('/api/matos/assets/:ref', (req: Request, res: Response) => {
    void (async () => {
      const ref = String(req.params.ref ?? '');
      if (!isMatOSBridgeAssetRef(ref)) {
        sendError(res, 400, 'invalid asset ref');
        return;
      }
      const record = await resolveAssetRecord(ref);
      const authorization = authorizeMatOSAssetRead(record);
      if (!authorization.ok) {
        sendError(res, 403, authorization.reason);
        return;
      }
      const evolution = await assetEvolutionIndexCached(await evolutionCwds());
      const summary = normalizeAssetRecord(record, { evolution });
      const assetDir = expandWorkspacePath(
        stringOrNull(record.absolutePath) ?? undefined,
        matosCwd(),
      );
      const files: Array<{ name: string; content: string }> = [];
      if (assetDir) {
        for (const name of await listEditableFiles(assetDir)) {
          try {
            files.push({
              name,
              content: await readFile(path.join(assetDir, name), 'utf8'),
            });
          } catch {
            // Unreadable file: surface the rest.
          }
        }
      }
      res.json({ asset: summary, files });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Save one editable file back into the asset's source checkout, then run
  // MatOS validation for the asset. Returns the validation verdict so the UI
  // can surface schema errors immediately.
  app.put('/api/matos/assets/:ref/file', (req: Request, res: Response) => {
    void serializeAssetMutation(currentDaemonScopeRef(), async () => {
      const ref = String(req.params.ref ?? '');
      if (!isMatOSBridgeAssetRef(ref)) {
        sendError(res, 400, 'invalid asset ref');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const content = typeof body.content === 'string' ? body.content : null;
      if (!isEditableAssetFileName(name) || content === null) {
        sendError(res, 400, 'name must be an editable asset file and content a string');
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
        sendError(res, 413, 'file too large');
        return;
      }
      const record = await resolveAssetRecord(ref);
      const authorization = authorizeMatOSAssetMutation(record);
      if (!authorization.ok) {
        sendError(res, 403, authorization.reason);
        return;
      }
      const assetDir = expandWorkspacePath(
        stringOrNull(record.absolutePath) ?? undefined,
        matosCwd(),
      );
      if (!assetDir) {
        sendError(res, 409, 'asset has no writable source checkout');
        return;
      }
      await assertMatOSAssetMutationPath(assetDir);
      const previousLease = pendingAssetMutations.get(ref);
      const restoreLease = () => {
        if (previousLease) pendingAssetMutations.set(ref, previousLease);
        else pendingAssetMutations.delete(ref);
      };
      pendingAssetMutations.delete(ref);
      pendingAssetMutations.set(ref, {
        sourceId: authorization.sourceId,
        assetDir,
        scopeRef: currentDaemonScopeRef(),
      });
      // A list/detail read that began before this mutation acquired its lease
      // may still be materializing the immutable accepted ref. Let it finish
      // before writing; all later bridge reads see the pending lease and use
      // the preserve-dirty editor environment.
      try {
        await waitForAssetBridgeReads();
        if (Object.hasOwn(body, 'expectedContent')) {
          const current = await readFile(path.join(assetDir, name), 'utf8');
          if (typeof body.expectedContent !== 'string' || current !== body.expectedContent) {
            restoreLease();
            res.status(409).json({ error: { code: 'ASSET_FILE_CONFLICT', message: 'Asset file changed. Reload and resolve the conflicting edits.' } });
            return;
          }
        }
        await writeFile(path.join(assetDir, name), content, 'utf8');
      } catch (error) {
        restoreLease();
        throw error;
      }
      // A long-lived daemon should not accumulate one record per asset ever
      // edited. Insertion order lets us evict the oldest completed/abandoned
      // edit without touching any source files.
      if (pendingAssetMutations.size > 512) {
        const oldest = pendingAssetMutations.keys().next().value;
        if (typeof oldest === 'string') pendingAssetMutations.delete(oldest);
      }
      listCache = null;
      let validation: unknown = null;
      try {
        validation = await execMatOSJson(
          ['assets', 'validate', ref, '--json'],
          { env: matosAssetBridgeEditCliEnv() },
        );
      } catch (error) {
        validation = {
          ok: false,
          errors: [{ code: 'validate_failed', message: error instanceof Error ? error.message : String(error) }],
        };
      }
      res.json({ ok: true, validation });
    }).catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Gitea governance: commit the asset's source checkout and advance the
  // accepted runtime ref through the native CLI gate. Never talks to Gitea
  // directly.
  app.post('/api/matos/assets/:ref/publish', (req: Request, res: Response) => {
    void serializeAssetMutation(currentDaemonScopeRef(), async () => {
      const ref = String(req.params.ref ?? '');
      if (!isMatOSBridgeAssetRef(ref)) {
        sendError(res, 400, 'invalid asset ref');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const message =
        typeof body.message === 'string' && body.message.trim()
          ? body.message.trim().slice(0, 300)
          : `matos-studio: update ${ref}`;
      const pending = pendingAssetMutations.get(ref);
      let sourceId: string;
      if (pending && pending.scopeRef === currentDaemonScopeRef()) {
        // Re-check the stored path boundary before relying on the mutation
        // lease. This is intentionally non-materializing so the dirty edit is
        // still present when commit-source starts.
        await assertMatOSAssetMutationPath(pending.assetDir);
        sourceId = pending.sourceId;
      } else {
        const record = await resolveAssetRecord(ref);
        const authorization = authorizeMatOSAssetMutation(record);
        if (!authorization.ok) {
          sendError(res, 403, authorization.reason);
          return;
        }
        sourceId = authorization.sourceId;
      }
      const commit = await execMatOSJson([
        'assets',
        'git',
        'commit-source',
        sourceId,
        '--message',
        message,
        '--push',
        '--json',
      ]);
      // Accept the immutable commit returned by commit-source, not mutable
      // `main`. This is also correct for a noop made from a detached accepted
      // checkout: main may lag behind the current accepted ref, which would
      // otherwise trigger a misleading non-fast-forward 502.
      const candidateCommit = matOSAssetPublishCandidateCommit(commit);
      const accept = await execMatOSJson([
        'assets',
        'git',
        'accept',
        sourceId,
        '--ref',
        candidateCommit,
        '--channel',
        'stable',
        '--push',
        '--json',
      ]);
      pendingAssetMutations.delete(ref);
      listCache = null;
      res.json({ ok: true, sourceId, commit, accept });
    }).catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });






  // One-command dataset registration: thin proxy over
  // `matos assets register-data --json`. Writes a project-local
  // reference-only data asset (DOI/source URLs/payload path provenance) in
  // the daemon's MatOS workspace; payloads stay at their source location.
  // The CLI owns validation, duplicate refusal, and rollback-on-invalid.
  app.post('/api/matos/assets/register-data', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!id || !name) {
        sendError(res, 400, 'id and name are required');
        return;
      }
      const argv = ['assets', 'register-data', '--id', id, '--name', name.slice(0, 300)];
      const pushOption = (flag: string, value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
          argv.push(flag, value.trim().slice(0, 2000));
        }
      };
      pushOption('--doi', body.doi);
      pushOption('--path', body.path);
      pushOption('--description', body.description);
      pushOption('--domain', body.domain);
      pushOption('--tos-archive', body.tosArchive);
      for (const url of Array.isArray(body.urls) ? body.urls.slice(0, 20) : []) {
        pushOption('--url', url);
      }
      for (const tag of Array.isArray(body.tags) ? body.tags.slice(0, 20) : []) {
        pushOption('--tag', tag);
      }
      if (body.replace === true) argv.push('--replace');
      argv.push('--json');
      try {
        const payload = await execMatOSJson(argv);
        listCache = null;
        res.json(payload);
      } catch (error) {
        // The CLI already validated inputs; surface its message as a client
        // error (duplicate id, bad slug, missing source) instead of a 502.
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });


  // Publish a document as a versioned project-local data asset: thin proxy
  // over `matos assets publish-data --json`. The document body is written to
  // a temp entry file under the MatOS workspace (never argv), exactly like
  // the workflow publish bridge passes canvas definitions; the CLI owns
  // manifest writing, entry checks (size/JSON/entry-name), duplicate
  // refusal, whole-registry validation, and rollback-on-invalid. The lab
  // sandbox "save scene to project" flow posts scene JSON here with
  // tags: ["virtual-lab-scene", ...].
  app.post('/api/matos/assets/publish-data', (req: Request, res: Response) => {
    void (async () => {
      let cwd: string;
      try { ({ cwd } = await matosProjectScope(req.query.projectId, options)); }
      catch (error) { sendError(res, 400, String((error as Error).message)); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!id || !name) {
        sendError(res, 400, 'id and name are required');
        return;
      }
      const document = body.document;
      const content =
        typeof document === 'string'
          ? document
          : document !== undefined && document !== null
            ? JSON.stringify(document, null, 2)
            : '';
      if (!content.trim()) {
        sendError(res, 400, 'document is required (JSON object or string)');
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
        sendError(res, 413, 'document too large');
        return;
      }
      const tmpDir = path.join(cwd, '.matos', 'tmp');
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `publish-data-${randomUUID()}.entry`);
      await writeFile(tmpFile, content, 'utf8');
      try {
        const argv = [
          'assets',
          'publish-data',
          '--id',
          id,
          '--name',
          name.slice(0, 300),
          '--entry-file',
          tmpFile,
        ];
        const pushOption = (flag: string, value: unknown) => {
          if (typeof value === 'string' && value.trim()) {
            argv.push(flag, value.trim().slice(0, 2000));
          }
        };
        pushOption('--entry-name', body.entryName);
        pushOption('--pack', body.pack);
        pushOption('--description', body.description);
        pushOption('--version', body.version);
        for (const tag of Array.isArray(body.tags) ? body.tags.slice(0, 20) : []) {
          pushOption('--tag', tag);
        }
        if (body.overwrite === true) argv.push('--overwrite');
        argv.push('--json');
        const payload = await execMatOSJson(argv, { cwd });
        listCache = null;
        projectListCache.delete(path.resolve(cwd));
        res.json(payload);
      } catch (error) {
        // The CLI already validated inputs; surface its message as a client
        // error (duplicate id, bad slug, invalid entry) instead of a 502.
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      } finally {
        await rm(tmpFile, { force: true });
      }
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Invoke one external tool asset with a JSON input document: thin proxy
  // over `matos assets run-tool <tool-ref> --input-file <tmp> --json`. The
  // input document is written to a temp file under the MatOS workspace
  // (never argv — decompose payloads carry megabyte base64 mesh soups),
  // exactly like the publish-data bridge passes scene documents; the CLI
  // owns ref resolution (registry-enabled tools only) and executes through
  // the same runner the asset MCP server uses. First consumer: the lab
  // sandbox "Decompose on server" backfill for imported meshes
  // (tool:cad-import action=decompose). Geometry work (CoACD) can far
  // outlast the default bridge timeout, so this exec uses its own
  // generous-but-bounded budget.
  const RUN_TOOL_TIMEOUT_MS = Number(process.env.MATOS_RUN_TOOL_TIMEOUT_MS || 600_000);
  const RUN_TOOL_MAX_INPUT_BYTES = 8 * 1024 * 1024;
  const execMatOSRunTool = (args: string[]): Promise<string> =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        MATOS_BIN,
        args,
        {
          cwd: matosCwd(),
          timeout: RUN_TOOL_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: matosCliEnv(),
        },
        (error, stdout, stderr) => {
          // `run-tool --json` exits 1 with the structured payload on stdout
          // when the tool reports ok:false; surface that payload instead of
          // collapsing it into an opaque exec error.
          const out = String(stdout ?? '');
          if (error && !out.trim().startsWith('{')) {
            rejectPromise(
              new Error(
                `matos assets run-tool failed: ${String(stderr || error.message).slice(0, 2000)}`,
              ),
            );
            return;
          }
          resolvePromise(out);
        },
      );
    });

  app.post('/api/matos/assets/run-tool', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
      if (!/^tool:[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.+-]+)?$/.test(tool)) {
        sendError(res, 400, 'tool must be a tool:<id> asset ref');
        return;
      }
      if (!isRecord(body.input)) {
        sendError(res, 400, 'input must be a JSON object');
        return;
      }
      const inputText = JSON.stringify(body.input);
      if (Buffer.byteLength(inputText, 'utf8') > RUN_TOOL_MAX_INPUT_BYTES) {
        sendError(res, 413, 'input too large');
        return;
      }
      const tmpDir = path.join(matosCwd(), '.matos', 'tmp');
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `run-tool-${randomUUID()}.json`);
      await writeFile(tmpFile, inputText, 'utf8');
      try {
        const stdout = await execMatOSRunTool([
          'assets',
          'run-tool',
          tool,
          '--input-file',
          tmpFile,
          '--json',
        ]);
        const payload = parseMatOSJson(stdout);
        res.json(payload);
      } catch (error) {
        // Unknown/disabled tool refs and unreadable executors surface as
        // client errors with the CLI's honest message, not a 502.
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      } finally {
        await rm(tmpFile, { force: true });
      }
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });



  const intakeDraftPackId = (payload: unknown): string | null => {
    const plan = isRecord(payload) && isRecord(payload.plan) ? payload.plan : null;
    const pack = plan && isRecord(plan.targetPack) ? plan.targetPack : null;
    return pack ? stringOrNull(pack.packId) : null;
  };
  const intakeAdoptionScopeRef = (): string | null => {
    const scopeRef = currentDaemonScopeRef();
    return /^(user|team|project):\S+$/.test(scopeRef ?? '') ? scopeRef : null;
  };
  const adoptIntakeDraftPack = async (
    packId: string,
  ): Promise<{ ok: boolean; adoptedRefs: string[]; error?: string }> => {
    try {
      const payload = await execMatOSJsonReport(['assets', 'intake-adopt', packId, '--json']);
      const record = isRecord(payload) ? payload : {};
      listCache = null;
      projectListCache.clear();
      return {
        ok: record.ok === true,
        adoptedRefs: Array.isArray(record.adoptedRefs)
          ? record.adoptedRefs.filter((ref): ref is string => typeof ref === 'string')
          : [],
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
      };
    } catch (error) {
      return { ok: false, adoptedRefs: [], error: error instanceof Error ? error.message : String(error) };
    }
  };

  // Universal asset import: thin proxy over the native external-intake
  // draft-pack pipeline (`matos workbench search intake-draft[-apply]`).
  // Sources may be local paths, uploaded archives, git URLs, or http(s)
  // downloads; the CLI owns acquisition/staging, deterministic
  // classification into typed asset proposals, secret scan, snapshots,
  // validation, and rollback. Preview returns the plan + confirmation
  // fingerprint; apply must echo that fingerprint back.
  const intakeArgv = (
    command: 'intake-draft' | 'intake-draft-apply',
    body: Record<string, unknown>,
  ): string[] | null => {
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (!source) return null;
    const argv = ['workbench', 'search', command, source];
    if (typeof body.packId === 'string' && body.packId.trim()) {
      argv.push('--pack-id', body.packId.trim().slice(0, 64));
    }
    if (body.executable === true) argv.push('--executable');
    if (body.withBenchmark === true) argv.push('--with-benchmark');
    return argv;
  };

  app.post('/api/matos/assets/import-preview', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const argv = intakeArgv('intake-draft', body);
      if (!argv) {
        sendError(res, 400, 'source is required (path, zip/tar, git URL, or http(s) URL)');
        return;
      }
      argv.push('--json');
      try {
        res.json(await execMatOSJson(argv));
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.post('/api/matos/assets/import-apply', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
      const argv = intakeArgv('intake-draft-apply', body);
      if (!argv || !fingerprint) {
        sendError(res, 400, 'source and fingerprint are required');
        return;
      }
      argv.push('--fingerprint', fingerprint);
      if (typeof body.reason === 'string' && body.reason.trim()) {
        argv.push('--reason', body.reason.trim().slice(0, 300));
      }
      argv.push('--json');
      let payload: unknown;
      try {
        payload = await execMatOSJson(argv);
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
        return;
      }
      listCache = null;
      const packId = intakeDraftPackId(payload);
      // The preview the user confirmed is the review; adopt unless the caller
      // asks to keep drafts. A failed adoption leaves the drafts in place.
      const adoption =
        body.adopt !== false && packId && intakeAdoptionScopeRef()
          ? await adoptIntakeDraftPack(packId)
          : null;
      res.json(isRecord(payload) ? { ...payload, adoption } : { result: payload, adoption });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.post('/api/matos/assets/import-adopt', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const packId = typeof body.packId === 'string' ? body.packId.trim() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packId)) {
        sendError(res, 400, 'packId is required');
        return;
      }
      if (!intakeAdoptionScopeRef()) {
        sendError(res, 409, 'adopting intake drafts needs a user, team or project scope');
        return;
      }
      const adoption = await adoptIntakeDraftPack(packId);
      if (!adoption.ok) {
        sendError(res, 409, adoption.error ?? 'intake adopt failed');
        return;
      }
      res.json({ ok: true, adoption });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Archive/document upload for the import flow: the file lands below the
  // MatOS workspace's intake uploads directory and the response returns the
  // absolute path to feed import-preview as `source`.
  const intakeUpload = multer({
    storage: multer.diskStorage({
      // One directory per upload keeps the original file name, which intake
      // turns into the asset id.
      destination: (_req, _file, cb) => {
        const dir = path.join(
          matosCwd(),
          '.matos',
          'intake',
          'uploads',
          `upload-${Date.now()}-${randomUUID().slice(0, 8)}`,
        );
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        cb(null, file.originalname.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-96) || 'upload');
      },
    }),
    limits: { fileSize: INTAKE_UPLOAD_MAX_FILE_BYTES },
  });

  app.post(
    '/api/matos/assets/import-upload',
    intakeUpload.single('file'),
    (req: Request, res: Response) => {
      const file = req.file;
      if (!file) {
        sendError(res, 400, 'multipart "file" field is required');
        return;
      }
      res.json({ ok: true, path: file.path, name: file.originalname, bytes: file.size });
    },
  );

  // Directory uploads use an explicit relative-path manifest followed by the
  // file parts. This avoids Chromium's recursive drag/drop FileSystemEntry
  // path, which can leave a partial tree when one local entry is unreadable.
  // Multer streams each file directly to disk; a failed batch is removed in
  // full so an incomplete directory never becomes an intake source.
  const intakeFolderFilePaths = new WeakMap<object, string>();
  const intakeFolderUpload = multer({
    storage: multer.diskStorage({
      destination: (rawReq, file, cb) => {
        const req = rawReq as IntakeFolderUploadRequest;
        try {
          const relativePaths = intakeFolderRelativePaths(req);
          const index = req._matosIntakeUploadIndex ?? 0;
          const relativePath = relativePaths[index];
          if (!relativePath) throw new Error('received more files than relativePaths entries');
          req._matosIntakeUploadIndex = index + 1;
          intakeFolderFilePaths.set(file, relativePath);

          const root = req._matosIntakeUploadRoot ?? path.join(
            matosCwd(),
            '.matos',
            'intake',
            'uploads',
            `folder-${Date.now()}-${randomUUID().slice(0, 8)}`,
          );
          req._matosIntakeUploadRoot = root;
          const destination = path.join(root, path.dirname(relativePath));
          fs.mkdirSync(destination, { recursive: true });
          cb(null, destination);
        } catch (error) {
          cb(error instanceof Error ? error : new Error(String(error)), '');
        }
      },
      filename: (_req, file, cb) => {
        const relativePath = intakeFolderFilePaths.get(file);
        if (!relativePath) {
          cb(new Error('uploaded file path manifest was not resolved'), '');
          return;
        }
        cb(null, path.basename(relativePath));
      },
    }),
    limits: {
      fileSize: INTAKE_UPLOAD_MAX_FILE_BYTES,
      files: INTAKE_FOLDER_UPLOAD_MAX_FILES,
      fields: 1,
      fieldSize: 4 * 1024 * 1024,
    },
  });

  app.post('/api/matos/assets/import-upload-folder', (req: Request, res: Response) => {
    intakeFolderUpload.array('files', INTAKE_FOLDER_UPLOAD_MAX_FILES)(req, res, (error) => {
      const uploadReq = req as IntakeFolderUploadRequest;
      const root = uploadReq._matosIntakeUploadRoot;
      const cleanupAndReject = (message: string) => {
        void (root ? rm(root, { recursive: true, force: true }) : Promise.resolve())
          .finally(() => sendError(res, 400, message));
      };
      if (error) {
        cleanupAndReject(error instanceof Error ? error.message : String(error));
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const expected = uploadReq._matosIntakeRelativePaths?.length ?? 0;
      if (!root || files.length === 0 || files.length !== expected) {
        cleanupAndReject(`folder upload was incomplete: received ${files.length} of ${expected} files`);
        return;
      }
      const bytes = files.reduce((total, file) => total + file.size, 0);
      // A dropped folder arrives as <root>/<folder>/...; intake names the
      // assets after the source directory, so hand it the folder itself.
      const top = fs.readdirSync(root, { withFileTypes: true });
      const source = top.length === 1 && top[0]!.isDirectory() ? path.join(root, top[0]!.name) : root;
      res.json({ ok: true, path: source, files: files.length, bytes });
    });
  });

  // Git governance overview for the Assets workbench header.
  app.get('/api/matos/assets-sources', (_req: Request, res: Response) => {
    void (async () => {
      const payload = await execMatOSJson(['assets', 'sources', 'list', '--json']);
      res.json(isRecord(payload) ? payload : { sources: [] });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // GitHub-style version history for one asset: commits touching the asset's
  // directory in its Gitea source checkout, plus the branch/evolution graph
  // (main, accepted/<source>/<channel> runtime gates, evolution/<run-id>
  // self-evolution edits). Read-only local git — never talks to Gitea.
  app.get('/api/matos/assets/:ref/history', (req: Request, res: Response) => {
    void (async () => {
      const ref = String(req.params.ref ?? '');
      if (!isMatOSBridgeAssetRef(ref)) {
        sendError(res, 400, 'invalid asset ref');
        return;
      }
      res.json(await execMatOSJson(['assets', 'archive', 'history', ref, '--json']));
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Commit-level drilldown for the history/evolution graph: what exactly
  // changed in one commit (file stats + bounded unified diff), plus the
  // self-evolution audit summary when the commit was produced by a MatOS
  // direct-editor run. Users could previously see only branch/commit labels,
  // which made it impossible to understand what actually evolved. Read-only
  // local git — never talks to Gitea.
  app.get('/api/matos/assets/:ref/history/:hash', (req: Request, res: Response) => {
    void (async () => {
      const ref = String(req.params.ref ?? '');
      const hash = String(req.params.hash ?? '');
      if (!isMatOSBridgeAssetRef(ref)) {
        sendError(res, 400, 'invalid asset ref');
        return;
      }
      if (!/^[0-9a-f]{7,64}$/i.test(hash)) {
        sendError(res, 400, 'invalid commit hash');
        return;
      }
      res.json(await execMatOSJson(['assets', 'archive', 'history', ref, hash, '--json']));
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  registerMatOSAssetArchiveRoutes(app, sendError);
}
