// @vitest-environment jsdom

// Short windows (768p laptops, non-maximized windows) cannot fit every rail
// destination, and the rail column does not scroll with the page — without
// the overflow mode the bottom icons and the whole footer sit below the fold,
// unreachable. These tests pin the measurement-driven contract: the
// `entry-nav-rail--overflow` class appears exactly when the rail's content
// genuinely overflows its box, and the destination list wrapper exists for
// the CSS to promote into a scroll container while brand/"+"/footer stay
// pinned.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';
import { parseRoute } from '../../src/router';



vi.mock('../../src/matos-asset-projects', () => ({
  createMatOSAssetProject: vi.fn(),
}));

const originalResizeObserver = globalThis.ResizeObserver;

type ObserverRecord = {
  callback: ResizeObserverCallback;
  targets: Element[];
};

const observers: ObserverRecord[] = [];
// The rail coalesces observer bursts into one requestAnimationFrame
// measurement per frame, so the test queues frames and drains them
// explicitly after firing the observers.
const rafCallbacks: FrameRequestCallback[] = [];

class ResizeObserverMock {
  private readonly record: ObserverRecord;

  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }

  observe(target: Element) {
    this.record.targets.push(target);
  }

  unobserve() {}

  disconnect() {}
}

beforeEach(() => {
  observers.length = 0;
  rafCallbacks.length = 0;
  globalThis.ResizeObserver = ResizeObserverMock as never;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver;
});

function renderRail() {
  return render(
    <I18nProvider>
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        onClose={() => {}}
      />
    </I18nProvider>,
  );
}

function setMetrics(element: Element, metrics: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(element, 'scrollHeight', {
    value: metrics.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(element, 'clientHeight', {
    value: metrics.clientHeight,
    configurable: true,
  });
}

function flushFrames() {
  // A frame callback can schedule a follow-up frame; drain until quiet.
  for (let i = 0; i < 5 && rafCallbacks.length > 0; i += 1) {
    const callbacks = rafCallbacks.splice(0);
    callbacks.forEach((callback) => callback(performance.now()));
  }
}

function fireResize() {
  act(() => {
    for (const record of observers) {
      record.callback([], record as never);
    }
    flushFrames();
  });
}

describe('EntryNavRail overflow mode', () => {
  it('keeps navigation inside the web workspace even behind a gateway', () => {
    const { queryByTestId } = renderRail();
    expect(queryByTestId('entry-nav-advanced-workspace')).toBeNull();
    expect(queryByTestId('entry-nav-advanced-workspace-phone')).toBeNull();
    for (const view of ['home', 'projects', 'assets', 'workflows']) {
      expect(queryByTestId(`entry-nav-${view}`)).not.toBeNull();
    }
  });

  it('keeps the destination wrapper mounted for the scroll-container CSS hook', () => {
    renderRail();
    const scroller = document.querySelector('.entry-nav-rail__scroll');
    expect(scroller).not.toBeNull();
    // Destinations live inside the scroller; brand, "+" and the footer stay
    // outside so their popovers never get clipped by the scroll container.
    expect(scroller?.querySelector('[data-testid="entry-nav-home"]')).not.toBeNull();
    expect(scroller?.querySelector('[data-testid="entry-nav-integrations"]')).not.toBeNull();
    const rail = document.querySelector('.entry-nav-rail');
    expect(rail?.querySelector('[data-testid="entry-nav-new-project"]')).not.toBeNull();
    expect(scroller?.querySelector('[data-testid="entry-nav-new-project"]')).toBeNull();
    expect(scroller?.querySelector('[data-testid="entry-nav-feedback"]')).toBeNull();
  });

  it('observes both the rail and the destination group for size changes', () => {
    renderRail();
    const targets = observers.flatMap((record) => record.targets);
    expect(targets).toContain(document.querySelector('.entry-nav-rail'));
    expect(targets).toContain(document.querySelector('.entry-nav-rail__group'));
  });

  it('toggles the overflow class from real measurements, with the scroller as the in-mode truth source', () => {
    renderRail();
    const nav = document.querySelector('.entry-nav-rail')!;
    expect(nav.classList.contains('entry-nav-rail--overflow')).toBe(false);

    // Short window: rail content extends past the rail box.
    setMetrics(nav, { scrollHeight: 880, clientHeight: 600 });
    fireResize();
    expect(nav.classList.contains('entry-nav-rail--overflow')).toBe(true);

    // While in overflow mode the nav itself no longer overflows (the scroll
    // container eats the excess), so the scroller decides. Still overflowing:
    const scroller = document.querySelector('.entry-nav-rail__scroll')!;
    setMetrics(nav, { scrollHeight: 600, clientHeight: 600 });
    setMetrics(scroller, { scrollHeight: 560, clientHeight: 320 });
    fireResize();
    expect(nav.classList.contains('entry-nav-rail--overflow')).toBe(true);

    // An exact fit stays in overflow mode: exiting needs ~12px of real slack
    // (hysteresis), or windows whose height lands on the boundary would
    // enter/exit every observer tick.
    setMetrics(scroller, { scrollHeight: 560, clientHeight: 560 });
    fireResize();
    expect(nav.classList.contains('entry-nav-rail--overflow')).toBe(true);

    // Window grows until the list fits with real slack: the mode ends.
    setMetrics(scroller, { scrollHeight: 560, clientHeight: 580 });
    fireResize();
    expect(nav.classList.contains('entry-nav-rail--overflow')).toBe(false);
  });
});
