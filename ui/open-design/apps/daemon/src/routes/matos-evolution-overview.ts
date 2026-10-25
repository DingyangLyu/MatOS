// MatOS self-evolution overview: pending proposals, the edit history and a
// per-asset lineage ("evolution tree") for the /evolution page.
//
// Direct-editor run records live next to the assets they changed: the user
// workspace for user-scoped edits and each project directory for
// project-scoped overlays. This module reads those `run.json` files (and the
// asset.json hunks of their diff patches, for version lineage) and shapes
// them for the browser. Decisions (approve / reject) and the approval policy
// stay in the MatOS CLI; nothing here mutates state.

import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord, stringOrNull } from '../services/matos-cli.js';

const RUNS_PER_LOCATION = Number(process.env.MATOS_EVOLUTION_OVERVIEW_MAX_RUNS || 400);
const MAX_HISTORY = 200;
const MAX_TEXT_CHARS = 600;
const MAX_DIFF_BYTES = 400 * 1024;

// Runs that changed (or would change) assets. Noop / failed / blocked runs
// never touched the live tree, so they stay out of the history.
const HISTORY_STATUSES = new Set([
  'accepted',
  'accepted_merged',
  'proposed',
  'rejected',
  'rolled_back',
]);
const LINEAGE_STATUSES = new Set(['accepted', 'accepted_merged', 'proposed', 'rejected']);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export interface EvolutionLocationSource {
  projectId: string | null;
  projectName: string | null;
  cwd: string;
}

export interface EvolutionRunJudge {
  verdict: string | null;
  confidence: number | null;
  reason: string | null;
  overfitRisk: string | null;
  pollutionRisk: string | null;
}

export interface EvolutionRunProposal {
  proposedAt: string | null;
  decision: string | null;
  decidedAt: string | null;
  note: string | null;
  lastApprovalError: string | null;
}

export interface EvolutionRunView {
  runId: string;
  projectId: string | null;
  projectName: string | null;
  status: string;
  statusReason: string | null;
  scope: string | null;
  scopeRef: string | null;
  triggerKind: string | null;
  triggerSummary: string | null;
  summary: string | null;
  expectedBehaviorChange: string | null;
  assetRefs: string[];
  changedFiles: string[];
  judge: EvolutionRunJudge | null;
  proposal: EvolutionRunProposal | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EvolutionLineageNode {
  runId: string | null;
  version: string | null;
  parentVersion: string | null;
  // 'base' marks the version the first edit started from.
  status: string;
  at: string | null;
  summary: string | null;
}

export interface EvolutionLineageBranch {
  projectId: string | null;
  projectName: string | null;
  scopeRef: string | null;
  nodes: EvolutionLineageNode[];
}

export interface EvolutionLineage {
  assetKey: string;
  acceptedCount: number;
  proposedCount: number;
  latestAt: string | null;
  branches: EvolutionLineageBranch[];
}

export interface EvolutionOverview {
  generatedAt: string;
  proposals: EvolutionRunView[];
  history: EvolutionRunView[];
  lineage: EvolutionLineage[];
}

export interface EvolutionRunSource {
  location: EvolutionLocationSource;
  record: unknown;
  diff: string | null;
}

function truncate(value: unknown, max = MAX_TEXT_CHARS): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function splitRef(ref: string): { key: string; version: string | null } | null {
  const match = /^([a-z][a-z0-9-]*):([^@\s]+)(?:@(\S+))?$/i.exec(ref.trim());
  if (!match) return null;
  return { key: `${match[1]}:${match[2]}`, version: match[3] ?? null };
}

// Refs the run actually changed: the import's observed refs when present,
// else what the editor reported.
function runAssetRefs(record: Record<string, unknown>): string[] {
  const evidence = isRecord(record.acceptanceEvidence) ? record.acceptanceEvidence : null;
  const observed = evidence && isRecord(evidence.observedChanges) ? evidence.observedChanges : null;
  const actual = strings(observed?.actualRefs);
  const editor = isRecord(record.editorOutput) ? record.editorOutput : null;
  const reported = [
    ...strings(record.createdAssets),
    ...strings(record.updatedAssets),
    ...strings(editor?.createdAssets),
    ...strings(editor?.updatedAssets),
  ];
  return [...new Set(actual.length > 0 ? actual : reported)];
}

export function evolutionRunView(
  location: EvolutionLocationSource,
  raw: unknown,
): EvolutionRunView | null {
  if (!isRecord(raw)) return null;
  const runId = stringOrNull(raw.runId);
  const status = stringOrNull(raw.status);
  if (!runId || !status) return null;
  const input = isRecord(raw.input) ? raw.input : null;
  const context = input && isRecord(input.currentEvolutionContext) ? input.currentEvolutionContext : null;
  const trigger = context && isRecord(context.trigger) ? context.trigger : null;
  const editor = isRecord(raw.editorOutput) ? raw.editorOutput : null;
  const acceptance = isRecord(raw.semanticAcceptance) ? raw.semanticAcceptance : null;
  const proposal = isRecord(raw.proposal) ? raw.proposal : null;
  return {
    runId,
    projectId: location.projectId,
    projectName: location.projectName,
    status,
    statusReason: stringOrNull(raw.statusReason),
    scope: stringOrNull(raw.scope),
    scopeRef: stringOrNull(input?.scopeRef),
    triggerKind: stringOrNull(trigger?.kind),
    triggerSummary: truncate(trigger?.summary),
    summary: truncate(editor?.summary),
    expectedBehaviorChange: truncate(editor?.expectedBehaviorChange),
    assetRefs: runAssetRefs(raw),
    changedFiles: strings(raw.importedTouchedPaths).length > 0
      ? strings(raw.importedTouchedPaths)
      : strings(raw.modifiedFiles),
    judge: acceptance
      ? {
          verdict: stringOrNull(acceptance.verdict),
          confidence: finiteOrNull(acceptance.confidence),
          reason: truncate(acceptance.reason),
          overfitRisk: stringOrNull(acceptance.overfitRisk),
          pollutionRisk: stringOrNull(acceptance.assetPollutionRisk),
        }
      : null,
    proposal: proposal
      ? {
          proposedAt: stringOrNull(proposal.proposedAt),
          decision: stringOrNull(proposal.decision),
          decidedAt: stringOrNull(proposal.decidedAt),
          note: truncate(proposal.note),
          lastApprovalError: truncate(proposal.lastApprovalError),
        }
      : null,
    createdAt: stringOrNull(raw.createdAt),
    updatedAt: stringOrNull(raw.updatedAt),
  };
}

interface AssetJsonChange {
  dirName: string;
  key: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  overlayOfVersion: string | null;
}

function jsonField(lines: string[], field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/** Version lineage from the asset.json hunks of a run's unified diff. */
export function assetJsonChangesFromDiff(diff: string): AssetJsonChange[] {
  const changes: AssetJsonChange[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const header = /^a\/(\S+) b\/(\S+)/.exec(section);
    const file = header?.[2];
    if (!file || path.posix.basename(file) !== 'asset.json') continue;
    const before: string[] = [];
    const after: string[] = [];
    for (const line of section.split('\n')) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) before.push(line);
      else if (line.startsWith('+')) after.push(line);
      else if (line.startsWith(' ')) {
        before.push(line);
        after.push(line);
      }
    }
    const type = jsonField(after, 'type') ?? jsonField(before, 'type');
    const id = jsonField(after, 'id') ?? jsonField(before, 'id');
    const overlayOf = jsonField(after, 'overlayOf');
    const isNew = /^new file mode/m.test(section);
    changes.push({
      dirName: path.posix.basename(path.posix.dirname(file)),
      key: type && id ? `${type}:${id}` : null,
      beforeVersion: isNew ? null : jsonField(before, 'version'),
      afterVersion: jsonField(after, 'version'),
      overlayOfVersion: overlayOf ? splitRef(overlayOf)?.version ?? null : null,
    });
  }
  return changes;
}

function lineageNodesForRun(
  view: EvolutionRunView,
  diff: string | null,
): Array<{ key: string; node: EvolutionLineageNode }> {
  const changes = diff ? assetJsonChangesFromDiff(diff) : [];
  const nodes: Array<{ key: string; node: EvolutionLineageNode }> = [];
  for (const ref of view.assetRefs) {
    const parsed = splitRef(ref);
    if (!parsed) continue;
    const id = parsed.key.slice(parsed.key.indexOf(':') + 1);
    const change =
      changes.find((item) => item.key === parsed.key) ??
      changes.find((item) => !item.key && item.dirName === id);
    nodes.push({
      key: parsed.key,
      node: {
        runId: view.runId,
        version: change?.afterVersion ?? parsed.version,
        parentVersion: change?.beforeVersion ?? change?.overlayOfVersion ?? null,
        status: view.status,
        at: view.updatedAt ?? view.createdAt,
        summary: view.summary,
      },
    });
  }
  return nodes;
}

function timeOf(value: string | null): number {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

export function buildEvolutionOverview(
  sources: EvolutionRunSource[],
  options: { nowMs?: number } = {},
): EvolutionOverview {
  const views: Array<{ view: EvolutionRunView; diff: string | null }> = [];
  for (const source of sources) {
    const view = evolutionRunView(source.location, source.record);
    if (view && HISTORY_STATUSES.has(view.status)) views.push({ view, diff: source.diff });
  }
  views.sort((a, b) => timeOf(b.view.updatedAt ?? b.view.createdAt) - timeOf(a.view.updatedAt ?? a.view.createdAt));

  const lineageByKey = new Map<string, Map<string, EvolutionLineageBranch>>();
  // Oldest first so each branch reads as a chain.
  for (const { view, diff } of [...views].reverse()) {
    if (!LINEAGE_STATUSES.has(view.status)) continue;
    for (const { key, node } of lineageNodesForRun(view, diff)) {
      const branches = lineageByKey.get(key) ?? new Map<string, EvolutionLineageBranch>();
      lineageByKey.set(key, branches);
      const branchKey = `${view.projectId ?? ''}|${view.scopeRef ?? ''}`;
      let branch = branches.get(branchKey);
      if (!branch) {
        branch = {
          projectId: view.projectId,
          projectName: view.projectName,
          scopeRef: view.scopeRef,
          nodes: node.parentVersion
            ? [{ runId: null, version: node.parentVersion, parentVersion: null, status: 'base', at: null, summary: null }]
            : [],
        };
        branches.set(branchKey, branch);
      }
      branch.nodes.push(node);
    }
  }

  const lineage: EvolutionLineage[] = [...lineageByKey.entries()].map(([assetKey, branches]) => {
    const nodes = [...branches.values()].flatMap((branch) => branch.nodes);
    const latestAt = nodes.reduce<string | null>(
      (latest, node) => (node.at && (!latest || node.at > latest) ? node.at : latest),
      null,
    );
    return {
      assetKey,
      acceptedCount: nodes.filter((node) => node.status === 'accepted' || node.status === 'accepted_merged').length,
      proposedCount: nodes.filter((node) => node.status === 'proposed').length,
      latestAt,
      branches: [...branches.values()],
    };
  });
  lineage.sort((a, b) => timeOf(b.latestAt) - timeOf(a.latestAt));

  return {
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    proposals: views.filter(({ view }) => view.status === 'proposed').map(({ view }) => view),
    history: views.slice(0, MAX_HISTORY).map(({ view }) => view),
    lineage,
  };
}

export function directEditorRunDir(cwd: string, runId: string): string | null {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  return path.join(cwd, '.matos', 'evolution', 'direct-editor', 'runs', runId);
}

async function readBoundedText(file: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_DIFF_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8'), truncated: size > MAX_DIFF_BYTES };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readLocationRuns(location: EvolutionLocationSource): Promise<EvolutionRunSource[]> {
  const runsRoot = path.join(location.cwd, '.matos', 'evolution', 'direct-editor', 'runs');
  let runIds: string[];
  try {
    runIds = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, RUNS_PER_LOCATION);
  } catch {
    return [];
  }
  const sources: EvolutionRunSource[] = [];
  for (let offset = 0; offset < runIds.length; offset += 32) {
    const batch = await Promise.all(
      runIds.slice(offset, offset + 32).map(async (runId) => {
        let record: unknown;
        try {
          record = JSON.parse(await readFile(path.join(runsRoot, runId, 'run.json'), 'utf8'));
        } catch {
          return null;
        }
        const status = isRecord(record) ? stringOrNull(record.status) : null;
        const diff = status && LINEAGE_STATUSES.has(status)
          ? (await readBoundedText(path.join(runsRoot, runId, 'diff.patch')))?.text ?? null
          : null;
        return { location, record, diff };
      }),
    );
    sources.push(...batch.filter((source): source is EvolutionRunSource => source !== null));
  }
  return sources;
}

export async function loadEvolutionOverview(
  locations: EvolutionLocationSource[],
): Promise<EvolutionOverview> {
  const seen = new Set<string>();
  const unique = locations.filter((location) => {
    const key = path.resolve(location.cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sources = (await Promise.all(unique.map(readLocationRuns))).flat();
  return buildEvolutionOverview(sources);
}

export async function readEvolutionRunDiff(
  cwd: string,
  runId: string,
): Promise<{ diff: string; truncated: boolean } | null> {
  const dir = directEditorRunDir(cwd, runId);
  if (!dir) return null;
  const result = await readBoundedText(path.join(dir, 'diff.patch'));
  return result ? { diff: result.text, truncated: result.truncated } : null;
}
