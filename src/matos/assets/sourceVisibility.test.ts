import { describe, expect, test } from 'bun:test'

import {
  isCurrentScopedMatOSAsset,
  isMarketplacePublicMatOSAsset,
  shouldRedactInternalAssetPaths,
  shouldHideAssetFromUserSurface,
} from './sourceVisibility.js'
import type { MatOSAsset } from './types.js'

const HIDE_ENV = { MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1' } as NodeJS.ProcessEnv

function bundledAsset(overrides: Partial<MatOSAsset> = {}): MatOSAsset {
  const base = '/app/matos-assets/packs/matos-core/roles/compute'
  return {
    id: 'compute',
    type: 'role',
    name: 'Compute',
    version: '1.0.0',
    description: undefined,
    canonicalKey: 'role:compute@1.0.0',
    relativePath: 'roles/compute',
    absolutePath: base,
    entryRelativePath: 'ROLE.md',
    entryAbsolutePath: `${base}/ROLE.md`,
    manifestPath: `${base}/asset.json`,
    manifestDir: base,
    source: 'pack',
    sourcePath: base,
    packId: 'matos-core',
    packName: 'matos-core',
    packVersion: '1.0.0',
    tags: [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {},
    ...overrides,
  }
}

describe('MatOS internal asset source visibility', () => {
  test('hides bundled roles without a marketplace marker when the policy is on', () => {
    expect(shouldHideAssetFromUserSurface(bundledAsset(), HIDE_ENV)).toBe(true)
  })

  test('declared marketplace-public bundled roles stay user-visible', () => {
    const asset = bundledAsset({
      metadata: { marketplace: { visibility: 'public', category: 'role' } },
    })
    expect(isMarketplacePublicMatOSAsset(asset)).toBe(true)
    expect(shouldHideAssetFromUserSurface(asset, HIDE_ENV)).toBe(false)
  })

  test('non-public marketplace visibilities do not opt into user surfaces', () => {
    for (const visibility of ['shared', 'project', 'internal', '', undefined]) {
      const asset = bundledAsset({
        metadata: { marketplace: { visibility } },
      })
      expect(isMarketplacePublicMatOSAsset(asset)).toBe(false)
      expect(shouldHideAssetFromUserSurface(asset, HIDE_ENV)).toBe(true)
    }
  })

  test('malformed marketplace metadata never throws and stays hidden', () => {
    for (const metadata of [
      { marketplace: 'public' },
      { marketplace: ['public'] },
      { marketplace: { visibility: ['public'] } },
      {},
    ]) {
      const asset = bundledAsset({ metadata: metadata as Record<string, unknown> })
      expect(isMarketplacePublicMatOSAsset(asset)).toBe(false)
      expect(shouldHideAssetFromUserSurface(asset, HIDE_ENV)).toBe(true)
    }
  })

  test('hidden self-evolution worker role shape stays hidden', () => {
    const base = '/app/matos-assets/packs/matos-core/roles/self-evolution-worker'
    const asset = bundledAsset({
      id: 'self-evolution-worker',
      canonicalKey: 'role:self-evolution-worker@1.0.0',
      absolutePath: base,
      manifestPath: `${base}/asset.json`,
      manifestDir: base,
      sourcePath: base,
      metadata: { sourceFormat: 'cmatos-native-role' },
    })
    expect(shouldHideAssetFromUserSurface(asset, HIDE_ENV)).toBe(true)
  })

  test('tool and mcp assets follow the same internal-source hiding policy', () => {
    expect(
      shouldHideAssetFromUserSurface(bundledAsset({ type: 'tool' }), HIDE_ENV),
    ).toBe(true)
    expect(
      shouldHideAssetFromUserSurface(bundledAsset({ type: 'mcp' }), HIDE_ENV),
    ).toBe(true)
  })

  test('policy off keeps every asset visible', () => {
    expect(
      shouldHideAssetFromUserSurface(bundledAsset(), {} as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  test('assets under user-visible roots stay visible regardless of markers', () => {
    const base = '/workspace/assets/user/roles/my-role'
    const asset = bundledAsset({
      id: 'my-role',
      canonicalKey: 'role:my-role@1.0.0',
      absolutePath: base,
      manifestPath: `${base}/asset.json`,
      manifestDir: base,
      sourcePath: base,
      source: 'project',
      packId: undefined,
    })
    expect(shouldHideAssetFromUserSurface(asset, HIDE_ENV)).toBe(false)
  })

  test('current scoped Gitea assets stay visible to their owner', () => {
    const base =
      '/workspace/group/shared/.matos/source-cache/scopes/users/alice/git/matos-user-assets-alice/skill/vasp'
    const asset = bundledAsset({
      id: 'vasp',
      type: 'skill',
      canonicalKey: 'skill:vasp@1.0.0',
      absolutePath: base,
      manifestPath: `${base}/asset.json`,
      manifestDir: base,
      sourcePath: `${base}/asset.json`,
      source: 'project',
      packId: undefined,
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-user-assets-alice',
          type: 'git',
          scope: 'user',
          scopeRef: 'user:alice',
          provider: 'gitea',
        },
      },
    })
    const env = {
      MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1',
      MATOS_SCOPE_ID: 'user:alice',
    } as NodeJS.ProcessEnv
    expect(isCurrentScopedMatOSAsset(asset, env)).toBe(true)
    expect(shouldHideAssetFromUserSurface(asset, env)).toBe(false)
    expect(shouldRedactInternalAssetPaths(asset, env)).toBe(false)
  })

  test('current scoped Gitea assets honor MATOS_SCOPE_REF when MATOS_SCOPE_ID is absent', () => {
    const base =
      '/workspace/group/shared/.matos/source-cache/scopes/users/alice/git/matos-user-assets-alice/skill/vasp'
    const asset = bundledAsset({
      id: 'vasp',
      type: 'skill',
      canonicalKey: 'skill:vasp@1.0.0',
      absolutePath: base,
      manifestPath: `${base}/asset.json`,
      manifestDir: base,
      sourcePath: `${base}/asset.json`,
      source: 'project',
      packId: undefined,
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-user-assets-alice',
          type: 'git',
          scope: 'user',
          scopeRef: 'user:alice',
          provider: 'gitea',
        },
      },
    })
    const env = {
      MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1',
      MATOS_SCOPE_REF: 'user:alice',
    } as NodeJS.ProcessEnv
    expect(isCurrentScopedMatOSAsset(asset, env)).toBe(true)
    expect(shouldHideAssetFromUserSurface(asset, env)).toBe(false)
    expect(shouldRedactInternalAssetPaths(asset, env)).toBe(false)
  })

  test('another scoped user asset remains hidden', () => {
    const base =
      '/workspace/group/shared/.matos/source-cache/scopes/users/bob/git/matos-user-assets-bob/role/private'
    const asset = bundledAsset({
      id: 'private',
      type: 'role',
      canonicalKey: 'role:private@1.0.0',
      absolutePath: base,
      manifestPath: `${base}/asset.json`,
      manifestDir: base,
      sourcePath: `${base}/asset.json`,
      source: 'project',
      packId: undefined,
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-user-assets-bob',
          type: 'git',
          scope: 'user',
          scopeRef: 'user:bob',
          provider: 'gitea',
        },
      },
    })
    const env = {
      MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1',
      MATOS_SCOPE_ID: 'user:alice',
    } as NodeJS.ProcessEnv
    expect(isCurrentScopedMatOSAsset(asset, env)).toBe(false)
    expect(shouldHideAssetFromUserSurface(asset, env)).toBe(true)
    expect(shouldRedactInternalAssetPaths(asset, env)).toBe(true)
  })
})
