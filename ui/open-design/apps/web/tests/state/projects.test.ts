import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversation,
  createProject,
  importFolderProject,
  listConversations,
  listMessages,
  listProjects,
  pickLocalFolderPath,
  saveMessageRequired,
  saveMessageRequiredWithRetry,
} from '../../src/state/projects';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/components/ServerFolderPicker', () => ({
  serverFolderBrowserAvailable: async () => (await fetch('/api/matos/fs/dirs')).ok,
  requestServerFolder: async () => '/srv/workspace/data',
}));

describe('listProjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the default fail-soft behavior for background app startup', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects()).resolves.toEqual([]);
  });

  it('can reject transport failures for refresh paths that must preserve current state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects({ throwOnError: true })).rejects.toThrow('projects 503');
  });
});

describe('listConversations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon errors when project bootstrap requires an authoritative list', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'workspace daemon is restarting' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )));

    await expect(listConversations('shared-project', { throwOnError: true }))
      .rejects.toThrow('workspace daemon is restarting');
  });

  it('keeps fail-soft behavior for background callers', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listConversations('shared-project')).resolves.toEqual([]);
  });
});

describe('createProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon validation messages from non-2xx create responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: {
          message: 'draft design systems cannot be used by projects',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({
      name: 'Draft DS project',
      skillId: null,
    })).rejects.toThrow('draft design systems cannot be used by projects');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

describe('createConversation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon role-resolution errors for user-initiated member chats', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: "MatOS role asset not found: role:recipient-shared-agent@1.0.0",
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(createConversation('shared-project', 'Shared agent', {
      roleRef: 'role:recipient-shared-agent@1.0.0',
      throwOnError: true,
    })).rejects.toThrow(
      'MatOS role asset not found: role:recipient-shared-agent@1.0.0',
    );
  });

  it('keeps fail-soft behavior for background callers', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'role resolution failed' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(createConversation('shared-project')).resolves.toBeNull();
  });
});

describe('saveMessageRequiredWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries an idempotent user-message PUT until the server confirms it', async () => {
    const message: ChatMessage = {
      id: 'user-message-1',
      role: 'user',
      content: 'Keep this turn across refreshes.',
      createdAt: 1000,
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'timeline busy' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'timeline busy' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveMessageRequiredWithRetry(
      'project-1',
      'conversation-1',
      message,
      {},
      [0, 0, 0],
    )).resolves.toEqual(message);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/project-1/conversations/conversation-1/messages/user-message-1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(message) }),
    );
  });

  it('sends a large recovery baseline once and omits it after acknowledgement', async () => {
    const message: ChatMessage = {
      id: 'assistant-baseline-once',
      role: 'assistant',
      content: 'streaming',
      runStatus: 'running',
      preTurnFileNames: ['one.html', 'two.csv'],
      preTurnFileSnapshot: [
        { name: 'one.html', size: 10, mtime: 1000 },
        { name: 'two.csv', size: 20, mtime: 1000 },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ message: { id: message.id, role: message.role, content: message.content } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await saveMessageRequired('project-1', 'conversation-1', message);
    await saveMessageRequired('project-1', 'conversation-1', {
      ...message,
      content: 'streaming more',
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(firstBody.preTurnFileSnapshot).toHaveLength(2);
    expect(secondBody.preTurnFileNames).toBeUndefined();
    expect(secondBody.preTurnFileSnapshot).toBeUndefined();
  });
});

describe('listMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the compact browser projection', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ messages: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await listMessages('project 1', 'conversation/1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project%201/conversations/conversation%2F1/messages?view=chat',
    );
  });
});

describe('importFolderProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the project on success', async () => {
    const response = {
      project: { id: 'p-1', name: 'My Folder' },
      conversationId: 'conv-1',
      entryFile: 'index.html',
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const result = await importFolderProject({ baseDir: '/home/user/project' });
    expect(result).toMatchObject({ project: { id: 'p-1' }, entryFile: 'index.html' });
  });

  it('throws with daemon error message for filesystem root', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'cannot import the filesystem root' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/' }))
      .rejects.toThrow('cannot import the filesystem root');
  });

  it('throws with daemon error message for non-existent folder', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'folder not found' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/abc/xyz/notexist' }))
      .rejects.toThrow('folder not found');
  });

  it('throws with daemon error message for file path', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'path must be a directory' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/etc/hosts' }))
      .rejects.toThrow('path must be a directory');
  });

  it('throws a fallback message when response body has no error detail', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      'Internal Server Error',
      { status: 500 },
    )));

    await expect(importFolderProject({ baseDir: '/some/path' }))
      .rejects.toThrow('Failed to import folder');
  });
});

describe('pickLocalFolderPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the selected native folder path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: '/Users/me/Site' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pickLocalFolderPath()).resolves.toBe('/Users/me/Site');
    expect(fetchMock).toHaveBeenCalledWith('/api/dialog/open-folder', {
      method: 'POST',
    });
  });

  it('falls back to the server folder browser when the daemon host has no native dialog', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => (
      String(input) === '/api/dialog/open-folder'
        ? new Response(
          JSON.stringify({ error: 'Could not open folder picker: zenity is not installed' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    )));

    await expect(pickLocalFolderPath()).resolves.toBe('/srv/workspace/data');
  });

  it('returns null when the native picker is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).resolves.toBeNull();
  });

  it('throws with the daemon picker error message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'cross-origin request rejected' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).rejects.toThrow('cross-origin request rejected');
  });
});
