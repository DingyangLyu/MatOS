import type { ChatMessage } from '../types';
import { listMessagesPage } from '../state/projects';

/** Load only the chat projection, never raw tool/event or hidden learning logs. */
export async function conversationExportText(
  projectId: string | null,
  conversationId: string | null,
  visibleMessages: ChatMessage[],
  hasOlderMessages: boolean,
  title?: string | null,
): Promise<string> {
  const messages = new Map<string, ChatMessage>();
  if (hasOlderMessages) {
    if (!projectId || !conversationId) throw new Error('Conversation is unavailable');
    const cursors = new Set<string>();
    let before: string | undefined;
    do {
      const page = await listMessagesPage(projectId, conversationId, before);
      for (const message of page.messages) messages.set(message.id, message);
      before = page.nextBefore ?? undefined;
      if (before && cursors.has(before)) throw new Error('Conversation pagination did not advance');
      if (before) cursors.add(before);
    } while (before);
  }
  // The latest local turn may not have reached persistence yet.
  for (const message of visibleMessages) messages.set(message.id, message);
  const sections = [...messages.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content.trim()}`);
  if (!sections.length) return '';
  return `${title?.trim() ? `# ${title.trim()}\n\n` : ''}${sections.join('\n\n')}\n`;
}
