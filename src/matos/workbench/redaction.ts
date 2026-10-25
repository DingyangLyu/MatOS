const SECRET_FIELD_PATTERN =
  /api[_-]?key|token|password|passwd|secret|authorization|credential|access[_-]?key|refresh[_-]?token/i

const SECRET_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [
    /\b(api[_-]?key|token|password|passwd|secret|authorization|credential|access[_-]?key|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^"',}\]\s\r\n]+/gi,
    '$1$2[REDACTED]',
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]'],
]

export function redactMatOSWorkbenchString(value: string): {
  value: string
  redacted: boolean
} {
  let output = value
  let redacted = false
  for (const [pattern, replacement] of SECRET_TEXT_REPLACEMENTS) {
    pattern.lastIndex = 0
    if (pattern.test(output)) {
      redacted = true
    }
    pattern.lastIndex = 0
    output = output.replace(pattern, replacement)
  }
  return { value: output, redacted }
}

export function redactMatOSWorkbenchValue(value: unknown): {
  value: unknown
  redacted: boolean
} {
  return redactValue(value, new WeakSet<object>())
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    return redactMatOSWorkbenchString(value)
  }
  if (Array.isArray(value)) {
    let redacted = false
    const next = value.map(item => {
      const result = redactValue(item, seen)
      redacted ||= result.redacted
      return result.value
    })
    return { value: next, redacted }
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return { value: '[circular]', redacted: true }
    }
    seen.add(value)
    let redacted = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_PATTERN.test(key)) {
        next[key] = '[REDACTED]'
        redacted = true
        continue
      }
      const result = redactValue(item, seen)
      redacted ||= result.redacted
      next[key] = result.value
    }
    return { value: next, redacted }
  }
  return { value, redacted: false }
}
