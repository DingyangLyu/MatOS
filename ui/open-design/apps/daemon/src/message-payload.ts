const CHAT_TOOL_RESULT_MAX_BYTES = 64 * 1024;
const CHAT_PRODUCED_FILES_MAX_ITEMS = 100;

type EventRecord = Record<string, unknown>;

function isEventRecord(value: unknown): value is EventRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  let end = Math.max(0, Math.min(maxBytes, buffer.byteLength));
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function boundedToolResult(content: string): string {
  const originalBytes = Buffer.byteLength(content, 'utf8');
  if (originalBytes <= CHAT_TOOL_RESULT_MAX_BYTES) return content;

  let suffix = `\n\n[MatOS chat view omitted ${originalBytes - CHAT_TOOL_RESULT_MAX_BYTES} bytes from this tool result. Full output remains in persisted run evidence.]`;
  let prefixBudget = Math.max(0, CHAT_TOOL_RESULT_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'));
  let prefix = truncateUtf8Prefix(content, prefixBudget);
  const omittedBytes = originalBytes - Buffer.byteLength(prefix, 'utf8');
  suffix = `\n\n[MatOS chat view omitted ${omittedBytes} bytes from this tool result. Full output remains in persisted run evidence.]`;
  prefixBudget = Math.max(0, CHAT_TOOL_RESULT_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'));
  prefix = truncateUtf8Prefix(content, prefixBudget);
  return `${prefix}${suffix}`;
}

/**
 * Builds the browser projection of persisted run events. Full events remain in
 * events_json; this projection removes stream-chunk object overhead and bounds
 * individual tool output so one historical command cannot stall chat replay.
 */
export function compactEventsForChat(events: unknown): unknown[] | undefined {
  if (!Array.isArray(events)) return undefined;
  const coalesced = coalesceAdjacentStreamEvents(events) ?? [];
  const compacted: unknown[] = [];
  for (const event of coalesced) {
    if (!isEventRecord(event)) {
      compacted.push(event);
      continue;
    }
    if (event.kind === 'tool_result' && typeof event.content === 'string') {
      compacted.push({ ...event, content: boundedToolResult(event.content) });
      continue;
    }
    compacted.push(event);
  }
  return compacted;
}

/** Losslessly removes stream chunk object overhead without bounding content. */
export function coalesceAdjacentStreamEvents(events: unknown): unknown[] | undefined {
  if (!Array.isArray(events)) return undefined;
  const coalesced: unknown[] = [];
  for (const event of events) {
    if (
      isEventRecord(event) &&
      (event.kind === 'text' || event.kind === 'thinking') &&
      typeof event.text === 'string'
    ) {
      const previous = coalesced[coalesced.length - 1];
      if (
        isEventRecord(previous) &&
        previous.kind === event.kind &&
        typeof previous.text === 'string'
      ) {
        previous.text += event.text;
      } else {
        coalesced.push({ ...event });
      }
      continue;
    }
    coalesced.push(event);
  }
  return coalesced;
}

export interface ChatResponseProjectionOptions {
  preserveRecoveryBaseline?: boolean;
}

export function messageForChatResponse<T extends Record<string, unknown>>(
  message: T,
  options: ChatResponseProjectionOptions = {},
): T & { producedFilesTotal?: number } {
  const events = compactEventsForChat(message.events);
  const producedFiles = Array.isArray(message.producedFiles)
    ? message.producedFiles
    : undefined;
  const producedFilesTruncated = Boolean(
    producedFiles && producedFiles.length > CHAT_PRODUCED_FILES_MAX_ITEMS,
  );
  return {
    ...message,
    ...(events ? { events } : {}),
    ...(producedFilesTruncated
      ? {
          producedFiles: producedFiles!.slice(0, CHAT_PRODUCED_FILES_MAX_ITEMS),
          producedFilesTotal: producedFiles!.length,
        }
      : {}),
    traceObjectFiles: undefined,
    preTurnFileNames: options.preserveRecoveryBaseline
      ? message.preTurnFileNames
      : undefined,
    preTurnFileSnapshot: options.preserveRecoveryBaseline
      ? message.preTurnFileSnapshot
      : undefined,
  };
}

export const messagePayloadLimits = {
  chatProducedFilesMaxItems: CHAT_PRODUCED_FILES_MAX_ITEMS,
  chatToolResultMaxBytes: CHAT_TOOL_RESULT_MAX_BYTES,
} as const;
