// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
import type { ChatMessage } from '../../src/types';

it.each([true, false])('bottom-aligns a short active transcript (streaming=%s)', (streaming) => {
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'Check layout', createdAt: 1 },
    { id: 'a', role: 'assistant', content: 'In progress', createdAt: 2, runStatus: 'running' },
  ];
  const html = renderToStaticMarkup(<ChatPane
    messages={messages} streaming={streaming} error={null}
    projectId="layout" projectFiles={[]} onEnsureProject={async () => 'layout'}
    onSend={() => {}} onStop={() => {}} conversations={[]} activeConversationId="conversation"
    onSelectConversation={() => {}} onDeleteConversation={() => {}}
  />);
  const document = new DOMParser().parseFromString(html, 'text/html');
  expect(document.querySelector('.chat-log')?.classList.contains('is-balanced-transcript')).toBe(true);
  expect(document.querySelector('.chat-log-tail-spacer')).toBeNull();
});
