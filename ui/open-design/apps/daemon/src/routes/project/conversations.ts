import type { Express } from 'express';
import {
  buildGroupContextHeader,
  buildGroupFanOutStubPrompt,
  buildGroupHistoryCompactionNotice,
  buildGroupRelayStubPrompt,
  buildReplyExcerpt,
  formatReplyQuote,
  formatTurnFileReferences,
  GROUP_RELAY_MAX_HOPS,
  parseGroupRelayDispatch,
  parseUserGroupMentions,
  type ChatGroupContext,
  type ChatMessageReplyRef,
  type ChatSessionMode,
  type GroupChatMember,
  type ProjectFile,
} from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { messageForChatResponse } from '../../message-payload.js';
import type { RouteDeps } from '../../server-context.js';
import {
  createMatOSProjectTaskAuthority,
  listMatOSProjectTimelineAuthority,
  mergeMatOSProjectAuthorityMetadata,
  readMatOSProjectAuthority,
  sendMatOSProjectMessageAuthority,
  syncMatOSProjectAuthority,
  syncMatOSProjectConversationsAuthority,
  updateMatOSProjectTaskAuthority,
} from '../../services/matos-project-authority.js';
import { matosRoleDisplayNames } from '../matos-assets.js';
import { registerProjectCommentRoutes } from './comments.js';
import { projectGroupDispatchHook } from './group-dispatch-hook.js';
import {
  findDispatchUserMessage,
  mirrorGroupTaskToMemberDm,
  type GroupTaskMirrorResult,
} from './group-task-mirror.js';
import {
  attachProjectGroupTaskChild,
  claimNextProjectGroupTask,
  completeProjectGroupTaskOutbox,
  enqueueProjectGroupTaskOutbox,
  failProjectGroupTaskOutbox,
  findProjectGroupTaskByAssistantMessage,
  findProjectGroupTaskByClientRequest,
  getProjectGroupTask,
  insertProjectGroupTask,
  listProjectGroupTasks,
  listProjectGroupTaskOutbox,
  listRecoverableProjectGroupTasks,
  nextProjectGroupTaskOutboxDelay,
  renewProjectGroupTaskLease,
  setProjectGroupTaskAuthorityState,
  updateProjectGroupTask,
  type ProjectGroupTaskRecord,
} from './group-task-queue.js';
import {
  completeProjectMessageAuthorityOutbox,
  enqueueProjectMessageAuthorityOutbox,
  failProjectMessageAuthorityOutbox,
  listProjectMessageAuthorityOutbox,
  nextProjectMessageAuthorityOutboxDelay,
} from './message-authority-outbox.js';
import { messageAuthorityOutboxFlushHook } from './message-authority-flush-hook.js';

export interface RegisterProjectConversationRoutesDeps extends RouteDeps<'db' | 'design' | 'paths' | 'projectStore' | 'projectFiles' | 'conversations' | 'ids' | 'appConfig' | 'agents' | 'chat' | 'messages' | 'lifecycle'> {}

function normalizeChatSessionMode(value: unknown): ChatSessionMode {
  return value === 'chat' || value === 'plan' ? value : 'design';
}

type FileSnapshot = Pick<ProjectFile, 'name' | 'size' | 'mtime' | 'etag'>;

export function producedProjectFilesFromSnapshots(
  before: FileSnapshot[] | undefined,
  after: ProjectFile[] | null,
): ProjectFile[] | undefined {
  if (!before || !after) return undefined;
  const previous = new Map(before.map(file => [file.name, file]));
  const produced: ProjectFile[] = [];
  for (const file of after) {
    const old = previous.get(file.name);
    if (!old) {
      produced.push({ ...file, traceObjectReason: 'new' });
      continue;
    }
    const changed = file.etag && old.etag
      ? file.etag !== old.etag
      : file.size !== old.size || file.mtime !== old.mtime;
    if (changed) produced.push({ ...file, traceObjectReason: 'modified' });
  }
  return produced;
}

export function registerProjectConversationRoutes(app: Express, ctx: RegisterProjectConversationRoutesDeps): void {
  const { db } = ctx;
  const { getProject, updateProject } = ctx.projectStore;
  const { resolveProjectDir, listFiles } = ctx.projectFiles;
  const {
    insertConversation,
    getConversation,
    listConversations,
    updateConversation,
    deleteConversation,
    listMessageIds,
    listMessages,
    listMessagesForChat,
    reconcileMessageTurnOrder,
    upsertMessage,
  } = ctx.conversations;
  const { randomId } = ctx.ids;
  const { PROJECTS_DIR } = ctx.paths;
  const { readAppConfig } = ctx.appConfig;
  const { getAgentDef } = ctx.agents;
  const { startChatRun } = ctx.chat;
  const {
    pinAssistantMessageOnRunCreate,
    reconcileAssistantMessageOnRunEnd,
  } = ctx.messages;
  const runningGroupTaskConversations = new Set<string>();
  const groupTaskWorkerId = `${process.pid}:${randomId()}`;
  const GROUP_TASK_LEASE_MS = 60_000;
  let authorityOutboxFlushing = false;
  let authorityOutboxTimer: ReturnType<typeof setTimeout> | null = null;
  let authorityOutboxTimerDueAt: number | null = null;
  let groupTaskRecoveryRunning = false;
  let messageAuthorityOutboxFlushing = false;
  let messageAuthorityOutboxTimer: ReturnType<typeof setTimeout> | null = null;
  let messageAuthorityOutboxTimerDueAt: number | null = null;
  const timelineImportInFlight = new Map<string, Promise<void>>();
  const timelineImportLastStartedAt = new Map<string, number>();
  const conversationAuthorityTails = new Map<string, Promise<void>>();
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const pidAlive = (pid: number | null): boolean => {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  };
  const terminateOrphan = async (pid: number | null): Promise<boolean> => {
    if (!pidAlive(pid)) return true;
    try {
      process.kill(process.platform === 'win32' ? pid! : -pid!, 'SIGTERM');
    } catch {
      try { process.kill(pid!, 'SIGTERM'); } catch {}
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!pidAlive(pid)) return true;
      await delay(100);
    }
    try {
      process.kill(process.platform === 'win32' ? pid! : -pid!, 'SIGKILL');
    } catch {
      try { process.kill(pid!, 'SIGKILL'); } catch {}
    }
    await delay(100);
    return !pidAlive(pid);
  };
  const groupTaskConversationKey = (projectId: string, conversationId: string) =>
    `${projectId}\0${conversationId}`;

  const projectCwd = (project: any) => resolveProjectDir(
    PROJECTS_DIR,
    project.id,
    project.metadata,
    { allowUnavailableSandboxImportedProject: true },
  );

  const terminalRunStatuses = new Set(['succeeded', 'failed', 'canceled']);
  const TIMELINE_IMPORT_TTL_MS = 15_000;

  async function ensureProjectAuthority(project: any) {
    const cwd = projectCwd(project);
    const existing = await readMatOSProjectAuthority(cwd, project.id)
      .catch((error: any) => {
        if (
          /MatOS project metadata has no id|MatOS project conversation (?:role is not a project member|member is not in the project)/i
            .test(String(error?.message ?? error))
        ) return null;
        throw error;
      });
    return existing ?? syncMatOSProjectAuthority({
      cwd,
      id: project.id,
      name: project.name,
      metadata: project.metadata,
    });
  }

  async function persistMessageToProjectTimeline(
    project: any,
    conversationId: string,
    message: any,
  ): Promise<void> {
    const role = String(message?.role ?? '');
    const content = String(message?.content ?? '').trim();
    if (!content || (role !== 'user' && role !== 'assistant' && role !== 'system')) return;
    if (role === 'assistant' && !terminalRunStatuses.has(String(message?.runStatus ?? ''))) return;
    const authority = await ensureProjectAuthority(project);
    const roleRef = typeof message?.roleRef === 'string' ? message.roleRef : undefined;
    const member = roleRef
      ? authority?.team.find(candidate =>
          candidate.roleRef && roleIdentity(candidate.roleRef) === roleIdentity(roleRef))
      : undefined;
    if (role === 'assistant' && roleRef && !member) return;
    const createdAtMs = Number(message?.createdAt ?? message?.endedAt ?? Date.now());
    await sendMatOSProjectMessageAuthority({
      cwd: projectCwd(project),
      projectId: project.id,
      conversationId,
      eventId: `od-message-${String(message.id)}`,
      createdAt: new Date(Number.isFinite(createdAtMs) ? createdAtMs : Date.now()).toISOString(),
      senderKind: role === 'assistant' ? 'agent' : role === 'system' ? 'system' : 'human',
      senderId: role === 'assistant'
        ? String(member?.memberId ?? roleRef ?? message?.agentId ?? 'agent')
        : role === 'system' ? 'system' : 'user',
      ...(member?.memberId ? { memberId: member.memberId } : {}),
      ...(roleRef ? { roleRef } : {}),
      text: content,
      refs: {
        messageId: String(message.id),
        ...(typeof message?.turnUserMessageId === 'string'
          ? { turnUserMessageId: message.turnUserMessageId }
          : {}),
        ...(typeof message?.runId === 'string' ? { runId: message.runId } : {}),
      },
    });
  }

  function shouldPersistMessageToProjectTimeline(message: any): boolean {
    const role = String(message?.role ?? '');
    if (!String(message?.content ?? '').trim()) return false;
    if (role === 'user' || role === 'system') return true;
    return role === 'assistant' && terminalRunStatuses.has(String(message?.runStatus ?? ''));
  }

  function getMessageTimelineProjection(messageId: string): any | null {
    return db.prepare(
      `SELECT id, role, content, agent_id AS agentId, role_ref AS roleRef,
              run_id AS runId, run_status AS runStatus,
              turn_user_message_id AS turnUserMessageId,
              created_at AS createdAt, ended_at AS endedAt
         FROM messages WHERE id = ?`,
    ).get(messageId) ?? null;
  }

  async function importProjectTimelineMessages(project: any, conversationId: string): Promise<void> {
    await ensureProjectAuthority(project);
    const events = await listMatOSProjectTimelineAuthority({
      cwd: projectCwd(project),
      projectId: project.id,
      conversationId,
    });
    const existingIds = new Set(listMessageIds(db, conversationId));
    const turnPairs: Array<{ userMessageId: string; assistantMessageId: string }> = [];
    let latestUserMessageId: string | null = null;
    for (const event of events) {
      const messageId = typeof event.refs?.messageId === 'string'
        ? event.refs.messageId
        : `matos-event-${event.eventId}`;
      const role = event.sender.kind === 'agent'
        ? 'assistant'
        : event.sender.kind === 'system'
          ? 'system'
          : 'user';
      if (role === 'user') latestUserMessageId = messageId;
      if (role === 'assistant') {
        const explicitTurnUserMessageId = typeof event.refs?.turnUserMessageId === 'string'
          ? event.refs.turnUserMessageId
          : null;
        const turnUserMessageId = explicitTurnUserMessageId ?? latestUserMessageId;
        if (turnUserMessageId) {
          turnPairs.push({ userMessageId: turnUserMessageId, assistantMessageId: messageId });
        }
      }
      if (existingIds.has(messageId)) continue;
      const createdAt = Date.parse(event.createdAt);
      upsertMessage(db, conversationId, {
        id: messageId,
        role,
        content: event.text,
        ...(event.sender.roleRef ? { roleRef: event.sender.roleRef } : {}),
        ...(event.sender.kind === 'agent'
          ? { agentId: 'matos', agentName: 'MatOS', runStatus: 'succeeded' }
          : {}),
        ...(role === 'assistant' && turnPairs.length > 0
          ? { turnUserMessageId: turnPairs[turnPairs.length - 1]!.userMessageId }
          : {}),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        startedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        endedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      });
      existingIds.add(messageId);
    }
    reconcileMessageTurnOrder(db, conversationId, turnPairs);
  }

  function scheduleProjectTimelineImport(
    project: any,
    conversationId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const key = `${project.id}\0${conversationId}`;
    const inFlight = timelineImportInFlight.get(key);
    if (inFlight) return inFlight;
    const lastStartedAt = timelineImportLastStartedAt.get(key) ?? 0;
    if (!options.force && Date.now() - lastStartedAt < TIMELINE_IMPORT_TTL_MS) {
      return Promise.resolve();
    }
    timelineImportLastStartedAt.set(key, Date.now());
    const task = importProjectTimelineMessages(project, conversationId)
      .catch((error: any) => {
        timelineImportLastStartedAt.delete(key);
        console.warn('[project-timeline] native timeline background import failed', error);
      })
      .finally(() => {
        if (timelineImportInFlight.get(key) === task) timelineImportInFlight.delete(key);
      });
    timelineImportInFlight.set(key, task);
    return task;
  }

  function scheduleMessageAuthorityOutboxFlush(delayMs = 0): void {
    const boundedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + boundedDelay;
    if (messageAuthorityOutboxTimer && messageAuthorityOutboxTimerDueAt !== null) {
      if (messageAuthorityOutboxTimerDueAt <= dueAt) return;
      clearTimeout(messageAuthorityOutboxTimer);
    }
    messageAuthorityOutboxTimerDueAt = dueAt;
    messageAuthorityOutboxTimer = setTimeout(() => {
      messageAuthorityOutboxTimer = null;
      messageAuthorityOutboxTimerDueAt = null;
      void flushMessageAuthorityOutbox();
    }, boundedDelay);
    messageAuthorityOutboxTimer.unref?.();
  }

  async function flushMessageAuthorityOutbox(): Promise<void> {
    if (messageAuthorityOutboxFlushing) {
      scheduleMessageAuthorityOutboxFlush(100);
      return;
    }
    messageAuthorityOutboxFlushing = true;
    try {
      for (const record of listProjectMessageAuthorityOutbox(db, 100)) {
        const project = getProject(db, record.projectId);
        const conversation = getConversation(db, record.conversationId);
        const message = getMessageTimelineProjection(record.messageId);
        if (
          !project ||
          !conversation ||
          conversation.projectId !== record.projectId ||
          !message ||
          !shouldPersistMessageToProjectTimeline(message)
        ) {
          completeProjectMessageAuthorityOutbox(db, record.messageId);
          continue;
        }
        try {
          await persistMessageToProjectTimeline(project, record.conversationId, message);
          completeProjectMessageAuthorityOutbox(db, record.messageId);
        } catch (error: any) {
          failProjectMessageAuthorityOutbox(
            db,
            record.messageId,
            String(error?.message ?? error),
          );
        }
      }
    } finally {
      messageAuthorityOutboxFlushing = false;
    }
    const nextDelay = nextProjectMessageAuthorityOutboxDelay(db);
    if (nextDelay !== null) scheduleMessageAuthorityOutboxFlush(Math.max(10, nextDelay));
  }

  // Run-terminal reconcile (server.ts -> finalizeAssistantMessageFromRunEvents)
  // enqueues message-authority outbox records for API-only clients and needs
  // the flush loop this module owns to pick them up. Registered as a hook for
  // the same reason as projectGroupDispatchHook below: server.ts must not
  // import this route closure.
  messageAuthorityOutboxFlushHook.current = (delayMs: number) => {
    scheduleMessageAuthorityOutboxFlush(Math.max(0, delayMs));
  };

  const roleIdentity = (value: string) => value.trim().split('@')[0] ?? value.trim();

  async function withConversationAuthorityLock<T>(
    projectId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = (conversationAuthorityTails.get(projectId) ?? Promise.resolve())
      .catch(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    conversationAuthorityTails.set(projectId, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (conversationAuthorityTails.get(projectId) === queued) {
        conversationAuthorityTails.delete(projectId);
      }
    }
  }

  async function syncConversationAuthority(
    project: any,
    conversations: any[] | (() => any[]),
    afterSync?: () => void | Promise<void>,
  ): Promise<void> {
    await withConversationAuthorityLock(project.id, async () => {
      const syncDesired = async (desiredConversations: any[] | (() => any[])) => {
        let lastConflict: unknown;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const currentAuthority = await ensureProjectAuthority(project);
          const desired = typeof desiredConversations === 'function'
            ? desiredConversations()
            : desiredConversations;
          try {
            return await syncMatOSProjectConversationsAuthority({
              cwd: projectCwd(project),
              ...(currentAuthority ? { expectedRevision: currentAuthority.revision } : {}),
              conversations: desired.map(conversation => ({
                id: String(conversation.id),
                title: typeof conversation.title === 'string' ? conversation.title : null,
                roleRef: typeof conversation.roleRef === 'string' ? conversation.roleRef : null,
                memberRefs: Array.isArray(conversation.memberRefs) ? conversation.memberRefs : [],
                createdAt: Number(conversation.createdAt) || Date.now(),
                updatedAt: Number(conversation.updatedAt) || Date.now(),
              })),
            });
          } catch (error) {
            lastConflict = error;
            if (!/project metadata revision conflict/i.test(String((error as Error)?.message ?? error))) {
              throw error;
            }
          }
        }
        throw lastConflict ?? new Error('MatOS project conversation synchronization failed');
      };
      const updateAuthorityProjection = (authority: Awaited<ReturnType<typeof syncDesired>>) => {
        const latestProject = getProject(db, project.id) ?? project;
        updateProject(db, project.id, {
          metadata: mergeMatOSProjectAuthorityMetadata(latestProject.metadata, authority),
          updatedAt: latestProject.updatedAt,
        });
      };
      updateAuthorityProjection(await syncDesired(conversations));
      if (afterSync) {
        try {
          await afterSync();
        } catch (error) {
          // The native update happened first so a failed SQLite delete cannot
          // leave the two stores disagreeing. Restore from current SQLite state
          // while still holding the same per-project authority lock.
          updateAuthorityProjection(await syncDesired(() => listConversations(db, project.id)));
          throw error;
        }
      }
    });
  }

  function deterministicGroupTaskId(input: {
    projectId: string;
    conversationId: string;
    clientRequestId: string;
  }): string {
    const digest = createHash('sha256')
      .update(input.projectId)
      .update('\0')
      .update(input.conversationId)
      .update('\0')
      .update(input.clientRequestId)
      .digest('hex')
      .slice(0, 32);
    return `group-task-${digest}`;
  }

  function scheduleAuthorityOutboxFlush(delayMs = 0): void {
    const boundedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + boundedDelay;
    if (authorityOutboxTimer && authorityOutboxTimerDueAt !== null) {
      if (authorityOutboxTimerDueAt <= dueAt) return;
      clearTimeout(authorityOutboxTimer);
    }
    authorityOutboxTimerDueAt = dueAt;
    authorityOutboxTimer = setTimeout(() => {
      authorityOutboxTimer = null;
      authorityOutboxTimerDueAt = null;
      void flushAuthorityOutbox();
    }, boundedDelay);
    authorityOutboxTimer.unref?.();
  }

  async function ensureGroupTaskDispatchTimeline(
    task: ProjectGroupTaskRecord,
    project: any,
  ): Promise<void> {
    const message = listMessages(db, task.conversationId)
      .find((candidate: any) => candidate.id === task.userMessageId);
    if (!message) {
      throw new Error(`group task dispatch message is missing: ${task.userMessageId}`);
    }
    await persistMessageToProjectTimeline(project, task.conversationId, message);
  }

  async function flushAuthorityOutbox(taskId?: string): Promise<boolean> {
    if (authorityOutboxFlushing) {
      scheduleAuthorityOutboxFlush(100);
      return false;
    }
    authorityOutboxFlushing = true;
    let allSucceeded = true;
    try {
      for (const record of listProjectGroupTaskOutbox(db, {
        ...(taskId ? { taskId } : {}),
        limit: 100,
      })) {
        const task = getProjectGroupTask(db, record.taskId);
        const project = task ? getProject(db, task.projectId) : null;
        if (!task || !project) {
          completeProjectGroupTaskOutbox(db, record.id);
          continue;
        }
        try {
          if (record.operation === 'create') {
            // The task ledger must never advance ahead of its canonical chat
            // event. This also repairs a daemon crash between the SQLite
            // enqueue transaction and the first timeline append.
            await ensureGroupTaskDispatchTimeline(task, project);
            await createMatOSProjectTaskAuthority(projectCwd(project), {
              taskId: task.id,
              conversationId: task.conversationId,
              roleRef: task.memberRef,
              ...(task.memberId ? { memberId: task.memberId } : {}),
              prompt: task.prompt,
              ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}),
              relayHop: task.relayHop,
            });
            setProjectGroupTaskAuthorityState(db, task.id, 'ready', null);
          } else if (record.operation.startsWith('conversation-sync:')) {
            await syncConversationAuthority(project, () => listConversations(db, task.projectId));
          } else if (record.operation.startsWith('timeline:')) {
            const messageId = typeof record.payload.messageId === 'string'
              ? record.payload.messageId
              : task.assistantMessageId;
            const message = listMessages(db, task.conversationId)
              .find((candidate: any) => candidate.id === messageId);
            if (!message) throw new Error(`group task timeline message is missing: ${messageId}`);
            await persistMessageToProjectTimeline(project, task.conversationId, message);
          } else if (record.operation.startsWith('status:')) {
            await updateMatOSProjectTaskAuthority(
              projectCwd(project),
              task.id,
              record.payload as { status: string; runId?: string | null; error?: string | null },
            );
          } else {
            throw new Error(`unsupported project group task outbox operation: ${record.operation}`);
          }
          completeProjectGroupTaskOutbox(db, record.id);
          if (record.operation === 'create') {
            scheduleNextGroupTask(task.projectId, task.conversationId);
          }
        } catch (error: any) {
          allSucceeded = false;
          const message = String(error?.message ?? error);
          failProjectGroupTaskOutbox(db, record.id, message);
          if (record.operation === 'create') {
            setProjectGroupTaskAuthorityState(db, task.id, 'error', message);
          }
        }
      }
    } finally {
      authorityOutboxFlushing = false;
    }
    const nextDelay = nextProjectGroupTaskOutboxDelay(db);
    if (nextDelay !== null) scheduleAuthorityOutboxFlush(Math.max(10, nextDelay));
    return allSucceeded;
  }

  async function projectMemberRefs(project: any): Promise<string[]> {
    return (await ensureProjectAuthority(project)).members;
  }

  /** Version-agnostic lookup in a `role:<ref>`-keyed record (alias/brief maps). */
  function roleRefRecordValue(
    record: Record<string, unknown> | null | undefined,
    roleRef: string,
  ): string | null {
    if (!record || typeof record !== 'object') return null;
    const direct = record[roleRef];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const identity = roleIdentity(roleRef);
    for (const [key, value] of Object.entries(record)) {
      if (roleIdentity(key) === identity && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  /**
   * The conversation's member roster with display names resolved the same way
   * the web roster header resolves them: project alias (`metadata.memberNames`)
   * first, then the role catalog name, then the authority team label, then the
   * bare role id. Keeping the two sides' names aligned is what lets the daemon
   * re-parse "@NAME" mentions/handoffs written against a web-built roster.
   */
  async function resolveGroupChatMembers(
    project: any,
    conversation: any,
  ): Promise<Array<GroupChatMember & { brief?: string }>> {
    const memberRefs: string[] = Array.isArray(conversation?.memberRefs)
      ? conversation.memberRefs.filter((value: unknown): value is string =>
          typeof value === 'string' && value.startsWith('role:'))
      : [];
    if (memberRefs.length === 0) return [];
    const metadata = (project?.metadata ?? {}) as Record<string, any>;
    const aliases = metadata.memberNames && typeof metadata.memberNames === 'object'
      ? metadata.memberNames as Record<string, unknown>
      : null;
    const briefs = metadata.memberBriefs && typeof metadata.memberBriefs === 'object'
      ? metadata.memberBriefs as Record<string, unknown>
      : null;
    const team: Array<{ roleRef?: string; displayName?: string; label?: string }> =
      Array.isArray(metadata.matosProjectMembers) ? metadata.matosProjectMembers : [];
    const catalogNames = await matosRoleDisplayNames();
    return memberRefs.map((ref) => {
      const identity = roleIdentity(ref);
      const alias = roleRefRecordValue(aliases as Record<string, unknown> | null, ref);
      const catalogName = catalogNames.get(identity);
      const teamEntry = team.find((member) =>
        typeof member?.roleRef === 'string' && roleIdentity(member.roleRef) === identity);
      const teamName = [teamEntry?.displayName, teamEntry?.label].find(
        (value) => typeof value === 'string' && value.trim() && !value.trim().startsWith('role:'),
      );
      const brief = roleRefRecordValue(briefs as Record<string, unknown> | null, ref);
      return {
        ref,
        name: alias ?? catalogName ?? (teamName ? teamName.trim() : identity.replace(/^role:/, '')),
        ...(brief ? { brief } : {}),
      };
    });
  }

  /** Group context for a durable task run, or null for non-group conversations. */
  async function groupTaskRunContext(
    project: any,
    conversation: any,
    respondingRef: string,
  ): Promise<ChatGroupContext | null> {
    const members = await resolveGroupChatMembers(project, conversation);
    if (members.length <= 1) return null;
    const responder = members.find((member) =>
      roleIdentity(member.ref) === roleIdentity(respondingRef));
    return {
      members,
      respondingRef: responder?.ref ?? respondingRef,
      respondingName: responder?.name ?? roleIdentity(respondingRef).replace(/^role:/, ''),
    };
  }

  function boundedGroupTaskTranscript(
    conversationId: string,
    excludedMessageIds: ReadonlySet<string>,
    groupContext?: ChatGroupContext | null,
  ): string {
    const memberNameFor = (roleRef: unknown): string | null => {
      if (!groupContext) return null;
      if (typeof roleRef !== 'string' || !roleRef.startsWith('role:')) return null;
      const member = groupContext.members.find((candidate) =>
        roleIdentity(candidate.ref) === roleIdentity(roleRef));
      return member ? member.name : roleIdentity(roleRef).replace(/^role:/, '');
    };
    const messages = listMessages(db, conversationId)
      .filter((message: any) => !excludedMessageIds.has(message.id))
      .filter((message: any) => message.role === 'user' || message.role === 'assistant')
      .filter((message: any) => String(message.content ?? '').trim().length > 0);
    const selected: string[] = [];
    let used = 0;
    let includedCount = 0;
    for (const message of messages.slice(-40).reverse()) {
      const content = String(message.content ?? '').trim();
      if (!content) continue;
      // Same attribution grammar as the web transcript builder so agents see
      // ONE consistent labeling wherever their turn was composed:
      // `## assistant (member: NAME)` marks who produced a turn and
      // `## user (@NAME)` marks whom the user addressed.
      const memberName = memberNameFor(message.roleRef);
      const label = message.role === 'assistant'
        ? memberName
          ? `assistant (member: ${memberName})`
          : typeof message.roleRef === 'string' && message.roleRef
            ? `assistant (${message.roleRef})`
            : 'assistant'
        : memberName
          ? `user (@${memberName})`
          : 'user';
      // Quote-reply anchor first (which message this turn replies to), then
      // the content, then per-turn file provenance — the same grammar the web
      // transcript builder renders, so agents see ONE format everywhere.
      const replyQuote = message.replyTo && typeof message.replyTo === 'object'
        ? formatReplyQuote(message.replyTo as { authorName?: string | null; excerpt: string })
        : '';
      const fileReferences = formatTurnFileReferences({
        attachments: Array.isArray(message.attachments) ? message.attachments : null,
        producedFiles: Array.isArray(message.producedFiles) ? message.producedFiles : null,
      });
      const block = `## ${label}${replyQuote ? `\n${replyQuote}` : ''}\n${
        content.slice(0, 12_000)
      }${fileReferences ? `\n${fileReferences}` : ''}`;
      if (selected.length > 0 && used + block.length > 64_000) break;
      selected.push(block);
      used += block.length;
      includedCount += 1;
    }
    const transcript = selected.reverse().join('\n\n');
    // Agents cannot scroll up: when older turns were dropped for the prompt
    // budget, say how many and where the full history persists (the
    // project-local native timeline, readable from the run's own cwd).
    const compactionNotice = buildGroupHistoryCompactionNotice({
      omittedCount: messages.length - includedCount,
      conversationId,
    });
    return [
      ...(groupContext ? [buildGroupContextHeader(groupContext)] : []),
      ...(compactionNotice ? [compactionNotice] : []),
      transcript,
    ].filter(Boolean).join('\n\n');
  }

  async function snapshotProjectFiles(project: any): Promise<ProjectFile[] | null> {
    try {
      const files = await listFiles(PROJECTS_DIR, project.id, { metadata: project.metadata });
      return files.map((file: any) => ({
        ...file,
        name: String(file.name ?? file.path ?? ''),
        size: Number(file.size ?? 0),
        mtime: Number(file.mtime ?? 0),
        kind: file.kind ?? 'binary',
        mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream',
      } satisfies ProjectFile)).filter((file: ProjectFile) => file.name.length > 0);
    } catch (error) {
      console.warn('[group-task] project file snapshot failed', error);
      return null;
    }
  }

  function scheduleNextGroupTask(projectId: string, conversationId: string): void {
    setTimeout(() => {
      void startNextGroupTask(projectId, conversationId);
    }, 0);
  }

  type EnqueueGroupTaskResult =
    | { ok: true; task: ProjectGroupTaskRecord; idempotent: boolean }
    | { ok: false; status: number; error: string };

  /**
   * The single enqueue path for durable group tasks. Shared by the HTTP
   * route (user/@-bar dispatches from the web) and the daemon's own dispatch
   * continuation (fan-out + auto-relay), so both produce identical task rows,
   * stub messages, provenance, and native-authority outbox records.
   *
   * `clientRequestId` is the idempotency key: an existing task with the same
   * key and the same member is returned as an idempotent hit. The stub prompt
   * text is NOT part of the identity — racing enqueuers (web PUT finalize vs
   * reconcile hook vs durable completion, possibly with differently localized
   * stub text) must converge on the first-written task instead of erroring.
   */
  async function enqueueGroupTaskCore(input: {
    project: any;
    conversation: any;
    memberRef: string;
    prompt: string;
    relayHop: number;
    sourceMessageId?: string | null;
    clientRequestId?: string;
    /** Source dispatch turn's user attachments, copied onto the stub user
     *  message so the queued run and the DM work ledger see the same files
     *  the dispatching turn carried. */
    attachments?: readonly unknown[] | null;
    /** Quote-reply anchor: the message this dispatch stub replies to (the
     *  user dispatch turn for fan-out, the handing-off reply for relay). */
    replyTo?: ChatMessageReplyRef | null;
  }): Promise<EnqueueGroupTaskResult> {
    const { project, conversation } = input;
    const prompt = input.prompt.trim();
    const requestedMemberRef = input.memberRef.trim();
    const clientRequestId = (input.clientRequestId ?? '').trim();
    if (!requestedMemberRef || !prompt) {
      return { ok: false, status: 400, error: 'memberRef and prompt are required' };
    }
    if (prompt.length > 32_000) {
      return { ok: false, status: 400, error: 'group task prompt exceeds 32 000 characters' };
    }
    if (clientRequestId.length > 200) {
      return { ok: false, status: 400, error: 'clientRequestId exceeds 200 characters' };
    }
    const roster = Array.isArray(conversation.memberRefs) ? conversation.memberRefs : [];
    if (!roster.some((ref: string) => roleIdentity(ref) === roleIdentity(requestedMemberRef))) {
      return { ok: false, status: 400, error: 'member is not in this group conversation' };
    }
    let projectMembers: string[];
    let projectAuthority: Awaited<ReturnType<typeof readMatOSProjectAuthority>> = null;
    try {
      projectAuthority = await readMatOSProjectAuthority(projectCwd(project), project.id);
      projectMembers = projectAuthority?.members ?? await projectMemberRefs(project);
    } catch (error: any) {
      return { ok: false, status: 409, error: String(error?.message ?? error) };
    }
    const memberRef = projectMembers.find(ref =>
      roleIdentity(ref) === roleIdentity(requestedMemberRef),
    );
    if (!memberRef) {
      return { ok: false, status: 400, error: 'member is not in this project' };
    }
    const projectMember = projectAuthority?.team.find(candidate =>
      candidate.roleRef && roleIdentity(candidate.roleRef) === roleIdentity(memberRef));
    if (!getAgentDef('matos')) {
      return { ok: false, status: 503, error: 'MatOS runtime is unavailable' };
    }

    const idempotentHit = (existing: ProjectGroupTaskRecord): Promise<EnqueueGroupTaskResult> =>
      (async () => {
        await flushAuthorityOutbox(existing.id);
        const authoritative = getProjectGroupTask(db, existing.id) ?? existing;
        if (authoritative.authorityState === 'error') {
          return {
            ok: false as const,
            status: 502,
            error: authoritative.error ?? 'native MatOS project task synchronization failed',
          };
        }
        return { ok: true as const, task: authoritative, idempotent: true };
      })();

    if (clientRequestId) {
      const existing = findProjectGroupTaskByClientRequest(db, {
        projectId: project.id,
        conversationId: conversation.id,
        clientRequestId,
      });
      if (existing) {
        if (roleIdentity(existing.memberRef) !== roleIdentity(memberRef)) {
          return { ok: false, status: 409, error: 'clientRequestId was already used for a different task' };
        }
        return idempotentHit(existing);
      }
    }

    const taskId = clientRequestId
      ? deterministicGroupTaskId({
          projectId: project.id,
          conversationId: conversation.id,
          clientRequestId,
        })
      : randomId();
    const userMessageId = randomId();
    const assistantMessageId = randomId();
    const sourceMessageId = typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim()
      ? input.sourceMessageId.trim()
      : userMessageId;
    const relayHop = Number.isInteger(input.relayHop)
      ? Math.max(0, Math.min(8, input.relayHop))
      : 0;
    const preTurnFileSnapshot = await snapshotProjectFiles(project);
    let task: ProjectGroupTaskRecord;
    const transaction = db.transaction(() => {
      task = insertProjectGroupTask(db, {
        id: taskId,
        projectId: project.id,
        conversationId: conversation.id,
        memberRef,
        memberId: projectMember?.memberId ?? null,
        prompt,
        userMessageId,
        assistantMessageId,
        sourceMessageId,
        relayHop,
        clientRequestId: clientRequestId || null,
        authorityState: 'pending',
      });
      enqueueProjectGroupTaskOutbox(db, {
        taskId,
        operation: 'create',
        payload: { taskId },
      });
      const provenance = {
        taskId,
        sourceProjectId: project.id,
        sourceConversationId: conversation.id,
        sourceConversationTitle: conversation.title ?? null,
        sourceMessageId,
        memberRef,
      };
      upsertMessage(db, conversation.id, {
        id: userMessageId,
        role: 'user',
        content: prompt,
        roleRef: memberRef,
        sessionMode: normalizeChatSessionMode(conversation.sessionMode),
        groupTask: provenance,
        ...(Array.isArray(input.attachments) && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        createdAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      upsertMessage(db, conversation.id, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        agentId: 'matos',
        agentName: 'MatOS',
        roleRef: memberRef,
        sessionMode: normalizeChatSessionMode(conversation.sessionMode),
        runStatus: 'queued',
        groupTask: provenance,
        ...(preTurnFileSnapshot ? { preTurnFileSnapshot } : {}),
        createdAt: Date.now(),
      });
      updateProject(db, project.id, {});
    });
    try {
      transaction();
    } catch (error: any) {
      const existing = clientRequestId
        ? findProjectGroupTaskByClientRequest(db, {
            projectId: project.id,
            conversationId: conversation.id,
            clientRequestId,
          })
        : null;
      if (existing) {
        return { ok: true, task: existing, idempotent: true };
      }
      console.warn('[group-task] queue transaction failed', error);
      return { ok: false, status: 500, error: 'group task queue transaction failed' };
    }
    await flushAuthorityOutbox(taskId);
    const authoritativeTask = getProjectGroupTask(db, taskId) ?? task!;
    if (authoritativeTask.authorityState === 'error') {
      return {
        ok: false,
        status: 502,
        error: authoritativeTask.error ?? 'native MatOS project task synchronization failed',
      };
    }
    if (authoritativeTask.authorityState === 'ready') {
      scheduleNextGroupTask(project.id, conversation.id);
    }
    return { ok: true, task: authoritativeTask, idempotent: false };
  }

  /**
   * Daemon-owned group chat orchestration, run after ANY member turn in a
   * group conversation reaches a terminal state (streamed web run, reattached
   * run, or durable queued task):
   *
   * 1. Fan-out — extra members the user @-mentioned in the dispatch turn are
   *    given their queued follow-up tasks (the first mentioned member already
   *    answered the turn itself). Runs for succeeded AND failed turns: those
   *    are independent instructions from the user, not dependents of the
   *    first member's outcome. Canceled turns dispatch nothing.
   * 2. Auto-relay — a succeeded reply ending in "@NAME: <task>" handoff lines
   *    dispatches those members, carrying the handoff task text into the stub
   *    prompt, bounded by GROUP_RELAY_MAX_HOPS hops per user turn and gated
   *    on the conversation's persisted `groupAutoRelay` setting.
   *
   * The continuation is idempotent: dispatch identities are deterministic
   * (`<sourceMessageId>:<memberRef>:<relayHop>` — the same key shape the web
   * client historically used), so the racing callers (reconcile hook, PUT
   * message finalize, durable completion handler) converge on one task.
   * This is what keeps multi-hop chains alive when the browser tab closed
   * mid-run — previously the chain silently died with the tab.
   */
  async function continueGroupDispatchAfterTurn(input: {
    projectId: string;
    conversationId: string;
    assistantMessageId: string;
    runId?: string | null;
    finalStatus: string;
  }): Promise<void> {
    if (ctx.lifecycle.isDaemonShuttingDown()) return;
    const status = input.finalStatus === 'succeeded'
      ? 'succeeded'
      : input.finalStatus === 'canceled'
        ? 'canceled'
        : 'failed';
    // A canceled turn means the user actively stopped this line of work.
    if (status === 'canceled') return;
    const conversation = getConversation(db, input.conversationId);
    if (!conversation || conversation.projectId !== input.projectId) return;
    const roster = Array.isArray(conversation.memberRefs) ? conversation.memberRefs : [];
    if (roster.length <= 1) return;
    const project = getProject(db, input.projectId);
    if (!project) return;
    const groupMessages = listMessages(db, input.conversationId);
    const message = groupMessages.find((candidate: any) => candidate.id === input.assistantMessageId);
    if (!message || message.role !== 'assistant') return;
    // Mirrored ledger rows carry another conversation's provenance and must
    // never continue a chain from the DM side.
    if (message.groupTask && message.groupTask.sourceConversationId !== conversation.id) return;
    const responderRef = typeof message.roleRef === 'string' && message.roleRef.startsWith('role:')
      ? message.roleRef
      : null;
    if (!responderRef) return;
    const members = await resolveGroupChatMembers(project, conversation);
    if (members.length <= 1) return;
    const ownerTask = findProjectGroupTaskByAssistantMessage(db, input.assistantMessageId);
    const relayHop = ownerTask?.relayHop ?? 0;
    // Human-facing dispatch notices for this turn (unknown handoff target,
    // relay suppressed, enqueue failure). Collected across both phases and
    // posted once as an idempotent system row at the end.
    const noticeLines: string[] = [];

    // 1) Fan-out for the extra members of a real typed user dispatch.
    //    Daemon-built stubs carry groupTask provenance and never fan out.
    const dispatch = findDispatchUserMessage(groupMessages as any[], input.assistantMessageId);
    if (dispatch && !dispatch.groupTask) {
      const mentions = parseUserGroupMentions(String(dispatch.content ?? ''), members)
        .filter((mention) => roleIdentity(mention.ref) !== roleIdentity(responderRef));
      // The dispatch turn's attachments follow every fanned-out member: the
      // user attached those files for the whole turn, not only for the first
      // responder.
      const dispatchAttachments = Array.isArray(dispatch.attachments)
        ? (dispatch.attachments as unknown[])
        : null;
      // Fan-out stubs quote the dispatch turn (Feishu-style reply): the
      // member sees exactly which user message its task anchors to, even
      // after later turns pushed that message up the log.
      const dispatchReply: ChatMessageReplyRef = {
        messageId: String(dispatch.id),
        authorName: null,
        excerpt: buildReplyExcerpt(String(dispatch.content ?? '')),
      };
      for (const mention of mentions) {
        const result = await enqueueGroupTaskCore({
          project,
          conversation,
          memberRef: mention.ref,
          prompt: buildGroupFanOutStubPrompt(mention),
          relayHop: 0,
          sourceMessageId: dispatch.id,
          clientRequestId: `${dispatch.id}:${mention.ref}:0`,
          attachments: dispatchAttachments,
          replyTo: dispatchReply,
        });
        if (!result.ok) {
          console.warn(
            `[group-dispatch] fan-out enqueue failed for ${mention.ref}: ${result.error}`,
          );
          noticeLines.push(
            `派发 @${mention.name} 失败：${result.error} (dispatching this member failed)`,
          );
        }
      }
    }

    // 2) Auto-relay for trailing handoff lines of a succeeded reply. Handoffs
    //    that will NOT dispatch (unknown member, relay toggle off, hop cap,
    //    enqueue failure) surface as a group-log notice instead of silently
    //    dropping work the member explicitly handed over.
    if (status === 'succeeded') {
      const relayParse = parseGroupRelayDispatch(
        String(message.content ?? ''),
        members,
        responderRef,
      );
      for (const label of relayParse.unmatchedHandoffLabels) {
        noticeLines.push(
          `交接目标 "@${label}" 不是本群成员，未派发 (handoff target is not in this group; not dispatched)`,
        );
      }
      const targetNames = relayParse.targets.map((target) => `@${target.name}`).join('、');
      if (relayParse.targets.length > 0 &&
          (conversation as { groupAutoRelay?: boolean }).groupAutoRelay === false) {
        noticeLines.push(
          `本群自动接力已关闭，未派发 ${targetNames}（可在 @ 栏重新开启）(auto-relay is off for this conversation; handoffs were not dispatched)`,
        );
      } else if (relayParse.targets.length > 0 && relayHop >= GROUP_RELAY_MAX_HOPS) {
        noticeLines.push(
          `接力链已达 ${GROUP_RELAY_MAX_HOPS} 跳上限，未继续派发 ${targetNames}，请手动 @ 成员继续 (relay hop limit reached; dispatch manually to continue)`,
        );
      } else if (relayParse.targets.length > 0) {
        // Relay stubs quote the handing-off reply, attributed to the member
        // that wrote it, so the relayed teammate knows whose conclusion its
        // task continues from.
        const responderName = members.find((member) =>
          roleIdentity(member.ref) === roleIdentity(responderRef))?.name ?? null;
        const relayReply: ChatMessageReplyRef = {
          messageId: input.assistantMessageId,
          roleRef: responderRef,
          authorName: responderName,
          excerpt: buildReplyExcerpt(String(message.content ?? '')),
        };
        for (const target of relayParse.targets) {
          const result = await enqueueGroupTaskCore({
            project,
            conversation,
            memberRef: target.ref,
            prompt: buildGroupRelayStubPrompt(target),
            relayHop: relayHop + 1,
            sourceMessageId: input.assistantMessageId,
            clientRequestId: `${input.assistantMessageId}:${target.ref}:${relayHop + 1}`,
            replyTo: relayReply,
          });
          if (!result.ok) {
            console.warn(
              `[group-dispatch] relay enqueue failed for ${target.ref}: ${result.error}`,
            );
            noticeLines.push(
              `派发 @${target.name} 失败：${result.error} (dispatching this member failed)`,
            );
          }
        }
      }
    }

    // Post the dispatch notice into the group log (Feishu-style system row).
    // Deterministic id per finished turn keeps the racing continuation
    // callers idempotent; agents never see it (transcripts keep user/
    // assistant turns only), it exists for the human watching the group.
    if (noticeLines.length > 0) {
      const notice = upsertMessage(db, conversation.id, {
        id: `gdn-${input.assistantMessageId}`,
        role: 'system',
        content: noticeLines.join('\n'),
        createdAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      if (notice) {
        await persistMessageToProjectTimeline(project, conversation.id, notice)
          .catch((error: any) => {
            console.warn('[group-dispatch] notice timeline persist failed', error);
          });
      }
    }
  }

  // Every run finalization observed by the daemon (including runs whose
  // browser tab is long gone) flows through reconcileAssistantMessageOnRunEnd,
  // which fires this hook after the terminal message-status update.
  projectGroupDispatchHook.current = (turn) => {
    if (!turn.projectId || !turn.conversationId || !turn.assistantMessageId) return;
    void continueGroupDispatchAfterTurn({
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
      runId: turn.runId ?? null,
      finalStatus: turn.finalStatus,
    }).catch((error: any) => {
      console.warn('[group-dispatch] terminal-turn continuation failed', error);
    });
  };

  async function startNextGroupTask(projectId: string, conversationId: string): Promise<void> {
    if (ctx.lifecycle.isDaemonShuttingDown()) return;
    const conversationKey = groupTaskConversationKey(projectId, conversationId);
    if (runningGroupTaskConversations.has(conversationKey)) return;
    const claimToken = randomId();
    const task = claimNextProjectGroupTask(db, {
      projectId,
      conversationId,
      workerId: groupTaskWorkerId,
      workerPid: process.pid,
      claimToken,
      leaseMs: GROUP_TASK_LEASE_MS,
    });
    if (!task) return;
    runningGroupTaskConversations.add(conversationKey);
    try {
      const project = getProject(db, task.projectId);
      const conversation = getConversation(db, task.conversationId);
      if (!project || !conversation || conversation.projectId !== task.projectId) {
        throw new Error('group task project or conversation no longer exists');
      }
      // Queued member runs get the same roster header + member-attributed
      // transcript a web-streamed run gets, so a relayed agent knows its
      // teammates, its own remit, and the handoff grammar.
      const groupContext = await groupTaskRunContext(project, conversation, task.memberRef)
        .catch((error: any) => {
          console.warn('[group-task] group context resolution failed', error);
          return null;
        });
      // Refresh the producedFiles diff baseline at claim time. The
      // enqueue-time snapshot predates every task queued ahead of this one in
      // the same conversation (multi-target fan-out/relay enqueues share one
      // instant), so keeping it would credit this member with every file
      // those earlier runs produced. On listing failure the enqueue-time
      // baseline stays. A second, authoritative refresh happens after the run
      // acquires the project write lock (see onProjectWriteLockAcquired
      // below), which also covers files written by a concurrent run in
      // ANOTHER conversation of this project while we waited for the lock.
      const startFileSnapshot = await snapshotProjectFiles(project);
      // The dispatch turn's user-attached files (fan-out stubs copy them from
      // the source dispatch) ride into the run as project-relative paths, so
      // the queued member gets the same safe-resolved `@path` references a
      // web-streamed dispatch turn gets.
      const stubMessage = listMessages(db, task.conversationId)
        .find((candidate: any) => candidate.id === task.userMessageId);
      const stubAttachmentPaths: string[] = Array.isArray(stubMessage?.attachments)
        ? stubMessage.attachments
            .map((attachment: unknown) => {
              if (typeof attachment === 'string') return attachment.trim();
              const path = (attachment as { path?: unknown } | null)?.path;
              return typeof path === 'string' ? path.trim() : '';
            })
            .filter((path: string) => path.length > 0)
        : [];
      const meta = {
        agentId: 'matos',
        model: task.memberRef,
        projectId: task.projectId,
        conversationId: task.conversationId,
        userMessageId: task.userMessageId,
        assistantMessageId: task.assistantMessageId,
        clientRequestId: task.id,
        sessionMode: normalizeChatSessionMode(conversation.sessionMode),
        message: boundedGroupTaskTranscript(
          task.conversationId,
          new Set([task.userMessageId, task.assistantMessageId]),
          groupContext,
        ),
        currentPrompt: task.prompt,
        ...(stubAttachmentPaths.length > 0 ? { attachments: stubAttachmentPaths } : {}),
        projectMetadata: project.metadata,
      };
      const run = ctx.design.runs.create(meta);
      pinAssistantMessageOnRunCreate(db, run);
      const startedTask = db.transaction(() => {
        const started = updateProjectGroupTask(db, task.id, {
          status: 'running',
          runId: run.id,
          expectedClaimToken: claimToken,
        });
        if (!started) return null;
        db.prepare(
          `UPDATE messages
              SET run_id = ?, run_status = 'running', started_at = COALESCE(started_at, ?)
            WHERE id = ?`,
        ).run(run.id, Date.now(), task.assistantMessageId);
        if (startFileSnapshot) {
          db.prepare(`UPDATE messages SET pre_turn_files_json = ? WHERE id = ?`)
            .run(JSON.stringify(startFileSnapshot), task.assistantMessageId);
        }
        enqueueProjectGroupTaskOutbox(db, {
          taskId: task.id,
          operation: `status:running:${task.attempt}`,
          payload: { status: 'running', runId: run.id },
        });
        return started;
      })();
      if (!startedTask) throw new Error('group task claim was lost before run start');
      scheduleAuthorityOutboxFlush();
      reconcileAssistantMessageOnRunEnd(db, ctx.design.runs, run);
      run.onChildPid = (pid: number) =>
        attachProjectGroupTaskChild(db, task.id, claimToken, pid);
      // Authoritative producedFiles baseline: startChatRun fires this after
      // the run holds the project write lock, i.e. after every earlier
      // project run (including ones in OTHER conversations this task waited
      // behind) finished writing. The claim-time snapshot above remains the
      // fallback when this listing fails or the lock path is skipped.
      run.onProjectWriteLockAcquired = async () => {
        const lockedSnapshot = await snapshotProjectFiles(project);
        if (!lockedSnapshot) return;
        db.prepare(`UPDATE messages SET pre_turn_files_json = ? WHERE id = ?`)
          .run(JSON.stringify(lockedSnapshot), task.assistantMessageId);
      };
      ctx.design.runs.start(run, () => startChatRun(meta, run));
      const childCaptureTimer = setInterval(() => {
        if (Number.isInteger(Number(run.childPid)) && Number(run.childPid) > 0) {
          attachProjectGroupTaskChild(db, task.id, claimToken, Number(run.childPid));
          clearInterval(childCaptureTimer);
        }
      }, 100);
      childCaptureTimer.unref?.();
      const leaseTimer = setInterval(() => {
        renewProjectGroupTaskLease(db, task.id, claimToken, GROUP_TASK_LEASE_MS);
        if (Number.isInteger(Number(run.childPid)) && Number(run.childPid) > 0) {
          attachProjectGroupTaskChild(db, task.id, claimToken, Number(run.childPid));
        }
      }, Math.floor(GROUP_TASK_LEASE_MS / 3));
      leaseTimer.unref?.();
      void ctx.design.runs.wait(run).then(async (finalStatus: any) => {
        const status = finalStatus.status === 'succeeded'
          ? 'succeeded'
          : finalStatus.status === 'canceled'
            ? 'canceled'
            : 'failed';
        const completedBefore = listMessages(db, task.conversationId)
          .find((message: any) => message.id === task.assistantMessageId);
        const producedFiles = producedProjectFilesFromSnapshots(
          completedBefore?.preTurnFileSnapshot,
          await snapshotProjectFiles(project),
        );
        const finalized = db.transaction(() => {
          const terminalTask = updateProjectGroupTask(db, task.id, {
            status,
            runId: run.id,
            error: status === 'failed' ? String(finalStatus.error ?? 'agent run failed') : null,
            expectedClaimToken: claimToken,
          });
          if (!terminalTask) return false;
          if (producedFiles) {
            db.prepare(`UPDATE messages SET produced_files_json = ? WHERE id = ?`)
              .run(JSON.stringify(producedFiles), task.assistantMessageId);
          }
          const completed = listMessages(db, task.conversationId)
            .find((message: any) => message.id === task.assistantMessageId);
          if (completed) {
            const mirror = mirrorGroupTaskToMemberDm(
              {
                db,
                randomId,
                getProject,
                listConversations,
                insertConversation,
                listMessages,
                upsertMessage,
              },
              {
                projectId: task.projectId,
                conversation: getConversation(db, task.conversationId),
                message: completed,
              },
            );
            if (mirror?.createdDm) {
              enqueueProjectGroupTaskOutbox(db, {
                taskId: task.id,
                operation: `conversation-sync:${mirror.dmConversationId}`,
                payload: { conversationId: mirror.dmConversationId },
              });
            }
            enqueueProjectGroupTaskOutbox(db, {
              taskId: task.id,
              operation: `timeline:assistant:${task.attempt}`,
              payload: { messageId: task.assistantMessageId },
            });
          }
          enqueueProjectGroupTaskOutbox(db, {
            taskId: task.id,
            operation: `status:${status}:${task.attempt}`,
            payload: {
              status,
              runId: run.id,
              error: status === 'failed' ? String(finalStatus.error ?? 'agent run failed') : null,
            },
          });
          return true;
        })();
        if (!finalized) return;
        await flushAuthorityOutbox(task.id);
        // Daemon-owned chain continuation: a finished queued turn may itself
        // end with "@NAME: task" handoff lines. Idempotent with the reconcile
        // hook and the PUT-finalize path (deterministic dispatch keys).
        await continueGroupDispatchAfterTurn({
          projectId: task.projectId,
          conversationId: task.conversationId,
          assistantMessageId: task.assistantMessageId,
          runId: run.id,
          finalStatus: status,
        }).catch((dispatchError: any) => {
          console.warn('[group-dispatch] durable-task continuation failed', dispatchError);
        });
      }).catch(async (error: any) => {
        let failed: ProjectGroupTaskRecord | null = null;
        try {
          failed = db.transaction(() => {
            const updated = updateProjectGroupTask(db, task.id, {
              status: 'failed',
              runId: run.id,
              error: String(error?.message ?? error),
              expectedClaimToken: claimToken,
            });
            if (updated?.status === 'failed') {
              enqueueProjectGroupTaskOutbox(db, {
                taskId: task.id,
                operation: `status:failed:${task.attempt}`,
                payload: { status: 'failed', runId: run.id, error: updated.error },
              });
            }
            return updated;
          })();
        } catch (transitionError) {
          console.warn('[group-task] failed to record task runner error', transitionError);
        }
        if (failed?.status === 'failed') {
          scheduleAuthorityOutboxFlush();
        }
      }).finally(() => {
        run.onChildPid = null;
        run.onProjectWriteLockAcquired = null;
        clearInterval(childCaptureTimer);
        clearInterval(leaseTimer);
        runningGroupTaskConversations.delete(conversationKey);
        scheduleNextGroupTask(projectId, conversationId);
      });
    } catch (error: any) {
      const project = getProject(db, task.projectId);
      let failed: ProjectGroupTaskRecord | null = null;
      try {
        failed = db.transaction(() => {
          const updated = updateProjectGroupTask(db, task.id, {
            status: 'failed',
            error: String(error?.message ?? error),
            expectedClaimToken: claimToken,
          });
          if (updated?.status === 'failed') {
            db.prepare(
              `UPDATE messages SET run_status = 'failed', ended_at = ? WHERE id = ?`,
            ).run(Date.now(), task.assistantMessageId);
          }
          if (project && updated?.status === 'failed') {
            enqueueProjectGroupTaskOutbox(db, {
              taskId: task.id,
              operation: `status:failed:${task.attempt}`,
              payload: { status: 'failed', error: updated.error },
            });
          }
          return updated;
        })();
      } catch (transitionError) {
        console.warn('[group-task] failed to record startup error', transitionError);
      }
      if (project && failed?.status === 'failed') {
        scheduleAuthorityOutboxFlush();
      }
      runningGroupTaskConversations.delete(conversationKey);
      scheduleNextGroupTask(projectId, conversationId);
    }
  }

  async function recoverProjectGroupTasks(): Promise<void> {
    if (groupTaskRecoveryRunning || ctx.lifecycle.isDaemonShuttingDown()) return;
    groupTaskRecoveryRunning = true;
    try {
      await flushAuthorityOutbox();
      const recoverable = listRecoverableProjectGroupTasks(db);
      for (const task of recoverable) {
        if (task.status === 'running') {
          const leaseIsFresh = task.leaseExpiresAt !== null && task.leaseExpiresAt > Date.now();
          const trackedLocally = runningGroupTaskConversations.has(
            groupTaskConversationKey(task.projectId, task.conversationId),
          );
          if (task.workerId === groupTaskWorkerId && trackedLocally && leaseIsFresh) {
            continue;
          }
          if (leaseIsFresh && task.workerPid && pidAlive(task.workerPid)) {
            continue;
          }
          const terminated = await terminateOrphan(task.childPid);
          if (!terminated) {
            db.transaction(() => {
              const failed = updateProjectGroupTask(db, task.id, {
                status: 'failed',
                runId: task.runId,
                error: 'daemon restart could not terminate the orphaned agent process',
                ...(task.claimToken ? { expectedClaimToken: task.claimToken } : {}),
              });
              if (!failed) return;
              db.prepare(
                `UPDATE messages SET run_status = 'failed', ended_at = ? WHERE id = ?`,
              ).run(Date.now(), task.assistantMessageId);
              enqueueProjectGroupTaskOutbox(db, {
                taskId: task.id,
                operation: `status:failed:${task.attempt}`,
                payload: { status: 'failed', runId: failed.runId, error: failed.error },
              });
            })();
            continue;
          }
          db.transaction(() => {
            const requeued = updateProjectGroupTask(db, task.id, {
              status: 'queued',
              runId: null,
              error: 'daemon restarted before the prior run reached a terminal state',
              ...(task.claimToken ? { expectedClaimToken: task.claimToken } : {}),
            });
            if (!requeued) return;
            db.prepare(
              `UPDATE messages
                  SET run_id = NULL, run_status = 'queued', started_at = NULL, ended_at = NULL
                WHERE id = ?`,
            ).run(task.assistantMessageId);
            enqueueProjectGroupTaskOutbox(db, {
              taskId: task.id,
              operation: `status:queued:${task.attempt}`,
              payload: {
                status: 'queued',
                runId: null,
                error: 'daemon restarted before the prior run reached a terminal state',
              },
            });
          })();
        }
      }
      scheduleAuthorityOutboxFlush();
      for (const task of listRecoverableProjectGroupTasks(db)) {
        scheduleNextGroupTask(task.projectId, task.conversationId);
      }
    } finally {
      groupTaskRecoveryRunning = false;
    }
  }

  const runProjectGroupTaskRecovery = () => {
    void recoverProjectGroupTasks().catch((error: any) => {
      console.warn('[group-task] durable recovery sweep failed', error);
    });
  };

  // A daemon restart loses in-memory run objects. Requeue interrupted group
  // tasks from the durable ledger, then keep sweeping expired foreign leases
  // so an old daemon that dies after this process starts cannot strand work.
  setTimeout(runProjectGroupTaskRecovery, 0);
  const groupTaskRecoveryTimer = setInterval(
    runProjectGroupTaskRecovery,
    Math.floor(GROUP_TASK_LEASE_MS / 2),
  );
  groupTaskRecoveryTimer.unref?.();

  // ---- Conversations --------------------------------------------------------

  app.get('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ conversations: listConversations(db, req.params.id) });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conversation = getConversation(db, req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({ conversation });
  });

  app.post('/api/projects/:id/conversations', async (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { title, seedFromConversationId, forkAfterMessageId } = req.body || {};
    const hasRequestedRoleRef = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'roleRef'),
    );
    const hasRequestedMemberRefs = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'memberRefs'),
    );
    const requestedRoleRef = typeof req.body?.roleRef === 'string'
      ? req.body.roleRef.trim()
      : '';
    const requestedMemberRefs: string[] = Array.isArray(req.body?.memberRefs)
      ? (req.body.memberRefs as unknown[]).filter(
          (value: unknown): value is string => typeof value === 'string',
        )
      : [];
    let allowedMemberRefs: string[];
    try {
      allowedMemberRefs = await projectMemberRefs(project);
    } catch (error: any) {
      return res.status(409).json({ error: String(error?.message ?? error) });
    }
    const allowedMembers = new Map(
      allowedMemberRefs.map(roleRef => [roleIdentity(roleRef), roleRef]),
    );
    const requestedRoles = [...new Set([
      ...(requestedRoleRef ? [requestedRoleRef] : []),
      ...requestedMemberRefs,
    ].map(roleIdentity))];
    if (requestedRoles.some(roleRef => !allowedMembers.has(roleRef))) {
      return res.status(400).json({ error: 'conversation roster must be a subset of project members' });
    }
    const canonicalRoleRef = requestedRoleRef
      ? allowedMembers.get(roleIdentity(requestedRoleRef)) ?? requestedRoleRef
      : '';
    const canonicalMemberRefs = [...new Set(requestedMemberRefs.map((roleRef: string) =>
      allowedMembers.get(roleIdentity(roleRef)) ?? roleRef,
    ))];
    if (
      canonicalRoleRef &&
      canonicalMemberRefs.length > 0 &&
      !canonicalMemberRefs.some(roleRef => roleIdentity(roleRef) === roleIdentity(canonicalRoleRef))
    ) {
      canonicalMemberRefs.unshift(canonicalRoleRef);
    }
    if (
      canonicalMemberRefs.length > 1 &&
      !seedFromConversationId &&
      !forkAfterMessageId
    ) {
      const requestedRoster = new Set(canonicalMemberRefs.map(roleIdentity));
      const existingGroup = listConversations(db, req.params.id).find((conversation: any) => {
        const memberRefs: string[] = Array.isArray(conversation.memberRefs)
          ? (conversation.memberRefs as unknown[]).filter(
              (value: unknown): value is string => typeof value === 'string',
            )
          : [];
        if (memberRefs.length <= 1) return false;
        const existingRoster = new Set(memberRefs.map(roleIdentity));
        if (existingRoster.size !== requestedRoster.size) return false;
        for (const roleRef of existingRoster) {
          if (!requestedRoster.has(roleRef)) return false;
        }
        return true;
      });
      if (existingGroup) {
        return res.json({ conversation: existingGroup, canonical: true });
      }
    }
    if (
      canonicalRoleRef &&
      !seedFromConversationId &&
      !forkAfterMessageId &&
      canonicalMemberRefs.length <= 1
    ) {
      const existingDm = listConversations(db, req.params.id).find((conversation: any) =>
        typeof conversation.roleRef === 'string' &&
        roleIdentity(conversation.roleRef) === roleIdentity(canonicalRoleRef) &&
        !(Array.isArray(conversation.memberRefs) && conversation.memberRefs.length > 1),
      );
      if (existingDm) {
        return res.json({ conversation: existingDm, canonical: true });
      }
    }
    const now = Date.now();
    const hasExplicitSessionMode = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'sessionMode'),
    );
    const requestedForkMessageId =
      typeof forkAfterMessageId === 'string' && forkAfterMessageId
        ? forkAfterMessageId
        : null;
    const sourceConversation =
      typeof seedFromConversationId === 'string' && seedFromConversationId
        ? getConversation(db, seedFromConversationId)
        : null;
    const localSourceConversation = sourceConversation?.projectId === req.params.id
      ? sourceConversation
      : null;
    const inheritedRoleRef = !hasRequestedRoleRef && typeof localSourceConversation?.roleRef === 'string'
      ? localSourceConversation.roleRef
      : '';
    const inheritedMemberRefs: string[] = !hasRequestedMemberRefs && Array.isArray(localSourceConversation?.memberRefs)
      ? localSourceConversation.memberRefs.filter(
          (value: unknown): value is string => typeof value === 'string',
        )
      : [];
    const conversationRoleRef = canonicalRoleRef || (
      inheritedRoleRef ? allowedMembers.get(roleIdentity(inheritedRoleRef)) ?? '' : ''
    );
    if (inheritedRoleRef && !conversationRoleRef) {
      return res.status(409).json({ error: 'source conversation role is no longer a project member' });
    }
    const conversationMemberRefs: string[] = canonicalMemberRefs.length > 0 || hasRequestedMemberRefs
      ? [...canonicalMemberRefs]
      : [...new Set<string>(inheritedMemberRefs.map((roleRef: string) =>
          allowedMembers.get(roleIdentity(roleRef)) ?? '',
        ).filter((roleRef: string) => Boolean(roleRef)))];
    if (inheritedMemberRefs.length > 0 && conversationMemberRefs.length !== new Set(
      inheritedMemberRefs.map(roleIdentity),
    ).size) {
      return res.status(409).json({ error: 'source conversation roster is no longer in the project' });
    }
    if (
      conversationRoleRef &&
      conversationMemberRefs.length > 0 &&
      !conversationMemberRefs.some((roleRef: string) =>
        roleIdentity(roleRef) === roleIdentity(conversationRoleRef))
    ) {
      conversationMemberRefs.unshift(conversationRoleRef);
    }
    // Client-supplied fork snapshot. The chat "Fork" action sends the exact
    // messages the user is looking at (up to the fork point). We prefer it over
    // reading the source conversation from the DB so a fork point that was
    // never persisted — e.g. an assistant turn whose run errored / had its
    // connection reset before reaching the database — still forks instead of
    // 404ing on `forkAfterMessageId`.
    const clientSeedMessages = Array.isArray(req.body?.seedMessages)
      ? req.body.seedMessages as any[]
      : null;
    if (clientSeedMessages && !localSourceConversation) {
      return res.status(404).json({ error: 'fork source conversation not found' });
    }
    let seedMessages: any[] = [];
    if (clientSeedMessages && clientSeedMessages.length > 0) {
      seedMessages = clientSeedMessages;
      if (requestedForkMessageId) {
        const forkIndex = seedMessages.findIndex(
          (message) => message.id === requestedForkMessageId,
        );
        if (forkIndex >= 0) {
          seedMessages = seedMessages.slice(0, forkIndex + 1);
        }
      }
    } else if (localSourceConversation) {
      seedMessages = listMessages(db, seedFromConversationId);
      if (requestedForkMessageId) {
        const forkIndex = seedMessages.findIndex((message) => message.id === requestedForkMessageId);
        if (forkIndex < 0) {
          return res.status(404).json({ error: 'fork message not found' });
        }
        seedMessages = seedMessages.slice(0, forkIndex + 1);
      }
    } else if (requestedForkMessageId) {
      return res.status(404).json({ error: 'fork source conversation not found' });
    }
    if (seedMessages.length > 500) {
      return res.status(413).json({ error: 'fork snapshot exceeds 500 messages' });
    }
    let seedContentBytes = 0;
    const normalizedSeedMessages: any[] = [];
    for (const message of seedMessages) {
      const role = typeof message?.role === 'string' ? message.role : '';
      const content = typeof message?.content === 'string' ? message.content : '';
      if (!['user', 'assistant', 'system'].includes(role)) {
        return res.status(400).json({ error: 'fork snapshot contains an invalid message role' });
      }
      seedContentBytes += Buffer.byteLength(content, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > 1_000_000 || seedContentBytes > 4_000_000) {
        return res.status(413).json({ error: 'fork snapshot content is too large' });
      }
      let seedRoleRef = '';
      if (role === 'assistant') {
        const requestedSeedRole = typeof message.roleRef === 'string'
          ? message.roleRef.trim()
          : conversationRoleRef || (
              conversationMemberRefs.length === 1
                ? conversationMemberRefs[0]!
                : allowedMemberRefs.length === 1
                  ? allowedMemberRefs[0]!
                  : ''
            );
        seedRoleRef = requestedSeedRole
          ? allowedMembers.get(roleIdentity(requestedSeedRole)) ?? ''
          : '';
        if (!seedRoleRef) {
          return res.status(400).json({ error: 'fork snapshot assistant role is not a project member' });
        }
        if (
          conversationMemberRefs.length > 0 &&
          !conversationMemberRefs.some((roleRef: string) =>
            roleIdentity(roleRef) === roleIdentity(seedRoleRef))
        ) {
          return res.status(400).json({ error: 'fork snapshot assistant role is not in the conversation' });
        }
      }
      normalizedSeedMessages.push({
        ...message,
        role,
        content,
        roleRef: seedRoleRef || undefined,
      });
    }
    seedMessages = normalizedSeedMessages;
    const sessionMode =
      hasExplicitSessionMode
        ? normalizeChatSessionMode(req.body.sessionMode)
        : localSourceConversation
          ? normalizeChatSessionMode(localSourceConversation.sessionMode)
          : 'design';
    const conv = insertConversation(db, {
      id: randomId(),
      projectId: req.params.id,
      title: typeof title === 'string' ? title.trim() || null : null,
      sessionMode,
      // MatOS member DM: bind the conversation to a role at creation so every
      // run in it executes with that role. Validated/normalized in the store.
      roleRef: conversationRoleRef || null,
      // MatOS group chat: seed the member roster (validated/normalized in the
      // store, which drops anything that is not a well-formed `role:<id>`).
      memberRefs: conversationMemberRefs.length > 0 ? conversationMemberRefs : null,
      groupAutoRelay: typeof req.body?.groupAutoRelay === 'boolean' ? req.body.groupAutoRelay : undefined,
      createdAt: now,
      updatedAt: now,
    });
    // Side Chat: inherit the source conversation's context by copying its
    // messages into the fresh conversation. Be defensive — a missing or
    // cross-project source id silently yields an empty conversation.
    if (conv && seedMessages.length > 0) {
      for (const m of seedMessages) {
        // Fresh id per copied message; upsertMessage assigns the next
        // position so role/content ordering is preserved. Drop the source's
        // run pointers (runId/runStatus/lastRunEventId): they belong to the
        // OTHER conversation's runs, and a copied still-`running` assistant
        // turn would otherwise render a perpetual spinner in the side chat.
        upsertMessage(db, conv.id, {
          ...m,
          id: randomId(),
          runId: undefined,
          runStatus: undefined,
          lastRunEventId: undefined,
        });
      }
    }
    try {
      await syncConversationAuthority(project, () => listConversations(db, req.params.id));
    } catch (error: any) {
      if (conv) deleteConversation(db, conv.id);
      await syncConversationAuthority(project, () => listConversations(db, req.params.id))
        .catch((rollbackError: any) => {
          console.warn('[project-timeline] conversation create rollback sync failed', rollbackError);
        });
      console.warn('[project-timeline] conversation create sync failed', error);
      return res.status(502).json({ error: 'native MatOS conversation sync failed' });
    }
    res.json({ conversation: conv });
  });

  app.patch('/api/projects/:id/conversations/:cid', async (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    let allowedMemberRefs: string[];
    try {
      allowedMemberRefs = await projectMemberRefs(project);
    } catch (error: any) {
      return res.status(409).json({ error: String(error?.message ?? error) });
    }
    const allowedMembers = new Map(
      allowedMemberRefs.map(roleRef => [roleIdentity(roleRef), roleRef]),
    );
    const patch: Record<string, any> = { ...(req.body || {}) };
    if (Object.prototype.hasOwnProperty.call(patch, 'groupAutoRelay')) {
      // null resets to the "unset -> enabled" default.
      if (patch.groupAutoRelay !== null && typeof patch.groupAutoRelay !== 'boolean') {
        return res.status(400).json({ error: 'conversation groupAutoRelay must be a boolean or null' });
      }
      if (patch.groupAutoRelay === null) patch.groupAutoRelay = undefined;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'roleRef')) {
      const requested = typeof patch.roleRef === 'string' ? patch.roleRef.trim() : '';
      if (requested && !allowedMembers.has(roleIdentity(requested))) {
        return res.status(400).json({ error: 'conversation role must be a project member' });
      }
      patch.roleRef = requested
        ? allowedMembers.get(roleIdentity(requested))
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'memberRefs')) {
      if (patch.memberRefs !== null && !Array.isArray(patch.memberRefs)) {
        return res.status(400).json({ error: 'conversation memberRefs must be an array or null' });
      }
      const requested: string[] = Array.isArray(patch.memberRefs)
        ? patch.memberRefs.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      if (requested.length !== (Array.isArray(patch.memberRefs) ? patch.memberRefs.length : 0)) {
        return res.status(400).json({ error: 'conversation memberRefs must contain role refs' });
      }
      if (requested.some(roleRef => !allowedMembers.has(roleIdentity(roleRef)))) {
        return res.status(400).json({ error: 'conversation roster must be a subset of project members' });
      }
      patch.memberRefs = [...new Set(requested.map(roleRef =>
        allowedMembers.get(roleIdentity(roleRef))!,
      ))];
    }
    const effectiveRoleRef = Object.prototype.hasOwnProperty.call(patch, 'roleRef')
      ? patch.roleRef
      : conv.roleRef;
    const effectiveMemberRefs = Object.prototype.hasOwnProperty.call(patch, 'memberRefs')
      ? patch.memberRefs
      : conv.memberRefs;
    if (
      typeof effectiveRoleRef === 'string' &&
      Array.isArray(effectiveMemberRefs) &&
      effectiveMemberRefs.length > 0 &&
      !effectiveMemberRefs.some(roleRef => roleIdentity(roleRef) === roleIdentity(effectiveRoleRef))
    ) {
      patch.memberRefs = [effectiveRoleRef, ...effectiveMemberRefs];
    }
    const updated = updateConversation(db, req.params.cid, patch);
    try {
      await syncConversationAuthority(project, () => listConversations(db, req.params.id));
    } catch (error: any) {
      updateConversation(db, req.params.cid, conv);
      await syncConversationAuthority(project, () => listConversations(db, req.params.id))
        .catch((rollbackError: any) => {
          console.warn('[project-timeline] conversation patch rollback sync failed', rollbackError);
        });
      console.warn('[project-timeline] conversation patch sync failed', error);
      return res.status(502).json({ error: 'native MatOS conversation sync failed' });
    }
    res.json({ conversation: updated });
  });

  app.delete('/api/projects/:id/conversations/:cid', async (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    try {
      await syncConversationAuthority(
        project,
        () => listConversations(db, req.params.id)
          .filter((conversation: any) => conversation.id !== req.params.cid),
        () => deleteConversation(db, req.params.cid),
      );
    } catch (error: any) {
      console.warn('[project-timeline] conversation delete sync failed', error);
      return res.status(502).json({ error: 'native MatOS conversation sync failed' });
    }
    res.json({ ok: true });
  });

  app.get('/api/projects/:id/group-tasks', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const conversationId = typeof req.query.conversationId === 'string'
      ? req.query.conversationId
      : undefined;
    res.json({
      tasks: listProjectGroupTasks(db, {
        projectId: req.params.id,
        ...(conversationId ? { conversationId } : {}),
      }),
    });
  });

  app.get('/api/projects/:id/group-tasks/:taskId', (req, res) => {
    const task = getProjectGroupTask(db, req.params.taskId);
    if (!task || task.projectId !== req.params.id) {
      return res.status(404).json({ error: 'group task not found' });
    }
    res.json({ task });
  });

  app.post('/api/projects/:id/group-tasks', async (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const conversationId = typeof req.body?.conversationId === 'string'
      ? req.body.conversationId.trim()
      : '';
    const requestedMemberRef = typeof req.body?.memberRef === 'string'
      ? req.body.memberRef.trim()
      : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!conversationId || !requestedMemberRef || !prompt) {
      return res.status(400).json({ error: 'conversationId, memberRef, and prompt are required' });
    }
    const conversation = getConversation(db, conversationId);
    if (!conversation || conversation.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const result = await enqueueGroupTaskCore({
      project,
      conversation,
      memberRef: requestedMemberRef,
      prompt,
      relayHop: Number.isInteger(Number(req.body?.relayHop)) ? Number(req.body.relayHop) : 0,
      sourceMessageId: typeof req.body?.sourceMessageId === 'string'
        ? req.body.sourceMessageId
        : null,
      clientRequestId: typeof req.body?.clientRequestId === 'string'
        ? req.body.clientRequestId
        : '',
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.status(202).json({
      task: result.task,
      ...(result.idempotent ? { idempotent: true } : {}),
    });
  });

  app.post('/api/projects/:id/group-tasks/:taskId/cancel', async (req, res) => {
    const task = getProjectGroupTask(db, req.params.taskId);
    if (!task || task.projectId !== req.params.id) {
      return res.status(404).json({ error: 'group task not found' });
    }
    if (task.status === 'queued') {
      const project = getProject(db, task.projectId);
      const canceled = db.transaction(() => {
        const updated = updateProjectGroupTask(db, task.id, { status: 'canceled' });
        if (!updated) return null;
        db.prepare(
          `UPDATE messages SET run_status = 'canceled', ended_at = ? WHERE id = ?`,
        ).run(Date.now(), task.assistantMessageId);
        if (project && updated) {
          enqueueProjectGroupTaskOutbox(db, {
            taskId: task.id,
            operation: `status:canceled:${task.attempt}`,
            payload: { status: 'canceled' },
          });
        }
        return updated;
      })();
      if (project && canceled) scheduleAuthorityOutboxFlush();
      if (canceled) return res.json({ task: canceled });
    }
    const latest = getProjectGroupTask(db, task.id);
    const liveRun = latest?.status === 'running' && latest.runId
      ? ctx.design.runs.get(latest.runId)
      : null;
    if (liveRun) {
      await ctx.design.runs.cancel(liveRun);
    } else if (latest?.status === 'running' && latest.claimToken) {
      if (!await terminateOrphan(latest.childPid)) {
        return res.status(409).json({ error: 'running agent process could not be terminated' });
      }
      const project = getProject(db, latest.projectId);
      const canceled = db.transaction(() => {
        const updated = updateProjectGroupTask(db, latest.id, {
          status: 'canceled',
          expectedClaimToken: latest.claimToken!,
        });
        if (!updated) return null;
        db.prepare(
          `UPDATE messages SET run_status = 'canceled', ended_at = ? WHERE id = ?`,
        ).run(Date.now(), latest.assistantMessageId);
        if (project) {
          enqueueProjectGroupTaskOutbox(db, {
            taskId: latest.id,
            operation: `status:canceled:${latest.attempt}`,
            payload: { status: 'canceled' },
          });
        }
        return updated;
      })();
      if (project && canceled) scheduleAuthorityOutboxFlush();
      if (canceled) return res.json({ task: canceled });
    }
    return res.json({ task: getProjectGroupTask(db, task.id) });
  });

  // ---- Messages -------------------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/messages', async (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const project = getProject(db, req.params.id);
    const chatView = req.query.view === 'chat';
    const pageSize = chatView && req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200)) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
    }
    if (before && pageSize === undefined) return res.status(400).json({ error: 'before requires limit' });
    const readChat = () => listMessagesForChat(db, req.params.cid,
      pageSize === undefined ? undefined : { limit: pageSize + 1, before });
    let messages = chatView
      ? readChat()
      : listMessages(db, req.params.cid);
    if (project && chatView && !before) {
      const timelineImport = scheduleProjectTimelineImport(
        project,
        req.params.cid,
        { force: messages.length === 0 },
      );
      if (messages.length === 0) {
        await Promise.race([timelineImport, delay(1_500)]);
        messages = readChat();
      }
    } else if (project && !chatView) {
      try {
        await importProjectTimelineMessages(project, req.params.cid);
        messages = listMessages(db, req.params.cid);
      } catch (error: any) {
        console.warn('[project-timeline] native timeline import failed', error);
        return res.status(502).json({ error: 'native MatOS project timeline is unavailable' });
      }
    }
    if (pageSize !== undefined) {
      const hasMore = messages.length > pageSize;
      messages = messages.slice(-pageSize);
      return res.json({ messages, nextBefore: hasMore ? messages[0]?.id ?? null : null });
    }
    res.json({ messages });
  });

  app.put('/api/projects/:id/conversations/:cid/messages/:mid', async (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const m = req.body || {};
    if (m.id && m.id !== req.params.mid) {
      return res.status(400).json({ error: 'id mismatch' });
    }
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const current = db.prepare(
      `SELECT conversation_id AS conversationId, role, role_ref AS roleRef
         FROM messages WHERE id = ?`,
    ).get(req.params.mid) as {
      conversationId?: string;
      role?: string;
      roleRef?: string;
    } | undefined;
    if (current && current.conversationId !== req.params.cid) {
      return res.status(409).json({ error: 'message id already belongs to another conversation' });
    }
    const messageRole = typeof m.role === 'string'
      ? m.role
      : typeof current?.role === 'string'
        ? current.role
        : '';
    if (current?.role && m.role && current.role !== m.role) {
      return res.status(400).json({ error: 'message role cannot be changed' });
    }
    if (!['user', 'assistant', 'system'].includes(messageRole)) {
      return res.status(400).json({ error: 'message role must be user, assistant, or system' });
    }
    let effectiveRoleRef = typeof m.roleRef === 'string'
      ? m.roleRef.trim()
      : typeof current?.roleRef === 'string'
        ? current.roleRef.trim()
        : '';
    const conversationMemberRefs = Array.isArray(conv.memberRefs)
      ? conv.memberRefs.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    let projectMembers: string[] | null = null;
    if (messageRole === 'assistant' && !effectiveRoleRef) {
      if (typeof conv.roleRef === 'string' && conv.roleRef.trim()) {
        effectiveRoleRef = conv.roleRef.trim();
      } else if (conversationMemberRefs.length === 1) {
        effectiveRoleRef = conversationMemberRefs[0]!;
      } else {
        try {
          projectMembers = await projectMemberRefs(project);
        } catch (error: any) {
          return res.status(409).json({ error: String(error?.message ?? error) });
        }
        if (projectMembers.length === 1) {
          effectiveRoleRef = projectMembers[0]!;
        } else {
          return res.status(400).json({ error: 'assistant message role is required for a multi-member project' });
        }
      }
    }
    let canonicalRoleRef = effectiveRoleRef;
    if (effectiveRoleRef) {
      try {
        projectMembers ??= await projectMemberRefs(project);
      } catch (error: any) {
        return res.status(409).json({ error: String(error?.message ?? error) });
      }
      canonicalRoleRef = projectMembers.find(roleRef =>
        roleIdentity(roleRef) === roleIdentity(effectiveRoleRef)) ?? '';
      if (!canonicalRoleRef) {
        return res.status(400).json({ error: 'message role must be a project member' });
      }
      if (
        typeof conv.roleRef === 'string' &&
        roleIdentity(conv.roleRef) !== roleIdentity(canonicalRoleRef)
      ) {
        return res.status(400).json({ error: 'message role does not match this member conversation' });
      }
      if (
        conversationMemberRefs.length > 0 &&
        !conversationMemberRefs.some((roleRef: string) =>
          roleIdentity(roleRef) === roleIdentity(canonicalRoleRef))
      ) {
        return res.status(400).json({ error: 'message role is not in this group conversation' });
      }
    }
    const messagePatch = {
      ...m,
      ...(canonicalRoleRef ? { roleRef: canonicalRoleRef } : {}),
    };
    let finalized: { saved: any; groupTaskMirror: GroupTaskMirrorResult | null };
    try {
      finalized = db.transaction(() => {
        const saved = upsertMessage(db, req.params.cid, {
          ...messagePatch,
          id: req.params.mid,
        });
        if (saved && shouldPersistMessageToProjectTimeline(saved)) {
          enqueueProjectMessageAuthorityOutbox(db, {
            messageId: String(saved.id),
            projectId: req.params.id,
            conversationId: req.params.cid,
          });
        }
        // Bump the parent project's updatedAt so the project list re-orders.
        updateProject(db, req.params.id, {});
        const groupTaskMirror = saved
          ? mirrorGroupTaskToMemberDm(
            {
              db,
              randomId,
              getProject,
              listConversations,
              insertConversation,
              listMessages,
              upsertMessage,
            },
            { projectId: req.params.id, conversation: conv, message: saved },
          )
          : null;
        return { saved, groupTaskMirror };
      })();
    } catch (err: any) {
      if (err?.code === 'EMESSAGECONFLICT') {
        return res.status(409).json({ error: 'message id already belongs to another conversation' });
      }
      console.warn('[group-task] atomic message finalize failed', err);
      return res.status(500).json({ error: 'message finalize failed' });
    }
    const { saved, groupTaskMirror } = finalized;
    scheduleMessageAuthorityOutboxFlush();
    if (groupTaskMirror?.createdDm) {
      const task = findProjectGroupTaskByAssistantMessage(db, String(saved.id));
      if (task) {
        enqueueProjectGroupTaskOutbox(db, {
          taskId: task.id,
          operation: `conversation-sync:${groupTaskMirror.dmConversationId}`,
          payload: { conversationId: groupTaskMirror.dmConversationId },
        });
        scheduleAuthorityOutboxFlush();
      }
      // The response exposes the new DM immediately. Commit its native
      // conversation identity before a client can read that DM's timeline.
      // The durable task outbox remains available if native sync must retry.
      await syncConversationAuthority(project, () => listConversations(db, req.params.id))
        .catch((error: any) => {
          console.warn('[project-timeline] mirrored DM conversation sync failed', error);
        });
    }
    // Daemon-owned group continuation (fan-out + auto-relay) also anchors on
    // the finalize persist: this covers reattached runs a reloaded tab
    // finalizes later and any run whose end the reconcile hook missed (e.g.
    // across a daemon restart). Idempotent with the other continuation
    // callers, and off the response path.
    if (
      saved?.role === 'assistant' &&
      terminalRunStatuses.has(String(saved.runStatus ?? '')) &&
      Array.isArray(conv.memberRefs) &&
      conv.memberRefs.length > 1
    ) {
      void continueGroupDispatchAfterTurn({
        projectId: req.params.id,
        conversationId: req.params.cid,
        assistantMessageId: String(saved.id),
        runId: typeof saved.runId === 'string' ? saved.runId : null,
        finalStatus: String(saved.runStatus),
      }).catch((error: any) => {
        console.warn('[group-dispatch] finalize continuation failed', error);
      });
    }
    // The group message and its DM work-ledger projection were committed in
    // one SQLite transaction above, so neither view can advance alone.
    res.json({
      message: messageForChatResponse(saved),
      ...(groupTaskMirror
        ? {
            groupTaskMirror: {
              conversationId: groupTaskMirror.dmConversationId,
              memberRef: groupTaskMirror.memberRef,
            },
          }
        : {}),
    });
  });

  // Resume durable native-timeline delivery after daemon restarts without
  // delaying route registration or the first browser request.
  scheduleMessageAuthorityOutboxFlush();
  registerProjectCommentRoutes(app, ctx);
}
