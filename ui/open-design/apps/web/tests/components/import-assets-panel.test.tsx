// @vitest-environment jsdom

// The universal import panel drives the two-step intake flow: preview posts
// the source to /api/matos/assets/import-preview and renders the typed asset
// proposals, then apply echoes the preview's confirmation fingerprint to
// /api/matos/assets/import-apply and reports the primary asset ref back.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImportAssetsPanel } from '../../src/components/AssetsView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PREVIEW = {
  validation: { ok: true, issues: [] },
  plan: {
    targetPack: { packId: 'toy-mlip-tool' },
    proposedAssets: [
      { type: 'tool', id: 'toy-mlip-tool', ref: 'tool:toy-mlip-tool@0.1.0', primary: true, confidence: 'high' },
      { type: 'knowledge', id: 'toy-mlip-tool-docs', ref: 'knowledge:toy-mlip-tool-docs@0.1.0', confidence: 'medium' },
    ],
  },
  transaction: { confirmationFingerprint: 'f'.repeat(64) },
};

describe('ImportAssetsPanel', () => {
  it('previews a source into proposals and applies with the fingerprint', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(url).includes('import-apply') ? { ...PREVIEW, applied: true } : PREVIEW),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();

    render(<ImportAssetsPanel onImported={onImported} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('assets-import-source'), {
      target: { value: 'https://github.com/org/toy-mlip-tool' },
    });
    fireEvent.click(screen.getByTestId('assets-import-preview'));

    await waitFor(() => expect(screen.getByTestId('assets-import-result')).toBeTruthy());
    expect(screen.getByText(/tool:toy-mlip-tool/)).toBeTruthy();
    expect(screen.getByText(/knowledge:toy-mlip-tool-docs/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('assets-import-apply'));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('tool:toy-mlip-tool'));

    const applyCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([url]) => String(url).includes('import-apply'),
    );
    expect(applyCall).toBeDefined();
    const body = JSON.parse(String(applyCall![1].body)) as Record<string, unknown>;
    expect(body.fingerprint).toBe('f'.repeat(64));
    expect(body.source).toBe('https://github.com/org/toy-mlip-tool');
  });

  it('blocks apply until a valid preview exists', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ImportAssetsPanel onImported={() => {}} onClose={() => {}} />);
    expect((screen.getByTestId('assets-import-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uploads a selected directory with its relative-path manifest', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, path: '/workspace/group/shared/.matos/intake/uploads/folder-test' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(<ImportAssetsPanel onImported={() => {}} onClose={() => {}} />);

    const first = new File(['a'], 'schema.csv');
    const second = new File(['b'], 'rows.jsonl');
    Object.defineProperty(first, 'webkitRelativePath', { value: 'powder-db/schema.csv' });
    Object.defineProperty(second, 'webkitRelativePath', { value: 'powder-db/nested/rows.jsonl' });
    const input = screen.getByTestId('assets-import-folder-input') as HTMLInputElement;
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    fireEvent.change(input, { target: { files: [first, second] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/matos/assets/import-upload-folder');
    const body = init.body as FormData;
    expect(JSON.parse(String(body.get('relativePaths')))).toEqual([
      'powder-db/schema.csv',
      'powder-db/nested/rows.jsonl',
    ]);
    expect(body.getAll('files')).toHaveLength(2);
    await waitFor(() => expect((screen.getByTestId('assets-import-source') as HTMLInputElement).value)
      .toBe('/workspace/group/shared/.matos/intake/uploads/folder-test'));
  });
});
