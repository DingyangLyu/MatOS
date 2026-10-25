import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentRefreshOptionsForConfig,
  sanitizeSettingsSavePayload,
  shouldEnableSettingsSave,
  shouldShowCustomModelInput,
  testStatusVariant,
  updateAgentCliEnvValue,
} from '../../src/components/SettingsDialog';
import type { AppConfig, ConnectionTestResponse } from '../../src/types';

const originalFetch = globalThis.fetch;

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsDialog test status variant', () => {
  const baseResult: ConnectionTestResponse = { ok: false, kind: 'unknown', latencyMs: 0 };
  it('returns success for an ok result', () => {
    expect(testStatusVariant({ ok: true, kind: 'success', latencyMs: 12 })).toBe(
      'success',
    );
  });
  it('returns error for the failure kinds', () => {
    for (const kind of [
      'not_found_model',
      'invalid_model_id',
      'timeout',
      'agent_not_installed',
      'agent_auth_required',
      'agent_spawn_failed',
      'unknown',
    ] as const) {
      expect(testStatusVariant({ ...baseResult, kind })).toBe('error');
    }
  });
});

describe('SettingsDialog custom model picker state', () => {
  it('keeps custom input visible while an intermediate value matches a known model', () => {
    expect(
      shouldShowCustomModelInput('gpt-5', ['gpt-5', 'o3'], true),
    ).toBe(true);
  });

  it('uses the dropdown when a known model is selected outside custom mode', () => {
    expect(
      shouldShowCustomModelInput('gpt-5', ['gpt-5', 'o3'], false),
    ).toBe(false);
  });

  it('shows custom input for unknown or empty model values', () => {
    expect(
      shouldShowCustomModelInput('gpt-5.5', ['gpt-5', 'o3'], false),
    ).toBe(true);
    expect(shouldShowCustomModelInput('', ['gpt-5', 'o3'], false)).toBe(true);
  });
});

describe('SettingsDialog agent CLI env settings', () => {
  it('updates supported per-agent CLI env values without dropping sibling agents', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-1' },
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '  ~/.claude-2  ',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('updates additional Codex CLI env values without dropping sibling Codex fields', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'codex',
      'CODEX_BIN',
      '  ~/bin/codex-next  ',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
    });
    expect(next.agentCliEnvIntent).toEqual({});
  });

  it('marks API key env values as explicit CLI overrides', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'codex',
      'CODEX_API_KEY',
      '  sk-codex  ',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt', CODEX_API_KEY: 'sk-codex' },
    });
    expect(next.agentCliEnvIntent).toEqual({
      codex: { apiKeyOverride: true },
    });
  });

  it('keeps the API key override marker when clearing a base URL with a key present', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        codex: {
          CODEX_API_KEY: 'sk-codex',
          OPENAI_BASE_URL: 'https://proxy.example/openai',
        },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'codex',
      'OPENAI_BASE_URL',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_API_KEY: 'sk-codex' },
    });
    expect(next.agentCliEnvIntent).toEqual({
      codex: { apiKeyOverride: true },
    });
  });

  it('removes the API key override marker when the last auth key is cleared', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: {
          CLAUDE_CONFIG_DIR: '~/.claude-2',
          ANTHROPIC_API_KEY: 'sk-anthropic',
        },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'ANTHROPIC_API_KEY',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
    });
    expect(next.agentCliEnvIntent).toEqual({});
  });

  it('removes empty per-agent CLI env entries', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('passes pending CLI env prefs through agent rescan options', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    });
  });

  it('passes an empty CLI env object through agent rescan after fields are cleared', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {},
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {},
    });
  });
});

describe('shouldEnableSettingsSave', () => {
  const availableAgent = { id: 'matos', available: true };
  const unavailableAgent = { id: 'matos', available: false };

  it('returns true on any non-execution section regardless of execution completeness', () => {
    const incomplete: AppConfig = { ...baseConfig, agentId: null };
    for (const section of [
      'language',
      'appearance',
      'media',
      'notifications',
      'about',
    ] as const) {
      expect(shouldEnableSettingsSave(incomplete, section, [availableAgent])).toBe(true);
    }
  });

  it('on execution: returns true only when an available agent is selected', () => {
    expect(
      shouldEnableSettingsSave({ ...baseConfig, agentId: 'matos' }, 'execution', [availableAgent]),
    ).toBe(true);
    expect(
      shouldEnableSettingsSave({ ...baseConfig, agentId: 'matos' }, 'execution', [unavailableAgent]),
    ).toBe(false);
    expect(
      shouldEnableSettingsSave({ ...baseConfig, agentId: 'matos' }, 'execution', []),
    ).toBe(false);
    expect(
      shouldEnableSettingsSave({ ...baseConfig, agentId: null }, 'execution', [availableAgent]),
    ).toBe(false);
  });
});

describe('sanitizeSettingsSavePayload', () => {
  const availableAgent = { id: 'matos', available: true };

  it('reverts execution fields to initial when saving from a non-execution section without an agent', () => {
    const initial: AppConfig = { ...baseConfig, agentId: 'matos' };
    const draft: AppConfig = {
      ...baseConfig,
      agentId: null,
      agentCliEnv: { matos: { DEEPSEEK_MODEL: 'x' } },
    };

    const sanitized = sanitizeSettingsSavePayload(
      draft,
      initial,
      'language',
      [availableAgent],
    );

    expect(sanitized.agentId).toBe(initial.agentId);
    expect(sanitized.agentCliEnv).toEqual(initial.agentCliEnv);
  });

  it('passes the cfg through unchanged when execution config is already valid', () => {
    const initial: AppConfig = { ...baseConfig, agentId: 'matos' };
    const draft: AppConfig = { ...initial, agentCliEnv: { matos: { DEEPSEEK_MODEL: 'x' } } };

    expect(
      sanitizeSettingsSavePayload(draft, initial, 'language', [availableAgent]),
    ).toBe(draft);
  });

  it('passes the cfg through unchanged on the execution section itself', () => {
    const initial: AppConfig = { ...baseConfig, agentId: 'matos' };
    const draft: AppConfig = { ...baseConfig, agentId: null };

    expect(
      sanitizeSettingsSavePayload(draft, initial, 'execution', [availableAgent]),
    ).toBe(draft);
  });
});
