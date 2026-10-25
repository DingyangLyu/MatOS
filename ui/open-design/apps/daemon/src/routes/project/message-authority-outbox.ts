import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

export interface ProjectMessageAuthorityOutboxRecord {
  messageId: string;
  projectId: string;
  conversationId: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export function enqueueProjectMessageAuthorityOutbox(
  db: SqliteDb,
  input: {
    messageId: string;
    projectId: string;
    conversationId: string;
    /**
     * Optional delivery grace window. The daemon's run-terminal reconcile
     * enqueues with a delay so an attached client's finalize PUT (which
     * enqueues with no delay) can land first; delivery reads the message row
     * at flush time, so the later, more authoritative write is what reaches
     * the native timeline. Client PUT callers omit it (immediate, as before).
     */
    delayMs?: number;
  },
): void {
  const now = Date.now();
  const delayMs = typeof input.delayMs === 'number' && input.delayMs > 0 ? input.delayMs : 0;
  // Earliest-wins on conflict: an immediate (client PUT) enqueue accelerates
  // a pending delayed record to "due now", while a delayed (daemon reconcile)
  // enqueue never pushes back a record that is already due — including
  // failure-backoff records, which a fresh enqueue may only speed up. This
  // preserves the previous `next_attempt_at = 0` reset semantics for the
  // existing no-delay callers.
  db.prepare(
    `INSERT INTO project_message_authority_outbox
       (message_id, project_id, conversation_id, attempts, next_attempt_at,
        last_error, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, NULL, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       project_id = excluded.project_id,
       conversation_id = excluded.conversation_id,
       next_attempt_at = MIN(project_message_authority_outbox.next_attempt_at, excluded.next_attempt_at),
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    input.messageId,
    input.projectId,
    input.conversationId,
    delayMs > 0 ? now + delayMs : 0,
    now,
    now,
  );
}

export function listProjectMessageAuthorityOutbox(
  db: SqliteDb,
  limit = 100,
): ProjectMessageAuthorityOutboxRecord[] {
  const rows = db.prepare(
    `SELECT message_id, project_id, conversation_id, attempts,
            next_attempt_at, last_error
       FROM project_message_authority_outbox
      WHERE next_attempt_at <= ?
      ORDER BY created_at ASC, message_id ASC
      LIMIT ?`,
  ).all(Date.now(), limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    messageId: String(row.message_id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: Number(row.next_attempt_at) || 0,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
  }));
}

export function completeProjectMessageAuthorityOutbox(
  db: SqliteDb,
  messageId: string,
): void {
  db.prepare(
    `DELETE FROM project_message_authority_outbox WHERE message_id = ?`,
  ).run(messageId);
}

export function failProjectMessageAuthorityOutbox(
  db: SqliteDb,
  messageId: string,
  error: string,
): void {
  const row = db.prepare(
    `SELECT attempts FROM project_message_authority_outbox WHERE message_id = ?`,
  ).get(messageId) as { attempts?: number } | undefined;
  const attempts = Number(row?.attempts ?? 0) + 1;
  const delayMs = Math.min(60_000, 250 * (2 ** Math.min(attempts, 8)));
  const now = Date.now();
  db.prepare(
    `UPDATE project_message_authority_outbox
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE message_id = ?`,
  ).run(attempts, now + delayMs, error.slice(0, 1_000), now, messageId);
}

export function nextProjectMessageAuthorityOutboxDelay(db: SqliteDb): number | null {
  const row = db.prepare(
    `SELECT MIN(next_attempt_at) AS next_attempt_at
       FROM project_message_authority_outbox`,
  ).get() as { next_attempt_at?: number | null } | undefined;
  if (row?.next_attempt_at == null) return null;
  return Math.max(0, Number(row.next_attempt_at) - Date.now());
}
