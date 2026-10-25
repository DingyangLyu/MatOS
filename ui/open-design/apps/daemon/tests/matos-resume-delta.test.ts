import { describe, expect, it } from 'vitest';
import { buildMatOSResumeDelta } from '../src/server.js';

describe('MatOS role resume delta', () => {
  it('includes only shared messages after the role cursor and removes the current request duplicate', () => {
    const delta = buildMatOSResumeDelta([
      { id: 'u1', role: 'user', content: 'initial request' },
      { id: 'c1', role: 'assistant', roleRef: 'role:compute', content: 'compute result' },
      { id: 'u2', role: 'user', content: 'ask academic' },
      { id: 'a1', role: 'assistant', roleRef: 'role:academic', content: 'academic result' },
      { id: 'u3', role: 'user', content: 'continue compute' },
      { id: 'pending', role: 'assistant', roleRef: 'role:compute', content: '' },
    ], {
      afterMessageId: 'c1',
      currentAssistantMessageId: 'pending',
      currentPrompt: 'continue compute',
    });
    expect(delta).toContain('ask academic');
    expect(delta).toContain('assistant (role:academic)');
    expect(delta).toContain('academic result');
    expect(delta).not.toContain('initial request');
    expect(delta).not.toContain('compute result');
    expect(delta).not.toContain('continue compute');
    expect(delta).not.toContain('Shared project updates');
    expect(delta).not.toContain('private working memory');
  });

  it('caps the rendered delta even when one message is larger than the budget', () => {
    const delta = buildMatOSResumeDelta([
      { id: 'cursor', role: 'assistant', roleRef: 'role:compute', content: 'done' },
      { id: 'large', role: 'assistant', roleRef: 'role:academic', content: 'x'.repeat(20_000) },
    ], {
      afterMessageId: 'cursor',
      maxChars: 4_000,
    });
    expect(delta.length).toBeLessThan(4_250);
    expect(delta).toContain('assistant (role:academic)');
  });
});
