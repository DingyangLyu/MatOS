// SQLite-backed persistence for projects, conversations, messages, and the
// per-project set of open workspace tabs. The on-disk project folder under
// .od/projects/<id>/ is still the single owner of the user's actual files
// (HTML artifacts, sketches, uploads); this database tracks the metadata
// that used to live in localStorage.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ProjectBrowserWorkspaceTab, ProjectTabsState } from '@open-design/contracts';
import {
  coalesceAdjacentStreamEvents,
  compactEventsForChat,
  messageForChatResponse,
} from './message-payload.js';

type SqliteDb = Database.Database;
type DbRow = Record<string, any>;
type ChatSessionMode = 'design' | 'chat' | 'plan';

let dbInstance: SqliteDb | null = null;
let dbFile: string | null = null;

function row(value: unknown): DbRow | null {
  return value && typeof value === 'object' ? value as DbRow : null;
}

function rows(value: unknown[]): DbRow[] {
  return value.map((item) => row(item) ?? {});
}

export function openDatabase(projectRoot: string, { dataDir }: { dataDir?: string } = {}): SqliteDb {
  const dir = dataDir ? path.resolve(dataDir) : path.join(projectRoot, '.od');
  const file = path.join(dir, 'app.sqlite');
  if (dbInstance && dbFile === file) return dbInstance;
  if (dbInstance) closeDatabase();
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  dbInstance = db;
  dbFile = file;
  return db;
}

export function closeDatabase() {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
  dbFile = null;
}

function inferLegacyMessageTurnLinks(db: SqliteDb, conversationId?: string): void {
  const parameters = conversationId ? [conversationId] : [];
  db.prepare(`
    UPDATE messages AS assistant
       SET turn_user_message_id = (
         SELECT user.id
           FROM messages AS user
          WHERE user.conversation_id = assistant.conversation_id
            AND user.role = 'user'
            AND ABS(user.position - assistant.position) = 1
            AND (
              (assistant.started_at IS NOT NULL AND user.created_at = assistant.started_at)
              OR user.created_at = assistant.created_at
            )
          ORDER BY CASE
                     WHEN user.position = assistant.position - 1 THEN 0
                     ELSE 1
                   END,
                   user.position
          LIMIT 1
       )
     WHERE assistant.role = 'assistant'
       AND assistant.turn_user_message_id IS NULL
       ${conversationId ? 'AND assistant.conversation_id = ?' : ''}
       AND EXISTS (
         SELECT 1
           FROM messages AS user
          WHERE user.conversation_id = assistant.conversation_id
            AND user.role = 'user'
            AND ABS(user.position - assistant.position) = 1
            AND (
              (assistant.started_at IS NOT NULL AND user.created_at = assistant.started_at)
              OR user.created_at = assistant.created_at
            )
       )
  `).run(...parameters);
}

function canonicalMessageOrderSql(where = ''): string {
  return `
    SELECT message.id,
           ROW_NUMBER() OVER (
             PARTITION BY message.conversation_id
             ORDER BY COALESCE(turn_user.created_at, message.created_at) ASC,
                      COALESCE(turn_user.position, message.position) ASC,
                      CASE message.role
                        WHEN 'user' THEN 0
                        WHEN 'system' THEN 1
                        WHEN 'assistant' THEN 2
                        ELSE 3
                      END ASC,
                      message.position ASC,
                      message.id ASC
           ) - 1 AS canonical_position
      FROM messages AS message
      LEFT JOIN messages AS turn_user
        ON turn_user.id = message.turn_user_message_id
       AND turn_user.conversation_id = message.conversation_id
       AND turn_user.role = 'user'
      ${where}
  `;
}

function resequenceMessages(db: SqliteDb, conversationId?: string): void {
  inferLegacyMessageTurnLinks(db, conversationId);
  const parameters = conversationId ? [conversationId] : [];
  const orderedSql = canonicalMessageOrderSql(
    conversationId ? 'WHERE message.conversation_id = ?' : '',
  );
  const mismatch = db.prepare(`
    SELECT 1
      FROM (${orderedSql}) AS ordered
      JOIN messages ON messages.id = ordered.id
     WHERE messages.position <> ordered.canonical_position
     LIMIT 1
  `).get(...parameters);
  if (!mismatch) return;
  db.prepare(`
    WITH ordered AS (${orderedSql})
    UPDATE messages
       SET position = (
         SELECT canonical_position FROM ordered WHERE ordered.id = messages.id
       )
     WHERE id IN (SELECT id FROM ordered)
  `).run(...parameters);
}

export function reconcileMessageTurnOrder(
  db: SqliteDb,
  conversationId: string,
  turns: Array<{ userMessageId: string; assistantMessageId: string }>,
): void {
  if (turns.length === 0) return;
  const link = db.prepare(`
    UPDATE messages AS assistant
       SET turn_user_message_id = ?
     WHERE assistant.id = ?
       AND assistant.conversation_id = ?
       AND assistant.role = 'assistant'
       AND EXISTS (
         SELECT 1 FROM messages AS user
          WHERE user.id = ?
            AND user.conversation_id = assistant.conversation_id
            AND user.role = 'user'
       )
  `);
  db.transaction(() => {
    for (const turn of turns) {
      link.run(
        turn.userMessageId,
        turn.assistantMessageId,
        conversationId,
        turn.userMessageId,
      );
    }
    resequenceMessages(db, conversationId);
  })();
}

function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      pending_prompt TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_name_counters (
      base TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value > 0)
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_project_id TEXT,
      files_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      session_mode TEXT NOT NULL DEFAULT 'design',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conv_project
      ON conversations(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      conversation_id TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      stable_prompt_hash TEXT,
      -- Resume identity guard: the session is only safe to resume when the
      -- conversation has not changed shape under it. model/cwd are the runtime
      -- identity the upstream session was created with; a change forces a fresh
      -- session. last_message_id is the assistant message this session produced
      -- on its last turn -- if it is no longer the latest completed assistant
      -- turn (another agent ran in between, or it was edited away), the session
      -- is behind and we reseed the full transcript.
      model           TEXT,
      cwd             TEXT,
      last_message_id TEXT,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, agent_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      events_json TEXT,
      events_chat_json TEXT,
      attachments_json TEXT,
      produced_files_json TEXT,
      trace_object_files_json TEXT,
      feedback_json TEXT,
      pre_turn_file_names_json TEXT,
      pre_turn_files_json TEXT,
      session_mode TEXT,
      run_context_json TEXT,
      telemetry_finalized_at INTEGER,
      group_task_json TEXT,
      reply_to_json TEXT,
      turn_user_message_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, position);

    CREATE TABLE IF NOT EXISTS project_group_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      member_ref TEXT NOT NULL,
      member_id TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      authority_state TEXT NOT NULL DEFAULT 'ready',
      run_id TEXT,
      claim_token TEXT,
      worker_id TEXT,
      worker_pid INTEGER,
      child_pid INTEGER,
      lease_expires_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      source_message_id TEXT,
      relay_hop INTEGER NOT NULL DEFAULT 0,
      client_request_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_group_tasks_queue
      ON project_group_tasks(project_id, conversation_id, status, created_at);

    CREATE TABLE IF NOT EXISTS project_group_task_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(task_id, operation),
      FOREIGN KEY(task_id) REFERENCES project_group_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_message_authority_outbox (
      message_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS preview_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      element_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      position_json TEXT NOT NULL,
      html_hint TEXT NOT NULL,
      selection_kind TEXT,
      member_count INTEGER,
      pod_members_json TEXT,
      style_json TEXT,
      attachments_json TEXT,
      slide_index INTEGER,
      slide_key INTEGER NOT NULL DEFAULT -1,
      note TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, conversation_id, file_path, element_id, slide_key),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation
      ON preview_comments(project_id, conversation_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation_created
      ON preview_comments(project_id, conversation_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tabs (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id, name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tabs_state (
      project_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      state_json TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tabs_project
      ON tabs(project_id, position);

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_json TEXT,
      project_mode TEXT NOT NULL,
      project_id TEXT,
      skill_id TEXT,
      agent_id TEXT,
      context_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      summary TEXT,
      error TEXT,
      error_code TEXT,
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS routine_schedule_claims (
      routine_id TEXT NOT NULL,
      slot_at INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(routine_id, slot_at),
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);
  `);
  // Forward-compatible column add for databases created before metadata_json.
  // SQLite has no IF NOT EXISTS for ALTER, so we check pragma_table_info.
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as DbRow[];
  if (!cols.some((c: DbRow) => c.name === 'metadata_json')) {
    db.exec(`ALTER TABLE projects ADD COLUMN metadata_json TEXT`);
  }
  if (!cols.some((c: DbRow) => c.name === 'custom_instructions')) {
    db.exec(`ALTER TABLE projects ADD COLUMN custom_instructions TEXT`);
  }
  const conversationCols = db.prepare(`PRAGMA table_info(conversations)`).all() as DbRow[];
  if (!conversationCols.some((c: DbRow) => c.name === 'session_mode')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'design'`);
  }
  if (!conversationCols.some((c: DbRow) => c.name === 'role_ref')) {
    // MatOS member DM binding: runs in this conversation pin to this role.
    db.exec(`ALTER TABLE conversations ADD COLUMN role_ref TEXT`);
  }
  if (!conversationCols.some((c: DbRow) => c.name === 'member_refs')) {
    // MatOS group chat roster: JSON array of `role:<id>` members that can be
    // @-addressed in this conversation. Null/empty for plain DMs.
    db.exec(`ALTER TABLE conversations ADD COLUMN member_refs TEXT`);
  }
  if (!conversationCols.some((c: DbRow) => c.name === 'group_auto_relay')) {
    // MatOS group auto-relay toggle. NULL/1 = enabled (default), 0 = the
    // daemon must not auto-dispatch a member's trailing "@NAME: task"
    // handoff lines. Persisted because relay continuation is daemon-owned.
    db.exec(`ALTER TABLE conversations ADD COLUMN group_auto_relay INTEGER`);
  }
  const groupTaskCols = db.prepare(`PRAGMA table_info(project_group_tasks)`).all() as DbRow[];
  if (!groupTaskCols.some((c: DbRow) => c.name === 'client_request_id')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN client_request_id TEXT`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'member_id')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN member_id TEXT`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'sequence')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'authority_state')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN authority_state TEXT NOT NULL DEFAULT 'ready'`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'claim_token')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN claim_token TEXT`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'worker_id')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN worker_id TEXT`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'worker_pid')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN worker_pid INTEGER`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'child_pid')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN child_pid INTEGER`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'lease_expires_at')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN lease_expires_at INTEGER`);
  }
  if (!groupTaskCols.some((c: DbRow) => c.name === 'attempt')) {
    db.exec(`ALTER TABLE project_group_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_group_task_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(task_id, operation),
      FOREIGN KEY(task_id) REFERENCES project_group_tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`DROP INDEX IF EXISTS idx_project_group_tasks_queue`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_group_tasks_queue
      ON project_group_tasks(project_id, conversation_id, status, authority_state, sequence, created_at)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_group_tasks_client_request
      ON project_group_tasks(project_id, conversation_id, client_request_id)
      WHERE client_request_id IS NOT NULL
  `);
  const messageCols = db.prepare(`PRAGMA table_info(messages)`).all() as DbRow[];
  if (!messageCols.some((c: DbRow) => c.name === 'role_ref')) {
    // MatOS role that produced the assistant turn (roles project as models).
    db.exec(`ALTER TABLE messages ADD COLUMN role_ref TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'agent_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN agent_id TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'agent_name')) {
    db.exec(`ALTER TABLE messages ADD COLUMN agent_name TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'run_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN run_id TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'run_status')) {
    db.exec(`ALTER TABLE messages ADD COLUMN run_status TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'last_run_event_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN last_run_event_id TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'events_chat_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN events_chat_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'comment_attachments_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN comment_attachments_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'feedback_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN feedback_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'pre_turn_file_names_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN pre_turn_file_names_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'pre_turn_files_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN pre_turn_files_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'trace_object_files_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN trace_object_files_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'session_mode')) {
    db.exec(`ALTER TABLE messages ADD COLUMN session_mode TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'run_context_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN run_context_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'telemetry_finalized_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN telemetry_finalized_at INTEGER`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'group_task_json')) {
    // MatOS group-task provenance for DM work-ledger rows mirrored from a
    // group chat (see ChatMessageGroupTask in contracts).
    db.exec(`ALTER TABLE messages ADD COLUMN group_task_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'reply_to_json')) {
    // Quote-reply provenance (see ChatMessageReplyRef in contracts): which
    // earlier message in the same conversation this message anchors to.
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_json TEXT`);
  }
  if (!messageCols.some((c: DbRow) => c.name === 'turn_user_message_id')) {
    // Causal turn link. Browser and daemon clocks are independent, so a
    // response must not be ordered solely by created_at wall-clock values.
    db.exec(`ALTER TABLE messages ADD COLUMN turn_user_message_id TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_message_authority_outbox (
      message_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  // Recovery baselines are only needed until produced-file and telemetry
  // finalization completes. Keeping them on every historical turn made some
  // conversations tens of megabytes and blocked the daemon event loop on read.
  db.exec(`
    UPDATE messages
       SET pre_turn_file_names_json = NULL,
           pre_turn_files_json = NULL
     WHERE telemetry_finalized_at IS NOT NULL
       AND (pre_turn_file_names_json IS NOT NULL OR pre_turn_files_json IS NOT NULL)
  `);
  const finalizedEvents = db.prepare(`
    SELECT id, events_json AS eventsJson
      FROM messages
     WHERE telemetry_finalized_at IS NOT NULL
       AND events_json IS NOT NULL
       AND events_chat_json IS NULL
  `).all() as DbRow[];
  if (finalizedEvents.length > 0) {
    const cacheChatEvents = db.prepare(
      `UPDATE messages SET events_chat_json = ? WHERE id = ?`,
    );
    db.transaction(() => {
      for (const message of finalizedEvents) {
        const compacted = compactEventsForChat(parseJsonOrUndef(message.eventsJson));
        cacheChatEvents.run(compacted ? JSON.stringify(compacted) : null, message.id);
      }
    })();
  }
  // Older clients fired the user and assistant PUTs concurrently, so slower
  // timeline persistence could assign the assistant a lower position. This is
  // idempotent and repairs existing ledgers when the daemon opens its database.
  resequenceMessages(db);
  const routineRunCols = db.prepare(`PRAGMA table_info(routine_runs)`).all() as DbRow[];
  if (!routineRunCols.some((c: DbRow) => c.name === 'error_code')) {
    db.exec(`ALTER TABLE routine_runs ADD COLUMN error_code TEXT`);
  }

  const previewCommentCols = db.prepare(`PRAGMA table_info(preview_comments)`).all() as DbRow[];
  if (!previewCommentCols.some((c: DbRow) => c.name === 'selection_kind')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN selection_kind TEXT`);
  }
  if (!previewCommentCols.some((c: DbRow) => c.name === 'member_count')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN member_count INTEGER`);
  }
  if (!previewCommentCols.some((c: DbRow) => c.name === 'pod_members_json')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN pod_members_json TEXT`);
  }
  if (!previewCommentCols.some((c: DbRow) => c.name === 'style_json')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN style_json TEXT`);
  }
  if (!previewCommentCols.some((c: DbRow) => c.name === 'attachments_json')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN attachments_json TEXT`);
  }
  if (!previewCommentCols.some((c: DbRow) => c.name === 'slide_index')) {
    db.exec(`ALTER TABLE preview_comments ADD COLUMN slide_index INTEGER`);
  }
  migratePreviewCommentsSlideKey(db);
  // schedule_json holds the full RoutineSchedule object (kind discriminator
  // plus kind-specific fields like time/timezone/weekday). The legacy
  // schedule_kind/schedule_value columns are kept populated for query
  // convenience and as a fallback when reading rows written before this
  // column existed.
  const routineCols = db.prepare(`PRAGMA table_info(routines)`).all() as DbRow[];
  if (routineCols.length > 0 && !routineCols.some((c: DbRow) => c.name === 'schedule_json')) {
    db.exec(`ALTER TABLE routines ADD COLUMN schedule_json TEXT`);
  }
  if (routineCols.length > 0 && !routineCols.some((c: DbRow) => c.name === 'context_json')) {
    db.exec(`ALTER TABLE routines ADD COLUMN context_json TEXT`);
  }
  const agentSessionCols = db.prepare(`PRAGMA table_info(agent_sessions)`).all() as DbRow[];
  if (agentSessionCols.length > 0 && !agentSessionCols.some((c: DbRow) => c.name === 'stable_prompt_hash')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN stable_prompt_hash TEXT`);
  }
  // Resume identity guard columns (see agent_sessions CREATE TABLE comment).
  if (agentSessionCols.length > 0 && !agentSessionCols.some((c: DbRow) => c.name === 'model')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN model TEXT`);
  }
  if (agentSessionCols.length > 0 && !agentSessionCols.some((c: DbRow) => c.name === 'cwd')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN cwd TEXT`);
  }
  if (agentSessionCols.length > 0 && !agentSessionCols.some((c: DbRow) => c.name === 'last_message_id')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN last_message_id TEXT`);
  }
  const tabsStateCols = db.prepare(`PRAGMA table_info(tabs_state)`).all() as DbRow[];
  if (tabsStateCols.length > 0 && !tabsStateCols.some((c: DbRow) => c.name === 'state_json')) {
    db.exec(`ALTER TABLE tabs_state ADD COLUMN state_json TEXT`);
  }
}

function migratePreviewCommentsSlideKey(db: SqliteDb): void {
  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'preview_comments'`)
    .get() as DbRow | undefined;
  const tableSql = String(table?.sql ?? '');
  const hasSlideKey = /\bslide_key\b/i.test(tableSql);
  const hasLegacyUnique = /UNIQUE\s*\(\s*project_id\s*,\s*conversation_id\s*,\s*file_path\s*,\s*element_id\s*\)/i
    .test(tableSql);
  if (hasSlideKey && !hasLegacyUnique) return;

  db.exec(`
    CREATE TABLE preview_comments_next (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      element_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      position_json TEXT NOT NULL,
      html_hint TEXT NOT NULL,
      selection_kind TEXT,
      member_count INTEGER,
      pod_members_json TEXT,
      style_json TEXT,
      attachments_json TEXT,
      slide_index INTEGER,
      slide_key INTEGER NOT NULL DEFAULT -1,
      note TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, conversation_id, file_path, element_id, slide_key),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    INSERT INTO preview_comments_next
      (id, project_id, conversation_id, file_path, element_id, selector, label,
       text, position_json, html_hint, selection_kind, member_count, pod_members_json,
       style_json, attachments_json, slide_index, slide_key, note, status, created_at, updated_at)
    SELECT id, project_id, conversation_id, file_path, element_id, selector, label,
       text, position_json, html_hint, selection_kind, member_count, pod_members_json,
       style_json, attachments_json, slide_index, COALESCE(slide_index, -1), note, status, created_at, updated_at
      FROM preview_comments;

    DROP TABLE preview_comments;
    ALTER TABLE preview_comments_next RENAME TO preview_comments;
    CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation
      ON preview_comments(project_id, conversation_id, updated_at DESC);
  `);
}

// ---------- projects ----------

const PROJECT_COLS = `id, name, skill_id AS skillId,
  pending_prompt AS pendingPrompt,
  metadata_json AS metadataJson,
  custom_instructions AS customInstructions,
  created_at AS createdAt,
  updated_at AS updatedAt`;

export function listProjects(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT ${PROJECT_COLS}
         FROM projects
        ORDER BY updated_at DESC`,
    )
    .all() as DbRow[];
  return rows.map(normalizeProject);
}

export function listLatestProjectRunStatuses(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT c.project_id AS projectId,
              m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.run_status IS NOT NULL
        ORDER BY updatedAt DESC`,
    )
    .all() as DbRow[];
  const latestByProject = new Map<string, DbRow>();
  for (const row of rows) {
    if (!latestByProject.has(row.projectId)) {
      latestByProject.set(row.projectId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return latestByProject;
}

/** One bounded list projection over existing visible conversation metadata.
 * No message bodies, model calls or per-project filesystem scans. */
export function listProjectConversationOverviews(db: SqliteDb) {
  const rows = db.prepare(`
    SELECT projectId, conversationCount, title FROM (
      SELECT project_id AS projectId, title,
        COUNT(*) OVER (PARTITION BY project_id) AS conversationCount,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, id ASC) AS ordinal
      FROM conversations
    ) WHERE ordinal = 1
  `).all() as Array<{ projectId: string; conversationCount: number; title: string | null }>;
  return new Map(rows.map(row => [row.projectId, {
    conversationCount: row.conversationCount,
    ...(row.title?.trim() ? { latestConversationTitle: row.title.trim().slice(0, 240) } : {}),
  }]));
}

export function listLatestConversationRunStatuses(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT m.conversation_id AS conversationId,
              m.run_id AS runId,
              m.run_status AS status,
              COALESCE(m.ended_at, m.started_at, m.created_at) AS updatedAt,
              m.position AS position
         FROM messages m
        WHERE m.run_status IS NOT NULL
        ORDER BY updatedAt DESC, m.position DESC`,
    )
    .all() as DbRow[];
  const latestByConversation = new Map<string, DbRow>();
  for (const row of rows) {
    if (!latestByConversation.has(row.conversationId)) {
      latestByConversation.set(row.conversationId, {
        value: normalizeProjectRunStatus(row.status),
        updatedAt: Number(row.updatedAt),
        runId: row.runId ?? undefined,
      });
    }
  }
  return latestByConversation;
}

export function listProjectsAwaitingInput(db: SqliteDb) {
  const rows = db
    .prepare(
      `SELECT latest.projectId
         FROM (
           SELECT c.project_id AS projectId,
                  m.conversation_id AS conversationId,
                  m.created_at AS createdAt,
                  m.position AS position,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.project_id
                    ORDER BY m.created_at DESC, m.position DESC
                  ) AS rowNum
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE m.role = 'assistant'
              -- ask-question is an accepted alias for question-form (UI parser
              -- + daemon open-tag matcher), so an alias-form turn must also
              -- count as awaiting input.
              AND (
                LOWER(m.content) LIKE '%<question-form%'
                OR LOWER(m.content) LIKE '%<ask-question%'
              )
         ) latest
        WHERE latest.rowNum = 1
          AND NOT EXISTS (
            SELECT 1
              FROM messages reply
             WHERE reply.conversation_id = latest.conversationId
               AND reply.role = 'user'
               AND (
                 reply.created_at > latest.createdAt
                 OR (reply.created_at = latest.createdAt AND reply.position > latest.position)
               )
          )`,
    )
    .all() as DbRow[];
  return new Set((rows as DbRow[]).map((row: DbRow) => row.projectId));
}

export function getProject(db: SqliteDb, id: string) {
  const row = db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`)
    .get(id) as DbRow | undefined;
  return row ? normalizeProject(row) : null;
}

export function insertProject(db: SqliteDb, p: DbRow) {
  db.prepare(
    `INSERT INTO projects
       (id, name, skill_id, pending_prompt,
        metadata_json, custom_instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.name,
    p.skillId ?? null,
    p.pendingPrompt ?? null,
    p.metadata ? JSON.stringify(p.metadata) : null,
    p.customInstructions ?? null,
    p.createdAt,
    p.updatedAt,
  );
  return getProject(db, p.id);
}

export function updateProject(db: SqliteDb, id: string, patch: DbRow) {
  const existing = getProject(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  db.prepare(
    `UPDATE projects
        SET name = ?,
            skill_id = ?,
            pending_prompt = ?,
            metadata_json = ?,
            custom_instructions = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.skillId ?? null,
    merged.pendingPrompt ?? null,
    merged.metadata ? JSON.stringify(merged.metadata) : null,
    merged.customInstructions ?? null,
    merged.updatedAt,
    id,
  );
  return getProject(db, id);
}

export function deleteProject(db: SqliteDb, id: string) {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

function normalizeProject(row: DbRow) {
  let metadata;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson);
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    name: row.name,
    skillId: row.skillId,
    pendingPrompt: row.pendingPrompt ?? undefined,
    metadata,
    customInstructions: row.customInstructions ?? undefined,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function normalizeProjectRunStatus(status: unknown) {
  if (status === 'starting') return 'running';
  if (status === 'cancelled') return 'canceled';
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled'
  ) {
    return status;
  }
  return 'not_started';
}

// ---------- templates ----------

export function listTemplates(db: SqliteDb) {
  return (db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates
        ORDER BY created_at DESC`,
    )
    .all() as DbRow[])
    .map(normalizeTemplate);
}

export function getTemplate(db: SqliteDb, id: string) {
  const row = db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates WHERE id = ?`,
    )
    .get(id) as DbRow | undefined;
  return row ? normalizeTemplate(row) : null;
}

export function findTemplateByNameAndProject(
  db: SqliteDb,
  name: string,
  sourceProjectId: string,
) {
  const row = db
    .prepare(
      `SELECT id, name, description, source_project_id AS sourceProjectId,
              files_json AS filesJson, created_at AS createdAt
         FROM templates
        WHERE name = ? AND source_project_id = ?`,
    )
    .get(name, sourceProjectId) as DbRow | undefined;
  return row ? normalizeTemplate(row) : null;
}

export function insertTemplate(db: SqliteDb, t: DbRow) {
  db.prepare(
    `INSERT INTO templates (id, name, description, source_project_id, files_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.name,
    t.description ?? null,
    t.sourceProjectId ?? null,
    JSON.stringify(t.files ?? []),
    t.createdAt,
  );
  return getTemplate(db, t.id);
}

export function updateTemplate(
  db: SqliteDb,
  id: string,
  t: { description: string | null; files: unknown[] },
) {
  db.prepare(
    `UPDATE templates SET description = ?, files_json = ? WHERE id = ?`,
  ).run(t.description, JSON.stringify(t.files), id);
  return getTemplate(db, id);
}

export function deleteTemplate(db: SqliteDb, id: string) {
  db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
}

function normalizeTemplate(row: DbRow) {
  let files = [];
  try {
    files = JSON.parse(row.filesJson || '[]');
  } catch {
    files = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    sourceProjectId: row.sourceProjectId ?? undefined,
    files,
    createdAt: Number(row.createdAt),
  };
}

// ---------- conversations ----------

export function listConversations(db: SqliteDb, projectId: string) {
  return rows(db
    .prepare(
      `WITH project_conversations AS (
          SELECT id, project_id AS projectId, title, session_mode AS sessionMode,
                 role_ref AS roleRef, member_refs AS memberRefs,
                 group_auto_relay AS groupAutoRelay,
                 created_at AS createdAt, updated_at AS updatedAt
            FROM conversations
           WHERE project_id = ?
        ),
        latest_runs AS (
          SELECT conversation_id AS conversationId,
                 run_status AS latestRunStatus,
                 started_at AS latestRunStartedAt,
                 ended_at AS latestRunEndedAt,
                 events_json AS latestRunEventsJson
            FROM (
              SELECT m.conversation_id,
                     m.run_status,
                     m.started_at,
                     m.ended_at,
                     m.events_json,
                     ROW_NUMBER() OVER (
                       PARTITION BY m.conversation_id
                       ORDER BY m.position DESC
                     ) AS rn
                FROM messages m
                JOIN project_conversations c ON c.id = m.conversation_id
               WHERE m.role = 'assistant'
                 AND m.run_status IS NOT NULL
            )
           WHERE rn = 1
        ),
        message_counts AS (
          SELECT m.conversation_id AS conversationId,
                 COUNT(*) AS messageCount
            FROM messages m
            JOIN project_conversations c ON c.id = m.conversation_id
           GROUP BY m.conversation_id
        ),
        total_run_durations AS (
          SELECT m.conversation_id AS conversationId,
                 SUM(${terminalRunDurationSql('m')}) AS totalDurationMs
            FROM messages m
            JOIN project_conversations c ON c.id = m.conversation_id
           WHERE m.role = 'assistant'
             AND m.run_status IN ('succeeded', 'failed', 'canceled')
           GROUP BY m.conversation_id
        )
        SELECT c.id, c.projectId, c.title, c.sessionMode, c.roleRef, c.memberRefs, c.groupAutoRelay, c.createdAt, c.updatedAt,
               COALESCE(mc.messageCount, 0) AS messageCount,
               lr.latestRunStatus, lr.latestRunStartedAt,
               lr.latestRunEndedAt, lr.latestRunEventsJson,
               trd.totalDurationMs
          FROM project_conversations c
          LEFT JOIN latest_runs lr ON lr.conversationId = c.id
          LEFT JOIN message_counts mc ON mc.conversationId = c.id
          LEFT JOIN total_run_durations trd ON trd.conversationId = c.id
         ORDER BY c.updatedAt DESC`,
    )
    .all(projectId)).map(normalizeConversation);
}

export function getConversation(db: SqliteDb, id: string) {
  const r = db
    .prepare(
      `SELECT id, project_id AS projectId, title, session_mode AS sessionMode,
              role_ref AS roleRef, member_refs AS memberRefs,
              group_auto_relay AS groupAutoRelay,
              created_at AS createdAt, updated_at AS updatedAt,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) AS messageCount
         FROM conversations WHERE id = ?`,
    )
    .get(id) as DbRow | undefined;
  if (!r) return null;
  return {
    ...normalizeConversation(r),
    latestRun: latestConversationRunSummary(db, r.id) ?? undefined,
    ...numberProperty('totalDurationMs', totalConversationRunDurationMs(db, r.id)),
  };
}

function normalizeConversation(r: DbRow) {
  const latestRun = conversationRunSummaryFromRow({
    runStatus: r.latestRunStatus,
    startedAt: r.latestRunStartedAt,
    endedAt: r.latestRunEndedAt,
    eventsJson: r.latestRunEventsJson,
  });
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title ?? null,
    sessionMode: normalizeConversationSessionMode(r.sessionMode),
    roleRef: normalizeConversationRoleRef(r.roleRef),
    memberRefs: normalizeConversationMemberRefs(r.memberRefs) ?? undefined,
    ...(r.groupAutoRelay === null || r.groupAutoRelay === undefined
      ? {}
      : { groupAutoRelay: Number(r.groupAutoRelay) !== 0 }),
    messageCount: Number(r.messageCount ?? 0),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    ...numberProperty('totalDurationMs', r.totalDurationMs),
    latestRun: latestRun ?? undefined,
  };
}

/** MatOS member binding: only unversioned-ish `role:<id>` refs are stored. */
export function normalizeConversationRoleRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return /^role:[A-Za-z0-9._@\/-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * MatOS group-task provenance (`group_task_json`). Accepts an object (or the
 * JSON-encoded column value) and keeps only the well-formed contract fields;
 * anything malformed collapses to null so a bad client payload cannot store
 * an unbounded blob or a record that fails to parse back.
 */
export function normalizeMessageGroupTask(value: unknown): {
  taskId?: string;
  sourceProjectId: string;
  sourceConversationId: string;
  sourceConversationTitle?: string | null;
  sourceMessageId: string;
  memberRef: string;
  memberName?: string;
} | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const requiredString = (key: string): string | null => {
    const entry = record[key];
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    return trimmed && trimmed.length <= 400 ? trimmed : null;
  };
  const sourceProjectId = requiredString('sourceProjectId');
  const sourceConversationId = requiredString('sourceConversationId');
  const sourceMessageId = requiredString('sourceMessageId');
  const memberRef = normalizeConversationRoleRef(record.memberRef);
  if (!sourceProjectId || !sourceConversationId || !sourceMessageId || !memberRef) {
    return null;
  }
  const title =
    typeof record.sourceConversationTitle === 'string'
      ? record.sourceConversationTitle.trim().slice(0, 400)
      : null;
  const memberName =
    typeof record.memberName === 'string' ? record.memberName.trim().slice(0, 200) : '';
  const taskId = requiredString('taskId');
  return {
    ...(taskId ? { taskId } : {}),
    sourceProjectId,
    sourceConversationId,
    sourceConversationTitle: title || null,
    sourceMessageId,
    memberRef,
    ...(memberName ? { memberName } : {}),
  };
}

/**
 * Quote-reply provenance (`reply_to_json`, see ChatMessageReplyRef). Accepts
 * an object (or the JSON-encoded column value) and keeps only well-formed
 * bounded fields; anything malformed collapses to null so a bad client
 * payload cannot store an unbounded blob or a record that fails to parse.
 */
export function normalizeMessageReplyRef(value: unknown): {
  messageId: string;
  roleRef?: string | null;
  authorName?: string | null;
  excerpt: string;
} | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  if (!messageId || messageId.length > 400) return null;
  const excerpt = typeof record.excerpt === 'string'
    ? record.excerpt.replace(/\s+/g, ' ').trim().slice(0, 400)
    : '';
  const roleRef = normalizeConversationRoleRef(record.roleRef);
  const authorName = typeof record.authorName === 'string'
    ? record.authorName.trim().slice(0, 200)
    : '';
  return {
    messageId,
    ...(roleRef ? { roleRef } : {}),
    ...(authorName ? { authorName } : {}),
    excerpt,
  };
}

/**
 * MatOS group chat roster. Accepts an array (or a JSON-encoded array read
 * back from `member_refs`), keeps only well-formed `role:<id>` refs, dedupes
 * while preserving order, and caps the roster so a malformed client payload
 * cannot store an unbounded blob. Returns null for an empty/invalid roster so
 * the column stays NULL for plain DMs.
 */
export function normalizeConversationMemberRefs(value: unknown): string[] | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const ref = normalizeConversationRoleRef(entry);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
    if (out.length >= 64) break;
  }
  return out.length > 0 ? out : null;
}

/** Serialize a roster for the `member_refs` column (NULL when empty). */
function serializeConversationMemberRefs(value: unknown): string | null {
  const refs = normalizeConversationMemberRefs(value);
  return refs ? JSON.stringify(refs) : null;
}

export function normalizeConversationSessionMode(value: unknown): ChatSessionMode {
  return value === 'chat' || value === 'plan' ? value : 'design';
}

function numberProperty(key: string, value: unknown) {
  const n = value == null ? undefined : Number(value);
  return typeof n === 'number' && Number.isFinite(n) ? { [key]: n } : {};
}

function latestConversationRunSummary(db: SqliteDb, conversationId: string) {
  const row = db
    .prepare(
      `SELECT run_status AS runStatus,
              started_at AS startedAt,
              ended_at AS endedAt,
              events_json AS eventsJson
         FROM messages
        WHERE conversation_id = ?
          AND role = 'assistant'
          AND run_status IS NOT NULL
        ORDER BY position DESC
        LIMIT 1`,
    )
    .get(conversationId) as DbRow | undefined;
  return conversationRunSummaryFromRow(row);
}

function totalConversationRunDurationMs(db: SqliteDb, conversationId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT SUM(${terminalRunDurationSql()}) AS totalDurationMs
         FROM messages
        WHERE conversation_id = ?
          AND role = 'assistant'
          AND run_status IN ('succeeded', 'failed', 'canceled')`,
    )
    .get(conversationId) as DbRow | undefined;
  return row?.totalDurationMs == null ? undefined : Number(row.totalDurationMs);
}

function terminalRunDurationSql(alias?: string) {
  const p = alias ? `${alias}.` : '';
  return `CASE
            WHEN ${p}started_at IS NOT NULL AND ${p}ended_at IS NOT NULL THEN
              CASE
                WHEN CAST(${p}ended_at AS INTEGER) >= CAST(${p}started_at AS INTEGER)
                  THEN CAST(${p}ended_at AS INTEGER) - CAST(${p}started_at AS INTEGER)
                ELSE 0
              END
            ELSE (
              SELECT CASE
                       WHEN json_extract(usage_event.value, '$.durationMs') >= 0
                         THEN json_extract(usage_event.value, '$.durationMs')
                       ELSE 0
                     END
                FROM json_each(
                  CASE
                    WHEN json_valid(${p}events_json) AND json_type(${p}events_json) = 'array'
                      THEN ${p}events_json
                    ELSE '[]'
                  END
                ) AS usage_event
               WHERE usage_event.type = 'object'
                 AND json_extract(usage_event.value, '$.kind') = 'usage'
                 AND json_type(usage_event.value, '$.durationMs') IN ('integer', 'real')
               ORDER BY CAST(usage_event.key AS INTEGER) DESC
               LIMIT 1
            )
          END`;
}

function conversationRunSummaryFromRow(row: DbRow | undefined) {
  if (!row || typeof row.runStatus !== 'string') return null;
  const startedAt = row.startedAt == null ? undefined : Number(row.startedAt);
  const endedAt = row.endedAt == null ? undefined : Number(row.endedAt);
  const usageDurationMs = latestUsageDurationMs(row.eventsJson);
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, (endedAt as number) - (startedAt as number))
      : usageDurationMs;
  return {
    status: row.runStatus,
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs)
      ? { durationMs }
      : {}),
  };
}

function latestUsageDurationMs(eventsJson: unknown): number | undefined {
  if (typeof eventsJson !== 'string' || eventsJson.length === 0) return undefined;
  try {
    const events = JSON.parse(eventsJson);
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        event &&
        typeof event === 'object' &&
        event.kind === 'usage' &&
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs)
      ) {
        return Math.max(0, event.durationMs);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function insertConversation(db: SqliteDb, c: DbRow) {
  db.prepare(
    `INSERT INTO conversations
       (id, project_id, title, session_mode, role_ref, member_refs, group_auto_relay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.projectId,
    c.title ?? null,
    normalizeConversationSessionMode(c.sessionMode),
    normalizeConversationRoleRef(c.roleRef),
    serializeConversationMemberRefs(c.memberRefs),
    serializeGroupAutoRelay(c.groupAutoRelay),
    c.createdAt,
    c.updatedAt,
  );
  return getConversation(db, c.id);
}

/** NULL keeps the "unset -> enabled" default; 0/1 are explicit user choices. */
function serializeGroupAutoRelay(value: unknown): number | null {
  if (typeof value !== 'boolean') return null;
  return value ? 1 : 0;
}

export function updateConversation(db: SqliteDb, id: string, patch: DbRow) {
  const existing = getConversation(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    sessionMode: Object.prototype.hasOwnProperty.call(patch, 'sessionMode')
      ? normalizeConversationSessionMode(patch.sessionMode)
      : existing.sessionMode,
    roleRef: Object.prototype.hasOwnProperty.call(patch, 'roleRef')
      ? normalizeConversationRoleRef(patch.roleRef)
      : normalizeConversationRoleRef(existing.roleRef),
    memberRefs: Object.prototype.hasOwnProperty.call(patch, 'memberRefs')
      ? normalizeConversationMemberRefs(patch.memberRefs)
      : normalizeConversationMemberRefs(existing.memberRefs),
    groupAutoRelay: Object.prototype.hasOwnProperty.call(patch, 'groupAutoRelay')
      ? (typeof patch.groupAutoRelay === 'boolean' ? patch.groupAutoRelay : undefined)
      : (existing as { groupAutoRelay?: boolean }).groupAutoRelay,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  db.prepare(
    `UPDATE conversations
        SET title = ?, session_mode = ?, role_ref = ?, member_refs = ?, group_auto_relay = ?, updated_at = ? WHERE id = ?`,
  ).run(
    merged.title ?? null,
    merged.sessionMode,
    merged.roleRef,
    serializeConversationMemberRefs(merged.memberRefs),
    serializeGroupAutoRelay(merged.groupAutoRelay),
    merged.updatedAt,
    id,
  );
  return getConversation(db, id);
}

export function deleteConversation(db: SqliteDb, id: string) {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

// ---------- agent sessions ----------

export function getAgentSession(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT session_id FROM agent_sessions
        WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId) as DbRow | undefined;
  return row && typeof row.session_id === 'string' ? row.session_id : null;
}

export function upsertAgentSession(
  db: SqliteDb,
  input: {
    conversationId: string;
    agentId: string;
    sessionId: string;
    stablePromptHash?: string | null;
    model?: string | null;
    cwd?: string | null;
    lastMessageId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO agent_sessions
       (conversation_id, agent_id, session_id, stable_prompt_hash, model, cwd, last_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, agent_id)
       DO UPDATE SET session_id = excluded.session_id,
                     stable_prompt_hash = excluded.stable_prompt_hash,
                     model = excluded.model,
                     cwd = excluded.cwd,
                     last_message_id = excluded.last_message_id,
                     updated_at = excluded.updated_at`,
  ).run(
    input.conversationId,
    input.agentId,
    input.sessionId,
    input.stablePromptHash ?? null,
    input.model ?? null,
    input.cwd ?? null,
    input.lastMessageId ?? null,
    Date.now(),
  );
}

export function getAgentSessionRecord(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): {
  sessionId: string;
  stablePromptHash: string | null;
  model: string | null;
  cwd: string | null;
  lastMessageId: string | null;
} | null {
  const row = db
    .prepare(
      `SELECT session_id, stable_prompt_hash, model, cwd, last_message_id FROM agent_sessions
        WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId) as DbRow | undefined;
  if (!row || typeof row.session_id !== 'string') return null;
  return {
    sessionId: row.session_id,
    stablePromptHash:
      typeof row.stable_prompt_hash === 'string' ? row.stable_prompt_hash : null,
    model: typeof row.model === 'string' ? row.model : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    lastMessageId: typeof row.last_message_id === 'string' ? row.last_message_id : null,
  };
}

// The freshest stored MatOS CLI session for a conversation, regardless of
// which role variant (`matos` / `matos:<role-ref>`) owns it. The web
// side-question path (`/btw`) forks whatever native session the conversation
// last ran on, so it wants "the conversation's MatOS session", not one exact
// (conversation, agent) key.
export function latestMatOSAgentSession(
  db: SqliteDb,
  conversationId: string,
): { sessionId: string; model: string | null; cwd: string | null } | null {
  const row = db
    .prepare(
      `SELECT session_id, model, cwd FROM agent_sessions
        WHERE conversation_id = ? AND (agent_id = 'matos' OR agent_id LIKE 'matos:%')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(conversationId) as DbRow | undefined;
  if (!row || typeof row.session_id !== 'string') return null;
  return {
    sessionId: row.session_id,
    model: typeof row.model === 'string' ? row.model : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
  };
}

// Conversation cursor for the resume identity guard: the id of the latest
// COMPLETED assistant message in the conversation, EXCLUDING the current run's
// in-flight placeholder (`excludeMessageId`). At resolve time the session is in
// sync iff this equals the assistant message the session last produced —
// otherwise another agent completed a turn in between, or the session's own last
// message was edited/removed, and the session is behind. Returns null when there
// is no prior completed assistant turn.
//
// "Completed" means run_status = 'succeeded' — a run stamps its assistant
// message with the terminal status on finish (server.ts), so an intervening
// agent run that FAILED or was CANCELED leaves a placeholder that produced no
// completed turn; counting it as advancement would force a needless cold reseed
// (silently disabling the resume perf path) even though the stored session is
// still the latest completed turn. In-flight placeholders have a null run_status
// and are likewise excluded.
//
// `resumableMessageId` is the one allowed exception: the resume-on-failure path
// persists a session whose own last assistant turn FAILED transiently (the CLI
// session already committed a tool/artifact block and is resumable). That stored
// id is admitted through the filter so the session it owns still matches its
// cursor — while a DIFFERENT later failed/canceled turn (a different id) stays
// excluded, so genuine advancement by a later succeeded turn is still detected.
export function latestCompletedAssistantMessageId(
  db: SqliteDb,
  conversationId: string,
  excludeMessageId: string,
  resumableMessageId: string | null = null,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM messages
        WHERE conversation_id = ? AND role = 'assistant' AND id != ?
          AND (run_status = 'succeeded' OR id = ?)
        ORDER BY position DESC LIMIT 1`,
    )
    .get(conversationId, excludeMessageId, resumableMessageId) as DbRow | undefined;
  return row && typeof row.id === 'string' ? row.id : null;
}

export function updateAgentSessionStableHash(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
  stablePromptHash: string,
): void {
  db.prepare(
    `UPDATE agent_sessions SET stable_prompt_hash = ?, updated_at = ?
      WHERE conversation_id = ? AND agent_id = ?`,
  ).run(stablePromptHash, Date.now(), conversationId, agentId);
}

export function clearAgentSession(
  db: SqliteDb,
  conversationId: string,
  agentId: string,
): void {
  db.prepare(
    `DELETE FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?`,
  ).run(conversationId, agentId);
}

// ---------- messages ----------

export function listMessages(db: SqliteDb, conversationId: string) {
  return (db
    .prepare(
      `SELECT id, role, content, agent_id AS agentId, agent_name AS agentName,
              role_ref AS roleRef,
              run_id AS runId, run_status AS runStatus,
              last_run_event_id AS lastRunEventId,
              events_json AS eventsJson,
              attachments_json AS attachmentsJson,
              comment_attachments_json AS commentAttachmentsJson,
              produced_files_json AS producedFilesJson,
              trace_object_files_json AS traceObjectFilesJson,
              feedback_json AS feedbackJson,
              pre_turn_file_names_json AS preTurnFileNamesJson,
              pre_turn_files_json AS preTurnFilesJson,
              session_mode AS sessionMode,
              run_context_json AS runContextJson,
              group_task_json AS groupTaskJson,
              reply_to_json AS replyToJson,
              turn_user_message_id AS turnUserMessageId,
              created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
              position
         FROM messages
        WHERE conversation_id = ?
        ORDER BY position ASC`,
    )
    .all(conversationId) as DbRow[])
    .map(normalizeMessage);
}

export function listMessageIds(db: SqliteDb, conversationId: string): string[] {
  return (db.prepare(
    `SELECT id FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
  ).all(conversationId) as DbRow[]).map(message => String(message.id));
}

export function listMessagesForChat(
  db: SqliteDb, conversationId: string,
  page?: { limit: number; before?: string },
) {
  const rows = db
    .prepare(
      `SELECT id, role, content, agent_id AS agentId, agent_name AS agentName,
              role_ref AS roleRef,
              run_id AS runId, run_status AS runStatus,
              last_run_event_id AS lastRunEventId,
              CASE WHEN telemetry_finalized_at IS NOT NULL
                THEN COALESCE(events_chat_json, events_json)
                ELSE events_json
              END AS eventsJson,
              attachments_json AS attachmentsJson,
              comment_attachments_json AS commentAttachmentsJson,
              produced_files_json AS producedFilesJson,
              trace_object_files_json AS traceObjectFilesJson,
              feedback_json AS feedbackJson,
              CASE WHEN telemetry_finalized_at IS NULL
                THEN pre_turn_file_names_json ELSE NULL
              END AS preTurnFileNamesJson,
              CASE WHEN telemetry_finalized_at IS NULL
                THEN pre_turn_files_json ELSE NULL
              END AS preTurnFilesJson,
              session_mode AS sessionMode,
              run_context_json AS runContextJson,
              group_task_json AS groupTaskJson,
              reply_to_json AS replyToJson,
              turn_user_message_id AS turnUserMessageId,
              created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
              position
         FROM messages
        WHERE conversation_id = ?
        ${page?.before ? `AND (position, id) < (
          SELECT position, id FROM messages WHERE id = ? AND conversation_id = ?
        )` : ''}
        ORDER BY position ${page ? 'DESC' : 'ASC'}, id ${page ? 'DESC' : 'ASC'}
        ${page ? 'LIMIT ?' : ''}`,
    )
    .all(conversationId, ...(page?.before ? [page.before, conversationId] : []),
      ...(page ? [page.limit] : [])) as DbRow[];
  return (page ? rows.reverse() : rows)
    .map(normalizeMessage)
    .map(message => messageForChatResponse(message, {
      preserveRecoveryBaseline:
        message.runStatus === 'queued' || message.runStatus === 'running',
    }));
}

export function upsertMessage(db: SqliteDb, conversationId: string, m: DbRow) {
  const existing = db
    .prepare(`SELECT position, conversation_id AS conversationId,
                     turn_user_message_id AS turnUserMessageId,
                     telemetry_finalized_at AS telemetryFinalizedAt
                FROM messages WHERE id = ?`)
    .get(m.id) as DbRow | undefined;
  if (existing && existing.conversationId !== conversationId) {
    const conflict: any = new Error('message id already belongs to another conversation');
    conflict.code = 'EMESSAGECONFLICT';
    throw conflict;
  }
  const now = Date.now();
  const effectivelyFinalized =
    m.telemetryFinalized === true || existing?.telemetryFinalizedAt != null;
  const compactedEvents = effectivelyFinalized
    ? compactEventsForChat(m.events)
    : undefined;
  const compactedEventsJson = compactedEvents ? JSON.stringify(compactedEvents) : null;
  const requestedTurnUserMessageId =
    typeof m.turnUserMessageId === 'string' && m.turnUserMessageId
      ? m.turnUserMessageId
      : null;
  if (existing) {
    const groupTask = normalizeMessageGroupTask(m.groupTask);
    const replyTo = normalizeMessageReplyRef(m.replyTo);
    db.prepare(
      `UPDATE messages
          SET role = ?, content = ?, agent_id = ?, agent_name = ?,
              role_ref = COALESCE(?, role_ref),
              run_id = ?, run_status = ?, last_run_event_id = ?,
              events_json = ?,
              events_chat_json = CASE
                WHEN ? THEN COALESCE(?, events_chat_json)
                ELSE NULL
              END,
              attachments_json = ?, comment_attachments_json = ?,
              produced_files_json = ?, trace_object_files_json = ?, feedback_json = ?,
              pre_turn_file_names_json = CASE
                WHEN ? THEN NULL ELSE COALESCE(?, pre_turn_file_names_json)
              END,
              pre_turn_files_json = CASE
                WHEN ? THEN NULL ELSE COALESCE(?, pre_turn_files_json)
              END,
              session_mode = ?, run_context_json = ?,
              group_task_json = COALESCE(?, group_task_json),
              reply_to_json = COALESCE(?, reply_to_json),
              turn_user_message_id = COALESCE(?, turn_user_message_id),
              telemetry_finalized_at = CASE
                WHEN ? THEN COALESCE(telemetry_finalized_at, ?)
                ELSE telemetry_finalized_at
              END,
              started_at = ?, ended_at = ?
        WHERE id = ?`,
    ).run(
      m.role,
      m.content,
      m.agentId ?? null,
      m.agentName ?? null,
      normalizeConversationRoleRef(m.roleRef),
      m.runId ?? null,
      m.runStatus ?? null,
      m.lastRunEventId ?? null,
      m.events ? JSON.stringify(m.events) : null,
      effectivelyFinalized ? 1 : 0,
      compactedEventsJson,
      m.attachments ? JSON.stringify(m.attachments) : null,
      m.commentAttachments ? JSON.stringify(m.commentAttachments) : null,
      m.producedFiles ? JSON.stringify(m.producedFiles) : null,
      m.traceObjectFiles ? JSON.stringify(m.traceObjectFiles) : null,
      m.feedback ? JSON.stringify(m.feedback) : null,
      effectivelyFinalized ? 1 : 0,
      m.preTurnFileNames ? JSON.stringify(m.preTurnFileNames) : null,
      effectivelyFinalized ? 1 : 0,
      m.preTurnFileSnapshot ? JSON.stringify(m.preTurnFileSnapshot) : null,
      normalizeMessageSessionModeForStorage(m.sessionMode),
      m.runContext ? JSON.stringify(m.runContext) : null,
      groupTask ? JSON.stringify(groupTask) : null,
      replyTo ? JSON.stringify(replyTo) : null,
      requestedTurnUserMessageId,
      m.telemetryFinalized === true ? 1 : 0,
      now,
      m.startedAt ?? null,
      m.endedAt ?? null,
      m.id,
    );
    // The browser can persist the assistant scaffold before the corresponding
    // user row, then attach the causal turn id during finalization. Updating
    // that link must immediately repair the already-assigned positions; the
    // insert-only resequence path below cannot see this late relationship.
    if (
      requestedTurnUserMessageId &&
      requestedTurnUserMessageId !== existing.turnUserMessageId
    ) {
      resequenceMessages(db, conversationId);
    }
  } else {
    const tail = db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS maxPosition,
                MAX(created_at) AS maxCreatedAt
           FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as DbRow | undefined;
    const position = ((tail?.maxPosition as number | undefined) ?? -1) + 1;
    const createdAt = typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)
      ? m.createdAt
      : now;
    const groupTask = normalizeMessageGroupTask(m.groupTask);
    const replyTo = normalizeMessageReplyRef(m.replyTo);
    // 30 values: id, conversation_id, role, content, agent_id, agent_name,
    // role_ref, run_id, run_status, last_run_event_id, events_json, events_chat_json,
    // attachments_json, comment_attachments_json, produced_files_json,
    // trace_object_files_json, feedback_json, pre_turn_file_names_json,
    // pre_turn_files_json,
    // session_mode, run_context_json,
    // group_task_json, reply_to_json, turn_user_message_id,
    // telemetry_finalized_at, started_at,
    // ended_at, position, created_at.
    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, role, content, agent_id, agent_name, role_ref,
          run_id, run_status, last_run_event_id, events_json, events_chat_json,
          attachments_json, comment_attachments_json, produced_files_json,
          trace_object_files_json, feedback_json, pre_turn_file_names_json,
          pre_turn_files_json,
          session_mode, run_context_json,
          group_task_json, reply_to_json, turn_user_message_id,
          telemetry_finalized_at, started_at,
          ended_at, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.id,
      conversationId,
      m.role,
      m.content,
      m.agentId ?? null,
      m.agentName ?? null,
      normalizeConversationRoleRef(m.roleRef),
      m.runId ?? null,
      m.runStatus ?? null,
      m.lastRunEventId ?? null,
      m.events ? JSON.stringify(m.events) : null,
      compactedEventsJson,
      m.attachments ? JSON.stringify(m.attachments) : null,
      m.commentAttachments ? JSON.stringify(m.commentAttachments) : null,
      m.producedFiles ? JSON.stringify(m.producedFiles) : null,
      m.traceObjectFiles ? JSON.stringify(m.traceObjectFiles) : null,
      m.feedback ? JSON.stringify(m.feedback) : null,
      effectivelyFinalized || !m.preTurnFileNames ? null : JSON.stringify(m.preTurnFileNames),
      effectivelyFinalized || !m.preTurnFileSnapshot ? null : JSON.stringify(m.preTurnFileSnapshot),
      normalizeMessageSessionModeForStorage(m.sessionMode),
      m.runContext ? JSON.stringify(m.runContext) : null,
      groupTask ? JSON.stringify(groupTask) : null,
      replyTo ? JSON.stringify(replyTo) : null,
      requestedTurnUserMessageId,
      m.telemetryFinalized === true ? now : null,
      m.startedAt ?? null,
      m.endedAt ?? null,
      position,
      createdAt,
    );
    // Canonical order sorts by created_at first, so a row appended STRICTLY
    // after the conversation's newest timestamp lands canonically last no
    // matter its role, and every earlier row keeps its relative order —
    // nothing to resequence. This matters for throughput: the resequence
    // mismatch check runs a window scan over the whole conversation, which
    // turns bulk chronological inserts (long ledgers, imports, test seeds)
    // quadratic. Same-timestamp or out-of-order inserts still take the full
    // self-healing resequence below.
    const maxCreatedAt = tail?.maxCreatedAt as number | null | undefined;
    const appendedStrictlyAfterTail = maxCreatedAt == null || createdAt > maxCreatedAt;
    const completesFutureTurnLink = m.role === 'user' && Boolean(
      db.prepare(
        `SELECT 1 FROM messages
          WHERE conversation_id = ?
            AND role = 'assistant'
            AND turn_user_message_id = ?
          LIMIT 1`,
      ).get(conversationId, m.id),
    );
    if (!appendedStrictlyAfterTail || completesFutureTurnLink) {
      resequenceMessages(db, conversationId);
    }
  }
  // Bump conversation activity so the sidebar's recency sort works.
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
    now,
    conversationId,
  );
  const row = db
    .prepare(
      `SELECT id, role, content, agent_id AS agentId, agent_name AS agentName,
              role_ref AS roleRef,
              run_id AS runId, run_status AS runStatus,
              last_run_event_id AS lastRunEventId,
              events_json AS eventsJson,
              attachments_json AS attachmentsJson,
              comment_attachments_json AS commentAttachmentsJson,
              produced_files_json AS producedFilesJson,
              trace_object_files_json AS traceObjectFilesJson,
              feedback_json AS feedbackJson,
              pre_turn_file_names_json AS preTurnFileNamesJson,
              pre_turn_files_json AS preTurnFilesJson,
              session_mode AS sessionMode,
              run_context_json AS runContextJson,
              group_task_json AS groupTaskJson,
              reply_to_json AS replyToJson,
              turn_user_message_id AS turnUserMessageId,
              created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
              position
         FROM messages WHERE id = ?`,
    )
    .get(m.id) as DbRow | undefined;
  return row ? normalizeMessage(row) : null;
}

export function appendMessageStatusEvent(db: SqliteDb, messageId: string, event: DbRow) {
  const label = typeof event?.label === 'string' ? event.label.trim() : '';
  const detail = typeof event?.detail === 'string' ? event.detail.trim() : '';
  if (!label) return null;
  const row = db
    .prepare(`SELECT events_json AS eventsJson,
                     telemetry_finalized_at AS telemetryFinalizedAt
                FROM messages WHERE id = ?`)
    .get(messageId) as DbRow | undefined;
  if (!row) return null;
  const parsed = parseJsonOrUndef(row.eventsJson);
  const events = Array.isArray(parsed) ? parsed : [];
  const last = events[events.length - 1];
  if (last?.kind === 'status' && last.label === label && (last.detail ?? '') === detail) {
    return events;
  }
  const nextEvent = detail
    ? { kind: 'status', label, detail }
    : { kind: 'status', label };
  const next = [...events, nextEvent];
  db.prepare(
    `UPDATE messages
        SET events_json = ?,
            events_chat_json = CASE
              WHEN telemetry_finalized_at IS NOT NULL THEN ? ELSE NULL
            END
      WHERE id = ?`,
  ).run(
    JSON.stringify(next),
    row.telemetryFinalizedAt != null
      ? JSON.stringify(compactEventsForChat(next) ?? [])
      : null,
    messageId,
  );
  return next;
}

export function appendMessageAgentEvent(db: SqliteDb, messageId: string, event: DbRow) {
  return appendMessageAgentEvents(db, messageId, [event]);
}

export function appendMessageAgentEvents(
  db: SqliteDb,
  messageId: string,
  incomingEvents: DbRow[],
) {
  const validEvents = incomingEvents.filter(event =>
    event && typeof event === 'object' && typeof event.kind === 'string' && event.kind,
  );
  if (validEvents.length === 0) return null;
  const row = db
    .prepare(`SELECT content, events_json AS eventsJson,
                     telemetry_finalized_at AS telemetryFinalizedAt
                FROM messages WHERE id = ?`)
    .get(messageId) as DbRow | undefined;
  if (!row) return null;
  const parsed = parseJsonOrUndef(row.eventsJson);
  const events = Array.isArray(parsed) ? parsed : [];
  const combined = [...events];
  let changed = false;
  for (const event of validEvents) {
    const last = combined[combined.length - 1];
    if (
      event.kind !== 'text' &&
      event.kind !== 'thinking' &&
      last &&
      JSON.stringify(last) === JSON.stringify(event)
    ) {
      continue;
    }
    combined.push(event);
    changed = true;
  }
  if (!changed) return events;
  const nextEvents = coalesceAdjacentStreamEvents(combined) ?? [];
  const nextJson = JSON.stringify(nextEvents);
  const textDelta = validEvents
    .filter(event => event.kind === 'text' && typeof event.text === 'string')
    .map(event => String(event.text))
    .join('');
  db.prepare(
    `UPDATE messages
        SET content = COALESCE(content, '') || ?,
            events_json = ?,
            events_chat_json = CASE
              WHEN telemetry_finalized_at IS NOT NULL THEN ? ELSE NULL
            END
      WHERE id = ?`,
  ).run(
    textDelta,
    nextJson,
    row.telemetryFinalizedAt != null
      ? JSON.stringify(compactEventsForChat(nextEvents) ?? [])
      : null,
    messageId,
  );
  return nextEvents;
}

// ---------- preview comments ----------

const PREVIEW_COMMENT_STATUSES = new Set([
  'open',
  'attached',
  'applying',
  'needs_review',
  'resolved',
  'failed',
]);

export function listPreviewComments(db: SqliteDb, projectId: string, conversationId: string) {
  return (db
    .prepare(
      `SELECT id, project_id AS projectId, conversation_id AS conversationId,
              file_path AS filePath, element_id AS elementId, selector, label,
              text, position_json AS positionJson, html_hint AS htmlHint,
              selection_kind AS selectionKind, member_count AS memberCount,
              pod_members_json AS podMembersJson, style_json AS styleJson,
              attachments_json AS attachmentsJson,
              slide_index AS slideIndex,
              note, status, created_at AS createdAt, updated_at AS updatedAt
         FROM preview_comments
        WHERE project_id = ? AND conversation_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectId, conversationId) as DbRow[])
    .map(normalizePreviewComment);
}

export function upsertPreviewComment(db: SqliteDb, projectId: string, conversationId: string, input: DbRow) {
  const target = input?.target ?? {};
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  const attachmentsProvided = Object.prototype.hasOwnProperty.call(input ?? {}, 'attachments');
  const incomingAttachments = normalizePreviewCommentAttachments(input?.attachments);
  const filePath = cleanRequiredString(target.filePath, 'filePath');
  const elementId = cleanRequiredString(target.elementId, 'elementId');
  const selector = cleanRequiredString(target.selector, 'selector');
  const label = cleanRequiredString(target.label, 'label');
  const text = typeof target.text === 'string' ? compactWhitespace(target.text).slice(0, 160) : '';
  const htmlHint = typeof target.htmlHint === 'string' ? compactWhitespace(target.htmlHint).slice(0, 180) : '';
  const position = normalizePosition(target.position);
  const selectionKind = target.selectionKind === 'pod' ? 'pod' : 'element';
  const podMembers = selectionKind === 'pod' ? normalizePodMembers(target.podMembers) : [];
  const style = normalizeAnnotationStyle(target.style);
  const memberCount = selectionKind === 'pod'
    ? (podMembers.length > 0
        ? podMembers.length
        : Number.isFinite(target.memberCount)
          ? Math.max(0, Math.round(target.memberCount))
          : 0)
    : 0;
  const slideIndex = Number.isFinite(target.slideIndex) ? Math.max(0, Math.round(target.slideIndex)) : null;
  const slideKey = slideIndex ?? -1;
  const now = Date.now();
  const existing = db
    .prepare(
      `SELECT id, created_at AS createdAt, attachments_json AS attachmentsJson
         FROM preview_comments
        WHERE project_id = ? AND conversation_id = ? AND file_path = ? AND element_id = ? AND slide_key = ?`,
    )
    .get(projectId, conversationId, filePath, elementId, slideKey) as DbRow | undefined;
  const id = existing?.id ?? randomCommentId();
  const createdAt = existing?.createdAt ?? now;
  const existingAttachments = normalizePreviewCommentAttachments(parseJsonOrUndef(existing?.attachmentsJson));
  const attachments = attachmentsProvided ? incomingAttachments : existingAttachments;
  // A comment must carry either a note or at least one image attachment.
  if (!note && attachments.length === 0) throw new Error('comment note required');
  db.prepare(
    `INSERT INTO preview_comments
       (id, project_id, conversation_id, file_path, element_id, selector, label,
        text, position_json, html_hint, selection_kind, member_count, pod_members_json,
        style_json, attachments_json, slide_index, slide_key, note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, conversation_id, file_path, element_id, slide_key) DO UPDATE SET
       selector = excluded.selector,
       label = excluded.label,
       text = excluded.text,
       position_json = excluded.position_json,
       html_hint = excluded.html_hint,
       selection_kind = excluded.selection_kind,
       member_count = excluded.member_count,
       pod_members_json = excluded.pod_members_json,
       style_json = excluded.style_json,
       attachments_json = excluded.attachments_json,
       slide_index = excluded.slide_index,
       note = excluded.note,
       status = 'open',
       updated_at = excluded.updated_at`,
  ).run(
    id,
    projectId,
    conversationId,
    filePath,
    elementId,
    selector,
    label,
    text,
    JSON.stringify(position),
    htmlHint,
    selectionKind,
    selectionKind === 'pod' ? memberCount : null,
    selectionKind === 'pod' ? JSON.stringify(podMembers) : null,
    style ? JSON.stringify(style) : null,
    attachments.length > 0 ? JSON.stringify(attachments) : null,
    slideIndex,
    slideKey,
    note,
    'open',
    createdAt,
    now,
  );
  return getPreviewComment(db, projectId, conversationId, id);
}

export function updatePreviewCommentStatus(db: SqliteDb, projectId: string, conversationId: string, id: string, status: string) {
  if (!PREVIEW_COMMENT_STATUSES.has(status)) throw new Error('invalid comment status');
  const now = Date.now();
  db.prepare(
    `UPDATE preview_comments
        SET status = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND conversation_id = ?`,
  ).run(status, now, id, projectId, conversationId);
  return getPreviewComment(db, projectId, conversationId, id);
}

export function deletePreviewComment(db: SqliteDb, projectId: string, conversationId: string, id: string) {
  const result = db
    .prepare(
      `DELETE FROM preview_comments
        WHERE id = ? AND project_id = ? AND conversation_id = ?`,
    )
    .run(id, projectId, conversationId);
  return result.changes > 0;
}

function getPreviewComment(db: SqliteDb, projectId: string, conversationId: string, id: string) {
  const row = db
    .prepare(
      `SELECT id, project_id AS projectId, conversation_id AS conversationId,
              file_path AS filePath, element_id AS elementId, selector, label,
              text, position_json AS positionJson, html_hint AS htmlHint,
              selection_kind AS selectionKind, member_count AS memberCount,
              pod_members_json AS podMembersJson, style_json AS styleJson,
              attachments_json AS attachmentsJson,
              slide_index AS slideIndex,
              note, status, created_at AS createdAt, updated_at AS updatedAt
         FROM preview_comments
        WHERE id = ? AND project_id = ? AND conversation_id = ?`,
    )
    .get(id, projectId, conversationId) as DbRow | undefined;
  return row ? normalizePreviewComment(row) : null;
}

function normalizePreviewComment(row: DbRow) {
  const podMembers = parseJsonOrUndef(row.podMembersJson);
  const normalizedPodMembers = Array.isArray(podMembers) ? podMembers : undefined;
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    filePath: row.filePath,
    elementId: row.elementId,
    selector: row.selector,
    label: row.label,
    text: row.text,
    position: parseJsonOrUndef(row.positionJson) ?? { x: 0, y: 0, width: 0, height: 0 },
    htmlHint: row.htmlHint,
    style: normalizeAnnotationStyle(parseJsonOrUndef(row.styleJson)),
    selectionKind: row.selectionKind === 'pod' ? 'pod' : 'element',
    memberCount:
      normalizedPodMembers && normalizedPodMembers.length > 0
        ? normalizedPodMembers.length
        : Number.isFinite(row.memberCount)
          ? row.memberCount
          : undefined,
    podMembers: normalizedPodMembers,
    slideIndex: Number.isFinite(row.slideIndex) ? row.slideIndex : undefined,
    note: row.note,
    attachments: normalizePreviewCommentAttachments(parseJsonOrUndef(row.attachmentsJson)),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePreviewCommentAttachments(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const path = typeof (item as DbRow).path === 'string' ? (item as DbRow).path.trim() : '';
      if (!path) return null;
      const rawName = typeof (item as DbRow).name === 'string' ? (item as DbRow).name.trim() : '';
      return { path, name: rawName || path.split('/').pop() || path };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function cleanRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function normalizePodMembers(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input
    .map((member) => {
      if (!member || typeof member !== 'object') return null;
      const elementId = cleanRequiredString(member.elementId, 'podMember.elementId');
      const selector = cleanRequiredString(member.selector, 'podMember.selector');
      const label = cleanRequiredString(member.label, 'podMember.label');
      return {
        elementId,
        selector,
        label,
        text:
          typeof member.text === 'string'
            ? compactWhitespace(member.text).slice(0, 160)
            : '',
        position: normalizePosition(member.position),
        htmlHint:
          typeof member.htmlHint === 'string'
            ? compactWhitespace(member.htmlHint).slice(0, 180)
            : '',
        style: normalizeAnnotationStyle(member.style),
      };
    })
    .filter(Boolean);
}

function normalizeAnnotationStyle(input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as DbRow;
  const style: DbRow = {};
  for (const key of ANNOTATION_STYLE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = compactWhitespace(value);
    if (trimmed) style[key] = trimmed.slice(0, 120);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

const ANNOTATION_STYLE_KEYS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderRadius',
] as const;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePosition(input: unknown) {
  const value: DbRow = input && typeof input === 'object' ? input as DbRow : {};
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function randomCommentId(): string {
  return `cmt_${randomUUID().slice(0, 8)}`;
}

function normalizeMessage(row: DbRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    agentId: row.agentId ?? undefined,
    agentName: row.agentName ?? undefined,
    roleRef: row.roleRef ?? undefined,
    runId: row.runId ?? undefined,
    runStatus: row.runStatus ?? undefined,
    lastRunEventId: row.lastRunEventId ?? undefined,
    events: parseJsonOrUndef(row.eventsJson),
    attachments: parseJsonOrUndef(row.attachmentsJson),
    commentAttachments: parseJsonOrUndef(row.commentAttachmentsJson),
    producedFiles: parseJsonOrUndef(row.producedFilesJson),
    traceObjectFiles: parseJsonOrUndef(row.traceObjectFilesJson),
    feedback: parseJsonOrUndef(row.feedbackJson),
    preTurnFileNames: parseJsonOrUndef(row.preTurnFileNamesJson),
    preTurnFileSnapshot: parseJsonOrUndef(row.preTurnFilesJson),
    sessionMode: normalizeMessageSessionMode(row.sessionMode),
    runContext: parseJsonOrUndef(row.runContextJson),
    groupTask: normalizeMessageGroupTask(row.groupTaskJson) ?? undefined,
    replyTo: normalizeMessageReplyRef(row.replyToJson) ?? undefined,
    turnUserMessageId: row.turnUserMessageId ?? undefined,
    createdAt: row.createdAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
  };
}

function normalizeMessageSessionMode(value: unknown): ChatSessionMode | undefined {
  return value === 'chat' || value === 'design' || value === 'plan' ? value : undefined;
}

function normalizeMessageSessionModeForStorage(value: unknown): ChatSessionMode | null {
  return value === 'chat' || value === 'design' || value === 'plan' ? value : null;
}

function parseJsonOrUndef(s: unknown): any {
  if (typeof s !== 'string' || !s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------- routines ----------

const ROUTINE_COLS = `id, name, prompt,
  schedule_kind AS scheduleKind, schedule_value AS scheduleValue,
  schedule_json AS scheduleJson,
  project_mode AS projectMode, project_id AS projectId,
  skill_id AS skillId, agent_id AS agentId,
  context_json AS contextJson,
  enabled, created_at AS createdAt, updated_at AS updatedAt`;

const ROUTINE_RUN_COLS = `id, routine_id AS routineId, trigger, status,
  project_id AS projectId, conversation_id AS conversationId,
  agent_run_id AS agentRunId, started_at AS startedAt,
  completed_at AS completedAt, summary, error, error_code AS errorCode`;

export function listRoutines(db: SqliteDb) {
  return (db
    .prepare(`SELECT ${ROUTINE_COLS} FROM routines ORDER BY created_at ASC`)
    .all() as DbRow[])
    .map(normalizeRoutine);
}

export function getRoutine(db: SqliteDb, id: string) {
  const r = db
    .prepare(`SELECT ${ROUTINE_COLS} FROM routines WHERE id = ?`)
    .get(id) as DbRow | undefined;
  return r ? normalizeRoutine(r) : null;
}

export function insertRoutine(db: SqliteDb, r: DbRow) {
  db.prepare(
    `INSERT INTO routines
       (id, name, prompt, schedule_kind, schedule_value, schedule_json,
        project_mode, project_id, skill_id, agent_id, context_json, enabled,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.name,
    r.prompt,
    r.scheduleKind,
    r.scheduleValue,
    r.scheduleJson ?? null,
    r.projectMode,
    r.projectId ?? null,
    r.skillId ?? null,
    r.agentId ?? null,
    r.contextJson ?? null,
    r.enabled ? 1 : 0,
    r.createdAt,
    r.updatedAt,
  );
  return getRoutine(db, r.id);
}

export function updateRoutine(db: SqliteDb, id: string, patch: DbRow) {
  const existing = getRoutine(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  db.prepare(
    `UPDATE routines
        SET name = ?, prompt = ?,
            schedule_kind = ?, schedule_value = ?, schedule_json = ?,
            project_mode = ?, project_id = ?,
            skill_id = ?, agent_id = ?, context_json = ?,
            enabled = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.prompt,
    merged.scheduleKind,
    merged.scheduleValue,
    merged.scheduleJson ?? null,
    merged.projectMode,
    merged.projectId ?? null,
    merged.skillId ?? null,
    merged.agentId ?? null,
    merged.contextJson ?? null,
    merged.enabled ? 1 : 0,
    merged.updatedAt,
    id,
  );
  return getRoutine(db, id);
}

export function deleteRoutine(db: SqliteDb, id: string): boolean {
  const result = db.prepare(`DELETE FROM routines WHERE id = ?`).run(id);
  return result.changes > 0;
}

function normalizeRoutine(row: DbRow) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    scheduleKind: row.scheduleKind,
    scheduleValue: row.scheduleValue,
    scheduleJson: row.scheduleJson ?? null,
    projectMode: row.projectMode,
    projectId: row.projectId ?? null,
    skillId: row.skillId ?? null,
    agentId: row.agentId ?? null,
    contextJson: row.contextJson ?? null,
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function listRoutineRuns(db: SqliteDb, routineId: string, limit = 20) {
  return (db
    .prepare(
      `SELECT ${ROUTINE_RUN_COLS}
         FROM routine_runs
        WHERE routine_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(routineId, limit) as DbRow[])
    .map(normalizeRoutineRun);
}

export function getLatestRoutineRun(db: SqliteDb, routineId: string) {
  const r = db
    .prepare(
      `SELECT ${ROUTINE_RUN_COLS}
         FROM routine_runs
        WHERE routine_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(routineId) as DbRow | undefined;
  return r ? normalizeRoutineRun(r) : null;
}

export function getRoutineRun(db: SqliteDb, id: string) {
  const r = db
    .prepare(`SELECT ${ROUTINE_RUN_COLS} FROM routine_runs WHERE id = ?`)
    .get(id) as DbRow | undefined;
  return r ? normalizeRoutineRun(r) : null;
}

export function insertRoutineRun(db: SqliteDb, r: DbRow) {
  db.prepare(
    `INSERT INTO routine_runs
       (id, routine_id, trigger, status, project_id, conversation_id,
        agent_run_id, started_at, completed_at, summary, error, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.routineId,
    r.trigger,
    r.status,
    r.projectId,
    r.conversationId,
    r.agentRunId,
    r.startedAt,
    r.completedAt ?? null,
    r.summary ?? null,
    r.error ?? null,
    r.errorCode ?? null,
  );
  return getRoutineRun(db, r.id);
}

export function insertScheduledRoutineRun(db: SqliteDb, r: DbRow, slotAt: number) {
  const insertClaim = db.prepare(
    `INSERT OR IGNORE INTO routine_schedule_claims
       (routine_id, slot_at, claimed_at)
     VALUES (?, ?, ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO routine_runs
       (id, routine_id, trigger, status, project_id, conversation_id,
        agent_run_id, started_at, completed_at, summary, error, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    const claim = insertClaim.run(r.routineId, slotAt, Date.now());
    if (claim.changes === 0) return false;
    insertRun.run(
      r.id,
      r.routineId,
      r.trigger,
      r.status,
      r.projectId,
      r.conversationId,
      r.agentRunId,
      r.startedAt,
      r.completedAt ?? null,
      r.summary ?? null,
      r.error ?? null,
      r.errorCode ?? null,
    );
    return true;
  });
  if (!tx()) return null;
  return getRoutineRun(db, r.id);
}

export function updateRoutineRun(db: SqliteDb, id: string, patch: DbRow) {
  const existing = getRoutineRun(db, id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
  };
  db.prepare(
    `UPDATE routine_runs
        SET status = ?, project_id = ?, conversation_id = ?, agent_run_id = ?,
            completed_at = ?, summary = ?, error = ?, error_code = ?
      WHERE id = ?`,
  ).run(
    merged.status,
    merged.projectId,
    merged.conversationId,
    merged.agentRunId,
    merged.completedAt ?? null,
    merged.summary ?? null,
    merged.error ?? null,
    merged.errorCode ?? null,
    id,
  );
  return getRoutineRun(db, id);
}

function normalizeRoutineRun(row: DbRow) {
  return {
    id: row.id,
    routineId: row.routineId,
    trigger: row.trigger,
    status: row.status,
    projectId: row.projectId,
    conversationId: row.conversationId,
    agentRunId: row.agentRunId,
    startedAt: Number(row.startedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
    summary: row.summary ?? null,
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
  };
}

// ---------- tabs ----------

function normalizeBrowserWorkspaceTab(value: unknown): ProjectBrowserWorkspaceTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  if (typeof record.label !== 'string' || !record.label.trim()) return null;
  const tab: ProjectBrowserWorkspaceTab = {
    id: record.id,
    label: record.label,
  };
  if (record.insertAfter === null) tab.insertAfter = null;
  else if (typeof record.insertAfter === 'string') tab.insertAfter = record.insertAfter;
  if (typeof record.title === 'string' && record.title.trim()) tab.title = record.title;
  if (typeof record.url === 'string' && record.url.trim()) tab.url = record.url;
  if (typeof record.iconUrl === 'string' && record.iconUrl.trim()) tab.iconUrl = record.iconUrl;
  return tab;
}

function normalizeProjectTabsState(value: unknown): ProjectTabsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs) || !record.tabs.every((tab) => typeof tab === 'string')) {
    return null;
  }
  const browserTabs = Array.isArray(record.browserTabs)
    ? record.browserTabs
        .map(normalizeBrowserWorkspaceTab)
        .filter((tab): tab is ProjectBrowserWorkspaceTab => Boolean(tab))
    : [];
  const state: ProjectTabsState = {
    tabs: record.tabs.slice(),
    active: typeof record.active === 'string' ? record.active : null,
  };
  if (browserTabs.length > 0) state.browserTabs = browserTabs;
  return state;
}

function parseProjectTabsStateJson(value: unknown): ProjectTabsState | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeProjectTabsState(JSON.parse(value));
  } catch {
    return null;
  }
}

export function listTabs(db: SqliteDb, projectId: string) {
  const rows = db
    .prepare(
      `SELECT name, position, is_active AS isActive
         FROM tabs WHERE project_id = ? ORDER BY position ASC`,
    )
    .all(projectId) as DbRow[];
  const state = db
    .prepare(`SELECT project_id, updated_at AS updatedAt, state_json AS stateJson FROM tabs_state WHERE project_id = ? LIMIT 1`)
    .get(projectId) as DbRow | undefined;
  const savedState = parseProjectTabsStateJson(state?.stateJson);
  if (savedState) {
    return {
      ...savedState,
      hasSavedState: true,
      updatedAt: Number(state?.updatedAt ?? Date.now()),
    };
  }
  const active = (rows as DbRow[]).find((r: DbRow) => r.isActive) ?? null;
  return {
    tabs: (rows as DbRow[]).map((r: DbRow) => r.name),
    active: active ? active.name : null,
    hasSavedState: rows.length > 0 || Boolean(state),
    updatedAt: state ? Number(state.updatedAt ?? Date.now()) : undefined,
  };
}

export function setTabs(
  db: SqliteDb,
  projectId: string,
  stateOrNames: ProjectTabsState | string[],
  activeName: string | null = null,
) {
  const state = normalizeProjectTabsState(
    Array.isArray(stateOrNames)
      ? { tabs: stateOrNames, active: activeName }
      : stateOrNames,
  ) ?? { tabs: [], active: null };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tabs_state (project_id, updated_at, state_json)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         state_json = excluded.state_json`,
    ).run(projectId, Date.now(), JSON.stringify(state));
    db.prepare(`DELETE FROM tabs WHERE project_id = ?`).run(projectId);
    const ins = db.prepare(
      `INSERT INTO tabs (project_id, name, position, is_active)
       VALUES (?, ?, ?, ?)`,
    );
    state.tabs.forEach((name: string, i: number) => {
      ins.run(projectId, name, i, name === state.active ? 1 : 0);
    });
  });
  tx();
  return listTabs(db, projectId);
}
