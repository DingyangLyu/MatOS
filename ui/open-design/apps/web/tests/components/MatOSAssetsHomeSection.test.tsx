// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMatOSAssets } = vi.hoisted(() => ({
  fetchMatOSAssets: vi.fn(),
}));

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/runtime/matos-assets', () => ({
  fetchMatOSAssets,
  getCachedMatOSAssets: () => undefined,
}));

import { MatOSAssetsHomeSection } from '../../src/components/MatOSAssetsHomeSection';

afterEach(() => {
  cleanup();
  fetchMatOSAssets.mockReset();
  vi.unstubAllGlobals();
});

describe('MatOSAssetsHomeSection', () => {
  it.each([
    ['an empty MatOS scope', () => Promise.resolve([])],
    ['a failed MatOS asset request', () => Promise.reject(new Error('registry unavailable'))],
  ])('fails closed for %s instead of rendering Open Design content', async (_name, load) => {
    fetchMatOSAssets.mockImplementationOnce(load);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    render(<MatOSAssetsHomeSection />);

    await waitFor(() => expect(screen.getByText('assets.empty')).toBeTruthy());
    expect(screen.getByTestId('matos-assets-home')).toBeTruthy();
    expect(screen.queryByText(/community/i)).toBeNull();
  });
});
