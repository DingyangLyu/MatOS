// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

vi.mock('../../src/components/workflow-studio/WorkflowStudio', () => ({
  WorkflowsView: ({ runId }: { runId?: string }) => <section data-testid="workflows-content">{runId}</section>,
}));

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function amrAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'amr',
    name: 'AMR',
    bin: 'amr',
    available: true,
    models: [{ id: 'amr-model', label: 'AMR Model' }],
    ...overrides,
  };
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agentId: null,
    agentModels: {},
    ...overrides,
  } as AppConfig;
}

function renderOnboarding(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/onboarding');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    projects: [],
    templates: [],
    config: baseConfig(),
    agents: [amrAgent(), cliAgent()],
    daemonLive: true,
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [amrAgent(), cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  function Harness() {
    const [config, setConfig] = useState(props.config);
    return (
      <I18nProvider initial="en">
        <EntryShell
          {...props}
          config={config}
          onConfigPersist={(next) => {
            props.onConfigPersist(next);
            setConfig(next as AppConfig);
          }}
        />
      </I18nProvider>
    );
  }

  render(
    <Harness />,
  );

  return props;
}

function renderHome(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
  path = '/',
) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    projects: [],
    templates: [],
    config: baseConfig({
      agentId: 'claude-code',
      agentModels: { 'claude-code': { model: 'sonnet' } },
      theme: 'system',
    }),
    agents: [cliAgent()],
    daemonLive: true,
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

function chooseOnboardingOption(label: string, option: string | RegExp) {
  const chipField = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-chip-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (chipField) {
    const matcher = option instanceof RegExp ? option : new RegExp(option, 'i');
    const chip = Array.from(chipField.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      matcher.test(button.textContent ?? ''),
    );
    if (!(chip instanceof HTMLButtonElement)) {
      throw new Error(`profile chip not found: ${label} / ${String(option)}`);
    }
    fireEvent.click(chip);
    return;
  }

  const dropdownField = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-view__select-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (!dropdownField) throw new Error(`profile field not found: ${label}`);
  const trigger = dropdownField.querySelector('button');
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`profile field trigger not found: ${label}`);
  }
  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole('option', {
      name: option instanceof RegExp ? option : new RegExp(option, 'i'),
    }),
  );
}

async function clickSignedInCloudContinue() {
  const continueButton = await screen.findByRole('button', { name: /Continue \(signed in\)/i });
  fireEvent.click(continueButton);
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
  });
}

async function clickCloudSignIn() {
  const signIn = await findCloudSignInButton();
  fireEvent.click(signIn);
  return signIn;
}

async function findCloudSignInButton() {
  return screen.findByRole('button', { name: /Sign in to MatOS\.ai/i });
}

function openLocalRuntimeSetup() {
  expect(screen.getByRole('heading', { name: 'Sign in to MatOS.ai' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Local coding agent/i }));
  expect(screen.getByText('Local CLI')).toBeTruthy();
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  vi.useRealTimers();
  window.sessionStorage.clear();
});

// Transform the actual lazy views before timing user interactions. Cold Vite
// compilation on shared storage is not a browser interaction timeout.
beforeAll(async () => {
  await Promise.all([import('../../src/components/HomeView'), import('../../src/components/DesignsTab')]);
}, 120_000);

beforeEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
});

describe('EntryShell settings menu', () => {
  it('opens quick actions before opening the full settings dialog', async () => {
    const props = renderHome();

    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    expect(props.onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    // MatOS: the upstream community rows (Discord online count, X /
    // Threads / YouTube follow links) are removed from the quick menu.
    expect(screen.queryByRole('menuitem', { name: /Join Discord/i })).toBeNull();
    expect(screen.queryByText(/online/i)).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /on X/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Threads/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /YouTube/i })).toBeNull();

    fireEvent.click(screen.getByTestId('entry-settings-open-details'));

    expect(props.onOpenSettings).toHaveBeenCalledWith();
  });
});

describe('EntryShell new project rail', () => {
  it('opens workflows within the existing workbench navigation', async () => {
    renderHome({}, '/projects');
    fireEvent.click(screen.getByTestId('entry-nav-workflows'));
    await screen.findByTestId('workflows-content');
    expect(window.location.pathname).toBe('/workflows');
    expect(screen.getByTestId('entry-nav-workflows').className).toContain('is-active');
    expect(screen.getByTestId('workflows-content').closest('.entry-shell')).not.toBeNull();
    expect(screen.getByTestId('entry-rail-toggle')).toBeTruthy();
  });

  it('keeps the workbench navigation active on a workflow run deep link', async () => {
    renderHome({}, '/workflows/runs/run-deep-link');
    expect((await screen.findByTestId('workflows-content')).textContent).toBe('run-deep-link');
    expect(screen.getByTestId('entry-nav-workflows').className).toContain('is-active');
  });

  it('keeps the docked entry rail navigation clickable after opening it', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/community/discord')) {
        return jsonResponse({ stale: true });
      }
      if (url.endsWith('/api/github/open-design')) {
        return jsonResponse({ stale: true });
      }
      return jsonResponse({});
    }) as typeof fetch;

    renderHome({}, '/projects');

    fireEvent.click(screen.getByTestId('entry-rail-toggle'));
    fireEvent.click(screen.getByTestId('entry-nav-assets'));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/assets');
    });
    expect(screen.getByTestId('entry-nav-assets').className).toContain('is-active');
  });

  it('creates a blank project directly from the rail plus', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.endsWith('/api/projects') && init?.method === 'POST') {
          return jsonResponse({
            project: {
              id: 'blank-project-1',
              name: 'Untitled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            conversationId: 'conversation-1',
          });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderHome();

    fireEvent.click(screen.getByTestId('entry-rail-toggle'));
    // The rail plus now opens a create menu (project + asset drafts);
    // "New project" is the first menu entry.
    fireEvent.click(screen.getByTestId('entry-nav-new-project'));
    fireEvent.click(await screen.findByTestId('create-menu-project'));

    // The no-tab create path opens the MatOS project form (mission + member
    // roster + working folder), not the legacy OD tabs panel. It is a lazy
    // Suspense chunk; its first cold import() under full-suite transform
    // pressure can exceed waitFor's 1s default (same headroom as the
    // home-hero-input wait below).
    await screen.findByTestId('matos-new-project-modal', undefined, { timeout: 12000 });
    expect(screen.getByTestId('matos-np-name')).toBeTruthy();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/projects' && init?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
  });

  it('opens the new project modal from the Projects tab button', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url === '/api/projects' && init?.method === 'POST') {
          return jsonResponse({
            project: {
              id: 'blank-project-from-projects',
              name: 'Untitled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            conversationId: 'conversation-2',
          });
        }
        if (url.endsWith('/api/projects/project-existing/files')) {
          return jsonResponse({ files: [] });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderHome({
      projects: [
        {
          id: 'project-existing',
          name: 'Existing project',
          skillId: null,
          createdAt: 1,
          updatedAt: 2,
          status: { value: 'not_started' },
        },
      ],
    });

    fireEvent.click(screen.getByTestId('entry-rail-toggle'));
    fireEvent.click(screen.getByTestId('entry-nav-projects'));
    fireEvent.click(await screen.findByTestId('designs-new-project', undefined, { timeout: 12000 }));

    // Projects-tab "New project" also goes through the no-tab path → MatOS form.
    await waitFor(() => {
      expect(screen.getByTestId('matos-new-project-modal')).toBeTruthy();
    });
    expect(screen.getByTestId('matos-np-name')).toBeTruthy();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/projects' && init?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
  });
});

describe('EntryShell Home submit handoff', () => {
  it('adds the selected MatOS role to the new project roster', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      if (url.endsWith('/api/community/discord')) return jsonResponse({ stale: true });
      if (url.endsWith('/api/github/open-design')) return jsonResponse({ stale: true });
      return jsonResponse({});
    }) as typeof fetch;
    const onCreateProject = vi.fn(async (
      _input: Parameters<React.ComponentProps<typeof EntryShell>['onCreateProject']>[0],
    ) => true);
    renderHome({
      config: baseConfig({
        agentId: 'matos',
        agentModels: { matos: { model: 'role:deep-research' } },
        theme: 'system',
      }),
      agents: [{
        id: 'matos',
        name: 'MatOS',
        bin: 'matos',
        available: true,
        models: [
          { id: 'role:compute', label: 'Compute' },
          { id: 'role:deep-research', label: 'Deep Research' },
        ],
      }],
      onCreateProject,
    });

    await screen.findByTestId('home-hero-input', undefined, { timeout: 12000 });
    await setHomeHeroPrompt('请研究镍基合金，这是一段不应该成为项目名称的中文需求');
    fireEvent.click(await screen.findByTestId('home-hero-submit'));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      name: 'Untitled project',
      pendingPrompt: '请研究镍基合金，这是一段不应该成为项目名称的中文需求',
      metadata: expect.objectContaining({
        nameSource: 'untitled',
        members: ['role:deep-research'],
        matosActiveRoleRef: 'role:deep-research',
      }),
    }));
  }, 20000);

  it('keeps the Home run button in sending state until project creation resolves', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      if (url.endsWith('/api/community/discord')) return jsonResponse({ stale: true });
      if (url.endsWith('/api/github/open-design')) return jsonResponse({ stale: true });
      return jsonResponse({});
    }) as typeof fetch;
    let resolveCreate: (accepted: boolean) => void = () => undefined;
    const onCreateProject = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveCreate = resolve; }),
    );
    renderHome({ onCreateProject });

    // HomeView is lazy-loaded plus data-gated; give the suspense chunk
    // room to resolve in slower jsdom runs. Under full-suite transform load the
    // cold import() can exceed 5s, so this poll needs real headroom.
    await screen.findByTestId('home-hero-input', undefined, { timeout: 12000 });
    setHomeHeroPrompt('Build a landing page');
    const submit = await screen.findByTestId('home-hero-submit') as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Sending…');

    resolveCreate(true);
    await waitFor(() => expect(submit.disabled).toBe(false));
    // HomeView is a lazy Suspense chunk; the cold import() can exceed the 5s
    // default under full-suite transform load, so widen this one.
  }, 20000);
});

// MatOS: the upstream runtime-connection onboarding wizard (AMR cloud
// sign-in, local CLI scan, BYOK setup, newsletter, about-you) is unrouted —
// /onboarding renders the MatOS first-run welcome (MatOSOnboardingView)
// because gateway deployments preprovision the matos runtime. These specs
// lock that replacement: the welcome renders orientation cards, adopts the
// matos runtime on completion, and none of the wizard surfaces come back.
describe('EntryShell onboarding (MatOS first-run welcome)', () => {
  function matosAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
    return {
      id: 'matos',
      name: 'MatOS',
      bin: 'matos',
      available: true,
      models: [],
      ...overrides,
    };
  }

  it('renders the MatOS welcome instead of the upstream sign-in wizard', async () => {
    renderOnboarding({ agents: [matosAgent(), cliAgent()] });

    expect(await screen.findByTestId('matos-onboarding')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Welcome to MatOS.ai' })).toBeTruthy();
    expect(screen.getByTestId('matos-onboarding-start')).toBeTruthy();
    expect(screen.queryByTestId('matos-onboarding-workspace')).toBeNull();

    // Upstream wizard surfaces must stay unrouted.
    expect(screen.queryByRole('heading', { name: 'Sign in to MatOS.ai' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign in to MatOS\.ai/i })).toBeNull();
    expect(screen.queryByText('Use a local CLI or your own API key')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Design AMR/i })).toBeNull();
  });

  it('completes onboarding and adopts the preprovisioned matos runtime from Start', async () => {
    const props = renderOnboarding({ agents: [matosAgent(), cliAgent()] });

    fireEvent.click(await screen.findByTestId('matos-onboarding-start'));

    expect(props.onAgentChange).toHaveBeenCalledWith('matos');
    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('routes capability cards through onboarding completion', async () => {
    const props = renderOnboarding({ agents: [matosAgent(), cliAgent()] });

    fireEvent.click(await screen.findByTestId('matos-onboarding-card-assets'));

    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/assets');
    });
  });

  it('does not adopt the matos runtime when it is not in the agent list', async () => {
    const props = renderOnboarding({ agents: [cliAgent()] });

    fireEvent.click(await screen.findByTestId('matos-onboarding-start'));

    expect(props.onAgentChange).not.toHaveBeenCalled();
    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
  });
});
