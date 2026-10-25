// @vitest-environment jsdom

// The "Register dataset" panel is a thin form over
// POST /api/matos/assets/register-data: it must auto-slug the asset id from
// the name, require at least one source of truth (DOI/URL/path), and hand the
// unversioned ref to the caller after the daemon confirms registration.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterDataPanel } from '../../src/components/AssetsView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RegisterDataPanel', () => {
  it('auto-slugs the id, requires a source, and reports the registered ref', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, ref: 'data:her-pt-cations@1.0.0' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRegistered = vi.fn();

    render(<RegisterDataPanel onRegistered={onRegistered} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('assets-register-data-name'), {
      target: { value: 'HER Pt Cations!' },
    });
    expect((screen.getByPlaceholderText('her-pt-cations') as HTMLInputElement).value).toBe(
      'her-pt-cations',
    );

    // No DOI/URL/path yet: submit must stop with the needSource message.
    fireEvent.click(screen.getByTestId('assets-register-data-submit'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/DOI, source URL, or payload path/)).toBeTruthy();

    fireEvent.change(screen.getByTestId('assets-register-data-doi'), {
      target: { value: '10.5281/zenodo.7026971' },
    });
    fireEvent.click(screen.getByTestId('assets-register-data-submit'));

    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith('data:her-pt-cations'));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.id).toBe('her-pt-cations');
    expect(payload.doi).toBe('10.5281/zenodo.7026971');
  });
});
