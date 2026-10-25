// @vitest-environment jsdom

/**
 * Product gate for the chat-only next-step card. The underlying action
 * component remains available for other surfaces, but terminal assistant
 * messages must not reserve space for the large follow-up panel.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage, ProjectFile } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Done.',
    runStatus: 'succeeded',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [{ kind: 'text', text: 'Done.' } as NonNullable<ChatMessage['events']>[number]],
    producedFiles: [],
    ...overrides,
  } as ChatMessage;
}

function producedFile(name: string, kind: ProjectFile['kind'] = 'html'): ProjectFile {
  return {
    name,
    path: name,
    size: 100,
    mtime: 1700000005,
    kind,
    mime: kind === 'html' ? 'text/html' : 'application/octet-stream',
  } as ProjectFile;
}

describe('AssistantMessage next-step affordance', () => {
  it('keeps the next-step card hidden after a successful artifact turn', () => {
    render(
      <AssistantMessage
        message={baseMessage({ producedFiles: [producedFile('landing.html')] })}
        streaming={false}
        projectId="proj-1"
        isLast
        onArtifactDownload={vi.fn()}
        onToolboxAction={vi.fn()}
        onNextStepPromptAction={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('next-step-actions')).toBeNull();
  });

  it('keeps the card hidden after a failed turn without an artifact', () => {
    render(
      <AssistantMessage
        message={baseMessage({ runStatus: 'failed', producedFiles: [] })}
        streaming={false}
        projectId="proj-1"
        isLast
        onToolboxAction={vi.fn()}
        onNextStepPromptAction={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('next-step-actions')).toBeNull();
  });

  it('does not hide the normal file summary with the card', () => {
    render(
      <AssistantMessage
        message={baseMessage({ producedFiles: [producedFile('notes.md', 'text')] })}
        streaming={false}
        projectId="proj-1"
        isLast
        onNextStepPromptAction={vi.fn()}
      />,
    );

    expect(screen.getByTestId('file-ops-summary')).toBeTruthy();
    expect(screen.getByTestId('file-ops-row-notes.md')).toBeTruthy();
    expect(screen.queryByTestId('next-step-actions')).toBeNull();
  });
});
