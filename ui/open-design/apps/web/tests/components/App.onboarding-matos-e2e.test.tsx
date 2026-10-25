// @vitest-environment jsdom
//
// High-fidelity integration test for the MatOS first-run onboarding -> home
// agent-selection path. On a MatOS gateway deployment the runtime is already
// provisioned, so onboarding orients the user and adopts the `matos` agent
// instead of running the upstream AMR cloud sign-in wizard. This mounts the
// REAL `App` with the REAL router and REAL EntryView/MatOSOnboardingView, so
// the App-level config lifecycle + auto-select interact exactly as in
// production: completing onboarding must land on home with the `matos` agent
// selected, not clobbered back to the Claude default by the App-level
// auto-select effect. Only the daemon/provider boundary is mocked.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig } from '../../src/types';
import { loadConfig, fetchDaemonConfig, saveConfig } from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, listProjects: vi.fn(), listTemplates: vi.fn() };
});

// Keep the REAL mergeDaemonConfig/loadConfig logic; only stub the network
// writes and the daemon GET so we can drive a deterministic first-run.
vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    loadConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn().mockResolvedValue({ status: 'ok', providers: null }),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
    saveConfig: vi.fn(),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignTemplates = vi.mocked(fetchDesignTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedSaveConfig = vi.mocked(saveConfig);

const claudeAgent = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
};
const matosAgent = {
  id: 'matos',
  name: 'MatOS',
  bin: 'matos',
  available: true,
  version: '1.0.0',
  models: [{ id: 'deepseek-chat', label: 'DeepSeek' }],
};

function firstRunConfig(): AppConfig {
  return {
    agentId: null,
    skillId: null,
    onboardingCompleted: false,
    mediaProviders: {},
    agentModels: {},
    agentCliEnv: {},
  } as AppConfig;
}

beforeEach(() => {
  // jsdom polyfills the full EntryView tree expects.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const win = window as unknown as Record<string, unknown>;
  win.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  win.IntersectionObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  window.scrollTo = window.scrollTo || (() => {});
  window.history.replaceState(null, '', '/');

  mockedDaemonIsLive.mockResolvedValue(true);
  // On a MatOS gateway deployment both the preprovisioned `matos` runtime and
  // the legacy Claude CLI are detected. Onboarding adopts `matos`.
  mockedFetchAgentsStream.mockResolvedValue([{ ...matosAgent }, { ...claudeAgent }]);
  mockedFetchSkills.mockResolvedValue([]);
  mockedFetchDesignTemplates.mockResolvedValue([]);
  mockedFetchAppVersionInfo.mockResolvedValue(null);
  mockedListProjects.mockResolvedValue([]);
  mockedListTemplates.mockResolvedValue([]);
  mockedLoadConfig.mockReturnValue(firstRunConfig());
  mockedFetchDaemonConfig.mockResolvedValue({});

  // MatOS onboarding does no cloud sign-in; a permissive JSON stub is enough
  // for the incidental daemon polls made by the shell.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MatOS onboarding -> home (end to end)', () => {
  it('lands on home with the matos runtime selected after finishing onboarding', async () => {
    render(<App />);

    // Bootstrap routes a first-run user into the MatOS welcome. It has no
    // provider wizard — just orientation cards plus a primary "start" action.
    const startButton = await screen.findByTestId('matos-onboarding-start', undefined, {
      timeout: 10000,
    });
    fireEvent.click(startButton);

    // Onboarding is dismissed and we leave the welcome for the app shell.
    await waitFor(() => {
      expect(screen.queryByTestId('matos-onboarding')).toBeNull();
    });

    // The onboarding adopted the preprovisioned `matos` runtime and persisted
    // it — and the App-level auto-select must NOT have clobbered that pick back
    // to the Claude default (the historical onboarding->home regression).
    await waitFor(() => {
      const wroteMatos = mockedSaveConfig.mock.calls.some(
        ([cfg]) => (cfg as AppConfig | undefined)?.agentId === 'matos',
      );
      expect(wroteMatos).toBe(true);
    });
    const wroteClaude = mockedSaveConfig.mock.calls.some(
      ([cfg]) => (cfg as AppConfig | undefined)?.agentId === 'claude',
    );
    expect(wroteClaude).toBe(false);
    // Lazy-loaded onboarding + full App bootstrap can exceed the default 5s
    // test budget in slower jsdom runs.
  }, 20000);
});
