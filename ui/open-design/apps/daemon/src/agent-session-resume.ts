import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  clearAgentSession,
  getAgentSessionRecord,
  latestCompletedAssistantMessageId,
  upsertAgentSession,
} from './db.js';

type SqliteDb = Database.Database;

/**
 * Why a stored session was NOT resumed this turn. `null` means it WAS resumed
 * (or there was no stored session to begin with). Surfaced for tests and
 * retry policy; the daemon reseeds the full transcript for every non-null reason.
 */
export type ResumeInvalidationReason =
  | 'model_changed'
  | 'cwd_changed'
  | 'conversation_advanced'
  | 'missing_cursor';

export interface AgentResumeContext {
  /** Stored CLI session id to resume, or null when starting fresh. */
  resumeSessionId: string | null;
  /** Freshly minted UUID to open a new session with when not resuming. */
  newSessionId: string;
  /** True when a prior session id exists AND it is still safe to resume. */
  isResuming: boolean;
  /** Hash of the stable instruction block last sent on this session, or null. */
  storedStablePromptHash: string | null;
  /** Last assistant message already present in the resumed session. */
  storedLastMessageId: string | null;
  /** Set when a stored session existed but was rejected; see the type. */
  invalidationReason: ResumeInvalidationReason | null;
}

export type CapturedAgentSessionResult = 'stored' | 'cleared' | 'skipped';

/**
 * Resume identity guard. A stored upstream session is only safe to continue
 * (and to `skipTranscript` for) when the conversation has not changed shape
 * under it. We reject the resume — forcing a fresh session reseeded with the
 * full transcript — when:
 *  - the model changed (the session was built under a different model),
 *  - the cwd changed (different workspace identity), or
 *  - the conversation advanced under the session: the assistant message the
 *    session last produced is no longer the latest completed assistant turn
 *    (another agent ran in between, or the message was edited/removed).
 *
 * The cursor is the session's own last assistant message id. At the next turn's
 * resolve time the latest completed assistant message — excluding the current
 * run's in-flight placeholder — must still be that id. A null stored cursor (row
 * written before this guard shipped) cannot be verified, so it is treated as
 * unsafe and reseeded once.
 */
export function evaluateResumeInvalidation(input: {
  storedModel: string | null;
  storedCwd: string | null;
  storedLastMessageId: string | null;
  currentModel: string | null;
  currentCwd: string | null;
  latestCompletedAssistantId: string | null;
  allowConversationAdvance?: boolean;
  storedCursorExists?: boolean;
}): ResumeInvalidationReason | null {
  if ((input.storedModel ?? null) !== (input.currentModel ?? null)) return 'model_changed';
  if ((input.storedCwd ?? null) !== (input.currentCwd ?? null)) return 'cwd_changed';
  if (input.storedLastMessageId == null) return 'missing_cursor';
  if (input.storedCursorExists === false) return 'conversation_advanced';
  if (
    !input.allowConversationAdvance &&
    input.latestCompletedAssistantId !== input.storedLastMessageId
  ) {
    return 'conversation_advanced';
  }
  return null;
}

/**
 * Decide whether a resume-capable adapter should continue its stored CLI
 * session or start a new one for this (conversation, agent). Pure read +
 * mint; the caller is responsible for persisting `newSessionId` (and the
 * current model/cwd/cursor) when it actually spawns a create turn.
 */
export function resolveAgentResumeContext(
  db: SqliteDb,
  input: {
    conversationId: string;
    agentId: string;
    currentModel?: string | null;
    currentCwd?: string | null;
    /** The current run's in-flight assistant placeholder id, excluded from the
     *  "latest completed assistant" cursor lookup. */
    currentAssistantMessageId?: string | null;
    /** Multi-member MatOS conversations resume each member independently and
     * receive the intervening shared timeline as a bounded delta. */
    allowConversationAdvance?: boolean;
  },
): AgentResumeContext {
  const record = getAgentSessionRecord(db, input.conversationId, input.agentId);
  const storedSessionId = record?.sessionId ?? null;
  const invalidationReason =
    storedSessionId != null
      ? evaluateResumeInvalidation({
          storedModel: record?.model ?? null,
          storedCwd: record?.cwd ?? null,
          storedLastMessageId: record?.lastMessageId ?? null,
          currentModel: input.currentModel ?? null,
          currentCwd: input.currentCwd ?? null,
          // Admit the stored session's own last message id through the cursor
          // filter so a resume-on-failure session (whose last turn FAILED but is
          // resumable) still matches its cursor; a different later failed turn
          // stays excluded and genuine advancement is still detected.
          latestCompletedAssistantId: latestCompletedAssistantMessageId(
            db,
            input.conversationId,
            input.currentAssistantMessageId ?? '',
            record?.lastMessageId ?? null,
          ),
          ...(input.allowConversationAdvance !== undefined
            ? { allowConversationAdvance: input.allowConversationAdvance }
            : {}),
          storedCursorExists: record?.lastMessageId
            ? Boolean(db.prepare(
                'SELECT 1 FROM messages WHERE conversation_id = ? AND id = ? LIMIT 1',
              ).get(input.conversationId, record.lastMessageId))
            : false,
        })
      : null;
  const resumable = storedSessionId != null && invalidationReason == null;
  return {
    resumeSessionId: resumable ? storedSessionId : null,
    newSessionId: randomUUID(),
    isResuming: resumable,
    storedStablePromptHash: resumable ? (record?.stablePromptHash ?? null) : null,
    storedLastMessageId: resumable ? (record?.lastMessageId ?? null) : null,
    invalidationReason,
  };
}

/**
 * Persist a captured upstream session for a successful run.
 *
 * A missing captured session on a successful run means the adapter could not
 * safely identify the child session it just created (for example, ambiguous pi
 * `.jsonl` writes in a shared cwd). Clear the stored row so the next turn does
 * not resume stale history; it will start fresh and seed from the transcript.
 */
export function persistCapturedAgentSession(
  db: SqliteDb,
  input: {
    conversationId: string | null | undefined;
    agentId: string;
    sessionId: string | null;
    stablePromptHash?: string | null;
    // Resume identity (see resolveAgentResumeContext). Must be stored alongside
    // the captured session so the next turn can verify the session is still
    // safe to resume; omitting them leaves a null cursor that the guard treats
    // as `missing_cursor` and reseeds every turn.
    model?: string | null;
    cwd?: string | null;
    lastMessageId?: string | null;
  },
): CapturedAgentSessionResult {
  if (!input.conversationId) return 'skipped';
  if (input.sessionId) {
    upsertAgentSession(db, {
      conversationId: input.conversationId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      stablePromptHash: input.stablePromptHash ?? null,
      model: input.model ?? null,
      cwd: input.cwd ?? null,
      lastMessageId: input.lastMessageId ?? null,
    });
    return 'stored';
  }
  clearAgentSession(db, input.conversationId, input.agentId);
  return 'cleared';
}

// Signatures Claude Code prints to stderr when a `--resume <id>` target no
// longer exists on disk (session pruned, repo moved machines, ~/.claude
// cleared). Verified against the installed CLI (v2.1.178): the first pattern
// matches its "No conversation found with session ID: <id>" string. These stay
// as a fast path, but Claude's human-readable prose drifts across builds — when
// it does, none of these match and the stale session id is never cleared, so
// every turn retries the same dead `--resume` (#4275). The structured detector
// below is the version-stable primary; treat these patterns as a complement.
const CLAUDE_RESUME_FAILURE_PATTERNS: RegExp[] = [
  /no conversation found with session id/i,
  /no session found/i,
  /session .* not found/i,
];

/**
 * Version-stable structured signal that a `--resume <id>` turn failed because
 * the target session could not be loaded. Unlike the human-readable prose
 * (which #4275 shows can silently stop matching across Claude builds), the
 * stream-json `result` event shape is stable: a resume whose session can't be
 * loaded fails LOCALLY, before any API call, so the terminal result is
 * `is_error` with zero turns and zero API time. A genuine in-turn failure
 * (overload / network) spends real API time (`duration_api_ms > 0`) and/or
 * completes a turn, so it is deliberately left alone — a transient blip must
 * not drop a still-valid session.
 */
function hasClaudeResumeFailureResultEvent(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"result"')) continue;
    let event: {
      type?: unknown;
      is_error?: unknown;
      num_turns?: unknown;
      duration_api_ms?: unknown;
    };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== 'result') continue;
    if (
      event.is_error === true
      && Number(event.num_turns) === 0
      && Number(event.duration_api_ms) === 0
    ) {
      return true;
    }
  }
  return false;
}

/** sha256 hex digest of the composed stable instruction block. */
export function hashStableInstructions(stable: string): string {
  return createHash('sha256').update(stable, 'utf8').digest('hex');
}

/**
 * Decide whether a resume-capable spawn must include the stable instruction
 * block (daemon prompt + tool contract + design system / skills).
 * Always include it on a create turn (not resuming) or when the block's hash
 * differs from what was last sent on this session; skip it only on a resumed
 * turn whose stable block is byte-identical to last time (incl. legacy
 * sessions with no stored hash, which compare unequal and so re-send).
 */
export function computeIncludeStable(
  isResuming: boolean,
  storedStableHash: string | null,
  currentStableHash: string,
): boolean {
  return !isResuming || storedStableHash !== currentStableHash;
}

/**
 * True when CLI output indicates a resume target session is missing. Prose
 * signatures are matched on `stderr` (where Claude prints the failure); the
 * version-stable structured `result` event is matched on `stdout` (the
 * stream-json channel). We deliberately do NOT scan ordinary assistant stdout
 * for the prose phrases — a successful turn whose model text happens to contain
 * "session not found" must not be mistaken for a resume failure.
 */
export function isClaudeResumeFailure(stderr: string, stdout = ''): boolean {
  if (stderr && CLAUDE_RESUME_FAILURE_PATTERNS.some((re) => re.test(stderr))) return true;
  return stdout ? hasClaudeResumeFailureResultEvent(stdout) : false;
}
