import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  closeDatabase,
  getProject,
  insertRoutine,
  insertRoutineRun,
  insertScheduledRoutineRun,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { startServer } from '../src/server.js';

let tmp: string;
let dbFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'od-routine-claims-'));
  dbFile = path.join(tmp, 'app.sqlite');
});

afterEach(async () => {
  vi.useRealTimers();
  closeDatabase();
  await rm(tmp, { recursive: true, force: true });
});

describe('routine scheduled slot claims', () => {
  it('deduplicates scheduled run insertion in the same transaction as the slot claim', () => {
    const first = openDatabase(tmp, { dataDir: tmp });
    insertRoutine(first, {
      id: 'routine-1',
      name: 'Daily brief',
      prompt: 'Summarize the day',
      scheduleKind: 'hourly',
      scheduleValue: '15',
      scheduleJson: JSON.stringify({ kind: 'hourly', minute: 15 }),
      projectMode: 'create_each_run',
      projectId: null,
      skillId: null,
      agentId: null,
      enabled: true,
      createdAt: 1779012000000,
      updatedAt: 1779012000000,
    });

    const second = new Database(dbFile);
    try {
      second.pragma('foreign_keys = ON');

      const firstRun = insertScheduledRoutineRun(first, makeRun('run-1'), 1779012900000);
      const secondRun = insertScheduledRoutineRun(second, makeRun('run-2'), 1779012900000);
      const manualRun = insertRoutineRun(second, makeRun('run-manual', { trigger: 'manual' }));

      expect(firstRun?.id).toBe('run-1');
      expect(secondRun).toBeNull();
      expect(manualRun?.id).toBe('run-manual');
      expect(
        first.prepare(`SELECT id FROM routine_runs ORDER BY id`).all(),
      ).toEqual([{ id: 'run-1' }, { id: 'run-manual' }]);
    } finally {
      second.close();
    }
  });
});

function makeRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    routineId: 'routine-1',
    trigger: 'scheduled',
    status: 'running',
    projectId: `project-${id}`,
    conversationId: `conversation-${id}`,
    agentRunId: `agent-${id}`,
    startedAt: 1779012900000,
    completedAt: null,
    summary: null,
    error: null,
    ...overrides,
  };
}

describe('routine scheduled loser cleanup', () => {
  it('does not expose a phantom canceled run when a duplicate scheduled slot is lost', async () => {
    // Reviewer regression: `server.ts` now creates the in-memory
    // `design.runs` entry before `insertScheduledRoutineRun()` decides
    // whether this daemon won the slot. The loser path used to call
    // `design.runs.finish(run, 'canceled')`, which surfaced a phantom
    // canceled chat run via `/api/runs` even though no `routine_runs` row,
    // conversation, or messages were ever committed. The fix routes the
    // never-inserted path through `design.runs.drop()` so duplicate losers
    // do not leak in-memory runs back through the public API.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:00:00.000Z'));

    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });
    const projectId = 'routine-phantom-loser-project';
    insertProject(db, {
      id: projectId,
      name: 'Routine phantom loser target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Scheduled phantom-loser routine',
          prompt: 'fresh prompt',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'reuse', projectId },
          agentId: 'other-agent',
          enabled: true,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };
      const slotAt = Date.UTC(2026, 4, 17, 10, 1);
      // Pre-claim the slot from a sibling daemon so the loser branch fires
      // in this process. The winning row carries the same routine and slot.
      insertScheduledRoutineRun(db, {
        ...makeRun('phantom-winning-run', {
          routineId: created.routine.id,
          projectId,
          conversationId: 'phantom-winning-conversation',
          agentRunId: 'phantom-winning-agent-run',
        }),
      }, slotAt);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();

      // Wait until at least one tick after the scheduled timer fired so the
      // loser branch has had a chance to clean up.
      await sleep(50);

      // The only routine_runs row is the pre-seeded winner; the loser
      // never made it through `insertScheduledRoutineRun()`.
      const rows = db.prepare(
        `SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY id`,
      ).all(created.routine.id) as Array<{ id: string }>;
      expect(rows).toEqual([{ id: 'phantom-winning-run' }]);

      // `/api/runs` must not surface the loser's in-memory chat run as
      // `canceled` — `design.runs.drop()` removes it from the registry.
      const runsRes = await fetch(`${started.url}/api/runs`);
      expect(runsRes.status).toBe(200);
      const runsJson = await runsRes.json() as {
        runs: Array<{ status: string; assistantMessageId: string | null }>;
      };
      const phantom = runsJson.runs.find((run) =>
        typeof run.assistantMessageId === 'string'
        && run.assistantMessageId.startsWith('routine-assistant-'));
      expect(phantom).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });

  it('does not create provisional database state for a reuse-mode loser before the slot is won', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:00:00.000Z'));

    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });
    const projectId = 'routine-rollback-failure-project';
    insertProject(db, {
      id: projectId,
      name: 'Routine rollback target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Scheduled rollback routine',
          prompt: 'fresh prompt',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'reuse', projectId },
          agentId: 'other-agent',
          enabled: true,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };
      const slotAt = Date.UTC(2026, 4, 17, 10, 1);
      insertScheduledRoutineRun(db, {
        ...makeRun('winning-run', {
          routineId: created.routine.id,
          projectId,
          conversationId: 'rollback-winning-conversation',
          agentRunId: 'rollback-winning-agent-run',
        }),
      }, slotAt);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(db.prepare(
        `SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?`,
      ).get(projectId)).toEqual({ n: 0 });
    } finally {
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});

describe('routine prepare failure cleanup', () => {
  it('clears scheduled placeholder IDs when project creation fails before real IDs are assigned', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:00:00.000Z'));

    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Scheduled project failure routine',
          prompt: 'create a project',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'create_each_run' },
          agentId: 'other-agent',
          enabled: true,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };

      db.exec(`
        DROP TRIGGER IF EXISTS fail_scheduled_routine_project_insert;
        CREATE TRIGGER fail_scheduled_routine_project_insert
        BEFORE INSERT ON projects
        WHEN NEW.id LIKE 'routine-%'
          AND json_extract(NEW.metadata_json, '$.routineId') = '${created.routine.id}'
        BEGIN
          SELECT RAISE(ABORT, 'routine project insert failed');
        END;
      `);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();

      let stored:
        | { status: string; projectId: string; conversationId: string; agentRunId: string }
        | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        stored = db.prepare(
          `SELECT status,
                  project_id AS projectId,
                  conversation_id AS conversationId,
                  agent_run_id AS agentRunId
             FROM routine_runs
            WHERE routine_id = ?`,
        ).get(created.routine.id) as typeof stored;
        if (stored?.status === 'failed') break;
        await sleep(10);
      }

      expect(stored).toBeDefined();
      if (!stored) return;
      expect(stored.status).toBe('failed');
      expect(stored.projectId).toBe('');
      expect(stored.conversationId).toBe('');
      expect(stored.agentRunId).toMatch(/^[0-9a-f-]{36}$/);
      expect(stored.projectId).not.toContain('routine-pending-project');
      expect(stored.conversationId).not.toContain('routine-pending-conv');

      const runsRes = await fetch(`${started.url}/api/runs`);
      expect(runsRes.status).toBe(200);
      const runsJson = await runsRes.json() as {
        runs: Array<{ status: string; projectId: string | null; conversationId: string | null; assistantMessageId: string | null }>;
      };
      const chatRun = runsJson.runs.find((run) =>
        typeof run.assistantMessageId === 'string'
        && run.assistantMessageId.startsWith('routine-assistant-'));
      expect(chatRun).toBeDefined();
      expect(chatRun?.status).toBe('canceled');
      expect(String(chatRun?.projectId ?? '')).not.toContain('routine-pending-project');
      expect(String(chatRun?.conversationId ?? '')).not.toContain('routine-pending-conv');
    } finally {
      vi.useRealTimers();
      try {
        db.exec('DROP TRIGGER IF EXISTS fail_scheduled_routine_project_insert');
      } catch {
        // The test may fail before the trigger exists.
      }
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });

  it('returns prepared IDs for a successful manual create_each_run response', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual response routine',
          prompt: 'prepare and return ids',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'create_each_run' },
          agentId: 'missing-agent-for-route-test',
          enabled: false,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };

      const runRes = await fetch(`${started.url}/api/routines/${created.routine.id}/run`, {
        method: 'POST',
      });
      expect(runRes.status).toBe(202);
      const runJson = await runRes.json() as {
        projectId: string;
        conversationId: string;
        agentRunId: string;
        run: {
          projectId: string;
          conversationId: string;
          agentRunId: string;
        };
      };

      expect(runJson.projectId).toMatch(/^routine-/);
      expect(runJson.conversationId).toMatch(/^routine-conv-/);
      expect(runJson.agentRunId).toMatch(/^[0-9a-f-]{36}$/);
      expect(runJson.projectId).not.toContain('routine-pending-project');
      expect(runJson.conversationId).not.toContain('routine-pending-conv');
      expect(runJson.run).toMatchObject({
        projectId: runJson.projectId,
        conversationId: runJson.conversationId,
        agentRunId: runJson.agentRunId,
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`).get(runJson.projectId))
        .toEqual({ n: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE id = ?`).get(runJson.conversationId))
        .toEqual({ n: 1 });
    } finally {
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });

  it('finalizes and cleans up a manual run when prepare fails after creating the conversation', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual prepare failure routine',
          prompt: 'write messages',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'create_each_run' },
          agentId: 'other-agent',
          enabled: false,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };

      db.exec(`
        DROP TRIGGER IF EXISTS fail_manual_routine_message_insert;
        CREATE TRIGGER fail_manual_routine_message_insert
        BEFORE INSERT ON messages
        WHEN NEW.id LIKE 'routine-user-%'
        BEGIN
          SELECT RAISE(ABORT, 'routine message insert failed');
        END;
      `);

      const runRes = await fetch(`${started.url}/api/routines/${created.routine.id}/run`, {
        method: 'POST',
      });
      expect(runRes.status).toBe(500);
      expect(await runRes.text()).toContain('routine message insert failed');

      const rows = db.prepare(
        `SELECT status,
                trigger,
                project_id AS projectId,
                conversation_id AS conversationId,
                agent_run_id AS agentRunId,
                error
           FROM routine_runs
          WHERE routine_id = ?`,
      ).all(created.routine.id) as Array<{
        status: string;
        trigger: string;
        projectId: string;
        conversationId: string;
        agentRunId: string;
        error: string | null;
      }>;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        status: 'failed',
        trigger: 'manual',
        error: 'routine message insert failed',
      });
      expect(row.projectId).toMatch(/^routine-/);
      expect(row.conversationId).toMatch(/^routine-conv-/);
      expect(row.agentRunId).toMatch(/^[0-9a-f-]{36}$/);

      expect(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`).get(row.projectId))
        .toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE id = ?`).get(row.conversationId))
        .toEqual({ n: 0 });

      const runsRes = await fetch(`${started.url}/api/runs`);
      expect(runsRes.status).toBe(200);
      const runsJson = await runsRes.json() as {
        runs: Array<{ status: string; assistantMessageId: string | null }>;
      };
      const chatRun = runsJson.runs.find((run) =>
        typeof run.assistantMessageId === 'string'
        && run.assistantMessageId.startsWith('routine-assistant-'));
      expect(chatRun).toBeDefined();
      expect(chatRun?.status).toBe('canceled');
    } finally {
      try {
        db.exec('DROP TRIGGER IF EXISTS fail_manual_routine_message_insert');
      } catch {
        // The test may fail before the trigger exists.
      }
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });

  it('rolls back a manual run when conversation creation fails before the handler returns', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(tmp, { dataDir });

    try {
      const createRoutine = await fetch(`${started.url}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual early conversation failure routine',
          prompt: 'prepare resources',
          schedule: { kind: 'hourly', minute: 1 },
          target: { mode: 'create_each_run' },
          agentId: 'other-agent',
          enabled: false,
        }),
      });
      expect(createRoutine.status).toBe(201);
      const created = await createRoutine.json() as { routine: { id: string } };

      db.exec(`
        DROP TRIGGER IF EXISTS fail_manual_routine_conversation_insert;
        CREATE TRIGGER fail_manual_routine_conversation_insert
        BEFORE INSERT ON conversations
        WHEN NEW.id LIKE 'routine-conv-%'
          AND NEW.project_id IN (
            SELECT id FROM projects
             WHERE json_extract(metadata_json, '$.routineId') = '${created.routine.id}'
          )
        BEGIN
          SELECT RAISE(ABORT, 'routine conversation insert failed');
        END;
      `);

      const runRes = await fetch(`${started.url}/api/routines/${created.routine.id}/run`, {
        method: 'POST',
      });
      expect(runRes.status).toBe(500);
      expect(await runRes.text()).toContain('routine conversation insert failed');

      const rows = db.prepare(
        `SELECT status,
                trigger,
                project_id AS projectId,
                conversation_id AS conversationId,
                agent_run_id AS agentRunId,
                error
           FROM routine_runs
          WHERE routine_id = ?`,
      ).all(created.routine.id) as Array<{
        status: string;
        trigger: string;
        projectId: string;
        conversationId: string;
        agentRunId: string;
        error: string | null;
      }>;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        status: 'failed',
        trigger: 'manual',
        error: 'routine conversation insert failed',
      });
      expect(row.projectId).toMatch(/^routine-/);
      expect(row.conversationId).toBe('');
      expect(row.agentRunId).toMatch(/^[0-9a-f-]{36}$/);

      expect(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`).get(row.projectId))
        .toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?`).get(row.projectId))
        .toEqual({ n: 0 });
    } finally {
      try {
        db.exec('DROP TRIGGER IF EXISTS fail_manual_routine_conversation_insert');
      } catch {
        // The test may fail before the trigger exists.
      }
      await Promise.resolve(started.shutdown?.());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});
