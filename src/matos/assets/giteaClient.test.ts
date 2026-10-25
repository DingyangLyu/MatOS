/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createServer } from 'node:http'
import { describe, expect, test } from 'bun:test'
import {
  bootstrapMatOSGiteaAssetRepos,
  createMatOSGiteaBranch,
  createMatOSGiteaCommitStatus,
  createMatOSGiteaPullRequest,
  createMatOSGiteaUserAccessToken,
  deleteMatOSGiteaFile,
  ensureMatOSGiteaContributionFork,
  ensureMatOSGiteaContributionInboxPolicy,
  ensureMatOSGiteaUser,
  mergeMatOSGiteaPullRequest,
  provisionMatOSGiteaAssetScope,
  readMatOSGiteaRepositoryAccess,
  readMatOSGiteaPullRequest,
  syncMatOSGiteaContributionFork,
  validateMatOSGiteaAccessToken,
  writeMatOSGiteaTextFile,
} from './giteaClient.js'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('missing port'))
        return
      }
      resolve(address.port)
    })
  })
}

describe('MatOS Gitea client', () => {
  test('ensures user accounts and creates personal access tokens', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      body: string
    }> = []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: String(req.headers.authorization ?? ''),
          body,
        })
        if (req.method === 'GET') {
          if (req.url === '/api/v1/user') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ login: 'matos-owner' }))
            return
          }
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/admin/users') {
          const parsed = JSON.parse(body) as {
            username: string
            email: string
            password: string
            must_change_password: boolean
          }
          expect(parsed).toMatchObject({
            username: 'alice-example-com',
            email: 'alice@example.com',
            must_change_password: false,
          })
          expect(parsed.password.length).toBeGreaterThan(12)
          existing.add(`/api/v1/users/${parsed.username}`)
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (
          req.method === 'PATCH' &&
          req.url === '/api/v1/admin/users/alice-example-com'
        ) {
          expect(JSON.parse(body)).toMatchObject({
            login_name: 'alice-example-com',
            source_id: 0,
            admin: false,
            allow_create_organization: false,
            allow_git_hook: false,
            allow_import_local: false,
            max_repo_creation: 0,
          })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/users/alice-example-com/tokens'
        ) {
          expect(JSON.parse(body)).toEqual({
            name: 'matos-user-alice-example-com',
            scopes: ['write:repository', 'read:user'],
          })
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ sha1: 'alice-user-token' }))
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const user = await ensureMatOSGiteaUser({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'operator-token',
        username: 'alice-example-com',
        email: 'alice@example.com',
        password: 'long-random-password',
      })
      const token = await createMatOSGiteaUserAccessToken({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        password: 'long-random-password',
        username: 'alice-example-com',
        name: 'matos-user-alice-example-com',
      })

      expect(user).toMatchObject({
        ok: true,
        username: 'alice-example-com',
        email: 'alice@example.com',
        action: 'created',
      })
      expect(token).toMatchObject({
        ok: true,
        username: 'alice-example-com',
        name: 'matos-user-alice-example-com',
        token: 'alice-user-token',
      })
      expect(JSON.stringify(user)).not.toContain('operator-token')
      expect(JSON.stringify(token)).not.toContain('operator-token')
      expect(requests[0]?.authorization).toBe('token operator-token')
      expect(requests[1]?.authorization).toBe('token operator-token')
      expect(requests[2]?.authorization).toBe('token operator-token')
      expect(requests[3]?.authorization).toBe(
        `Basic ${Buffer.from('alice-example-com:long-random-password', 'utf8').toString('base64')}`,
      )
      expect(requests.every(request => !request.authorization?.includes('long-random-password'))).toBe(
        true,
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('rejects privileged personal token scopes before contacting Gitea', async () => {
    await expect(
      createMatOSGiteaUserAccessToken({
        apiUrl: 'http://127.0.0.1:1/api/v1',
        username: 'alice-example-com',
        name: 'workspace-token',
        password: 'password',
        scopes: ['write:user'],
      }),
    ).rejects.toThrow(/unsupported scope/)
  })

  test('validates personal access tokens without leaking them', async () => {
    const requests: Array<{ url: string; authorization?: string }> = []
    const server = createServer((req, res) => {
      requests.push({
        url: req.url ?? '/',
        authorization: String(req.headers.authorization ?? ''),
      })
      if (req.url === '/api/v1/user' && req.headers.authorization === 'token good-token') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ login: 'alice-example-com' }))
        return
      }
      res.statusCode = 401
      res.end('bad token')
    })
    const port = await listen(server)

    try {
      const valid = await validateMatOSGiteaAccessToken({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'good-token',
      })
      expect(valid).toEqual({
        ok: true,
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        username: 'alice-example-com',
        status: 200,
      })
      const invalid = await validateMatOSGiteaAccessToken({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'bad-token',
      })
      expect(invalid).toEqual({
        ok: false,
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        status: 401,
      })
      expect(JSON.stringify(valid)).not.toContain('good-token')
      expect(JSON.stringify(invalid)).not.toContain('bad-token')
      expect(requests.map(request => request.authorization)).toEqual([
        'token good-token',
        'token bad-token',
      ])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('writes commit status for accepted asset validation', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      body: string
    }> = []
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: String(req.headers.authorization ?? ''),
          body,
        })
        if (
          req.method === 'POST' &&
          req.url === `/api/v1/repos/matos-core/assets/statuses/${sha}`
        ) {
          expect(JSON.parse(body)).toEqual({
            state: 'success',
            target_url: `https://matos.example/git/matos-core/assets/src/commit/${sha}`,
            description: 'MatOS asset validation passed',
            context: 'matos/validate',
          })
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const result = await createMatOSGiteaCommitStatus({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'status-token',
        owner: 'matos-core',
        repo: 'assets',
        commit: sha,
        state: 'success',
        description: 'MatOS asset validation passed',
        context: 'matos/validate',
        targetUrl: `https://matos.example/git/matos-core/assets/src/commit/${sha}`,
      })

      expect(result).toEqual({
        ok: true,
        owner: 'matos-core',
        repo: 'assets',
        commit: sha,
        state: 'success',
        status: 201,
      })
      expect(requests[0]?.authorization).toBe('token status-token')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('bootstraps expected asset organizations and repos without leaking token', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      body: string
    }> = []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: String(req.headers.authorization ?? ''),
          body,
        })
        if (req.method === 'GET') {
          if (req.url === '/api/v1/user') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ login: 'matos-owner' }))
            return
          }
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs') {
          const parsed = JSON.parse(body) as { username: string }
          existing.add(`/api/v1/orgs/${parsed.username}`)
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (req.method === 'POST' && req.url?.startsWith('/api/v1/orgs/')) {
          const parsed = JSON.parse(body) as { name: string }
          const owner = req.url.split('/')[4]
          existing.add(`/api/v1/repos/${owner}/${parsed.name}`)
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-community/contributions/branch_protections'
        ) {
          const parsed = JSON.parse(body) as Record<string, unknown>
          existing.add(
            '/api/v1/repos/matos-community/contributions/branch_protections/main',
          )
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(parsed))
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const result = await bootstrapMatOSGiteaAssetRepos({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'secret-token-for-test',
      })

      expect(result.ok).toBe(true)
      expect(result.contributionInboxPolicy).toMatchObject({
        ok: true,
        action: 'created',
        ownerUsernames: ['matos-owner'],
      })
      expect(result.repositories.map(repo => `${repo.owner}/${repo.repo}`)).toEqual(
        [
          'matos-core/assets',
          'matos-shared/assets',
          'matos-global/assets',
          'matos-community/contributions',
          'matos-evolution/proposals',
        ],
      )
      expect(JSON.stringify(result)).not.toContain('secret-token-for-test')
      expect(requests.every(request => request.authorization === 'token secret-token-for-test')).toBe(
        true,
      )
      expect(
        requests.some(
          request =>
            request.method === 'POST' &&
            request.url === '/api/v1/orgs/matos-core/repos' &&
            JSON.parse(request.body).name === 'assets',
        ),
      ).toBe(true)
      const policy = requests.find(
        request =>
          request.method === 'POST' &&
          request.url === '/api/v1/repos/matos-community/contributions/branch_protections',
      )
      expect(policy).toBeDefined()
      expect(JSON.parse(policy!.body)).toMatchObject({
        branch_name: 'main',
        enable_push: true,
        enable_push_whitelist: true,
        enable_merge_whitelist: true,
        enable_approvals_whitelist: true,
        required_approvals: 1,
        push_whitelist_usernames: ['matos-owner'],
        merge_whitelist_usernames: ['matos-owner'],
        approvals_whitelist_username: ['matos-owner'],
        dismiss_stale_approvals: true,
        block_on_rejected_reviews: true,
        block_on_official_review_requests: true,
        block_on_outdated_branch: true,
        block_admin_merge_override: true,
        enable_status_check: true,
        status_check_contexts: ['matos/owner-verify'],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('repairs an incomplete community inbox protection policy fail-closed', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = []
    let policy: Record<string, unknown> = {
      branch_name: 'main',
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ['matos-owner'],
      enable_merge_whitelist: true,
      merge_whitelist_usernames: ['community-user'],
      enable_approvals_whitelist: true,
      approvals_whitelist_username: ['matos-owner'],
      required_approvals: 1,
    }
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-community/contributions/branch_protections/main'
        ) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(policy))
          return
        }
        if (
          req.method === 'PATCH' &&
          req.url === '/api/v1/repos/matos-community/contributions/branch_protections/main'
        ) {
          policy = { branch_name: 'main', ...JSON.parse(body) }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(policy))
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const result = await ensureMatOSGiteaContributionInboxPolicy({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'operator-token',
        ownerUsernames: ['matos-owner'],
      })
      expect(result.ok).toBe(true)
      expect(result.action).toBe('repaired')
      expect(result.ownerUsernames).toEqual(['matos-owner'])
      const repair = requests.find(request => request.method === 'PATCH')
      expect(repair).toBeDefined()
      expect(JSON.parse(repair!.body)).toMatchObject({
        merge_whitelist_usernames: ['matos-owner'],
        approvals_whitelist_username: ['matos-owner'],
        block_admin_merge_override: true,
        enable_status_check: true,
      })

      const rotated = await ensureMatOSGiteaContributionInboxPolicy({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'operator-token',
        ownerUsernames: ['replacement-owner'],
      })
      expect(rotated).toMatchObject({
        ok: true,
        action: 'repaired',
        ownerUsernames: ['replacement-owner'],
      })
      expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('keeps the community inbox read-only and submits through a per-user fork', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = []
    let forkExists = false
    const forkBody = () => JSON.stringify({
      name: 'matos-contributions',
      full_name: 'alice/matos-contributions',
      fork: true,
      private: true,
      clone_url: 'https://gitea.test/alice/matos-contributions.git',
      html_url: 'https://gitea.test/alice/matos-contributions',
      parent: { full_name: 'matos-community/contributions' },
      permissions: { admin: true, pull: true, push: true },
    })
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-community/contributions'
        ) {
          res.end(JSON.stringify({
            name: 'contributions',
            full_name: 'matos-community/contributions',
            permissions: { admin: false, pull: true, push: false },
          }))
          return
        }
        if (req.method === 'GET' && req.url === '/api/v1/repos/alice/matos-contributions') {
          if (!forkExists) {
            res.statusCode = 404
            res.end('{}')
          } else {
            res.end(forkBody())
          }
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-community/contributions/forks'
        ) {
          forkExists = true
          res.statusCode = 202
          res.end(forkBody())
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/alice/matos-contributions/merge-upstream'
        ) {
          res.end(JSON.stringify({ message: 'success' }))
          return
        }
        res.statusCode = 500
        res.end('{}')
      })
    })
    const port = await listen(server)
    const apiUrl = `http://127.0.0.1:${port}/api/v1`

    try {
      const access = await readMatOSGiteaRepositoryAccess({
        apiUrl,
        token: 'alice-token',
        owner: 'matos-community',
        repo: 'contributions',
      })
      expect(access.permissions).toEqual({ admin: false, pull: true, push: false })
      const fork = await ensureMatOSGiteaContributionFork({
        apiUrl,
        token: 'alice-token',
        username: 'alice',
      })
      expect(fork).toMatchObject({
        ok: true,
        owner: 'alice',
        repo: 'matos-contributions',
        action: 'created',
      })
      await syncMatOSGiteaContributionFork({
        apiUrl,
        token: 'alice-token',
        owner: fork.owner,
        repo: fork.repo,
      })
      expect(requests.some(request => request.url.endsWith('/forks'))).toBe(true)
      expect(requests.some(request => request.url.endsWith('/merge-upstream'))).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('dry-run reports bootstrap plan without making HTTP requests', async () => {
    const result = await bootstrapMatOSGiteaAssetRepos({
      apiUrl: 'http://127.0.0.1:1/api/v1',
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.organizations.every(org => org.action === 'planned')).toBe(true)
    expect(result.repositories.every(repo => repo.action === 'planned')).toBe(true)
  })

  test('provisions a scoped asset repo and repository collaborators', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      body: string
    }> = []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: String(req.headers.authorization ?? ''),
          body,
        })
        if (req.method === 'GET') {
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs') {
          const parsed = JSON.parse(body) as { username: string }
          existing.add(`/api/v1/orgs/${parsed.username}`)
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs/matos-users/repos') {
          const parsed = JSON.parse(body) as { name: string; private: boolean }
          expect(parsed).toMatchObject({
            name: 'alice-assets',
            private: true,
            auto_init: true,
            default_branch: 'main',
          })
          existing.add(`/api/v1/repos/matos-users/${parsed.name}`)
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (
          req.method === 'PUT' &&
          req.url === '/api/v1/repos/matos-users/alice-assets/collaborators/alice'
        ) {
          expect(JSON.parse(body)).toEqual({ permission: 'write' })
          res.statusCode = 204
          res.end('')
          return
        }
        if (
          req.method === 'PUT' &&
          req.url === '/api/v1/repos/matos-users/alice-assets/collaborators/admin'
        ) {
          expect(JSON.parse(body)).toEqual({ permission: 'admin' })
          res.statusCode = 204
          res.end('')
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const result = await provisionMatOSGiteaAssetScope({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'secret-scope-token',
        owner: 'matos-users',
        repo: 'alice-assets',
        scopeLabel: 'user:alice',
        members: ['alice'],
        admins: ['admin'],
      })

      expect(result.ok).toBe(true)
      expect(result.repository).toMatchObject({
        owner: 'matos-users',
        repo: 'alice-assets',
        action: 'created',
      })
      expect(result.members).toEqual([
        { username: 'alice', permission: 'write', action: 'added' },
        { username: 'admin', permission: 'admin', action: 'added' },
      ])
      expect(JSON.stringify(result)).not.toContain('secret-scope-token')
      expect(requests.every(request => request.authorization === 'token secret-scope-token')).toBe(
        true,
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('treats existing repository collaborators as provisioned', async () => {
    const server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          res.end('{}')
          return
        }
        if (
          req.method === 'PUT' &&
          req.url === '/api/v1/repos/matos-users/alice-assets/collaborators/admin'
        ) {
          res.statusCode = 422
          res.end('already exists')
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)

    try {
      const result = await provisionMatOSGiteaAssetScope({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'secret-scope-token',
        owner: 'matos-users',
        repo: 'alice-assets',
        scopeLabel: 'user:alice',
        admins: ['admin'],
      })

      expect(result.ok).toBe(true)
      expect(result.repository.action).toBe('exists')
      expect(result.members).toEqual([
        { username: 'admin', permission: 'admin', action: 'existing' },
      ])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('creates branch, pull request, reads status, and merges without exposing token', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      body: string
    }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: String(req.headers.authorization ?? ''),
          body,
        })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-core/assets/branches/evolution%2Frun-1'
        ) {
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/branches'
        ) {
          expect(JSON.parse(body)).toEqual({
            new_branch_name: 'evolution/run-1',
            old_branch_name: 'main',
          })
          res.statusCode = 201
          res.end(JSON.stringify({ name: 'evolution/run-1' }))
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            head: 'evolution/run-1',
            base: 'main',
            title: 'evolve core assets',
          })
          res.statusCode = 201
          res.end(
            JSON.stringify({
              number: 7,
              title: parsed.title,
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/7',
              head: { ref: parsed.head },
              base: { ref: parsed.base },
            }),
          )
          return
        }
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls/7'
        ) {
          res.end(
            JSON.stringify({
              number: 7,
              title: 'evolve core assets',
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/7',
              head: { ref: 'evolution/run-1' },
              base: { ref: 'main' },
            }),
          )
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls/7/merge'
        ) {
          expect(JSON.parse(body)).toEqual({ Do: 'squash' })
          res.end(JSON.stringify({ merged: true }))
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected' }))
      })
    })
    const port = await listen(server)

    try {
      const apiUrl = `http://127.0.0.1:${port}/api/v1`
      const branch = await createMatOSGiteaBranch({
        apiUrl,
        token: 'secret-pr-token',
        owner: 'matos-core',
        repo: 'assets',
        branch: 'evolution/run-1',
        fromRef: 'main',
      })
      const created = await createMatOSGiteaPullRequest({
        apiUrl,
        token: 'secret-pr-token',
        owner: 'matos-core',
        repo: 'assets',
        sourceBranch: 'evolution/run-1',
        targetBranch: 'main',
        title: 'evolve core assets',
        body: 'validated by MatOS',
      })
      const status = await readMatOSGiteaPullRequest({
        apiUrl,
        token: 'secret-pr-token',
        owner: 'matos-core',
        repo: 'assets',
        number: 7,
      })
      const merged = await mergeMatOSGiteaPullRequest({
        apiUrl,
        token: 'secret-pr-token',
        owner: 'matos-core',
        repo: 'assets',
        number: 7,
        method: 'squash',
      })

      expect(branch).toMatchObject({ ok: true, action: 'created' })
      expect(created).toMatchObject({
        ok: true,
        number: 7,
        sourceBranch: 'evolution/run-1',
        targetBranch: 'main',
      })
      expect(status.state).toBe('open')
      expect(merged).toMatchObject({ ok: true, merged: true, status: 200 })
      expect(JSON.stringify({ branch, created, status, merged })).not.toContain(
        'secret-pr-token',
      )
      expect(requests.every(request => request.authorization === 'token secret-pr-token')).toBe(
        true,
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('writes and deletes text files on a Gitea asset branch', async () => {
    const requests: Array<{
      method: string
      url: string
      body: string
    }> = []
    let fileExists = false
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body,
        })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'GET' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/skills/demo/SKILL.md?ref=evolution%2Frun-1'
        ) {
          if (!fileExists) {
            res.statusCode = 404
            res.end('missing')
            return
          }
          res.end(
            JSON.stringify({
              sha: 'existing-sha',
              html_url:
                'https://matos.top/git/matos-core/assets/src/branch/evolution/run-1/matos-assets/packs/matos-core/skills/demo/SKILL.md',
            }),
          )
          return
        }
        if (
          req.method === 'POST' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/skills/demo/SKILL.md'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            branch: 'evolution/run-1',
            message: 'write demo',
            content: Buffer.from('first').toString('base64'),
          })
          expect(parsed.sha).toBeUndefined()
          fileExists = true
          res.statusCode = 201
          res.end(
            JSON.stringify({
              content: {
                html_url:
                  'https://matos.top/git/matos-core/assets/src/branch/evolution/run-1/matos-assets/packs/matos-core/skills/demo/SKILL.md',
              },
            }),
          )
          return
        }
        if (
          req.method === 'PUT' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/skills/demo/SKILL.md'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            branch: 'evolution/run-1',
            message: 'write demo',
            content: Buffer.from('second').toString('base64'),
            sha: 'existing-sha',
          })
          res.end(JSON.stringify({ content: {} }))
          return
        }
        if (
          req.method === 'DELETE' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/skills/demo/SKILL.md'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toEqual({
            branch: 'evolution/run-1',
            message: 'delete demo',
            sha: 'existing-sha',
          })
          fileExists = false
          res.end(JSON.stringify({}))
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected' }))
      })
    })
    const port = await listen(server)

    try {
      const apiUrl = `http://127.0.0.1:${port}/api/v1`
      const path = 'matos-assets/packs/matos-core/skills/demo/SKILL.md'
      const created = await writeMatOSGiteaTextFile({
        apiUrl,
        token: 'content-token',
        owner: 'matos-core',
        repo: 'assets',
        branch: 'evolution/run-1',
        path,
        content: 'first',
        message: 'write demo',
      })
      const updated = await writeMatOSGiteaTextFile({
        apiUrl,
        token: 'content-token',
        owner: 'matos-core',
        repo: 'assets',
        branch: 'evolution/run-1',
        path,
        content: 'second',
        message: 'write demo',
      })
      const deleted = await deleteMatOSGiteaFile({
        apiUrl,
        token: 'content-token',
        owner: 'matos-core',
        repo: 'assets',
        branch: 'evolution/run-1',
        path,
        message: 'delete demo',
      })

      expect(created.action).toBe('created')
      expect(updated.action).toBe('updated')
      expect(deleted.action).toBe('deleted')
      expect(requests.map(request => request.method)).toEqual([
        'GET',
        'POST',
        'GET',
        'PUT',
        'GET',
        'DELETE',
      ])
      expect(JSON.stringify({ created, updated, deleted })).not.toContain('content-token')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('retries idempotent requests through transient 503 responses', async () => {
    let attempts = 0
    const server = createServer((req, res) => {
      attempts += 1
      if (attempts < 3) {
        res.statusCode = 503
        res.end('gitea restarting')
        return
      }
      if (req.url === '/api/v1/user' && req.headers.authorization === 'token retry-token') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ login: 'alice-example-com' }))
        return
      }
      res.statusCode = 500
      res.end('unexpected')
    })
    const port = await listen(server)
    process.env.MATOS_GITEA_API_RETRY_BASE_MS = '10'
    try {
      const result = await validateMatOSGiteaAccessToken({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'retry-token',
      })
      expect(result.ok).toBe(true)
      expect(result.username).toBe('alice-example-com')
      expect(attempts).toBe(3)
    } finally {
      delete process.env.MATOS_GITEA_API_RETRY_BASE_MS
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('does not retry non-idempotent POST requests on 5xx responses', async () => {
    let attempts = 0
    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        // ensureMatOSGiteaUser existence probe.
        res.statusCode = 404
        res.end('missing')
        return
      }
      attempts += 1
      res.statusCode = 503
      res.end('gitea restarting')
    })
    const port = await listen(server)
    process.env.MATOS_GITEA_API_RETRY_BASE_MS = '10'
    try {
      await expect(
        ensureMatOSGiteaUser({
          apiUrl: `http://127.0.0.1:${port}/api/v1`,
          token: 'operator-token',
          username: 'alice-example-com',
          email: 'alice@example.com',
          password: 'long-random-password',
        }),
      ).rejects.toThrow('Gitea user create failed: 503')
      expect(attempts).toBe(1)
    } finally {
      delete process.env.MATOS_GITEA_API_RETRY_BASE_MS
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('retries connection-refused requests after Gitea comes back', async () => {
    // Reserve a port, shut the listener down, then bring the real server up
    // shortly after the first connection attempt fails.
    const probe = createServer(() => undefined)
    const port = await listen(probe)
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const server = createServer((req, res) => {
      if (req.url === '/api/v1/user') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ login: 'alice-example-com' }))
        return
      }
      res.statusCode = 500
      res.end('unexpected')
    })
    const startLater = new Promise<void>(resolve =>
      setTimeout(() => {
        server.listen(port, '127.0.0.1', () => resolve())
      }, 60),
    )
    process.env.MATOS_GITEA_API_RETRY_BASE_MS = '100'
    try {
      const result = await validateMatOSGiteaAccessToken({
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
        token: 'retry-token',
      })
      expect(result.ok).toBe(true)
      await startLater
    } finally {
      delete process.env.MATOS_GITEA_API_RETRY_BASE_MS
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
