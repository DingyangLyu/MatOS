import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMediaProvidersForDaemonSave,
  DEFAULT_CONFIG,
  fetchMediaProvidersFromDaemon,
  isStoredMediaProviderEntryEmpty,
  isStoredMediaProviderEntryPresent,
  loadConfig,
  mergeDaemonConfig,
  mergeDaemonMediaProviders,
  saveConfig,
  shouldSyncLocalMediaProvidersToDaemon,
  syncConfigToDaemon,
  syncMediaProvidersToDaemon,
} from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const store = new Map<string, string>();
const originalFetch = globalThis.fetch;

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

describe('syncConfigToDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('syncs per-agent CLI env prefs to the daemon app config', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/app-config');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      onboardingCompleted: DEFAULT_CONFIG.onboardingCompleted,
      agentId: DEFAULT_CONFIG.agentId,
      agentModels: DEFAULT_CONFIG.agentModels,
      skillId: DEFAULT_CONFIG.skillId,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
      },
    });
  });

  it('syncs CLI API key env values and intent to daemon app config while localStorage strips them', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
        codex: { OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: 'https://proxy.example/openai' },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
        codex: { apiKeyOverride: true },
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
        codex: { OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: 'https://proxy.example/openai' },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
        codex: { apiKeyOverride: true },
      },
    });
  });

});

describe('syncMediaProvidersToDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('throws when a forced media sync fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

    await expect(
      syncMediaProvidersToDaemon({}, { force: true, throwOnError: true }),
    ).rejects.toThrow('Media config save failed');
  });
});

describe('mergeDaemonConfig', () => {
  it('clears stale local CLI env prefs when the daemon has none', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentId: 'codex',
      },
    );

    expect(merged.agentId).toBe('codex');
    expect(merged.agentCliEnv).toEqual({});
  });

  it('uses daemon CLI env prefs instead of merging with stale local entries', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentCliEnv: {
          codex: { CODEX_HOME: '~/.codex-new', CODEX_BIN: '~/bin/codex-new' },
        },
      },
    );

    expect(merged.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-new', CODEX_BIN: '~/bin/codex-new' },
    });
  });

  it('uses daemon CLI env intent instead of merging with stale local entries', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnvIntent: {
          claude: { apiKeyOverride: true },
        },
      },
      {
        agentCliEnvIntent: {
          codex: { apiKeyOverride: true },
        },
      },
    );

    expect(merged.agentCliEnvIntent).toEqual({
      codex: { apiKeyOverride: true },
    });
  });

});

describe('mergeDaemonMediaProviders', () => {
  it('preserves a local pending media-provider edit while adopting daemon saved-marker metadata', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: 'sk-local',
            baseUrl: 'https://local.example/v1',
          },
        },
      },
      {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '1234',
          baseUrl: 'https://daemon.example/v1',
        },
      },
      { preserveLocalProviderIds: new Set(['openai']) },
    );

    expect(merged.mediaProviders).toEqual({
      openai: {
        apiKey: 'sk-local',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: 'https://local.example/v1',
      },
    });
  });

  it('preserves local pending edits and unrelated local-only providers when daemon returns a partial provider set', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: 'sk-local-openai',
            baseUrl: 'https://local-openai.example/v1',
          },
          fal: {
            apiKey: 'sk-local-fal',
            baseUrl: 'https://queue.fal.run',
            model: 'fal-ai/imagen4/preview',
          },
        },
      },
      {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '1234',
          baseUrl: 'https://daemon-openai.example/v1',
        },
      },
      { preserveLocalProviderIds: new Set(['openai']) },
    );

    expect(merged.mediaProviders).toEqual({
      openai: {
        apiKey: 'sk-local-openai',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: 'https://local-openai.example/v1',
      },
      fal: {
        apiKey: 'sk-local-fal',
        baseUrl: 'https://queue.fal.run',
        model: 'fal-ai/imagen4/preview',
      },
    });
  });

  it('keeps local media providers when daemon has no stored state yet', () => {
    const localConfig = {
      ...DEFAULT_CONFIG,
      mediaProviders: {
        openai: {
          apiKey: 'sk-local',
          baseUrl: 'https://local.example/v1',
        },
      },
    };

    const merged = mergeDaemonMediaProviders(localConfig, {
      openai: {
        apiKey: '',
        apiKeyConfigured: false,
        apiKeyTail: '',
        baseUrl: '',
      },
    });

    expect(merged.mediaProviders).toEqual(localConfig.mediaProviders);
  });

  it('preserves local pending media-provider edits when daemon reload returns saved marker state', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: 'sk-local-pending',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://local-pending.example/v1',
          },
        },
      },
      {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '9876',
          baseUrl: 'https://daemon.example/v1',
        },
      },
      { preserveLocalProviderIds: new Set(['openai']) },
    );

    expect(merged.mediaProviders).toEqual({
      openai: {
        apiKey: 'sk-local-pending',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: 'https://local-pending.example/v1',
      },
    });
  });

  it('refreshes ordinary saved-marker rows from daemon state when there is no unsaved local secret', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://local-saved.example/v1',
            model: 'gpt-image-1',
          },
        },
      },
      {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '9876',
          baseUrl: 'https://daemon.example/v1',
          model: 'gpt-image-1-mini',
        },
      },
    );

    expect(merged.mediaProviders).toEqual({
      openai: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
        model: 'gpt-image-1-mini',
      },
    });
  });

  it('prefers daemon-backed media provider state during startup reloads by default', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: 'sk-stale-local',
            baseUrl: 'https://local-stale.example/v1',
          },
        },
      },
      {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '9876',
          baseUrl: 'https://daemon.example/v1',
        },
      },
    );

    expect(merged.mediaProviders).toEqual({
      openai: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
      },
    });
  });

  it('refreshes browser-persisted saved rows from daemon state unless the dialog marks them dirty', () => {
    const localConfig = {
      ...DEFAULT_CONFIG,
      mediaProviders: {
        openai: {
          apiKey: 'sk-browser-saved',
          apiKeyConfigured: true,
          apiKeyTail: '1234',
          baseUrl: 'https://local-stale.example/v1',
          model: 'gpt-image-1',
        },
      },
    };

    const daemonProviders = {
      openai: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
        model: 'gpt-image-1-mini',
      },
    };

    expect(mergeDaemonMediaProviders(localConfig, daemonProviders).mediaProviders).toEqual({
      openai: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
        model: 'gpt-image-1-mini',
      },
    });

    expect(
      mergeDaemonMediaProviders(localConfig, daemonProviders, {
        preserveLocalProviderIds: new Set(['openai']),
      }).mediaProviders,
    ).toEqual({
      openai: {
        apiKey: 'sk-browser-saved',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: 'https://local-stale.example/v1',
        model: 'gpt-image-1',
      },
    });
  });

  it('drops stale marker-only local entries when daemon definitively has no stored state', () => {
    const merged = mergeDaemonMediaProviders(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
            model: '',
          },
          fal: {
            apiKey: 'sk-local-fal',
            baseUrl: 'https://queue.fal.run',
            model: 'fal-ai/imagen4/preview',
          },
        },
      },
      {},
    );

    expect(merged.mediaProviders).toEqual({
      fal: {
        apiKey: 'sk-local-fal',
        baseUrl: 'https://queue.fal.run',
        model: 'fal-ai/imagen4/preview',
      },
    });
  });
});

describe('media provider entry presence helpers', () => {
  it('treat saved-marker entries as present even when visible fields are empty', () => {
    expect(
      isStoredMediaProviderEntryPresent({
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: '',
      }),
    ).toBe(true);
    expect(
      isStoredMediaProviderEntryEmpty({
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
        baseUrl: '',
      }),
    ).toBe(false);
  });

  it('treats entries as empty only after clear-level fields and markers are removed', () => {
    expect(
      isStoredMediaProviderEntryEmpty({
        apiKey: '',
        apiKeyConfigured: false,
        apiKeyTail: '',
        baseUrl: '',
        model: '',
      }),
    ).toBe(true);
  });
});

describe('shouldSyncLocalMediaProvidersToDaemon', () => {
  it('returns true when local providers exist and daemon has none yet', () => {
    expect(
      shouldSyncLocalMediaProvidersToDaemon(
        {
          openai: {
            apiKey: 'sk-local',
            baseUrl: 'https://local.example/v1',
          },
        },
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: false,
            apiKeyTail: '',
            baseUrl: '',
          },
        },
      ),
    ).toBe(true);
  });

  it('returns false when daemon already has persisted media provider state', () => {
    expect(
      shouldSyncLocalMediaProvidersToDaemon(
        {
          openai: {
            apiKey: 'sk-local',
            baseUrl: 'https://local.example/v1',
          },
        },
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        },
      ),
    ).toBe(false);
  });

  it('returns false when daemon media config could not be fetched', () => {
    expect(
      shouldSyncLocalMediaProvidersToDaemon(
        {
          openai: {
            apiKey: 'sk-local',
            baseUrl: 'https://local.example/v1',
          },
        },
        null,
      ),
    ).toBe(false);
  });

  it('returns false when local state only has masked saved markers', () => {
    expect(
      shouldSyncLocalMediaProvidersToDaemon(
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
            model: '',
          },
        },
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: false,
            apiKeyTail: '',
            baseUrl: '',
            model: '',
          },
        },
      ),
    ).toBe(false);
  });
});

describe('fetchMediaProvidersFromDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('maps daemon media config into masked local config state', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providers: {
            openai: {
              configured: true,
              source: 'stored',
              apiKeyTail: '1234',
              baseUrl: 'https://daemon.example/v1',
              model: 'gpt-image-1',
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMediaProvidersFromDaemon()).resolves.toEqual({
      status: 'ok',
      providers: {
        openai: {
          apiKey: '',
          apiKeyConfigured: true,
          source: 'stored',
          apiKeyTail: '1234',
          baseUrl: 'https://daemon.example/v1',
          model: 'gpt-image-1',
        },
      },
    });
  });

  it('returns an error status when daemon media config fetch fails', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMediaProvidersFromDaemon()).resolves.toEqual({ status: 'error' });
  });
});

describe('buildMediaProvidersForDaemonSave', () => {
  it('preserves a stored key while applying daemon/default non-secret values', () => {
    expect(
      buildMediaProvidersForDaemonSave(
        {
          'materials-project': {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        },
        {
          'materials-project': {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        },
        { force: true },
      ),
    ).toEqual({
      providers: {
        'materials-project': {
          preserveApiKey: true,
          baseUrl: 'https://api.materialsproject.org',
        },
      },
      force: true,
    });
  });

  it('keeps an existing stored key when only baseUrl or model changes', () => {
    expect(
      buildMediaProvidersForDaemonSave(
        {
          nanobanana: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '9999',
            baseUrl: 'https://custom.gateway.example',
            model: 'gemini-custom',
          },
        },
        {
          nanobanana: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '9999',
            baseUrl: 'https://generativelanguage.googleapis.com',
            model: 'gemini-3.1-flash-image-preview',
          },
        },
      ),
    ).toEqual({
      providers: {
        nanobanana: {
          preserveApiKey: true,
          baseUrl: 'https://custom.gateway.example',
          model: 'gemini-custom',
        },
      },
      force: false,
    });
  });

  it('does not persist default OpenAI base URL for OAuth-only markers', () => {
    expect(
      buildMediaProvidersForDaemonSave(
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '',
            baseUrl: '',
            source: 'oauth-codex',
          },
        },
        {
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '',
            baseUrl: '',
            source: 'oauth-codex',
          },
        },
      ),
    ).toEqual({
      providers: {},
      force: false,
    });
  });
});

afterEach(() => {
  store.clear();
});

describe('loadConfig', () => {
  it('preserves a valid saved accent color', () => {
    const savedConfig: Partial<AppConfig> = {
      theme: 'dark',
      accentColor: '#4F46E5',
    };
    store.set('open-design:config', JSON.stringify(savedConfig));

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('falls back to the default accent color for malformed saved colors', () => {
    const savedConfig: Partial<AppConfig> = {
      accentColor: 'blue',
    };
    store.set('open-design:config', JSON.stringify(savedConfig));

    expect(loadConfig().accentColor).toBe(DEFAULT_CONFIG.accentColor);
  });

  it('returns defaults for malformed localStorage JSON', () => {
    store.set('open-design:config', '{broken-json');

    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('drops retired direct-provider settings from stored config', () => {
    store.set('open-design:config', JSON.stringify({
      mode: 'api',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      apiProtocol: 'openai',
      apiVersion: '2024-01-01',
      apiProtocolConfigs: { openai: { apiKey: 'sk-test' } },
      apiProviderBaseUrl: 'https://api.example.com/v1',
      maxTokens: 4096,
      configMigrationVersion: 1,
      agentId: 'matos',
    }));

    const config = loadConfig() as AppConfig & Record<string, unknown>;

    expect(config.agentId).toBe('matos');
    for (const key of [
      'mode',
      'apiKey',
      'baseUrl',
      'model',
      'apiProtocol',
      'apiVersion',
      'apiProtocolConfigs',
      'apiProviderBaseUrl',
      'maxTokens',
      'configMigrationVersion',
    ]) {
      expect(config[key]).toBeUndefined();
    }
  });
});

describe('saveConfig', () => {
  it('keeps CLI API key env values out of localStorage while preserving intent and non-secret env', () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-auth-token',
          ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
          CLAUDE_CONFIG_DIR: '~/.claude-2',
        },
        codex: {
          CODEX_API_KEY: 'sk-codex',
          OPENAI_API_KEY: 'sk-openai',
          OPENAI_BASE_URL: 'https://proxy.example/openai',
          CODEX_HOME: '~/.codex-alt',
        },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
        codex: { apiKeyOverride: true },
      },
    });

    const saved = JSON.parse(store.get('open-design:config') ?? '{}');
    expect(saved.agentCliEnv.claude).toEqual({
      ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      CLAUDE_CONFIG_DIR: '~/.claude-2',
    });
    expect(saved.agentCliEnv.codex).toEqual({
      OPENAI_BASE_URL: 'https://proxy.example/openai',
      CODEX_HOME: '~/.codex-alt',
    });
    expect(saved.agentCliEnvIntent).toEqual({
      claude: { apiKeyOverride: true },
      codex: { apiKeyOverride: true },
    });
  });
});
