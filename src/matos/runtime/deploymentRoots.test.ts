import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MATOS_DEPLOY_ROOT, redactedMatOSDeploymentRoots, resolveMatOSDeploymentRoots } from './deploymentRoots.js'

describe('portable deployment roots', () => {
  test('defaults to the local user data directory', () => {
    const roots = resolveMatOSDeploymentRoots({})
    expect(DEFAULT_MATOS_DEPLOY_ROOT).toBe(join(homedir(), '.local', 'share', 'matos'))
    expect(roots.deployRoot).toBe(DEFAULT_MATOS_DEPLOY_ROOT)
    expect(roots.sharedAssetRoot).toBe(join(roots.deployRoot, 'assets/shared'))
    expect(roots.opsRoot).toBe(join(roots.deployRoot, 'ops'))
  })
  test('honors paths with spaces on any filesystem', () => {
    const roots = resolveMatOSDeploymentRoots({ MATOS_DEPLOY_ROOT: '/srv/Science Work', MATOS_SHARED_ASSET_ROOT: '/data/assets' })
    expect(roots.deployRoot).toBe('/srv/Science Work')
    expect(roots.runtimeDataDir).toBe('/srv/Science Work/runtime')
    expect(roots.sharedAssetRoot).toBe('/data/assets')
  })
  test('does not copy unrelated credentials into diagnostics', () => {
    const roots = resolveMatOSDeploymentRoots({ DEEPSEEK_API_KEY: 'secret-value' })
    expect(JSON.stringify(redactedMatOSDeploymentRoots(roots))).not.toContain('secret-value')
  })
})
