import { describe, expect, test } from 'bun:test'
import {
  canAccessMatOSGiteaAssetRepo,
  matOSGiteaAssetRepoForScope,
  matOSGiteaAssetRepoPathInfo,
} from './giteaGovernance.js'

describe('MatOS Gitea asset governance', () => {
  test('maps native MatOS scopes to deterministic Gitea asset repositories', () => {
    expect(
      matOSGiteaAssetRepoForScope({
        scope: 'user',
        scopeRef: 'user:alice@example.com',
      }),
    ).toMatchObject({
      owner: 'matos-users',
      repo: 'alice-example-com-assets',
      visibility: 'private',
      scopeKind: 'user',
      scopeId: 'alice-example-com',
    })
    expect(
      matOSGiteaAssetRepoForScope({ scope: 'team', scopeRef: 'team:lab-a' }),
    ).toMatchObject({
      owner: 'matos-teams',
      repo: 'lab-a-assets',
      visibility: 'private',
      scopeKind: 'team',
      scopeId: 'lab-a',
    })
    expect(matOSGiteaAssetRepoForScope({ scope: 'shared' })).toMatchObject({
      owner: 'matos-shared',
      repo: 'assets',
      visibility: 'internal',
      scopeKind: 'shared',
    })
    expect(matOSGiteaAssetRepoForScope({ scope: 'core' })).toMatchObject({
      owner: 'matos-core',
      repo: 'assets',
      visibility: 'internal',
      scopeKind: 'core',
    })
  })

  test('enforces private user repo isolation while allowing admin inspection', () => {
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        action: 'write',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        owner: 'matos-users',
        repo: 'bob-example-com-assets',
        action: 'read',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        isAdmin: true,
        owner: 'matos-users',
        repo: 'bob-example-com-assets',
        action: 'admin',
      }),
    ).toBe(true)
  })

  test('allows team and project asset repos through typed authorized scopes', () => {
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopes: [{ role: 'reviewer', scopeRef: 'team:lab-a' }],
        owner: 'matos-teams',
        repo: 'lab-a-assets',
        action: 'read',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopes: [{ role: 'curator', scopeRef: 'project:battery' }],
        owner: 'matos-projects',
        repo: 'battery-assets',
        action: 'write',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopes: [{ role: 'reviewer', scopeRef: 'project:battery' }],
        owner: 'matos-projects',
        repo: 'battery-assets',
        action: 'write',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopes: [{ role: 'curator', scopeRef: 'user:bob@example.com' }],
        owner: 'matos-users',
        repo: 'bob-example-com-assets',
        action: 'read',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopeRefs: ['user:bob@example.com'],
        owner: 'matos-users',
        repo: 'bob-example-com-assets',
        action: 'read',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopeRefs: ['project:battery'],
        owner: 'matos-projects',
        repo: 'battery-assets',
        action: 'read',
      }),
    ).toBe(false)
  })

  test('allows normal users to read shared and core assets but not write them', () => {
    for (const [owner, repo] of [
      ['matos-shared', 'assets'],
      ['matos-global', 'assets'],
      ['matos-core', 'assets'],
    ]) {
      expect(
        canAccessMatOSGiteaAssetRepo({
          accountScopeRef: 'user:alice',
          owner,
          repo,
          action: 'read',
        }),
      ).toBe(true)
      expect(
        canAccessMatOSGiteaAssetRepo({
          accountScopeRef: 'user:alice',
          owner,
          repo,
          action: 'write',
        }),
      ).toBe(false)
    }
  })

  test('routes authenticated contributors read-only to the non-runtime community inbox', () => {
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice',
        owner: 'matos-community',
        repo: 'contributions',
        action: 'read',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice',
        owner: 'matos-community',
        repo: 'contributions',
        action: 'write',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice',
        owner: 'matos-community',
        repo: 'anything-else',
        action: 'write',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice',
        owner: 'matos-community',
        repo: 'contributions',
        action: 'admin',
      }),
    ).toBe(false)
  })

  test('does not govern unrelated Gitea owners', () => {
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:admin',
        isAdmin: true,
        owner: 'unrelated-owner',
        repo: 'private-repo',
        action: 'admin',
      }),
    ).toBe(false)
  })

  test('extracts MatOS asset repo owner and name from Gitea route paths', () => {
    expect(
      matOSGiteaAssetRepoPathInfo('/matos-users/alice-assets'),
    ).toMatchObject({
      owner: 'matos-users',
      repo: 'alice-assets',
      isMatOSAssetRepo: true,
    })
    expect(
      matOSGiteaAssetRepoPathInfo(
        '/matos-users/alice-assets.git/info/refs?service=git-upload-pack',
      ),
    ).toMatchObject({
      owner: 'matos-users',
      repo: 'alice-assets',
      isMatOSAssetRepo: true,
    })
    expect(
      matOSGiteaAssetRepoPathInfo(
        '/matos-community/contributions.git/info/refs?service=git-receive-pack',
      ),
    ).toEqual({
      owner: 'matos-community',
      repo: 'contributions',
      isMatOSAssetRepo: true,
    })
    expect(matOSGiteaAssetRepoPathInfo('/explore/repos')).toBeUndefined()
  })
})
