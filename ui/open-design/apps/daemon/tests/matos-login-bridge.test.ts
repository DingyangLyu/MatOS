import { describe, expect, it } from 'vitest';

import { projectLoginStatus, validateLoginSetInput } from '../src/routes/matos-login.js';

describe('validateLoginSetInput', () => {
  it('accepts a DeepSeek key with optional base URL and model', () => {
    expect(
      validateLoginSetInput({
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-user-key',
        model: 'deepseek-flash',
      }),
    ).toEqual({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-user-key',
      model: 'deepseek-flash',
    });
    expect(validateLoginSetInput({ apiKey: 'sk-user-key' })).toEqual({ apiKey: 'sk-user-key' });
  });

  it('ignores provider-type and fast-model fields the DSH runtime does not use', () => {
    expect(
      validateLoginSetInput({
        providerType: 'openai-chat',
        apiKey: 'sk-user-key',
        fastModel: 'deepseek-flash',
      }),
    ).toEqual({ apiKey: 'sk-user-key' });
  });

  it('rejects missing/invalid fields', () => {
    expect(validateLoginSetInput(null)).toHaveProperty('error');
    expect(validateLoginSetInput({ baseUrl: 'ftp://x', apiKey: 'k' })).toHaveProperty('error');
    expect(validateLoginSetInput({ baseUrl: 'https://ok.example', apiKey: '' })).toHaveProperty('error');
    expect(
      validateLoginSetInput({ apiKey: 'k', model: 'bad model name with spaces' }),
    ).toHaveProperty('error');
  });
});

describe('projectLoginStatus', () => {
  it('projects status fields and never carries secret values', () => {
    const projected = projectLoginStatus({
      ok: true,
      status: {
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-flash',
        source: 'profile',
        status: 'validated',
        hasSecret: true,
        // Fields that must NOT survive the projection:
        apiKey: 'sk-leak',
        authToken: 'sk-leak-2',
        secrets: { apiKey: 'sk-leak-3' },
      },
      secrets: { apiKey: 'sk-leak-4' },
      message: 'Provider validation succeeded.',
    });
    expect(projected).toEqual({
      ok: true,
      status: {
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-flash',
        source: 'profile',
        status: 'validated',
        hasSecret: true,
      },
      message: 'Provider validation succeeded.',
    });
    expect(JSON.stringify(projected)).not.toContain('sk-leak');
  });

  it('degrades malformed payloads to ok:false', () => {
    expect(projectLoginStatus(null)).toEqual({ ok: false });
    expect(projectLoginStatus('x')).toEqual({ ok: false });
  });
});
