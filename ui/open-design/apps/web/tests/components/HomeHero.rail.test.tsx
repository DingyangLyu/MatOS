// @vitest-environment jsdom
//
// Home intent tabs / shortcuts.
// Covers:
//   - Every chip in the catalog renders with its test id.
//   - Clicking a chip forwards the full chip descriptor to onPickChip
//     so the dispatcher in HomeView can route to the right flow.
//   - The active + pending UI states light up the right chip and
//     disable all chips while a chip selection is pending.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

// These suites cover the upstream OD scenario rail; the MatOS product
// default replaces it with the MatOS template rail, so pin the gate off.
vi.mock('../../src/features/matosHomeTemplates', () => ({
  MATOS_HOME_TEMPLATES_VISIBLE: false,
}));

import { HomeHero } from '../../src/components/HomeHero';
import {
  HOME_HERO_CHIPS,
  findChip,
} from '../../src/components/home-hero/chips';

afterEach(() => {
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const onPickChip = vi.fn();
  const onClearActiveChip = vi.fn();
  render(
    <HomeHero
      prompt=""
      onPromptChange={() => undefined}
      onSubmit={() => undefined}
      activeChipId={null}
      onPickChip={onPickChip}
      onClearActiveChip={onClearActiveChip}
      contextItemCount={0}
      error={null}
      {...overrides}
    />,
  );
  return { onPickChip, onClearActiveChip };
}

describe('HomeHero intent rail', () => {
  it('renders creation chips as composer tabs and collapses shortcuts behind More', () => {
    renderHero();
    const tabs = screen.getByTestId('home-hero-type-tabs');
    for (const chip of HOME_HERO_CHIPS) {
      if (chip.group === 'create') {
        const node = screen.getByTestId(`home-hero-rail-${chip.id}`);
        expect(node).toBeTruthy();
        expect(tabs.contains(node)).toBe(true);
      } else {
        expect(screen.queryByTestId(`home-hero-rail-${chip.id}`)).toBeNull();
      }
    }
    fireEvent.click(screen.getByTestId('home-hero-shortcuts-trigger'));
    const menu = screen.getByTestId('home-hero-shortcuts-menu');
    for (const chip of HOME_HERO_CHIPS.filter((item) => item.group === 'migrate')) {
      const node = screen.getByTestId(`home-hero-rail-${chip.id}`);
      expect(node).toBeTruthy();
      expect(menu.contains(node)).toBe(true);
    }
  });

  it('renders execution switcher inside the input footer when provided', () => {
    renderHero({
      executionSwitcher: (
        <button type="button" data-testid="home-execution-switcher">
          Local CLI
        </button>
      ),
    });

    const switcher = screen.getByTestId('home-execution-switcher');
    const footer = switcher.closest('.home-hero__input-foot');
    expect(footer).toBeTruthy();
  });

  it('forwards the matching chip descriptor when clicked', () => {
    const { onPickChip } = renderHero();
    fireEvent.click(screen.getByTestId('home-hero-rail-deck'));
    expect(onPickChip).toHaveBeenCalledTimes(1);
    expect(onPickChip).toHaveBeenCalledWith(findChip('deck'));
  });

  it('moves the active creation chip into the composer and hides the tab row', () => {
    renderHero({ activeChipId: 'deck' });
    expect(screen.queryByTestId('home-hero-type-tabs')).toBeNull();
    expect(screen.queryByTestId('home-hero-rail-deck')).toBeNull();
    const node = screen.getByTestId('home-hero-template-trigger');
    expect(node.textContent).toContain('Slide deck');
  });

  it('lets the active creation chip be removed from the composer', () => {
    const { onClearActiveChip } = renderHero({ activeChipId: 'prototype' });
    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    fireEvent.click(screen.getByTestId('home-hero-template-clear'));
    expect(onClearActiveChip).toHaveBeenCalledTimes(1);
  });

  it('clears the template pill to None even after a hovered rail card was picked', () => {
    // The rail owns the hover-preview and unmounts the instant a template
    // becomes active, so its mouseleave never fires — the preview must not
    // outlive the committed selection or Clear leaves a stale pill (issue: the
    // pill stayed "Slide deck" after Clear).
    const baseProps = {
      prompt: '',
      onPromptChange: () => undefined,
      onSubmit: () => undefined,
      activeChipId: null,
      onPickChip: vi.fn(),
      onClearActiveChip: vi.fn(),
      contextItemCount: 0,
      error: null,
    } as React.ComponentProps<typeof HomeHero>;

    const { rerender } = render(<HomeHero {...baseProps} activeChipId={null} />);

    // Hover the Slide deck card → the footer pill previews it.
    fireEvent.mouseEnter(screen.getByTestId('home-hero-rail-deck'));
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');

    // Pick commits the chip; the rail unmounts without firing mouseleave.
    rerender(<HomeHero {...baseProps} activeChipId="deck" />);
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');

    // Clear nulls the active chip — the pill must fall back to None.
    rerender(<HomeHero {...baseProps} activeChipId={null} />);
    const trigger = screen.getByTestId('home-hero-template-trigger');
    expect(trigger.textContent).toContain('None');
    expect(trigger.textContent).not.toContain('Slide deck');
  });

  it('clears the template pill to None when Clear is pressed on a stale hover-preview', () => {
    // Hovering a rail card previews it in the footer pill while the active chip
    // is still null. The reset that drops the preview keys on the *committed*
    // chip changing, so when the pointer never leaves the card (or the rail
    // unmounts mid-hover) the preview outlives the hover with activeChipId still
    // null. Pressing Clear there is a no-op on the active chip, so the pill must
    // drop the preview itself or it stays stuck on the hovered template.
    // (Reported: pill stayed on the picked template after Clear.)
    const { onClearActiveChip } = renderHero({ activeChipId: null });

    fireEvent.mouseEnter(screen.getByTestId('home-hero-rail-deck'));
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');

    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    fireEvent.click(screen.getByTestId('home-hero-template-clear'));

    expect(onClearActiveChip).toHaveBeenCalledTimes(1);
    const trigger = screen.getByTestId('home-hero-template-trigger');
    expect(trigger.textContent).toContain('None');
    expect(trigger.textContent).not.toContain('Slide deck');
  });

  it('shows prompt examples below the composer for the selected tab', () => {
    const onPromptChange = vi.fn();
    renderHero({ activeChipId: 'deck', onPromptChange });

    expect(screen.getByTestId('home-hero-prompt-examples')).toBeTruthy();
    const examples = screen.getAllByTestId('home-hero-prompt-example');
    expect(examples).toHaveLength(4);

    fireEvent.click(examples[0]!);
    expect(onPromptChange).toHaveBeenCalledWith(
      'Research the market opportunity for a product launch, including competitors, target users, pricing hypotheses, and launch narrative',
    );
    // The top "selected example" pill was removed from the composer; picking an
    // example still seeds the prompt but no longer surfaces a dismissible chip.
    expect(screen.queryByTestId('home-hero-active-example')).toBeNull();
  });

  it('keeps the generic fallback in the free-form prompt instead of an Other chip', () => {
    renderHero();

    expect(findChip('other')).toBeUndefined();
    expect(screen.queryByTestId('home-hero-rail-other')).toBeNull();
  });

  it('template chip carries the right action discriminator', () => {
    expect(findChip('folder')).toBeUndefined();
    expect(findChip('template')?.action).toMatchObject({ kind: 'open-template-picker' });
  });

  it('prototype and slide-deck chips create their project kind', () => {
    expect(findChip('prototype')?.action).toMatchObject({ kind: 'create-project', projectKind: 'prototype' });
    expect(findChip('deck')?.action).toMatchObject({ kind: 'create-project', projectKind: 'deck' });
  });

});
