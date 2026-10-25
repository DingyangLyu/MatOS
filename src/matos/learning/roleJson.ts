function extractBalancedJsonObject(raw: string): string | undefined {
  const start = raw.indexOf('{')
  if (start < 0) {
    return undefined
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]!
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(start, index + 1)
      }
    }
  }
  return undefined
}

export function parseRoleJsonResult(raw: string | undefined): unknown {
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    const candidate = extractBalancedJsonObject(raw)
    if (!candidate) {
      return undefined
    }
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }
}
