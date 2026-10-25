import express from 'express';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackIssue } from '@open-design/contracts';
import {
  normalizeFeedbackList,
  registerMatOSFeedbackRoutes,
} from '../../src/routes/matos-feedback.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startFeedbackRoute(
  execute: NonNullable<Parameters<typeof registerMatOSFeedbackRoutes>[1]['execute']>,
  isAdmin = false,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'matos-feedback-route-'));
  roots.push(dataDir);
  const app = express();
  app.use(express.json());
  registerMatOSFeedbackRoutes(app, { dataDir, execute, isAdmin });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const nativeReport = {
  id: 'feedback-20260710120000000-a1b2c3',
  createdAt: '2026-07-10T12:00:00.000Z',
  updatedAt: '2026-07-10T13:00:00.000Z',
  resolvedAt: null,
  status: 'open',
  kind: 'bug',
  severity: 'high',
  title: 'Preview is blank',
  message: 'The preview is blank after reopening the project.',
  messagePreview: 'The preview is blank after reopening the project.',
  contact: '',
  context: { pagePath: '/projects/demo', scopeRef: 'user:test' },
  attachments: [{
    id: 'image-1-a1b2c3d4',
    name: 'blank.png',
    mimeType: 'image/png',
    size: 16,
    fileName: 'must-not-leak.png',
  }],
  storagePath: '/host/private/feedback.json',
};

describe('MatOS feedback route DTOs', () => {
  it('normalizes native reports without leaking storage paths', () => {
    const result = normalizeFeedbackList({
      reports: [nativeReport],
      total: 1,
      summary: {
        fixedTotal: 0,
        statusCounts: { open: 1 },
        resolvedDaily: {},
      },
    });
    expect(result.summary.total).toBe(1);
    expect(result.issues[0]).toMatchObject({
      id: nativeReport.id,
      status: 'open',
      kind: 'bug',
      attachments: [{
        id: 'image-1-a1b2c3d4',
        url: `/api/matos/feedback/${nativeReport.id}/attachments/image-1-a1b2c3d4`,
      }],
    });
    expect(JSON.stringify(result)).not.toContain('/host/private');
    expect(JSON.stringify(result)).not.toContain('must-not-leak.png');
  });

  it('preserves a title-only projection without private details', () => {
    const result = normalizeFeedbackList({
      reports: [{
        ...nativeReport,
        viewerAccess: 'title',
      }],
      total: 1,
      summary: { fixedTotal: 0, statusCounts: { open: 1 }, resolvedDaily: {} },
    });
    expect(result.issues[0]).toMatchObject({
      title: nativeReport.title,
      viewerAccess: 'title',
      message: '',
      context: {},
      attachments: [],
    });
  });
});

describe('MatOS feedback routes', () => {
  it('lists, submits with an image, updates status, and streams the image', async () => {
    let stagedPath = '';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const execute = vi.fn(async (args: string[]) => {
      const operation = args[2];
      if (operation === 'list') {
        return {
          reports: [nativeReport],
          total: 1,
          summary: { fixedTotal: 0, statusCounts: { open: 1 }, resolvedDaily: {} },
        };
      }
      if (operation === 'submit') {
        const payloadIndex = args.indexOf('--payload-json');
        const payload = JSON.parse(args[payloadIndex + 1] ?? '{}') as {
          title: string;
          attachmentPaths: Array<{ path: string; name: string }>;
          context: Record<string, string>;
        };
        stagedPath = payload.attachmentPaths[0]?.path ?? '';
        expect(payload.title).toBe('Preview is blank');
        expect(payload.attachmentPaths[0]?.name).toBe('blank.png');
        expect(payload.context).toMatchObject({
          pagePath: '/projects/demo',
          reporterScopeRef: 'user:alice',
          reporterPrincipal: 'alice@example.com',
        });
        expect(await readFile(stagedPath)).toEqual(png);
        return { report: nativeReport };
      }
      if (operation === 'status') {
        return {
          report: {
            ...nativeReport,
            status: 'resolved',
            resolvedAt: '2026-07-10T14:00:00.000Z',
          },
        };
      }
      if (operation === 'attachment') {
        return {
          attachment: {
            id: 'image-1-a1b2c3d4',
            name: 'blank.png',
            mimeType: 'image/png',
            size: png.length,
            base64: png.toString('base64'),
          },
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    const route = await startFeedbackRoute(execute, true);
    try {
      const listed = await (await fetch(`${route.baseUrl}/api/matos/feedback`)).json() as {
        issues: Array<{ title: string }>;
      };
      expect(listed.issues[0]?.title).toBe('Preview is blank');

      const form = new FormData();
      form.set('kind', 'bug');
      form.set('severity', 'high');
      form.set('title', 'Preview is blank');
      form.set('message', 'The preview is blank after reopening the project.');
      form.set('context', JSON.stringify({ pagePath: '/projects/demo' }));
      form.append('images', new Blob([png], { type: 'image/png' }), 'blank.png');
      const createdResponse = await fetch(`${route.baseUrl}/api/matos/feedback`, {
        method: 'POST',
        headers: {
          'x-matos-feedback-viewer': 'title',
          'x-matos-feedback-reporter-scope': 'user:alice',
          'x-matos-feedback-reporter-principal': 'alice@example.com',
        },
        body: form,
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { issue: { id: string } };
      expect(created.issue.id).toBe(nativeReport.id);
      await expect(access(stagedPath)).rejects.toThrow();

      const updatedResponse = await fetch(
        `${route.baseUrl}/api/matos/feedback/${nativeReport.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'resolved' }),
        },
      );
      const updated = await updatedResponse.json() as {
        issue?: { status: string };
        error?: unknown;
      };
      expect(updatedResponse.status, JSON.stringify(updated)).toBe(200);
      expect(updated.issue?.status).toBe('resolved');

      const imageResponse = await fetch(
        `${route.baseUrl}/api/matos/feedback/${nativeReport.id}/attachments/image-1-a1b2c3d4`,
      );
      expect(imageResponse.headers.get('content-type')).toContain('image/png');
      expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(png);
    } finally {
      await route.close();
    }
  });

  it('forces title-only projections and blocks detail actions for non-admin users', async () => {
    const execute = vi.fn(async (args: string[]) => {
      const operation = args[2];
      if (operation === 'list') {
        return {
          reports: [nativeReport],
          total: 1,
          summary: { fixedTotal: 0, statusCounts: { open: 1 }, resolvedDaily: {} },
        };
      }
      if (operation === 'submit') return { report: nativeReport };
      throw new Error(`Private operation reached MatOS: ${args.join(' ')}`);
    });
    const route = await startFeedbackRoute(execute, false);
    try {
      const listedResponse = await fetch(`${route.baseUrl}/api/matos/feedback`);
      const listed = await listedResponse.json() as {
        issues: Array<{
          title: string;
          viewerAccess: string;
          message: string;
          context: Record<string, string>;
          attachments: unknown[];
        }>;
      };
      expect(listedResponse.status).toBe(200);
      expect(listed.issues[0]).toMatchObject({
        title: nativeReport.title,
        viewerAccess: 'title',
        message: '',
        context: {},
        attachments: [],
      });

      const form = new FormData();
      form.set('kind', 'bug');
      form.set('severity', 'high');
      form.set('title', nativeReport.title);
      form.set('message', nativeReport.message);
      const createdResponse = await fetch(`${route.baseUrl}/api/matos/feedback`, {
        method: 'POST',
        body: form,
      });
      const created = await createdResponse.json() as { issue: FeedbackIssue };
      expect(createdResponse.status).toBe(201);
      expect(created.issue).toMatchObject({
        title: nativeReport.title,
        viewerAccess: 'title',
        message: '',
        context: {},
        attachments: [],
      });

      const updatedResponse = await fetch(
        `${route.baseUrl}/api/matos/feedback/${nativeReport.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'resolved' }),
        },
      );
      expect(updatedResponse.status).toBe(403);

      const imageResponse = await fetch(
        `${route.baseUrl}/api/matos/feedback/${nativeReport.id}/attachments/image-1-a1b2c3d4`,
      );
      expect(imageResponse.status).toBe(403);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await route.close();
    }
  });

  it('honors the gateway title projection even on the admin authority daemon', async () => {
    const execute = vi.fn(async (args: string[]) => {
      if (args[2] === 'list') {
        return {
          reports: [nativeReport],
          total: 1,
          summary: { fixedTotal: 0, statusCounts: { open: 1 }, resolvedDaily: {} },
        };
      }
      throw new Error(`Private operation reached MatOS: ${args.join(' ')}`);
    });
    const route = await startFeedbackRoute(execute, true);
    try {
      const listedResponse = await fetch(`${route.baseUrl}/api/matos/feedback`, {
        headers: {
          'x-matos-feedback-viewer': 'title',
          'x-matos-feedback-reporter-scope': 'user:alice',
        },
      });
      const listed = await listedResponse.json() as { issues: FeedbackIssue[] };
      expect(listed.issues[0]).toMatchObject({
        title: nativeReport.title,
        viewerAccess: 'title',
        message: '',
        context: {},
        attachments: [],
      });

      const statusResponse = await fetch(
        `${route.baseUrl}/api/matos/feedback/${nativeReport.id}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'x-matos-feedback-viewer': 'title',
          },
          body: JSON.stringify({ status: 'resolved' }),
        },
      );
      expect(statusResponse.status).toBe(403);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await route.close();
    }
  });

  it('rejects unsupported attachment types before invoking MatOS', async () => {
    const execute = vi.fn();
    const route = await startFeedbackRoute(execute);
    try {
      const form = new FormData();
      form.set('kind', 'bug');
      form.set('severity', 'normal');
      form.set('title', 'Bad attachment');
      form.set('message', 'This should be rejected.');
      form.append('images', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'unsafe.svg');
      const response = await fetch(`${route.baseUrl}/api/matos/feedback`, {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await route.close();
    }
  });
});
