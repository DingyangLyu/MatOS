import type { Express } from 'express';
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AGENT_DEFS, detectAgentsStream } from '../agents.js';
import type { DetectAgentsOptions } from '../runtimes/detection.js';
import type { DetectedAgent } from '../runtimes/types.js';
import {
  SkillImportError,
  findSkillById,
  importUserSkill,
  listSkillFiles,
  splitDerivedSkillId,
  updateUserSkill,
} from '../skills.js';
import { readAppConfig } from '../app-config.js';
import { installFromTarget, uninstallById } from '../library-install.js';
import type { RouteDeps } from '../server-context.js';
import { usesOpenDesignCatalogs } from '../runtimes/matos-native-policy.js';

export interface RegisterStaticResourceRoutesDeps extends RouteDeps<'http' | 'paths' | 'resources'> {
  agentDetection?: {
    detectAgentsStream?: typeof detectAgentsStream;
    now?: () => number;
    freshMs?: number;
    staleMs?: number;
  };
}

export function registerStaticResourceRoutes(app: Express, ctx: RegisterStaticResourceRoutesDeps) {
  const {
    RUNTIME_DATA_DIR,
    RUNTIME_DATA_DIR_CANONICAL,
    PROJECT_ROOT,
    DESIGN_TEMPLATES_DIR,
    USER_DESIGN_TEMPLATES_DIR,
    SKILLS_DIR,
    USER_SKILLS_DIR,
  } = ctx.paths;
  const {
    listAllSkills,
    listAllDesignTemplates,
    listAllSkillLikeEntries,
    mimeFor,
  } = ctx.resources;
  const { isLocalSameOrigin, resolvedPortRef, sendApiError } = ctx.http;
  const requireLocalOrigin = (req: any, res: any) => {
    if (isLocalSameOrigin(req, resolvedPortRef.current)) return true;
    sendApiError(res, 403, 'FORBIDDEN', 'local origin required');
    return false;
  };
  // MatOS product decision: the user-facing agent picker offers only the
  // MatOS runtime. The upstream registry, adapters, and detection stay
  // intact (they still back tests and internal tooling); this surface-level
  // filter is what the web UI consumes. Operators can re-expose everything
  // with MATOS_AGENT_ONLY=0 (e.g. for upstream-parity debugging).
  const matosOnlyAgents = (): boolean =>
    process.env.MATOS_AGENT_ONLY !== '0';
  const isProductVisibleAgent = (agent: { id: string }): boolean =>
    !matosOnlyAgents() || agent.id === 'matos';

  const agentDetector = ctx.agentDetection?.detectAgentsStream ?? detectAgentsStream;
  const agentNow = ctx.agentDetection?.now ?? Date.now;
  const durationMs = (value: number | undefined, envValue: string | undefined, fallback: number) => {
    const parsed = value ?? Number(envValue ?? fallback);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const agentCacheFreshMs = durationMs(
    ctx.agentDetection?.freshMs,
    process.env.OD_AGENT_DETECTION_CACHE_MS,
    60_000,
  );
  const agentCacheStaleMs = Math.max(
    agentCacheFreshMs,
    durationMs(
      ctx.agentDetection?.staleMs,
      process.env.OD_AGENT_DETECTION_STALE_MS,
      15 * 60_000,
    ),
  );
  const agentOrder = new Map(AGENT_DEFS.map((def, index) => [def.id, index]));
  const sortedAgents = (agents: readonly DetectedAgent[]): DetectedAgent[] =>
    [...agents].sort(
      (a, b) =>
        (agentOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (agentOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  const agentCacheKey = (
    agentCliEnv: Record<string, Record<string, string>>,
    options: DetectAgentsOptions,
  ): string =>
    createHash('sha256')
      .update(JSON.stringify({ agentCliEnv, agentIds: options.agentIds ?? null }))
      .digest('hex');
  type AgentCacheEntry = { at: number; agents: DetectedAgent[] };
  type AgentRefresh = {
    partial: DetectedAgent[];
    listeners: Set<(agent: DetectedAgent) => void>;
    promise: Promise<DetectedAgent[]>;
  };
  let agentCacheGeneration = 0;
  const agentCaches = new Map<string, AgentCacheEntry>();
  const agentRefreshes = new Map<string, AgentRefresh>();

  const startAgentRefresh = (
    key: string,
    agentCliEnv: Record<string, Record<string, string>>,
    options: DetectAgentsOptions,
  ): AgentRefresh => {
    const existing = agentRefreshes.get(key);
    if (existing) return existing;
    const generation = agentCacheGeneration;
    const refresh: AgentRefresh = {
      partial: [],
      listeners: new Set<(agent: DetectedAgent) => void>(),
      promise: Promise.resolve([] as DetectedAgent[]),
    };
    refresh.promise = (async () => {
      for await (const agent of agentDetector(agentCliEnv, options)) {
        if (!isProductVisibleAgent(agent)) continue;
        refresh.partial.push(agent);
        for (const listener of refresh.listeners) listener(agent);
      }
      const agents = sortedAgents(refresh.partial);
      if (generation === agentCacheGeneration) {
        agentCaches.set(key, { at: agentNow(), agents });
      }
      // Config changes are uncommon, but bound the per-registrar cache so a
      // long-lived daemon cannot retain every historical env fingerprint.
      while (agentCaches.size > 4) {
        const oldest = agentCaches.keys().next().value;
        if (typeof oldest !== 'string') break;
        agentCaches.delete(oldest);
      }
      return agents;
    })();
    agentRefreshes.set(key, refresh);
    refresh.promise.then(
      () => {
        if (agentRefreshes.get(key) === refresh) agentRefreshes.delete(key);
      },
      () => {
        if (agentRefreshes.get(key) === refresh) agentRefreshes.delete(key);
      },
    );
    return refresh;
  };

  const cachedAgents = (key: string): { entry: AgentCacheEntry; stale: boolean } | null => {
    const entry = agentCaches.get(key);
    if (!entry) return null;
    const age = Math.max(0, agentNow() - entry.at);
    if (age > agentCacheStaleMs) return null;
    return { entry, stale: age > agentCacheFreshMs };
  };

  app.get('/api/agents', async (req, res) => {
    const wantsStream =
      req.query.stream === '1' || req.query.stream === 'true';
    let aborted = false;
    if (wantsStream) {
      // `writeHead` alone stays buffered until the first agent result. Flush
      // headers plus an SSE comment now so proxies/browsers leave their
      // loading state immediately even when a cold CLI probe takes seconds.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(': connected\n\n');
      req.on('close', () => {
        aborted = true;
      });
    }
    let config;
    try {
      config = await readAppConfig(RUNTIME_DATA_DIR);
    } catch (err: any) {
      if (wantsStream) {
        if (!aborted) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
        }
        res.end();
      } else {
        res.status(500).json({ error: String(err) });
      }
      return;
    }
    const agentCliEnv = config.agentCliEnv ?? {};
    // Select the product-visible runtime before detection. In the default
    // MatOS mode this prevents 25 unrelated version/model/auth probes from
    // starting merely to discard their results afterward.
    const detectionOptions: DetectAgentsOptions = matosOnlyAgents()
      ? { agentIds: ['matos'] }
      : {};
    const key = agentCacheKey(agentCliEnv, detectionOptions);
    const cached = cachedAgents(key);

    if (!wantsStream) {
      try {
        if (cached) {
          if (cached.stale) {
            void startAgentRefresh(key, agentCliEnv, detectionOptions).promise.catch(() => {});
          }
          res.json({ agents: cached.entry.agents });
          return;
        }
        const list = await startAgentRefresh(key, agentCliEnv, detectionOptions).promise;
        res.json({ agents: list });
      } catch (err: any) {
        res.status(500).json({ error: String(err) });
      }
      return;
    }

    const writeAgent = (agent: DetectedAgent) => {
      if (!aborted) res.write(`event: agent\ndata: ${JSON.stringify(agent)}\n\n`);
    };
    try {
      if (cached) {
        for (const agent of cached.entry.agents) writeAgent(agent);
        if (cached.stale) {
          void startAgentRefresh(key, agentCliEnv, detectionOptions).promise.catch(() => {});
        }
      } else {
        const refresh = startAgentRefresh(key, agentCliEnv, detectionOptions);
        refresh.listeners.add(writeAgent);
        // A concurrent request may have started the single-flight before this
        // stream subscribed. Replay only the already-produced prefix.
        for (const agent of refresh.partial) writeAgent(agent);
        try {
          await refresh.promise;
        } finally {
          refresh.listeners.delete(writeAgent);
        }
      }
      if (!aborted) {
        res.write('event: done\ndata: {}\n\n');
      }
    } catch (err: any) {
      if (!aborted) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  app.get('/api/skills', async (_req, res) => {
    if (!usesOpenDesignCatalogs()) return res.json({ skills: [] });
    try {
      const skills = await listAllSkills();
      // Strip full body + on-disk dir from the listing — frontend fetches the
      // body via /api/skills/:id when needed (keeps the listing payload small).
      res.json({
        skills: skills.map(({ body, dir: _dir, ...rest }) => ({
          ...rest,
          hasBody: typeof body === 'string' && body.length > 0,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills/:id', async (req, res) => {
    try {
      const skills = await listAllSkills();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) return res.status(404).json({ error: 'skill not found' });
      const { dir: _dir, ...serializable } = skill;
      res.json(serializable);
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Design templates — the rendering catalogue. Same shape as /api/skills
  // (so the web client can reuse SkillSummary types) but rooted at
  // DESIGN_TEMPLATE_ROOTS so the listing stays focused on template-style
  // entries without bleeding functional skills into the EntryView gallery.
  app.get('/api/design-templates', async (_req, res) => {
    if (!usesOpenDesignCatalogs()) return res.json({ designTemplates: [] });
    try {
      const templates = await listAllDesignTemplates();
      res.json({
        designTemplates: templates.map(({ body, dir: _dir, ...rest }) => ({
          ...rest,
          hasBody: typeof body === 'string' && body.length > 0,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-templates/:id', async (req, res) => {
    try {
      const templates = await listAllDesignTemplates();
      const template = findSkillById(templates, req.params.id);
      if (!template) return res.status(404).json({ error: 'design template not found' });
      const { dir: _dir, ...serializable } = template;
      res.json(serializable);
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/skills/import — write a new SKILL.md under USER_SKILLS_DIR
  // from a UI-supplied body. The next /api/skills request surfaces it
  // automatically because listSkills walks USER_SKILLS_DIR first.
  app.post('/api/skills/import', async (req, res) => {
    try {
      const result = await importUserSkill(USER_SKILLS_DIR, req.body || {});
      const skills = await listAllSkills();
      const skill = findSkillById(skills, result.id);
      if (!skill) {
        return sendApiError(
          res,
          500,
          'INTERNAL_ERROR',
          'imported skill was not found in catalog',
        );
      }
      const { dir: _dir, body: _body, ...serializable } = skill;
      res.status(201).json({
        skill: {
          ...serializable,
          hasBody: typeof skill.body === 'string' && skill.body.length > 0,
        },
      });
    } catch (err: any) {
      if (err instanceof SkillImportError) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 500;
        return sendApiError(res, status, err.code, err.message);
      }
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  // PUT /api/skills/:id — update an existing user-managed skill's
  // SKILL.md (and, when the user edits a built-in for the first time,
  // clone its side files into USER_SKILLS_DIR/<slug>/ so subsequent
  // /api/skills/:id/{files,example,assets/*} requests keep resolving
  // the bundled assets/references/scripts/examples). See PR #955 review.
  app.put('/api/skills/:id', async (req, res) => {
    try {
      const skills = await listAllSkills();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
      }
      const result = await updateUserSkill(USER_SKILLS_DIR, {
        ...(req.body || {}),
        id: skill.id,
        sourceDir: skill.dir,
      });
      const next = await listAllSkills();
      const updated = findSkillById(next, result.id);
      if (!updated) {
        return sendApiError(
          res,
          500,
          'INTERNAL_ERROR',
          'updated skill was not found in catalog',
        );
      }
      const { dir: _dir, body: _body, ...serializable } = updated;
      res.json({
        skill: {
          ...serializable,
          hasBody: typeof updated.body === 'string' && updated.body.length > 0,
        },
      });
    } catch (err: any) {
      if (err instanceof SkillImportError) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 500;
        return sendApiError(res, status, err.code, err.message);
      }
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  // GET /api/skills/:id/files — flat listing of the files that ship with
  // a skill. Used by the Settings → Skills detail panel to render the
  // file tree (capped server-side to keep payload bounded).
  app.get('/api/skills/:id/files', async (req, res) => {
    try {
      const skills = await listAllSkills();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
      }
      const files = await listSkillFiles(skill.dir);
      res.json({ files });
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  // Pre-built example HTML for a skill — what a typical artifact from this
  // skill looks like. Lets users browse skills without running an agent.
  //
  // The skill's `id` (from SKILL.md frontmatter `name`) can differ from its
  // on-disk folder name (e.g. id `magazine-web-ppt` lives in `skills/guizang-ppt/`),
  // so we resolve the actual directory via listSkills() rather than guessing.
  //
  // Resolution order:
  //   1. Derived id (`<parent>:<child>`):
  //      <parentDir>/examples/<child>.html — pre-baked single-file sample.
  //      Subfolder layouts
  //      `examples/<name>/template.html`) are intentionally not served:
  //      they still contain `{{data.x}}` placeholders that only the
  //      daemon-side renderer fills in, and serving the raw template
  //      would render visible placeholder braces in the gallery.
  //   2. <skillDir>/example.html — fully-baked static example (preferred)
  //   3. <skillDir>/assets/template.html  +
  //      <skillDir>/assets/example-slides.html — assemble at request time
  //      by replacing the `<!-- SLIDES_HERE -->` marker with the snippet
  //      and patching the placeholder <title>. Lets a skill ship one
  //      canonical seed plus a small content fragment, so the example
  //      never drifts from the seed.
  //   4. <skillDir>/assets/template.html — raw template, no content slides
  //   5. <skillDir>/assets/index.html — generic fallback
  //   6. First .html in <skillDir>/examples/ — used as a friendly fallback
  //      so a skill that aggregates examples still has
  //      a real preview on its parent card instead of returning 404.
  app.get('/api/skills/:id/example', async (req, res) => {
    try {
      // Span both functional skills and design templates: rendered example
      // HTML rewrites assets to /api/skills/<id>/... and we want those URLs
      // to keep resolving regardless of which root owns the backing folder
      // after the skills/design-templates split.
      const skills = await listAllSkillLikeEntries();

      // 1. Derived `<parent>:<child>` id — resolve straight to the matching
      // file under <parentDir>/examples/. Done before findSkillById so the
      // parent's normal fallback chain never accidentally serves a stale
      // file when a sample is missing (we'd rather 404 explicitly).
      const derived = splitDerivedSkillId(req.params.id);
      if (derived) {
        const parent = findSkillById(skills, derived.parentId);
        if (!parent) {
          return res.status(404).type('text/plain').send('skill not found');
        }
        const candidate = path.join(
          parent.dir,
          'examples',
          `${derived.childKey}.html`,
        );
        if (fs.existsSync(candidate)) {
          const html = await fs.promises.readFile(candidate, 'utf8');
          return res
            .type('text/html')
            .send(rewriteSkillAssetUrls(html, parent.id));
        }
        return res
          .status(404)
          .type('text/plain')
          .send('derived example not found');
      }

      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }

      const baked = path.join(skill.dir, 'example.html');
      if (fs.existsSync(baked)) {
        const html = await fs.promises.readFile(baked, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }

      const tpl = path.join(skill.dir, 'assets', 'template.html');
      const slides = path.join(skill.dir, 'assets', 'example-slides.html');
      if (fs.existsSync(tpl) && fs.existsSync(slides)) {
        try {
          const tplHtml = await fs.promises.readFile(tpl, 'utf8');
          const slidesHtml = await fs.promises.readFile(slides, 'utf8');
          const assembled = assembleExample(tplHtml, slidesHtml, skill.name);
          return res
            .type('text/html')
            .send(rewriteSkillAssetUrls(assembled, skill.id));
        } catch {
          // Fall through to raw template on read failure.
        }
      }
      if (fs.existsSync(tpl)) {
        const html = await fs.promises.readFile(tpl, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }
      const idx = path.join(skill.dir, 'assets', 'index.html');
      if (fs.existsSync(idx)) {
        const html = await fs.promises.readFile(idx, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }

      // Friendly fallback for skills that aggregate examples in a sibling
      // `examples/` folder. The parent card would
      // otherwise 404 even though plenty of perfectly valid samples ship
      // alongside SKILL.md; pick the first .html file alphabetically so
      // direct URL access (e.g. deep links) shows something representative.
      // Subfolder layouts are excluded for the same reason as the derived
      // resolver above — their `template.html` still has unresolved
      // `{{data.x}}` placeholders.
      const examplesDir = path.join(skill.dir, 'examples');
      if (fs.existsSync(examplesDir)) {
        let entries: string[] = [];
        try {
          entries = await fs.promises.readdir(examplesDir);
        } catch {
          entries = [];
        }
        entries.sort();
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          if (!name.toLowerCase().endsWith('.html')) continue;
          const direct = path.join(examplesDir, name);
          try {
            const html = await fs.promises.readFile(direct, 'utf8');
            return res
              .type('text/html')
              .send(rewriteSkillAssetUrls(html, skill.id));
          } catch {
            continue;
          }
        }
      }

      res
        .status(404)
        .type('text/plain')
        .send(
          'no example.html, assets/template.html, assets/index.html, or examples/*.html for this skill',
        );
    } catch (err: any) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Static assets shipped beside a skill's example/template HTML. Lets the
  // example HTML reference `./assets/foo.png`-style paths that resolve
  // correctly when the response is loaded into a sandboxed `srcdoc` iframe
  // (where relative URLs would otherwise resolve against `about:srcdoc`).
  // The example response above rewrites `./assets/<file>` into a request
  // against this route; we still keep the on-disk paths human-friendly so
  // contributors can preview `example.html` straight from disk.
  app.get('/api/skills/:id/assets/*splat', async (req, res) => {
    try {
      // Same rationale as /example above — assets need to resolve whether
      // the owning skill folder lives under skills/ or design-templates/.
      const skills = await listAllSkillLikeEntries();
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }
      const splatParam = (req.params as { splat?: string | string[] }).splat;
      const relPath = Array.isArray(splatParam) ? splatParam.join('/') : String(splatParam || '');
      const assetsRoot = path.resolve(skill.dir, 'assets');
      const target = path.resolve(assetsRoot, relPath);
      if (target !== assetsRoot && !target.startsWith(assetsRoot + path.sep)) {
        return res.status(400).type('text/plain').send('invalid asset path');
      }
      if (!fs.existsSync(target)) {
        return res.status(404).type('text/plain').send('asset not found');
      }
      // The example HTML is rendered inside a sandboxed iframe (Origin: null).
      // Mirror the project /raw route's allowance so the iframe can fetch the
      // image bytes; same-origin web callers do not need this header.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      await res.type(mimeFor(target)).sendFile(target);
    } catch (err: any) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.post('/api/skills/install', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const result = await installFromTarget(req.body, USER_SKILLS_DIR);
      if (!result.ok) return res.status(400).json({ error: result.error });
      if (typeof result.dir !== 'string' || !result.dir) {
        return res.status(500).json({ error: 'skill install did not return an installation directory' });
      }
      const skills = await listAllSkills();
      const installedDir = fs.realpathSync.native(result.dir);
      const skill = skills.find((candidate) => fs.realpathSync.native(candidate.dir) === installedDir);
      if (!skill) {
        return res.status(500).json({ error: `installed skill was not found in catalog: ${result.dir}` });
      }
      res.json({
        skill: {
          ...skill,
          dir: undefined,
          body: undefined,
          hasBody: typeof skill.body === 'string' && skill.body.length > 0,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/skills/:id', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const result = await uninstallById(req.params.id, USER_SKILLS_DIR, SKILLS_DIR);
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  return {
    invalidateAgentCache() {
      agentCacheGeneration += 1;
      agentCaches.clear();
      agentRefreshes.clear();
    },
  };
}

export function assembleExample(templateHtml: string, slidesHtml: string, title: string) {
  return templateHtml
    .replace('<!-- SLIDES_HERE -->', slidesHtml)
    .replace(/<title>.*?<\/title>/, `<title>${title} | MatOS Example</title>`);
}

export function rewriteSkillAssetUrls(html: string, skillId: string) {
  if (typeof html !== 'string' || html.length === 0) return html;
  return html.replace(
    /(\s(?:src|href)\s*=\s*)(['"])((?:\.\.\/([^/'"#?]+)\/)?(?:\.\/)?assets\/([^'"#?]+))(\2)/gi,
    (_match, attr, openQuote, _fullPath, siblingSkillId, relPath, closeQuote) => {
      const resolvedSkillId = siblingSkillId || skillId;
      const prefix = `/api/skills/${encodeURIComponent(resolvedSkillId)}/assets/`;
      return `${attr}${openQuote}${prefix}${relPath}${closeQuote}`;
    },
  );
}
