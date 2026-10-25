// MatOS self-evolution "review panel" (自进化评审团) bridge.
//
// A read-only projection of the ALREADY-RUNNING hidden self-evolution pipeline
// onto a Design-Jury-shaped view. It never spawns work of its own: it runs the
// stable `matos evolve monitor list --json` surface and folds the per-session
// monitor records into review "cases" (one per trigger), each with the five
// pipeline stages the UI renders as jury lanes:
//
//   scout   → trigger detected                (`detected`)
//   critic  → hidden feedback critic verdict  (`analysis-complete` + feedbackAnalysis)
//   refiner → experience sedimentation         (`experience-written`, legacy/optional)
//   editor  → direct asset edit                (`direct-edit-*` + directEditorRun)
//   judge   → semantic acceptance verdict      (semanticAcceptance)
//
// All business logic stays in the MatOS CLI/runtime; this file only shapes and
// truncates the CLI output for the browser. It surfaces no secrets: the CLI
// already redacts feedback/semantic payloads and truncates long text.

import type { Express, Request, Response } from 'express';
import { execMatOSJson, isRecord, matosCwd, stringOrNull } from '../services/matos-cli.js';
import {
  evolutionRunView,
  loadEvolutionOverview,
  readEvolutionRunDiff,
  type EvolutionLocationSource,
  type EvolutionOverview,
} from './matos-evolution-overview.js';

const PANEL_CACHE_TTL_MS = Number(process.env.MATOS_EVOLUTION_PANEL_CACHE_MS || 4_000);
// Newest-first slice pulled from the (potentially huge) monitor ledger each
// poll. Enough to cover every trigger group of the most recent session without
// scanning thousands of historical records.
const MONITOR_FETCH_LIMIT = Number(process.env.MATOS_EVOLUTION_PANEL_FETCH_LIMIT || 120);
const DEFAULT_RECENT_MINUTES = Number(process.env.MATOS_EVOLUTION_PANEL_RECENT_MIN || 30);
const MAX_CASES = 8;
const MAX_DETAIL_CHARS = 220;
const MAX_ASSET_REFS = 12;

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

// Stages carry structured state only; the web client composes localized
// detail text from the case's critic/editor/judge payloads (the daemon must
// stay locale-neutral).
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

const SETTLED_STATUSES = new Set([
  'direct-edit-complete',
  'direct-edit-proposed',
  'direct-edit-blocked',
  'direct-edit-import-blocked',
  'skipped-low-quality-trigger',
  'noop',
  'failed',
]);

const EDITOR_DONE_STATUSES = new Set(['accepted', 'accepted_merged', 'edited', 'validated', 'proposed']);
const EDITOR_FAILED_STATUSES = new Set(['failed', 'rolled_back', 'rollback_failed']);
const EDITOR_ACTIVE_STATUSES = new Set(['pending_merge', 'blocked']);

function truncate(value: string | null | undefined, max = MAX_DETAIL_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function stringArray(value: unknown, max = MAX_ASSET_REFS): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, max);
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface RawMonitorRecord {
  recordId: string;
  sessionId: string;
  triggerKind: string;
  triggerKey: string;
  status: string;
  summary: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  feedbackAnalysis: Record<string, unknown> | null;
  experienceRefs: string[];
  directEditorRun: Record<string, unknown> | null;
}

function normalizeRawRecord(value: unknown): RawMonitorRecord | null {
  if (!isRecord(value)) return null;
  const recordId = stringOrNull(value.recordId);
  const sessionId = stringOrNull(value.sessionId);
  const triggerKind = stringOrNull(value.triggerKind);
  const triggerKey = stringOrNull(value.triggerKey);
  const status = stringOrNull(value.status);
  if (!recordId || !sessionId || !status) return null;
  return {
    recordId,
    sessionId,
    triggerKind: triggerKind ?? 'session-end',
    triggerKey: triggerKey ?? recordId,
    status,
    summary: stringOrNull(value.summary),
    createdAt: stringOrNull(value.createdAt),
    updatedAt: stringOrNull(value.updatedAt),
    feedbackAnalysis: isRecord(value.feedbackAnalysis) ? value.feedbackAnalysis : null,
    experienceRefs: stringArray(value.experienceRefs),
    directEditorRun: isRecord(value.directEditorRun) ? value.directEditorRun : null,
  };
}

function recordTimeMs(record: RawMonitorRecord): number {
  const value = Date.parse(record.updatedAt ?? record.createdAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

function buildCritic(record: RawMonitorRecord): EvolutionReviewCritic | null {
  const analysis = record.feedbackAnalysis;
  if (!analysis) return null;
  const signals = Array.isArray(analysis.signals) ? analysis.signals : [];
  const decisions = Array.isArray(analysis.decisions) ? analysis.decisions : [];
  const firstDecision = decisions.find(isRecord);
  return {
    shouldUseFeedback:
      typeof analysis.shouldUseFeedback === 'boolean' ? analysis.shouldUseFeedback : null,
    signalCount: signals.length,
    decisionCount: decisions.length,
    topAction: firstDecision ? stringOrNull(firstDecision.recommendedAction) : null,
    summary: truncate(stringOrNull(analysis.summary)),
  };
}

function buildEditor(run: Record<string, unknown> | null): EvolutionReviewEditor | null {
  if (!run) return null;
  return {
    status: stringOrNull(run.status),
    updatedAssets: stringArray(run.updatedAssets),
    createdAssets: stringArray(run.createdAssets),
    disabledAssets: stringArray(run.disabledAssets),
  };
}

function buildJudge(run: Record<string, unknown> | null): EvolutionReviewJudge | null {
  if (!run) return null;
  const acceptance = isRecord(run.semanticAcceptance) ? run.semanticAcceptance : null;
  if (!acceptance) return null;
  return {
    verdict: stringOrNull(acceptance.verdict),
    confidence: toFiniteOrNull(acceptance.confidence),
    reason: truncate(stringOrNull(acceptance.reason)),
    overfitRisk: stringOrNull(acceptance.overfitRisk),
    pollutionRisk: stringOrNull(acceptance.assetPollutionRisk),
  };
}

function casePhase(latestStatus: string, editor: EvolutionReviewEditor | null): EvolutionCasePhase {
  switch (latestStatus) {
    case 'direct-edit-complete':
      return 'accepted';
    case 'direct-edit-proposed':
      return 'proposed';
    case 'direct-edit-blocked':
    case 'direct-edit-import-blocked':
      return 'blocked';
    case 'skipped-low-quality-trigger':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'noop':
      return 'noop';
    default:
      // detected / analysis-complete / experience-written and anything new:
      // still in flight unless the editor already settled negatively.
      if (editor && editor.status && EDITOR_FAILED_STATUSES.has(editor.status)) return 'failed';
      return 'reviewing';
  }
}

function buildStages(input: {
  statuses: Set<string>;
  phase: EvolutionCasePhase;
  critic: EvolutionReviewCritic | null;
  editor: EvolutionReviewEditor | null;
  judge: EvolutionReviewJudge | null;
  experienceRefs: string[];
}): EvolutionReviewStage[] {
  const { statuses, phase, critic, editor, judge, experienceRefs } = input;
  const settled = phase !== 'reviewing';

  // scout: a trigger group always started with a detection.
  const scout: EvolutionReviewStage = {
    role: 'scout',
    state: statuses.size <= 1 && statuses.has('detected') && !settled ? 'active' : 'done',
  };

  // critic: hidden feedback critic. Skipped for triggers that never reach
  // analysis (e.g. low-quality-trigger short circuit).
  let criticStage: EvolutionReviewStage;
  if (critic) {
    criticStage = { role: 'critic', state: 'done' };
  } else if (phase === 'skipped') {
    criticStage = { role: 'critic', state: 'skipped' };
  } else if (settled) {
    criticStage = { role: 'critic', state: 'done' };
  } else {
    criticStage = {
      role: 'critic',
      state: statuses.has('analysis-complete') ? 'done' : 'active',
    };
  }

  // refiner: legacy/optional experience layer. Done when experience refs
  // exist, else skipped once the case settled.
  const refinerStage: EvolutionReviewStage = experienceRefs.length
    ? { role: 'refiner', state: 'done' }
    : { role: 'refiner', state: settled ? 'skipped' : 'pending' };

  // editor: direct asset edit.
  let editorStage: EvolutionReviewStage;
  if (editor) {
    const status = editor.status ?? '';
    if (EDITOR_FAILED_STATUSES.has(status)) {
      editorStage = { role: 'editor', state: 'failed' };
    } else if (EDITOR_ACTIVE_STATUSES.has(status)) {
      editorStage = { role: 'editor', state: 'active' };
    } else if (EDITOR_DONE_STATUSES.has(status)) {
      editorStage = { role: 'editor', state: 'done' };
    } else {
      editorStage = { role: 'editor', state: settled ? 'done' : 'active' };
    }
  } else if (phase === 'noop' || phase === 'skipped') {
    editorStage = { role: 'editor', state: 'skipped' };
  } else if (phase === 'failed') {
    editorStage = { role: 'editor', state: 'failed' };
  } else {
    editorStage = { role: 'editor', state: 'pending' };
  }

  // judge: semantic acceptance.
  let judgeStage: EvolutionReviewStage;
  if (judge) {
    judgeStage = { role: 'judge', state: judge.verdict === 'rollback' ? 'failed' : 'done' };
  } else if (editor && EDITOR_DONE_STATUSES.has(editor.status ?? '')) {
    judgeStage = { role: 'judge', state: 'active' };
  } else if (settled) {
    judgeStage = { role: 'judge', state: 'skipped' };
  } else {
    judgeStage = { role: 'judge', state: 'pending' };
  }

  return [scout, criticStage, refinerStage, editorStage, judgeStage];
}

function buildCase(records: RawMonitorRecord[]): EvolutionReviewCase | null {
  if (records.length === 0) return null;
  const ordered = [...records].sort((a, b) => recordTimeMs(a) - recordTimeMs(b));
  const latest = ordered[ordered.length - 1]!;
  const statuses = new Set(ordered.map((record) => record.status));

  // Prefer the richest payloads seen across the group (a later `noop` record
  // may carry no analysis while the `analysis-complete` one does).
  const criticRecord = ordered.find((record) => record.feedbackAnalysis) ?? latest;
  const editorRecord = ordered.find((record) => record.directEditorRun) ?? latest;
  const experienceRefs = stringArray(
    ordered.flatMap((record) => record.experienceRefs),
  );

  const critic = buildCritic(criticRecord);
  const editor = buildEditor(editorRecord.directEditorRun);
  const judge = buildJudge(editorRecord.directEditorRun);
  const phase = casePhase(latest.status, editor);
  const stages = buildStages({ statuses, phase, critic, editor, judge, experienceRefs });

  return {
    caseId: latest.triggerKey,
    sessionId: latest.sessionId,
    triggerKind: latest.triggerKind,
    phase,
    status: latest.status,
    summary: truncate(criticRecord.feedbackAnalysis
      ? stringOrNull(criticRecord.feedbackAnalysis.summary) ?? latest.summary
      : latest.summary),
    createdAt: ordered[0]!.createdAt,
    updatedAt: latest.updatedAt,
    stages,
    critic,
    editor,
    judge,
    experienceRefs,
  };
}

/**
 * Fold the newest monitor records into review cases for a single session.
 * When `sessionId` is omitted, the most recently active session wins so the
 * panel tracks whatever run just produced learning activity.
 */
export function buildEvolutionPanel(
  records: unknown[],
  options: { sessionId?: string; recentMinutes?: number; nowMs?: number } = {},
): EvolutionPanelView {
  const nowMs = options.nowMs ?? Date.now();
  const recentMs = Math.max(0, options.recentMinutes ?? DEFAULT_RECENT_MINUTES) * 60_000;
  const normalized = records
    .map(normalizeRawRecord)
    .filter((record): record is RawMonitorRecord => Boolean(record));

  const requestedSession = options.sessionId?.trim();
  let sessionId: string | null = requestedSession || null;
  if (!sessionId) {
    // Most recent session by newest record timestamp.
    let bestMs = -1;
    for (const record of normalized) {
      const ms = recordTimeMs(record);
      if (ms > bestMs) {
        bestMs = ms;
        sessionId = record.sessionId;
      }
    }
  }

  const generatedAt = new Date(nowMs).toISOString();
  if (!sessionId) {
    return { sessionId: null, generatedAt, cases: [] };
  }

  const sessionRecords = normalized.filter((record) => record.sessionId === sessionId);
  const byTrigger = new Map<string, RawMonitorRecord[]>();
  for (const record of sessionRecords) {
    const bucket = byTrigger.get(record.triggerKey);
    if (bucket) bucket.push(record);
    else byTrigger.set(record.triggerKey, [record]);
  }

  const cases = [...byTrigger.values()]
    .map(buildCase)
    .filter((entry): entry is EvolutionReviewCase => Boolean(entry))
    .filter((entry) => {
      // When explicitly scoped to a session, show its cases regardless of age;
      // for the auto-picked latest session, keep only recent activity.
      if (requestedSession || recentMs === 0) return true;
      const ms = Date.parse(entry.updatedAt ?? entry.createdAt ?? '');
      return Number.isFinite(ms) && nowMs - ms <= recentMs;
    })
    .sort((a, b) => {
      const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '');
      const at = Date.parse(a.updatedAt ?? a.createdAt ?? '');
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    })
    .slice(0, MAX_CASES);

  return { sessionId, generatedAt, cases };
}

let panelCache: { at: number; key: string; payload: EvolutionPanelView } | null = null;

// Project sessions keep their monitor ledger in the project directory, so the
// panel reads the ledger of the project it is shown in.
async function loadEvolutionPanel(options: {
  sessionId?: string;
  recentMinutes?: number;
  cwd?: string;
}): Promise<EvolutionPanelView> {
  const key = `${options.cwd ?? ''}|${options.sessionId ?? ''}|${options.recentMinutes ?? ''}`;
  if (panelCache && panelCache.key === key && Date.now() - panelCache.at < PANEL_CACHE_TTL_MS) {
    return panelCache.payload;
  }
  const payload = await execMatOSJson([
    'evolve',
    'monitor',
    'list',
    '--json',
    '--limit',
    String(MONITOR_FETCH_LIMIT),
  ], options.cwd ? { cwd: options.cwd } : {});
  const records =
    isRecord(payload) && Array.isArray(payload.records) ? payload.records : [];
  const panel = buildEvolutionPanel(records, {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.recentMinutes != null ? { recentMinutes: options.recentMinutes } : {}),
  });
  panelCache = { at: Date.now(), key, payload: panel };
  return panel;
}

export interface MatOSEvolutionRouteOptions {
  resolveProjectCwd?: (projectId: string) => string | undefined | Promise<string | undefined>;
  listProjectLocations?: () => EvolutionLocationSource[] | Promise<EvolutionLocationSource[]>;
  // Approving a proposal changes assets; the asset bridge drops its caches.
  onAssetsChanged?: () => void;
}

const APPROVAL_MODES = new Set(['off', 'manual', 'auto']);
const OVERVIEW_CACHE_TTL_MS = 3_000;
let overviewCache: { at: number; payload: EvolutionOverview } | null = null;

function sendEvolutionError(res: Response, status: number, code: string, error: unknown): void {
  res.status(status).json({
    error: { code, message: error instanceof Error ? error.message : String(error) },
  });
}

function policyView(payload: unknown): { mode: string; source: string } {
  const policy = isRecord(payload) && isRecord(payload.policy) ? payload.policy : {};
  return {
    mode: stringOrNull(policy.mode) ?? 'auto',
    source: stringOrNull(policy.source) ?? 'default',
  };
}

export function registerMatOSEvolutionRoutes(
  app: Express,
  options: MatOSEvolutionRouteOptions = {},
): void {
  // undefined = the user workspace; null = an unknown or invalid project.
  const projectCwd = async (projectId: unknown): Promise<string | null | undefined> => {
    if (projectId === undefined || projectId === null || projectId === '') return undefined;
    if (
      typeof projectId !== 'string' ||
      projectId.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(projectId)
    ) {
      return null;
    }
    return (await options.resolveProjectCwd?.(projectId)) ?? null;
  };

  app.get('/api/matos/evolution/panel', (req: Request, res: Response) => {
    const sessionRaw = req.query.session;
    const recentRaw = req.query.recentMinutes;
    const sessionId = typeof sessionRaw === 'string' ? sessionRaw : undefined;
    const recentMinutes =
      typeof recentRaw === 'string' && recentRaw.trim() && Number.isFinite(Number(recentRaw))
        ? Number(recentRaw)
        : undefined;
    void (async () => {
      const cwd = await projectCwd(req.query.projectId);
      if (cwd === null) {
        sendEvolutionError(res, 404, 'MATOS_EVOLUTION_PROJECT', 'project not found');
        return;
      }
      const panel = await loadEvolutionPanel({
        ...(sessionId ? { sessionId } : {}),
        ...(recentMinutes != null ? { recentMinutes } : {}),
        ...(cwd ? { cwd } : {}),
      });
      res.json({ panel });
    })().catch((error) => {
      res.status(502).json({
        error: {
          code: 'MATOS_EVOLUTION_PANEL',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });

  app.get('/api/matos/evolution/policy', (_req: Request, res: Response) => {
    void (async () => {
      res.json({ policy: policyView(await execMatOSJson(['evolve', 'policy', '--json'])) });
    })().catch((error) => sendEvolutionError(res, 502, 'MATOS_EVOLUTION_POLICY', error));
  });

  app.put('/api/matos/evolution/policy', (req: Request, res: Response) => {
    const mode = isRecord(req.body) ? req.body.mode : undefined;
    if (typeof mode !== 'string' || !APPROVAL_MODES.has(mode)) {
      sendEvolutionError(res, 400, 'MATOS_EVOLUTION_POLICY', 'mode must be off, manual or auto');
      return;
    }
    void (async () => {
      res.json({ policy: policyView(await execMatOSJson(['evolve', 'policy', mode, '--json'])) });
    })().catch((error) => sendEvolutionError(res, 502, 'MATOS_EVOLUTION_POLICY', error));
  });

  app.get('/api/matos/evolution/overview', (req: Request, res: Response) => {
    void (async () => {
      if (
        req.query.refresh !== '1' &&
        overviewCache &&
        Date.now() - overviewCache.at < OVERVIEW_CACHE_TTL_MS
      ) {
        res.json({ overview: overviewCache.payload });
        return;
      }
      const locations: EvolutionLocationSource[] = [
        { projectId: null, projectName: null, cwd: matosCwd() },
        ...((await options.listProjectLocations?.()) ?? []),
      ];
      const overview = await loadEvolutionOverview(locations);
      overviewCache = { at: Date.now(), payload: overview };
      res.json({ overview });
    })().catch((error) => sendEvolutionError(res, 500, 'MATOS_EVOLUTION_OVERVIEW', error));
  });

  app.get('/api/matos/evolution/runs/:runId/diff', (req: Request, res: Response) => {
    void (async () => {
      const cwd = await projectCwd(req.query.projectId);
      if (cwd === null) {
        sendEvolutionError(res, 404, 'MATOS_EVOLUTION_PROJECT', 'project not found');
        return;
      }
      const diff = await readEvolutionRunDiff(cwd ?? matosCwd(), String(req.params.runId ?? ''));
      if (!diff) {
        sendEvolutionError(res, 404, 'MATOS_EVOLUTION_RUN', 'run diff not found');
        return;
      }
      res.json(diff);
    })().catch((error) => sendEvolutionError(res, 500, 'MATOS_EVOLUTION_RUN', error));
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/api/matos/evolution/runs/:runId/${decision}`, (req: Request, res: Response) => {
      const body = isRecord(req.body) ? req.body : {};
      const runId = String(req.params.runId ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(runId)) {
        sendEvolutionError(res, 400, 'MATOS_EVOLUTION_RUN', 'invalid run id');
        return;
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
      void (async () => {
        const cwd = await projectCwd(body.projectId);
        if (cwd === null) {
          sendEvolutionError(res, 404, 'MATOS_EVOLUTION_PROJECT', 'project not found');
          return;
        }
        let payload: unknown;
        try {
          payload = await execMatOSJson(
            ['evolve', 'direct-editor', decision, runId, '--json', ...(note ? [`--note=${note}`] : [])],
            cwd ? { cwd } : {},
          );
        } catch (error) {
          // The CLI refuses stale or already-decided proposals; the message
          // says why.
          sendEvolutionError(res, 409, 'MATOS_EVOLUTION_DECISION', error);
          return;
        }
        overviewCache = null;
        panelCache = null;
        if (decision === 'approve') options.onAssetsChanged?.();
        const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
        res.json({
          run: evolutionRunView(
            { projectId, projectName: null, cwd: cwd ?? matosCwd() },
            isRecord(payload) ? payload.run : null,
          ),
        });
      })().catch((error) => sendEvolutionError(res, 500, 'MATOS_EVOLUTION_DECISION', error));
    });
  }
}
