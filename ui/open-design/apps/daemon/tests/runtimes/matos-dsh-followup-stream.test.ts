import { expect, test } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';

test('coalesces only an identical automatic DSH follow-up, preserving novel and explicit replies', () => {
  const events: Record<string, unknown>[] = [];
  const parser = createClaudeStreamHandler(e => events.push(e));
  const feed = (value: unknown) => parser.feed(JSON.stringify(value) + '\n');
  const message = (id: string, text: string, automatic = false) => {
    const meta = { id, ...(automatic ? { matos_dsh_followup: true } : {}) };
    feed({ type: 'stream_event', event: { type: 'message_start', message: meta } });
    for (const part of [text.slice(0, 3), text.slice(3)]) {
      feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    }
    feed({ type: 'stream_event', event: { type: 'message_stop' } });
    feed({ type: 'assistant', message: { ...meta, content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  };
  message('first', 'ANSWER_OK');
  message('completion-notice', 'ANSWER_OK', true);
  message('new-evidence', 'ANSWER_OK with an additional result.', true);
  message('explicit-user-repeat', 'ANSWER_OK');
  parser.flush();
  expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('ANSWER_OKANSWER_OK with an additional result.ANSWER_OK');
});

test('an automatic follow-up with new tool work retains its commentary', () => {
  const events: Record<string, unknown>[] = [];
  const p = createClaudeStreamHandler(e => events.push(e));
  const feed = (x: unknown) => p.feed(JSON.stringify(x) + '\n');
  feed({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'Checking' }], stop_reason: 'end_turn' } });
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'two', matos_dsh_followup: true } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } } });
  feed({ type: 'stream_event', event: { type: 'message_stop' } });
  feed({ type: 'assistant', message: { id: 'two', matos_dsh_followup: true, content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'result.txt' } }], stop_reason: 'tool_use' } });
  p.flush();
  expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('CheckingChecking');
  expect(events.some(e => e.type === 'tool_use')).toBe(true);
});

test('an interrupted matching prefix is retained until an authoritative completed reply arrives', () => {
  const events: Record<string, unknown>[] = [];
  const p = createClaudeStreamHandler(e => events.push(e));
  const feed = (x: unknown) => p.feed(JSON.stringify(x) + '\n');
  feed({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'Checking' }], stop_reason: 'end_turn' } });
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'two', matos_dsh_followup: true } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } } });
  p.flush();
  expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('CheckingChecking');
});

test.each(['end_turn', 'max_tokens'])('final wrapper without a trailing newline respects %s', stopReason => {
  const events: Record<string, unknown>[] = [];
  const p = createClaudeStreamHandler(e => events.push(e));
  const feed = (x: unknown) => p.feed(JSON.stringify(x) + '\n');
  feed({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'ANSWER' }], stop_reason: 'end_turn' } });
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'two', matos_dsh_followup: true } } });
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANSWER' } } });
  feed({ type: 'stream_event', event: { type: 'message_stop' } });
  p.feed(JSON.stringify({ type: 'assistant', message: { id: 'two', matos_dsh_followup: true, content: [{ type: 'text', text: 'ANSWER' }], stop_reason: stopReason } }));
  p.flush();
  expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe(stopReason === 'end_turn' ? 'ANSWER' : 'ANSWERANSWER');
});
