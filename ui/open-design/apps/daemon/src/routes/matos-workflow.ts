// MatOS Workflow Studio bridge.
//
// The canvas edits a project `*.workflow.json` file (or a workflow asset).
// This bridge lets the canvas toolbar validate, publish, and run that
// definition through the native `matos workflow ...` CLI without the web app
// knowing any workflow business logic:
//
//   validate  -> ensure a stable per-canvas draft, replace its definition,
//                return the native validation verdict (no asset side effect).
//   publish   -> same draft path, then `draft publish --id <workflow-id>` to
//                mint/refresh a workflow asset in the current scope.
//   run       -> `matos workflow run <ref> --detach` (validates, creates the
//                run, hands execution to a detached worker), returning the
//                run id immediately so the canvas can poll live status.
//   status    -> `matos workflow inspect <runId>` for the run poll loop —
//                inspect (not status) because only inspect carries node-level
//                statuses, attempts, timings, diagnostics, and approvals.
//   events    -> `matos workflow events <runId>` for the run event feed.
//   node      -> per-node attempt detail (full output/error payloads) served
//                from the same inspect view, fetched on demand.
//   control   -> cancel/pause/resume/retry-node/skip-node/approve/deny/
//                respond, each mapped 1:1 onto the native CLI verb.
//
// A canvas maps to one deterministic draft id (derived from cwd + label) so
// repeated validate/publish clicks reuse a single draft instead of leaking a
// new draft per click. Definitions are passed via a temp `--definition-file`
// (not argv) so large graphs never hit the command-line length limit.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { execMatOSJson, execMatOSJsonReport, isRecord, stringOrNull } from '../services/matos-cli.js';
import { matosProjectScope, type MatOSProjectScopeDeps } from '../services/matos-project-scope.js';

const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;

import type { WorkflowValidationDiagnostic, WorkflowValidationResult, WorkflowRunNodeSummary, WorkflowRunBudgetSummary, WorkflowRunApprovalSummary, WorkflowRunSummary, WorkflowRunEventSummary, WorkflowRunNodeDetail, WorkflowPublishSummary, WorkflowRunListRow } from '@open-design/contracts';
export type { WorkflowValidationDiagnostic, WorkflowValidationResult, WorkflowRunNodeSummary, WorkflowRunBudgetSummary, WorkflowRunApprovalSummary, WorkflowRunSummary, WorkflowRunEventSummary, WorkflowRunNodeDetail, WorkflowPublishSummary, WorkflowRunListRow } from '@open-design/contracts';

/**
 * Deterministic draft id for a canvas, so repeated validate/publish calls on
 * the same document reuse one draft. Kept to a safe id charset.
 */
export function workflowDraftIdFor(cwd: string, label: string): string {
  const hash = createHash('sha1').update(`${cwd}\u0000${label}`).digest('hex').slice(0, 12);
  return `od-canvas-${hash}`;
}

/**
 * Turn a workflow name into a registry-safe asset id
 * (`[a-z0-9][a-z0-9._-]*`), falling back to a stable default.
 */
export function sanitizeWorkflowId(name: string): string {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const trimmed = slug.replace(/^[^a-z0-9]+/, '');
  return trimmed || 'canvas-workflow';
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a `draft replace-definition`/`draft compile` JSON payload into the
 * validation shape the canvas renders. Tolerant of the two native shapes:
 * `{ validation: {...} }` (mutation commands) and the compile result that
 * carries `ok`/`diagnostics`/`metadata` at the top level.
 */
export function normalizeWorkflowValidation(payload: unknown): WorkflowValidationResult {
  const root = isRecord(payload) ? payload : {};
  const validation = isRecord(root.validation) ? root.validation : root;
  const ok = validation.ok === true;
  const errorsRaw = Array.isArray(validation.errors) ? validation.errors : [];
  const errors = errorsRaw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const message = stringOrNull(entry.message);
      if (!message) return null;
      return { code: stringOrNull(entry.code) ?? 'error', message };
    })
    .filter((entry): entry is { code: string; message: string } => entry !== null);
  const diagnosticsRaw = Array.isArray(validation.diagnostics)
    ? validation.diagnostics
    : Array.isArray(root.diagnostics)
      ? root.diagnostics
      : [];
  const diagnostics = diagnosticsRaw
    .map((entry): WorkflowValidationDiagnostic | null => {
      if (!isRecord(entry)) return null;
      const message = stringOrNull(entry.message);
      if (!message) return null;
      return {
        severity: stringOrNull(entry.severity) ?? 'error',
        code: stringOrNull(entry.code) ?? 'diagnostic',
        message,
        nodeId: stringOrNull(entry.nodeId),
      };
    })
    .filter((entry): entry is WorkflowValidationDiagnostic => entry !== null);
  const metadata = isRecord(root.metadata) ? root.metadata : {};
  return {
    ok,
    errors,
    diagnostics,
    workflowRef: stringOrNull(root.workflowRef),
    nodeCount: toNumberOrNull(metadata.nodeCount),
    risk: stringOrNull(metadata.risk),
  };
}

/**
 * The native draft store keeps drafts always-valid: `draft replace-definition`
 * on an invalid definition exits 1 with
 * `Invalid workflow draft definition: <msg>; <msg>; ...` on stderr instead of
 * returning a `--json` verdict. For the canvas that hard failure IS the
 * validation result (the graph is simply still incomplete), so parse it back
 * into the structured shape the run strip renders. Returns null for anything
 * that is not that specific rejection.
 */
export function workflowValidationFromMutationRejection(
  message: string,
): WorkflowValidationResult | null {
  const marker = 'Invalid workflow draft definition:';
  const index = message.indexOf(marker);
  if (index < 0) return null;
  const errors = message
    .slice(index + marker.length)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ code: 'invalid_definition', message: entry }));
  return {
    ok: false,
    errors: errors.length > 0 ? errors : [{ code: 'invalid_definition', message: 'workflow validation failed' }],
    diagnostics: [],
    workflowRef: null,
    nodeCount: null,
    risk: null,
  };
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Short human-readable message out of a node `error` payload of any shape. */
export function errorMessageOf(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error.trim() ? error : null;
  if (isRecord(error)) {
    const message = stringOrNull(error.message) ?? stringOrNull(error.error);
    if (message) return message;
  }
  try {
    const encoded = JSON.stringify(error);
    return encoded && encoded !== '{}' ? encoded.slice(0, 400) : null;
  } catch {
    return null;
  }
}

const SETTLED_NODE_STATUSES = new Set([
  'completed',
  'succeeded',
  'failed',
  'error',
  'skipped',
  'cancelled',
  'canceled',
]);

/**
 * Node run snapshots carry `startedAt` + `updatedAt` (no `finishedAt`), so for
 * settled nodes the last update is the end time; only still-running nodes get
 * a live now() duration. Falling back to now() for settled nodes would make
 * their duration keep growing with every poll.
 */
function nodeDurationMs(entry: Record<string, unknown>, status: string): number | null {
  const started = stringOrNull(entry.startedAt);
  if (!started) return null;
  const startMs = Date.parse(started);
  if (!Number.isFinite(startMs)) return null;
  const finished = stringOrNull(entry.finishedAt) ?? stringOrNull(entry.updatedAt);
  const settled = SETTLED_NODE_STATUSES.has(status.toLowerCase());
  const endMs = settled
    ? finished
      ? Date.parse(finished)
      : Number.NaN
    : Date.now();
  if (!Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function normalizeRunNode(entry: unknown): WorkflowRunNodeSummary | null {
  if (!isRecord(entry)) return null;
  const nodeId = stringOrNull(entry.nodeId) ?? stringOrNull(entry.id);
  if (!nodeId) return null;
  const status = stringOrNull(entry.status) ?? 'pending';
  return {
    nodeId,
    status,
    attempts: toFiniteOrNull(entry.attempts),
    startedAt: stringOrNull(entry.startedAt),
    finishedAt: stringOrNull(entry.finishedAt) ?? stringOrNull(entry.updatedAt),
    durationMs: nodeDurationMs(entry, status),
    error: errorMessageOf(entry.error),
  };
}

/**
 * Normalize `workflow run --detach`/`workflow inspect` JSON into the poll
 * shape the canvas renders. Node `output` payloads are intentionally dropped
 * here (they can be huge); the per-node detail route serves them on demand.
 */
export function normalizeWorkflowRun(payload: unknown): WorkflowRunSummary {
  const root = isRecord(payload) ? payload : {};
  const run = isRecord(root.run) ? root.run : root;
  const nodesRaw = Array.isArray(run.nodes) ? run.nodes : [];
  const nodes = nodesRaw
    .map(normalizeRunNode)
    .filter((entry): entry is WorkflowRunNodeSummary => entry !== null);
  if (isRecord(run.graph) && Array.isArray(run.graph.nodes)) {
    const existing = new Set(nodes.map((node) => node.nodeId));
    for (const entry of run.graph.nodes) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || existing.has(entry.id)) continue;
      nodes.push({ nodeId: entry.id, status: 'pending', attempts: 0, startedAt: null, finishedAt: null, durationMs: null, error: null });
      existing.add(entry.id);
    }
    const order = new Map(run.graph.nodes.filter(isRecord).map((node, index) => [node.id, index]));
    nodes.sort((left, right) => (order.get(left.nodeId) ?? Infinity) - (order.get(right.nodeId) ?? Infinity));
  }

  const diagnostics = isRecord(run.diagnostics) ? run.diagnostics : {};
  const activeNodeIds = Array.isArray(diagnostics.activeNodeIds)
    ? diagnostics.activeNodeIds.filter((id): id is string => typeof id === 'string')
    : nodes.filter((node) => node.status === 'running').map((node) => node.nodeId);

  const approvalsRaw = Array.isArray(run.pendingApprovals) ? run.pendingApprovals : [];
  const pendingApprovals = approvalsRaw
    .map((entry): WorkflowRunApprovalSummary | null => {
      if (!isRecord(entry)) return null;
      const nodeId = stringOrNull(entry.nodeId);
      if (!nodeId) return null;
      return {
        nodeId,
        status: stringOrNull(entry.status) ?? 'pending',
        fingerprint: stringOrNull(entry.actionFingerprint),
        requestedAt: stringOrNull(entry.requestedAt),
      };
    })
    .filter((entry): entry is WorkflowRunApprovalSummary => entry !== null);

  const budgetRaw = isRecord(run.budget) ? run.budget : null;
  const totals = budgetRaw && isRecord(budgetRaw.totals) ? budgetRaw.totals : null;
  const budget: WorkflowRunBudgetSummary | null = totals
    ? {
        totalTokens: toFiniteOrNull(totals.totalTokens),
        totalCostUsd: toFiniteOrNull(totals.totalCostUsd),
        wallTimeMs: toFiniteOrNull(totals.wallTimeMs),
        elapsedWallTimeMs: toFiniteOrNull(totals.elapsedWallTimeMs),
        agentCalls: toFiniteOrNull(totals.agentCalls),
        toolCalls: toFiniteOrNull(totals.toolCalls),
      }
    : null;

  return {
    runId: stringOrNull(run.runId) ?? stringOrNull(run.id),
    workflowRef: stringOrNull(run.workflowRef),
    workflowName: stringOrNull(run.workflowName),
    ...(isRecord(run.graph) && Array.isArray(run.graph.nodes) && Array.isArray(run.graph.edges) ? {
      graph: {
        nodes: run.graph.nodes.filter(isRecord).filter((node) => typeof node.id === 'string' && typeof node.type === 'string').map((node) => ({
          id: String(node.id), type: String(node.type),
          ...(typeof node.label === 'string' ? { label: node.label } : {}),
          dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.filter((id): id is string => typeof id === 'string') : [],
        })),
        edges: run.graph.edges.filter(isRecord).filter((edge) => typeof edge.from === 'string' && typeof edge.to === 'string').map((edge) => ({
          from: String(edge.from), to: String(edge.to),
          ...(typeof edge.route === 'string' ? { route: edge.route } : {}),
          ...(typeof edge.condition === 'string' ? { condition: edge.condition } : {}),
        })),
      },
    } : {}),
    status: stringOrNull(run.status),
    waitingNodeId: stringOrNull(run.waitingNodeId),
    nodes,
    activeNodeIds,
    pendingApprovals,
    budget,
    outputs: isRecord(run.outputs) && Object.keys(run.outputs).length > 0 ? run.outputs : null,
    ...(root.detached === true ? { detached: true } : {}),
  };
}

/** Normalize `workflow events` JSON into the event feed shape. */
export function normalizeWorkflowEvents(payload: unknown): WorkflowRunEventSummary[] {
  const root = isRecord(payload) ? payload : {};
  const eventsRaw = Array.isArray(root.events) ? root.events : [];
  return eventsRaw
    .map((entry): WorkflowRunEventSummary | null => {
      if (!isRecord(entry)) return null;
      const type = stringOrNull(entry.type);
      if (!type) return null;
      const data = isRecord(entry.data) ? entry.data : null;
      return {
        id: stringOrNull(entry.id),
        timestamp: stringOrNull(entry.timestamp),
        type,
        nodeId: data ? (stringOrNull(data.nodeId) ?? null) : null,
        data,
      };
    })
    .filter((entry): entry is WorkflowRunEventSummary => entry !== null);
}

/** Pick one node's full detail (output/error included) from an inspect view. */
export function pickWorkflowNodeDetail(
  payload: unknown,
  nodeId: string,
): WorkflowRunNodeDetail | null {
  const root = isRecord(payload) ? payload : {};
  const run = isRecord(root.run) ? root.run : root;
  const nodesRaw = Array.isArray(run.nodes) ? run.nodes : [];
  for (const entry of nodesRaw) {
    if (!isRecord(entry)) continue;
    const id = stringOrNull(entry.nodeId) ?? stringOrNull(entry.id);
    if (id !== nodeId) continue;
    const status = stringOrNull(entry.status) ?? 'pending';
    return {
      nodeId,
      status,
      attempts: toFiniteOrNull(entry.attempts),
      startedAt: stringOrNull(entry.startedAt),
      finishedAt: stringOrNull(entry.finishedAt) ?? stringOrNull(entry.updatedAt),
      durationMs: nodeDurationMs(entry, status),
      output: entry.output,
      error: entry.error,
    };
  }
  return null;
}

/** Normalize `draft publish` JSON into the published-asset shape. */
export function normalizeWorkflowPublish(payload: unknown): WorkflowPublishSummary {
  const root = isRecord(payload) ? payload : {};
  const sync = isRecord(root.scopedGiteaSync) ? root.scopedGiteaSync : null;
  if (sync && (sync.ok !== true || sync.action === 'failed' || sync.activationRequired === true)) {
    throw new Error('Workflow publication failed: no accepted runtime asset; repair the scoped asset source and publish again.');
  }
  const published = isRecord(root.published) ? root.published : root;
  const assetKey = stringOrNull(published.assetKey);
  const id = stringOrNull(published.id);
  const version = stringOrNull(published.version);
  const workflowRef = assetKey
    ? assetKey.startsWith('workflow:')
      ? assetKey
      : `workflow:${assetKey}`
    : id
      ? `workflow:${id}${version ? `@${version}` : ''}`
      : null;
  return { assetKey, workflowRef };
}

/** `{ key: value }` -> `["--param", "key=value", ...]` for the CLI. */
export function parametersToArgs(parameters: unknown): string[] {
  if (!isRecord(parameters)) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (!key) continue;
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    args.push('--param', `${key}=${encoded}`);
  }
  return args;
}

function assetRefPattern(value: string): boolean {
  return /^workflow:[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.+-]+)?$/.test(value);
}

const draftWrites = new Map<string, Promise<unknown>>();
async function withCanvasDraft<T>(cwd: string, label: string, action: () => Promise<T>): Promise<T> {
  const key = workflowDraftIdFor(cwd, label);
  const previous = draftWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  draftWrites.set(key, next);
  try { return await next; } finally {
    if (draftWrites.get(key) === next) draftWrites.delete(key);
  }
}

function sendError(res: Response, status: number, message: string): void {
  const conflict = message.includes('WORKFLOW_DRAFT_CONFLICT:');
  res.status(conflict ? 409 : status).json({ error: { code: conflict ? 'WORKFLOW_DRAFT_CONFLICT' : 'MATOS_WORKFLOW', message } });
}

async function draftExists(draftId: string, cwd: string): Promise<boolean> {
  try {
    await execMatOSJson(['workflow', 'draft', 'show', draftId, '--json'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the canvas's deterministic draft exists and holds `definition`,
 * returning the native validation verdict from the replace. Writes the
 * definition to a temp file under the MatOS cwd (never argv) and cleans it up.
 */
async function syncCanvasDraft(input: {
  cwd: string;
  label: string;
  definition: unknown;
  name?: string;
}): Promise<{ draftId: string; definitionDigest?: string; validation: WorkflowValidationResult }> {
  const draftId = workflowDraftIdFor(input.cwd, input.label);
  const tmpDir = path.join(input.cwd, '.matos', 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${draftId}.${randomUUID()}.definition.json`);
  try {
    await writeFile(tmpFile, JSON.stringify(input.definition), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (!(await draftExists(draftId, input.cwd))) {
      await execMatOSJson([
        'workflow',
        'draft',
        'create',
        '--id',
        draftId,
        ...(input.name ? ['--name', input.name] : []),
        '--json',
      ], { cwd: input.cwd });
    }
    let replacePayload: unknown;
    try {
      replacePayload = await execMatOSJson([
        'workflow',
        'draft',
        'replace-definition',
        draftId,
        '--definition-file',
        tmpFile,
        '--json',
      ], { cwd: input.cwd });
    } catch (error) {
      // An incomplete canvas graph (agent node without role yet, …) is a
      // normal validate outcome, not a bridge failure.
      const rejected = workflowValidationFromMutationRejection(
        error instanceof Error ? error.message : String(error),
      );
      if (rejected) return { draftId, validation: rejected };
      throw error;
    }
    const definitionDigest = isRecord(replacePayload) ? stringOrNull(replacePayload.definitionDigest) : null;
    return { draftId, ...(definitionDigest ? { definitionDigest } : {}), validation: normalizeWorkflowValidation(replacePayload) };
  } finally {
    await rm(tmpFile, { force: true });
  }
}

export function registerMatOSWorkflowRoutes(app: Express, deps: MatOSProjectScopeDeps = {}): void {
  const scope = (req: Request) => matosProjectScope(req.query.projectId, deps);
  // Validate a canvas definition (no asset side effect).
  app.post('/api/matos/workflow/validate', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const definition = body.definition;
      if (!isRecord(definition)) {
        sendError(res, 400, 'definition must be an object');
        return;
      }
      if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > MAX_DEFINITION_BYTES) {
        sendError(res, 413, 'definition too large');
        return;
      }
      const label = stringOrNull(body.label) ?? 'canvas';
      const name = stringOrNull((definition as Record<string, unknown>).name);
      const { cwd } = await scope(req);
      const { validation } = await withCanvasDraft(cwd, label, () => syncCanvasDraft({
        cwd,
        label,
        definition,
        ...(name ? { name } : {}),
      }));
      res.json({ validation });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Validate, then publish the definition into a workflow asset in the current
  // scope. The published asset is what `run` executes.
  app.post('/api/matos/workflow/publish', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const definition = body.definition;
      if (!isRecord(definition)) {
        sendError(res, 400, 'definition must be an object');
        return;
      }
      if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > MAX_DEFINITION_BYTES) {
        sendError(res, 413, 'definition too large');
        return;
      }
      const label = stringOrNull(body.label) ?? 'canvas';
      const defName = stringOrNull((definition as Record<string, unknown>).name);
      // Native and scoped-Gitea publishers store one directory per asset ID.
      // A content-addressed ID keeps a later publish from replacing a ref
      // between this response, preflight and the detached run's snapshot.
      const revision = createHash('sha256').update(JSON.stringify([definition, body.version ?? null, body.description ?? null])).digest('hex').slice(0, 16);
      const { cwd } = await scope(req);
      const workflowId = `${sanitizeWorkflowId(stringOrNull(body.id) ?? defName ?? label)}-${workflowDraftIdFor(cwd, label).slice(-12)}-${revision}`;
      await withCanvasDraft(cwd, label, async () => {
      const { draftId, definitionDigest, validation } = await syncCanvasDraft({
        cwd,
        label,
        definition,
        ...(defName ? { name: defName } : {}),
      });
      if (!validation.ok) {
        res.json({ validation, published: null });
        return;
      }
      if (!definitionDigest) {
        throw new Error('Workflow publication requires a native CLI with draft revision checks. Update the MatOS runtime and retry.');
      }
      const publishPayload = await execMatOSJson([
        'workflow',
        'draft',
        'publish',
        draftId,
        '--expected-definition',
        definitionDigest,
        '--id',
        workflowId,
        ...(defName ? ['--name', defName] : []),
        '--version', stringOrNull(body.version) ?? `0.1.0-canvas.${revision}`,
        ...(stringOrNull(body.description) ? ['--description', String(body.description)] : []),
        '--json',
      ], { cwd });
      res.json({ validation, published: normalizeWorkflowPublish(publishPayload) });
      });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.post('/api/matos/workflow/preflight', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = stringOrNull(body.ref);
      if (!ref || !assetRefPattern(ref)) return sendError(res, 400, 'invalid workflow ref');
      const { cwd } = await scope(req);
      const report = await execMatOSJsonReport(['workflow', 'preflight', ref, ...parametersToArgs(body.parameters), '--json'], { cwd });
      const result = isRecord(report) ? report : {};
      res.json({ preflight: {
        runnable: result.runnable === true,
        issues: Array.isArray(result.issues) ? result.issues.filter(isRecord).map((issue) => ({
          code: stringOrNull(issue.code) ?? 'preflight', severity: stringOrNull(issue.severity) ?? 'error',
          message: stringOrNull(issue.message) ?? 'Preflight failed',
          ...(stringOrNull(issue.nodeId) ? { nodeId: String(issue.nodeId) } : {}),
        })) : [],
      } });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Run a published workflow asset. `--detach` creates the run and hands
  // execution to a detached background worker, so this returns the run id
  // immediately and the canvas polls live node-level progress.
  app.post('/api/matos/workflow/run', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = stringOrNull(body.ref);
      if (!ref || !assetRefPattern(ref)) {
        sendError(res, 400, 'ref must be a workflow asset ref (e.g. workflow:my-flow)');
        return;
      }
      const { cwd } = await scope(req);
      const payload = await execMatOSJson([
        'workflow',
        'run',
        ref,
        ...parametersToArgs(body.parameters),
        '--detach',
        '--json',
      ], { cwd });
      res.json({ run: normalizeWorkflowRun(payload) });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Recent runs (summary rows) so the canvas can discover and attach to runs
  // started elsewhere (agent tools, CLI, triggers) — not just the ones this
  // browser tab launched. `?query=` filters by runId/workflowRef substring.
  app.get('/api/matos/workflow/runs', (req: Request, res: Response) => {
    void (async () => {
      const query = stringOrNull(req.query.query);
      // The query lands in the CLI argv as a positional; a leading dash
      // would be parsed as a flag (argument injection) instead of a filter.
      if (query && query.startsWith('-')) {
        sendError(res, 400, "query must not start with '-'");
        return;
      }
      const { cwd } = await scope(req);
      const payload = await cachedPollExec(cwd, `runs:${query ?? ''}`, [
        'workflow',
        'runs',
        ...(query ? [query] : []),
        '--json',
      ]);
      const root = isRecord(payload) ? payload : {};
      const rows = Array.isArray(root.runs) ? root.runs : [];
      const runs = rows
        .map((entry): WorkflowRunListRow | null => {
          if (!isRecord(entry)) return null;
          const runId = stringOrNull(entry.runId);
          if (!runId) return null;
          return {
            runId,
            workflowRef: stringOrNull(entry.workflowRef),
            status: stringOrNull(entry.status) ?? 'unknown',
            createdAt: stringOrNull(entry.createdAt),
            updatedAt: stringOrNull(entry.updatedAt),
            waitingNodeId: stringOrNull(entry.waitingNodeId),
          };
        })
        .filter((entry): entry is WorkflowRunListRow => entry !== null);
      res.json({ runs });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Poll a run: inspect carries node statuses/attempts/timings, active node
  // ids, pending approvals, and the budget ledger (status does not).
  app.get('/api/matos/workflow/run/:runId', (req: Request, res: Response) => {
    void (async () => {
      const runId = validRunId(req.params.runId);
      if (!runId) {
        sendError(res, 400, 'invalid run id');
        return;
      }
      const { cwd } = await scope(req);
      const payload = await cachedPollExec(cwd, `inspect:${runId}`, [
        'workflow',
        'inspect',
        runId,
        '--json',
      ]);
      res.json({ run: normalizeWorkflowRun(payload) });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Run event feed (`events.jsonl` projection). `?tail=<n>` keeps polls light.
  app.get('/api/matos/workflow/run/:runId/events', (req: Request, res: Response) => {
    void (async () => {
      const runId = validRunId(req.params.runId);
      if (!runId) {
        sendError(res, 400, 'invalid run id');
        return;
      }
      const tail = req.query.tail === undefined ? 200 : Number(req.query.tail);
      if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
        sendError(res, 400, 'tail must be an integer between 1 and 1000');
        return;
      }
      const { cwd } = await scope(req);
      const payload = await cachedPollExec(cwd, `events:${runId}:${tail}`, [
        'workflow',
        'events',
        runId,
        '--tail',
        String(tail),
        '--json',
      ]);
      const events = normalizeWorkflowEvents(payload);
      res.json({ events });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // One node's full run detail (output/error payloads) fetched on demand so
  // the poll loop stays light.
  app.get('/api/matos/workflow/run/:runId/node/:nodeId', (req: Request, res: Response) => {
    void (async () => {
      const runId = validRunId(req.params.runId);
      const nodeId = String(req.params.nodeId ?? '').trim();
      if (!runId || !nodeId) {
        sendError(res, 400, 'invalid run or node id');
        return;
      }
      // Reuses the poll cache: a node-detail click right after a poll serves
      // from the same inspect payload instead of spawning another CLI.
      const { cwd } = await scope(req);
      const payload = await cachedPollExec(cwd, `inspect:${runId}`, [
        'workflow',
        'inspect',
        runId,
        '--json',
      ]);
      const node = pickWorkflowNodeDetail(payload, nodeId);
      if (!node) {
        sendError(res, 404, `node ${nodeId} has no run record yet`);
        return;
      }
      res.json({ node });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Run lifecycle controls, each mapped 1:1 onto a native CLI verb.
  app.post('/api/matos/workflow/run/:runId/fork', (req: Request, res: Response) => {
    void (async () => {
      const runId = validRunId(req.params.runId);
      if (!runId) { sendError(res, 400, 'invalid run id'); return; }
      const { cwd } = await scope(req);
      const payload = await execMatOSJson(['workflow', 'fork', runId, '--json'], { cwd });
      if (!isRecord(payload) || !isRecord(payload.draft) || !isRecord(payload.definition)
        || typeof payload.draft.draftId !== 'string') throw new Error('Native workflow fork did not return a definition');
      res.json({ draftId: payload.draft.draftId, definition: payload.definition } satisfies import('@open-design/contracts').WorkflowForkSummary);
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.post('/api/matos/workflow/run/:runId/control', (req: Request, res: Response) => {
    void (async () => {
      const runId = validRunId(req.params.runId);
      if (!runId) {
        sendError(res, 400, 'invalid run id');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = stringOrNull(body.action);
      const args = controlArgs(runId, action, body);
      if (!args) {
        sendError(res, 400, `unsupported control action: ${action ?? '(missing)'}`);
        return;
      }
      const { cwd } = await scope(req);
      // A retry/resume may exit 1 with a valid failed-run report. Keep the
      // inspect view authoritative so users can see the actual node failure.
      const report = await execMatOSJsonReport(args, { cwd });
      if (isRecord(report) && (report.ok === false || typeof report.error === 'string')) {
        throw new Error(stringOrNull(report.error) ?? 'Workflow control was rejected');
      }
      // Always answer with a fresh inspect view so the canvas state is
      // consistent no matter which verb ran; drop cached polls so the next
      // poll cannot serve the pre-mutation state.
      invalidatePollCache(cwd, runId);
      const payload = await execMatOSJson(['workflow', 'inspect', runId, '--json'], { cwd });
      res.json({ run: normalizeWorkflowRun(payload) });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });
}

function validRunId(raw: unknown): string | null {
  const runId = String(raw ?? '').trim();
  return runId && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId) ? runId : null;
}

// Short-TTL poll dedupe: every canvas tab polls inspect+events every 1.5s and
// each poll spawns a full MatOS CLI process (bun startup + run-dir reads).
// Coalescing concurrent/rapid polls into one in-flight invocation keeps the
// daemon's CLI fan-out proportional to distinct runs, not open tabs. Control
// verbs bypass and invalidate this cache so mutations are never served stale.
const POLL_CACHE_TTL_MS = 1_000;
const POLL_CACHE_MAX_ENTRIES = 256;
const pollCache = new Map<string, { at: number; promise: Promise<unknown> }>();

function cachedPollExec(cwd: string, action: string, args: string[]): Promise<unknown> {
  const key = JSON.stringify([cwd, action]);
  const now = Date.now();
  const hit = pollCache.get(key);
  if (hit && now - hit.at < POLL_CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = execMatOSJson(args, { cwd });
  // Failed polls must not be cached; the next poll should retry the CLI.
  promise.catch(() => { if (pollCache.get(key)?.promise === promise) pollCache.delete(key); });
  if (pollCache.size >= POLL_CACHE_MAX_ENTRIES) {
    const oldest = pollCache.keys().next().value;
    if (oldest !== undefined) {
      pollCache.delete(oldest);
    }
  }
  pollCache.set(key, { at: now, promise });
  return promise;
}

function invalidatePollCache(cwd: string, runId: string): void {
  pollCache.delete(JSON.stringify([cwd, `inspect:${runId}`]));
  pollCache.delete(JSON.stringify([cwd, `events:${runId}`]));
  // Runs-list entries embed this run's status row; drop them too so the
  // picker cannot show the pre-mutation status for the next TTL window.
  for (const key of pollCache.keys()) {
    const [entryCwd, action] = JSON.parse(key) as string[];
    if (entryCwd === cwd && (action?.startsWith('runs:') || action?.startsWith(`events:${runId}:`))) {
      pollCache.delete(key);
    }
  }
}

/**
 * Whitelisted control verbs -> `matos workflow ...` argv. Returns null for
 * anything outside the map so arbitrary CLI args can never be injected.
 */
export function controlArgs(
  runId: string,
  action: string | null,
  body: Record<string, unknown>,
): string[] | null {
  const nodeId = stringOrNull(body.nodeId);
  const message = stringOrNull(body.message);
  const reason = stringOrNull(body.reason);
  const fingerprint = stringOrNull(body.fingerprint);
  switch (action) {
    case 'cancel':
    case 'pause':
    case 'resume':
      return ['workflow', action, runId, '--json'];
    case 'retry-node':
      return nodeId ? ['workflow', 'retry-node', runId, '--node', nodeId, '--json'] : null;
    case 'skip-node':
      return nodeId ? ['workflow', 'skip-node', runId, '--node', nodeId, '--json'] : null;
    case 'approve':
      return nodeId
        ? [
            'workflow',
            'approve',
            runId,
            '--node',
            nodeId,
            ...(fingerprint ? ['--fingerprint', fingerprint] : []),
            ...(message ? ['--message', message] : []),
            '--json',
          ]
        : null;
    case 'deny':
      return nodeId
        ? [
            'workflow',
            'deny',
            runId,
            '--node',
            nodeId,
            ...(reason ? ['--reason', reason] : []),
            '--json',
          ]
        : null;
    case 'respond':
      return nodeId && message !== null
        ? ['workflow', 'respond', runId, '--node', nodeId, '--message', message, '--json']
        : null;
    default:
      return null;
  }
}
