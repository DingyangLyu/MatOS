// Structured-editor helpers for the MatOS Assets workbench.
//
// Users edit forms, documents, and canvases — never raw schema by default.
// These helpers round-trip the underlying files losslessly where possible:
// asset.json edits merge into the existing JSON (unknown fields preserved),
// SKILL.md frontmatter edits go through the `yaml` Document API (comments
// and field order preserved), and workflow YAML entries parse into the
// canvas document model.

import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';

export interface AssetMetadataFields {
  name: string;
  description: string;
  version: string;
  tags: string[];
}

/** Read the form fields out of an asset.json body (tolerant). */
export function metadataFromAssetJson(text: string): AssetMetadataFields {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === 'string')
        : [],
    };
  } catch {
    return { name: '', description: '', version: '', tags: [] };
  }
}

/** Merge the form fields back into asset.json, preserving unknown fields. */
export function applyMetadataToAssetJson(text: string, fields: AssetMetadataFields): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed.name = fields.name;
  parsed.description = fields.description;
  if (fields.version) parsed.version = fields.version;
  parsed.tags = fields.tags;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function dependenciesFromAssetJson(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Array.isArray(parsed.dependencies)
      ? parsed.dependencies.filter((d): d is string => typeof d === 'string')
      : [];
  } catch {
    return [];
  }
}

export function applyDependenciesToAssetJson(text: string, dependencies: string[]): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed.dependencies = dependencies;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Markdown front matter (SKILL.md and friends)
// ---------------------------------------------------------------------------

export interface FrontmatterDocument {
  /** Raw frontmatter YAML (without the --- fences), '' when absent. */
  frontmatter: string;
  /** Markdown body after the frontmatter block. */
  body: string;
  hasFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(text: string): FrontmatterDocument {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: '', body: text, hasFrontmatter: false };
  }
  return {
    frontmatter: match[1] ?? '',
    body: text.slice(match[0].length),
    hasFrontmatter: true,
  };
}

export function joinFrontmatter(doc: FrontmatterDocument): string {
  if (!doc.hasFrontmatter) return doc.body;
  return `---\n${doc.frontmatter.replace(/\n$/, '')}\n---\n\n${doc.body.replace(/^\n+/, '')}`;
}

export interface SkillFrontmatterFields {
  description: string;
  allowedTools: string[];
  tags: string[];
}

export function skillFieldsFromFrontmatter(frontmatter: string): SkillFrontmatterFields {
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter) ?? {};
  } catch {
    // A malformed frontmatter (classically an unquoted description that
    // contains ": ", e.g. "(6 sub-skills: ...)") makes strict parseYaml throw.
    // Recover a best-effort object through the tolerant Document parser so the
    // form still shows the real values instead of blanks.
    try {
      parsed = parseDocument(frontmatter).toJS() ?? {};
    } catch {
      parsed = {};
    }
  }
  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  // The tolerant Document parser drops the value of the exact line that broke
  // (classically `description: ... (6 sub-skills: a, b)`), so when a scalar
  // came back empty, fall back to reading that single line as plain text.
  const description =
    typeof record.description === 'string' && record.description
      ? record.description
      : looseFrontmatterLine(frontmatter, 'description') ?? '';
  return {
    description,
    allowedTools: list(record['allowed-tools']),
    tags: list(record.tags),
  };
}

/** Line-level extraction for frontmatter keys whose YAML failed to parse. */
function looseFrontmatterLine(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
  const value = match?.[1];
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Write the form fields back into the frontmatter YAML through the Document
 * API so unrelated keys, comments, and ordering survive.
 */
export function applySkillFieldsToFrontmatter(
  frontmatter: string,
  fields: SkillFrontmatterFields,
): string {
  const doc = parseDocument(frontmatter || '{}');
  // When the source frontmatter parses cleanly, edit it through the Document
  // API so comments, key order, and unknown keys survive.
  if (doc.errors.length === 0) {
    doc.set('description', fields.description);
    if (fields.allowedTools.length > 0) doc.set('allowed-tools', fields.allowedTools);
    else doc.delete('allowed-tools');
    if (fields.tags.length > 0) doc.set('tags', fields.tags);
    else doc.delete('tags');
    return doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  }
  // Malformed source frontmatter (classically an unquoted description that
  // contains ": ", e.g. "(6 sub-skills: ...)") leaves parse errors on the
  // Document, and yaml refuses to stringify an errored Document — calling
  // toString() there throws "Document with errors cannot be stringified" and
  // takes the whole Assets view down. Rebuild from the best-effort recovered
  // object so we always emit valid, correctly-quoted YAML instead of crashing.
  let base: Record<string, unknown> = {};
  try {
    const recovered = doc.toJS();
    if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
      base = recovered as Record<string, unknown>;
    }
  } catch {
    base = {};
  }
  base.description = fields.description;
  if (fields.allowedTools.length > 0) base['allowed-tools'] = fields.allowedTools;
  else delete base['allowed-tools'];
  if (fields.tags.length > 0) base.tags = fields.tags;
  else delete base.tags;
  return stringifyYaml(base, { lineWidth: 0 }).replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Workflow YAML <-> canvas JSON
// ---------------------------------------------------------------------------

export function workflowTextToCanvasJson(text: string, fileName: string): string {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) {
    const parsed = parseYaml(text);
    return JSON.stringify(parsed ?? {}, null, 2);
  }
  return text;
}

/**
 * Serialize the canvas JSON back into the entry file's format. YAML entries
 * are re-emitted with `yaml`'s stringifier — structure-exact, though comments
 * in the original YAML do not survive a canvas edit.
 */
export function canvasJsonToWorkflowText(json: string, fileName: string): string {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) {
    return stringifyYaml(JSON.parse(json), { lineWidth: 0 });
  }
  return json;
}

/** Group dependency refs by asset type for the role mounts editor. */
export function groupDependencies(dependencies: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const dep of dependencies) {
    const type = dep.includes(':') ? dep.slice(0, dep.indexOf(':')) : 'other';
    const list = groups.get(type) ?? [];
    list.push(dep);
    groups.set(type, list);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Role runtime overrides (asset.json `runtime` block)
// ---------------------------------------------------------------------------
//
// Written by `matos roles runtime set` and consumed by the role's runtime
// composition (`agent.model` / `agent.effort` / `agent.permissionMode` /
// `agent.maxTurns`). The workbench edits the same block through the normal
// asset.json save path so validation + Gitea governance apply unchanged.

export interface RoleRuntimeFields {
  /** Empty string = no override (deployment/env default). */
  model: string;
  effort: string;
  permissionMode: string;
  /** Empty string = no override; otherwise a positive-integer string. */
  maxTurns: string;
}

export function roleRuntimeFromAssetJson(text: string): RoleRuntimeFields {
  const empty: RoleRuntimeFields = { model: '', effort: '', permissionMode: '', maxTurns: '' };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const runtime =
      parsed.runtime && typeof parsed.runtime === 'object' && !Array.isArray(parsed.runtime)
        ? (parsed.runtime as Record<string, unknown>)
        : {};
    return {
      model: typeof runtime.model === 'string' ? runtime.model : '',
      effort:
        typeof runtime.effort === 'string'
          ? runtime.effort
          : typeof runtime.effort === 'number'
            ? String(runtime.effort)
            : '',
      permissionMode: typeof runtime.permissionMode === 'string' ? runtime.permissionMode : '',
      maxTurns:
        typeof runtime.maxTurns === 'number' && Number.isInteger(runtime.maxTurns) && runtime.maxTurns > 0
          ? String(runtime.maxTurns)
          : '',
    };
  } catch {
    return empty;
  }
}

/**
 * Merge the runtime form back into asset.json. Empty fields DELETE the
 * override (mirroring the CLI's clear sentinels) and an all-empty form drops
 * the whole `runtime` block, so cleared roles read exactly like never-set
 * ones. Non-runtime keys inside an existing block (e.g. initialPrompt,
 * memory) are preserved.
 */
export function applyRoleRuntimeToAssetJson(text: string, fields: RoleRuntimeFields): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const runtime =
    parsed.runtime && typeof parsed.runtime === 'object' && !Array.isArray(parsed.runtime)
      ? { ...(parsed.runtime as Record<string, unknown>) }
      : {};
  if (fields.model.trim()) runtime.model = fields.model.trim();
  else delete runtime.model;
  if (fields.effort.trim()) runtime.effort = fields.effort.trim();
  else delete runtime.effort;
  if (fields.permissionMode.trim()) runtime.permissionMode = fields.permissionMode.trim();
  else delete runtime.permissionMode;
  const maxTurns = Number(fields.maxTurns.trim());
  if (fields.maxTurns.trim() && Number.isInteger(maxTurns) && maxTurns > 0) {
    runtime.maxTurns = maxTurns;
  } else {
    delete runtime.maxTurns;
  }
  if (Object.keys(runtime).length > 0) parsed.runtime = runtime;
  else delete parsed.runtime;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Shared tolerant JSON plumbing for the typed structured editors below
// ---------------------------------------------------------------------------

function parseRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metadataRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  return parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
    ? (parsed.metadata as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ---------------------------------------------------------------------------
// MCP assets — mcp.json structured server editor
// ---------------------------------------------------------------------------
//
// Shape: { "mcpServers": { "<name>": { command, args?, env?, ...rest } } }.
// The editor round-trips per-server unknown keys (cwd, transport, url, …)
// and any top-level keys outside `mcpServers` untouched.

export interface McpServerFields {
  name: string;
  command: string;
  /** One argv entry per row (newline-joined in the editor). */
  args: string[];
  /** Env rows as [key, value] to keep duplicates editable while typing. */
  env: Array<[string, string]>;
}

export function mcpServersFromJson(text: string): McpServerFields[] {
  const parsed = parseRecord(text);
  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  return Object.entries(servers).map(([name, raw]) => {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const env =
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? Object.entries(record.env as Record<string, unknown>).map(
            ([key, value]): [string, string] => [key, typeof value === 'string' ? value : String(value ?? '')],
          )
        : [];
    return {
      name,
      command: typeof record.command === 'string' ? record.command : '',
      args: stringList(record.args),
      env,
    };
  });
}

export function applyMcpServersToJson(text: string, servers: McpServerFields[]): string {
  const parsed = parseRecord(text);
  const existing =
    parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {};
  const previousNames = Object.keys(existing);
  servers.forEach((server, index) => {
    const name = server.name.trim();
    if (!name) return;
    // Positional rename support: row N edits keep row N's unknown keys even
    // when the server key itself changed.
    const sourceKey = previousNames.includes(name) ? name : previousNames[index];
    const base =
      sourceKey && existing[sourceKey] && typeof existing[sourceKey] === 'object' && !Array.isArray(existing[sourceKey])
        ? { ...(existing[sourceKey] as Record<string, unknown>) }
        : {};
    base.command = server.command;
    if (server.args.length > 0) base.args = [...server.args];
    else delete base.args;
    const envEntries = server.env.filter(([key]) => key.trim() !== '');
    if (envEntries.length > 0) base.env = Object.fromEntries(envEntries);
    else delete base.env;
    next[name] = base;
  });
  parsed.mcpServers = next;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Read-only launch profile from an MCP asset.json (metadata block). */
export interface McpAssetProfile {
  kind: string;
  serverName: string;
  serverPath: string;
  condaEnvs: string[];
  requiresModels: boolean;
}

export function mcpProfileFromAssetJson(text: string): McpAssetProfile {
  const metadata = metadataRecord(parseRecord(text));
  const hints =
    metadata.runtimeHints && typeof metadata.runtimeHints === 'object' && !Array.isArray(metadata.runtimeHints)
      ? (metadata.runtimeHints as Record<string, unknown>)
      : {};
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : '',
    serverName: typeof metadata.mcpServerName === 'string' ? metadata.mcpServerName : '',
    serverPath: typeof metadata.serverPath === 'string' ? metadata.serverPath : '',
    condaEnvs: stringList(hints.condaEnvNames),
    requiresModels: hints.requiresModels === true,
  };
}

// ---------------------------------------------------------------------------
// Tool assets — builtinTools / mcpServers bindings in asset.json metadata
// ---------------------------------------------------------------------------

export interface ToolBindingsFields {
  kind: string;
  builtinTools: string[];
  mcpServers: string[];
}

export function toolBindingsFromAssetJson(text: string): ToolBindingsFields {
  const metadata = metadataRecord(parseRecord(text));
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : '',
    builtinTools: stringList(metadata.builtinTools),
    mcpServers: stringList(metadata.mcpServers),
  };
}

export function applyToolBindingsToAssetJson(text: string, fields: ToolBindingsFields): string {
  const parsed = parseRecord(text);
  const metadata = { ...metadataRecord(parsed) };
  metadata.builtinTools = [...fields.builtinTools];
  metadata.mcpServers = [...fields.mcpServers];
  parsed.metadata = metadata;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Data assets — container mount root + family rows in asset.json metadata
// ---------------------------------------------------------------------------

export interface DataFamilyRow {
  family: string;
  version: string;
  functional: string;
  protocol: string;
  containerPath: string;
}

export interface DataProfileFields {
  kind: string;
  containerRoot: string;
  families: DataFamilyRow[];
}

export function dataProfileFromAssetJson(text: string): DataProfileFields {
  const metadata = metadataRecord(parseRecord(text));
  const families = Array.isArray(metadata.families)
    ? metadata.families
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
        .map((row) => ({
          family: typeof row.family === 'string' ? row.family : '',
          version: typeof row.version === 'string' ? row.version : '',
          functional: typeof row.functional === 'string' ? row.functional : '',
          protocol: typeof row.protocol === 'string' ? row.protocol : '',
          containerPath: typeof row.containerPath === 'string' ? row.containerPath : '',
        }))
    : [];
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : '',
    containerRoot: typeof metadata.containerRoot === 'string' ? metadata.containerRoot : '',
    families,
  };
}

// ---------------------------------------------------------------------------
// Data assets — read-only source/provenance profile (dataset/paper units)
// ---------------------------------------------------------------------------
//
// Generated TOS archive units (`material-bench-data` pack) and curated data
// assets carry their upstream identity in asset.json metadata: provider
// record, DOI, source URLs, TOS payload status, sizes, and the catalog tool
// query that resolves the unit. The workbench renders this read-only; the
// generator scripts own the values.

export interface DataProvenanceFields {
  present: boolean;
  generated: boolean;
  provider: string;
  providerId: string;
  unitKind: string;
  unitOrigin: string;
  doi: string;
  paperDoi: string;
  sourceUrls: string[];
  sourceManifest: string;
  payloadStatus: string;
  payloadKind: string;
  sizeHuman: string;
  recordCount: number | null;
  collections: string[];
  containerPath: string;
  payloadPaths: string[];
  tosArchive: string;
  catalogTool: string;
  recommendedQuery: string;
  curationIssues: string[];
}

export function dataProvenanceFromAssetJson(text: string): DataProvenanceFields {
  const metadata = metadataRecord(parseRecord(text));
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const urls: string[] = [];
  for (const value of [metadata.sourceUrl, ...(Array.isArray(metadata.sourceUrls) ? metadata.sourceUrls : [])]) {
    const url = str(value);
    if (url && !urls.includes(url)) urls.push(url);
  }
  const recommendedQuery =
    metadata.recommendedQuery && typeof metadata.recommendedQuery === 'object'
      ? JSON.stringify(metadata.recommendedQuery)
      : str(metadata.recommendedQuery);
  const fields: DataProvenanceFields = {
    present: false,
    generated: Boolean(str(metadata.generatedBy)),
    provider: str(metadata.provider),
    providerId: str(metadata.providerId),
    unitKind: str(metadata.unitKind),
    unitOrigin: str(metadata.unitOrigin),
    doi: str(metadata.doi),
    paperDoi: str(metadata.paperDoi),
    sourceUrls: urls,
    sourceManifest: str(metadata.sourceManifest),
    payloadStatus: str(metadata.payloadStatus),
    payloadKind: str(metadata.payloadKind),
    sizeHuman: str(metadata.sizeHuman),
    recordCount: typeof metadata.recordCount === 'number' ? metadata.recordCount : null,
    collections: stringList(metadata.collections),
    containerPath: str(metadata.path) || str(metadata.containerRoot),
    payloadPaths: stringList(metadata.payloadPaths),
    tosArchive: str(metadata.tosArchive),
    catalogTool: str(metadata.catalogTool),
    recommendedQuery,
    curationIssues: stringList(metadata.curationIssues),
  };
  fields.present = Boolean(
    fields.doi || fields.paperDoi || fields.sourceUrls.length > 0 || fields.tosArchive || fields.payloadStatus,
  );
  return fields;
}

export function applyDataProfileToAssetJson(text: string, fields: DataProfileFields): string {
  const parsed = parseRecord(text);
  const metadata = { ...metadataRecord(parsed) };
  if (fields.containerRoot.trim()) metadata.containerRoot = fields.containerRoot.trim();
  else delete metadata.containerRoot;
  const existing = Array.isArray(metadata.families) ? metadata.families : [];
  metadata.families = fields.families.map((row, index) => {
    // Preserve unknown per-row keys (metadataPath, checksums, …) positionally.
    const base =
      existing[index] && typeof existing[index] === 'object' && !Array.isArray(existing[index])
        ? { ...(existing[index] as Record<string, unknown>) }
        : {};
    for (const key of ['family', 'version', 'functional', 'protocol', 'containerPath'] as const) {
      if (row[key].trim()) base[key] = row[key].trim();
      else delete base[key];
    }
    return base;
  });
  if ((metadata.families as unknown[]).length === 0) delete metadata.families;
  parsed.metadata = metadata;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Knowledge assets — read-only capability/safety profile from metadata
// ---------------------------------------------------------------------------

export interface KnowledgeCapability {
  id: string;
  label: string;
  description: string;
  riskLevel: string;
  sideEffects: boolean;
}

export interface KnowledgeProfile {
  kind: string;
  executionMode: string;
  capabilities: KnowledgeCapability[];
  requiresApproval: boolean;
  simulationOnly: boolean;
  safetyNotes: string[];
}

export function knowledgeProfileFromAssetJson(text: string): KnowledgeProfile {
  const metadata = metadataRecord(parseRecord(text));
  const execution =
    metadata.execution && typeof metadata.execution === 'object' && !Array.isArray(metadata.execution)
      ? (metadata.execution as Record<string, unknown>)
      : {};
  const safety =
    metadata.safety && typeof metadata.safety === 'object' && !Array.isArray(metadata.safety)
      ? (metadata.safety as Record<string, unknown>)
      : {};
  const capabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
        .map((row) => ({
          id: typeof row.id === 'string' ? row.id : '',
          label: typeof row.label === 'string' ? row.label : '',
          description: typeof row.description === 'string' ? row.description : '',
          riskLevel: typeof row.riskLevel === 'string' ? row.riskLevel : '',
          sideEffects: row.sideEffects === true,
        }))
    : [];
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : '',
    executionMode: typeof execution.mode === 'string' ? execution.mode : '',
    capabilities,
    requiresApproval: safety.requires_approval === true || safety.requiresApproval === true,
    simulationOnly: safety.simulation_only === true || metadata.simulationOnly === true,
    safetyNotes: stringList(safety.notes),
  };
}

// ---------------------------------------------------------------------------
// Permissions block (tool / MCP asset.json top level)
// ---------------------------------------------------------------------------

export interface AssetPermissionsProfile {
  shell: string;
  network: string;
  workspace: string;
  secrets: string[];
  present: boolean;
}

export function permissionsFromAssetJson(text: string): AssetPermissionsProfile {
  const parsed = parseRecord(text);
  const permissions =
    parsed.permissions && typeof parsed.permissions === 'object' && !Array.isArray(parsed.permissions)
      ? (parsed.permissions as Record<string, unknown>)
      : null;
  if (!permissions) {
    return { shell: '', network: '', workspace: '', secrets: [], present: false };
  }
  return {
    shell: typeof permissions.shell === 'string' ? permissions.shell : '',
    network: typeof permissions.network === 'string' ? permissions.network : '',
    workspace: typeof permissions.workspace === 'string' ? permissions.workspace : '',
    secrets: stringList(permissions.secrets),
    present: true,
  };
}
