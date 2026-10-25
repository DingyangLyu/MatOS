import { describe, expect, it, vi } from 'vitest';
import { readOverlappingMessagePages } from '../../src/runtime/message-page-refresh';
import type { ChatMessage } from '../../src/types';

const messages = (start: number, end: number): ChatMessage[] => Array.from({ length: end - start }, (_, i) => ({
  id: `m-${start + i}`, role: i % 2 ? 'assistant' : 'user', content: String(start + i),
}));

describe('bounded message refresh', () => {
  it('does not request older history if the latest page overlaps the loaded transcript', async () => {
    const load = vi.fn();
    const recent = { messages: messages(40, 80), nextBefore: 'm-40' };
    expect(await readOverlappingMessagePages(recent, messages(0, 65), load)).toBe(recent);
    expect(load).not.toHaveBeenCalled();
  });
  it('fills a multi-page gap, stopping at overlap without reading all earlier history', async () => {
    const load = vi.fn().mockResolvedValueOnce({ messages: messages(80, 120), nextBefore: 'm-80' })
      .mockResolvedValueOnce({ messages: messages(40, 80), nextBefore: 'm-40' });
    const page = await readOverlappingMessagePages({ messages: messages(120, 160), nextBefore: 'm-120' }, messages(0, 65), load);
    expect(page.messages.map(message => message.id)).toEqual(messages(40, 160).map(message => message.id));
    expect(page.nextBefore).toBe('m-40');
    expect(load.mock.calls).toEqual([['m-120'], ['m-80']]);
  });
  it('does not keep fetching after a conversation switch', async () => {
    const load = vi.fn();
    await readOverlappingMessagePages({ messages: messages(80, 120), nextBefore: 'm-80' }, messages(0, 40), load, () => false);
    expect(load).not.toHaveBeenCalled();
  });
  it('fails visibly instead of looping forever when an older server repeats the cursor', async () => {
    const recent = { messages: messages(80, 120), nextBefore: 'm-80' };
    await expect(readOverlappingMessagePages(recent, messages(0, 40), async () => recent)).rejects.toThrow('cursor did not advance');
  });
});
