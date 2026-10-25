// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatPane, buildRunErrorDiagnosticText, retryableAssistantMessage } from '../../src/components/ChatPane';
import { readExpandedIndexCss } from '../helpers/read-expanded-css';
import type { ChatMessage, Conversation, ProjectMetadata } from '../../src/types';

const composerMocks = vi.hoisted(() => ({
  focus: vi.fn(),
  restoreDraft: vi.fn(),
  setDraft: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async (_text: string) => true),
}));

const translations: Record<string, string> = {
  'chat.mode.chat.label': 'Ask',
  'chat.mode.design.label': 'Design Agent',
  'chat.queuedHeader': 'Queued',
  'chat.queuedToSend': 'to Send',
  'chat.queuedEditQueuedTaskAria': 'Edit queued task',
  'chat.queuedSave': 'Save',
  'chat.queuedCancel': 'Cancel',
  'chat.queuedReorder': 'Drag to reorder',
  'chat.queuedEdit': 'Edit',
  'chat.queuedMore': 'more queued',
  'chat.queuedFollowUpFallback': 'Queued follow-up',
  'chat.copyErrorDiagnostic': 'Copy error diagnostics',
  'chat.copyDone': 'Copied!',
};

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (key: string) => translations[key] ?? key,
  }),
  useT: () => (key: string) => translations[key] ?? key,
}));

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({
    streaming,
    message,
    isLast,
    showConversationTodoCard,
    conversationTodoInput,
  }: {
    streaming: boolean;
    message: ChatMessage;
    isLast?: boolean;
    showConversationTodoCard?: boolean;
    conversationTodoInput?: {
      todos?: Array<{ content: string; status?: string }>;
      plan?: Array<{ content?: string; step?: string; status?: string }>;
    } | null;
  }) => (
    <>
      <output data-testid={`assistant-streaming-${message.id}`}>{streaming ? 'streaming' : 'idle'}</output>
      <output data-testid={`assistant-last-${message.id}`}>{isLast ? 'last' : 'not-last'}</output>
      {showConversationTodoCard && conversationTodoInput ? (
        <div className="op-card op-todo">
          {(conversationTodoInput.todos ?? conversationTodoInput.plan ?? []).map((todo, index) => {
            const content = 'content' in todo ? todo.content : todo.step;
            return (
              <div key={`${content}-${index}`} className={`todo-${todo.status ?? 'pending'}`}>
                <span className="todo-text">{content}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  ),
}));

vi.mock('../../src/lib/copy-to-clipboard', () => ({
  copyToClipboard: clipboardMocks.copyToClipboard,
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef(({
    onSend,
    streaming,
  }: {
    onSend?: (
      prompt: string,
      attachments: Array<{ path: string; name: string; kind: 'file' }>,
      commentAttachments: Array<{ id: string; order: number; filePath: string; comment: string }>,
    ) => void;
    streaming: boolean;
  }, ref) => {
    useImperativeHandle(ref, () => ({
      focus: composerMocks.focus,
      restoreDraft: composerMocks.restoreDraft,
      setDraft: composerMocks.setDraft,
    }));
    return (
      <>
        <output data-testid="composer-streaming">{streaming ? 'streaming' : 'idle'}</output>
        <button
          type="button"
          data-testid="composer-submit"
          onClick={() => onSend?.(
            'Use a bolder export button',
            [{ path: 'edited.md', name: 'edited.md', kind: 'file' }],
            [{ id: 'edited-comment', order: 1, filePath: 'preview.html', comment: 'Bolder' }],
          )}
        >
          submit composer
        </button>
      </>
    );
  }),
}));

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];

  callback: ResizeObserverCallback;
  observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe = (target: Element) => {
    this.observed.add(target);
  };

  unobserve = (target: Element) => {
    this.observed.delete(target);
  };

  disconnect = () => {
    this.observed.clear();
  };

  trigger(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  static triggerObserved(target: Element) {
    for (const instance of MockResizeObserver.instances) {
      if (instance.observed.has(target)) instance.trigger(target);
    }
  }
}

function mockDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn((type?: string) => {
      if (type) store.delete(type);
      else store.clear();
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ''),
    setData: vi.fn((type: string, data: string) => {
      store.set(type, data);
    }),
    setDragImage: vi.fn(),
  };
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatPane streaming state', () => {
  it('keeps queued-send strip styles compact above the composer', () => {
    const css = readExpandedIndexCss();

    expect(css).toContain('.chat-queued-send-strip');
    expect(css).toContain('display: flex;');
    expect(css).toContain('.chat-queued-send-list');
    expect(css).toContain('overflow-y: auto;');
    expect(css).toContain('.chat-queued-send-row');
    expect(css).toContain('display: grid;');
    expect(css).toContain('grid-template-columns: 24px minmax(0, 1fr) max-content;');
    expect(css).toContain('.chat-queued-send-title');
    expect(css).toContain('text-overflow: ellipsis;');
    expect(css).toContain('.chat-queued-send-drag-handle');
    expect(css).toContain('align-self: auto;');
    expect(css).toContain('.pane {');
    expect(css).toContain('--chat-composer-inline-inset: 12px;');
    expect(css).toContain('.app .split-chat-slot > .pane');
    expect(css).toContain('--chat-composer-inline-inset: 10px;');
    expect(css).toContain('width: calc(100% - (var(--chat-composer-inline-inset, 12px) * 2));');
    expect(css).toContain('margin: 0 var(--chat-composer-inline-inset, 12px) 2px;');
    expect(css).toContain('max-width: none;');
    expect(css).toContain('.chat-queued-send-action');
    expect(css).toContain('width: 24px;');
    expect(css).toContain('height: 24px;');
    expect(css).toContain('.chat-queued-send-overflow');
    expect(css).toContain('.chat-log.is-balanced-transcript > :first-child');
    expect(css).toContain('margin-top: auto;');
  });

  it('balances both finished transcripts and active turns near the composer', () => {
    const baseProps = {
      streaming: false,
      error: null,
      projectId: 'project-1',
      projectFiles: [],
      onEnsureProject: async () => 'project-1',
      onSend: vi.fn(),
      onStop: vi.fn(),
      conversations,
      activeConversationId: 'conv-1',
      onSelectConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      projectMetadata,
    };
    const { container, rerender } = render(
      <ChatPane
        {...baseProps}
        messages={[
          { id: 'user-1', role: 'user', content: 'Make the landing page', createdAt: 1 },
          { id: 'assistant-1', role: 'assistant', content: 'Done', createdAt: 2 },
        ]}
      />,
    );

    expect(container.querySelector('.chat-log')?.className).toContain('is-balanced-transcript');

    rerender(
      <ChatPane
        {...baseProps}
        streaming
        messages={[
          { id: 'user-1', role: 'user', content: 'Make the landing page', createdAt: 1 },
          { id: 'assistant-1', role: 'assistant', content: 'Done', createdAt: 2 },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: '',
            createdAt: 3,
            runStatus: 'running',
          },
        ]}
      />,
    );

    expect(container.querySelector('.chat-log')?.className).toContain('is-balanced-transcript');
  });

  it('keeps composer popovers above the chat jump button', () => {
    const css = readExpandedIndexCss();

    expect(css).toContain('.chat-jump-btn');
    expect(css).toContain('z-index: 6;');
    expect(css).toContain('.composer:has(.composer-tools-menu)');
    expect(css).toContain('.composer:has(.composer-design-toolbox-menu)');
    expect(css).toContain('.composer:has(.composer-import-menu)');
    expect(css).toContain('z-index: 80;');
  });

  it('exposes retry only for the last failed assistant when the pane is idle', () => {
    const failed: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Generation failed',
      createdAt: 1,
      runStatus: 'failed',
    };
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'Create a login page', createdAt: 0 },
      failed,
    ];

    expect(retryableAssistantMessage(messages, failed.id, false)).toBe(failed);
    expect(retryableAssistantMessage(messages, failed.id, true)).toBeNull();
    expect(retryableAssistantMessage([...messages, { ...messages[0]!, id: 'user-2' }], failed.id, false))
      .toBeNull();
  });

  it('copies failed-run diagnostics with the trace id from the error card', async () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'Create a login page', createdAt: 0 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Generation failed',
        agentId: 'amr',
        createdAt: 1,
        runId: 'run-trace-123',
        runStatus: 'failed',
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: 'json-rpc id 4: Connection reset by server',
            code: 'AGENT_EXECUTION_FAILED',
          },
        ],
      },
    ];

    render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy error diagnostics' }));

    await waitFor(() => expect(clipboardMocks.copyToClipboard).toHaveBeenCalledTimes(1));
    const copied = clipboardMocks.copyToClipboard.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('trace_id: run-trace-123');
    expect(copied).toContain('run_id: run-trace-123');
    expect(copied).toContain('error_code: AGENT_EXECUTION_FAILED');
    expect(copied).toContain('project_id: project-1');
    expect(copied).toContain('conversation_id: conv-1');
    expect(copied).toMatch(/^json-rpc id 4: Connection reset by server\n\nMatOS run error diagnostics/);
    expect(copied).not.toContain('raw_error:');
    expect(copied).not.toContain('\nerror:\n');
  });

  it('formats run error diagnostics with a raw error when guidance copy differs', () => {
    const text = buildRunErrorDiagnosticText({
      message: 'Service unavailable. Try again.',
      rawMessage: 'json-rpc id 4: Connection reset by server',
      errorCode: 'UPSTREAM_UNAVAILABLE',
      traceId: 'run-abc',
      projectId: 'project-1',
      conversationId: 'conv-1',
      assistantMessageId: 'assistant-1',
      agentId: 'amr',
    });

    expect(text).toMatch(/^json-rpc id 4: Connection reset by server\n\nMatOS run error diagnostics/);
    expect(text).not.toContain('raw_error:');
    expect(text).toContain('error_code: UPSTREAM_UNAVAILABLE');
    expect(text).not.toContain('\nerror:\n');
  });

  it('falls back to the display message when raw error text is unavailable', () => {
    const text = buildRunErrorDiagnosticText({
      message: 'Connection dropped. Try again.',
      rawMessage: '  ',
      errorCode: 'AGENT_CONNECTION_DROPPED',
      traceId: 'run-abc',
      projectId: 'project-1',
      conversationId: 'conv-1',
      assistantMessageId: 'assistant-1',
      agentId: 'amr',
    });

    expect(text).toMatch(/^Connection dropped\. Try again\.\n\nMatOS run error diagnostics/);
    expect(text).not.toContain('raw_error:');
    expect(text).toContain('error_code: AGENT_CONNECTION_DROPPED');
    expect(text).not.toContain('\nerror:\n');
  });

  it('formats pre-run project failures without misleading n/a run fields', () => {
    const text = buildRunErrorDiagnosticText({
      message: 'workspace daemon is restarting',
      projectId: 'project-1',
    });

    expect(text).toBe([
      'workspace daemon is restarting',
      '',
      'MatOS project error diagnostics',
      'project_id: project-1',
    ].join('\n'));
    expect(text).not.toContain('trace_id:');
    expect(text).not.toContain('run_id:');
  });

  it('renders user turns with the chat bubble styling hook', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Generate a simple sign-in page',
        createdAt: 1,
      },
    ];

    render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    const bubble = screen.getByText('Generate a simple sign-in page');
    expect(bubble.classList.contains('user-bubble')).toBe(true);
    expect(bubble.closest('.msg.user')).not.toBeNull();
  });

  it('shows the sent mode and workspace context on user turns', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Generate the refinement glow-up deck',
        createdAt: 1,
        sessionMode: 'design',
        runContext: {
          workspaceItems: [
            {
              id: 'browser:tab-1',
              kind: 'browser',
              label: 'Dribbble',
              tabId: 'tab-1',
              url: 'https://dribbble.com/',
            },
          ],
        },

      },
    ];

    const onRequestOpenFile = vi.fn();

    render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
        onRequestOpenFile={onRequestOpenFile}
      />,
    );

    expect(screen.getByTestId('msg-session-mode-chip').textContent).toContain('Design Agent');
    expect(screen.getByTestId('msg-workspace-context-chip').textContent).toContain('Dribbble');
    fireEvent.click(screen.getByTestId('msg-workspace-context-chip'));
    expect(onRequestOpenFile).toHaveBeenCalledWith('tab-1');
  });

  it('hides internal path ids from comment attachment chips', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '',
        createdAt: 1,
        commentAttachments: [
          {
            id: 'comment-1',
            order: 1,
            filePath: 'preview.html',
            elementId: 'path-0-0-0-0-1',
            selector: '[data-od-id="path-0-0-0-0-1"]',
            label: '',
            comment: '222',
            currentText: '',
            pagePosition: { x: 10, y: 20, width: 30, height: 40 },
            htmlHint: '<div>',
          },
        ],
      },
    ];

    render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    expect(screen.getByText('Annotation')).toBeTruthy();
    expect(screen.getByText('222')).toBeTruthy();
    expect(screen.queryByText('path-0-0-0-0-1')).toBeNull();
  });

  it('keeps composer idle while active-run messages still render as streaming', () => {
    const messages: ChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'still running',
        createdAt: 1,
        runId: 'run-1',
        runStatus: 'running',
      },
    ];

    render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    expect(screen.getByTestId('composer-streaming').textContent).toBe('idle');
    expect(screen.getByTestId('assistant-streaming-assistant-1').textContent).toBe('streaming');
  });

  it('does not reserve blank space below another local turn', () => {
    const onSend = vi.fn();
    const { container } = render(
      <ChatPane
        messages={[
          { id: 'user-1', role: 'user', content: 'Make the landing page', createdAt: 1 },
          { id: 'assistant-1', role: 'assistant', content: 'Done', createdAt: 2 },
        ]}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={onSend}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    expect(container.querySelector('.chat-log-tail-spacer')).toBeNull();

    fireEvent.click(screen.getByTestId('composer-submit'));

    expect(onSend).toHaveBeenCalledOnce();
    expect(container.querySelector('.chat-log-tail-spacer')).toBeNull();
  });

  it('passes a stopped inline todo after a terminal run without a final TodoWrite', () => {
    const messages: ChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        runStatus: 'failed',
        events: [
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                {
                  content: 'Build prototype',
                  status: 'in_progress',
                  activeForm: 'Building prototype',
                },
                { content: 'Run QA', status: 'pending' },
              ],
            },
          },
        ],
      },
    ];

    const { container } = render(
      <ChatPane
        messages={messages}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    expect(container.querySelectorAll('.chat-log .op-card.op-todo')).toHaveLength(1);
    expect(container.querySelector('.todo-stopped .todo-text')?.textContent).toBe('Build prototype');
    expect(container.querySelector('.todo-pending .todo-text')?.textContent).toBe('Run QA');
    expect(container.querySelector('.chat-pinned-todo')).toBeNull();
  });
  it('shows several queued prompts above the composer with compact controls', () => {
    const onRemoveQueuedSend = vi.fn();
    const onSendQueuedNow = vi.fn();
    const onUpdateQueuedSend = vi.fn();
    const onReorderQueuedSends = vi.fn();
    const { container } = render(
      <ChatPane
        messages={[]}
        streaming
        error={null}
        projectId="project-1"
        projectFiles={[]}
        queuedItems={[
          {
            id: 'queued-1',
            prompt: 'Make the export button larger and use a warmer accent',
            attachments: [{ path: 'brief.md', name: 'brief.md', kind: 'file' }],
            commentAttachments: [
              {
                id: 'comment-1',
                order: 1,
                filePath: 'preview.html',
                elementId: 'hero',
                selector: '#hero',
                label: 'Hero',
                comment: 'Use a warmer accent',
                currentText: 'Export',
                pagePosition: { x: 10, y: 20, width: 30, height: 40 },
                htmlHint: '<section id="hero">',
              },
            ],
          },
          { id: 'queued-2', prompt: 'Then adjust the title spacing' },
          { id: 'queued-3', prompt: 'Reduce the subtitle size' },
          { id: 'queued-4', prompt: 'Switch to a lighter font weight' },
          { id: 'queued-5', prompt: 'Add hover polish' },
        ]}
        onRemoveQueuedSend={onRemoveQueuedSend}
        onSendQueuedNow={onSendQueuedNow}
        onUpdateQueuedSend={onUpdateQueuedSend}
        onReorderQueuedSends={onReorderQueuedSends}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    const strip = container.querySelector('.chat-queued-send-strip');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain('5 Queued');
    expect(strip?.textContent).toContain('to Send');
    expect(strip?.textContent).not.toContain('Start Multitasking');
    expect(container.querySelectorAll('.chat-queued-send-row')).toHaveLength(5);
    expect(strip?.textContent).toContain('Make the export button larger and use a warmer accent');
    expect(strip?.textContent).toContain('Then adjust the title spacing');
    expect(strip?.textContent).toContain('Reduce the subtitle size');
    expect(strip?.textContent).toContain('Switch to a lighter font weight');
    expect(strip?.textContent).toContain('Add hover polish');
    expect(container.querySelector('.chat-queued-send-list')?.className).toContain('is-scrollable');
    expect(container.querySelector('.chat-queued-send-overflow')?.textContent).toContain('+1 more queued');
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(5);

    const sendNowButtons = screen.getAllByRole('button', { name: 'chat.send' });
    fireEvent.click(sendNowButtons[1]!);
    expect(onSendQueuedNow).toHaveBeenCalledWith('queued-2');

    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[0]!);
    expect(composerMocks.restoreDraft).toHaveBeenCalledWith({
      text: 'Make the export button larger and use a warmer accent',
      attachments: [{ path: 'brief.md', name: 'brief.md', kind: 'file' }],
      commentAttachments: [
        {
          id: 'comment-1',
          order: 1,
          filePath: 'preview.html',
          elementId: 'hero',
          selector: '#hero',
          label: 'Hero',
          comment: 'Use a warmer accent',
          currentText: 'Export',
          pagePosition: { x: 10, y: 20, width: 30, height: 40 },
          htmlHint: '<section id="hero">',
        },
      ],
    });
    expect(onUpdateQueuedSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('composer-submit'));
    expect(onUpdateQueuedSend).toHaveBeenCalledWith('queued-1', {
      prompt: 'Use a bolder export button',
      attachments: [{ path: 'edited.md', name: 'edited.md', kind: 'file' }],
      commentAttachments: [
        { id: 'edited-comment', order: 1, filePath: 'preview.html', comment: 'Bolder' },
      ],
    });

    const removeButtons = screen.getAllByRole('button', { name: 'chat.comments.remove' });
    fireEvent.click(removeButtons[1]!);
    expect(onRemoveQueuedSend).toHaveBeenCalledWith('queued-2');
  });

  it('reorders queued prompts with the drag handle', () => {
    const onReorderQueuedSends = vi.fn();
    const { container } = render(
      <ChatPane
        messages={[]}
        streaming
        error={null}
        projectId="project-1"
        projectFiles={[]}
        queuedItems={[
          { id: 'queued-1', prompt: 'First queued follow-up' },
          { id: 'queued-2', prompt: 'Second queued follow-up' },
          { id: 'queued-3', prompt: 'Third queued follow-up' },
        ]}
        onReorderQueuedSends={onReorderQueuedSends}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    const rows = container.querySelectorAll('.chat-queued-send-row');
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' });
    const dataTransfer = mockDataTransfer();
    const targetRect = {
      top: 0,
      height: 30,
      bottom: 30,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    Object.defineProperty(rows[2]!, 'getBoundingClientRect', {
      configurable: true,
      value: () => targetRect,
    });

    fireEvent.dragStart(handles[0]!, { dataTransfer });
    fireEvent.dragOver(rows[2]!, { dataTransfer, clientY: 29 });
    fireEvent.drop(rows[2]!, { dataTransfer, clientY: 29 });

    expect(onReorderQueuedSends).toHaveBeenCalledWith([
      'queued-2',
      'queued-3',
      'queued-1',
    ]);
  });

  it('falls back to the localized queued follow-up label for blank prompts', () => {
    render(
      <ChatPane
        messages={[]}
        streaming
        error={null}
        projectId="project-1"
        projectFiles={[]}
        queuedItems={[{ id: 'queued-1', prompt: '   ' }]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    expect(screen.getByText('Queued follow-up')).toBeTruthy();
  });

  it('auto-follows when the queued strip resizes while pinned to bottom', () => {
    const { container } = render(
      <ChatPane
        messages={[]}
        streaming
        error={null}
        projectId="project-1"
        projectFiles={[]}
        queuedItems={[{ id: 'queued-1', prompt: 'First queued follow-up' }]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={conversations}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={projectMetadata}
      />,
    );

    const log = container.querySelector('.chat-log') as HTMLDivElement | null;
    const strip = screen.getByTestId('chat-queued-send-strip');
    expect(log).not.toBeNull();
    expect(strip).toBeTruthy();

    Object.defineProperty(log!, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(log!, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(log!, 'scrollTop', {
      configurable: true,
      get() {
        return (this as HTMLDivElement).dataset.scrollTop
          ? Number((this as HTMLDivElement).dataset.scrollTop)
          : 400;
      },
      set(value: number) {
        (this as HTMLDivElement).dataset.scrollTop = String(value);
      },
    });

    MockResizeObserver.triggerObserved(strip);

    expect(log!.scrollTop).toBe(600);
  });
});

const conversations: Conversation[] = [
  {
    id: 'conv-1',
    projectId: 'project-1',
    title: 'Conversation 1',
    createdAt: 1,
    updatedAt: 1,
  },
];

const projectMetadata: ProjectMetadata = {
  kind: 'prototype',
};
