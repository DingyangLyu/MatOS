import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// Daemon-owned group chat continuation: after ANY member turn in a group
// conversation reaches a terminal state, the DAEMON (not the browser tab)
// parses the turn and enqueues the follow-up durable tasks:
//   - fan-out  → extra members the user @-mentioned in the dispatch turn
//   - auto-relay → trailing "@NAME: <task>" handoff lines of a succeeded reply
// This suite drives the real PUT message finalize route against the real
// server (real project authority CLI, real task queue) and asserts the queued
// ledger the web client polls. Tasks are canceled as soon as they appear so
// the suite never waits on full agent runs.
describe('daemon-owned group dispatch continuation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as Record<string, any>;
  }

  interface GroupTaskRow {
    id: string;
    status: string;
    memberRef: string;
    relayHop: number;
    clientRequestId?: string | null;
    prompt: string;
  }

  async function listTasks(projectId: string, conversationId: string): Promise<GroupTaskRow[]> {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/group-tasks?conversationId=${encodeURIComponent(conversationId)}`,
    );
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { tasks: GroupTaskRow[] };
    return payload.tasks ?? [];
  }

  async function cancelTask(projectId: string, taskId: string): Promise<void> {
    await fetch(`${baseUrl}/api/projects/${projectId}/group-tasks/${taskId}/cancel`, {
      method: 'POST',
    });
  }

  /** Poll the durable ledger until `predicate` holds, canceling every
   *  non-terminal task each round so no real agent run gets far. */
  async function pollTasks(
    projectId: string,
    conversationId: string,
    predicate: (tasks: GroupTaskRow[]) => boolean,
    deadlineMs: number,
  ): Promise<GroupTaskRow[]> {
    const startedAt = Date.now();
    let tasks: GroupTaskRow[] = [];
    for (;;) {
      tasks = await listTasks(projectId, conversationId);
      for (const task of tasks) {
        if (task.status === 'queued' || task.status === 'running') {
          await cancelTask(projectId, task.id);
        }
      }
      if (predicate(tasks)) return tasks;
      if (Date.now() - startedAt > deadlineMs) return tasks;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    }
  }

  function putMessage(
    projectId: string,
    conversationId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages/${id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id }),
      },
    );
  }

  it(
    'fans out extra user mentions and relays trailing handoffs after a finalized turn',
    async () => {
      const { project } = await postJson('/api/projects', {
        id: `gd-cont-${Date.now().toString(36)}`,
        name: '连续性项目部',
        metadata: {
          kind: 'other',
          members: ['role:compute', 'role:research-scientist'],
          memberNames: {
            'role:compute': '算力老王',
            'role:research-scientist': '学术研究',
          },
        },
      });
      const { conversation: group } = await postJson(
        `/api/projects/${project.id}/conversations`,
        {
          title: '连续性群',
          roleRef: 'role:compute',
          memberRefs: ['role:compute', 'role:research-scientist'],
        },
      );
      const computeRef = (group.memberRefs as string[]).find((ref) =>
        ref.startsWith('role:compute'));
      const academicRef = (group.memberRefs as string[]).find((ref) =>
        ref.startsWith('role:research-scientist'));
      expect(computeRef).toBeTruthy();
      expect(academicRef).toBeTruthy();

      // Real user dispatch turn mentioning BOTH members; compute answers it.
      // The attached input file must follow every fanned-out member, not only
      // the first responder.
      const dispatchAttachments = [
        { path: 'inputs/BaTiO3.cif', name: 'BaTiO3.cif', kind: 'file' },
      ];
      const userPut = await putMessage(project.id, group.id, 'u1', {
        role: 'user',
        content: '@算力老王 跑 BaTiO3 弛豫，@学术研究 查文献做对照',
        roleRef: computeRef,
        attachments: dispatchAttachments,
      });
      expect(userPut.ok).toBe(true);
      // Finalized succeeded reply ending in handoff lines: one to the real
      // teammate, one to a NON-member label (typo/out-of-roster) that must
      // surface as a dispatch notice instead of silently dropping.
      const assistantContent =
        '弛豫已经完成，结果在 relax-results/。\n\n@学术研究: 基于弛豫结果整理文献对照表\n@数据分析: 做误差分析';
      const assistantPut = await putMessage(project.id, group.id, 'a1', {
        role: 'assistant',
        content: assistantContent,
        roleRef: computeRef,
        runStatus: 'succeeded',
        telemetryFinalized: true,
      });
      expect(assistantPut.ok).toBe(true);

      // The daemon continuation runs off the response path; wait for BOTH
      // dispatches: the fan-out for the extra user mention and the relay for
      // the trailing handoff line.
      const fanOutKey = `u1:${academicRef}:0`;
      const relayKey = `a1:${academicRef}:1`;
      const tasks = await pollTasks(
        project.id,
        group.id,
        (rows) =>
          rows.some((task) => task.clientRequestId === fanOutKey) &&
          rows.some((task) => task.clientRequestId === relayKey),
        120_000,
      );
      const fanOut = tasks.find((task) => task.clientRequestId === fanOutKey);
      const relay = tasks.find((task) => task.clientRequestId === relayKey);
      expect(fanOut).toBeTruthy();
      expect(relay).toBeTruthy();
      expect(fanOut!.memberRef).toBe(academicRef);
      expect(fanOut!.relayHop).toBe(0);
      expect(fanOut!.prompt).toContain('@学术研究');
      expect(fanOut!.prompt).toContain('请处理上面用户消息中');
      expect(relay!.memberRef).toBe(academicRef);
      expect(relay!.relayHop).toBe(1);
      // The relay stub carries the handoff line's task text verbatim, so the
      // group log row and the member's DM ledger describe the actual task.
      expect(relay!.prompt).toBe('@学术研究 基于弛豫结果整理文献对照表');

      // Each dispatch also persisted its stub user turn + placeholder into
      // the group log with durable-task provenance.
      const messagesPayload = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${group.id}/messages`)
      ).json()) as { messages: Array<Record<string, any>> };
      const stubUserTurns = messagesPayload.messages.filter(
        (message) => message.role === 'user' && message.groupTask?.taskId,
      );
      expect(stubUserTurns.map((message) => message.groupTask.taskId).sort()).toEqual(
        [fanOut!.id, relay!.id].sort(),
      );
      // The fan-out stub inherits the dispatch turn's attachments (its run and
      // DM ledger row point at the same input file); the relay stub follows an
      // assistant turn, which has none.
      const fanOutStub = stubUserTurns.find(
        (message) => message.groupTask.taskId === fanOut!.id,
      );
      const relayStub = stubUserTurns.find(
        (message) => message.groupTask.taskId === relay!.id,
      );
      expect(fanOutStub!.attachments).toEqual(dispatchAttachments);
      expect(relayStub!.attachments ?? undefined).toBeUndefined();
      // Quote-reply anchors: the fan-out stub quotes the user dispatch turn,
      // the relay stub quotes the teammate reply whose handoff created it —
      // attributed to that member with a bounded excerpt.
      expect(fanOutStub!.replyTo.messageId).toBe('u1');
      expect(fanOutStub!.replyTo.authorName ?? null).toBeNull();
      expect(fanOutStub!.replyTo.excerpt).toContain('@算力老王 跑 BaTiO3 弛豫');
      expect(relayStub!.replyTo.messageId).toBe('a1');
      expect(relayStub!.replyTo.roleRef).toBe(computeRef);
      expect(relayStub!.replyTo.authorName).toBe('算力老王');
      expect(relayStub!.replyTo.excerpt).toContain('弛豫已经完成');

      // Idempotency across racing continuation callers: re-finalizing the
      // same turn (reconcile hook / PUT retry / durable completion all share
      // these deterministic keys) must not enqueue duplicates.
      const repeatPut = await putMessage(project.id, group.id, 'a1', {
        role: 'assistant',
        content: assistantContent,
        roleRef: computeRef,
        runStatus: 'succeeded',
        telemetryFinalized: true,
      });
      expect(repeatPut.ok).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
      const finalTasks = await pollTasks(project.id, group.id, () => true, 0);
      expect(finalTasks).toHaveLength(2);

      // The unknown handoff target surfaced as ONE idempotent system notice
      // in the group log (deterministic gdn-<assistantMessageId> id), so the
      // user learns the "@数据分析" handoff went nowhere.
      const finalMessages = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${group.id}/messages`)
      ).json()) as { messages: Array<Record<string, any>> };
      const notices = finalMessages.messages.filter((message) => message.role === 'system');
      expect(notices).toHaveLength(1);
      expect(notices[0]!.id).toBe('gdn-a1');
      expect(notices[0]!.content).toContain('数据分析');
      expect(notices[0]!.content).toContain('不是本群成员');
      // The dispatched teammate is NOT in the notice — its handoff worked.
      expect(notices[0]!.content).not.toContain('派发 @学术研究 失败');
    },
    180_000,
  );

  it(
    'suppresses auto-relay when the conversation persists groupAutoRelay=false',
    async () => {
      const { project } = await postJson('/api/projects', {
        id: `gd-norelay-${Date.now().toString(36)}`,
        name: '关闭接力项目部',
        metadata: {
          kind: 'other',
          members: ['role:compute', 'role:research-scientist'],
          memberNames: {
            'role:compute': '算力老王',
            'role:research-scientist': '学术研究',
          },
        },
      });
      const { conversation: group } = await postJson(
        `/api/projects/${project.id}/conversations`,
        {
          title: '关闭接力群',
          roleRef: 'role:compute',
          memberRefs: ['role:compute', 'role:research-scientist'],
        },
      );
      const computeRef = (group.memberRefs as string[]).find((ref) =>
        ref.startsWith('role:compute'));

      // The @-bar toggle persists onto the conversation record — that is what
      // the daemon reads at continuation time (the tab may be gone by then).
      const patch = await fetch(
        `${baseUrl}/api/projects/${project.id}/conversations/${group.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupAutoRelay: false }),
        },
      );
      expect(patch.ok).toBe(true);
      const patched = (await patch.json()) as { conversation: { groupAutoRelay?: boolean } };
      expect(patched.conversation.groupAutoRelay).toBe(false);

      // Single mention (the responder itself) → no fan-out; relay disabled →
      // the trailing handoff line must NOT dispatch. Message ids are globally
      // unique across conversations, hence the nr- prefix.
      const userPut = await putMessage(project.id, group.id, 'nr-u1', {
        role: 'user',
        content: '@算力老王 跑一个快速收敛测试',
        roleRef: computeRef,
      });
      expect(userPut.ok).toBe(true);
      const assistantPut = await putMessage(project.id, group.id, 'nr-a1', {
        role: 'assistant',
        content: '测试完成。\n\n@学术研究: 请写收敛性报告',
        roleRef: computeRef,
        runStatus: 'succeeded',
        telemetryFinalized: true,
      });
      expect(assistantPut.ok).toBe(true);

      // Bounded negative probe: give the continuation ample time to (wrongly)
      // enqueue, then require an empty ledger.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 6_000));
      expect(await listTasks(project.id, group.id)).toEqual([]);

      // The suppressed handoff is not silent: a system notice in the group
      // log tells the user auto-relay is off and whom it would have
      // dispatched, so the "nothing happened" state is explained in place.
      const messagesPayload = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${group.id}/messages`)
      ).json()) as { messages: Array<Record<string, any>> };
      const notice = messagesPayload.messages.find(
        (message) => message.id === 'gdn-nr-a1',
      );
      expect(notice?.role).toBe('system');
      expect(notice?.content).toContain('自动接力已关闭');
      expect(notice?.content).toContain('@学术研究');
    },
    120_000,
  );
});
