import { chmod, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { readMatOSProjectConfig } from '../project.js'
import type { MatOSEnv } from './runtimeEnv.js'
import {
  resolveMatOSRuntimeScope,
  type MatOSRuntimeScope,
} from './scopes.js'

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/** Runtime scope that owns the DSH home for this cwd; trace-only ambient scopes fall back to user:local. */
export async function resolveMatOSAgentEngineScope(input: {
  cwd: string
  scopeRef?: string
  env?: MatOSEnv
}): Promise<MatOSRuntimeScope> {
  const env = input.env ?? process.env
  const config = await readMatOSProjectConfig(input.cwd)
  const ambientScopeRef = env.MATOS_SCOPE_REF ?? env.MATOS_SCOPE_ID
  const runtimeAmbientScopeRef =
    ambientScopeRef &&
    (!ambientScopeRef.includes(':') || ambientScopeRef.startsWith('user:'))
      ? ambientScopeRef
      : undefined
  return resolveMatOSRuntimeScope(input.cwd, {
    scopeRef:
      input.scopeRef ??
      runtimeAmbientScopeRef ??
      'user:local',
    runtimeDataDir: config.execution?.runtimeDataDir,
    env,
  })
}

export function matOSDshHome(
  scope: MatOSRuntimeScope,
  env: MatOSEnv = process.env,
): string {
  const configured = env.MATOS_DSH_HOME?.trim()
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('MATOS_DSH_HOME must be an absolute path')
    }
    return configured
  }
  return join(scope.homeDir, 'dsh')
}

export async function ensureMatOSDshHome(
  scope: MatOSRuntimeScope,
  env: MatOSEnv = process.env,
): Promise<string> {
  const path = matOSDshHome(scope, env)
  await ensurePrivateDirectory(scope.homeDir)
  await ensurePrivateDirectory(path)
  return path
}
