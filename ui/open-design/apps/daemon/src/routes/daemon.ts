import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { readCurrentAppVersionInfo } from '../app-version.js';

export interface RegisterDaemonRoutesDeps {
  db: any;
  paths: {
    PROJECT_ROOT: string;
    RESOURCE_ROOT: string;
    RUNTIME_DATA_DIR: string;
  };
  http: {
    requireLocalDaemonRequest: RequestHandler;
    sendApiError: (...args: any[]) => any;
  };
  host: string;
  getResolvedPort: () => number;
  getDaemonShuttingDown: () => boolean;
  sandboxRuntime: {
    enabled: boolean;
    roots?: unknown;
  };
  env: NodeJS.ProcessEnv;
}

export function registerDaemonRoutes(app: Express, deps: RegisterDaemonRoutesDeps): void {
  const { db, env, host, http, paths, sandboxRuntime } = deps;
  const { requireLocalDaemonRequest, sendApiError } = http;

  app.get('/api/daemon/status', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({
      ok: true,
      version: versionInfo.version,
      bindHost: host,
      port: deps.getResolvedPort(),
      dataDir: paths.RUNTIME_DATA_DIR,
      mediaConfigDir: env.OD_MEDIA_CONFIG_DIR ?? null,
      sandboxMode: sandboxRuntime.enabled,
      sandbox: sandboxRuntime.enabled
        ? { enabled: true, roots: sandboxRuntime.roots }
        : { enabled: false },
      pid: process.pid,
      shuttingDown: deps.getDaemonShuttingDown(),
    });
  });

  app.get('/api/daemon/db', async (_req, res) => {
    try {
      const { inspectSqliteDatabase } = await import('../storage/db-inspect.js');
      const file = path.join(paths.RUNTIME_DATA_DIR, 'app.sqlite');
      const report = await inspectSqliteDatabase({ db, file });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/daemon/db/verify', requireLocalDaemonRequest, async (req, res) => {
    try {
      const { verifySqliteIntegrity } = await import('../storage/db-inspect.js');
      const quick = String(req.query.quick ?? '').toLowerCase();
      const report = verifySqliteIntegrity({ db, quick: quick === '1' || quick === 'true' });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/daemon/db/vacuum', requireLocalDaemonRequest, async (_req, res) => {
    try {
      const { inspectSqliteDatabase } = await import('../storage/db-inspect.js');
      const file = path.join(paths.RUNTIME_DATA_DIR, 'app.sqlite');
      const before = await inspectSqliteDatabase({ db, file });
      const startedAt = Date.now();
      db.exec('VACUUM');
      const elapsedMs = Date.now() - startedAt;
      const after = await inspectSqliteDatabase({ db, file });
      res.json({
        ok: true,
        beforeBytes: before.sizeBytes,
        afterBytes:  after.sizeBytes,
        reclaimedBytes: Math.max(0, before.sizeBytes - after.sizeBytes),
        elapsedMs,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/daemon/shutdown', requireLocalDaemonRequest, (_req, res) => {
    res.status(202).json({ ok: true, scheduled: true });
    setImmediate(() => {
      try {
        process.emit('SIGTERM');
      } catch {
        // Best-effort; if the listener was removed the kernel SIGTERM fallback remains.
      }
    });
  });

}
