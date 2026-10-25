// MatOS product-feedback bridge.
//
// The native `matos workbench feedback ... --json` service remains the
// runtime authority for persistence, redaction, status history, image
// validation, notifications, and repair counts. This route only translates
// browser multipart requests and public DTOs across that process boundary.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import {
  FEEDBACK_ISSUE_STATUSES,
  type FeedbackIssue,
  type FeedbackIssueKind,
  type FeedbackIssueListResponse,
  type FeedbackIssueSeverity,
  type FeedbackIssueStatus,
} from '@open-design/contracts';
import { execMatOSJson, isRecord, stringOrNull } from '../services/matos-cli.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const ALLOWED_KINDS = new Set<FeedbackIssueKind>(['bug', 'suggestion']);
const ALLOWED_SEVERITIES = new Set<FeedbackIssueSeverity>([
  'low',
  'normal',
  'high',
  'blocking',
]);
const ALLOWED_STATUSES = new Set<FeedbackIssueStatus>(FEEDBACK_ISSUE_STATUSES);
const SAFE_ID = /^[A-Za-z0-9._-]{3,160}$/;
const FEEDBACK_VIEWER_HEADER = 'x-matos-feedback-viewer';
const FEEDBACK_REPORTER_SCOPE_HEADER = 'x-matos-feedback-reporter-scope';
const FEEDBACK_REPORTER_PRINCIPAL_HEADER = 'x-matos-feedback-reporter-principal';

type MatOSJsonExecutor = typeof execMatOSJson;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizedStatus(value: unknown): FeedbackIssueStatus {
  const candidate = text(value).trim() as FeedbackIssueStatus;
  return ALLOWED_STATUSES.has(candidate) ? candidate : 'open';
}

function normalizedKind(value: unknown): FeedbackIssueKind {
  const candidate = text(value).trim().toLowerCase();
  return candidate === 'suggestion' || candidate === 'feature' ? 'suggestion' : 'bug';
}

function normalizedSeverity(value: unknown): FeedbackIssueSeverity {
  const candidate = text(value).trim().toLowerCase() as FeedbackIssueSeverity;
  return ALLOWED_SEVERITIES.has(candidate) ? candidate : 'normal';
}

function publicContext(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    result[key] = raw.slice(0, 500);
  }
  return result;
}

export function normalizeFeedbackIssue(
  value: unknown,
  allowDetails = true,
): FeedbackIssue | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  const createdAt = stringOrNull(value.createdAt);
  if (!id || !createdAt || !SAFE_ID.test(id)) return null;
  const viewerAccess = allowDetails && value.viewerAccess !== 'title' ? 'full' : 'title';
  const attachments = viewerAccess === 'full' && Array.isArray(value.attachments)
    ? value.attachments.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const attachmentId = stringOrNull(raw.id);
        const name = stringOrNull(raw.name);
        const mimeType = stringOrNull(raw.mimeType);
        const size = Number(raw.size);
        if (
          !attachmentId ||
          !name ||
          !mimeType ||
          !SAFE_ID.test(attachmentId) ||
          !ALLOWED_IMAGE_MIME.has(mimeType) ||
          !Number.isFinite(size) ||
          size <= 0 ||
          size > MAX_IMAGE_BYTES
        ) {
          return [];
        }
        return [{
          id: attachmentId,
          name,
          mimeType,
          size,
          url: `/api/matos/feedback/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
        }];
      })
    : [];
  return {
    id,
    createdAt,
    updatedAt: stringOrNull(value.updatedAt) ?? createdAt,
    resolvedAt: stringOrNull(value.resolvedAt),
    status: normalizedStatus(value.status),
    kind: normalizedKind(value.kind),
    severity: normalizedSeverity(value.severity),
    title: text(value.title, id),
    message: viewerAccess === 'full' ? text(value.message) : '',
    messagePreview: viewerAccess === 'full'
      ? text(value.messagePreview, text(value.message).slice(0, 180))
      : '',
    contact: viewerAccess === 'full' ? text(value.contact) : '',
    context: viewerAccess === 'full' ? publicContext(value.context) : {},
    attachments,
    viewerAccess,
  };
}

function normalizedCountRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const count = Number(raw);
    if (Number.isFinite(count) && count >= 0) out[key] = Math.floor(count);
  }
  return out;
}

export function normalizeFeedbackList(
  value: unknown,
  allowDetails = true,
): FeedbackIssueListResponse {
  const root = isRecord(value) ? value : {};
  const issues = (Array.isArray(root.reports) ? root.reports : [])
    .map((report) => normalizeFeedbackIssue(report, allowDetails))
    .filter((issue): issue is FeedbackIssue => issue !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const nativeSummary = isRecord(root.summary) ? root.summary : {};
  const statusCounts = normalizedCountRecord(nativeSummary.statusCounts);
  const resolvedDaily = normalizedCountRecord(nativeSummary.resolvedDaily);
  const total = Number(root.total);
  const fixedTotal = Number(nativeSummary.fixedTotal);
  return {
    issues,
    summary: {
      total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : issues.length,
      fixedTotal: Number.isFinite(fixedTotal) && fixedTotal >= 0
        ? Math.floor(fixedTotal)
        : (statusCounts.resolved ?? 0) + (statusCounts.closed ?? 0),
      statusCounts,
      resolvedDaily,
    },
  };
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { code: 'MATOS_FEEDBACK', message } });
}

function safeId(value: unknown): string | null {
  const id = stringOrNull(value);
  return id && SAFE_ID.test(id) ? id : null;
}

function parseContext(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('context must be a JSON object');
  return parsed;
}

function issueFromSubmit(value: unknown, allowDetails: boolean): FeedbackIssue | null {
  const root = isRecord(value) ? value : {};
  return normalizeFeedbackIssue(root.report, allowDetails);
}

function enabled(value: unknown): boolean {
  return /^(?:1|true|yes|on)$/i.test(text(value).trim());
}

function requestCanReadFeedbackDetails(req: Request, daemonIsAdmin: boolean): boolean {
  const viewer = text(req.get(FEEDBACK_VIEWER_HEADER)).trim().toLowerCase();
  if (!viewer) return daemonIsAdmin;
  return daemonIsAdmin && viewer === 'admin';
}

function trustedReporterContext(
  req: Request,
  daemonIsAdmin: boolean,
): Record<string, string> {
  if (!daemonIsAdmin) return {};
  const reporterScopeRef = text(req.get(FEEDBACK_REPORTER_SCOPE_HEADER)).trim().slice(0, 200);
  const reporterPrincipal = text(req.get(FEEDBACK_REPORTER_PRINCIPAL_HEADER)).trim().slice(0, 320);
  return {
    ...(reporterScopeRef ? { reporterScopeRef } : {}),
    ...(reporterPrincipal ? { reporterPrincipal } : {}),
  };
}

export interface RegisterMatOSFeedbackRoutesOptions {
  dataDir: string;
  execute?: MatOSJsonExecutor;
  /** Trusted daemon capability; never derive this from browser input. */
  isAdmin?: boolean;
}

export function registerMatOSFeedbackRoutes(
  app: Express,
  options: RegisterMatOSFeedbackRoutesOptions,
): void {
  const execute = options.execute ?? execMatOSJson;
  const isAdmin = options.isAdmin ?? enabled(process.env.MATOS_FEEDBACK_ADMIN);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: MAX_IMAGES,
      fields: 12,
    },
    fileFilter: (_req, file, callback) => {
      if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
        callback(new Error('Only PNG, JPEG, GIF, and WebP images are supported'));
        return;
      }
      callback(null, true);
    },
  }).array('images', MAX_IMAGES);

  app.get('/api/matos/feedback', (req: Request, res: Response) => {
    void execute(['workbench', 'feedback', 'list', '--json'])
      .then((payload) => res.json(normalizeFeedbackList(
        payload,
        requestCanReadFeedbackDetails(req, isAdmin),
      )))
      .catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.post('/api/matos/feedback', (req: Request, res: Response) => {
    upload(req, res, (uploadError) => {
      if (uploadError) {
        sendError(res, 400, uploadError instanceof Error ? uploadError.message : String(uploadError));
        return;
      }
      void (async () => {
        const body = isRecord(req.body) ? req.body : {};
        const title = text(body.title).trim();
        const message = text(body.message).trim();
        const kind = text(body.kind, 'bug').trim() as FeedbackIssueKind;
        const severity = text(body.severity, 'normal').trim() as FeedbackIssueSeverity;
        if (!title || title.length > 200) {
          sendError(res, 400, 'title is required and must be at most 200 characters');
          return;
        }
        if (!message || message.length > 8000) {
          sendError(res, 400, 'message is required and must be at most 8000 characters');
          return;
        }
        if (!ALLOWED_KINDS.has(kind)) {
          sendError(res, 400, 'kind must be bug or suggestion');
          return;
        }
        if (!ALLOWED_SEVERITIES.has(severity)) {
          sendError(res, 400, 'unsupported severity');
          return;
        }
        let context: Record<string, unknown>;
        try {
          context = parseContext(body.context);
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error));
          return;
        }

        const files = Array.isArray(req.files) ? req.files : [];
        const uploadRoot = path.join(options.dataDir, 'feedback-uploads');
        await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
        const stagingDir = await mkdtemp(path.join(uploadRoot, 'request-'));
        let issue: FeedbackIssue | null = null;
        try {
          const attachmentPaths = await Promise.all(files.map(async (file, index) => {
            const stagedPath = path.join(stagingDir, `${index + 1}-${randomUUID()}`);
            await writeFile(stagedPath, file.buffer, { mode: 0o600 });
            return {
              path: stagedPath,
              name: file.originalname,
              mimeType: file.mimetype,
            };
          }));
          const payload = await execute([
            'workbench',
            'feedback',
            'submit',
            '--payload-json',
            JSON.stringify({
              kind,
              severity,
              title,
              message,
              contact: text(body.contact).slice(0, 200),
              context: {
                ...context,
                ...trustedReporterContext(req, isAdmin),
              },
              attachmentPaths,
            }),
            '--json',
          ]);
          issue = issueFromSubmit(payload, requestCanReadFeedbackDetails(req, isAdmin));
          if (!issue) throw new Error('MatOS returned an invalid feedback report');
        } finally {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        }
        res.status(201).json({ issue });
      })().catch((error) => {
        if (!res.headersSent) {
          sendError(res, 502, error instanceof Error ? error.message : String(error));
        }
      });
    });
  });

  app.patch('/api/matos/feedback/:reportId', (req: Request, res: Response) => {
    if (!requestCanReadFeedbackDetails(req, isAdmin)) {
      sendError(res, 403, 'Only administrators can change feedback status');
      return;
    }
    void (async () => {
      const reportId = safeId(req.params.reportId);
      const body = isRecord(req.body) ? req.body : {};
      const status = text(body.status).trim() as FeedbackIssueStatus;
      if (!reportId || !ALLOWED_STATUSES.has(status)) {
        sendError(res, 400, 'A valid report id and status are required');
        return;
      }
      const payload = await execute([
        'workbench',
        'feedback',
        'status',
        reportId,
        status,
        '--json',
      ]);
      const issue = issueFromSubmit(payload, true);
      if (!issue) throw new Error('MatOS returned an invalid feedback report');
      res.json({ issue });
    })().catch((error) => sendError(res, 502, error instanceof Error ? error.message : String(error)));
  });

  app.get(
    '/api/matos/feedback/:reportId/attachments/:attachmentId',
    (req: Request, res: Response) => {
      if (!requestCanReadFeedbackDetails(req, isAdmin)) {
        sendError(res, 403, 'Feedback attachments are only available to administrators');
        return;
      }
      void (async () => {
        const reportId = safeId(req.params.reportId);
        const attachmentId = safeId(req.params.attachmentId);
        if (!reportId || !attachmentId) {
          sendError(res, 400, 'Invalid feedback attachment id');
          return;
        }
        const payload = await execute([
          'workbench',
          'feedback',
          'attachment',
          reportId,
          attachmentId,
          '--json',
        ]);
        const root = isRecord(payload) ? payload : {};
        const attachment = isRecord(root.attachment) ? root.attachment : {};
        const mimeType = stringOrNull(attachment.mimeType);
        const base64 = stringOrNull(attachment.base64);
        const name = stringOrNull(attachment.name) ?? 'feedback-image';
        if (!mimeType || !ALLOWED_IMAGE_MIME.has(mimeType) || !base64) {
          throw new Error('MatOS returned an invalid feedback attachment');
        }
        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
          throw new Error('Feedback attachment size is invalid');
        }
        res.setHeader('content-type', mimeType);
        res.setHeader('cache-control', 'private, no-store');
        res.setHeader(
          'content-disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,
        );
        res.send(buffer);
      })().catch((error) => sendError(res, 404, error instanceof Error ? error.message : String(error)));
    },
  );
}
