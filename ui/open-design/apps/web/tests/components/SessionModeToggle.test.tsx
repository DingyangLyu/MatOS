// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionModeToggle } from '../../src/components/SessionModeToggle';
import { I18nProvider } from '../../src/i18n';

afterEach(() => cleanup());

describe('SessionModeToggle', () => {
  it('shows only the active mode until the menu is opened', () => {
    render(<SessionModeToggle mode="design" onChange={vi.fn()} />);

    // MatOS execution tiers: the 'design' wire mode surfaces as "Run".
    expect(screen.getByTestId('session-mode-trigger').textContent).toContain('Run');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTestId('session-mode-trigger'));

    expect(screen.getByRole('menuitemradio', { name: /Run mode/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: /Plan mode/i }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemradio', { name: /Ask mode/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches into the lightweight Ask mode from the menu', () => {
    const onChange = vi.fn();
    render(<SessionModeToggle mode="design" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Ask mode/i }));

    expect(onChange).toHaveBeenCalledWith('chat');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('switches mode from the menu', () => {
    const onChange = vi.fn();
    render(<SessionModeToggle mode="design" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Plan mode/i }));

    expect(onChange).toHaveBeenCalledWith('plan');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('tags each mode with its expected usage/cost', () => {
    render(<SessionModeToggle mode="design" onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));

    // Every option in the menu carries a usage tier so modes can be compared.
    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('Light');
    expect(menu.textContent).toContain('Standard');
    expect(menu.textContent).toContain('Heavy');

    // The description card explains the active mode's usage expectation —
    // for MatOS the Run tier is a real contract (auto-exec at max effort).
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Typical usage');
    expect(card.textContent).toContain('Auto-executes at max effort');
    expect(screen.getByRole('img', { name: 'Typical usage: Heavy' })).toBeTruthy();
  });

  it('shows localized guidance only after opening the menu', () => {
    render(
      <I18nProvider initial="zh-CN">
        <SessionModeToggle mode="plan" onChange={vi.fn()} />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('session-mode-trigger');
    fireEvent.pointerEnter(trigger);

    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip').textContent).toContain('规划模式');
    expect(screen.getByRole('tooltip').textContent).toContain('为这个体系设计一套 DFT 弛豫加能带的计算方案。');

    const runOption = screen.getByRole('menuitemradio', { name: /执行模式/i });
    fireEvent.pointerEnter(runOption);

    const menu = screen.getByRole('menu');
    const card = screen.getByRole('tooltip');
    expect(menu.textContent).not.toContain('自动运行工具与计算');
    expect(card.textContent).toContain('自动运行工具与计算');
    expect(card.textContent).toContain('最高推理强度');
    expect(card.textContent).toContain('帮我对这个结构做 DFT 弛豫并计算能带，跑完汇报结果。');
  });
});
