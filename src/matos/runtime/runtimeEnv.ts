export type MatOSEnv = Record<string, string | undefined>

export function cloneMatOSEnv(env: MatOSEnv = process.env): MatOSEnv {
  return { ...env }
}

export function envValue(env: MatOSEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

export function withTemporaryMatOSEnv<T>(
  env: Record<string, string>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
  try {
    const result = fn()
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}
