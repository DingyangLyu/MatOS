// Client for the daemon's MatOS self-evolution review-panel bridge
// (`apps/daemon/src/routes/matos-evolution.ts`). The 自进化评审团 surface polls
// this to project the hidden self-evolution pipeline (critic → refiner →
// editor → judge) onto the Design-Jury-styled panel. All learning logic stays
// in the MatOS runtime; this is a read-only view.

export type EvolutionStageRole = 'scout' | 'critic' | 'refiner' | 'editor' | 'judge';
export type EvolutionStageState = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type EvolutionCasePhase =
  | 'reviewing'
  | 'accepted'
  | 'proposed'
  | 'noop'
  | 'blocked'
  | 'skipped'
  | 'failed';

// Structured state only — localized detail text is composed in the panel
// from the case's critic/editor/judge payloads.
export interface EvolutionReviewStage {
  role: EvolutionStageRole;
  state: EvolutionStageState;
}

export interface EvolutionReviewCritic {
  shouldUseFeedback: boolean | null;
  signalCount: number;
  decisionCount: number;
  topAction: string | null;
  summary: string | null;
}

export interface EvolutionReviewEditor {
  status: string | null;
  updatedAssets: string[];
  createdAssets: string[];
  disabledAssets: string[];
}

export interface EvolutionReviewJudge {
  verdict: string | null;
  confidence: number | null;
  reason: string | null;
  overfitRisk: string | null;
  pollutionRisk: string | null;
}

export interface EvolutionReviewCase {
  caseId: string;
  sessionId: string;
  triggerKind: string;
  phase: EvolutionCasePhase;
  status: string;
  summary: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stages: EvolutionReviewStage[];
  critic: EvolutionReviewCritic | null;
  editor: EvolutionReviewEditor | null;
  judge: EvolutionReviewJudge | null;
  experienceRefs: string[];
}

export interface EvolutionPanelView {
  sessionId: string | null;
  generatedAt: string;
  cases: EvolutionReviewCase[];
}

export const EVOLUTION_STAGE_ORDER: EvolutionStageRole[] = [
  'scout',
  'critic',
  'refiner',
  'editor',
  'judge',
];

/** Case phases that are terminal (the review has settled). */
export const EVOLUTION_TERMINAL_PHASES = new Set<EvolutionCasePhase>([
  'accepted',
  'proposed',
  'noop',
  'blocked',
  'skipped',
  'failed',
]);

export function isTerminalEvolutionPhase(phase: EvolutionCasePhase): boolean {
  return EVOLUTION_TERMINAL_PHASES.has(phase);
}

/**
 * Fetch the current self-evolution review panel. When `sessionId` is omitted
 * the daemon auto-selects the most recently active session so the panel tracks
 * whatever run just produced learning activity. Never throws for an empty
 * panel; only network / server errors reject.
 */
export async function fetchEvolutionPanel(options: {
  sessionId?: string;
  recentMinutes?: number;
  /** Project sessions keep their review records in the project directory. */
  projectId?: string;
} = {}): Promise<EvolutionPanelView> {
  const params = new URLSearchParams();
  if (options.sessionId) params.set('session', options.sessionId);
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.recentMinutes != null) params.set('recentMinutes', String(options.recentMinutes));
  const query = params.toString();
  const url = `/api/matos/evolution/panel${query ? `?${query}` : ''}`;
  const resp = await fetch(url, { cache: 'no-store' });
  const payload = (await resp.json().catch(() => null)) as
    | { panel?: EvolutionPanelView; error?: { message?: string } }
    | null;
  if (!resp.ok) {
    const message =
      payload && typeof payload === 'object' && payload.error?.message
        ? payload.error.message
        : `Request failed (${resp.status})`;
    throw new Error(message);
  }
  return (
    payload?.panel ?? {
      sessionId: options.sessionId ?? null,
      generatedAt: new Date().toISOString(),
      cases: [],
    }
  );
}

// ---- Evolution page (/evolution): approval policy, proposals, history ----

export type EvolutionApprovalMode = 'off' | 'manual' | 'auto';

export interface EvolutionApprovalPolicy {
  mode: EvolutionApprovalMode;
  /** 'env' means MATOS_EVOLUTION_APPROVAL_MODE pins the mode for the service. */
  source: string;
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

async function requestEvolutionJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = (await resp.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!resp.ok) {
    throw new Error(payload?.error?.message ?? `Request failed (${resp.status})`);
  }
  return payload as T;
}

export async function fetchEvolutionPolicy(): Promise<EvolutionApprovalPolicy> {
  return (await requestEvolutionJson<{ policy: EvolutionApprovalPolicy }>('/api/matos/evolution/policy'))
    .policy;
}

export async function saveEvolutionPolicy(
  mode: EvolutionApprovalMode,
): Promise<EvolutionApprovalPolicy> {
  return (
    await requestEvolutionJson<{ policy: EvolutionApprovalPolicy }>('/api/matos/evolution/policy', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    })
  ).policy;
}

export async function fetchEvolutionOverview(
  options: { refresh?: boolean } = {},
): Promise<EvolutionOverview> {
  return (
    await requestEvolutionJson<{ overview: EvolutionOverview }>(
      `/api/matos/evolution/overview${options.refresh ? '?refresh=1' : ''}`,
    )
  ).overview;
}

export async function fetchEvolutionRunDiff(
  runId: string,
  projectId: string | null,
): Promise<{ diff: string; truncated: boolean }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return requestEvolutionJson(`/api/matos/evolution/runs/${encodeURIComponent(runId)}/diff${query}`);
}

export async function decideEvolutionProposal(input: {
  runId: string;
  projectId: string | null;
  decision: 'approve' | 'reject';
  note?: string;
}): Promise<EvolutionRunView | null> {
  const payload = await requestEvolutionJson<{ run: EvolutionRunView | null }>(
    `/api/matos/evolution/runs/${encodeURIComponent(input.runId)}/${input.decision}`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.note ? { note: input.note } : {}),
      }),
    },
  );
  return payload.run;
}
