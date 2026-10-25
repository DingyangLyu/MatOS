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

import net from 'node:net'
import tls from 'node:tls'
import { setTimeout as sleep } from 'node:timers/promises'

export type MatOSGiteaBootstrapAction = 'created' | 'exists' | 'planned'

export type MatOSGiteaBootstrapOrganization = {
  owner: string
  action: MatOSGiteaBootstrapAction
}

export type MatOSGiteaBootstrapRepository = {
  owner: string
  repo: string
  private: boolean
  action: MatOSGiteaBootstrapAction
}

export type MatOSGiteaBootstrapResult = {
  ok: boolean
  dryRun: boolean
  apiUrl: string
  organizations: MatOSGiteaBootstrapOrganization[]
  repositories: MatOSGiteaBootstrapRepository[]
  contributionInboxPolicy?: MatOSGiteaContributionInboxPolicyResult
}

export type MatOSGiteaBranchResult = {
  ok: boolean
  owner: string
  repo: string
  branch: string
  fromRef: string
  action: 'created' | 'exists'
}

export type MatOSGiteaPullRequestResult = {
  ok: boolean
  owner: string
  repo: string
  number: number
  sourceBranch?: string
  sourceRepository?: string
  headCommit?: string
  targetBranch?: string
  title?: string
  state?: string
  merged?: boolean
  url?: string
}

export type MatOSGiteaPullRequestMergeResult = {
  ok: boolean
  owner: string
  repo: string
  number: number
  merged: boolean
  status: number
}

export type MatOSGiteaContentWriteResult = {
  ok: boolean
  owner: string
  repo: string
  branch: string
  path: string
  action: 'created' | 'updated' | 'deleted' | 'absent'
  url?: string
}

export type MatOSGiteaCommitStatusState =
  | 'pending'
  | 'success'
  | 'error'
  | 'failure'

export type MatOSGiteaCommitStatusResult = {
  ok: boolean
  owner: string
  repo: string
  commit: string
  state: MatOSGiteaCommitStatusState
  status: number
}

export type MatOSGiteaScopeProvisionMember = {
  username: string
  permission: 'read' | 'write' | 'admin'
  action: 'added' | 'planned' | 'existing'
}

export type MatOSGiteaScopeProvisionResult = {
  ok: boolean
  dryRun: boolean
  apiUrl: string
  repository: MatOSGiteaBootstrapRepository
  organization: MatOSGiteaBootstrapOrganization
  members: MatOSGiteaScopeProvisionMember[]
}

export type MatOSGiteaUserProvisionResult = {
  ok: boolean
  apiUrl: string
  username: string
  email: string
  action: 'created' | 'exists'
}

export type MatOSGiteaUserAccessTokenResult = {
  ok: boolean
  apiUrl: string
  username: string
  name: string
  token: string
}

export type MatOSGiteaTokenValidationResult = {
  ok: boolean
  apiUrl: string
  username?: string
  status: number
}

export type MatOSGiteaContributionInboxPolicyResult = {
  ok: boolean
  owner: string
  repo: string
  branch: string
  action: 'created' | 'exists' | 'repaired'
  ownerUsernames: string[]
}

export type MatOSGiteaRepositoryAccessResult = {
  ok: boolean
  owner: string
  repo: string
  permissions: {
    admin: boolean
    pull: boolean
    push: boolean
  }
}

export type MatOSGiteaContributionForkResult = {
  ok: boolean
  owner: string
  repo: string
  action: 'created' | 'exists'
  cloneUrl?: string
  webUrl?: string
}

type MatOSGiteaBootstrapRepoSpec = {
  owner: string
  repo: string
  private: boolean
  ownerFullName: string
  ownerDescription: string
  repoDescription: string
}

const DEFAULT_ASSET_REPOS: MatOSGiteaBootstrapRepoSpec[] = [
  {
    owner: 'matos-core',
    repo: 'assets',
    private: true,
    ownerFullName: 'MatOS Core Assets',
    ownerDescription: 'Operator-governed MatOS core asset repositories',
    repoDescription: 'Validated core MatOS text assets',
  },
  {
    owner: 'matos-shared',
    repo: 'assets',
    private: true,
    ownerFullName: 'MatOS Shared Assets',
    ownerDescription: 'Shared MatOS assets promoted for users',
    repoDescription: 'Validated shared MatOS text assets',
  },
  {
    owner: 'matos-global',
    repo: 'assets',
    private: true,
    ownerFullName: 'MatOS Global Assets',
    ownerDescription: 'Global MatOS deployment assets',
    repoDescription: 'Validated global MatOS text assets',
  },
  {
    owner: 'matos-community',
    repo: 'contributions',
    private: true,
    ownerFullName: 'MatOS Community',
    ownerDescription: 'Owner-reviewed community contribution intake',
    repoDescription:
      'Protected review inbox for community MatOS assets; not a runtime asset source',
  },
  {
    owner: 'matos-evolution',
    repo: 'proposals',
    private: true,
    ownerFullName: 'MatOS Evolution',
    ownerDescription: 'Private MatOS self-evolution proposal repositories',
    repoDescription: 'Self-evolution branches and proposal metadata',
  },
]

function scopedRepoSpec(input: {
  owner: string
  repo: string
  private: boolean
  scopeLabel: string
}): MatOSGiteaBootstrapRepoSpec {
  const display = `${input.owner}/${input.repo}`
  return {
    owner: input.owner,
    repo: input.repo,
    private: input.private,
    ownerFullName: input.owner,
    ownerDescription: 'MatOS scoped asset repositories',
    repoDescription: `MatOS ${input.scopeLabel} asset repository ${display}`,
  }
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '')
}

function headers(input: {
  token?: string
  authorization?: string
} = {}): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(input.token?.trim()
      ? { authorization: `token ${input.token.trim()}` }
      : input.authorization?.trim()
        ? { authorization: input.authorization.trim() }
        : {}),
  }
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

type GiteaResponse = {
  status: number
  ok: boolean
  body: string
}

function decodeHttpBody(head: string, body: Buffer): string {
  const transferEncoding = head
    .split('\r\n')
    .find(line => line.toLowerCase().startsWith('transfer-encoding:'))
    ?.toLowerCase()
  if (!transferEncoding?.includes('chunked')) {
    return body.toString('utf8')
  }

  const chunks: Buffer[] = []
  let offset = 0
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) {
      throw new Error('Incomplete Gitea HTTP response')
    }
    const rawSize = body.subarray(offset, lineEnd).toString('ascii').split(';')[0]?.trim() ?? ''
    const size = Number.parseInt(rawSize, 16)
    if (!/^[a-f0-9]+$/i.test(rawSize) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Invalid Gitea HTTP chunk size')
    }
    offset = lineEnd + 2
    if (size === 0) {
      return Buffer.concat(chunks).toString('utf8')
    }
    if (offset + size + 2 > body.length || body[offset + size] !== 13 || body[offset + size + 1] !== 10) {
      throw new Error('Incomplete Gitea HTTP response')
    }
    chunks.push(body.subarray(offset, offset + size))
    offset += size + 2
  }
  throw new Error('Incomplete Gitea HTTP response')
}

function parseJsonBody<T>(body: string): T | undefined {
  if (!body.trim()) {
    return undefined
  }
  try {
    return JSON.parse(body) as T
  } catch {
    return undefined
  }
}

function repoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

function contentPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

function pullRequestFromBody(input: {
  owner: string
  repo: string
  body: string
  fallbackNumber?: number
}): MatOSGiteaPullRequestResult {
  const parsed = parseJsonBody<{
    number?: number
    index?: number
    title?: string
    state?: string
    merged?: boolean
    html_url?: string
    url?: string
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } }
    base?: { ref?: string }
  }>(input.body)
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    number: Number(parsed?.number ?? parsed?.index ?? input.fallbackNumber ?? 0),
    sourceBranch: parsed?.head?.ref,
    sourceRepository: parsed?.head?.repo?.full_name,
    headCommit: parsed?.head?.sha,
    targetBranch: parsed?.base?.ref,
    title: parsed?.title,
    state: parsed?.state,
    merged: parsed?.merged,
    url: parsed?.html_url ?? parsed?.url,
  }
}

function giteaRequestRetryCount(): number {
  const parsed = Number(process.env.MATOS_GITEA_API_RETRY_COUNT)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2
}

function giteaRequestRetryBaseMs(): number {
  const parsed = Number(process.env.MATOS_GITEA_API_RETRY_BASE_MS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500
}

const GITEA_IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'PUT', 'PATCH'])

function giteaRequestMethodIsIdempotent(method: string | undefined): boolean {
  return GITEA_IDEMPOTENT_METHODS.has((method ?? 'GET').toUpperCase())
}

function isRetryableGiteaRequestError(
  error: unknown,
  method: string | undefined,
): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  // The connection was never established, so no request reached Gitea and a
  // retry is safe for every method. This covers brief Gitea restarts.
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'EAI_AGAIN'
  ) {
    return true
  }
  // Mid-flight failures may have reached Gitea; retry only idempotent methods.
  const midFlight =
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    error.message.includes('Gitea request timed out')
  return midFlight && giteaRequestMethodIsIdempotent(method)
}

function isRetryableGiteaResponseStatus(status: number): boolean {
  // Status 0 means the socket closed before a valid HTTP status line arrived
  // (for example Gitea restarting mid-response). 502/503/504 are upstream
  // gateway/restart transients.
  return status === 0 || status === 502 || status === 503 || status === 504
}

async function requestOnce(input: {
  apiUrl: string
  path: string
  token?: string
  authorization?: string
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: Record<string, unknown>
}): Promise<GiteaResponse> {
  const url = new URL(`${input.apiUrl}${input.path}`)
  const body = input.body ? JSON.stringify(input.body) : undefined
  return new Promise((resolve, reject) => {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const socket =
      url.protocol === 'https:'
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port })
    const chunks: Buffer[] = []
    let settled = false
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      reject(error)
    }
    const readyEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect'
    socket.once(readyEvent, () => {
      const requestHeaders = {
        host: url.host,
        connection: 'close',
        ...headers({
          token: input.token,
          authorization: input.authorization,
        }),
        ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      }

      const lines = [
        `${input.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1`,
        ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
        '',
        body ?? '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
    socket.once('end', () => {
      if (settled) {
        return
      }
      const raw = Buffer.concat(chunks)
      const boundary = raw.indexOf('\r\n\r\n')
      const head = boundary < 0 ? '' : raw.subarray(0, boundary).toString('ascii')
      const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0)
      let body: string
      try { body = decodeHttpBody(head, boundary < 0 ? Buffer.alloc(0) : raw.subarray(boundary + 4)) }
      catch (error) { fail(error as Error); return }
      settled = true
      resolve({
        status,
        ok: status >= 200 && status < 300,
        body,
      })
    })
    socket.once('error', fail)
    socket.once('close', () => {
      if (!settled) fail(Object.assign(new Error('Gitea connection closed before its response completed'), { code: 'ECONNRESET' }))
    })
    socket.setTimeout(30000, () => fail(new Error(`Gitea request timed out: ${input.path}`)))
  })
}

async function request(input: {
  apiUrl: string
  path: string
  token?: string
  authorization?: string
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: Record<string, unknown>
}): Promise<GiteaResponse> {
  const retries = giteaRequestRetryCount()
  const baseMs = giteaRequestRetryBaseMs()
  const method = input.method ?? 'GET'
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await requestOnce(input)
      if (
        isRetryableGiteaResponseStatus(response.status) &&
        attempt < retries &&
        giteaRequestMethodIsIdempotent(method)
      ) {
        await sleep(baseMs * 2 ** attempt)
        continue
      }
      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (!isRetryableGiteaRequestError(lastError, method) || attempt >= retries) {
        throw lastError
      }
      await sleep(baseMs * 2 ** attempt)
    }
  }
  throw lastError ?? new Error(`Gitea request failed: ${input.path}`)
}

async function exists(input: {
  apiUrl: string
  path: string
  token?: string
}): Promise<boolean> {
  const response = await request(input)
  if (response.status === 404) {
    return false
  }
  if (!response.ok) {
    throw new Error(`Gitea request failed: ${response.status} ${input.path}`)
  }
  return true
}

async function ensureOrganization(input: {
  apiUrl: string
  token?: string
  spec: MatOSGiteaBootstrapRepoSpec
}): Promise<MatOSGiteaBootstrapOrganization> {
  if (
    await exists({
      apiUrl: input.apiUrl,
      path: `/orgs/${encodeURIComponent(input.spec.owner)}`,
      token: input.token,
    })
  ) {
    return { owner: input.spec.owner, action: 'exists' }
  }
  const response = await request({
    apiUrl: input.apiUrl,
    path: '/orgs',
    method: 'POST',
    token: input.token,
    body: {
      username: input.spec.owner,
      full_name: input.spec.ownerFullName,
      description: input.spec.ownerDescription,
    },
  })
  if (!response.ok) {
    throw new Error(`Gitea org create failed: ${response.status} ${input.spec.owner}`)
  }
  return { owner: input.spec.owner, action: 'created' }
}

async function ensureRepository(input: {
  apiUrl: string
  token?: string
  spec: MatOSGiteaBootstrapRepoSpec
}): Promise<MatOSGiteaBootstrapRepository> {
  if (
    await exists({
      apiUrl: input.apiUrl,
      path: `/repos/${encodeURIComponent(input.spec.owner)}/${encodeURIComponent(
        input.spec.repo,
      )}`,
      token: input.token,
    })
  ) {
    return {
      owner: input.spec.owner,
      repo: input.spec.repo,
      private: input.spec.private,
      action: 'exists',
    }
  }
  const response = await request({
    apiUrl: input.apiUrl,
    path: `/orgs/${encodeURIComponent(input.spec.owner)}/repos`,
    method: 'POST',
    token: input.token,
    body: {
      name: input.spec.repo,
      private: input.spec.private,
      auto_init: true,
      default_branch: 'main',
      description: input.spec.repoDescription,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea repo create failed: ${response.status} ${input.spec.owner}/${input.spec.repo}`,
    )
  }
  return {
    owner: input.spec.owner,
    repo: input.spec.repo,
    private: input.spec.private,
    action: 'created',
  }
}

async function addRepositoryCollaborator(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  username: string
  permission: 'read' | 'write' | 'admin'
}): Promise<MatOSGiteaScopeProvisionMember> {
  const username = input.username.trim()
  if (!username) {
    throw new Error('Gitea collaborator username is required')
  }
  const response = await request({
    apiUrl: input.apiUrl,
    token: input.token,
    method: 'PUT',
    path: `/repos/${repoPath(input.owner, input.repo)}/collaborators/${encodeURIComponent(
      username,
    )}`,
    body: {
      permission: input.permission,
    },
  })
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) {
      return {
        username,
        permission: input.permission,
        action: 'existing',
      }
    }
    throw new Error(
      `Gitea collaborator add failed: ${response.status} ${input.owner}/${input.repo}:${username}`,
    )
  }
  return {
    username,
    permission: input.permission,
    action: 'added',
  }
}

export async function addMatOSGiteaRepositoryCollaborator(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  username: string
  permission: 'read' | 'write' | 'admin'
}): Promise<MatOSGiteaScopeProvisionMember> {
  return addRepositoryCollaborator({
    ...input,
    apiUrl: normalizeApiUrl(input.apiUrl),
  })
}

function repositoryFromBody(input: {
  body: string
  fallbackOwner: string
  fallbackRepo: string
}): {
  owner: string
  repo: string
  fork: boolean
  private: boolean
  parent?: string
  cloneUrl?: string
  webUrl?: string
  permissions: { admin: boolean; pull: boolean; push: boolean }
} | undefined {
  const parsed = parseJsonBody<{
    name?: string
    full_name?: string
    fork?: boolean
    private?: boolean
    clone_url?: string
    html_url?: string
    parent?: { full_name?: string }
    owner?: { login?: string; username?: string }
    permissions?: { admin?: boolean; pull?: boolean; push?: boolean }
  }>(input.body)
  if (!parsed) return undefined
  const fullName = parsed.full_name?.trim()
  const [fullOwner, fullRepo] = fullName?.includes('/')
    ? fullName.split('/', 2)
    : [undefined, undefined]
  return {
    owner:
      parsed.owner?.login?.trim() ||
      parsed.owner?.username?.trim() ||
      fullOwner ||
      input.fallbackOwner,
    repo: parsed.name?.trim() || fullRepo || input.fallbackRepo,
    fork: parsed.fork === true,
    private: parsed.private === true,
    parent: parsed.parent?.full_name?.trim(),
    cloneUrl: parsed.clone_url?.trim(),
    webUrl: parsed.html_url?.trim(),
    permissions: {
      admin: parsed.permissions?.admin === true,
      pull: parsed.permissions?.pull === true,
      push: parsed.permissions?.push === true,
    },
  }
}

export async function readMatOSGiteaRepositoryAccess(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
}): Promise<MatOSGiteaRepositoryAccessResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    path: `/repos/${repoPath(input.owner, input.repo)}`,
  })
  if (!response.ok) {
    throw new Error(
      `Gitea repository access read failed: ${response.status} ${input.owner}/${input.repo}`,
    )
  }
  const repository = repositoryFromBody({
    body: response.body,
    fallbackOwner: input.owner,
    fallbackRepo: input.repo,
  })
  if (!repository) {
    throw new Error(`Gitea repository access response was invalid: ${input.owner}/${input.repo}`)
  }
  return {
    ok: true,
    owner: repository.owner,
    repo: repository.repo,
    permissions: repository.permissions,
  }
}

export async function ensureMatOSGiteaContributionFork(input: {
  apiUrl: string
  token?: string
  username: string
  forkRepo?: string
  upstreamOwner?: string
  upstreamRepo?: string
}): Promise<MatOSGiteaContributionForkResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const username = input.username.trim()
  const forkRepo = input.forkRepo?.trim() || 'matos-contributions'
  const upstreamOwner = input.upstreamOwner?.trim() || 'matos-community'
  const upstreamRepo = input.upstreamRepo?.trim() || 'contributions'
  if (!username) throw new Error('Gitea contribution fork requires a username')

  const readFork = async (): Promise<ReturnType<typeof repositoryFromBody>> => {
    const response = await request({
      apiUrl,
      token: input.token,
      path: `/repos/${repoPath(username, forkRepo)}`,
    })
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(
        `Gitea contribution fork read failed: ${response.status} ${username}/${forkRepo}`,
      )
    }
    return repositoryFromBody({
      body: response.body,
      fallbackOwner: username,
      fallbackRepo: forkRepo,
    })
  }
  let repository = await readFork()
  let action: MatOSGiteaContributionForkResult['action'] = 'exists'
  if (!repository) {
    const response = await request({
      apiUrl,
      token: input.token,
      method: 'POST',
      path: `/repos/${repoPath(upstreamOwner, upstreamRepo)}/forks`,
      body: { name: forkRepo },
    })
    if (!response.ok) {
      throw new Error(
        `Gitea contribution fork create failed: ${response.status} ${upstreamOwner}/${upstreamRepo}`,
      )
    }
    repository = repositoryFromBody({
      body: response.body,
      fallbackOwner: username,
      fallbackRepo: forkRepo,
    })
    action = 'created'
    // Fork creation can be asynchronous. Poll only the repository metadata;
    // the later git materializer remains the final availability check.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) await sleep(100 * 2 ** Math.min(attempt - 1, 3))
      repository = await readFork() ?? repository
      if (repository?.parent && repository.permissions.push) break
    }
  }
  const expectedParent = `${upstreamOwner}/${upstreamRepo}`.toLowerCase()
  if (
    !repository?.fork ||
    !repository.private ||
    repository.owner.toLowerCase() !== username.toLowerCase() ||
    repository.parent?.toLowerCase() !== expectedParent ||
    !repository.permissions.push
  ) {
    throw new Error(
      `Gitea repository ${username}/${forkRepo} is not a private writable fork of ${upstreamOwner}/${upstreamRepo}.`,
    )
  }
  return {
    ok: true,
    owner: username,
    repo: forkRepo,
    action,
    ...(repository.cloneUrl ? { cloneUrl: repository.cloneUrl } : {}),
    ...(repository.webUrl ? { webUrl: repository.webUrl } : {}),
  }
}

export async function syncMatOSGiteaContributionFork(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  branch?: string
}): Promise<void> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/merge-upstream`,
    body: { branch: input.branch?.trim() || 'main' },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea contribution fork sync failed: ${response.status} ${input.owner}/${input.repo}`,
    )
  }
}

function contributionInboxPolicyFromBody(input: {
  owner: string
  repo: string
  branch: string
  body: string
  action: 'created' | 'exists' | 'repaired'
}): MatOSGiteaContributionInboxPolicyResult {
  const parsed = parseJsonBody<{
    branch_name?: string
    enable_push?: boolean
    enable_push_whitelist?: boolean
    push_whitelist_usernames?: string[]
    push_whitelist_teams?: string[]
    push_whitelist_deploy_keys?: boolean
    enable_merge_whitelist?: boolean
    merge_whitelist_usernames?: string[]
    merge_whitelist_teams?: string[]
    enable_approvals_whitelist?: boolean
    approvals_whitelist_username?: string[]
    approvals_whitelist_teams?: string[]
    required_approvals?: number
    dismiss_stale_approvals?: boolean
    ignore_stale_approvals?: boolean
    block_on_rejected_reviews?: boolean
    block_on_official_review_requests?: boolean
    block_on_outdated_branch?: boolean
    block_admin_merge_override?: boolean
    enable_force_push?: boolean
    enable_force_push_allowlist?: boolean
    enable_bypass_allowlist?: boolean
    bypass_allowlist_usernames?: string[]
    bypass_allowlist_teams?: string[]
    enable_status_check?: boolean
    status_check_contexts?: string[]
  }>(input.body)
  const pushOwners = Array.isArray(parsed?.push_whitelist_usernames)
    ? parsed!.push_whitelist_usernames!.filter(Boolean)
    : []
  const mergeOwners = Array.isArray(parsed?.merge_whitelist_usernames)
    ? parsed!.merge_whitelist_usernames!.filter(Boolean)
    : []
  const approvalOwners = Array.isArray(parsed?.approvals_whitelist_username)
    ? parsed!.approvals_whitelist_username!.filter(Boolean)
    : []
  const normalizeNames = (values: string[]): string[] =>
    [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))].sort()
  const normalizedPushOwners = normalizeNames(pushOwners)
  const normalizedMergeOwners = normalizeNames(mergeOwners)
  const normalizedApprovalOwners = normalizeNames(approvalOwners)
  const sameOwners =
    JSON.stringify(normalizedPushOwners) === JSON.stringify(normalizedMergeOwners) &&
    JSON.stringify(normalizedPushOwners) === JSON.stringify(normalizedApprovalOwners)
  const noTeamOrBypassAccess = [
    parsed?.push_whitelist_teams,
    parsed?.merge_whitelist_teams,
    parsed?.approvals_whitelist_teams,
    parsed?.bypass_allowlist_usernames,
    parsed?.bypass_allowlist_teams,
  ].every(values => !Array.isArray(values) || values.length === 0)
  const statusContexts = Array.isArray(parsed?.status_check_contexts)
    ? parsed.status_check_contexts
    : []
  const ownerUsernames = [...new Set(pushOwners.map(value => value.trim()).filter(Boolean))]
  const ok = Boolean(
    parsed?.enable_push === true &&
      parsed.enable_push_whitelist === true &&
      parsed.enable_merge_whitelist === true &&
      parsed.enable_approvals_whitelist === true &&
      Number(parsed.required_approvals ?? 0) >= 1 &&
      normalizedPushOwners.length > 0 &&
      sameOwners &&
      noTeamOrBypassAccess &&
      parsed.push_whitelist_deploy_keys !== true &&
      parsed.dismiss_stale_approvals === true &&
      parsed.ignore_stale_approvals !== true &&
      parsed.block_on_rejected_reviews === true &&
      parsed.block_on_official_review_requests === true &&
      parsed.block_on_outdated_branch === true &&
      parsed.block_admin_merge_override === true &&
      parsed.enable_force_push !== true &&
      parsed.enable_force_push_allowlist !== true &&
      parsed.enable_bypass_allowlist !== true &&
      parsed.enable_status_check === true &&
      statusContexts.includes('matos/owner-verify'),
  )
  return {
    ok,
    owner: input.owner,
    repo: input.repo,
    branch: parsed?.branch_name?.trim() || input.branch,
    action: input.action,
    ownerUsernames,
  }
}

export async function readMatOSGiteaContributionInboxPolicy(input: {
  apiUrl: string
  token?: string
  owner?: string
  repo?: string
  branch?: string
}): Promise<MatOSGiteaContributionInboxPolicyResult | undefined> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const owner = input.owner?.trim() || 'matos-community'
  const repo = input.repo?.trim() || 'contributions'
  const branch = input.branch?.trim() || 'main'
  const response = await request({
    apiUrl,
    token: input.token,
    path: `/repos/${repoPath(owner, repo)}/branch_protections/${encodeURIComponent(branch)}`,
  })
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(
      `Gitea contribution inbox policy read failed: ${response.status} ${owner}/${repo}:${branch}`,
    )
  }
  return contributionInboxPolicyFromBody({
    owner,
    repo,
    branch,
    body: response.body,
    action: 'exists',
  })
}

export async function ensureMatOSGiteaContributionInboxPolicy(input: {
  apiUrl: string
  token?: string
  owner?: string
  repo?: string
  branch?: string
  ownerUsernames: string[]
}): Promise<MatOSGiteaContributionInboxPolicyResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const owner = input.owner?.trim() || 'matos-community'
  const repo = input.repo?.trim() || 'contributions'
  const branch = input.branch?.trim() || 'main'
  const ownerUsernames = [...new Set(input.ownerUsernames.map(value => value.trim()).filter(Boolean))]
  if (ownerUsernames.length === 0) {
    throw new Error('MatOS contribution inbox protection requires at least one owner username')
  }
  const expectedOwners = ownerUsernames
    .map(value => value.toLowerCase())
    .sort()
  const hasExpectedOwners = (
    policy: MatOSGiteaContributionInboxPolicyResult | undefined,
  ): policy is MatOSGiteaContributionInboxPolicyResult =>
    Boolean(
      policy?.ok &&
      JSON.stringify(policy.ownerUsernames.map(value => value.toLowerCase()).sort()) ===
        JSON.stringify(expectedOwners),
    )
  const existing = await readMatOSGiteaContributionInboxPolicy({
    apiUrl,
    token: input.token,
    owner,
    repo,
    branch,
  })
  if (hasExpectedOwners(existing)) return existing
  const policyBody = {
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_usernames: ownerUsernames,
    push_whitelist_teams: [],
    push_whitelist_deploy_keys: false,
    enable_merge_whitelist: true,
    merge_whitelist_usernames: ownerUsernames,
    merge_whitelist_teams: [],
    enable_approvals_whitelist: true,
    // Gitea's public API intentionally uses the singular `username` key for
    // this array (verified against the deployed 1.27 OpenAPI document).
    approvals_whitelist_username: ownerUsernames,
    approvals_whitelist_teams: [],
    required_approvals: 1,
    dismiss_stale_approvals: true,
    ignore_stale_approvals: false,
    block_on_rejected_reviews: true,
    block_on_official_review_requests: true,
    block_on_outdated_branch: true,
    block_admin_merge_override: true,
    enable_force_push: false,
    enable_force_push_allowlist: false,
    enable_bypass_allowlist: false,
    bypass_allowlist_usernames: [],
    bypass_allowlist_teams: [],
    enable_status_check: true,
    status_check_contexts: ['matos/owner-verify'],
  }
  const method = existing ? 'PATCH' : 'POST'
  const path = existing
    ? `/repos/${repoPath(owner, repo)}/branch_protections/${encodeURIComponent(branch)}`
    : `/repos/${repoPath(owner, repo)}/branch_protections`
  const response = await request({
    apiUrl,
    token: input.token,
    method,
    path,
    body: {
      ...(!existing ? { branch_name: branch } : {}),
      ...policyBody,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea contribution inbox protection ${existing ? 'repair' : 'create'} failed: ${response.status} ${owner}/${repo}:${branch}`,
    )
  }
  const action = existing ? 'repaired' : 'created'
  const policy = contributionInboxPolicyFromBody({
    owner,
    repo,
    branch,
    body: response.body,
    action,
  })
  // Some Gitea versions return a partial create response. Re-read before
  // trusting the policy instead of treating an incomplete response as safe.
  const verified = policy.ok
    ? policy
    : await readMatOSGiteaContributionInboxPolicy({
        apiUrl,
        token: input.token,
        owner,
        repo,
        branch,
      })
  if (!hasExpectedOwners(verified)) {
    throw new Error(
      `MatOS contribution inbox protection could not be verified: ${owner}/${repo}:${branch}`,
    )
  }
  return { ...verified, action }
}

export async function ensureMatOSGiteaUser(input: {
  apiUrl: string
  token?: string
  username: string
  email: string
  password: string
  fullName?: string
  resetPasswordIfExists?: boolean
  enforceAssetUserPolicy?: boolean
}): Promise<MatOSGiteaUserProvisionResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const username = input.username.trim()
  const email = input.email.trim()
  if (!username) {
    throw new Error('Gitea username is required')
  }
  if (!email) {
    throw new Error('Gitea user email is required')
  }
  const existsAlready =
    await exists({
      apiUrl,
      token: input.token,
      path: `/users/${encodeURIComponent(username)}`,
    })
  const updateManagedUser = async (includePassword: boolean): Promise<void> => {
    const response = await request({
      apiUrl,
      token: input.token,
      method: 'PATCH',
      path: `/admin/users/${encodeURIComponent(username)}`,
      body: {
        email,
        full_name: input.fullName ?? username,
        ...(includePassword ? { password: input.password } : {}),
        must_change_password: false,
        active: true,
        prohibit_login: false,
        source_id: 0,
        login_name: username,
        admin: false,
        allow_create_organization: false,
        allow_git_hook: false,
        allow_import_local: false,
        max_repo_creation: 0,
      },
    })
    if (!response.ok) {
      throw new Error(
        `Gitea managed user policy update failed: ${response.status} ${username}`,
      )
    }
  }
  if (existsAlready) {
    if (input.resetPasswordIfExists || input.enforceAssetUserPolicy) {
      await updateManagedUser(input.resetPasswordIfExists === true)
    }
    return { ok: true, apiUrl, username, email, action: 'exists' }
  }
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: '/admin/users',
    body: {
      username,
      email,
      password: input.password,
      full_name: input.fullName ?? username,
      must_change_password: false,
      send_notify: false,
    },
  })
  if (!response.ok) {
    throw new Error(`Gitea user create failed: ${response.status} ${username}`)
  }
  if (input.enforceAssetUserPolicy !== false) {
    await updateManagedUser(false)
  }
  return { ok: true, apiUrl, username, email, action: 'created' }
}

export async function createMatOSGiteaUserAccessToken(input: {
  apiUrl: string
  token?: string
  password?: string
  username: string
  name: string
  scopes?: string[]
}): Promise<MatOSGiteaUserAccessTokenResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const username = input.username.trim()
  const name = input.name.trim()
  if (!username) {
    throw new Error('Gitea token username is required')
  }
  if (!name) {
    throw new Error('Gitea token name is required')
  }
  // Workspace credentials are deliberately limited to repository access and
  // identity lookup. Reject arbitrary scopes so callers cannot accidentally
  // mint an admin or user-management token.
  const scopes = input.scopes ?? [...MATOS_GITEA_USER_ASSET_TOKEN_SCOPES]
  const allowedScopes = new Set<string>(MATOS_GITEA_USER_ASSET_TOKEN_SCOPES)
  const invalidScopes = scopes.filter(scope => !allowedScopes.has(scope))
  if (invalidScopes.length > 0) {
    throw new Error('Gitea user token scopes are restricted; unsupported scope(s): ' + invalidScopes.join(', '))
  }
  const response = await request({
    apiUrl,
    token: input.password ? undefined : input.token,
    authorization: input.password
      ? basicAuthorization(username, input.password)
      : undefined,
    method: 'POST',
    path: `/users/${encodeURIComponent(username)}/tokens`,
    body: {
      name,
      scopes: [...scopes],
    },
  })
  if (!response.ok) {
    throw new Error(`Gitea user token create failed: ${response.status} ${username}`)
  }
  const parsed = parseJsonBody<{ sha1?: string; token?: string }>(response.body)
  const accessToken = parsed?.sha1?.trim() || parsed?.token?.trim()
  if (!accessToken) {
    throw new Error(`Gitea user token create returned no token for ${username}`)
  }
  return {
    ok: true,
    apiUrl,
    username,
    name,
    token: accessToken,
  }
}

export const MATOS_GITEA_USER_ASSET_TOKEN_SCOPES = [
  'write:repository',
  'read:user',
] as const

export async function deleteMatOSGiteaUserAccessToken(input: {
  apiUrl: string
  token?: string
  password?: string
  username: string
  tokenNameOrId: string
}): Promise<boolean> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const username = input.username.trim()
  const tokenNameOrId = input.tokenNameOrId.trim()
  if (!username || !tokenNameOrId) return false
  const response = await request({
    apiUrl,
    token: input.password ? undefined : input.token,
    authorization: input.password
      ? basicAuthorization(username, input.password)
      : undefined,
    method: 'DELETE',
    path: `/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenNameOrId)}`,
  })
  if (response.status === 404) return false
  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Gitea user token delete failed: ${response.status} ${username}`,
    )
  }
  return true
}

export async function validateMatOSGiteaAccessToken(input: {
  apiUrl: string
  token: string
}): Promise<MatOSGiteaTokenValidationResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    path: '/user',
  })
  if (!response.ok) {
    return { ok: false, apiUrl, status: response.status }
  }
  const parsed = parseJsonBody<{ login?: string; username?: string }>(
    response.body,
  )
  return {
    ok: true,
    apiUrl,
    username: parsed?.login?.trim() || parsed?.username?.trim(),
    status: response.status,
  }
}

export async function inspectMatOSGiteaRepositoryAccess(input: {
  apiUrl: string; token: string; owner: string; repo: string
}): Promise<{ ok: true; username: string } | {
  ok: false; status: number
  code: 'gitea_auth_rejected' | 'gitea_repository_forbidden' | 'gitea_unavailable'
}> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const identity = await validateMatOSGiteaAccessToken(input)
  if (!identity.ok || !identity.username) return {
    ok: false, status: identity.status,
    code: identity.status === 401 || identity.status === 403 ? 'gitea_auth_rejected' : 'gitea_unavailable',
  }
  const response = await request({ apiUrl, token: input.token, path: `/repos/${repoPath(input.owner, input.repo)}` })
  if (!response.ok) return {
    ok: false, status: response.status,
    code: [401, 403, 404].includes(response.status) ? 'gitea_repository_forbidden' : 'gitea_unavailable',
  }
  const body = parseJsonBody<{ permissions?: { push?: boolean }; archived?: boolean; mirror?: boolean }>(response.body)
  if (body?.permissions?.push !== true || body.archived || body.mirror) return {
    ok: false, status: response.status, code: 'gitea_repository_forbidden',
  }
  return { ok: true, username: identity.username }
}

/** Advertise receive-pack without sending a pack or changing any Git ref. */
export async function inspectMatOSGiteaGitWriteAccess(input: {
  repoUrl: string; token: string; username: string
}): Promise<{ ok: boolean; status: number }> {
  const url = new URL(input.repoUrl)
  const response = await request({
    apiUrl: url.origin,
    path: `${url.pathname.replace(/\/$/, '')}/info/refs?service=git-receive-pack`,
    authorization: basicAuthorization(input.username, input.token),
  })
  return { ok: response.ok && response.body.includes('# service=git-receive-pack\n'), status: response.status }
}

export async function provisionMatOSGiteaAssetScope(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  scopeLabel: string
  private?: boolean
  members?: string[]
  admins?: string[]
  dryRun?: boolean
}): Promise<MatOSGiteaScopeProvisionResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const members = [...new Set((input.members ?? []).map(value => value.trim()).filter(Boolean))]
  const admins = [...new Set((input.admins ?? []).map(value => value.trim()).filter(Boolean))]
  const spec = scopedRepoSpec({
    owner: input.owner,
    repo: input.repo,
    private: input.private ?? true,
    scopeLabel: input.scopeLabel,
  })

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      apiUrl,
      organization: {
        owner: spec.owner,
        action: 'planned',
      },
      repository: {
        owner: spec.owner,
        repo: spec.repo,
        private: spec.private,
        action: 'planned',
      },
      members: [
        ...members.map(username => ({
          username,
          permission: 'write' as const,
          action: 'planned' as const,
        })),
        ...admins.map(username => ({
          username,
          permission: 'admin' as const,
          action: 'planned' as const,
        })),
      ],
    }
  }

  const organization = await ensureOrganization({
    apiUrl,
    token: input.token,
    spec,
  })
  const repository = await ensureRepository({
    apiUrl,
    token: input.token,
    spec,
  })
  const provisionedMembers: MatOSGiteaScopeProvisionMember[] = []
  for (const username of members) {
    provisionedMembers.push(
      await addRepositoryCollaborator({
        apiUrl,
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        username,
        permission: 'write',
      }),
    )
  }
  for (const username of admins) {
    provisionedMembers.push(
      await addRepositoryCollaborator({
        apiUrl,
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        username,
        permission: 'admin',
      }),
    )
  }

  return {
    ok: true,
    dryRun: false,
    apiUrl,
    organization,
    repository,
    members: provisionedMembers,
  }
}

export async function bootstrapMatOSGiteaAssetRepos(input: {
  apiUrl: string
  token?: string
  dryRun?: boolean
}): Promise<MatOSGiteaBootstrapResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      apiUrl,
      organizations: DEFAULT_ASSET_REPOS.map(spec => ({
        owner: spec.owner,
        action: 'planned',
      })),
      repositories: DEFAULT_ASSET_REPOS.map(spec => ({
        owner: spec.owner,
        repo: spec.repo,
        private: spec.private,
        action: 'planned',
      })),
    }
  }

  const organizations: MatOSGiteaBootstrapOrganization[] = []
  const repositories: MatOSGiteaBootstrapRepository[] = []
  for (const spec of DEFAULT_ASSET_REPOS) {
    organizations.push(
      await ensureOrganization({
        apiUrl,
        token: input.token,
        spec,
      }),
    )
    repositories.push(
      await ensureRepository({
        apiUrl,
        token: input.token,
        spec,
      }),
    )
  }
  const operator = input.token
    ? await validateMatOSGiteaAccessToken({ apiUrl, token: input.token })
    : undefined
  const ownerUsername = operator?.username?.trim()
  if (!ownerUsername) {
    throw new Error(
      'MatOS Gitea bootstrap could not identify the owner account required for the protected community contribution inbox.',
    )
  }
  const contributionInboxPolicy = await ensureMatOSGiteaContributionInboxPolicy({
    apiUrl,
    token: input.token,
    ownerUsernames: [ownerUsername],
  })

  return {
    ok: true,
    dryRun: false,
    apiUrl,
    organizations,
    repositories,
    contributionInboxPolicy,
  }
}

export async function createMatOSGiteaBranch(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  branch: string
  fromRef?: string
}): Promise<MatOSGiteaBranchResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const fromRef = input.fromRef?.trim() || 'main'
  const branch = input.branch.trim()
  if (!branch) {
    throw new Error('Gitea branch name is required')
  }
  const branchPath = `/repos/${repoPath(input.owner, input.repo)}/branches/${encodeURIComponent(
    branch,
  )}`
  if (await exists({ apiUrl, path: branchPath, token: input.token })) {
    return {
      ok: true,
      owner: input.owner,
      repo: input.repo,
      branch,
      fromRef,
      action: 'exists',
    }
  }
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/branches`,
    body: {
      new_branch_name: branch,
      old_branch_name: fromRef,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea branch create failed: ${response.status} ${input.owner}/${input.repo}:${branch}`,
    )
  }
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    branch,
    fromRef,
    action: 'created',
  }
}

export async function createMatOSGiteaPullRequest(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  sourceBranch: string
  targetBranch: string
  title: string
  body?: string
}): Promise<MatOSGiteaPullRequestResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/pulls`,
    body: {
      head: input.sourceBranch,
      base: input.targetBranch,
      title: input.title,
      body: input.body ?? '',
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea pull request create failed: ${response.status} ${input.owner}/${input.repo}`,
    )
  }
  return pullRequestFromBody({
    owner: input.owner,
    repo: input.repo,
    body: response.body,
  })
}

export async function readMatOSGiteaPullRequest(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  number: number
}): Promise<MatOSGiteaPullRequestResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    path: `/repos/${repoPath(input.owner, input.repo)}/pulls/${input.number}`,
  })
  if (!response.ok) {
    throw new Error(
      `Gitea pull request read failed: ${response.status} ${input.owner}/${input.repo}#${input.number}`,
    )
  }
  return pullRequestFromBody({
    owner: input.owner,
    repo: input.repo,
    body: response.body,
    fallbackNumber: input.number,
  })
}

export async function closeMatOSGiteaPullRequest(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  number: number
}): Promise<MatOSGiteaPullRequestResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'PATCH',
    path: `/repos/${repoPath(input.owner, input.repo)}/pulls/${input.number}`,
    body: { state: 'closed' },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea pull request close failed: ${response.status} ${input.owner}/${input.repo}#${input.number}`,
    )
  }
  return pullRequestFromBody({
    owner: input.owner,
    repo: input.repo,
    body: response.body,
    fallbackNumber: input.number,
  })
}

export async function mergeMatOSGiteaPullRequest(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  number: number
  method?: 'merge' | 'squash' | 'rebase'
}): Promise<MatOSGiteaPullRequestMergeResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/pulls/${input.number}/merge`,
    body: {
      Do: input.method ?? 'merge',
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea pull request merge failed: ${response.status} ${input.owner}/${input.repo}#${input.number}`,
    )
  }
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    merged: true,
    status: response.status,
  }
}

export async function createMatOSGiteaCommitStatus(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  commit: string
  state: MatOSGiteaCommitStatusState
  context?: string
  description?: string
  targetUrl?: string
}): Promise<MatOSGiteaCommitStatusResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/statuses/${encodeURIComponent(
      input.commit,
    )}`,
    body: {
      state: input.state,
      ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      ...(input.description ? { description: input.description } : {}),
      context: input.context ?? 'matos/validate',
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea commit status create failed: ${response.status} ${input.owner}/${input.repo}:${input.commit}`,
    )
  }
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    commit: input.commit,
    state: input.state,
    status: response.status,
  }
}

async function readMatOSGiteaContent(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  branch: string
  path: string
}): Promise<{ sha?: string; url?: string } | undefined> {
  const response = await request({
    apiUrl: normalizeApiUrl(input.apiUrl),
    token: input.token,
    path: `/repos/${repoPath(input.owner, input.repo)}/contents/${contentPath(
      input.path,
    )}?ref=${encodeURIComponent(input.branch)}`,
  })
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(
      `Gitea content read failed: ${response.status} ${input.owner}/${input.repo}:${input.path}`,
    )
  }
  const parsed = parseJsonBody<{ sha?: string; html_url?: string; url?: string }>(
    response.body,
  )
  return { sha: parsed?.sha, url: parsed?.html_url ?? parsed?.url }
}

export async function writeMatOSGiteaTextFile(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  branch: string
  path: string
  content: string | Buffer
  message: string
}): Promise<MatOSGiteaContentWriteResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const existing = await readMatOSGiteaContent({ ...input, apiUrl })
  const response = await request({
    apiUrl,
    token: input.token,
    method: existing?.sha ? 'PUT' : 'POST',
    path: `/repos/${repoPath(input.owner, input.repo)}/contents/${contentPath(input.path)}`,
    body: {
      branch: input.branch,
      message: input.message,
      content: Buffer.from(input.content).toString('base64'),
      ...(existing?.sha ? { sha: existing.sha } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea content write failed: ${response.status} ${input.owner}/${input.repo}:${input.path}`,
    )
  }
  const parsed = parseJsonBody<{ content?: { html_url?: string; url?: string } }>(
    response.body,
  )
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    path: input.path,
    action: existing?.sha ? 'updated' : 'created',
    url: parsed?.content?.html_url ?? parsed?.content?.url ?? existing?.url,
  }
}

export async function deleteMatOSGiteaFile(input: {
  apiUrl: string
  token?: string
  owner: string
  repo: string
  branch: string
  path: string
  message: string
}): Promise<MatOSGiteaContentWriteResult> {
  const apiUrl = normalizeApiUrl(input.apiUrl)
  const existing = await readMatOSGiteaContent({ ...input, apiUrl })
  if (!existing?.sha) {
    return {
      ok: true,
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      path: input.path,
      action: 'absent',
    }
  }
  const response = await request({
    apiUrl,
    token: input.token,
    method: 'DELETE',
    path: `/repos/${repoPath(input.owner, input.repo)}/contents/${contentPath(input.path)}`,
    body: {
      branch: input.branch,
      message: input.message,
      sha: existing.sha,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Gitea content delete failed: ${response.status} ${input.owner}/${input.repo}:${input.path}`,
    )
  }
  return {
    ok: true,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    path: input.path,
    action: 'deleted',
    url: existing.url,
  }
}
