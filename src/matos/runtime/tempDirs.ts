import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { MatOSEnv } from './runtimeEnv.js'

export const DEFAULT_MATOS_HOST_TMP_ROOT =
  join(homedir(), '.cache', 'matos', 'tmp')

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function isRootTmpPath(path: string | undefined): boolean {
  if (!path) {
    return false
  }
  const resolved = resolve(path)
  return resolved === '/tmp' || resolved.startsWith('/tmp/')
}

function runningInWorkspaceContainer(cwd: string, env: MatOSEnv): boolean {
  return Boolean(
    env.MATOS_IMAGE_PROFILE ||
      env.MATOS_WORKSPACE_DIR ||
      cwd.startsWith('/workspace/') ||
      env.HOME === '/home/workspace' ||
      env.HOME === '/home/node',
  )
}

function candidatePaths(cwd: string, env: MatOSEnv): string[] {
  const candidates = [
    nonEmpty(env.MATOS_TMP_DIR),
    nonEmpty(env.MATOS_RUNTIME_TMP_DIR),
    nonEmpty(env.MATOS_HOST_TMP_DIR),
  ]

  if (runningInWorkspaceContainer(cwd, env)) {
    candidates.push(
      nonEmpty(env.TMPDIR),
      nonEmpty(env.TMP),
      nonEmpty(env.TEMP),
      env.HOME ? join(env.HOME, '.cache', 'tmp') : undefined,
      '/home/workspace/.cache/tmp',
      '/workspace/caches/tmp',
      '/workspace/tmp',
    )
  } else {
    candidates.push(
      nonEmpty(env.MATOS_TEST_TMPDIR),
      env.MATOS_DEPLOY_ROOT ? join(env.MATOS_DEPLOY_ROOT, 'tmp', 'host') : undefined,
      nonEmpty(env.TMPDIR),
      nonEmpty(env.TMP),
      nonEmpty(env.TEMP),
      join(cwd, '.matos', 'tmp'),
      DEFAULT_MATOS_HOST_TMP_ROOT,
    )
  }

  const seen = new Set<string>()
  return candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(candidate => resolvePath(cwd, candidate))
    .filter(candidate => {
      if (seen.has(candidate)) {
        return false
      }
      seen.add(candidate)
      return true
    })
}

export function resolveMatOSTmpRoot(
  cwd: string = process.cwd(),
  env: MatOSEnv = process.env,
): string {
  return (
    candidatePaths(cwd, env).find(candidate => !isRootTmpPath(candidate)) ??
    join(cwd, '.matos', 'tmp')
  )
}

export async function ensureMatOSTmpRoot(
  cwd: string = process.cwd(),
  env: MatOSEnv = process.env,
): Promise<string> {
  let lastError: unknown
  for (const candidate of candidatePaths(cwd, env)) {
    if (isRootTmpPath(candidate)) {
      continue
    }
    try {
      await mkdir(candidate, { recursive: true })
      return candidate
    } catch (error) {
      lastError = error
    }
  }

  const fallback = join(cwd, '.matos', 'tmp')
  await mkdir(fallback, { recursive: true }).catch(error => {
    throw lastError ?? error
  })
  return fallback
}

export async function mkdtempInMatOSTmp(input: {
  cwd?: string
  env?: MatOSEnv
  prefix: string
}): Promise<string> {
  const root = await ensureMatOSTmpRoot(input.cwd, input.env)
  return mkdtemp(join(root, input.prefix))
}

export function matosTmpDirForPrefix(input: {
  cwd?: string
  env?: MatOSEnv
  prefix: string
}): string {
  return join(resolveMatOSTmpRoot(input.cwd, input.env), input.prefix)
}
