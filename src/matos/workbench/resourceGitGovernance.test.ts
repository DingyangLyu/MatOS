import { describe, expect, test } from 'bun:test'
import type { MatOSAsset } from '../assets/types.js'
import { packMatOSWorkbenchResource } from './resources.js'

function assetWithGiteaSource(): MatOSAsset {
  return {
    id: 'gitea-role',
    type: 'role',
    name: 'Gitea Role',
    version: '1.0.0',
    description: 'Role loaded from a scoped Gitea asset source',
    canonicalKey: 'role:gitea-role@1.0.0',
    relativePath: 'role/gitea-role',
    absolutePath: '/workspace/assets/user/role/gitea-role',
    entryRelativePath: 'ROLE.md',
    entryAbsolutePath: '/workspace/assets/user/role/gitea-role/ROLE.md',
    manifestPath: '/workspace/assets/user/role/gitea-role/asset.json',
    manifestDir: '/workspace/assets/user/role/gitea-role',
    source: 'project',
    sourcePath: '/workspace/assets/user',
    packId: 'user-assets',
    packName: 'User Assets',
    packVersion: '1.0.0',
    tags: ['git'],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {
      sourceProvenance: {
        sourceId: 'alice-assets',
        type: 'git',
        scope: 'user',
        scopeRef: 'user:alice@example.com',
        refresh: 'manual',
        provider: 'gitea',
        repo: 'https://matos.top/git/matos-users/alice-example-com-assets.git',
        ref: 'main',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/alice-assets/stable',
          commit: 'b'.repeat(40),
        },
        currentCommit: 'a'.repeat(40),
        gitea: {
          owner: 'matos-users',
          repo: 'alice-example-com-assets',
          visibility: 'private',
          webUrl: 'https://matos.top/git/matos-users/alice-example-com-assets',
          cloneUrl: 'https://matos.top/git/matos-users/alice-example-com-assets.git',
        },
      },
    },
  }
}

describe('MatOS workbench Git governance projection', () => {
  test('packs Gitea source governance and source actions into resource payloads', () => {
    const resource = packMatOSWorkbenchResource(assetWithGiteaSource(), {
      cwd: '/workspace',
    })

    expect(resource.gitGovernance).toMatchObject({
      sourceId: 'alice-assets',
      provider: 'gitea',
      scope: 'user',
      scopeRef: 'user:alice@example.com',
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: 'b'.repeat(40),
      },
      repository: {
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        webUrl: 'https://matos.top/git/matos-users/alice-example-com-assets',
      },
    })
    expect(resource.gitGovernance?.actions.map(action => action.key)).toEqual([
      'open-gitea',
      'open-history',
      'open-pulls',
      'validate-source',
      'refresh-source',
      'commit-source',
      'accept-source',
      'rollback-source',
    ])
    expect(
      resource.gitGovernance?.actions.find(action => action.key === 'open-history')?.url,
    ).toBe(
      'https://matos.top/git/matos-users/alice-example-com-assets/src/branch/accepted%2Falice-assets%2Fstable',
    )
    expect(
      resource.gitGovernance?.actions.find(action => action.key === 'open-pulls')?.url,
    ).toBe('https://matos.top/git/matos-users/alice-example-com-assets/pulls')
    expect(
      resource.actions.find(action => action.key === 'validate-source')?.command?.argv,
    ).toEqual(['assets', 'sources', 'status', 'alice-assets', '--json'])
    expect(
      resource.actions.find(action => action.key === 'refresh-source')?.command?.argv,
    ).toEqual(['assets', 'sources', 'refresh', 'alice-assets', '--json'])
    expect(
      resource.actions.find(action => action.key === 'commit-source')?.command?.argv,
    ).toEqual([
      'assets',
      'git',
      'commit-source',
      'alice-assets',
      '--message',
      'MatOS asset source update',
      '--push',
      '--json',
    ])
    expect(
      resource.actions.find(action => action.key === 'accept-source')?.command?.argv,
    ).toEqual([
      'assets',
      'git',
      'accept',
      'alice-assets',
      '--channel',
      'stable',
      '--push',
      '--json',
    ])
    expect(
      resource.actions.find(action => action.key === 'rollback-source')?.command?.argv,
    ).toEqual(['assets', 'git', 'rollback-pr', 'alice-assets', '--json'])
    for (const key of ['commit-source', 'accept-source', 'rollback-source']) {
      const action = resource.actions.find(candidate => candidate.key === key)
      expect(action?.contract.effects).toEqual(['write', 'asset-history'])
      expect(action?.contract.permission).toMatchObject({
        maturity: 'controlled-mutation',
        requiresConfirmation: true,
        danger: false,
      })
    }
  })
})
