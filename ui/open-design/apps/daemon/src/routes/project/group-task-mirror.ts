// MatOS group-task mirroring: the daemon-side half of the Feishu-style
// project org. When a member finishes a turn in a project group chat (it was
// @-dispatched by the user or by another member's handoff), the finished
// dispatch + work record are copied into that member's own DM conversation.
// The member's "single chat" page therefore doubles as their work ledger —
// what they were asked to do, what they actually did (tool events), and what
// they produced (files) — and, because the DM transcript now contains the
// mirrored pair, the member "remembers" its group work when the user DMs it
// later.
//
// The mirror lives in the daemon (not the web client) so it holds for every
// finalization path: normal streamed runs, auto-relay hops, reattached runs
// finalized after a reload, and canceled/failed turns (a real ledger records
// failures too). Mirrored rows are inert copies: they carry content, events,
// and produced files, but no live run wiring (no runId), so the DM never
// tries to reattach or resume the group's run.

import type { ChatMessageGroupTask } from '@open-design/contracts';

interface DbRowLike {
  [key: string]: unknown;
}

interface ConversationRecord {
  id: string;
  projectId: string;
  title: string | null;
  roleRef?: string | null | undefined;
  memberRefs?: string[] | undefined;
  createdAt: number;
  updatedAt: number;
}

interface MessageRecord {
  id: string;
  role: string;
  content: string;
  agentId?: string | undefined;
  agentName?: string | undefined;
  roleRef?: string | null | undefined;
  runStatus?: string | undefined;
  events?: unknown;
  attachments?: unknown;
  producedFiles?: unknown;
  traceObjectFiles?: unknown;
  sessionMode?: string | undefined;
  groupTask?: ChatMessageGroupTask | undefined;
  replyTo?: unknown;
  createdAt?: number | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  position?: number | undefined;
}

export interface GroupTaskMirrorDeps {
  db: unknown;
  randomId: () => string;
  getProject: (db: unknown, id: string) => DbRowLike | null | undefined;
  listConversations: (db: unknown, projectId: string) => ConversationRecord[];
  insertConversation: (db: unknown, c: DbRowLike) => ConversationRecord | null;
  listMessages: (db: unknown, conversationId: string) => MessageRecord[];
  upsertMessage: (db: unknown, conversationId: string, m: DbRowLike) => MessageRecord | null;
}

export interface GroupTaskMirrorResult {
  dmConversationId: string;
  memberRef: string;
  createdDm: boolean;
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function roleIdentity(roleRef: string): string {
  return roleRef.trim().split('@')[0] ?? roleRef.trim();
}

/** Deterministic mirror ids so repeated finalize PUTs stay idempotent. */
export function groupTaskUserMirrorId(sourceAssistantMessageId: string): string {
  return `gtu-${sourceAssistantMessageId}`;
}

export function groupTaskAssistantMirrorId(sourceAssistantMessageId: string): string {
  return `gta-${sourceAssistantMessageId}`;
}

function isGroupConversation(conversation: ConversationRecord | null | undefined): boolean {
  return Boolean(
    conversation &&
      Array.isArray(conversation.memberRefs) &&
      conversation.memberRefs.length > 1,
  );
}

/** Project alias (`metadata.memberNames`) first, then the bare role id. */
function memberDisplayName(project: DbRowLike | null | undefined, memberRef: string): string {
  const metadata = project?.metadata as
    | { memberNames?: Record<string, unknown> }
    | null
    | undefined;
  const aliases = metadata?.memberNames ?? {};
  const alias = aliases[memberRef] ?? Object.entries(aliases)
    .find(([roleRef]) => roleRef.split('@')[0] === memberRef.split('@')[0])?.[1];
  if (typeof alias === 'string' && alias.trim()) return alias.trim();
  return memberRef.replace(/^role:/, '');
}

/**
 * The member's DM conversation, matching the web client's lookup: the most
 * recently updated single-member conversation bound to that role. Group
 * conversations (multi-member rosters) never count as DMs.
 */
export function findMemberDmConversation(
  conversations: ConversationRecord[],
  memberRef: string,
  excludeConversationId: string,
): ConversationRecord | null {
  return (
    conversations.find(
      (conversation) =>
        conversation.id !== excludeConversationId &&
        typeof conversation.roleRef === 'string' &&
        roleIdentity(conversation.roleRef) === roleIdentity(memberRef) &&
        !isGroupConversation(conversation),
    ) ?? null
  );
}

/**
 * The dispatch turn for a finished group assistant message: the nearest user
 * message above it. In the linear group log every run appends its user turn
 * (typed send, @-bar dispatch, or auto-relay stub) directly before the
 * assistant placeholder, so nearest-above is the prompt that started the run.
 */
export function findDispatchUserMessage(
  groupMessages: MessageRecord[],
  assistantMessageId: string,
): MessageRecord | null {
  const assistantIndex = groupMessages.findIndex(
    (message) => message.id === assistantMessageId,
  );
  if (assistantIndex < 0) return null;
  const assistantTaskId = groupMessages[assistantIndex]?.groupTask?.taskId;
  if (typeof assistantTaskId === 'string' && assistantTaskId) {
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      const candidate = groupMessages[i];
      if (
        candidate?.role === 'user' &&
        candidate.groupTask?.taskId === assistantTaskId
      ) {
        return candidate;
      }
    }
    return null;
  }
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const candidate = groupMessages[i];
    if (candidate && candidate.role === 'user') return candidate;
  }
  return null;
}

/**
 * Mirror a finished group turn into the member's DM. Idempotent: mirror rows
 * use deterministic ids derived from the source assistant message, so the
 * repeated finalize persists (content → producedFiles → feedback edits) just
 * refresh the same ledger pair. Returns null when the message is not a
 * finished group member turn (wrong role, no member, non-terminal run,
 * non-group conversation, or itself already a mirror).
 */
export function mirrorGroupTaskToMemberDm(
  deps: GroupTaskMirrorDeps,
  input: {
    projectId: string;
    conversation: ConversationRecord;
    message: MessageRecord;
  },
): GroupTaskMirrorResult | null {
  const { db, randomId } = deps;
  const { projectId, conversation, message } = input;

  if (!message || message.role !== 'assistant') return null;
  // Never mirror a mirror. Durable source tasks also carry groupTask
  // provenance, but their source conversation is the group itself; mirrored
  // DM rows retain the original group id and therefore differ here.
  if (
    message.groupTask &&
    message.groupTask.sourceConversationId !== conversation.id
  ) return null;
  if (!isGroupConversation(conversation)) return null;
  const groupMessages = deps.listMessages(db, conversation.id);
  if (!groupMessages.some(candidate => candidate.id === message.id)) return null;
  const memberRef =
    typeof message.roleRef === 'string' && message.roleRef.startsWith('role:')
      ? message.roleRef
      : null;
  if (!memberRef) return null;
  if (
    !conversation.memberRefs?.some(
      roleRef => roleIdentity(roleRef) === roleIdentity(memberRef),
    )
  ) return null;
  const runStatus = typeof message.runStatus === 'string' ? message.runStatus : '';
  if (!TERMINAL_RUN_STATUSES.has(runStatus)) return null;

  const project = deps.getProject(db, projectId) ?? null;
  const memberName = memberDisplayName(project, memberRef);

  const conversations = deps.listConversations(db, projectId);
  let dm = findMemberDmConversation(conversations, memberRef, conversation.id);
  let createdDm = false;
  if (!dm) {
    const now = Date.now();
    dm = deps.insertConversation(db, {
      id: randomId(),
      projectId,
      title: memberName,
      roleRef: memberRef,
      createdAt: now,
      updatedAt: now,
    });
    createdDm = true;
  }
  if (!dm) return null;

  const groupTaskBase = {
    ...(message.groupTask?.taskId ? { taskId: message.groupTask.taskId } : {}),
    sourceProjectId: projectId,
    sourceConversationId: conversation.id,
    sourceConversationTitle: conversation.title ?? null,
    memberRef,
    memberName,
  };

  const dispatch = findDispatchUserMessage(groupMessages, message.id);
  if (dispatch) {
    deps.upsertMessage(db, dm.id, {
      id: groupTaskUserMirrorId(message.id),
      role: 'user',
      content: dispatch.content ?? '',
      attachments: dispatch.attachments,
      replyTo: dispatch.replyTo,
      sessionMode: dispatch.sessionMode,
      roleRef: memberRef,
      createdAt: dispatch.createdAt,
      startedAt: dispatch.startedAt,
      endedAt: dispatch.endedAt,
      groupTask: {
        ...groupTaskBase,
        sourceMessageId: dispatch.id,
      } satisfies ChatMessageGroupTask,
    });
  }

  deps.upsertMessage(db, dm.id, {
    id: groupTaskAssistantMirrorId(message.id),
    role: 'assistant',
    content: message.content ?? '',
    agentId: message.agentId,
    agentName: message.agentName,
    roleRef: memberRef,
    runStatus,
    events: message.events,
    producedFiles: message.producedFiles,
    traceObjectFiles: message.traceObjectFiles,
    replyTo: message.replyTo,
    sessionMode: message.sessionMode,
    createdAt: message.createdAt,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
    groupTask: {
      ...groupTaskBase,
      sourceMessageId: message.id,
    } satisfies ChatMessageGroupTask,
  });

  return { dmConversationId: dm.id, memberRef, createdDm };
}
