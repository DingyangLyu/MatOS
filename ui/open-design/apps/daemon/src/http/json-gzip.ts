// Opt-in gzip for large JSON payloads.
//
// The daemon deliberately has no blanket compression middleware (SSE streams
// and tiny JSON replies would pay overhead for nothing). A handful of
// catalog-style endpoints, led by the MatOS asset registry bridge
// (~800 assets even after the compact projection), return hundreds of KB of
// highly compressible JSON to remote browsers behind the public gateway —
// exactly where transfer time, not daemon CPU, dominates perceived loading.
//
// gzipSync on a ~1MB JSON body costs a few milliseconds, which is noise next
// to the CLI walk that produced it, so the synchronous form keeps the call
// sites trivially simple.

import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';

/** Only bodies above this size are worth the gzip round-trip. */
export const JSON_GZIP_MIN_BYTES = 8 * 1024;

export function sendJsonMaybeGzip(req: Request, res: Response, payload: unknown): void {
  const body = JSON.stringify(payload);
  const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
  if (!acceptsGzip || Buffer.byteLength(body, 'utf8') < JSON_GZIP_MIN_BYTES) {
    res.set('content-type', 'application/json; charset=utf-8').send(body);
    return;
  }
  const compressed = gzipSync(body);
  res
    .set({
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      // Proxies must not serve a gzip body to a client that didn't ask.
      vary: 'Accept-Encoding',
    })
    .send(compressed);
}
