import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import type { ProjectFilesResponse, ProjectFilesPageResponse, MessagesResponse } from '@open-design/contracts';

describe('project browsing pages through native HTTP routes', () => {
  let server: http.Server;
  let url: string;
  const projectId = 'bounded-project-browsing';
  const base = `/api/projects/${projectId}`;
  async function json<T = unknown>(route: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await fetch(url + route, body === undefined ? undefined : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.ok, `${route}: HTTP ${response.status}`).toBe(true);
    return response.json() as Promise<T>;
  }
  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
    server = started.server; url = started.url;
    await json('/api/projects', { id: projectId, name: 'Bounded browsing test' });
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('keeps every file reachable through bounded pages and preserves the full-index API', async () => {
    for (let i = 0; i < 23; i++) await json(`${base}/files`, { name: `task/file-${i}.txt`, content: `payload ${i}` });
    const full = await json<ProjectFilesResponse>(`${base}/files`);
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ProjectFilesPageResponse = await json<ProjectFilesPageResponse>(`${base}/files?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.files.length).toBeLessThanOrEqual(7);
      expect(page.total).toBe(full.files.length);
      expect('complete' in page).toBe(false);
      names.push(...page.files.map((file: { name: string }) => file.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(names).size).toBe(full.files.length);
    expect(names.length).toBe(full.files.length);
    expect((await json<ProjectFilesPageResponse>(`${base}/files?limit=7&kind=image`)).files).toEqual([]);
    const single = await json<ProjectFilesPageResponse>(`${base}/files?limit=1&path=task%2Ffile-0.txt`);
    expect(single.files.map(file => file.name)).toEqual(['task/file-0.txt']);
    expect(single.total).toBe(1);
    const collision = await fetch(url + `${base}/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'task/file-0.txt', content: '', expectedEtag: null }),
    });
    expect(collision.status).toBe(409);
    expect(await (await fetch(url + `${base}/raw/task/file-0.txt`)).text()).toBe('payload 0');
    expect((await fetch(url + `${base}/files?limit=0`)).status).toBe(400);
    expect((await fetch(url + `${base}/files?limit=7&cursor=invalid`)).status).toBe(400);
  });
  it('pages recent messages backwards without cross-project reads or reordering', async () => {
    const { conversation } = await json<{ conversation: { id: string } }>(`${base}/conversations`, { title: 'History' });
    const route = `${base}/conversations/${conversation.id}/messages`;
    for (let i = 0; i < 47; i++) await json(`${route}/m-${i}`, {
      id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: String(i), createdAt: 1000 + i,
      ...(i % 2 ? { turnUserMessageId: `m-${i - 1}`, startedAt: 1000 + i } : {}),
    }, 'PUT');
    const all = (await json<MessagesResponse>(`${route}?view=chat`)).messages;
    let before: string | null = null;
    let ids: string[] = [];
    do {
      const page: MessagesResponse = await json<MessagesResponse>(`${route}?view=chat&limit=10${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      expect(page.messages.length).toBeLessThanOrEqual(10);
      ids = [...page.messages.map((message: { id: string }) => message.id), ...ids];
      before = page.nextBefore ?? null;
    } while (before);
    expect(ids).toEqual(all.map((message: { id: string }) => message.id));
    expect((await fetch(url + route.replace(projectId, 'another-project') + '?view=chat&limit=10')).status).toBe(404);
    expect((await fetch(url + route + '?view=chat&limit=201')).status).toBe(400);
  });
  it('filters old-style HTML card previews before applying a bound', async () => {
    await json(`${base}/files`, { name: 'index.html', content: '<h1>Retained preview</h1>' });
    const result = await json<ProjectFilesPageResponse>(`${base}/files?limit=1&kind=html`);
    expect(result.files.map(file => file.name)).toEqual(['index.html']);
    expect(result.total).toBe(1);
    expect(result.nextCursor).toBe(null);
  });
});
