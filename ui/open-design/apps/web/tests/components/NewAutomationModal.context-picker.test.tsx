// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewAutomationModal } from '../../src/components/NewAutomationModal';
import type { SkillSummary } from '../../src/types';
import { fetchMcpServers } from '../../src/state/mcp';

vi.mock('../../src/state/mcp', () => ({
  fetchMcpServers: vi.fn(),
}));

const skill: SkillSummary = {
  id: 'context-refresh',
  name: 'Context Refresh',
  description: 'Update project context.',
  triggers: ['context'],
  mode: 'prototype',
  previewType: 'html',
  defaultFor: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Refresh context',
  aggregatesExamples: false,
};


const mcpServer = {
  id: 'figma',
  label: 'Figma MCP',
  transport: 'stdio' as const,
  enabled: true,
  command: 'figma-mcp',
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('NewAutomationModal context picker', () => {
  it('picks skills and MCP servers from @ in the prompt', async () => {
    vi.mocked(fetchMcpServers).mockResolvedValue({ servers: [mcpServer], templates: [] });

    render(
      <NewAutomationModal
        open
        templates={[]}
        projects={[]}
        skills={[skill]}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );

    const prompt = screen.getByTestId('automation-modal-prompt') as HTMLTextAreaElement;

    fireEvent.change(prompt, {
      target: { value: 'Run @context', selectionStart: 'Run @context'.length },
    });
    const mentionPopover = screen.getByTestId('automation-mention-popover');
    const promptWrap = prompt.closest('.automation-modal__prompt-wrap');
    expect(mentionPopover).toBeTruthy();
    expect(promptWrap?.classList.contains('is-mentioning')).toBe(true);
    expect(mentionPopover.closest('.automation-modal__prompt-wrap')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('option', { name: /Context Refresh/i }));
    expect(prompt.value).toContain('@Context Refresh');
    await waitFor(() => expect(fetchMcpServers).toHaveBeenCalled());

    fireEvent.change(prompt, {
      target: { value: `${prompt.value} @figma`, selectionStart: `${prompt.value} @figma`.length },
    });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Figma MCP/i }));
    expect(prompt.value).toContain('@Figma MCP');

    expect(screen.getByTitle('Remove Context Refresh')).toBeTruthy();
    expect(screen.getByTitle('Remove Figma MCP')).toBeTruthy();
  });
});
