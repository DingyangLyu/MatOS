import fs from 'node:fs';
import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import { proxyDispatcherRequestInit } from '../connectionTest.js';
import { readMaskedConfig, writeConfig } from '../integrations/provider-config.js';

export interface RegisterResearchRoutesDeps extends RouteDeps<'http' | 'paths' | 'appConfig' | 'nativeDialogs' | 'research'> {}

export function registerResearchRoutes(app: Express, ctx: RegisterResearchRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT, RUNTIME_DATA_DIR } = ctx.paths;
  const { readAppConfig, writeAppConfig } = ctx.appConfig;
  const { openBrowser, openNativeFolderDialog } = ctx.nativeDialogs;
  const { searchResearch, ResearchError } = ctx.research;
  const getResolvedPort = () => resolvedPortRef.current;

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      res.json({ config });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await writeAppConfig(RUNTIME_DATA_DIR, req.body);
      res.json({ config });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/dir-exists', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const dir = typeof req.body?.path === 'string' ? req.body.path : '';
    let exists = false;
    if (dir) {
      try {
        exists = fs.statSync(dir).isDirectory();
      } catch {
        exists = false;
      }
    }
    res.json({ exists });
  });

  app.get('/api/recent-dirs', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      const recents = Array.isArray(config.recentLinkedDirs)
        ? config.recentLinkedDirs
        : [];
      const existing = recents.filter((dir: string) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
      if (existing.length !== recents.length) {
        await writeAppConfig(RUNTIME_DATA_DIR, { recentLinkedDirs: existing });
      }
      /** @type {import('@open-design/contracts').RecentLinkedDirsResponse} */
      const body = { dirs: existing };
      res.json(body);
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/system/open-external', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ ok: false, error: 'url must be a valid URL' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'url must be http or https' });
      }
      const child = openBrowser(parsed.toString());
      res.json({ ok: Boolean(child) });
    } catch (err: any) {
      res
        .status(500)
        .json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/dialog/open-folder', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const selected = await openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/research/search', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: research search is restricted to the local UI / CLI',
      });
    }

    try {
      const proxyDispatcher = proxyDispatcherRequestInit(process.env);
      try {
        const result = await searchResearch({
          projectRoot: PROJECT_ROOT,
          query: req.body?.query,
          maxSources:
            typeof req.body?.maxSources === 'number'
              ? req.body.maxSources
              : undefined,
          providers: Array.isArray(req.body?.providers)
            ? req.body.providers
            : undefined,
          requestInit: proxyDispatcher.requestInit,
        });
        res.json(result);
      } finally {
        await proxyDispatcher.close();
      }
    } catch (err: any) {
      if (err instanceof ResearchError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message },
        });
      }
      res.status(500).json({
        error: {
          code: 'RESEARCH_FAILED',
          message: String(err && err.message ? err.message : err),
        },
      });
    }
  });
}
