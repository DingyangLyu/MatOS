import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, test } from 'bun:test'
import { configureMatOSEnvironment } from './env.js'
import { loadMatOSAssetsFromRoot } from './assets/loadAssets.js'
import { backendToolRef } from './workflows/nodeLifecycle.js'
import { MATOS_WORKFLOW_NODE_MANIFESTS } from './workflows/nodeManifests.js'
import { listWorkflowNodeTemplates } from './workflows/nodeTemplates.js'
import type { MatOSWorkflowNode } from './workflows/types.js'

test('public asset catalog has no platform-specific cloud adapters or dangling mounts', async () => {
  const assets = await loadMatOSAssetsFromRoot(resolve(import.meta.dir, '../../distribution/benchmark-minimal/assets'))
  const cloud = /(?:volc-vemlp|wuwen)/i
  expect(assets.filter(a => cloud.test(a.id)).map(a => a.canonicalKey)).toEqual([])
  const role = assets.find(a => a.type === 'role' && a.id === 'compute')!
  expect(JSON.stringify({ dependencies: role.dependencies, mounts: role.mounts })).not.toMatch(cloud)
}, 60000)

test('environment setup does not autoload a vendor queue profile', () => {
  const env: Record<string, string | undefined> = { MATOS_BUNDLED_ASSET_ROOT: resolve(import.meta.dir, '../../distribution/benchmark-minimal/assets') }
  configureMatOSEnvironment(env)
  expect(env.MATOS_COMPUTE_PROFILE_JSON).toBeUndefined()
  expect(env.MATOS_VOLC_CLI_PATH).toBeUndefined()
  expect(env.MATOS_VOLC_CREDENTIALS_AVAILABLE).toBeUndefined()
})


test('backend dispatch requires explicit adapter references without vendor guessing', () => {
  expect(backendToolRef({ id: 'job', type: 'backend', dependsOn: [], backend: 'volc-vemlp', operation: 'submit' } as MatOSWorkflowNode)).toBeUndefined()
  expect(backendToolRef({ id: 'job', type: 'backend', dependsOn: [], backend: 'local', tool: 'tool:conda-environment-catalog' } as MatOSWorkflowNode)).toBe('tool:conda-environment-catalog')
  expect(JSON.stringify(MATOS_WORKFLOW_NODE_MANIFESTS)).not.toMatch(/volc-vemlp|wuwen/)
  expect(JSON.stringify(listWorkflowNodeTemplates())).not.toMatch(/volc-vemlp|wuwen/)
})


test('repository configuration loads the bundled scientific catalog', async () => {
  const { loadMatOSAssets } = await import('./assets/loadAssets.js')
  const assets = await loadMatOSAssets(resolve(import.meta.dir, '../..'))
  expect(assets.some(a => a.type === 'role' && a.id === 'compute')).toBe(true)
  expect(assets.some(a => a.type === 'role' && a.id === 'research-scientist')).toBe(true)
  expect(assets.filter(a => a.type === 'workflow').length).toBeGreaterThan(0)
})

test('strict release loading rejects malformed manifests instead of silently omitting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-invalid-asset-'))
  await writeFile(join(root, 'asset.json'), '{not valid json')
  await expect(loadMatOSAssetsFromRoot(root, { strict: true })).rejects.toThrow()
  await expect(loadMatOSAssetsFromRoot(join(root, 'missing'), { strict: true })).rejects.toThrow()
})

