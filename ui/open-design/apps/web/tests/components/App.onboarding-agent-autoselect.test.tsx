// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig } from '../../src/types';
import { loadConfig, mergeDaemonConfig, fetchDaemonConfig } from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'home' as const }),
}));

// Minimal EntryView that surfaces the agent selection + onboarding state so
// the test can observe whether the App-level auto-select fired.
vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ config }: { config: AppConfig }) => (
    <>
      <div data-testid="agent-id">{config.agentId ?? 'none'}</div>
      <div data-testid="onboarding-completed">
        {String(config.onboardingCompleted)}
      </div>
    </>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    loadConfig: vi.fn(),
    // Use the real merge so onboardingCompleted / agentId flow exactly as in
    // production from the daemon config.
    mergeDaemonConfig: vi.fn(actual.mergeDaemonConfig),
    saveConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn().mockResolvedValue({
      status: 'ok',
      providers: null,
    }),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);

function firstRunConfig(): AppConfig {
  return {
    agentId: null,
    skillId: null,
    // First run: the user has NOT finished onboarding yet. Onboarding owns
    // the agent pick.
    onboardingCompleted: false,
    mediaProviders: {},
    agentModels: {},
    agentCliEnv: {},
  };
}

// Only Claude is detected on the first agent probe. Onboarding chooses the
// runtime, so the App-level fallback must not snap the agent to Claude.
const claudeOnly = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
  },
];

describe('App first-run agent auto-select', () => {
  beforeEach(() => {
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([...claudeOnly]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListProjects.mockResolvedValue([]);
    mockedListTemplates.mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not render the Home entry before first-run onboarding routing is known', async () => {
    let resolveDaemonConfig!: (value: {}) => void;
    mockedLoadConfig.mockReturnValue(firstRunConfig());
    mockedFetchDaemonConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveDaemonConfig = resolve;
      }),
    );

    render(<App />);

    expect(screen.queryByTestId('agent-id')).toBeNull();
    expect(screen.getByText('Loading workspace…')).toBeTruthy();

    resolveDaemonConfig({});
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-completed').textContent).toBe('false');
    });
  });

  it('does not auto-pick a default agent while first-run onboarding is in progress', async () => {
    const { syncConfigToDaemon } = await import('../../src/state/config');
    const mockedSync = vi.mocked(syncConfigToDaemon);
    mockedLoadConfig.mockReturnValue(firstRunConfig());
    // Daemon has nothing persisted yet (fresh install): no agentId, onboarding
    // not completed.
    mockedFetchDaemonConfig.mockResolvedValue({});

    render(<App />);

    // Once the daemon config + the Claude-only agent list have both landed,
    // the App-level auto-select effect is eligible to run. During first-run
    // onboarding it must stay its hand — the onboarding flow owns the first
    // agent pick — so the agent slot stays empty rather than snapping to
    // Claude and racing the onboarding's own runtime selection.
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-completed').textContent).toBe('false');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('agent-id').textContent).toBe('none');
    // And it must not have persisted a Claude default to the daemon, which is
    // what later clobbers the runtime pick on the next launch.
    const wroteClaude = mockedSync.mock.calls.some(
      ([cfg]) => (cfg as AppConfig | undefined)?.agentId === 'claude',
    );
    expect(wroteClaude).toBe(false);
  });

  it('auto-picks the first available agent once onboarding is complete', async () => {
    mockedLoadConfig.mockReturnValue({
      ...firstRunConfig(),
      onboardingCompleted: true,
    });
    mockedFetchDaemonConfig.mockResolvedValue({ onboardingCompleted: true });

    render(<App />);

    // Returning user with an empty agent slot: the fallback should still fill
    // it with the first available agent.
    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('claude');
    });
  });
});
