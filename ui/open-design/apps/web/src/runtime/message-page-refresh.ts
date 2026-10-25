import type { ChatMessage } from '../types';

interface MessagePage { messages: ChatMessage[]; nextBefore?: string | null }

/** Refresh only enough recent pages to overlap the already loaded transcript.
 * This avoids both a full-history read on every completion and silent gaps
 * after another client has added more than one page of messages. */
export async function readOverlappingMessagePages(
  recent: MessagePage,
  current: ChatMessage[],
  loadOlder: (before: string) => Promise<MessagePage>,
  isCurrent: () => boolean = () => true,
): Promise<MessagePage> {
  const known = new Set(current.map(message => message.id));
  const visited = new Set<string>();
  let page = recent;
  while (known.size && page.nextBefore && !page.messages.some(message => known.has(message.id)) && isCurrent()) {
    const cursor = page.nextBefore;
    if (visited.has(cursor)) throw new Error('Message history cursor did not advance. Please retry.');
    visited.add(cursor);
    const older = await loadOlder(cursor);
    const ids = new Set(page.messages.map(message => message.id));
    page = { ...older, messages: [...older.messages.filter(message => !ids.has(message.id)), ...page.messages] };
  }
  return page;
}
