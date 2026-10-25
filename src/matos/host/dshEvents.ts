import { randomUUID } from 'node:crypto'
import type { MatOSDeepSeekHarnessNotification } from '../runtime/deepseekHarnessEngine.js'

type RecordValue = Record<string, unknown>

export function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

/** DeepSeek has no medium tier: map it explicitly to high. */
export function mapEffortToDeepSeek(effort: unknown): 'off' | 'low' | 'high' | 'max' | undefined {
  if (effort === undefined || effort === null || effort === '') return undefined
  if (effort === 'medium') return 'high'
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') return effort
  throw new Error('DeepSeek Harness does not support reasoning effort: ' + String(effort))
}

/** Convert one stream-json/Anthropic-style user content value into DSH content blocks. */
export function userContentToDshBlocks(content: unknown): RecordValue[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap<RecordValue>(value => {
    const block = record(value)
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') {
      const source = record(block.source)
      if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        return [{ type: 'image', data: source.data, mimeType: source.media_type }]
      }
    }
    if (block.type === 'tool_result') return []
    throw new Error('DeepSeek Harness cannot submit content block: ' + String(block.type ?? 'unknown'))
  })
}

export type DshProjection =
  | { type: 'stream_event'; event: RecordValue }
  | { type: 'stream_start'; id: string; automaticFollowup?: boolean }
  | { type: 'assistant'; id?: string; model?: string; content: RecordValue[]; usage?: RecordValue; automaticFollowup?: boolean }
  | { type: 'tool_result'; callId: string; content: RecordValue[]; isError: boolean }

function parseArguments(value: unknown): RecordValue {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { return { _raw: value } }
}

function projectContent(content: unknown): RecordValue[] {
  if (!Array.isArray(content)) return []
  return content.flatMap<RecordValue>(value => {
    const block = record(value)
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block.type === 'reasoning' && typeof block.text === 'string') return [{ type: 'thinking', thinking: block.text, signature: '' }]
    if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
      return [{ type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) }]
    }
    return []
  })
}

/** Pure DSH notification to Anthropic-style event conversion. */
export function createDshEventProjector(): (notification: MatOSDeepSeekHarnessNotification) => DshProjection[] {
  const seenToolCalls = new Set<string>()
  const startedBlocks = new Set<number>()
  let usage: RecordValue = {}
  let streamMessageId: string | undefined
  let sawTurn = false
  let automaticFollowup = false
  const stream = (event: RecordValue): DshProjection => ({ type: 'stream_event', event })
  return notification => {
    const liveFrame = notification.method === 'session.stream' ? record(notification.params.frame) : undefined
    if (notification.method !== 'session.event' && liveFrame?.type !== 'chunk') return []
    const event = record(notification.params.event)
    const data = record(event.data)
    if (event.type === 'turn/start') {
      automaticFollowup = sawTurn
      sawTurn = true
      return []
    }
    if (event.type === 'step/start') {
      startedBlocks.clear()
      usage = {}
      streamMessageId = randomUUID()
      return [{ type: 'stream_start', id: streamMessageId, ...(automaticFollowup ? { automaticFollowup: true } : {}) }]
    }
    if (liveFrame?.type === 'chunk' || event.type === 'assistant/chunk') {
      const chunk = record(liveFrame?.chunk ?? data.chunk)
      const index = typeof chunk.index === 'number' ? chunk.index : 0
      if (chunk.type === 'block-start') {
        if (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') return []
        startedBlocks.add(index)
        return [stream({ type: 'content_block_start', index, content_block: chunk.blockType === 'text'
          ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } })]
      }
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && typeof chunk.text === 'string') {
        return [stream({ type: 'content_block_delta', index, delta: chunk.type === 'text-delta'
          ? { type: 'text_delta', text: chunk.text } : { type: 'thinking_delta', thinking: chunk.text } })]
      }
      if (chunk.type === 'tool-call-delta') {
        const result: DshProjection[] = []
        if (!startedBlocks.has(index) && typeof chunk.name === 'string' && typeof chunk.id === 'string') {
          startedBlocks.add(index)
          result.push(stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: chunk.id, name: chunk.name, input: {} } }))
        }
        if (startedBlocks.has(index) && typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta) {
          result.push(stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta } }))
        }
        return result
      }
      if (chunk.type === 'block-end' && startedBlocks.has(index)) return [stream({ type: 'content_block_stop', index })]
      if (chunk.type === 'usage') { usage = record(chunk.usage); return [] }
      if (chunk.type === 'finish') {
        const reason = record(chunk.reason).kind
        return [
          stream({ type: 'message_delta', delta: { stop_reason: reason === 'tool-calls' ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: Number(usage.outputTokens ?? 0) } }),
          stream({ type: 'message_stop' }),
        ]
      }
      return []
    }
    if (event.type === 'assistant/message') {
      const message = record(data.message)
      const content = projectContent(message.content).filter(block => {
        if (block.type !== 'tool_use') return true
        if (seenToolCalls.has(String(block.id))) return false
        seenToolCalls.add(String(block.id))
        return true
      })
      if (!content.length) return []
      // Streamed deltas and the assembled message share one identity so
      // consumers can deduplicate completed text against streamed text.
      const id = streamMessageId ?? (typeof message.id === 'string' ? message.id : undefined)
      streamMessageId = undefined
      return [{ type: 'assistant', id, ...(automaticFollowup ? { automaticFollowup: true } : {}),
        model: typeof record(message.source).model === 'string' ? String(record(message.source).model) : undefined,
        content, usage: data.usage ? record(data.usage) : undefined }]
    }
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      if (seenToolCalls.has(data.callId)) return []
      seenToolCalls.add(data.callId)
      return [{ type: 'assistant', content: [{ type: 'tool_use', id: data.callId, name: data.name, input: parseArguments(data.arguments) }] }]
    }
    if (event.type === 'tool/result') {
      const message = record(data.message)
      const content = message.content
      if (!Array.isArray(content)) return []
      if (typeof message.toolCallId === 'string') {
        return [{ type: 'tool_result', callId: message.toolCallId,
          content: projectContent(content).filter(item => item.type === 'text'),
          isError: Boolean(message.isError || data.error) }]
      }
      return content.flatMap(value => {
        const block = record(value)
        if (block.type !== 'tool-result' || typeof block.toolCallId !== 'string') return []
        return [{ type: 'tool_result' as const, callId: block.toolCallId, content: projectContent(block.content).filter(item => item.type === 'text'), isError: Boolean(block.isError || data.error) }]
      })
    }
    return []
  }
}

/** Token usage in the Anthropic shape stream-json consumers read. */
export function dshUsageToAnthropic(usage: RecordValue | undefined): RecordValue {
  const value = usage ?? {}
  const cacheRead = Number(value.cacheReadTokens ?? 0)
  const cacheWrite = Number(value.cacheWriteTokens ?? 0)
  return {
    input_tokens: Math.max(0, Number(value.inputTokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: Number(value.outputTokens ?? 0),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }
}
