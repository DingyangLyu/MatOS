// Client for the daemon's MatOS Workflow Studio bridge
// (`apps/daemon/src/routes/matos-workflow.ts`). The canvas toolbar uses these
// to validate, publish, and run the workflow definition it is editing, and to
// poll a launched run (node statuses, events, budget, approvals) plus drive
// run lifecycle controls. All workflow business logic stays in the daemon/CLI.

import type { WorkflowValidationResult, WorkflowRunSummary, WorkflowRunEventSummary, WorkflowRunNodeDetail, WorkflowPublishSummary, WorkflowRunListRow, WorkflowPreflight } from '@open-design/contracts';
export type { WorkflowValidationDiagnostic, WorkflowValidationResult, WorkflowRunNodeSummary, WorkflowRunBudgetSummary, WorkflowRunApprovalSummary, WorkflowRunSummary, WorkflowRunEventSummary, WorkflowRunNodeDetail, WorkflowPublishSummary, WorkflowRunListRow, WorkflowPreflight } from '@open-design/contracts';
export type WorkflowControlAction =
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'retry-node'
  | 'skip-node'
  | 'approve'
  | 'deny'
  | 'respond';

export interface WorkflowScope { projectId?: string | null; signal?: AbortSignal }
function scopedUrl(url: string, scope?: WorkflowScope): string {
  if (!scope?.projectId) return url;
  if (!/^[\w-]{1,128}$/.test(scope.projectId)) throw new Error('Invalid project ID');
  return `${url}${url.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(scope.projectId)}`;
}

const EMPTY_RUN: WorkflowRunSummary = {
  runId: null,
  status: null,
  waitingNodeId: null,
  nodes: [],
  activeNodeIds: [],
  pendingApprovals: [],
  budget: null,
  outputs: null,
};

export async function preflightWorkflowRef(ref: string, parameters: Record<string, unknown>, scope?: WorkflowScope): Promise<WorkflowPreflight> {
  const result = await postJson<{ preflight: WorkflowPreflight }>(scopedUrl('/api/matos/workflow/preflight', scope), { ref, parameters });
  return result.preflight;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await resp.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!resp.ok) {
    const message =
      payload && typeof payload === 'object' && payload.error?.message
        ? payload.error.message
        : `Request failed (${resp.status})`;
    throw new Error(message);
  }
  return payload as T;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(30_000);
  const resp = await fetch(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const payload = (await resp.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!resp.ok) {
    const message =
      payload && typeof payload === 'object' && payload.error?.message
        ? payload.error.message
        : `Request failed (${resp.status})`;
    throw new Error(message);
  }
  return payload as T;
}

/** Validate a canvas definition (no asset side effect). */
export async function validateWorkflowDefinition(
  definition: unknown,
  label: string,
  scope?: WorkflowScope,
): Promise<WorkflowValidationResult> {
  const { validation } = await postJson<{ validation: WorkflowValidationResult }>(
    scopedUrl('/api/matos/workflow/validate', scope),
    { definition, label },
  );
  return validation;
}

/**
 * Validate then publish the definition into a workflow asset. When validation
 * fails, `published` is null and the caller should surface `validation`.
 */
export async function publishWorkflowDefinition(input: {
  definition: unknown;
  label: string;
  id?: string;
  version?: string;
  description?: string;
}, scope?: WorkflowScope): Promise<{ validation: WorkflowValidationResult; published: WorkflowPublishSummary | null }> {
  return postJson(scopedUrl('/api/matos/workflow/publish', scope), input);
}

/**
 * Start a published workflow asset. The daemon launches it detached, so this
 * returns as soon as the run is created; poll with fetchWorkflowRunStatus.
 */
export async function runWorkflowRef(
  ref: string,
  parameters?: Record<string, unknown>,
  scope?: WorkflowScope,
): Promise<WorkflowRunSummary> {
  const { run } = await postJson<{ run: WorkflowRunSummary }>(scopedUrl('/api/matos/workflow/run', scope), {
    ref,
    parameters,
  });
  return run ?? EMPTY_RUN;
}

/** List recent workflow runs (attach-run menu in the editor). */
export async function fetchWorkflowRuns(query?: string, scope?: WorkflowScope): Promise<WorkflowRunListRow[]> {
  const { runs } = await getJson<{ runs?: WorkflowRunListRow[] }>(
    scopedUrl(`/api/matos/workflow/runs${query ? `?query=${encodeURIComponent(query)}` : ''}`, scope), scope?.signal,
  );
  return runs ?? [];
}

/** Copy the native pinned graph, never reconstruct executable nodes from a preview. */
export async function forkWorkflowRun(runId: string, scope?: WorkflowScope): Promise<import('@open-design/contracts').WorkflowForkSummary> {
  return postJson(scopedUrl(`/api/matos/workflow/run/${encodeURIComponent(runId)}/fork`, scope), {});
}

/** Poll a run's live view (node statuses, approvals, budget, outputs). */
export async function fetchWorkflowRunStatus(runId: string, scope?: WorkflowScope): Promise<WorkflowRunSummary> {
  const { run } = await getJson<{ run?: WorkflowRunSummary }>(
    scopedUrl(`/api/matos/workflow/run/${encodeURIComponent(runId)}`, scope), scope?.signal,
  );
  return run ?? { ...EMPTY_RUN, runId };
}

/** Fetch the run's event feed (most recent `tail` entries). */
export async function fetchWorkflowRunEvents(
  runId: string,
  tail = 200,
  scope?: WorkflowScope,
): Promise<WorkflowRunEventSummary[]> {
  const { events } = await getJson<{ events?: WorkflowRunEventSummary[] }>(
    scopedUrl(`/api/matos/workflow/run/${encodeURIComponent(runId)}/events?tail=${tail}`, scope), scope?.signal,
  );
  return events ?? [];
}

/** Fetch one node's full run detail (output/error payloads). */
export async function fetchWorkflowRunNodeDetail(
  runId: string,
  nodeId: string,
  scope?: WorkflowScope,
): Promise<WorkflowRunNodeDetail> {
  const { node } = await getJson<{ node?: WorkflowRunNodeDetail }>(
    scopedUrl(`/api/matos/workflow/run/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}`, scope), scope?.signal,
  );
  if (!node) throw new Error(`node ${nodeId} has no run record yet`);
  return node;
}

/** Drive a run lifecycle control; resolves to the refreshed run view. */
export async function controlWorkflowRun(
  runId: string,
  action: WorkflowControlAction,
  options?: { nodeId?: string; message?: string; reason?: string; fingerprint?: string },
  scope?: WorkflowScope,
): Promise<WorkflowRunSummary> {
  const { run } = await postJson<{ run: WorkflowRunSummary }>(
    scopedUrl(`/api/matos/workflow/run/${encodeURIComponent(runId)}/control`, scope),
    { action, ...options },
  );
  return run ?? { ...EMPTY_RUN, runId };
}

/** Terminal run states that stop the status poll loop. */
export const WORKFLOW_TERMINAL_STATUSES = new Set([
  'succeeded',
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled',
]);

export function isTerminalWorkflowStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && WORKFLOW_TERMINAL_STATUSES.has(status.toLowerCase());
}

/** Human "1m 23s" / "450ms" duration for run timeline rows. */
export function formatWorkflowDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}
