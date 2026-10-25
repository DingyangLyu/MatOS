// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SideChatTab } from '../../../src/components/workspace/SideChatTab';
import type { AppConfig, Conversation } from '../../../src/types';

const chatPaneMock = vi.fn((_: unknown) => <div data-testid="chat-pane" />);
const useConversationChatMock = vi.fn((
  _projectId: string,
  _conversationId: string,
  _context: unknown,
) => ({
  messages: [],
  streaming: false,
  loading: false,
  error: null,
  onSend: vi.fn(),
  onStop: vi.fn(),
}));

vi.mock('../../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../../src/components/Icon', () => ({
  Icon: () => <span data-testid="icon" />,
}));

vi.mock('../../../src/components/ChatPane', () => ({
  ChatPane: (props: unknown) => chatPaneMock(props),
}));

vi.mock('../../../src/components/workspace/useConversationChat', () => ({
  useConversationChat: (projectId: string, conversationId: string, context: unknown) =>
    useConversationChatMock(projectId, conversationId, context),
}));

afterEach(() => {
  cleanup();
  chatPaneMock.mockClear();
  useConversationChatMock.mockClear();
});

describe('SideChatTab', () => {
  it('passes the live config through to ChatPane', () => {
    const config = {
      agentCliEnv: {
        amr: { OPEN_DESIGN_AMR_PROFILE: 'test' },
      },
    } as unknown as AppConfig;
    const conversations = [
      {
        id: 'conv-1',
        title: 'Current',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectId: 'project-1',
        messageCount: 0,
        sessionMode: 'design',
      },
    ] as unknown as Conversation[];

    render(
      <SideChatTab
        projectId="project-1"
        conversationId="conv-1"
        config={config}
        agentsById={new Map()}
        locale="en"
        projectMemberRefs={['role:compute@1.0.0', 'role:deep-research@0.2.0']}
        projectMatosRoleRef="role:deep-research@0.2.0"
        matosRolePicker={<div data-testid="project-role-picker" />}
        projectFiles={[]}
        conversations={conversations}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(chatPaneMock).toHaveBeenCalled();
    const firstCall = chatPaneMock.mock.calls[0];
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        config,
        matosRolePicker: expect.anything(),
      }),
    );
    expect(useConversationChatMock).toHaveBeenCalledWith(
      'project-1',
      'conv-1',
      expect.objectContaining({
        projectMemberRefs: ['role:compute@1.0.0', 'role:deep-research@0.2.0'],
        projectRoleRef: 'role:deep-research@0.2.0',
        conversationRoleRef: null,
      }),
    );
  });

  it('gives a member-bound side chat precedence over the project role', () => {
    const conversation = {
      id: 'conv-member',
      title: 'Compute',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: 'project-1',
      roleRef: 'role:compute@1.0.0',
    } as Conversation;

    render(
      <SideChatTab
        projectId="project-1"
        conversationId={conversation.id}
        config={{} as AppConfig}
        agentsById={new Map()}
        locale="en"
        projectMemberRefs={['role:compute@1.0.0', 'role:deep-research@0.2.0']}
        projectMatosRoleRef="role:deep-research@0.2.0"
        projectFiles={[]}
        conversations={[conversation]}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(useConversationChatMock).toHaveBeenCalledWith(
      'project-1',
      conversation.id,
      expect.objectContaining({ conversationRoleRef: 'role:compute@1.0.0' }),
    );
  });
});
