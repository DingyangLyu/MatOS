import { expect, test } from 'bun:test'
import { matOSGiteaEquivalentSourceRepos, resolveMatOSGitAssetSourceRuntimeRepo } from './giteaRuntimeTransport.js'

const source = {
  type: 'git' as const, id: 'user-assets', provider: 'gitea' as const,
  repo: 'http://matos-gitea:3000/matos-users/alice-assets.git',
}

test('accepted source identity recognizes only configured Gitea origin aliases', () => {
  expect(matOSGiteaEquivalentSourceRepos(source, {})).toEqual([
    source.repo, 'http://127.0.0.1:3001/matos-users/alice-assets.git',
  ])
  for (const repo of [
    'http://127.0.0.1:9000/matos-users/alice-assets.git',
    'http://untrusted.invalid/matos-users/alice-assets.git',
    '/tmp/local-repo',
  ]) expect(matOSGiteaEquivalentSourceRepos({ ...source, repo }, {})).toEqual([repo])
  expect(matOSGiteaEquivalentSourceRepos({ ...source, provider: undefined }, {})).toEqual([source.repo])
})

test('Gitea aliases retain the exact repository path and never manufacture path-prefix aliases', () => {
  const repo = `${source.repo}?revision=A`
  expect(matOSGiteaEquivalentSourceRepos({ ...source, repo }, {})).toContain(
    'http://127.0.0.1:3001/matos-users/alice-assets.git?revision=A',
  )
  expect(matOSGiteaEquivalentSourceRepos(source, {
    MATOS_GITEA_SOURCE_BASE_URL: 'https://host.invalid/gitea',
  })).toEqual([source.repo])
  expect(matOSGiteaEquivalentSourceRepos(source, {
    MATOS_GITEA_SOURCE_BASE_URL: 'https://host.invalid',
  })).toContain('https://host.invalid/matos-users/alice-assets.git')
})


test('local Git remotes resolve against the workspace before cache fetch and push', () => {
  const local = { type: 'git' as const, id: 'local-project', repo: './.matos/local-git/project.git' }
  expect(resolveMatOSGitAssetSourceRuntimeRepo({ cwd: '/workspace/moved', source: local, repo: local.repo, env: {} }))
    .toBe('/workspace/moved/.matos/local-git/project.git')
  for (const repo of ['https://example.test/assets.git', 'git@example.test:assets.git']) {
    expect(resolveMatOSGitAssetSourceRuntimeRepo({ cwd: '/workspace/moved', source: local, repo, env: {} })).toBe(repo)
  }
})
