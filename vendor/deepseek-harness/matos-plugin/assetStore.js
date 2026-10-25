import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const MAX_ASSET_BYTES = 256 * 1024
export const MAX_SCAN_FILES = 2000
export const MAX_SCAN_DEPTH = 16
export const MAX_RESULTS = 500
export const MAX_IDENTIFIER_LENGTH = 1024

const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key|cookie)/i

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    result[key] = redactSecrets(child)
  }
  return result
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes('\0'))
}

export function resolveAssetRoot(value, cwd = process.cwd()) {
  const configured = typeof value === 'string' && value.trim() ? value.trim() : '.matos/assets'
  if (configured.includes('\0')) throw new Error('MATOS_ASSET_ROOT contains an invalid NUL byte')
  return resolve(cwd, configured)
}

async function canonicalRoot(root) {
  try {
    const resolved = await realpath(root)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

export function createAssetStore(root, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_ASSET_BYTES
  const maxFiles = Number.isSafeInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : MAX_SCAN_FILES
  const maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : MAX_SCAN_DEPTH
  const maxResults = Number.isSafeInteger(options.maxResults) && options.maxResults > 0 ? options.maxResults : MAX_RESULTS

  async function readAsset(pathValue) {
    if (typeof pathValue !== 'string' || !pathValue.trim() || pathValue.length > MAX_IDENTIFIER_LENGTH || pathValue.includes('\0')) {
      throw new Error('Asset path is invalid')
    }
    const path = resolve(pathValue)
    if (!path.endsWith(`${sep}asset.json`) && path !== 'asset.json') throw new Error('Asset path must point to asset.json')
    const rootPath = await canonicalRoot(root)
    if (!rootPath) throw new Error('MatOS asset root is unavailable')
    let canonicalPath
    try { canonicalPath = await realpath(path) } catch { throw new Error('Asset path does not exist') }
    if (!inside(rootPath, canonicalPath) || !canonicalPath.endsWith(`${sep}asset.json`)) {
      throw new Error('Asset path is outside the current MatOS scope')
    }
    const info = await lstat(canonicalPath)
    if (!info.isFile()) throw new Error('Asset path is not a regular file')
    if (info.size > maxBytes) throw new Error(`Asset manifest exceeds ${maxBytes} bytes`)
    let parsed
    try { parsed = JSON.parse(await readFile(canonicalPath, 'utf8')) } catch (error) {
      throw new Error(`Asset manifest is invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`)
    }
    return redactSecrets(parsed)
  }

  async function listAssets(type) {
    const rootPath = await canonicalRoot(root)
    if (!rootPath) return { assets: [], truncated: false }
    const assets = []
    let scanned = 0
    let truncated = false
    async function walk(dir, depth) {
      if (depth > maxDepth || scanned >= maxFiles || assets.length >= maxResults) {
        truncated = true
        return
      }
      let children
      try { children = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const child of children) {
        if (scanned >= maxFiles || assets.length >= maxResults) { truncated = true; return }
        scanned += 1
        const candidate = resolve(dir, child.name)
        if (child.isDirectory()) {
          await walk(candidate, depth + 1)
        } else if (child.isFile() && child.name === 'asset.json') {
          try {
            const item = await readAsset(candidate)
            if (!type || (item && item.type === type)) assets.push(item)
          } catch {
            // Ignore malformed, oversized, or escaped manifests during discovery.
          }
        }
      }
    }
    await walk(rootPath, 0)
    return { assets, truncated }
  }

  return { root, readAsset, listAssets }
}
