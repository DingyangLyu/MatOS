import { describe, expect, it } from 'vitest';

import { shouldPreserveExistingAgentSession } from '../../src/runtimes/run-recovery.js';

describe('recovered run session cursor ordering', () => {
  it('preserves a later conversation session when lazily recovering an older run', () => {
    expect(shouldPreserveExistingAgentSession({
      lastMessageId: 'assistant-new',
      existingPosition: 8,
      recoveringPosition: 4,
      updatedAt: 800,
    }, {
      assistantMessageId: 'assistant-old',
      updatedAt: 400,
    })).toBe(true);
  });

  it('allows the interrupted newer turn to advance an older stored session', () => {
    expect(shouldPreserveExistingAgentSession({
      lastMessageId: 'assistant-old',
      existingPosition: 4,
      recoveringPosition: 8,
      updatedAt: 400,
    }, {
      assistantMessageId: 'assistant-new',
      updatedAt: 800,
    })).toBe(false);
  });

  it('uses timestamps when either message position is unavailable', () => {
    expect(shouldPreserveExistingAgentSession({
      lastMessageId: 'assistant-new',
      existingPosition: null,
      recoveringPosition: 4,
      updatedAt: 800,
    }, {
      assistantMessageId: 'assistant-old',
      updatedAt: 400,
    })).toBe(true);
  });

  it('does not treat the recovering turn own session row as newer', () => {
    expect(shouldPreserveExistingAgentSession({
      lastMessageId: 'assistant-same',
      existingPosition: 4,
      recoveringPosition: 4,
      updatedAt: 800,
    }, {
      assistantMessageId: 'assistant-same',
      updatedAt: 400,
    })).toBe(false);
  });

  it('fails closed when different session cursors cannot be ordered', () => {
    expect(shouldPreserveExistingAgentSession({
      lastMessageId: 'assistant-unknown',
    }, {
      assistantMessageId: 'assistant-recovering',
    })).toBe(true);
  });
});
