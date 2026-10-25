// @vitest-environment jsdom
//
// MatOS "start from a template" rail (the product-default Home rail).
// Covers:
//   - Every MatOS template card renders inside the tabs container.
//   - Asset cards spawn an asset-editing project for the right asset type.
//   - The compute-task card pre-fills the composer instead of navigating.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

const createMatOSAssetProject = vi.fn<(assetType: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../../src/matos-asset-projects', () => ({
  createMatOSAssetProject: (assetType: string) => createMatOSAssetProject(assetType),
}));

const navigate = vi.fn();
vi.mock('../../src/router', () => ({
  navigate: (...args: unknown[]) => navigate(...args),
}));

import { HomeHero } from '../../src/components/HomeHero';
import { MATOS_TEMPLATE_CHIPS } from '../../src/components/home-hero/matos-chips';

afterEach(() => {
  cleanup();
  createMatOSAssetProject.mockClear();
  navigate.mockClear();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const onPromptChange = vi.fn<(prompt: string) => void>();
  render(
    <HomeHero
      prompt=""
      onPromptChange={onPromptChange}
      onSubmit={() => undefined}
      activeChipId={null}
      onPickChip={() => undefined}
      onClearActiveChip={() => undefined}
      contextItemCount={0}
      error={null}
      {...overrides}
    />,
  );
  return { onPromptChange };
}

describe('HomeHero MatOS template rail', () => {
  it('renders the MatOS.ai product brand', () => {
    renderHero();
    expect(screen.getByLabelText('MatOS.ai')).toHaveTextContent('MatOS.ai');
  });

  it('renders every MatOS template card in the rail', () => {
    renderHero();
    const tabs = screen.getByTestId('home-hero-type-tabs');
    expect(tabs.getAttribute('data-rail-group')).toBe('matos');
    for (const chip of MATOS_TEMPLATE_CHIPS) {
      const node = screen.getByTestId(`home-hero-rail-${chip.id}`);
      expect(node).toBeTruthy();
      expect(tabs.contains(node)).toBe(true);
    }
    // The upstream OD scenario cards are replaced, not shown alongside.
    expect(screen.queryByTestId('home-hero-rail-deck')).toBeNull();
    expect(screen.queryByTestId('home-hero-rail-prototype')).toBeNull();
  });

  it('spawns an asset-editing project for asset template cards', () => {
    renderHero();
    fireEvent.click(screen.getByTestId('home-hero-rail-matos-workflow'));
    expect(createMatOSAssetProject).toHaveBeenCalledTimes(1);
    expect(createMatOSAssetProject).toHaveBeenNthCalledWith(1, 'workflow');

    fireEvent.click(screen.getByTestId('home-hero-rail-matos-knowledge'));
    expect(createMatOSAssetProject).toHaveBeenNthCalledWith(2, 'knowledge');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('pre-fills the composer for the compute-task template', () => {
    const { onPromptChange } = renderHero();
    fireEvent.click(screen.getByTestId('home-hero-rail-matos-compute'));
    // Called once by the dispatcher and possibly again by the editor's own
    // change event when setText syncs — every call carries the scaffold.
    expect(onPromptChange).toHaveBeenCalled();
    const prompt = onPromptChange.mock.calls[0]?.[0] ?? '';
    expect(prompt.length).toBeGreaterThan(20);
    expect(createMatOSAssetProject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('HomeHero MatOS template pill (composer footer)', () => {
  it('lists the MatOS catalog in the Template dropdown instead of the OD project types', () => {
    renderHero();
    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    const menu = screen.getByTestId('home-hero-template-menu');
    for (const chip of MATOS_TEMPLATE_CHIPS) {
      expect(screen.getByTestId(`home-hero-template-card-${chip.id}`)).toBeTruthy();
      expect(menu.contains(screen.getByTestId(`home-hero-template-card-${chip.id}`))).toBe(true);
    }
    // The upstream OD project-type cards are replaced, not shown alongside.
    expect(screen.queryByTestId('home-hero-template-card-deck')).toBeNull();
    expect(screen.queryByTestId('home-hero-template-card-prototype')).toBeNull();
  });

  it('fires the same MatOS actions as the rail from the dropdown cards', () => {
    const { onPromptChange } = renderHero();

    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    fireEvent.click(screen.getByTestId('home-hero-template-card-matos-skill'));
    expect(createMatOSAssetProject).toHaveBeenCalledWith('skill');

    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    fireEvent.click(screen.getByTestId('home-hero-template-card-matos-compute'));
    expect(onPromptChange).toHaveBeenCalled();
  });

  it('filters the dropdown cards by search text', () => {
    renderHero();
    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    fireEvent.change(screen.getByTestId('home-hero-template-search'), {
      target: { value: 'Workflow' },
    });
    expect(screen.getByTestId('home-hero-template-card-matos-workflow')).toBeTruthy();
    expect(screen.queryByTestId('home-hero-template-card-matos-skill')).toBeNull();
  });
});
