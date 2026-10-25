import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// POST /api/runs message scaffolding for API-only clients (mobile app,
// SDK/smoke scripts): a request that addresses an explicit conversation but
// sends no assistantMessageId must get daemon-owned message persistence —
// user turn row + pinned assistant row + the generated id in the 202 body —
// while web-shaped requests (concrete assistantMessageId, client-owned user
// rows) keep their pre-existing behavior byte-for-byte. Drives the real
// server: real routes, real SQLite, real run lifecycle (the run fails fast
// on an unknown agent id, which is itself the early-failure finalize path).

interface RunCreateBody {
  runId: string;
  conversationId: string | null;
  assistantMessageId: string | null;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  turnUserMessageId?: string;
  runStatus?: string;
  events?: Array<Record<string, unknown>>;
}

describe('POST /api/runs conversation message scaffolding', () => {
  let server: http.Server;
  let baseUrl: string;
  let projectId: string;

  async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as Record<string, any>;
  }

  async function createConversation(title: string): Promise<string> {
    const { conversation } = await postJson(
      `/api/projects/${projectId}/conversations`,
      { title },
    );
    return String(conversation.id);
  }

  async function waitForTerminalRun(runId: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      expect(response.ok).toBe(true);
      const status = String(((await response.json()) as { status: string }).status);
      if (status === 'succeeded' || status === 'failed' || status === 'canceled') return status;
      if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal state`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  async function listChatMessages(conversationId: string): Promise<MessageRow[]> {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages?view=chat`,
    );
    expect(response.ok).toBe(true);
    return ((await response.json()) as { messages: MessageRow[] }).messages ?? [];
  }

  /** Poll until the pinned assistant row reflects the run's terminal state
   *  (the reconcile finalize runs microtask-async after the run finishes). */
  async function waitForFinalizedMessages(
    conversationId: string,
    assistantMessageId: string,
  ): Promise<MessageRow[]> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const messages = await listChatMessages(conversationId);
      const assistant = messages.find((message) => message.id === assistantMessageId);
      const status = assistant?.runStatus ?? '';
      if (status === 'succeeded' || status === 'failed' || status === 'canceled') return messages;
      if (Date.now() > deadline) {
        throw new Error(`assistant ${assistantMessageId} never finalized: ${JSON.stringify(messages)}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
    projectId = `run-scaffold-${Date.now().toString(36)}`;
    await postJson('/api/projects', { id: projectId, name: 'Run scaffold spec' });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it('persists a large recovery baseline and preserves it across small streaming updates', async () => {
    const conversationId = await createConversation('large recovery baseline');
    const id = `large-baseline-${Date.now().toString(36)}`;
    const files = Array.from({ length: 20_000 }, (_, index) => ({
      name: `task/${'nested/'.repeat(24)}file-${index}.json`, size: index, mtime: index,
    }));
    const body = JSON.stringify({
      id, role: 'assistant', roleRef: 'role:compute', content: '',
      runId: 'fixture-recovery-only', runStatus: 'running',
      preTurnFileNames: files.map(file => file.name), preTurnFileSnapshot: files,
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
    const url = `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages/${id}`;
    const initial = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    expect(initial.status).toBe(200);
    // Write acknowledgements deliberately omit recovery arrays; read the
    // authoritative recovery projection to verify durable storage instead.
    const readSaved = async () => {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`);
      expect(response.status).toBe(200);
      return ((await response.json() as { messages: Array<Record<string, any>> }).messages).find(message => message.id === id)!;
    };
    await initial.json();
    const initialMessage = await readSaved();
    expect(initialMessage.preTurnFileSnapshot).toHaveLength(files.length);
    const update = await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, role: 'assistant', content: 'Streaming update' }),
    });
    expect(update.status).toBe(200);
    await update.json();
    const saved = await readSaved();
    expect(saved.content).toBe('Streaming update');
    expect(saved.preTurnFileSnapshot).toHaveLength(files.length);
    expect(saved.preTurnFileSnapshot[0]).toEqual(files[0]);
    expect(saved.preTurnFileSnapshot.at(-1)).toEqual(files.at(-1));
  });

  it('adopts message persistence for API-only requests (explicit conversation, no assistantMessageId)', async () => {
    const conversationId = await createConversation('api-only turn');
    const prompt = '请只回复一句话确认你在线。';

    const created = await postJson('/api/runs', {
      agentId: 'od-test-missing-agent',
      projectId,
      conversationId,
      message: prompt,
      sessionMode: 'chat',
      clientRequestId: `api-scaffold-${Date.now().toString(36)}`,
    }) as RunCreateBody;

    // 202 returns the daemon-generated pinned assistant id and echoes the
    // conversation, so an SSE-only client can correlate its stream.
    expect(created.conversationId).toBe(conversationId);
    expect(created.assistantMessageId).toMatch(/[0-9a-f-]{36}/);

    // The user turn exists immediately (before the run even finishes).
    const initial = await listChatMessages(conversationId);
    const initialUser = initial.filter((message) => message.role === 'user');
    expect(initialUser).toHaveLength(1);
    expect(initialUser[0]!.content).toBe(prompt);

    const terminal = await waitForTerminalRun(created.runId);
    expect(terminal).toBe('failed'); // unknown agent fails fast, pre-stream

    const messages = await waitForFinalizedMessages(conversationId, created.assistantMessageId!);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const assistant = messages.find((message) => message.id === created.assistantMessageId)!;
    expect(assistant.runStatus).toBe('failed');
    // Early failure carries the persisted error event the finalize sink
    // assembled from the run record (no agent stream ever existed).
    expect(assistant.events).toEqual([
      expect.objectContaining({
        kind: 'status',
        label: 'error',
        code: 'AGENT_UNAVAILABLE',
        detail: expect.stringContaining('od-test-missing-agent'),
      }),
    ]);
  });

  it('leaves web-shaped requests (concrete assistantMessageId) byte-identical: no daemon user row', async () => {
    const conversationId = await createConversation('web-shaped turn');
    const assistantMessageId = `web-shape-assistant-${Date.now().toString(36)}`;

    const created = await postJson('/api/runs', {
      agentId: 'od-test-missing-agent',
      projectId,
      conversationId,
      // Web overloads `message` with the full rendered transcript; the
      // daemon must NOT turn it into a user row when the client owns ids.
      message: '## user\nolder\n\n## assistant\nolder answer\n\n## user\nnewest turn',
      currentPrompt: 'newest turn',
      assistantMessageId,
      clientRequestId: `web-scaffold-${Date.now().toString(36)}`,
    }) as RunCreateBody;

    expect(created.assistantMessageId).toBe(assistantMessageId);
    expect(created.conversationId).toBe(conversationId);

    await waitForTerminalRun(created.runId);
    const messages = await waitForFinalizedMessages(conversationId, assistantMessageId);
    // Only the pinned assistant placeholder: the web client persists its own
    // user rows through the PUT route, exactly as before this scaffold.
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(0);
    expect(messages.map((message) => message.id)).toEqual([assistantMessageId]);
  });

  it('pins a web assistant after its explicit user turn despite client clock skew', async () => {
    const conversationId = await createConversation('clock-skewed web turn');
    const userMessageId = `clock-user-${Date.now().toString(36)}`;
    const assistantMessageId = `clock-assistant-${Date.now().toString(36)}`;
    const browserCreatedAt = Date.now() + 60_000;
    const savedUser = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages/${userMessageId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: userMessageId,
          role: 'user',
          content: 'The browser clock is ahead.',
          createdAt: browserCreatedAt,
        }),
      },
    );
    expect(savedUser.ok).toBe(true);

    const created = await postJson('/api/runs', {
      agentId: 'od-test-missing-agent',
      projectId,
      conversationId,
      userMessageId,
      assistantMessageId,
      message: '## user\nThe browser clock is ahead.',
      currentPrompt: 'The browser clock is ahead.',
      clientRequestId: `clock-skew-${Date.now().toString(36)}`,
    }) as RunCreateBody;

    await waitForTerminalRun(created.runId);
    const messages = await waitForFinalizedMessages(conversationId, assistantMessageId);
    expect(messages.map((message) => message.id)).toEqual([
      userMessageId,
      assistantMessageId,
    ]);
    expect(messages[1]?.turnUserMessageId).toBe(userMessageId);
  });
});
