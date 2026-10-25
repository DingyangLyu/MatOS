import { afterEach, expect, test } from 'bun:test'
import { writeJson } from './assetsCliShared'

const previous = process.env.MATOS_ASSET_BRIDGE_PATHS
afterEach(() => {
  if (previous === undefined) delete process.env.MATOS_ASSET_BRIDGE_PATHS
  else process.env.MATOS_ASSET_BRIDGE_PATHS = previous
})

const asset = {
  id: 'external-workflow', type: 'workflow',
  absolutePath: '/vepfs/shared/assets/external-workflow',
  sourcePath: '/vepfs/shared/assets/external-workflow/asset.json',
  metadata: { absolutePath: '/root/private', apiKey: 'secret-value' },
}
function output(value: unknown) {
  let text = ''
  writeJson({ cwd: '/workspace/project', stdout: value => { text += value }, stderr: () => {} }, value)
  return JSON.parse(text)
}

test('ordinary asset JSON keeps external paths and secrets redacted', () => {
  delete process.env.MATOS_ASSET_BRIDGE_PATHS
  expect(output({ asset }).asset.absolutePath).toBe('<redacted-path>')
  expect(output({ assets: [asset] }).assets[0].metadata.apiKey).toBe('<redacted>')
})

test('the scoped bridge receives only top-level asset file paths, for list and show', () => {
  process.env.MATOS_ASSET_BRIDGE_PATHS = '1'
  for (const result of [output({ asset }).asset, output({ assets: [asset] }).assets[0]]) {
    expect(result.absolutePath).toBe(asset.absolutePath)
    expect(result.sourcePath).toBe(asset.sourcePath)
    expect(result.metadata.absolutePath).toBe('<redacted-path>')
    expect(result.metadata.apiKey).toBe('<redacted>')
  }
  expect(output({ other: { absolutePath: '/root/private' } }).other.absolutePath).toBe('<redacted-path>')
})
