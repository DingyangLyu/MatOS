import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { isLocalSameOrigin } from '../src/origin-validation.js';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';

describe('static resource mutation routes', () => {
  let server: http.Server;
  let baseUrl: string;
  let tempRoot: string;
  let catalogReadCount = 0;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-static-routes-'));
        const app = express();
        app.use(express.json({ limit: '4mb' }));
        registerStaticResourceRoutes(app, {
          http: {
            createSseResponse: () => undefined,
            isLocalSameOrigin,
            requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
            resolvedPortRef: {
              get current() {
                const address = server.address();
                return typeof address === 'object' && address ? address.port : 0;
              },
            },
            sendApiError: (res: express.Response, status: number, code: string, message: string) =>
              res.status(status).json({ error: message, code }),
            sendMulterError: () => undefined,
          },
          paths: {
            ARTIFACTS_DIR: path.join(tempRoot, 'artifacts'),
            DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'design-templates'),
            OD_BIN: path.join(tempRoot, 'od'),
            PROJECT_ROOT: tempRoot,
            PROJECTS_DIR: path.join(tempRoot, 'projects'),
            RUNTIME_DATA_DIR: path.join(tempRoot, 'data'),
            RUNTIME_DATA_DIR_CANONICAL: path.join(tempRoot, 'data'),
            SKILLS_DIR: path.join(tempRoot, 'skills'),
            USER_DESIGN_TEMPLATES_DIR: path.join(tempRoot, 'user-design-templates'),
            USER_SKILLS_DIR: path.join(tempRoot, 'user-skills'),
          },
          resources: {
            listAllSkills: async () => {
              catalogReadCount += 1;
              return [];
            },
            listAllDesignTemplates: async () => [],
            listAllSkillLikeEntries: async () => [],
            mimeFor: () => 'application/octet-stream',
          },
        });

        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          resolve();
        });
      }),
  );

  it.each([
    ['POST', '/api/skills/install'],
    ['DELETE', '/api/skills/demo-skill'],
  ])('rejects cross-origin %s %s before catalog or filesystem work', async (method, route) => {
    catalogReadCount = 0;
    const init: RequestInit = {
      method,
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
    };
    if (method === 'POST') {
      init.body = JSON.stringify({
        source: 'local',
        path: tempRoot,
        baseDir: tempRoot,
        githubUrl: 'https://github.com/example/repo',
        reference: 'shadcn/ui/theme-zinc',
      });
    }
    const res = await fetch(`${baseUrl}${route}`, init);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(catalogReadCount).toBe(0);
  });


});
