import { relative, resolve, sep } from 'node:path'

const SECRET_KEY_PATTERN =
  /(token|secret|password|api[-_]?key|auth|authorization|credential)/i
// `root` covers container-internal `/root/...` harness paths (the workspace
// user home is `/home/workspace`, so `/root` is host/internal only and must not
// leak into user-visible asset prose). Shared system roots like `/usr`, `/etc`,
// and `/var` are intentionally left alone because they are container-visible and
// legitimately referenced in knowledge runbooks.
const HOST_PATH_PATTERN =
  /\/(?:workspace\/(?!(?:knowledge|assets)\/)[^"'`\s)}]*|vepfs[^"'`\s)}]*|tos[^"'`\s)}]*|tmp[^"'`\s)}]*|home[^"'`\s)}]*|opt\/(?!matos-tools\/)[^"'`\s)}]*|run[^"'`\s)}]*|root[^"'`\s)}]*)/g

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

function workspaceRelativePath(value: string, cwd?: string): string | undefined {
  if (!cwd || !value.startsWith('/')) {
    return undefined
  }
  if (!isWithin(value, cwd)) {
    return undefined
  }
  const rel = relative(resolve(cwd), resolve(value))
  return rel ? `<workspace>/${rel.split(sep).join('/')}` : '<workspace>'
}

function redactString(value: string, cwd?: string): string {
  const relativeValue = workspaceRelativePath(value, cwd)
  const workspaceRedacted = cwd ? value.replaceAll(cwd, '<workspace>') : value
  const pathRedacted =
    relativeValue ?? workspaceRedacted
  const hostPathRedacted = pathRedacted.replace(
    HOST_PATH_PATTERN,
    '<redacted-path>',
  )
  return hostPathRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
    // Only a standalone sk- key; identifiers such as knowledge:...-task-pitfalls contain "sk-" too.
    .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(
      /(token|secret|password|credential|api[-_]?key)["']?\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
      '$1=<redacted>',
    )
}

export function redactMatOSAssetOutput(
  value: unknown,
  options: { cwd?: string; exposeHostPaths?: boolean } = {},
): unknown {
  return redactValue(value, options, new WeakSet<object>())
}

function redactValue(
  value: unknown,
  options: { cwd?: string; exposeHostPaths?: boolean },
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return options.exposeHostPaths ? redactString(value) : redactString(value, options.cwd)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '<circular>'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const redactedArray = value.map(item => redactValue(item, options, seen))
    seen.delete(value)
    return redactedArray
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key)
      ? '<redacted>'
      : redactValue(item, options, seen)
  }
  seen.delete(value)
  return redacted
}
