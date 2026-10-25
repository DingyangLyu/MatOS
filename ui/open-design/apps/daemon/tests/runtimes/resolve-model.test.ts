/**
 * Coverage for `resolveModelForAgent` — the safety net that turns the
 * synthetic `'default'` / null model into a concrete fallback id for adapters
 * whose CLI cannot accept "default".
 *
 * The chat-run path in server.ts goes:
 *
 *   user/plugin model -> isKnownModel | sanitizeCustomModel -> resolveModelForAgent
 *
 * so the substitution kicks in even when a plugin or stored chat state sends
 * `model: 'default'` (or omits the field).
 */

import { describe, expect, it } from 'vitest';

import {
  getRememberedLiveModels,
  isKnownModel,
  preferFreshLiveModels,
  rememberLiveModels,
  resolveModelForAgent,
} from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

function defWith(fallbackIds: string[]): RuntimeAgentDef {
  return {
    id: 'test',
    name: 'Test',
    bin: 'test',
    versionArgs: ['--version'],
    fallbackModels: fallbackIds.map((id) => ({ id, label: id })),
    buildArgs: () => [],
    streamFormat: 'acp-json-rpc',
  };
}

function defWithId(id: string, fallbackIds: string[]): RuntimeAgentDef {
  return {
    ...defWith(fallbackIds),
    id,
  };
}

describe('resolveModelForAgent', () => {
  it('substitutes the first concrete fallback when the resolved model is null and the def has no "default" option', () => {
    const def = defWith(['gpt-5.4-mini', 'gpt-5.4']);
    expect(resolveModelForAgent(def, null)).toBe('gpt-5.4-mini');
  });

  it('substitutes when the resolved model is the synthetic "default" id and the def omits "default"', () => {
    const def = defWith(['gpt-5.4-mini', 'gpt-5.4']);
    expect(resolveModelForAgent(def, 'default')).toBe('gpt-5.4-mini');
  });

  it('prefers the first remembered live model when the def cannot accept the synthetic default model', () => {
    const def = defWithId('live-default-test', []);
    rememberLiveModels(def.id, [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ]);

    expect(resolveModelForAgent(def, null)).toBe('deepseek-v3.2');
    expect(resolveModelForAgent(def, 'default')).toBe('deepseek-v3.2');
    expect(getRememberedLiveModels(def.id)).toEqual([
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ]);
  });

  it('isolates remembered live models by environment profile scope', () => {
    const def = defWithId('scoped-runtime', []);
    rememberLiveModels(def.id, [
      { id: 'prod-model', label: 'prod-model' },
    ], 'prod');
    rememberLiveModels(def.id, [
      { id: 'test-model', label: 'test-model' },
    ], 'test');

    expect(getRememberedLiveModels(def.id, 'prod')).toEqual([
      { id: 'prod-model', label: 'prod-model' },
    ]);
    expect(getRememberedLiveModels(def.id, 'test')).toEqual([
      { id: 'test-model', label: 'test-model' },
    ]);
    expect(isKnownModel(def, 'prod-model', 'prod')).toBe(true);
    expect(isKnownModel(def, 'prod-model', 'test')).toBe(false);
    expect(resolveModelForAgent(def, null, 'prod')).toBe('prod-model');
    expect(resolveModelForAgent(def, null, 'test')).toBe('test-model');
  });

  it('prefers remembered live models only when the fresh catalog is empty', () => {
    const remembered = [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ];
    const fresh = [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }];

    expect(preferFreshLiveModels(fresh, remembered)).toEqual(fresh);
    expect(preferFreshLiveModels([], remembered)).toEqual(remembered);
  });

  it('keeps common default-capable defs untouched even when live models are remembered', () => {
    const def = defWithId('live-default-capable-test', ['default', 'sonnet']);
    rememberLiveModels(def.id, [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
    ]);

    expect(resolveModelForAgent(def, null)).toBe(null);
    expect(resolveModelForAgent(def, 'default')).toBe('default');
  });

  it('leaves the resolved model alone when the def lists "default" itself (the common case)', () => {
    const def = defWith(['default', 'sonnet']);
    expect(resolveModelForAgent(def, 'default')).toBe('default');
    expect(resolveModelForAgent(def, null)).toBe(null);
  });

  it('leaves real model ids untouched even when the def omits "default"', () => {
    const def = defWith(['gpt-5.4-mini']);
    expect(resolveModelForAgent(def, 'gpt-5.4')).toBe('gpt-5.4');
  });

  it('returns the original value when fallbackModels is empty (no substitution possible)', () => {
    const def = defWith([]);
    expect(resolveModelForAgent(def, null)).toBe(null);
    expect(resolveModelForAgent(def, 'default')).toBe('default');
  });
});
