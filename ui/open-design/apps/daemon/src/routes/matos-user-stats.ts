// Thin projection of native MatOS accounting; no daemon-owned transcript scanner.
import type { Express } from 'express';
import type { MatOSUserStats } from '@open-design/contracts';
import { execMatOSJson } from '../services/matos-cli.js';

export function parseUserStatsRange(query: Record<string, unknown>): { from?: string; to?: string } {
  const result: { from?: string; to?: string } = {};
  for (const key of Object.keys(query)) if (key !== 'from' && key !== 'to') throw new Error('Invalid parameter');
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
    result[key] = value;
  }
  if (result.from && result.to && result.from > result.to) throw new Error('Invalid date range');
  return result;
}

export function registerMatOSUserStatsRoutes(app: Express): void {
  // Per daemon/app. Bound memory and coalesce refreshes, including rapid range switches.
  const cache = new Map<string, { at: number; payload: MatOSUserStats }>();
  const pending = new Map<string, Promise<MatOSUserStats>>();
  let queue: Promise<unknown> = Promise.resolve();
  app.get('/api/matos/user-stats', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    let range: { from?: string; to?: string };
    try { range = parseUserStatsRange(req.query); }
    catch { res.status(400).json({ error: { code: 'MATOS_USER_STATS_RANGE', message: 'Expected a valid UTC date range (YYYY-MM-DD).' } }); return; }
    const key = JSON.stringify([process.env.MATOS_SCOPE_REF, range, new Date().toISOString().slice(0, 10)]);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 15_000) { res.json(cached.payload); return; }
    let task = pending.get(key);
    if (!task) {
      if (pending.size >= 8) { res.status(429).json({ error: { code: 'MATOS_USER_STATS_BUSY', message: 'Usage refresh in progress; retry shortly.' } }); return; }
      const args = ['usage', 'profile', '--json'];
      if (range.from) args.push('--from', range.from);
      if (range.to) args.push('--to', range.to);
      task = queue.catch(() => {}).then(async () => {
        const payload = await execMatOSJson(args) as MatOSUserStats;
        if (payload.schemaVersion !== 1 || !payload.coverage || !Number.isFinite(payload.totalTokens)) throw new Error('Incompatible usage schema');
        cache.set(key, { at: Date.now(), payload });
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
        return payload;
      }).finally(() => { pending.delete(key); });
      queue = task.catch(() => {});
      pending.set(key, task);
    }
    void task.then(payload => res.json(payload)).catch(() => {
      // No raw CLI errors: they can contain host paths or private runtime details.
      res.status(503).json({ error: { code: 'MATOS_USER_STATS', message: 'Usage statistics are temporarily unavailable. Retry shortly.' } });
    });
  });
}
