// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

const baseConfig: AppConfig = {
  agentId: 'matos',
  skillId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const matosAgent: AgentInfo = {
  id: 'matos',
  name: 'MatOS',
  bin: 'matos',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'default', label: 'Default role' },
    { id: 'role:compute', label: 'Compute' },
  ],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'high', label: 'High' },
  ],
};

function renderSwitcher(config: Partial<AppConfig> = {}, agents: AgentInfo[] = [matosAgent]) {
  const onAgentModelChange = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { ...view, onAgentModelChange, onOpenSettings };
}

afterEach(() => {
  cleanup();
});

describe('InlineModelSwitcher', () => {
  it('summarizes the MatOS runtime and selected role in the chip', () => {
    renderSwitcher({ agentModels: { matos: { model: 'role:compute' } } });
    const chip = screen.getByTestId('inline-model-switcher-chip');
    expect(chip.getAttribute('aria-label')).toContain('MatOS');
    expect(chip.getAttribute('aria-label')).toContain('Compute');
  });

  it('shows a default label when the default role is selected', () => {
    renderSwitcher();
    const label = screen.getByTestId('inline-model-switcher-chip').getAttribute('aria-label') ?? '';
    expect(label).not.toContain('Default role');
  });

  it('changes reasoning effort for the active runtime', () => {
    const { onAgentModelChange } = renderSwitcher();
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.change(screen.getByTestId('inline-model-switcher-agent-reasoning'), {
      target: { value: 'high' },
    });
    expect(onAgentModelChange).toHaveBeenCalledWith('matos', { reasoning: 'high' });
  });

  it('opens the execution settings from the popover', () => {
    const { onOpenSettings } = renderSwitcher();
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledWith('execution');
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('closes the popover on Escape', () => {
    renderSwitcher();
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('explains when no runtime is detected', () => {
    renderSwitcher({}, []);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.getByTestId('inline-model-switcher-popover').textContent ?? '').not.toBe('');
  });
});
