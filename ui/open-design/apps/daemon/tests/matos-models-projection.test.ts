import { describe, expect, it, vi } from 'vitest';

import { modelEnvFingerprint, projectMatOSWebModel } from '../src/routes/matos-models.js';

// Regression spec for the 2026-07-19 main-channel daemon crash loop: the
// models warmup derived a housekeeping promise via `promise.finally()` that
// nobody awaited, so a failing `matos workbench models list` (older baked CLI
// without the subcommand) escaped as an unhandledRejection. The daemon-wide
// fatal telemetry handler then exit(1)'d the whole daemon ~2s after listen.
describe('warmMatOSModelsCache', () => {
  it('does not leak an unhandledRejection when the matos CLI fails', async () => {
    vi.resetModules();
    // Point the bridge at a binary that cannot exist so the refresh rejects
    // through the real execFile failure path.
    const previousBin = process.env.MATOS_BIN;
    process.env.MATOS_BIN = '/nonexistent/matos-borked-for-test';
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { warmMatOSModelsCache } = await import('../src/routes/matos-models.js');
      warmMatOSModelsCache();
      // Let the spawn fail and every derived promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      if (previousBin === undefined) delete process.env.MATOS_BIN;
      else process.env.MATOS_BIN = previousBin;
    }
  });
});

// The models bridge projects `matos workbench models list --json` rows into
// the web picker shape. `id: null` is the deployment-default sentinel; rows
// without a label are malformed and dropped.
describe('projectMatOSWebModel', () => {
  it('projects a concrete model row', () => {
    expect(
      projectMatOSWebModel({
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'Production model',
        isDefault: false,
      }),
    ).toEqual({
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Production model',
      isDefault: false,
    });
  });

  it('projects the deployment-default sentinel (null id)', () => {
    expect(
      projectMatOSWebModel({ id: null, label: 'Default', description: '', isDefault: true }),
    ).toEqual({ id: null, label: 'Default', description: '', isDefault: true });
    // Empty-string ids normalize to the sentinel too.
    expect(projectMatOSWebModel({ id: '  ', label: 'Default' })?.id).toBeNull();
  });

  it('drops malformed rows', () => {
    expect(projectMatOSWebModel(null)).toBeNull();
    expect(projectMatOSWebModel('x')).toBeNull();
    expect(projectMatOSWebModel({ id: 'model-without-label' })).toBeNull();
    expect(projectMatOSWebModel({ label: '   ' })).toBeNull();
  });
});

describe('modelEnvFingerprint', () => {
  it('changes when a BYOK provider variable changes and never leaks values', () => {
    const base = { ANTHROPIC_MODEL: 'deepseek-v4-pro', ANTHROPIC_AUTH_TOKEN: 'sk-secret-a' };
    const sameAgain = modelEnvFingerprint({ ...base });
    expect(modelEnvFingerprint(base)).toBe(sameAgain);

    // A different key or model must produce a different cache key so a
    // provider switch refreshes the catalog immediately.
    expect(modelEnvFingerprint({ ...base, ANTHROPIC_AUTH_TOKEN: 'sk-secret-b' })).not.toBe(
      sameAgain,
    );
    expect(modelEnvFingerprint({ ...base, ANTHROPIC_MODEL: 'my-own-model' })).not.toBe(sameAgain);

    // Unrelated env noise must not churn the cache.
    expect(modelEnvFingerprint({ ...base, RANDOM_UNRELATED: 'x' })).toBe(sameAgain);

    // The fingerprint is a short hash, never the secret itself.
    expect(sameAgain).toMatch(/^[0-9a-f]{16}$/);
    expect(sameAgain).not.toContain('sk-secret');
  });
});
