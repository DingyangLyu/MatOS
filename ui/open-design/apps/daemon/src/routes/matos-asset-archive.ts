import type { Express, Response } from 'express';
import { execMatOSJson } from '../services/matos-cli.js';

const revisionPattern = /^asset-snapshot-[A-Za-z0-9_-]+~[a-f0-9]{24}$/;

export function registerMatOSAssetArchiveRoutes(app: Express, sendError: (res: Response, status: number, message: string) => void): void {
  app.get('/api/matos/assets-archive', (req, res) => {
    const asset = typeof req.query.asset === 'string' ? req.query.asset : undefined;
    const offset = String(req.query.offset ?? '0');
    if (!/^\d{1,8}$/.test(offset) || asset && !/^[a-zA-Z0-9:/+._@-]+$/.test(asset)) { sendError(res, 400, 'invalid archive query'); return; }
    void execMatOSJson(['assets', 'archive', 'list', '--offset', offset, ...(asset ? ['--asset', asset] : []), '--json'])
      .then(value => res.json(value)).catch(() => sendError(res, 502, 'Asset archive could not be loaded'));
  });
  app.get('/api/matos/assets-archive/:revision', (req, res) => {
    const revision = String(req.params.revision);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    if (!revisionPattern.test(revision) || from && !revisionPattern.test(from)) { sendError(res, 400, 'invalid revision'); return; }
    void execMatOSJson(['assets', 'archive', ...(from ? ['diff', from, revision] : ['show', revision]), '--json'])
      .then(value => res.json(value)).catch(() => sendError(res, 502, 'Asset revision is unavailable in this scope'));
  });
  app.post('/api/matos/assets-archive/:revision/restore', (req, res) => {
    const revision = String(req.params.revision);
    const apply = req.body?.apply === true;
    const expected = typeof req.body?.expectedCurrent === 'string' ? req.body.expectedCurrent : '';
    if (!revisionPattern.test(revision) || apply && !/^[a-f0-9]{40,64}$/.test(expected)) { sendError(res, 400, 'a valid revision and rollback preview are required'); return; }
    void execMatOSJson(['assets', 'archive', 'restore', revision, ...(apply ? ['--apply', '--expected', expected] : []), '--json'])
      .then(value => res.json(value)).catch(() => sendError(res, 409, 'Rollback failed validation or the preview is stale. Refresh the preview.'));
  });
}
