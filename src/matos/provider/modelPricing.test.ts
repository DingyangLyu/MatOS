import { expect, test } from 'bun:test'
import { deepSeekModelCosts } from './modelPricing.js'
test('DeepSeek uses its published peak/off-peak rates, not Claude fallback prices', () => {
  const price = (at: string, model = 'deepseek-flash') =>
    deepSeekModelCosts(model, new Date(at))
  expect(price('2026-09-14T00:59:59Z')?.inputTokens).toBe(0.15)
  expect(price('2026-09-14T01:00:00Z')?.inputTokens).toBe(0.3)
  expect(price('2026-09-14T04:00:00Z')?.inputTokens).toBe(0.15)
  expect(price('2026-09-14T06:00:00Z')?.outputTokens).toBe(1.2)
  expect(price('2026-09-14T10:00:00Z')?.promptCacheReadTokens).toBe(0.003)
  expect(price('2026-09-12T02:00:00Z')?.inputTokens).toBe(0.15)
  expect(
    price('2026-09-14T02:00:00Z', 'deepseek-v4-flash[1m]')?.inputTokens,
  ).toBe(0.3)
  expect(price('2026-09-14T12:00:00Z', 'deepseek-v4-pro')?.inputTokens).toBe(
    0.66,
  )
  expect(price('2026-09-14T12:00:00Z', 'custom-model')).toBeUndefined()
  expect(price('2026-09-01T12:00:00Z')).toBeUndefined()
})
