/** Published USD estimates, NOT a provider invoice or currency conversion.
 * Verified 2026-09-14: https://api-docs.deepseek.com/quick_start/pricing/
 * Flash pricing effective 2026-09-10 04:00 UTC. The current price page keeps
 * Pro pricing separate (superseding the original retirement announcement).
 * Unknown/older models must retain the runtime's unknown-price indicator.
 */
export function deepSeekModelCosts(model: string, at = new Date()) {
  if (at.getTime() < Date.parse('2026-09-10T04:00:00Z')) return undefined
  const name = model.toLowerCase().replace(/\[1m\]$/, '')
  const flash = [
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
  ].includes(name)
  const pro = name === 'deepseek-v4-pro'
  if (!flash && !pro) return undefined
  const hour = at.getUTCHours(),
    weekday = at.getUTCDay()
  const peak =
    weekday >= 1 &&
    weekday <= 5 &&
    ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  const factor = peak ? 2 : 1
  return {
    inputTokens: (flash ? 0.15 : 0.66) * factor,
    outputTokens: (flash ? 0.6 : 1.98) * factor,
    promptCacheReadTokens: (flash ? 0.003 : 0.022) * factor,
    // DeepSeek exposes cache misses as input; no separate Anthropic write surcharge.
    promptCacheWriteTokens: (flash ? 0.15 : 0.66) * factor,
    webSearchRequests: 0,
  }
}
