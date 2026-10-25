import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type MatOSBuildInfoSource = 'build-info' | 'git' | 'unknown'

export type MatOSBuildInfo = {
  version: string
  commit: string | null
  commitShort: string | null
  builtAt: string | null
  channel: string | null
  dirty: boolean | null
  source: MatOSBuildInfoSource
}

/**
 * App root that carries build-info.json in channel images (/app) and equals
 * the repository root for host checkouts.
 */
export function resolveMatOSAppRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function fromBuildInfoFile(infoPath: string, version: string): MatOSBuildInfo | null {
  if (!existsSync(infoPath)) {
    return null
  }
  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(readFileSync(infoPath, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null
    }
    parsed = raw as Record<string, unknown>
  } catch {
    return null
  }
  const commit = typeof parsed.commit === 'string' && parsed.commit.length > 0 ? parsed.commit : null
  const commitShort =
    typeof parsed.commitShort === 'string' && parsed.commitShort.length > 0
      ? parsed.commitShort
      : commit
        ? commit.slice(0, 12)
        : null
  return {
    version,
    commit,
    commitShort,
    builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
    channel: typeof parsed.channel === 'string' ? parsed.channel : null,
    dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
    source: 'build-info',
  }
}

function fromGit(root: string, version: string): MatOSBuildInfo | null {
  // A source snapshot may live inside another checkout; never report its parent's revision.
  if (!existsSync(join(root, '.git'))) return null
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.error || result.status !== 0) {
    return null
  }
  const commit = result.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return null
  }
  return {
    version,
    commit,
    commitShort: commit.slice(0, 12),
    builtAt: null,
    channel: null,
    dirty: null,
    source: 'git',
  }
}

/**
 * Resolve the runtime version fingerprint: prefer the build-info.json stamped
 * by the channel image refresh, fall back to the live git HEAD for host
 * checkouts, and degrade to `unknown` instead of failing. Never throws.
 */
export function resolveMatOSBuildInfo(
  options: { root?: string; version?: string } = {},
): MatOSBuildInfo {
  const root = options.root ?? resolveMatOSAppRoot()
  const version = options.version ?? 'unknown'
  return (
    fromBuildInfoFile(join(root, 'build-info.json'), version) ??
    fromGit(root, version) ?? {
      version,
      commit: null,
      commitShort: null,
      builtAt: null,
      channel: null,
      dirty: null,
      source: 'unknown',
    }
  )
}
