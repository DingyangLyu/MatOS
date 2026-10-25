import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

export type ProjectGroupTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface ProjectGroupTaskRecord {
  id: string;
  projectId: string;
  conversationId: string;
  memberRef: string;
  memberId: string | null;
  prompt: string;
  status: ProjectGroupTaskStatus;
  sequence: number;
  authorityState: 'pending' | 'ready' | 'error';
  runId: string | null;
  claimToken: string | null;
  workerId: string | null;
  workerPid: number | null;
  childPid: number | null;
  leaseExpiresAt: number | null;
  attempt: number;
  userMessageId: string;
  assistantMessageId: string;
  sourceMessageId: string | null;
  relayHop: number;
  clientRequestId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const TASK_TRANSITIONS: Record<ProjectGroupTaskStatus, ReadonlySet<ProjectGroupTaskStatus>> = {
  queued: new Set(['queued', 'running', 'failed', 'canceled']),
  running: new Set(['running', 'queued', 'succeeded', 'failed', 'canceled']),
  succeeded: new Set(['succeeded']),
  failed: new Set(['failed']),
  canceled: new Set(['canceled']),
};

function normalize(row: any): ProjectGroupTaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    memberRef: String(row.member_ref),
    memberId: typeof row.member_id === 'string' ? row.member_id : null,
    prompt: String(row.prompt),
    status: row.status as ProjectGroupTaskStatus,
    sequence: Number(row.sequence) || 0,
    authorityState: row.authority_state === 'pending' || row.authority_state === 'error'
      ? row.authority_state
      : 'ready',
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    claimToken: typeof row.claim_token === 'string' ? row.claim_token : null,
    workerId: typeof row.worker_id === 'string' ? row.worker_id : null,
    workerPid: row.worker_pid != null && Number.isInteger(Number(row.worker_pid)) ? Number(row.worker_pid) : null,
    childPid: row.child_pid != null && Number.isInteger(Number(row.child_pid)) ? Number(row.child_pid) : null,
    leaseExpiresAt: row.lease_expires_at != null && Number.isFinite(Number(row.lease_expires_at))
      ? Number(row.lease_expires_at)
      : null,
    attempt: Number(row.attempt) || 0,
    userMessageId: String(row.user_message_id),
    assistantMessageId: String(row.assistant_message_id),
    sourceMessageId: typeof row.source_message_id === 'string' ? row.source_message_id : null,
    relayHop: Number(row.relay_hop) || 0,
    clientRequestId: typeof row.client_request_id === 'string' ? row.client_request_id : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function insertProjectGroupTask(
  db: SqliteDb,
  task: Pick<ProjectGroupTaskRecord,
    'id' | 'projectId' | 'conversationId' | 'memberRef' | 'prompt' |
    'userMessageId' | 'assistantMessageId' | 'sourceMessageId' | 'relayHop'> & {
    memberId?: string | null;
    clientRequestId?: string | null;
    authorityState?: ProjectGroupTaskRecord['authorityState'];
    sequence?: number;
  },
): ProjectGroupTaskRecord {
  const now = Date.now();
  const nextSequence = db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM project_group_tasks WHERE project_id = ? AND conversation_id = ?`,
  ).get(task.projectId, task.conversationId) as { next_sequence?: number } | undefined;
  const sequence = Number.isInteger(task.sequence)
    ? Number(task.sequence)
    : Number(nextSequence?.next_sequence ?? 1);
  db.prepare(
    `INSERT INTO project_group_tasks
       (id, project_id, conversation_id, member_ref, member_id, prompt, status,
        sequence, authority_state, run_id, claim_token, worker_id, worker_pid,
        child_pid, lease_expires_at, attempt,
       user_message_id, assistant_message_id, source_message_id, relay_hop,
        client_request_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL,
       NULL, NULL, 0, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    task.id,
    task.projectId,
    task.conversationId,
    task.memberRef,
    task.memberId ?? null,
    task.prompt,
    sequence,
    task.authorityState ?? 'ready',
    task.userMessageId,
    task.assistantMessageId,
    task.sourceMessageId,
    task.relayHop,
    task.clientRequestId ?? null,
    now,
    now,
  );
  return getProjectGroupTask(db, task.id)!;
}

export function findProjectGroupTaskByClientRequest(
  db: SqliteDb,
  input: { projectId: string; conversationId: string; clientRequestId: string },
): ProjectGroupTaskRecord | null {
  const row = db.prepare(
    `SELECT * FROM project_group_tasks
      WHERE project_id = ? AND conversation_id = ? AND client_request_id = ?`,
  ).get(input.projectId, input.conversationId, input.clientRequestId);
  return row ? normalize(row) : null;
}

export function getProjectGroupTask(
  db: SqliteDb,
  taskId: string,
): ProjectGroupTaskRecord | null {
  const row = db.prepare('SELECT * FROM project_group_tasks WHERE id = ?').get(taskId);
  return row ? normalize(row) : null;
}

/**
 * The durable task that owns a group assistant turn, or null when the turn
 * was a plain web-streamed run. Group dispatch continuation uses this to
 * carry the finished turn's relay hop into the next handoff.
 */
export function findProjectGroupTaskByAssistantMessage(
  db: SqliteDb,
  assistantMessageId: string,
): ProjectGroupTaskRecord | null {
  const row = db.prepare(
    'SELECT * FROM project_group_tasks WHERE assistant_message_id = ?',
  ).get(assistantMessageId);
  return row ? normalize(row) : null;
}

export function listProjectGroupTasks(
  db: SqliteDb,
  input: { projectId: string; conversationId?: string; status?: ProjectGroupTaskStatus },
): ProjectGroupTaskRecord[] {
  const clauses = ['project_id = ?'];
  const values: unknown[] = [input.projectId];
  if (input.conversationId) {
    clauses.push('conversation_id = ?');
    values.push(input.conversationId);
  }
  if (input.status) {
    clauses.push('status = ?');
    values.push(input.status);
  }
  return (db.prepare(
    `SELECT * FROM project_group_tasks WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC, created_at ASC, id ASC`,
  ).all(...values) as any[]).map(normalize);
}

export function listRecoverableProjectGroupTasks(db: SqliteDb): ProjectGroupTaskRecord[] {
  return (db.prepare(
    `SELECT * FROM project_group_tasks
      WHERE status IN ('queued', 'running')
      ORDER BY sequence ASC, created_at ASC, id ASC`,
  ).all() as any[]).map(normalize);
}

export function updateProjectGroupTask(
  db: SqliteDb,
  taskId: string,
  patch: {
    status: ProjectGroupTaskStatus;
    runId?: string | null;
    error?: string | null;
    expectedClaimToken?: string;
  },
): ProjectGroupTaskRecord | null {
  const current = getProjectGroupTask(db, taskId);
  if (!current) return null;
  if (
    patch.expectedClaimToken !== undefined &&
    (current.status !== 'running' || current.claimToken !== patch.expectedClaimToken)
  ) {
    return null;
  }
  if (!TASK_TRANSITIONS[current.status].has(patch.status)) {
    throw new Error(`invalid project group task transition: ${current.status} -> ${patch.status}`);
  }
  const hasRunId = Object.prototype.hasOwnProperty.call(patch, 'runId');
  const clearClaim = patch.status !== 'running';
  const changed = db.prepare(
    `UPDATE project_group_tasks
        SET status = ?,
            run_id = CASE WHEN ? = 1 THEN ? ELSE run_id END,
            error = ?,
            claim_token = CASE WHEN ? = 1 THEN NULL ELSE claim_token END,
            worker_id = CASE WHEN ? = 1 THEN NULL ELSE worker_id END,
            worker_pid = CASE WHEN ? = 1 THEN NULL ELSE worker_pid END,
            child_pid = CASE WHEN ? = 1 THEN NULL ELSE child_pid END,
            lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at END,
            updated_at = ?
      WHERE id = ? AND status = ?${patch.expectedClaimToken !== undefined ? ' AND claim_token = ?' : ''}`,
  ).run(
    patch.status,
    hasRunId ? 1 : 0,
    hasRunId ? patch.runId ?? null : null,
    patch.error ?? null,
    clearClaim ? 1 : 0,
    clearClaim ? 1 : 0,
    clearClaim ? 1 : 0,
    clearClaim ? 1 : 0,
    clearClaim ? 1 : 0,
    Date.now(),
    taskId,
    current.status,
    ...(patch.expectedClaimToken !== undefined ? [patch.expectedClaimToken] : []),
  );
  return changed.changes === 1 ? getProjectGroupTask(db, taskId) : null;
}

export function setProjectGroupTaskAuthorityState(
  db: SqliteDb,
  taskId: string,
  state: ProjectGroupTaskRecord['authorityState'],
  error?: string | null,
): ProjectGroupTaskRecord | null {
  db.prepare(
    `UPDATE project_group_tasks
        SET authority_state = ?,
            error = CASE
              WHEN ? = 'ready' AND status = 'queued' THEN NULL
              WHEN ? IS NOT NULL THEN ?
              ELSE error
            END,
            updated_at = ?
      WHERE id = ?`,
  ).run(state, state, error ?? null, error ?? null, Date.now(), taskId);
  return getProjectGroupTask(db, taskId);
}

export function claimNextProjectGroupTask(
  db: SqliteDb,
  input: {
    projectId: string;
    conversationId: string;
    workerId: string;
    workerPid: number;
    claimToken: string;
    leaseMs: number;
  },
): ProjectGroupTaskRecord | null {
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT id FROM project_group_tasks
        WHERE project_id = ? AND conversation_id = ?
          AND status = 'queued' AND authority_state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM project_group_tasks running
             WHERE running.project_id = project_group_tasks.project_id
               AND running.conversation_id = project_group_tasks.conversation_id
               AND running.status = 'running'
          )
        ORDER BY sequence ASC, created_at ASC, id ASC LIMIT 1`,
    ).get(input.projectId, input.conversationId) as { id?: string } | undefined;
    if (!row?.id) return null;
    const now = Date.now();
    const changed = db.prepare(
      `UPDATE project_group_tasks
          SET status = 'running', claim_token = ?, worker_id = ?, worker_pid = ?,
              child_pid = NULL, lease_expires_at = ?, attempt = attempt + 1,
              error = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued' AND authority_state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM project_group_tasks running
             WHERE running.project_id = project_group_tasks.project_id
               AND running.conversation_id = project_group_tasks.conversation_id
               AND running.status = 'running'
          )`,
    ).run(
      input.claimToken,
      input.workerId,
      input.workerPid,
      now + input.leaseMs,
      now,
      row.id,
    );
    return changed.changes === 1 ? getProjectGroupTask(db, row.id) : null;
  })();
}

export function renewProjectGroupTaskLease(
  db: SqliteDb,
  taskId: string,
  claimToken: string,
  leaseMs: number,
): boolean {
  const now = Date.now();
  return db.prepare(
    `UPDATE project_group_tasks SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND claim_token = ?`,
  ).run(now + leaseMs, now, taskId, claimToken).changes === 1;
}

export function attachProjectGroupTaskChild(
  db: SqliteDb,
  taskId: string,
  claimToken: string,
  childPid: number,
): boolean {
  return db.prepare(
    `UPDATE project_group_tasks SET child_pid = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND claim_token = ?`,
  ).run(childPid, Date.now(), taskId, claimToken).changes === 1;
}

export interface ProjectGroupTaskOutboxRecord {
  id: number;
  taskId: string;
  operation: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export function enqueueProjectGroupTaskOutbox(
  db: SqliteDb,
  input: { taskId: string; operation: string; payload: Record<string, unknown> },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO project_group_task_outbox
       (task_id, operation, payload_json, attempts, next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, NULL, ?, ?)
     ON CONFLICT(task_id, operation) DO UPDATE SET
       payload_json = excluded.payload_json, next_attempt_at = 0,
       last_error = NULL, updated_at = excluded.updated_at`,
  ).run(input.taskId, input.operation, JSON.stringify(input.payload), now, now);
}

export function listProjectGroupTaskOutbox(
  db: SqliteDb,
  input: { taskId?: string; limit?: number } = {},
): ProjectGroupTaskOutboxRecord[] {
  const rows = input.taskId
    ? db.prepare(
        `SELECT pending.* FROM project_group_task_outbox pending
          WHERE pending.task_id = ? AND pending.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM project_group_task_outbox earlier
               WHERE earlier.task_id = pending.task_id AND earlier.id < pending.id
            )
          ORDER BY pending.id ASC LIMIT ?`,
      ).all(input.taskId, Date.now(), input.limit ?? 100)
    : db.prepare(
        `SELECT pending.* FROM project_group_task_outbox pending
          WHERE pending.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM project_group_task_outbox earlier
               WHERE earlier.task_id = pending.task_id AND earlier.id < pending.id
            )
          ORDER BY pending.id ASC LIMIT ?`,
      ).all(Date.now(), input.limit ?? 100);
  return (rows as any[]).map(row => ({
    id: Number(row.id),
    taskId: String(row.task_id),
    operation: String(row.operation),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: Number(row.next_attempt_at) || 0,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
  }));
}

export function completeProjectGroupTaskOutbox(db: SqliteDb, id: number): void {
  db.prepare('DELETE FROM project_group_task_outbox WHERE id = ?').run(id);
}

export function nextProjectGroupTaskOutboxDelay(db: SqliteDb): number | null {
  const row = db.prepare(
    `SELECT MIN(pending.next_attempt_at) AS next_attempt_at
       FROM project_group_task_outbox pending
      WHERE NOT EXISTS (
        SELECT 1 FROM project_group_task_outbox earlier
         WHERE earlier.task_id = pending.task_id AND earlier.id < pending.id
      )`,
  ).get() as { next_attempt_at?: number | null } | undefined;
  if (row?.next_attempt_at == null) return null;
  return Math.max(0, Number(row.next_attempt_at) - Date.now());
}

export function failProjectGroupTaskOutbox(db: SqliteDb, id: number, error: string): void {
  const row = db.prepare(
    'SELECT attempts FROM project_group_task_outbox WHERE id = ?',
  ).get(id) as { attempts?: number } | undefined;
  const attempts = Number(row?.attempts ?? 0) + 1;
  const delay = Math.min(30_000, 250 * (2 ** Math.min(attempts, 7)));
  db.prepare(
    `UPDATE project_group_task_outbox
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(attempts, Date.now() + delay, error.slice(0, 1_000), Date.now(), id);
}
