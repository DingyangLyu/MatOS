import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// End-to-end shape of the Feishu-style group-task ledger: persisting a
// finished group member turn through the real PUT message route must mirror
// the dispatch + work record into that member's DM conversation.
describe('group task mirroring through the message persist route', () => {
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

  it('mirrors a finished group member turn into the member DM', async () => {
    const { project } = await postJson('/api/projects', {
      id: `gt-route-${Date.now().toString(36)}`,
      name: '电池项目部',
      metadata: {
        kind: 'other',
        members: ['role:compute', 'role:research-scientist'],
        memberNames: { 'role:compute': '算力老王' },
      },
    });

    const { conversation: group } = await postJson(
      `/api/projects/${project.id}/conversations`,
      {
        title: '电池项目群',
        roleRef: 'role:compute',
        memberRefs: ['role:compute', 'role:research-scientist'],
      },
    );
    // The daemon resolves unversioned member refs against the live MatOS asset
    // registry, so the concrete versions advance whenever the role assets
    // evolve. Assert the resolved shape, then reuse the returned refs so the
    // mirror assertions pin the SAME resolution instead of a hardcoded version.
    expect(group.memberRefs).toEqual([
      expect.stringMatching(/^role:compute@\d+\.\d+\.\d+$/),
      expect.stringMatching(/^role:research-scientist@\d+\.\d+\.\d+$/),
    ]);
    const computeRef = (group.memberRefs as string[])[0]!;

    const putMessage = async (id: string, body: Record<string, unknown>): Promise<any> => {
      const response = await fetch(
        `${baseUrl}/api/projects/${project.id}/conversations/${group.id}/messages/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, id }),
        },
      );
      expect(response.ok).toBe(true);
      return response.json();
    };

    await putMessage('u1', {
      role: 'user',
      content: '@算力老王 跑一下 BaTiO3 弛豫',
      roleRef: 'role:compute',
    });
    // Mid-run persist (running) must not mirror yet.
    const runningPut = await putMessage('a1', {
      role: 'assistant',
      content: '',
      roleRef: 'role:compute',
      runStatus: 'running',
    });
    expect(runningPut.groupTaskMirror).toBeUndefined();

    // Finalize persist mirrors dispatch + work record into the member DM.
    const finalPut = await putMessage('a1', {
      role: 'assistant',
      content: '弛豫完成，CONTCAR 已生成。',
      roleRef: 'role:compute',
      runStatus: 'succeeded',
      producedFiles: [{ name: 'CONTCAR' }],
      telemetryFinalized: true,
    });
    expect(finalPut.groupTaskMirror?.memberRef).toBe(computeRef);
    const dmId = finalPut.groupTaskMirror?.conversationId as string;
    expect(dmId).toBeTruthy();
    expect(dmId).not.toBe(group.id);

    const conversations = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}/conversations`)
    ).json()) as { conversations: Array<Record<string, any>> };
    const dm = conversations.conversations.find((c) => c.id === dmId);
    expect(dm?.roleRef).toBe(computeRef);
    expect(dm?.title).toBe('算力老王');
    expect(dm?.memberRefs).toBeUndefined();

    const dmResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/conversations/${dmId}/messages`,
    );
    const dmMessages = await dmResponse.json() as { messages: Array<Record<string, any>> };
    expect(dmResponse.status, JSON.stringify(dmMessages)).toBe(200);
    expect(dmMessages.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '@算力老王 跑一下 BaTiO3 弛豫'],
      ['assistant', '弛豫完成，CONTCAR 已生成。'],
    ]);
    const record = dmMessages.messages[1]!;
    expect(record.runStatus).toBe('succeeded');
    expect(record.producedFiles).toEqual([{ name: 'CONTCAR' }]);
    expect(record.groupTask).toMatchObject({
      sourceProjectId: project.id,
      sourceConversationId: group.id,
      sourceConversationTitle: '电池项目群',
      sourceMessageId: 'a1',
      memberRef: computeRef,
      memberName: '算力老王',
    });
    // Ledger rows are inert copies without live run wiring.
    expect(record.runId).toBeUndefined();
  });

  it('keeps conversation patches and mirrored senders inside the project roster', async () => {
    const { project } = await postJson('/api/projects', {
      id: `gt-roster-${Date.now().toString(36)}`,
      name: 'Roster project',
      metadata: {
        kind: 'other',
        members: ['role:compute', 'role:research-scientist'],
      },
    });
    const { conversation: group } = await postJson(
      `/api/projects/${project.id}/conversations`,
      {
        title: 'Project group',
        roleRef: 'role:compute',
        memberRefs: ['role:compute', 'role:research-scientist'],
      },
    );
    // Same live-registry resolution as above: reuse the resolved refs instead
    // of pinning role versions that change as the assets evolve.
    const computeRef = (group.memberRefs as string[])[0]!;
    const academicRef = (group.memberRefs as string[])[1]!;
    expect(computeRef).toMatch(/^role:compute@\d+\.\d+\.\d+$/);
    expect(academicRef).toMatch(/^role:research-scientist@\d+\.\d+\.\d+$/);

    const invalidPatch = await fetch(
      `${baseUrl}/api/projects/${project.id}/conversations/${group.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleRef: 'role:workflow-builder' }),
      },
    );
    expect(invalidPatch.status).toBe(400);

    const validPatch = await fetch(
      `${baseUrl}/api/projects/${project.id}/conversations/${group.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleRef: 'role:research-scientist',
          memberRefs: ['role:compute'],
        }),
      },
    );
    expect(validPatch.ok).toBe(true);
    const patched = await validPatch.json() as { conversation: { roleRef: string; memberRefs: string[] } };
    expect(patched.conversation.roleRef).toBe(academicRef);
    expect(patched.conversation.memberRefs).toEqual([
      academicRef,
      computeRef,
    ]);

    const { conversation: forkedGroup } = await postJson(
      `/api/projects/${project.id}/conversations`,
      {
        title: 'Forked project group',
        seedFromConversationId: group.id,
      },
    );
    expect(forkedGroup.roleRef).toBe(academicRef);
    expect(forkedGroup.memberRefs).toEqual([
      academicRef,
      computeRef,
    ]);

    const spoofed = await fetch(
      `${baseUrl}/api/projects/${project.id}/conversations/${group.id}/messages/spoofed`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'spoofed',
          role: 'assistant',
          content: 'not a project member',
          roleRef: 'role:workflow-builder',
          runStatus: 'succeeded',
        }),
      },
    );
    expect(spoofed.status).toBe(400);
    await expect(spoofed.json()).resolves.toMatchObject({
      error: 'message role must be a project member',
    });
  });
});
