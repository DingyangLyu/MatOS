// @vitest-environment jsdom
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The rail leads with the slide deck ("Slides") per the curated create
//     order.
//   - The finer-grained scenarios (wireframe / mobile / document) exist and
//     route to a project kind.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const placeholderCarouselMock = vi.hoisted(() => ({
  reportScenario: false,
  reportedScenarioId: null as string | null,
}));

// This suite covers the upstream OD scenario rail; the MatOS product
// default replaces it with the MatOS template rail, so pin the gate off.
vi.mock('../../src/features/matosHomeTemplates', () => ({
  MATOS_HOME_TEMPLATES_VISIBLE: false,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: ({
    scenarios,
    active,
    onScenarioChange,
  }: {
    scenarios: Array<{ id: string; chipId?: string | null; text: string }>;
    active: boolean;
    onScenarioChange: (scenario: { id: string; chipId?: string | null; text: string }) => void;
  }) => {
    const scenario = scenarios[0];
    if (
      placeholderCarouselMock.reportScenario &&
      active &&
      scenario &&
      placeholderCarouselMock.reportedScenarioId !== scenario.id
    ) {
      placeholderCarouselMock.reportedScenarioId = scenario.id;
      queueMicrotask(() => onScenarioChange(scenario));
    }
    return null;
  },
}));

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';

afterEach(() => {
  placeholderCarouselMock.reportScenario = false;
  placeholderCarouselMock.reportedScenarioId = null;
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activeChipId: null,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

describe('HomeHero scenario cards', () => {
  it('renders each create scenario card with a title and a description', () => {
    renderHero();
    const prototype = screen.getByTestId('home-hero-rail-prototype');
    expect(prototype.textContent).toContain('Prototype');
    expect(prototype.textContent).toContain('Interactive app mockups');

    const deck = screen.getByTestId('home-hero-rail-deck');
    expect(deck.textContent).toContain('Presentations & pitch decks');
  });

  it('leads the create rail with the slide deck', () => {
    expect(orderedCreateChips()[0]?.id).toBe('deck');
  });

  it('adds the finer-grained scenarios as create cards', () => {
    renderHero();
    for (const id of ['wireframe', 'mobile', 'document']) {
      const card = screen.getByTestId(`home-hero-rail-${id}`);
      const tabs = screen.getByTestId('home-hero-type-tabs');
      expect(tabs.contains(card)).toBe(true);
      expect(findChip(id)?.action.kind).toBe('create-project');
    }
    // Wireframe keeps the lo-fi prototype metadata.
    expect(findChip('wireframe')?.action).toMatchObject({
      kind: 'create-project',
      projectKind: 'prototype',
      projectMetadata: { kind: 'prototype', fidelity: 'wireframe' },
    });
    expect(findChip('document')?.action).toMatchObject({
      kind: 'create-project',
      projectKind: 'other',
    });
  });
});
