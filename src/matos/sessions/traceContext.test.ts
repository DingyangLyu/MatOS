import { describe, expect, test } from 'bun:test'
import {
  redactTraceValue,
  scrubSecretsFromString,
} from './traceContext.js'

describe('MatOS trace secret redaction', () => {
  test('preserves only finite nonnegative numeric usage counters, never token secrets', () => {
    expect(redactTraceValue({
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 100 },
      modelUsage: { model: { inputTokens: 12, cacheReadInputTokens: 100 } },
      input_tokens: 'secret-disguised-as-counter',
      access_token: 123456,
      totalTokens: -1,
      outputTokens: Infinity,
    })).toEqual({
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 100 },
      modelUsage: { model: { inputTokens: 12, cacheReadInputTokens: 100 } },
      input_tokens: '[redacted]', access_token: '[redacted]',
      totalTokens: '[redacted]', outputTokens: '[redacted]',
    })
  })

  test('scrubs secret assignments and URL query values inside ordinary strings', () => {
    const source = [
      'provider failed password=hunter2',
      'clientSecret: "client-value"',
      'https://example.invalid/callback?access_token=query-secret&mode=safe',
    ].join(' | ')
    const scrubbed = scrubSecretsFromString(source)

    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('client-value')
    expect(scrubbed).not.toContain('query-secret')
    expect(scrubbed).toContain('password=[redacted]')
    expect(scrubbed).toContain('access_token=[redacted]&mode=safe')
  })

  test('redacts both secret-bearing keys and embedded secret text recursively', () => {
    const redacted = redactTraceValue({
      apiKey: 'top-level-secret',
      nested: {
        message: 'request rejected: token=embedded-secret',
      },
    }) as Record<string, unknown>

    expect(redacted.apiKey).toBe('[redacted]')
    expect(redacted.nested).toEqual({
      message: 'request rejected: token=[redacted]',
    })
  })
})
