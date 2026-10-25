import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import type { MatOSEnv } from './runtimeEnv.js'

export const DEFAULT_MATOS_DEPLOY_ROOT =
  join(homedir(), '.local', 'share', 'matos')


export type MatOSDeploymentRoots = {
  deployRoot: string
  gatewayDataDir: string
  gatewayConfig: string
  gatewayAccountStore: string
  runtimeDataDir: string
  sharedAssetRoot: string
  globalAssetRoot: string
  governanceRoot: string
  backupRoot: string
  opsRoot: string
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function pathFromEnv(env: MatOSEnv, key: string, fallback: string): string {
  return resolve(nonEmpty(env[key]) ?? fallback)
}

export function resolveMatOSDeploymentRoots(
  env: MatOSEnv = process.env,
): MatOSDeploymentRoots {
  const deployRoot = pathFromEnv(
    env,
    'MATOS_DEPLOY_ROOT',
    DEFAULT_MATOS_DEPLOY_ROOT,
  )
  const gatewayDataDir = pathFromEnv(
    env,
    'MATOS_GATEWAY_DATA_DIR',
    `${deployRoot}/gateway`,
  )
  return {
    deployRoot,
    gatewayDataDir,
    gatewayConfig: pathFromEnv(
      env,
      'MATOS_GATEWAY_CONFIG',
      `${gatewayDataDir}/gateway.json`,
    ),
    gatewayAccountStore: pathFromEnv(
      env,
      'MATOS_GATEWAY_ACCOUNT_STORE',
      `${gatewayDataDir}/users.sqlite`,
    ),
    runtimeDataDir: pathFromEnv(
      env,
      'MATOS_RUNTIME_DATA_DIR',
      `${deployRoot}/runtime`,
    ),
    sharedAssetRoot: pathFromEnv(
      env,
      'MATOS_SHARED_ASSET_ROOT',
      `${deployRoot}/assets/shared`,
    ),
    globalAssetRoot: pathFromEnv(
      env,
      'MATOS_GLOBAL_ASSET_ROOT',
      `${deployRoot}/assets/global`,
    ),
    governanceRoot: pathFromEnv(
      env,
      'MATOS_GOVERNANCE_ROOT',
      `${deployRoot}/governance`,
    ),
    backupRoot: pathFromEnv(
      env,
      'MATOS_BACKUP_ROOT',
      `${deployRoot}/backups`,
    ),
    opsRoot: pathFromEnv(
      env,
      'MATOS_OPS_ROOT',
      `${deployRoot}/ops`,
    ),
  }
}

export function redactedMatOSDeploymentRoots(
  roots: MatOSDeploymentRoots,
): MatOSDeploymentRoots {
  return { ...roots }
}
