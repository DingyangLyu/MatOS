import { describe, expect, it } from 'vitest';

import {
  compactEventsForChat,
  messageForChatResponse,
  messagePayloadLimits,
} from '../src/message-payload.js';

describe('chat message payload compaction', () => {
  it('coalesces adjacent stream chunks without crossing event boundaries', () => {
    expect(compactEventsForChat([
      { kind: 'thinking', text: 'one' },
      { kind: 'thinking', text: ' two' },
      { kind: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      { kind: 'text', text: 'done' },
      { kind: 'text', text: ' now' },
    ])).toEqual([
      { kind: 'thinking', text: 'one two' },
      { kind: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      { kind: 'text', text: 'done now' },
    ]);
  });

  it('bounds large tool results on a valid UTF-8 boundary with a visible marker', () => {
    const compacted = compactEventsForChat([{
      kind: 'tool_result',
      toolUseId: 'tool-1',
      content: '材料'.repeat(40_000),
      isError: false,
    }]) as Array<{ content: string }>;

    expect(Buffer.byteLength(compacted[0]!.content, 'utf8'))
      .toBeLessThanOrEqual(messagePayloadLimits.chatToolResultMaxBytes);
    expect(compacted[0]!.content).toContain('Full output remains in persisted run evidence.');
    expect(compacted[0]!.content).not.toContain('\ufffd');
  });

  it('bounds historical file evidence while preserving the full count', () => {
    const producedFiles = Array.from(
      { length: messagePayloadLimits.chatProducedFilesMaxItems + 25 },
      (_, index) => ({ name: `file-${index}.txt` }),
    );
    const projected = messageForChatResponse({
      id: 'assistant-large-files',
      producedFiles,
      traceObjectFiles: producedFiles,
      preTurnFileNames: producedFiles.map((file) => file.name),
      preTurnFileSnapshot: producedFiles.map((file) => ({ name: file.name })),
    });

    expect(projected.producedFiles)
      .toHaveLength(messagePayloadLimits.chatProducedFilesMaxItems);
    expect(projected.producedFilesTotal).toBe(producedFiles.length);
    expect(projected.traceObjectFiles).toBeUndefined();
    expect(projected.preTurnFileNames).toBeUndefined();
    expect(projected.preTurnFileSnapshot).toBeUndefined();
  });

  it('keeps recovery baselines only when the caller marks a run active', () => {
    const projected = messageForChatResponse({
      id: 'assistant-running',
      preTurnFileNames: ['before.txt'],
      preTurnFileSnapshot: [{ name: 'before.txt' }],
    }, { preserveRecoveryBaseline: true });

    expect(projected.preTurnFileNames).toEqual(['before.txt']);
    expect(projected.preTurnFileSnapshot).toEqual([{ name: 'before.txt' }]);
  });
});
