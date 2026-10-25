// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MatOSUserStats } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { UserProfileView } from '../../src/components/UserProfileView';
import { usageRange, cacheHitShare } from '../../src/components/user-profile-usage';

const original = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = original; vi.restoreAllMocks(); });
function profile(url: string, foreground = 40): MatOSUserStats {
  const params = new URL(url, 'http://local').searchParams;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), timeZone: 'UTC', from: params.get('from')!, to: params.get('to')!,
    coverage: { status: 'recorded-only', unavailableRecords: 3, costStatus: 'unverified-estimate' }, totalTokens: 100,
    foregroundTokens: foreground, backgroundTokens: 60, tokensByKind: { input: 20, output: 20, cacheRead: 60, cacheCreation: 0 },
    peakDayTokens: 100, daily: { [params.get('to')!]: 100 }, activeDays: 1, currentStreakDays: 1, longestStreakDays: 1,
    sessionCount: 1, userMessageCount: 1, toolCallCount: 0, longestTaskMs: 1000, topTools: [], firstActivityAt: null, lastActivityAt: null };
}
function mount() { return render(<I18nProvider initial="en"><UserProfileView /></I18nProvider>); }
test('shows foreground/background, missing-data notice and input-only cache hit rate', async () => {
  globalThis.fetch = vi.fn(async input => Response.json(profile(String(input))));
  mount();
  expect(await screen.findByText('Background self-evolution')).toBeTruthy();
  expect(screen.getByText('75.0%')).toBeTruthy();
  expect(screen.getByText(/Missing historical usage: 3/)).toBeTruthy();
  expect(screen.getByText(/Last 365 days/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Last 7 days' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Last 30 days' })).toBeNull();
  expect(screen.getAllByText('First activity in range')).toHaveLength(2);
});
test('failed fetch offers retry, not misleading zero usage', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 503 }));
  globalThis.fetch = fetcher; mount();
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('Background self-evolution')).toBeNull();
  fireEvent.click(retry); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
test('loads every profile with a fixed 365-day range', async () => {
  const pending: Array<{ url: string; signal: AbortSignal; done: (r: Response) => void }> = [];
  globalThis.fetch = vi.fn((input, init) => new Promise<Response>(done => pending.push({ url: String(input), signal: init!.signal!, done })));
  mount(); await waitFor(() => expect(pending).toHaveLength(1));
  const params = new URL(pending[0]!.url, 'http://local').searchParams;
  expect(params.get('from')).toBe(usageRange(365).from);
  expect(params.get('to')).toBe(usageRange(365).to);
  expect(screen.queryByRole('button', { name: 'Last 7 days' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Last 30 days' })).toBeNull();
  await act(async () => { pending[0]!.done(Response.json(profile(pending[0]!.url, 77))); });
  expect(await screen.findByText('77')).toBeTruthy();
});
test('range boundaries use UTC and cache rate excludes output', () => {
  expect(usageRange(7, new Date('2026-09-14T23:30:00-07:00'))).toEqual({ from: '2026-09-09', to: '2026-09-15' });
  expect(usageRange(365, new Date('2026-09-14T23:30:00-07:00'))).toEqual({ from: '2025-09-16', to: '2026-09-15' });
  expect(cacheHitShare(profile('/?from=2026-09-01&to=2026-09-14'))).toBe(0.75);
});
