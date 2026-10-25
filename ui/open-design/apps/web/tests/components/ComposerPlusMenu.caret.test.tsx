// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerPlusMenu } from '../../src/components/ComposerPlusMenu';
import type { McpServerConfig } from '@open-design/contracts';

// Regression coverage ported from the now-deleted
// `ChatComposer.tools-menu-caret.test.tsx` (#3195 / #3368). The shared "+"
// menu rows that insert a context/mention call `onPick*`, which the chat
// composer wires to `editorRef.current?.insertMention(...)`. Lexical reads the
// collapsed range at insert time; if the picker button takes focus on
// mousedown first, the range is lost and `insertMention` falls back to
// `$getRoot().selectEnd()` (LexicalComposerInput.tsx:721-728) — the mention
// then lands at the end of the draft instead of at the user's caret.
//
// jsdom does not move focus on raw mousedown, so we assert the contract
// directly: each mention-inserting picker row must `preventDefault()` on
// mousedown so a real browser never transfers focus before the click handler
// runs.

const MCP_SERVER: McpServerConfig = {
  id: 'slack',
  label: 'Slack MCP',
  transport: 'stdio',
  enabled: true,
  command: 'slack-mcp',
};

function renderMenu() {
  return render(
    <ComposerPlusMenu
      mcpServers={[MCP_SERVER]}
      onPickMcp={vi.fn()}
      onAttachFiles={vi.fn()}
    />,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
}

function openSubmenu(label: string) {
  const parent = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button.plus-menu__parent'),
  ).find((btn) => btn.textContent?.includes(label));
  expect(parent).toBeTruthy();
  fireEvent.click(parent!);
}

function pickerRow(text: string): HTMLButtonElement {
  const row = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.plus-menu__flyout button.plus-menu__item'),
  ).find((btn) => btn.textContent?.includes(text));
  expect(row).toBeTruthy();
  return row!;
}

function expectMousedownPrevented(row: HTMLButtonElement) {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  row.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

afterEach(() => {
  cleanup();
});

describe('ComposerPlusMenu picker mousedown protection (#3195)', () => {
  it('the MCP picker prevents default on mousedown so the caret survives focus transfer', () => {
    renderMenu();
    openMenu();
    openSubmenu('MCP');
    expectMousedownPrevented(pickerRow('Slack MCP'));
  });
});
