import { describe, expect, it, vi } from 'vitest';

import {
  buildPersistedConfig,
  isAutosaveDraftOnlyChange,
  resolveSettingsCloseConfig,
  shouldSyncMediaProvidersOnSave,
} from '../src/App';
import type { AppConfig } from '../src/types';

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
};

describe('shouldSyncMediaProvidersOnSave', () => {
  it('keeps bootstrap-style empty media maps from syncing by default', () => {
    expect(shouldSyncMediaProvidersOnSave({})).toBe(false);
  });

  it('syncs an explicit empty media map when the user save should force a clear', () => {
    expect(shouldSyncMediaProvidersOnSave({}, { force: true })).toBe(true);
  });
});

describe('buildPersistedConfig', () => {
  it('preserves onboarding completion when a stale autosave snapshot says false', () => {
    expect(
      buildPersistedConfig(
        { ...baseConfig, onboardingCompleted: false },
        { ...baseConfig, onboardingCompleted: true },
      ),
    ).toMatchObject({ onboardingCompleted: true });
  });
});

describe('isAutosaveDraftOnlyChange', () => {
  const savedConfig: AppConfig = { ...baseConfig };

  it('flags a real change (non-draft field) as persist-worthy', () => {
    const flipped: AppConfig = { ...savedConfig, agentId: 'matos' };
    expect(isAutosaveDraftOnlyChange(flipped, savedConfig)).toBe(false);
  });

  it('returns true for an identical snapshot (no-op autosave tick)', () => {
    expect(isAutosaveDraftOnlyChange(savedConfig, savedConfig)).toBe(true);
  });
});

describe('resolveSettingsCloseConfig', () => {
  it('marks onboarding complete without discarding the latest persisted draft', () => {
    expect(
      resolveSettingsCloseConfig(
        {
          ...baseConfig,
          onboardingCompleted: false,
        },
        {
          ...baseConfig,
          onboardingCompleted: false,
        },
      ),
    ).toMatchObject({
      onboardingCompleted: true,
    });
  });
});
