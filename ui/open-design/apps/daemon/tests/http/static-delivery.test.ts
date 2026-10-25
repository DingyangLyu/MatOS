import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerApiCompression,
  registerStaticDelivery,
} from '../../src/http/static-delivery.js';

interface TestResponse {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}

describe('static delivery', () => {
  let staticDir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    staticDir = mkdtempSync(path.join(os.tmpdir(), 'od-static-delivery-'));
    mkdirSync(path.join(staticDir, '_next', 'static', 'chunks'), { recursive: true });
    writeFileSync(
      path.join(staticDir, '_next', 'static', 'chunks', 'app-content-hash.js'),
      `globalThis.__openDesign = ${JSON.stringify('compressible-static-payload-'.repeat(512))};`,
    );
    writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><main>Open Design</main>');

    const app = express();
    registerStaticDelivery(app, staticDir);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(staticDir, { force: true, recursive: true });
  });

  function request(pathname: string, acceptEncoding?: string): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
      const request = http.get({
        headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : undefined,
        host: '127.0.0.1',
        path: pathname,
        port,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode ?? 0,
        }));
      });
      request.on('error', reject);
    });
  }

  it('compresses and permanently caches build-versioned framework assets', async () => {
    const response = await request('/__matos_web/build-123/_next/static/chunks/app-content-hash.js', 'gzip');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers.vary).toContain('Accept-Encoding');
    expect(gunzipSync(response.body).toString('utf8')).toContain('__openDesign');
  });

  it('requires revalidation for legacy unversioned framework assets', async () => {
    const response = await request('/_next/static/chunks/app-content-hash.js');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['cache-control']).not.toContain('immutable');
  });

  it('does not mark the mutable application shell as immutable', async () => {
    const response = await request('/index.html');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).not.toContain('immutable');
  });
});

describe('API compression', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    registerApiCompression(app);
    app.get('/api/skills', (_request, response) => {
      response.json({ skills: [{ body: 'large-skill-body-'.repeat(512) }] });
    });
    app.get('/api/agents', (_request, response) => {
      response.type('text/event-stream').send('data: {"type":"agent"}\n\n');
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  function request(pathname: string): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
      const request = http.get({
        headers: { 'accept-encoding': 'gzip' },
        host: '127.0.0.1',
        path: pathname,
        port,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode ?? 0,
        }));
      });
      request.on('error', reject);
    });
  }

  it('compresses large JSON list payloads at the daemon boundary', async () => {
    const response = await request('/api/skills');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(response.body).toString('utf8')).skills).toHaveLength(1);
  });

  it('never buffers event streams behind compression', async () => {
    const response = await request('/api/agents');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString('utf8')).toContain('data:');
  });
});
