import { describe, expect, it } from 'vitest';

import {
  buildQuestionFormKey,
  mergeServerMessagesIntoConversation,
} from '../../src/components/ProjectView';
import type { ChatMessage, ProjectFile } from '../../src/types';

describe('buildQuestionFormKey', () => {
  it('is stable across a streaming form-id change (no remount mid-answer)', () => {
    // The streaming preview shows the `discovery` fallback id until the body id
    // streams in; a form that emits answerable questions before its id flips
    // the parsed id late. The React key must NOT change across that flip, or
    // the panel remounts and drops in-progress selections. Same conversation +
    // message ⇒ same key regardless of the parsed id.
    const early = buildQuestionFormKey('conv-1', 'msg-1', true);
    const settled = buildQuestionFormKey('conv-1', 'msg-1', true);
    expect(early).toBe('conv-1:msg-1');
    expect(settled).toBe(early);
  });

  it('gives a distinct key to a later form in a different assistant message', () => {
    // A second discovery form (same `discovery` template id) lives in its own
    // assistant message, so it still gets its own key and replays the reveal —
    // without folding the id into the key.
    expect(buildQuestionFormKey('conv-1', 'msg-1', true)).not.toBe(
      buildQuestionFormKey('conv-1', 'msg-2', true),
    );
  });

  it('returns null until a form, conversation, and message are all present', () => {
    expect(buildQuestionFormKey(null, 'msg-1', true)).toBeNull();
    expect(buildQuestionFormKey('conv-1', null, true)).toBeNull();
    expect(buildQuestionFormKey('conv-1', 'msg-1', false)).toBeNull();
  });
});

describe('mergeServerMessagesIntoConversation', () => {
  it('keeps loaded older pages before the refreshed recent page and live rows after it', () => {
    const messages: ChatMessage[] = Array.from({ length: 85 }, (_, i) => ({
      id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: String(i),
    }));
    const merged = mergeServerMessagesIntoConversation(messages, messages.slice(40, 80), true);
    expect(merged.map(message => message.id)).toEqual(messages.map(message => message.id));
  });

  it('adds server-created CTA messages while preserving local produced files', () => {
    const producedFile: ProjectFile = {
      name: 'deck.html',
      size: 1024,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    const localMessages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Use this SKILL.md',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        runStatus: 'succeeded',
        producedFiles: [producedFile],
      },
    ];
    const serverMessages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Use this SKILL.md',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        runStatus: 'succeeded',
      },
      {
        id: 'cta-1',
        role: 'assistant',
        content: '',
        events: [{ kind: 'usage', inputTokens: 1, outputTokens: 1 }],
      },
    ];

    const merged = mergeServerMessagesIntoConversation(localMessages, serverMessages);

    expect(merged.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'cta-1']);
    expect(merged[1]?.producedFiles).toEqual([producedFile]);
  });

  it('adopts repaired server order while preserving richer local message fields', () => {
    const localMessages: ChatMessage[] = [
      { id: 'assistant-2', role: 'assistant', content: 'MatOS streaming', createdAt: 900 },
      { id: 'user-2', role: 'user', content: 'Who are you?', createdAt: 1000 },
    ];
    const serverMessages: ChatMessage[] = [
      { id: 'user-2', role: 'user', content: 'Who are you?', createdAt: 1000 },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'MatOS',
        createdAt: 900,
        turnUserMessageId: 'user-2',
      },
    ];

    const merged = mergeServerMessagesIntoConversation(localMessages, serverMessages);

    expect(merged.map((message) => message.id)).toEqual(['user-2', 'assistant-2']);
    expect(merged[1]?.content).toBe('MatOS streaming');
  });

  it('appends not-yet-persisted local turn rows in their live order', () => {
    const localMessages: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'Earlier' },
      { id: 'assistant-1', role: 'assistant', content: 'Earlier answer' },
      { id: 'user-live', role: 'user', content: 'New turn' },
      { id: 'assistant-live', role: 'assistant', content: '', runStatus: 'running' },
    ];
    const serverMessages = localMessages.slice(0, 2);

    const merged = mergeServerMessagesIntoConversation(localMessages, serverMessages);

    expect(merged.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-live',
      'assistant-live',
    ]);
  });
});
