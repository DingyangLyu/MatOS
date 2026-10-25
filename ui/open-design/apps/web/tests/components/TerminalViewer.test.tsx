// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalViewer } from '../../src/components/workspace/TerminalViewer';
import { I18nProvider } from '../../src/i18n';

const { terminalOptions } = vi.hoisted(() => ({
  terminalOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};

    constructor(options: Record<string, unknown>) {
      terminalOptions.push(options);
      this.options = options;
    }

    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('../../src/state/projects', () => ({
  createTerminal: vi.fn(),
  killTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  sendTerminalStdin: vi.fn(),
  terminalStreamUrl: vi.fn(
    (projectId: string, terminalId: string) =>
      `/api/projects/${projectId}/terminals/${terminalId}/stream`,
  ),
}));

class StubEventSource {
  static CLOSED = 2;

  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener() {}

  close() {
    this.readyState = StubEventSource.CLOSED;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('EventSource', StubEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  terminalOptions.length = 0;
});

describe('TerminalViewer', () => {
  it('shows localized loading copy while the initial terminal connection is pending', () => {
    render(
      <I18nProvider initial="zh-CN">
        <TerminalViewer terminalId="term-1" projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    const loading = screen.getByTestId('terminal-loading');
    expect(loading.textContent).toContain('正在启动项目终端…');
    expect(loading.textContent).toContain('正在连接项目目录，通常只需几秒。');
    expect(loading.textContent).toContain('matos shell');
  });

  it('uses compact xterm sizing on phone-width viewports', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 640px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    render(
      <I18nProvider initial="zh-CN">
        <TerminalViewer terminalId="term-1" projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(terminalOptions).toHaveLength(1);
    });
    expect(terminalOptions[0]?.fontSize).toBe(12);
  });
});
