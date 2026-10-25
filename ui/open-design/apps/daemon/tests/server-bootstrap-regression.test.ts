import type http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isStaticSpaFallbackRequest,
  resolveDataDir,
  startServer,
  type StartServerResult,
} from '../src/server.js';
import { isLocalSameOrigin } from '../src/origin-validation.js';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;
let routeInventory: StartServerResult['routeInventory'];

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as StartServerResult;
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
  routeInventory = started.routeInventory;
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('server route inventory', () => {
  it('records bootstrap and migrated domain routes in registration order', () => {
    const routeKeys = routeInventory.map((route) => `${route.method} ${route.path}`);
    const fallbackIndex = routeKeys.indexOf('GET /*splat');

    const automationRouteKeys = [
      'GET /api/automation-source-packets',
      'POST /api/automation-ingestions',
      'GET /api/automation-source-packets/:id',
      'GET /api/automation-proposals',
      'POST /api/automation-proposals',
      'GET /api/automation-proposals/:id',
      'POST /api/automation-proposals/:id/apply',
      'POST /api/automation-proposals/:id/reject',
    ];
    const runRouteKeys = [
      'POST /api/runs',
      'GET /api/runs',
      'GET /api/runs/:id/result-package',
      'GET /api/runs/:id',
      'GET /api/runs/:id/events',
      'GET /api/runs/:id/agui',
      'POST /api/runs/:id/cancel',
      'POST /api/chat',
    ];
    const projectFileStringRouteKeys = [
      'GET /api/projects/:id/files',
      'GET /api/projects/:id/search',
      'GET /api/projects/:id/files/:name/preview',
      'POST /api/projects/:id/files',
      'DELETE /api/projects/:id/files/:name',
    ];
    const projectArchiveRouteKeys = [
      'POST /api/projects/:id/archive/batch',
    ];
    const projectTemplateAndArtifactRouteKeys = [
      'POST /api/upload',
      'POST /api/artifacts/save',
      'POST /api/artifacts/lint',
      'POST /api/projects/:id/upload',
      'GET /api/projects/:id/tabs',
      'PUT /api/projects/:id/tabs',
      'GET /api/templates',
      'GET /api/templates/:id',
      'POST /api/templates',
      'DELETE /api/templates/:id',
    ];
    const staticCatalogRouteKeys = [
      'GET /api/skills/:id/example',
      'GET /api/skills/:id/assets/*splat',
    ];
    const researchConfigRouteKeys = [
      'GET /api/media/config',
      'PUT /api/media/config',
      'GET /api/app-config',
      'PUT /api/app-config',
      'POST /api/dir-exists',
      'GET /api/recent-dirs',
      'POST /api/system/open-external',
      'POST /api/dialog/open-folder',
      'POST /api/research/search',
    ];

    expect(routeKeys).toEqual(expect.arrayContaining([
      'GET /api/health',
      'GET /api/ready',
      'GET /api/version',
      'GET /api/daemon/status',
      'GET /api/skills',
      'GET /*splat',
    ]));

    expect(routeKeys.filter((key) => automationRouteKeys.includes(key))).toEqual(automationRouteKeys);
    expect(routeKeys.some(key => key.includes('/api/amr/') || key.includes('/api/integrations/vela/'))).toBe(false);
    expect(routeKeys.filter((key) => runRouteKeys.includes(key))).toEqual(runRouteKeys);
    expect(routeKeys.filter((key) => projectFileStringRouteKeys.includes(key))).toEqual(projectFileStringRouteKeys);
    expect(routeKeys.filter((key) => projectArchiveRouteKeys.includes(key))).toEqual(projectArchiveRouteKeys);
    expect(routeKeys.filter((key) => projectTemplateAndArtifactRouteKeys.includes(key))).toEqual(projectTemplateAndArtifactRouteKeys);
    expect(routeKeys.filter((key) => staticCatalogRouteKeys.includes(key))).toEqual(staticCatalogRouteKeys);
    expect(routeKeys.filter((key) => researchConfigRouteKeys.includes(key))).toEqual(researchConfigRouteKeys);

    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(routeKeys.indexOf('GET /api/health')).toBeLessThan(fallbackIndex);
    expect(routeKeys.indexOf('GET /api/automation-source-packets')).toBeLessThan(
      routeKeys.indexOf('GET /api/skills'),
    );
    expect(routeKeys.indexOf('USE /artifacts')).toBeLessThan(routeKeys.indexOf('USE /frames'));
    expect(routeKeys.filter((key) => key === 'USE /artifacts')).toHaveLength(1);
    expect(routeKeys.filter((key) => key === 'USE /frames')).toHaveLength(1);
    expect(routeKeys.filter((key) => key === 'POST /api/projects/:id/upload')).toHaveLength(1);
    expect(routeKeys.filter((key) => key === 'POST /api/runs')).toHaveLength(1);
    expect(routeKeys.filter((key) => key === 'POST /api/chat')).toHaveLength(1);
    for (const [index, key] of routeKeys.entries()) {
      if (key.includes(' /api/')) {
        expect(index, `${key} should register before SPA fallback`).toBeLessThan(fallbackIndex);
      }
    }
    expect(routeKeys.filter((key) => key === 'GET /api/skills')).toHaveLength(1);
  });
});

describe('bootstrap route regressions', () => {
  it('keeps health, ready, version, and daemon status available', async () => {
    const [health, ready, version, status] = await Promise.all([
      fetch(`${baseUrl}/api/health`),
      fetch(`${baseUrl}/api/ready`),
      fetch(`${baseUrl}/api/version`),
      fetch(`${baseUrl}/api/daemon/status`),
    ]);

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(version.status).toBe(200);
    expect(status.status).toBe(200);
  });

  it('keeps lightweight extracted-route responses stable without fixtures', async () => {
    const [
      automationList,
      automationMissing,
    ] = await Promise.all([
      fetch(`${baseUrl}/api/automation-source-packets`),
      fetch(`${baseUrl}/api/automation-source-packets/missing-packet`),
    ]);

    expect(automationList.status).toBe(200);
    expect(await automationList.json()).toEqual({ packets: [] });

    expect(automationMissing.status).toBe(404);
    expect(await automationMissing.json()).toEqual({ error: 'automation source packet not found' });

  });

  it('keeps template example responses stable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-route-smoke-'));
    const templateId = 'route-smoke-template';
    const templateDir = path.join(tempRoot, 'design-templates', templateId);
    const assetPath = path.join(templateDir, 'assets', 'demo.css');

    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'SKILL.md'),
      [
        '---',
        `name: ${templateId}`,
        'description: Route smoke template.',
        '---',
        '',
        'Render the route smoke template.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(templateDir, 'example.html'),
      '<!doctype html><link rel="stylesheet" href="./assets/demo.css"><main>Template Example</main>',
    );
    fs.writeFileSync(assetPath, 'main { color: rgb(1 2 3); }');

    const app = express();
    app.use(express.json({ limit: '4mb' }));
    let smokeServer: http.Server | undefined;
    const paths = {
      ARTIFACTS_DIR: path.join(tempRoot, 'artifacts'),
      DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'design-templates'),
      LIBRARY_DIR: path.join(tempRoot, 'library'),
      OD_BIN: path.join(tempRoot, 'od'),
      PROJECT_ROOT: tempRoot,
      PROJECTS_DIR: path.join(tempRoot, 'projects'),
      RUNTIME_DATA_DIR: path.join(tempRoot, 'data'),
      RUNTIME_DATA_DIR_CANONICAL: path.join(tempRoot, 'data'),
      SKILLS_DIR: path.join(tempRoot, 'skills'),
      USER_DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'user-design-templates'),
      USER_SKILLS_DIR: path.join(tempRoot, 'user-skills'),
    };
    const httpDeps = {
      createSseResponse: () => undefined,
      isLocalSameOrigin,
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      resolvedPortRef: {
        get current() {
          const address = smokeServer?.address();
          return typeof address === 'object' && address ? address.port : 0;
        },
      },
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: message, code }),
      sendMulterError: () => undefined,
    };
    const templateEntry = {
      id: templateId,
      name: templateId,
      description: 'Route smoke template.',
      triggers: [],
      mode: 'template' as const,
      surface: 'web' as const,
      source: 'built-in' as const,
      platform: null,
      scenario: '',
      category: null,
      previewType: 'default',
      defaultFor: [],
      upstream: null,
      featured: null,
      fidelity: null,
      speakerNotes: null,
      animations: null,
      examplePrompt: '',
      aggregatesExamples: false,
      critiquePolicy: null,
      body: 'Render the route smoke template.',
      dir: templateDir,
    };

    registerStaticResourceRoutes(app, {
      http: httpDeps,
      paths,
      resources: {
        listAllSkills: async () => [],
        listAllDesignTemplates: async () => [templateEntry],
        listAllSkillLikeEntries: async () => [templateEntry],
        mimeFor: (target: string) => target.endsWith('.css') ? 'text/css' : 'application/octet-stream',
      },
    });

    try {
      const smokeBaseUrl = await new Promise<string>((resolve) => {
        smokeServer = app.listen(0, '127.0.0.1', () => {
          const address = smokeServer?.address() as { port: number };
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
      const example = await fetch(`${smokeBaseUrl}/api/skills/${templateId}/example`);

      expect(example.status).toBe(200);
      expect(example.headers.get('content-type')).toContain('text/html');
      const exampleHtml = await example.text();
      expect(exampleHtml).toContain(`/api/skills/${templateId}/assets/demo.css`);

      const asset = await fetch(`${smokeBaseUrl}/api/skills/${templateId}/assets/demo.css`, {
        headers: { Origin: 'null' },
      });
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('text/css');
      expect(asset.headers.get('access-control-allow-origin')).toBe('*');
      await expect(asset.text()).resolves.toBe('main { color: rgb(1 2 3); }');
    } finally {
      await new Promise<void>((resolve) => smokeServer?.close(() => resolve()));
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('static SPA fallback classification', () => {
  const makeReq = (path: string, method = 'GET', accept = 'text/html') => ({
    method,
    path,
    get: (name: string) => (name.toLowerCase() === 'accept' ? accept : ''),
  });

  it('does not classify API, artifacts, frames, or _next requests as SPA fallbacks', () => {
    expect(isStaticSpaFallbackRequest(makeReq('/api/projects') as never)).toBe(false);
    expect(isStaticSpaFallbackRequest(makeReq('/artifacts/x') as never)).toBe(false);
    expect(isStaticSpaFallbackRequest(makeReq('/frames/x') as never)).toBe(false);
    expect(isStaticSpaFallbackRequest(makeReq('/_next/static/app.js') as never)).toBe(false);
  });

  it('requires a GET or HEAD request with an HTML-compatible Accept header', () => {
    expect(isStaticSpaFallbackRequest(makeReq('/workspace') as never)).toBe(true);
    expect(isStaticSpaFallbackRequest(makeReq('/workspace', 'HEAD') as never)).toBe(true);
    expect(isStaticSpaFallbackRequest(makeReq('/workspace', 'POST') as never)).toBe(false);
    expect(isStaticSpaFallbackRequest(makeReq('/workspace', 'GET', 'application/json') as never)).toBe(false);
  });
});

describe('daemon data dir resolver', () => {
  it('requires explicit OD_DATA_DIR in sandbox mode and resolves project-relative dirs', () => {
    expect(() => resolveDataDir('', '/tmp/open-design-test', { requireExplicit: true })).toThrow(
      /OD_DATA_DIR is required/,
    );
    expect(resolveDataDir('relative-data', '/tmp/open-design-test')).toBe('/tmp/open-design-test/relative-data');
  });
});
