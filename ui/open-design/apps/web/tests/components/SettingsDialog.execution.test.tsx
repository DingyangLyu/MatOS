// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { en } from '../../src/i18n/locales/en';

const {
  playSoundMock,
  requestNotificationPermissionMock,
  showCompletionNotificationMock,
  notificationPermissionMock,
  fetchSkillsMock,
  fetchSkillMock,
  openExternalUrlMock,
} = vi.hoisted(() => ({
  playSoundMock: vi.fn(),
  requestNotificationPermissionMock: vi.fn(),
  showCompletionNotificationMock: vi.fn(),
  notificationPermissionMock: vi.fn(),
  fetchSkillsMock: vi.fn(),
  fetchSkillMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
}));

vi.mock('../../src/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/notifications')>(
    '../../src/utils/notifications',
  );
  return {
    ...actual,
    playSound: playSoundMock,
    requestNotificationPermission: requestNotificationPermissionMock,
    showCompletionNotification: showCompletionNotificationMock,
    notificationPermission: notificationPermissionMock,
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchSkills: fetchSkillsMock,
    fetchSkill: fetchSkillMock,
    openExternalUrl: openExternalUrlMock,
  };
});

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { IntegrationsView } from '../../src/components/IntegrationsView';
import type { AgentRefreshOptions, SettingsSection } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { LOCALES } from '../../src/i18n/types';
import type { AgentInfo, AppConfig, AppVersionInfo } from '../../src/types';

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const availableAgents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.80.0',
    models: [{ id: 'default', label: 'Default' }],
  },
];

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
  supportsCustomModel: false,
};

type OnRefreshAgents = (
  options?: AgentRefreshOptions,
) => void | AgentInfo[] | Promise<void | AgentInfo[]>;

const sampleSkills = [
  {
    id: 'blog-post',
    name: 'blog-post',
    description: 'A long-form article / blog post.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'dashboard',
    name: 'dashboard',
    description: 'Admin / analytics dashboard.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'sales-deck',
    name: 'sales-deck',
    description: 'A narrative sales presentation.',
    mode: 'deck',
    previewType: 'PPTX',
  },
];


let restoreOpenDesignHost: (() => void) | null = null;


function renderSettingsDialog(
  initial: Partial<AppConfig> = {},
  options: {
    agents?: AgentInfo[];
    daemonLive?: boolean;
    onRefreshAgents?: OnRefreshAgents;
    initialSection?: SettingsSection;
    appVersionInfo?: AppVersionInfo | null;
    welcome?: boolean;
  } = {},
) {
  const onPersist = vi.fn();
  const onClose = vi.fn();
  const onRefreshAgents = options.onRefreshAgents ?? vi.fn<OnRefreshAgents>();

  const view = render(
    <SettingsDialog
      initial={{ ...baseConfig, ...initial }}
      agents={options.agents ?? availableAgents}
      daemonLive={options.daemonLive ?? true}
      appVersionInfo={options.appVersionInfo ?? null}
      initialSection={options.initialSection ?? 'execution'}
      welcome={options.welcome}
      onPersist={onPersist}
      onClose={onClose}
      onRefreshAgents={onRefreshAgents}
    />,
  );

  return { onPersist, onClose, onRefreshAgents, ...view };
}

function renderIntegrationsView(
  initial: Partial<AppConfig> = {},
  options: {
    initialTab?: 'mcp' | 'use-everywhere';
  } = {},
) {
  const onConfigPersist = vi.fn();
  const view = render(
    <IntegrationsView
      config={{ ...baseConfig, ...initial }}
      initialTab={options.initialTab ?? 'mcp'}
      onConfigPersist={onConfigPersist}
    />,
  );

  return { onConfigPersist, ...view };
}

function renderLanguageSettingsDialog(initialLocale: Parameters<typeof I18nProvider>[0]['initial'] = 'en') {
  const onPersist = vi.fn();
  const onClose = vi.fn();

  render(
    <I18nProvider initial={initialLocale}>
      <SettingsDialog
        initial={baseConfig}
        agents={availableAgents}
        daemonLive={true}
        appVersionInfo={null}
        initialSection="language"
        onPersist={onPersist}
        onClose={onClose}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );

  return { onPersist, onClose };
}

async function waitForPersist(
  onPersist: ReturnType<typeof vi.fn>,
  expectedConfig: unknown,
  expectedOptions: { forceMediaProviderSync?: boolean } = { forceMediaProviderSync: false },
) {
  await waitFor(() => {
    expect(onPersist).toHaveBeenCalledWith(
      expectedConfig,
      expect.objectContaining(expectedOptions),
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  playSoundMock.mockReset();
  requestNotificationPermissionMock.mockReset();
  showCompletionNotificationMock.mockReset();
  notificationPermissionMock.mockReset();
  fetchSkillsMock.mockReset();
  fetchSkillMock.mockReset();
  openExternalUrlMock.mockReset();
  notificationPermissionMock.mockReturnValue('default');
  requestNotificationPermissionMock.mockResolvedValue('granted');
  showCompletionNotificationMock.mockResolvedValue('shown');
  fetchSkillsMock.mockResolvedValue(sampleSkills);
  fetchSkillMock.mockImplementation(async (id: string) => ({
    id,
    body: `skill body for ${id}`,
  }));
  openExternalUrlMock.mockResolvedValue(true);
});

afterEach(() => {
  restoreOpenDesignHost?.();
  restoreOpenDesignHost = null;
});


// The settings nav also contains a "MatOS as MCP server" item whose label and
// hint match a bare /^MatOS\b/ button query, so scope AMR-card lookups to the
// card itself — still asserting the card's visible branding is "MatOS".
function amrCardSelectButton() {
  return within(screen.getByTestId('settings-agent-card-amr')).getByRole('button', {
    name: /^MatOS\b/,
  });
}

describe('SettingsDialog execution settings Local CLI interactions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets users select an installed agent and autosave', async () => {
    const installed = availableAgents[0]!;
    const unavailable: AgentInfo = {
      id: 'kimi',
      name: 'Kimi CLI',
      bin: 'kimi',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/MoonshotAI/kimi-cli',
      docsUrl: 'https://www.kimi.com/code/docs/en/kimi-cli/guides/getting-started.html?aff=open-design',
    };
    const { onPersist } = renderSettingsDialog(
      { agentId: null },
      { agents: [installed, unavailable] },
    );


    expect(screen.getByText('Your CLIs (1)')).toBeTruthy();
    const installGroupSummary = screen.getByText('Available to install (1)');
    expect(installGroupSummary.closest('details')?.hasAttribute('open')).toBe(false);
    const codexCard = screen.getByRole('button', { name: /Codex CLI/i }) as HTMLButtonElement;
    fireEvent.click(installGroupSummary);
    const kimiGroup = screen.getByRole('group', { name: /Kimi CLI/i });
    expect(within(kimiGroup).getByText('Moonshot Kimi CLI')).toBeTruthy();
    expect(
      (within(kimiGroup).getByRole('link', { name: en['settings.agentInstall.install'] }) as HTMLAnchorElement).getAttribute('href'),
    ).toBe(
      'https://github.com/MoonshotAI/kimi-cli',
    );
    expect(
      screen.getByText(en['settings.agentInstall.stepAuth']),
    ).toBeTruthy();
    expect(
      screen.getByText(en['settings.agentInstall.stepSelect']),
    ).toBeTruthy();
    expect(screen.getByText(en['settings.agentInstall.pathHint'])).toBeTruthy();

    fireEvent.click(codexCard);
    const selectedCard = codexCard.closest('.agent-card') as HTMLElement;
    expect(
      within(selectedCard).getByRole('combobox', {
        name: en['settings.modelPicker'],
      }),
    ).toBeTruthy();
    expect(
      selectedCard.compareDocumentPosition(installGroupSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitForPersist(
      onPersist,
      expect.objectContaining({
        agentId: 'codex',
      }),
      {},
    );
  });

  it('filters long Local CLI model lists in Settings without hiding the current selection', () => {
    renderSettingsDialog(
      { agentId: 'codex', agentModels: { codex: { model: 'gpt-4.1-mini' } } },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
              { id: 'gpt-4.1', label: 'gpt-4.1' },
              { id: 'gpt-5.5', label: 'gpt-5.5' },
              { id: 'o4-mini', label: 'o4-mini' },
              { id: 'o3', label: 'o3' },
              { id: 'o1', label: 'o1' },
              { id: 'gpt-4o', label: 'gpt-4o' },
              { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            ],
          },
        ],
      },
    );

    const codexCard = screen.getByRole('button', { name: /Codex CLI/i });
    fireEvent.click(codexCard);

    const modelPicker = screen.getByRole('combobox', {
      name: en['settings.modelPicker'],
    });
    fireEvent.click(modelPicker);

    const searchInput = screen.getByTestId('settings-agent-model-search-codex') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: '5.5' } });

    const modelPopover = screen.getByTestId('settings-agent-model-popover-codex');
    expect(
      within(modelPopover).getAllByRole('option').map((option) => option.textContent?.trim()),
    ).toEqual(['gpt-4.1-mini', 'gpt-5.5', 'Custom (type below)…']);
  });

  it('labels live CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'gpt-6-codex', label: 'GPT-6 Codex' },
            ],
          },
        ],
      },
    );

    expect(screen.getByText('Live from CLI')).toBeTruthy();
    expect(
      screen.getByText(/Model list comes from this CLI/i),
    ).toBeTruthy();
  });

  it('labels fallback CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'fallback',
          },
        ],
      },
    );

    expect(screen.getByText('Built-in list')).toBeTruthy();
    expect(
      screen.getByText(/Showing built-in defaults/i),
    ).toBeTruthy();
  });

  it('shows an empty state when no local CLI agents are detected', () => {
    renderSettingsDialog(
      { agentId: null },
      { agents: [] },
    );

    expect(screen.getByText(/No agents detected yet/i)).toBeTruthy();
  });


  it('shows rescan loading, avoids duplicate rescans, and renders the success notice', async () => {
    const nextAgents: AgentInfo[] = [
      availableAgents[0]!,
      {
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        available: true,
        version: '1.2.3',
        models: [{ id: 'default', label: 'Default' }],
      },
    ];
    const pending = deferred<AgentInfo[]>();
    const onRefreshAgents = vi.fn(() => pending.promise);

    renderSettingsDialog(
      { agentId: 'codex' },
      { agents: availableAgents, onRefreshAgents },
    );

    const rescanButton = screen.getByRole('button', { name: /Rescan|Scanning/i }) as HTMLButtonElement;

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);
    expect(onRefreshAgents).toHaveBeenCalledWith({
      throwOnError: true,
      agentCliEnv: {},
    });
    expect(rescanButton.disabled).toBe(true);
    expect(screen.getByText('Scanning...')).toBeTruthy();

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);

    pending.resolve(nextAgents);

    await waitFor(() => {
      expect(screen.getByText('Scan complete. 2 available.')).toBeTruthy();
      expect((screen.getByRole('button', { name: /Rescan/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('renders an error notice when rescan fails', async () => {
    const onRefreshAgents = vi.fn(async () => {
      throw new Error('boom');
    });

    renderSettingsDialog(
      { agentId: 'codex' },
      { agents: availableAgents, onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('button', { name: /Rescan/i }));

    await waitFor(() => {
      expect(screen.getByText('Scan failed. Check the daemon and try again.')).toBeTruthy();
    });
  });

  it('renders diagnostics and fix actions on installed agents with auth failures', async () => {
    const docsUrl = 'https://docs.example.com/codex-auth';
    const authMissingAgent: AgentInfo = {
      ...availableAgents[0]!,
      authStatus: 'missing',
      authMessage: 'Codex CLI is installed but not authenticated.',
      docsUrl,
      diagnostics: [
        {
          reason: 'auth-missing',
          severity: 'error',
          message: 'Codex CLI is installed but not authenticated.',
          fixActions: [{ kind: 'openDocs' }, { kind: 'rescan' }],
        },
      ],
    };
    const onRefreshAgents = vi.fn(async () => [authMissingAgent]);

    renderSettingsDialog(
      { agentId: 'codex' },
      { agents: [authMissingAgent], onRefreshAgents },
    );

    const codexCard = screen.getByRole('button', { name: /Codex CLI/i })
      .closest('.agent-card') as HTMLElement;

    expect(
      within(codexCard).getByText('Codex CLI is installed but not authenticated.'),
    ).toBeTruthy();

    fireEvent.click(within(codexCard).getByRole('button', {
      name: en['settings.agentInstall.docs'],
    }));
    expect(openExternalUrlMock).toHaveBeenCalledWith(docsUrl);

    fireEvent.click(within(codexCard).getByRole('button', {
      name: en['settings.rescan'],
    }));
    await waitFor(() => {
      expect(onRefreshAgents).toHaveBeenCalledWith({
        throwOnError: true,
        agentCliEnv: {},
      });
    });
  });

  it('rescans automatically when returning after opening an install link', async () => {
    const unavailable: AgentInfo = {
      id: 'kimi',
      name: 'Kimi CLI',
      bin: 'kimi',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/MoonshotAI/kimi-cli',
    };
    const onRefreshAgents = vi.fn(async () => availableAgents);

    renderSettingsDialog(
      { agentId: 'codex' },
      { agents: [availableAgents[0]!, unavailable], onRefreshAgents },
    );

    fireEvent.click(screen.getByText('Available to install (1)'));
    fireEvent.click(screen.getByRole('link', { name: en['settings.agentInstall.install'] }));
    expect(onRefreshAgents).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onRefreshAgents).toHaveBeenCalledWith({
        throwOnError: true,
        agentCliEnv: {},
      });
    });
  });

  it('renders a Local CLI connection test for selected installed agents', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      { agents: availableAgents },
    );


    expect(screen.getByRole('button', { name: /Codex CLI/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy();
  });
});

describe('SettingsDialog research data API interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('sorts configured providers ahead of unconfigured ones and shows configured badges', () => {
    renderSettingsDialog(
      {
        agentId: 'codex',
        mediaProviders: {
          'materials-project': { apiKey: 'mp-key', baseUrl: 'https://api.materialsproject.org' },
          openalex: { apiKey: 'oa-key', baseUrl: 'https://api.openalex.org' },
        },
      },
      { initialSection: 'media' },
    );

    const names = Array.from(document.querySelectorAll('.media-provider-name')).map((node) =>
      node.textContent?.trim(),
    );
    expect(names.slice(0, 2)).toEqual(['Materials Project', 'OpenAlex']);
  });

  it('renders keyless public data sources in the collapsed drawer without input fields', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'media' },
    );

    // Keyless public sources (AFLOW, OQMD, PubChem, ...) are shown in a
    // separate disclosure without editable inputs.
    expect(screen.queryByLabelText('AFLOW API key')).toBeNull();
    expect(screen.queryByLabelText('AFLOW Base URL')).toBeNull();
    expect(document.querySelector('.media-provider-coming-soon')).toBeTruthy();
    expect(screen.getByText('PubChem')).toBeTruthy();
  });

  it('renders only research data API providers, not media providers', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'media' },
    );

    const apiKeyInput = screen.getByLabelText('NOMAD API key') as HTMLInputElement;
    const baseUrlInput = screen.getByLabelText('NOMAD Base URL') as HTMLInputElement;
    expect(apiKeyInput.disabled).toBe(false);
    expect(baseUrlInput.disabled).toBe(false);
    // Image/video/audio providers stay in the registry for the media pickers
    // but must not render in this section anymore.
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
    expect(screen.queryByLabelText('ElevenLabs API key')).toBeNull();
    expect(screen.queryByText('AIHubMix')).toBeNull();
  });

  it('clears an existing provider config and removes it from the persisted payload', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        agentId: 'codex',
        mediaProviders: {
          'materials-project': { apiKey: 'mp-key', baseUrl: 'https://custom.mp.example/api' },
        },
      },
      { initialSection: 'media' },
    );

    // Issue #737 added a window.confirm guard on the Clear button so a
    // stray click cannot wipe a saved API key. Auto-accept the prompt
    // here so the test still exercises the cleared-payload path.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const clearButtons = screen.getAllByRole('button', { name: 'Clear' });
    fireEvent.click(clearButtons[0]!);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Materials Project API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Materials Project Base URL') as HTMLInputElement).value).toBe('');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mediaProviders: {},
      }),
      { forceMediaProviderSync: true },
    );

    confirmSpy.mockRestore();
  });

  it('cancels Clear when the confirmation is dismissed (issue #737)', () => {
    const { onPersist } = renderSettingsDialog(
      {
        agentId: 'codex',
        mediaProviders: {
          'materials-project': { apiKey: 'mp-key', baseUrl: 'https://custom.mp.example/api' },
        },
      },
      { initialSection: 'media' },
    );

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const clearButtons = screen.getAllByRole('button', { name: 'Clear' });
    fireEvent.click(clearButtons[0]!);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Saved key + base URL must stay intact when the user dismisses
    // the confirmation; without this guard a fat-fingered click on
    // Clear would silently wipe the key. Autosave should never fire
    // because nothing changed.
    expect((screen.getByLabelText('Materials Project API key') as HTMLInputElement).value).toBe('mp-key');
    expect((screen.getByLabelText('Materials Project Base URL') as HTMLInputElement).value).toBe(
      'https://custom.mp.example/api',
    );
    expect(onPersist).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('supports persisting provider API key and base URL edits', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'media' },
    );

    fireEvent.change(screen.getByLabelText('OpenAlex API key'), {
      target: { value: 'openalex-key' },
    });
    fireEvent.change(screen.getByLabelText('OpenAlex Base URL'), {
      target: { value: 'https://openalex.example.com' },
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mediaProviders: expect.objectContaining({
          openalex: {
            apiKey: 'openalex-key',
            baseUrl: 'https://openalex.example.com',
            model: '',
          },
        }),
      }),
      { forceMediaProviderSync: true },
    );
  });

  it('re-masks a replacement research API key until reveal is used again', () => {
    renderSettingsDialog(
      {
        agentId: 'codex',
        mediaProviders: {
          'materials-project': { apiKey: 'mp-key', baseUrl: 'https://api.materialsproject.org' },
        },
      },
      { initialSection: 'media' },
    );

    const apiKeyInput = screen.getByLabelText('Materials Project API key') as HTMLInputElement;
    expect(apiKeyInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Materials Project Show key' }));
    expect(apiKeyInput.type).toBe('text');

    // Issue #737 added a window.confirm guard on Clear; jsdom's
    // unimplemented confirm() returns undefined, which would cancel
    // the clear and leave this test asserting the wrong reveal state.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]!);
    expect(apiKeyInput.type).toBe('password');

    fireEvent.change(apiKeyInput, { target: { value: 'mp-replacement' } });
    expect(apiKeyInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Materials Project Show key' }));
    expect(apiKeyInput.type).toBe('text');

    confirmSpy.mockRestore();
  });

  it('catches unmount flush failures for pending media-provider autosaves', async () => {
    const rejection = new Error('daemon unavailable');
    const handleUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => {
      event.preventDefault();
    });
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    try {
      const { onPersist, unmount } = renderSettingsDialog(
        { agentId: 'codex' },
        { initialSection: 'media' },
      );
      onPersist.mockRejectedValueOnce(rejection);

      fireEvent.change(screen.getByLabelText('Materials Project API key'), {
        target: { value: 'mp-unmount-key' },
      });

      await waitFor(() => {
        expect(screen.getByText('Saving…')).toBeTruthy();
      });
      unmount();
      await Promise.resolve();
      await Promise.resolve();

      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaProviders: expect.objectContaining({
            'materials-project': expect.objectContaining({ apiKey: 'mp-unmount-key' }),
          }),
        }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
      expect(handleUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    }
  });

  it('closes media settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'media' },
    );

    fireEvent.change(screen.getByLabelText('Materials Project API key'), {
      target: { value: 'mp-unsaved-key' },
    });
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'media' },
    );
    fireEvent.change(screen.getByLabelText('Materials Project API key'), {
      target: { value: 'mp-unsaved-key-2' },
    });
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsDialog language interactions', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem('open-design:locale');
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });

  it('shows every locale as a tile and marks the current locale as selected', async () => {
    renderLanguageSettingsDialog('en');

    const tiles = await screen.findAllByRole('radio');
    expect(tiles).toHaveLength(LOCALES.length);
    expect(screen.getByRole('radio', { name: /English/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /简体中文/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches locale immediately and updates localStorage', async () => {
    renderLanguageSettingsDialog('en');

    fireEvent.click(screen.getByRole('radio', { name: /简体中文/i }));

    expect(screen.getByRole('radio', { name: /简体中文/i }).getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem('open-design:locale')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('does not route language changes through autosave and closing does not revert an applied locale', async () => {
    const { onPersist, onClose } = renderLanguageSettingsDialog('en');

    fireEvent.click(screen.getByRole('radio', { name: /繁體中文/i }));

    expect(window.localStorage.getItem('open-design:locale')).toBe('zh-TW');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-TW');

    fireEvent.click(screen.getByTitle(/close|關閉/i));
    expect(onPersist).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('open-design:locale')).toBe('zh-TW');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-TW');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });
});

describe('SettingsDialog notifications interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders notifications offline by default and only reveals sound pickers when enabled', () => {
    renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    expect(screen.getByRole('group', { name: 'Completion sound' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'offline' })[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Success sound' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Failure sound' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    expect(playSoundMock).toHaveBeenCalledWith('ding');
    expect(screen.getByRole('group', { name: 'Success sound' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Failure sound' })).toBeTruthy();
  });

  it('updates completion success and failure sounds and autosaves the edited notification config', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        agentId: 'codex',
        notifications: {
          soundEnabled: true,
          successSoundId: 'chime',
          failureSoundId: 'two-tone-down',
          desktopEnabled: false,
        },
      },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pluck' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thud' }));

    expect(playSoundMock).toHaveBeenNthCalledWith(1, 'pluck');
    expect(playSoundMock).toHaveBeenNthCalledWith(2, 'thud');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        notifications: {
          soundEnabled: true,
          successSoundId: 'pluck',
          failureSoundId: 'thud',
          desktopEnabled: false,
        },
      }),
      {},
    );
  });

  it('enables desktop notifications after permission is granted and sends a test notification', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('granted');
    requestNotificationPermissionMock.mockResolvedValue('granted');
    showCompletionNotificationMock.mockResolvedValue('shown');

    renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    const desktopToggle = screen.getAllByRole('button', { name: 'offline' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => {
      expect(showCompletionNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded' }),
      );
    });
    expect(screen.getByText(/Test notification sent/i)).toBeTruthy();
  });

  it('shows a blocked hint and keeps desktop notifications disabled when permission is denied', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('denied');
    requestNotificationPermissionMock.mockResolvedValue('denied');

    renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    const desktopToggle = screen.getAllByRole('button', { name: 'offline' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/Notifications blocked by the browser/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
  });

  it('closes notification settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { agentId: 'codex' },
      { initialSection: 'notifications' },
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsDialog appearance interactions', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-strong');
    document.documentElement.style.removeProperty('--accent-soft');
    document.documentElement.style.removeProperty('--accent-tint');
    document.documentElement.style.removeProperty('--accent-hover');
  });

  it('treats System as the selected appearance mode when theme is unset or system', () => {
    renderSettingsDialog(
      { theme: 'system' },
      { initialSection: 'appearance' },
    );

    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies the first accent color as the default appearance color', () => {
    renderSettingsDialog(
      { theme: 'system' },
      { initialSection: 'appearance' },
    );

    expect(screen.getByRole('radio', { name: 'Default accent color' }).getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#c96442');
  });

  it('live previews explicit themes and removes the explicit document theme when switching back to System', () => {
    renderSettingsDialog(
      { theme: 'dark' },
      { initialSection: 'appearance' },
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reverts an unsaved appearance preview back to the saved theme when the dialog closes', () => {
    const first = renderSettingsDialog(
      { theme: 'dark' },
      { initialSection: 'appearance' },
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('persists System mode explicitly and preserves accent variables without an explicit document theme', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'codex', theme: 'dark', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        theme: 'system',
        accentColor: '#2563eb',
      }),
      {},
    );
  });

  it('switches back to the default accent color and persists it explicitly', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'codex', theme: 'light', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Default accent color' }));

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#c96442');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#c96442',
      }),
      {},
    );
  });

  it('keeps an autosaved accent color applied after the dialog closes', async () => {
    const view = renderSettingsDialog(
      { agentId: 'codex', theme: 'light', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: '#059669' }));

    await waitForPersist(
      view.onPersist,
      expect.objectContaining({
        accentColor: '#059669',
      }),
      {},
    );

    fireEvent.click(view.container.querySelector('.settings-close') as HTMLElement);
    expect(view.onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#059669');
  });

  it('live previews and autosaves preset and custom accent colors', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'codex', theme: 'light' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: '#059669' }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#059669');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#059669',
      }),
      {},
    );

    fireEvent.change(screen.getByLabelText('Custom color'), {
      target: { value: '#123456' },
    });
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#123456',
      }),
      {},
    );
  });

  it('localizes the accent color controls in Chinese', () => {
    render(
      <I18nProvider initial="zh-CN">
        <SettingsDialog
          initial={{ ...baseConfig, theme: 'light' }}
          agents={availableAgents}
          daemonLive={true}
          appVersionInfo={null}
          initialSection="appearance"
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('主题色')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '主题色' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '默认主题色' })).toBeTruthy();
    expect(screen.getByLabelText('自定义颜色')).toBeTruthy();
  });
});

// MatOS removed the Skills tab from Integrations (skills are native MatOS
// assets managed in the Assets workbench). The upstream SkillsSection
// component stays in-tree; these upstream tab tests are skipped because the
// tab is no longer routable.
describe.skip('IntegrationsView skills tab', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists functional skills and filters them by mode + search', async () => {
    renderIntegrationsView(
      { agentId: 'codex' },
      // @ts-expect-error — the skills tab was removed from IntegrationTab.
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
      expect(screen.getByText('sales-deck')).toBeTruthy();
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'deck' },
    });
    expect(screen.queryByText('blog-post')).toBeNull();
    expect(screen.getByText('sales-deck')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'sales' },
    });
    expect(screen.getByText('sales-deck')).toBeTruthy();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('opens a skill detail panel and persists disabled skills from toggle switches', async () => {
    const { onConfigPersist } = renderIntegrationsView(
      { agentId: 'codex' },
      // @ts-expect-error — the skills tab was removed from IntegrationTab.
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('blog-post'));
    await waitFor(() => {
      expect(fetchSkillMock).toHaveBeenCalledWith('blog-post');
      expect(screen.getByText('skill body for blog-post')).toBeTruthy();
    });

    const toggles = screen.getAllByTitle('Toggle');
    fireEvent.click(toggles[0] as HTMLElement);

    await waitFor(() => {
      expect(onConfigPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          disabledSkills: ['blog-post'],
        }),
      );
    });
  });

  it('shows an empty state when search matches nothing', async () => {
    renderIntegrationsView(
      { agentId: 'codex' },
      // @ts-expect-error — the skills tab was removed from IntegrationTab.
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No items match your search.')).toBeTruthy();
  });
});

// MatOS hides the upstream design-systems settings section behind
