import compression from 'compression';
import express, { type Express, type Request, type Response } from 'express';
import path from 'node:path';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const STREAMING_CONTENT_TYPE = /(?:text\/event-stream|application\/(?:x-ndjson|json-seq))/i;

function apiCompressionFilter(request: Request, response: Response): boolean {
  const contentType = String(response.getHeader('content-type') ?? '');
  if (STREAMING_CONTENT_TYPE.test(contentType)) return false;
  if (String(response.getHeader('x-accel-buffering') ?? '').toLowerCase() === 'no') return false;
  return compression.filter(request, response);
}

/** Compress large API documents before they cross a remote gateway. */
export function registerApiCompression(app: Express): void {
  app.use('/api', compression({
    filter: apiCompressionFilter,
    threshold: 1_024,
  }));
}

/**
 * Serve versioned Next.js assets with transport compression and an immutable
 * cache policy. Turbopack chunk names are stable across some production
 * builds, so the build version in the URL, not the chunk basename alone, is
 * the cache identity. The legacy unversioned route remains available for old
 * exports but must revalidate because runtime syncs overwrite it in place.
 */
export function registerStaticDelivery(app: Express, staticDir: string): void {
  const nextStaticDir = path.join(staticDir, '_next', 'static');

  app.use(
    '/__matos_web/:buildVersion/_next/static',
    compression({ threshold: 1_024 }),
    express.static(nextStaticDir, {
      fallthrough: true,
      immutable: true,
      maxAge: ONE_YEAR_MS,
    }),
  );

  app.use(
    '/_next/static',
    compression({ threshold: 1_024 }),
    express.static(nextStaticDir, {
      fallthrough: true,
      immutable: false,
      maxAge: 0,
      setHeaders(response) {
        response.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use(express.static(staticDir));
}
