import { describe, expect, it } from 'vitest';
import { assistantRoleLabel } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

const t = () => 'Assistant';

describe('assistantRoleLabel', () => {
  it('prefers the persisted assistant display name over the protocol id', () => {
    const message: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: '',
      agentId: 'claude',
      agentName: 'Claude · claude-sonnet-4-6',
    };

    expect(assistantRoleLabel(message, t)).toBe('Claude · claude-sonnet-4-6');
  });

  it('preserves an explicit local agent model in the display name', () => {
    const message: ChatMessage = {
      id: 'message-4',
      role: 'assistant',
      content: '',
      agentId: 'claude',
      agentName: 'Claude · claude-sonnet-4-6',
    };

    expect(assistantRoleLabel(message, t)).toBe('Claude · claude-sonnet-4-6');
  });

  it('adds the model reported by a local CLI initializing event', () => {
    const message: ChatMessage = {
      id: 'message-5',
      role: 'assistant',
      content: '',
      agentId: 'claude',
      agentName: 'Claude',
      events: [{ kind: 'status', label: 'initializing', detail: 'claude-sonnet-4-6' }],
    };

    expect(assistantRoleLabel(message, t)).toBe('Claude · claude-sonnet-4-6');
  });
});
