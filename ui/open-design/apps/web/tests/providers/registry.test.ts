import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import {
  deleteProjectFile,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchProjectFileText,
  fetchProjectFileSnapshot,
  fetchProjectFiles,
  fetchProjectCoverFiles,
  fetchProjectPreviewFiles,
  fetchSkillExample,
  openFolderDialog,
  renameProjectFile,
  resetProjectFilesBrowserCacheForTests,
  uploadProjectFiles,
  writeProjectTextFileDetailed,
} from '../../src/providers/registry';

function projectFile(name: string, mtime: number) {
  return {
    name,
    path: name,
    size: name.length,
    mtime,
    kind: 'text' as const,
    mime: 'text/plain',
  };
}

describe('fetchProjectCoverFiles', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses one bounded image-only request for native project cards', async () => {
    const image = { ...projectFile('cover.png', 30), kind: 'image' };
    const fetch = vi.fn(async () => Response.json({ files: [image] }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchProjectCoverFiles('a b')).resolves.toEqual([image]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects/a%20b/files?limit=20&kind=image');
  });
});

describe('fetchProjectPreviewFiles', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('bounds legacy cover discovery and preserves an older index.html', async () => {
    const image = { ...projectFile('cover.png', 30), kind: 'image' };
    const page = { ...projectFile('new.html', 20), kind: 'html' };
    const index = { ...projectFile('index.html', 1), kind: 'html' };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      expect(url.searchParams.has('limit')).toBe(true);
      const files = url.searchParams.has('path') ? [index]
        : url.searchParams.get('kind') === 'image' ? [image] : [page];
      return Response.json({ files });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(fetchProjectPreviewFiles('a b')).resolves.toEqual([image, page, index]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => url.startsWith('/api/projects/a%20b/files?'))).toBe(true);
  });
});

describe('fetchProjectFileSnapshot', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('pairs content with its write revision, bypassing the raw preview cache', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('scene content', { headers: { 'X-MatOS-File-Revision': 'sha256:original' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchProjectFileSnapshot('a b', 'scene/a.json')).resolves.toEqual({ text: 'scene content', etag: 'sha256:original' });
    expect(fetch).toHaveBeenCalledWith('/api/projects/a%20b/files/scene%2Fa.json', { cache: 'no-store' });
  });
  it('never accepts a weak preview ETag as a write revision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { ETag: 'W/preview' } })));
    await expect(fetchProjectFileSnapshot('p', 'scene.json')).rejects.toThrow(/revision/i);
  });
  it('rejects a failed read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(fetchProjectFileSnapshot('p', 'scene.json')).rejects.toThrow(/404/);
  });
});

describe('fetchProjectFiles', () => {
  afterEach(() => {
    resetProjectFilesBrowserCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('singleflights concurrent requests for the same project', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchProjectFiles('project-1');
    const second = fetchProjectFiles('project-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(new Response(JSON.stringify({
      files: [projectFile('alpha.txt', 1)],
      complete: true,
      snapshotAt: 100,
    }), { status: 200 }));

    await expect(first).resolves.toEqual([projectFile('alpha.txt', 1)]);
    await expect(second).resolves.toEqual([projectFile('alpha.txt', 1)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends since and merges changed and removed paths into the full list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [projectFile('alpha.txt', 1), projectFile('keep.txt', 2)],
        complete: true,
        snapshotAt: 200,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [projectFile('beta.txt', 3)],
        removed: ['alpha.txt'],
        complete: false,
        snapshotAt: 201,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProjectFiles('project delta');
    await expect(fetchProjectFiles('project delta')).resolves.toEqual([
      projectFile('beta.txt', 3),
      projectFile('keep.txt', 2),
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/projects/project%20delta/files?since=200',
    );
  });

  it('replaces the local snapshot when the daemon returns a complete recovery list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [projectFile('stale.txt', 1)],
        complete: true,
        snapshotAt: 300,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [projectFile('fresh.txt', 2)],
        complete: true,
        snapshotAt: 400,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProjectFiles('project-recovery');
    await expect(fetchProjectFiles('project-recovery')).resolves.toEqual([
      projectFile('fresh.txt', 2),
    ]);
  });
});

function agentStreamResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('fetchAgentsStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('collects streamed agents only after the terminal done event', async () => {
    const agent = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => agentStreamResponse(
        `event: agent\ndata: ${JSON.stringify(agent)}\n\n` +
          'event: done\ndata: {}\n\n',
      )),
    );
    const onAgent = vi.fn();

    await expect(fetchAgentsStream({ onAgent })).resolves.toEqual([agent]);
    expect(onAgent).toHaveBeenCalledWith(agent);
  });

  it('throws when the stream emits an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => agentStreamResponse(
        'event: error\ndata: {"error":"agent probe failed"}\n\n',
      )),
    );

    await expect(fetchAgentsStream({ onAgent: vi.fn() }))
      .rejects.toThrow('agent probe failed');
  });

  it('throws when the stream closes before the terminal done event', async () => {
    const agent = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => agentStreamResponse(
        `event: agent\ndata: ${JSON.stringify(agent)}\n\n`,
      )),
    );

    await expect(fetchAgentsStream({ onAgent: vi.fn() }))
      .rejects.toThrow('agents stream ended before done');
  });
});

describe('fetchAppVersionInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns version info from the daemon response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        version: { version: '1.2.3', channel: 'beta', packaged: true, platform: 'darwin', arch: 'arm64' },
      }), { status: 200 })),
    );

    await expect(fetchAppVersionInfo()).resolves.toEqual({
      version: '1.2.3',
      channel: 'beta',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64',
    });
  });

  it('returns null when version info is unavailable or malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: { version: '1.2.3' } }), { status: 200 })),
    );

    await expect(fetchAppVersionInfo()).resolves.toBeNull();
  });
});

describe('writeProjectTextFileDetailed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('surfaces daemon save errors instead of collapsing them to null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        error: { code: 'ARTIFACT_REGRESSION', message: 'new artifact is smaller than the prior version' },
      }), { status: 422, headers: { 'Content-Type': 'application/json' } })),
    );

    await expect(writeProjectTextFileDetailed('project-1', 'preview.html', '<html></html>')).resolves.toEqual({
      ok: false,
      status: 422,
      code: 'ARTIFACT_REGRESSION',
      message: 'new artifact is smaller than the prior version',
    });
  });

  it('sends the expected etag for compare-and-swap writes', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      file: { name: 'preview.html', etag: 'etag-v2' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await writeProjectTextFileDetailed(
      'project-1',
      'preview.html',
      '<html></html>',
      { expectedEtag: 'etag-v1' },
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ expectedEtag: 'etag-v1' });
  });

  it('sends expected etags for delete and rename operations', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      file: { name: 'renamed.txt', etag: 'etag-v2' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteProjectFile('project-1', 'notes.txt', 'etag-v1')).resolves.toBe(true);
    await renameProjectFile('project-1', 'notes.txt', 'renamed.txt', 'etag-v1');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('expectedEtag=etag-v1');
    const renameInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(renameInit.body))).toEqual({
      from: 'notes.txt',
      to: 'renamed.txt',
      expectedEtag: 'etag-v1',
    });
  });
});

describe('openFolderDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the legacy fail-soft behavior unless throwOnError is requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ error: 'Could not open folder picker: zenity is not installed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    await expect(openFolderDialog()).resolves.toBeNull();
  });

  it('throws daemon picker messages when throwOnError is requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ error: 'Could not open folder picker: zenity is not installed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    await expect(openFolderDialog({ throwOnError: true }))
      .rejects.toThrow('Could not open folder picker: zenity is not installed');
  });
});

describe('fetchSkillExample', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Regression coverage for nexu-io/open-design#897. Skills declared with
  // a non-html `od.preview.type` ship no fetchable HTML — the daemon's
  // /example endpoint only resolves HTML files and 404s for everything
  // else, which left the gallery stuck on a misleading "Couldn't load
  // this example. The example HTML failed to fetch." state. The dispatch
  // now short-circuits at the data layer so the modal can render a calm
  // "no shipped preview" placeholder without firing a doomed network
  // call.
  it('short-circuits without a fetch when previewType is not html', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillExample('image-template', 'image')).resolves.toEqual({
      unavailable: true,
      kind: 'image',
    });
    await expect(
      fetchSkillExample('dcf-valuation', 'markdown'),
    ).resolves.toEqual({ unavailable: true, kind: 'markdown' });

    // The doomed-call is the bug we're fixing — assert no network call
    // was made for either non-html dispatch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to html fetch when previewType is omitted (legacy callers)', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html><body>ok</body></html>', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillExample('blog-post')).resolves.toEqual({
      html: '<html><body>ok</body></html>',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/blog-post/example');
  });

  it('treats missing html previews as unavailable instead of an error', async () => {
    const fetchMock = vi.fn(
      async () => new Response('not found', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillExample('design-brief', 'html')).resolves.toEqual({
      unavailable: true,
      kind: 'html',
    });
    // Confirm the dispatch did call through to the daemon for the html
    // path (i.e. the short-circuit above only catches non-html types).
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/design-brief/example');
  });

  it('forwards real html preview fetch failures as discriminated errors', async () => {
    const fetchMock = vi.fn(
      async () => new Response('server error', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillExample('design-brief', 'html')).resolves.toEqual({
      error: 'HTTP 500',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/design-brief/example');
  });
});

describe('fetchProjectFileText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('can bypass caches when fetching source text', async () => {
    const fetchMock = vi.fn(async () => new Response('<svg />', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchProjectFileText('project-1', 'diagram.svg', {
        cache: 'no-store',
        cacheBustKey: '1710000000-2',
      }),
    ).resolves.toBe('<svg />');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/raw/diagram.svg?cacheBust=1710000000-2',
      { cache: 'no-store' },
    );
  });

  it('logs HTTP failure context before returning null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404, statusText: 'Not Found' })));

    await expect(fetchProjectFileText('project-1', 'missing.svg')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      '[fetchProjectFileText] failed:',
      expect.objectContaining({
        name: 'missing.svg',
        projectId: 'project-1',
        status: 404,
        statusText: 'Not Found',
        url: '/api/projects/project-1/raw/missing.svg',
      }),
    );
  });

  it('logs thrown fetch errors before returning null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('network down');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw error;
    }));

    await expect(fetchProjectFileText('project-1', 'diagram.svg')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      '[fetchProjectFileText] failed:',
      expect.objectContaining({
        error,
        name: 'diagram.svg',
        projectId: 'project-1',
        url: '/api/projects/project-1/raw/diagram.svg',
      }),
    );
  });
});


describe('uploadProjectFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats every response entry as a success regardless of originalName drift', async () => {
    // Simulates an encoding edge case: the browser File.name carries a
    // composed CJK name (NFC) but multer round-trips it through latin1 and
    // returns a slightly different decoded form. The old name-equality
    // matching marked these as failed even though the server stored them.
    const composed = '测试.pdf';
    const decomposed = '测试.pdf'; // pretend the server returned a normalized variant
    const file = new File(['hello'], composed, { type: 'application/pdf' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        files: [
          {
            name: 'mxk7-test.pdf',
            path: 'mxk7-test.pdf',
            size: 5,
            originalName: decomposed,
          },
        ],
      }), { status: 200 })),
    );

    const result = await uploadProjectFiles('project-1', [file]);

    expect(result.failed).toEqual([]);
    expect(result.uploaded).toHaveLength(1);
    expect(result.uploaded[0]).toMatchObject({
      path: 'mxk7-test.pdf',
      name: decomposed,
      size: 5,
    });
  });

  it('marks the unmatched tail as failed when the server drops files mid-flight', async () => {
    const a = new File(['a'], 'a.txt', { type: 'text/plain' });
    const b = new File(['b'], 'b.txt', { type: 'text/plain' });
    const c = new File(['c'], 'c.txt', { type: 'text/plain' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        files: [
          { name: 't1-a.txt', path: 't1-a.txt', size: 1, originalName: 'a.txt' },
          { name: 't2-b.txt', path: 't2-b.txt', size: 1, originalName: 'b.txt' },
        ],
      }), { status: 200 })),
    );

    const result = await uploadProjectFiles('project-1', [a, b, c]);

    expect(result.uploaded).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: 'c.txt' });
  });
});
