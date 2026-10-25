import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAssetStore } from './assetStore.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'matos-assets-'))
  await mkdir(join(dir, 'role'))
  await writeFile(join(dir, 'role', 'asset.json'), JSON.stringify({ type: 'role', id: 'safe', apiKey: 'do-not-return', nested: { token: 'hidden', ok: true } }))
  return dir
}

test('reads real manifests, redacts secret fields, and rejects escaping symlinks', async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const outside = await mkdtemp(join(tmpdir(), 'matos-outside-')); t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'asset.json'), JSON.stringify({ type: 'role', secret: 'outside' }))
  await mkdir(join(root, 'escape'))
  await symlink(join(outside, 'asset.json'), join(root, 'escape', 'asset.json'))
  const store = createAssetStore(root)
  const item = await store.readAsset(join(root, 'role', 'asset.json'))
  assert.equal(item.id, 'safe')
  assert.equal(Object.hasOwn(item, 'apiKey'), false)
  assert.deepEqual(item.nested, { ok: true })
  await assert.rejects(store.readAsset(join(root, 'escape', 'asset.json')), /outside|asset\.json/)
  const listed = await store.listAssets()
  assert.equal(listed.assets.length, 1)
  assert.equal(listed.assets[0].id, 'safe')
})

test('bounds manifest size and discovery scan', async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'large'))
  await writeFile(join(root, 'large', 'asset.json'), JSON.stringify({ type: 'role', padding: 'x'.repeat(200) }))
  const limited = createAssetStore(root, { maxBytes: 64, maxFiles: 2 })
  await assert.rejects(limited.readAsset(join(root, 'large', 'asset.json')), /exceeds/)
  const result = await limited.listAssets()
  assert.equal(result.truncated, true)
  assert.ok(result.assets.length <= 1)
})
