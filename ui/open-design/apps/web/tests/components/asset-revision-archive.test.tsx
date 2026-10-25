// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetRevisionArchive } from '../../src/components/AssetRevisionArchive';

const revision = { revisionId: 'asset-snapshot-demo~' + '1'.repeat(24), assetRef: 'knowledge:demo@1.0.0', name: 'Archived procedure', version: '1.0.0', snapshotId: 'asset-snapshot-demo', commit: 'a'.repeat(40), scope: 'project', createdAt: '2026-09-14T00:00:00Z', kind: 'manual', state: 'snapshot', fileCount: 1, sizeBytes: 30 };
const list = { revisions: [revision], total: 1, hasMore: false, nextOffset: 50, issues: [], storage: '.matos/asset-history.git' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows errors instead of silently hiding history and supports retry', async () => {
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ++attempts === 1 ? response({ error: { message: 'Archive unavailable' } }, 502) : response(list)));
  render(<AssetRevisionArchive />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Archive unavailable');
  fireEvent.click(screen.getByRole('button', { name: /Refresh archive|刷新存档/i }));
  expect(await screen.findByText('Archived procedure')).toBeTruthy();
});

it('loads exact content and requires a fresh preview before applying rollback', async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/restore')) {
      const body = JSON.parse(String(options?.body)); writes.push(body);
      return response(body.apply ? { revision, mode: 'local', ok: true, action: 'restored' } : { revision, mode: 'local', canRestore: true, expectedCurrent: 'b'.repeat(64), files: ['asset.json'] });
    }
    return response(url.includes('?') ? list : { revision, files: [{ path: 'asset.json', content: '{"archived":true}', sizeBytes: 20, sha256: 'c'.repeat(64) }] });
  }));
  render(<AssetRevisionArchive />);
  fireEvent.click(await screen.findByText('Archived procedure'));
  expect(await screen.findByText('{"archived":true}')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Confirm rollback|确认回滚/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Preview rollback|回滚预览/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirm rollback|确认回滚/ }));
  await waitFor(() => expect(writes.length).toBe(2));
  expect(writes[0]).toEqual({ apply: false });
  expect(writes[1]).toEqual({ apply: true, expectedCurrent: 'b'.repeat(64) });
});

it('does not report a rejected rollback as submitted', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/restore')) return response(JSON.parse(String(options?.body)).apply
      ? { revision, mode: 'candidate', ok: false, action: 'validation_failed' }
      : { revision, mode: 'candidate', canRestore: true, expectedCurrent: 'a'.repeat(40), files: ['asset.json'] });
    return response(url.includes('?') ? list : { revision, files: [] });
  }));
  render(<AssetRevisionArchive />);
  fireEvent.click(await screen.findByText('Archived procedure'));
  fireEvent.click(await screen.findByRole('button', { name: /Preview rollback|回滚预览/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirm rollback|确认回滚/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/failed validation|未通过校验/);
  expect(screen.queryByRole('status')).toBeNull();
});
