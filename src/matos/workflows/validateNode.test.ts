import { describe, expect, test } from 'bun:test'
import { validationResultFromGuardOutput } from './nodeAdapters/validateNode.js'

describe('MatOS workflow validate node contract', () => {
  test('wraps guard output as a structured validation result', () => {
    const result = validationResultFromGuardOutput({
      ok: false,
      checks: [
        { type: 'file_exists', ok: true },
        { type: 'numeric_range', ok: false },
      ],
    })

    expect(result).toEqual({
      ok: false,
      severity: 'error',
      recommendation: 'fail',
      checks: [
        {
          id: 'file_exists_1',
          type: 'file_exists',
          ok: true,
        },
        {
          id: 'numeric_range_2',
          type: 'numeric_range',
          ok: false,
        },
      ],
    })
  })
})
