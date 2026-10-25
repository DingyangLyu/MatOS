import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationExportText } from '../../src/runtime/conversation-export';
import { listMessagesPage } from '../../src/state/projects';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/state/projects', () => ({ listMessagesPage: vi.fn() }));
const message = (id: string, content: string, createdAt: number): ChatMessage => ({
  id, content, createdAt, role: 'assistant', events: [],
});
beforeEach(() => vi.clearAllMocks());

describe('conversation export', () => {
  it('keeps raw math and skips empty turns', async () => {
    const result = await conversationExportText('p', 'c', [message('a', '$E=mc^2$', 1), message('b', '', 2)], false, 'Report');
    expect(result).toBe('# Report\n\n## Assistant\n\n$E=mc^2$\n');
    expect(listMessagesPage).not.toHaveBeenCalled();
  });

  it('loads all older pages, deduplicates and preserves the newest local text', async () => {
    vi.mocked(listMessagesPage)
      .mockResolvedValueOnce({ messages: [message('b', 'persisted', 2)], nextBefore: 'older' })
      .mockResolvedValueOnce({ messages: [message('a', 'first', 1)], nextBefore: null });
    const result = await conversationExportText('p', 'c', [message('b', 'latest', 2)], true);
    expect(result).toBe('## Assistant\n\nfirst\n\n## Assistant\n\nlatest\n');
    expect(listMessagesPage).toHaveBeenLastCalledWith('p', 'c', 'older');
  });

  it('does not silently export partial history after a request failure or repeated cursor', async () => {
    vi.mocked(listMessagesPage).mockRejectedValueOnce(new Error('unavailable'));
    await expect(conversationExportText('p', 'c', [], true)).rejects.toThrow('unavailable');
    vi.mocked(listMessagesPage).mockResolvedValue({ messages: [], nextBefore: 'stuck' });
    await expect(conversationExportText('p', 'c', [], true)).rejects.toThrow('did not advance');
  });
});
