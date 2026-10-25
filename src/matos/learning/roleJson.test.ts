import { describe, expect, test } from 'bun:test'
import { parseRoleJsonResult } from './roleJson.js'

describe('parseRoleJsonResult', () => {
  test('parses plain JSON payloads', () => {
    expect(parseRoleJsonResult('{"ok":true}')).toEqual({ ok: true })
  })

  test('extracts the first balanced JSON object from noisy text', () => {
    const raw = [
      'Here is the result:',
      '{"shouldWrite":true,"summary":"keep this"}',
      'and some trailing {"ignored":true} noise',
    ].join('\n')
    expect(parseRoleJsonResult(raw)).toEqual({
      shouldWrite: true,
      summary: 'keep this',
    })
  })

  test('returns undefined for unbalanced payloads', () => {
    expect(parseRoleJsonResult('{"broken":')).toBeUndefined()
  })
})
