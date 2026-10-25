import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_BODY_LIMIT_BYTES, createChatMessageBodyParser } from '../src/chat-message-body.js';

describe('chat message request body limits', () => {
  let server: Server;
  let origin: string;
  const route = '/api/projects/project/conversations/conversation/messages/message';
  beforeEach(async () => {
    const app = express();
    app.use(createChatMessageBodyParser());
    app.use(express.json({ limit: '4mb' }));
    app.use((req, res) => res.json({
      id: req.body.id,
      count: req.body.preTurnFileSnapshot?.length,
      first: req.body.preTurnFileSnapshot?.[0],
      last: req.body.preTurnFileSnapshot?.at(-1),
    }));
    app.use(((error, _req, res, _next) => {
      res.status(error.status ?? 500).json({ error: error.type });
    }) satisfies ErrorRequestHandler);
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const put = (url: string, body: string) => fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
  });

  it('accepts an intact 77,000-file baseline above the previous 4 MiB limit', async () => {
    const files = Array.from({ length: 77_000 }, (_, i) => ({
      name: `task/env/toolchain/${'nested/'.repeat(12)}file-${i}.dat`,
      size: i, mtime: 1789550000000 + i, etag: `etag-${i}`,
    }));
    const body = JSON.stringify({ id: 'message', preTurnFileNames: files.map(f => f.name), preTurnFileSnapshot: files });
    expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(CHAT_MESSAGE_BODY_LIMIT_BYTES);
    const response = await put(origin + route + '?source=browser', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'message', count: files.length, first: files[0], last: files.at(-1) });
  });

  it.each([
    ['PUT', '/api/projects/project'],
    ['POST', route],
    ['PUT', route + '/attachments'],
    ['PUT', '/api/projects/project/conversations/conversation/messages'],
  ])('retains the 4 MiB default for %s %s', async (method, url) => {
    const response = await fetch(origin + url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(4 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it('rejects message bodies over 32 MiB, including compressed input', async () => {
    const body = JSON.stringify({ content: 'x'.repeat(CHAT_MESSAGE_BODY_LIMIT_BYTES) });
    expect((await put(origin + route, body)).status).toBe(413);
    const compressed = gzipSync(body);
    const response = await fetch(origin + route, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: new Uint8Array(compressed),
    });
    expect(response.status).toBe(413);
  });

  it('retains malformed JSON rejection and accepts small normal writes', async () => {
    expect((await put(origin + route, '{')).status).toBe(400);
    const response = await put(origin + route + '/', JSON.stringify({ id: 'small' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'small' });
  });
});
