// MatOS scheduled-tasks bridge.
//
// MatOS already owns cron-based workflow scheduling natively through
// `matos workbench workflows triggers|save-trigger|delete-trigger|
// fire-trigger|trigger-scheduler`. This bridge is a thin adapter that lets the
// Automations/Schedules web surface list, create, edit, enable/disable, run,
// and delete those schedules without the web app knowing any scheduling
// business logic. No product logic lives here — every mutation is a `matos
// ... --json` call and the runtime remains authoritative.
//
// It also runs the resident "tick" loop so schedules actually fire: the
// trigger scheduler is not started elsewhere in the per-user daemon, so a
// filesystem-gated interval advances due cron triggers. The gate means an
// idle scope (no trigger store) never spawns the CLI.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { execMatOSJson, isRecord, matosCwd, stringOrNull } from '../services/matos-cli.js';
import { createStaleWhileRevalidateCache } from '../services/stale-while-revalidate.js';

const SCHEDULES_CACHE_TTL_MS = Number(process.env.MATOS_SCHEDULES_CACHE_MS || 120_000);
const SCHEDULES_CACHE_STALE_MS = Number(
  process.env.MATOS_SCHEDULES_STALE_MS || 15 * 60_000,
);
const AUTOTICK_ENABLED = process.env.MATOS_SCHEDULES_AUTOTICK !== '0';
const AUTOTICK_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.MATOS_SCHEDULES_TICK_INTERVAL_MS || 60_000),
);
// Trigger stores live at `<cwd>/.matos/workbench/workflow-triggers/*.json`
// (mirror of src/matos/workbench/workflowTriggers.ts). Checking the directory
// directly keeps the autotick free when the scope has no schedules.
const TRIGGER_STORE_REL = ['.matos', 'workbench', 'workflow-triggers'];

export interface ScheduleSummary {
  triggerId: string;
  workflowRef: string;
  name: string;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  parameters: Record<string, unknown>;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  lastRunId: string | null;
  lastError: string | null;
  createTime: number | null;
  updateTime: number | null;
}

export interface ScheduleWorkflowOption {
  ref: string;
  name: string;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalize a native trigger record into the flat schedule shape the UI renders. */
export function normalizeScheduleRecord(record: unknown): ScheduleSummary | null {
  if (!isRecord(record)) return null;
  const triggerId = stringOrNull(record.triggerId);
  const workflowRef = stringOrNull(record.workflowRef);
  if (!triggerId || !workflowRef) return null;
  const config = isRecord(record.config) ? record.config : {};
  const payload = isRecord(record.payload) ? record.payload : {};
  const scheduler = isRecord(record.scheduler) ? record.scheduler : {};
  const cron = stringOrNull(config.crontab) ?? stringOrNull(config.cron) ?? '';
  return {
    triggerId,
    workflowRef,
    name: stringOrNull(record.name) ?? triggerId,
    cron,
    timezone: stringOrNull(config.timezone),
    // Native status: 1 = enabled, 0 = paused.
    enabled: Number(record.status) === 1,
    parameters: isRecord(payload.parameters) ? (payload.parameters as Record<string, unknown>) : {},
    nextFireAt: numberOrNull(scheduler.nextFireAt),
    lastFiredAt: numberOrNull(scheduler.lastFiredAt),
    lastRunId: stringOrNull(scheduler.lastRunId),
    lastError: stringOrNull(scheduler.lastError),
    createTime: numberOrNull(record.createTime),
    updateTime: numberOrNull(record.updateTime),
  };
}

/** Extract enabled workflow options (ref + name) from a `workflows list` payload. */
export function normalizeWorkflowOptions(payload: unknown): ScheduleWorkflowOption[] {
  const root = isRecord(payload) ? payload : {};
  const resources = Array.isArray(root.resources) ? root.resources : [];
  const options: ScheduleWorkflowOption[] = [];
  const seen = new Set<string>();
  for (const item of resources) {
    if (!isRecord(item)) continue;
    const ref = stringOrNull(item.ref);
    if (!ref || seen.has(ref)) continue;
    // Skip disabled/retired workflows — you cannot usefully schedule them.
    const lifecycle = stringOrNull(item.lifecycle) ?? stringOrNull(item.status);
    if (lifecycle && lifecycle !== 'enabled' && lifecycle !== 'active') continue;
    seen.add(ref);
    options.push({ ref, name: stringOrNull(item.name) ?? ref });
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
}

type MatOSJsonExecutor = typeof execMatOSJson;

async function listSchedules(execute: MatOSJsonExecutor): Promise<ScheduleSummary[]> {
  const payload = await execute(['workbench', 'workflows', 'triggers', '--json']);
  const root = isRecord(payload) ? payload : {};
  const triggers = Array.isArray(root.triggers) ? root.triggers : [];
  return triggers
    .map(normalizeScheduleRecord)
    .filter((item): item is ScheduleSummary => item !== null)
    .sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity));
}

async function listWorkflowOptions(execute: MatOSJsonExecutor): Promise<ScheduleWorkflowOption[]> {
  try {
    const payload = await execute(['workbench', 'workflows', 'list', '--json']);
    return normalizeWorkflowOptions(payload);
  } catch {
    // The picker degrades to free-text ref entry when discovery fails.
    return [];
  }
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { code: 'MATOS_SCHEDULES', message } });
}

// Cheap gate for the autotick: does the scope hold any trigger store file?
// Avoids spawning the CLI for the common (no-schedules) case.
async function scopeHasTriggerStores(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(path.join(cwd, ...TRIGGER_STORE_REL));
    return entries.some((entry) => entry.endsWith('.json'));
  } catch {
    return false;
  }
}

async function tickScheduler(execute: MatOSJsonExecutor = execMatOSJson): Promise<unknown> {
  return execute(['workbench', 'workflows', 'trigger-scheduler', 'tick', '--json']);
}

let autotickTimer: ReturnType<typeof setInterval> | null = null;
let autotickInFlight = false;

/**
 * Resident cron loop. Filesystem-gated so idle scopes never spawn the CLI;
 * skips overlapping runs; swallows errors (a slow/broken tick must not crash
 * the daemon). Exported for tests and clean shutdown.
 */
export function startMatOSScheduleAutotick(): (() => void) | null {
  if (!AUTOTICK_ENABLED || autotickTimer) return null;
  const cwd = matosCwd();
  autotickTimer = setInterval(() => {
    if (autotickInFlight) return;
    autotickInFlight = true;
    void (async () => {
      try {
        if (!(await scopeHasTriggerStores(cwd))) return;
        await tickScheduler();
      } catch {
        // Intentionally quiet: the next tick retries.
      } finally {
        autotickInFlight = false;
      }
    })();
  }, AUTOTICK_INTERVAL_MS);
  // Do not keep the process alive solely for the scheduler.
  autotickTimer.unref?.();
  return () => {
    if (autotickTimer) clearInterval(autotickTimer);
    autotickTimer = null;
  };
}

export interface RegisterMatOSScheduleRoutesOptions {
  execute?: MatOSJsonExecutor;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
  startAutotick?: boolean;
}

export function registerMatOSScheduleRoutes(
  app: Express,
  options: RegisterMatOSScheduleRoutesOptions = {},
): void {
  const execute = options.execute ?? execMatOSJson;
  const now = options.now ?? Date.now;
  const cache = createStaleWhileRevalidateCache({
    freshMs: options.freshMs ?? SCHEDULES_CACHE_TTL_MS,
    staleMs: options.staleMs ?? SCHEDULES_CACHE_STALE_MS,
    now,
    load: async () => {
      const [triggers, workflows] = await Promise.all([
        listSchedules(execute),
        listWorkflowOptions(execute),
      ]);
      return { at: now(), triggers, workflows };
    },
  });

  app.get('/api/matos/schedules', (_req: Request, res: Response) => {
    void (async () => {
      const snapshot = await cache.get();
      res.json({
        triggers: snapshot.triggers,
        workflows: snapshot.workflows,
        generatedAt: new Date(snapshot.at).toISOString(),
        autotick: AUTOTICK_ENABLED,
      });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Create or update a schedule. `triggerId` present = update (the native
  // save resolves the owning workflow from the store when the ref is omitted).
  app.post('/api/matos/schedules', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const workflowRef = stringOrNull(body.workflowRef);
      const triggerId = stringOrNull(body.triggerId);
      const cron = stringOrNull(body.cron);
      if (!triggerId && !workflowRef) {
        sendError(res, 400, 'workflowRef is required to create a schedule');
        return;
      }
      if (!cron) {
        sendError(res, 400, 'cron is required');
        return;
      }
      const name = stringOrNull(body.name);
      const timezone = stringOrNull(body.timezone);
      const parameters = isRecord(body.parameters) ? body.parameters : {};
      const enabled = body.enabled === undefined ? true : body.enabled !== false;
      const request: Record<string, unknown> = {
        event_id: 'matos.schedule.cron',
        config: { crontab: cron, ...(timezone ? { timezone } : {}) },
        payload: { parameters },
        status: enabled ? 1 : 0,
      };
      if (triggerId) request.trigger_id = triggerId;
      if (name) request.name = name;
      const saved = await execute([
        'workbench',
        'workflows',
        'save-trigger',
        ...(workflowRef ? [workflowRef] : []),
        '--payload-json',
        JSON.stringify(request),
        '--json',
      ]);
      const savedRecord = isRecord(saved) ? saved : {};
      const validation = isRecord(savedRecord.validation) ? savedRecord.validation : null;
      if (validation && validation.ok === false) {
        res.status(422).json({ applied: false, validation });
        return;
      }
      cache.invalidate();
      // Arm the new/edited schedule so `nextFireAt` is populated immediately.
      // A tick may also fire an already-due trigger, which is the scheduler's
      // job; it is safe and idempotent under the per-trigger firing lease.
      await tickScheduler(execute).catch(() => undefined);
      const trigger = normalizeScheduleRecord(savedRecord.trigger);
      res.json({ applied: true, trigger });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Run a schedule immediately (out of band from its cron).
  app.post('/api/matos/schedules/:triggerId/fire', (req: Request, res: Response) => {
    void (async () => {
      const triggerId = String(req.params.triggerId ?? '').trim();
      if (!triggerId || !/^[A-Za-z0-9._:-]+$/.test(triggerId)) {
        sendError(res, 400, 'invalid trigger id');
        return;
      }
      const payload = await execute([
        'workbench',
        'workflows',
        'fire-trigger',
        triggerId,
        '--json',
      ]);
      cache.invalidate();
      res.json({ fired: payload });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.delete('/api/matos/schedules/:triggerId', (req: Request, res: Response) => {
    void (async () => {
      const triggerId = String(req.params.triggerId ?? '').trim();
      if (!triggerId || !/^[A-Za-z0-9._:-]+$/.test(triggerId)) {
        sendError(res, 400, 'invalid trigger id');
        return;
      }
      const payload = await execute([
        'workbench',
        'workflows',
        'delete-trigger',
        '--trigger-id',
        triggerId,
        '--json',
      ]);
      cache.invalidate();
      const record = isRecord(payload) ? payload : {};
      res.json({ deleted: record.applied === true });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  // Manual scheduler tick — arms new triggers and fires anything due now.
  app.post('/api/matos/schedules/tick', (_req: Request, res: Response) => {
    void (async () => {
      const payload = await tickScheduler(execute);
      cache.invalidate();
      res.json({ tick: payload });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  if (options.startAutotick !== false) startMatOSScheduleAutotick();
}
