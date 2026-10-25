import { realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  findMatOSProjectRoot,
  matOSProjectMetadataPath,
  readMatOSProjectMetadata,
  type MatOSProjectMetadata,
} from '../projectMetadata.js'

const PROJECT_PRIVATE_RELATIVE_PATH = join('.matos', 'private')
const PROJECT_INTERNAL_TOP_LEVEL_NAMES = [
  '.gitignore',
  'algorithms',
  'asset-history',
  'asset-history-cache',
  'asset-history.git',
  'benchmarks',
  'cache',
  'config',
  'evolution',
  'feedback',
  'gateway',
  'index',
  'learning',
  'locks',
  'manuals',
  'matos.json',
  'project.json',
  'runtime',
  'sessions',
  'source-cache',
  'source.json',
  'tmp',
  'tmp-smoke',
  'workbench',
] as const

type JsonRecord = Record<string, unknown>

export type MatOSProjectAccessPolicy = {
  projectCwd: string
  projectId: string
  memberId: string
  roleRef: string
  matosRoot: string
  sharedAssetsRoot: string
  privateRoot: string
  memberPrivateRoot: string
  deniedPrivateRoots: string[]
  protectedRuntimePaths: string[]
  settingsPath: string
  goal?: string
  memberBrief?: string
}

export type MatOSProjectMemberBinding = {
  metadata: MatOSProjectMetadata
  projectCwd: string
  projectId: string
  memberId: string
  roleRef: string
}

export class MatOSProjectToolPathDeniedError extends Error {
  readonly code = 'MATOS_PROJECT_TOOL_PATH_DENIED'

  constructor() {
    super('MatOS project tool input may not access another member or internal project state')
    this.name = 'MatOSProjectToolPathDeniedError'
  }
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function decodedToolInputText(value: string): string {
  let normalized = value.replace(/\\/g, '/')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(normalized)
      if (decoded === normalized) break
      normalized = decoded
    } catch {
      break
    }
  }
  return normalized.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/')
}


function stripProjectContainerPrefix(text: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    let from = 0
    while (prefix && from < text.length) {
      const index = text.indexOf(prefix, from)
      if (index < 0) break
      const before = text[index - 1]
      const after = text[index + prefix.length]
      const boundary = /[\s"'()\[\]{},;:=\u0060]/
      if ((!before || boundary.test(before)) && (!after || after === '/' || boundary.test(after))) {
        text = text.slice(0, index) + '[project]' + text.slice(index + prefix.length)
        from = index + '[project]'.length
      } else {
        from = index + prefix.length
      }
    }
  }
  return text
}


function assertToolInputStringAllowed(value: string, memberId: string, projectPrefixes: readonly string[]): void {
  // Deployment containers may themselves live under .matos. Inspect the
  // project-relative suffix, while still rejecting its own internal state.
  const text = stripProjectContainerPrefix(decodedToolInputText(value), projectPrefixes)
  const lower = text.toLowerCase()
  const matosMarker = '.matos'
  let cursor = 0
  while (true) {
    const markerIndex = lower.indexOf(matosMarker, cursor)
    if (markerIndex < 0) break
    const previous = markerIndex > 0 ? lower[markerIndex - 1] : ''
    const suffix = text.slice(markerIndex + matosMarker.length)
    if (previous && /[A-Za-z0-9_-]/.test(previous)) {
      cursor = markerIndex + matosMarker.length
      continue
    }
    const token = suffix.split(/[\s"'`),;\]}]/, 1)[0] ?? ''
    const segments = token.split('/').filter(Boolean)
    const allowedAssets = segments[0]?.toLowerCase() === 'assets' &&
      !segments.some(segment => segment === '..')
    const allowedPrivate = segments[0]?.toLowerCase() === 'private' &&
      segments[1] === memberId &&
      !segments.some(segment => segment === '..')
    if (!allowedAssets && !allowedPrivate) {
      throw new MatOSProjectToolPathDeniedError()
    }
    cursor = markerIndex + matosMarker.length
  }
}

export function assertMatOSProjectToolInputAllowed(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const projectCwd = stringValue(env.MATOS_PROJECT_CWD) ??
    stringValue(env.MATOS_WORKSPACE_DIR)
  const rawMemberId = stringValue(env.MATOS_PROJECT_MEMBER_ID)
  if (!projectCwd || !rawMemberId) return
  const memberId = assertMatOSProjectMemberId(rawMemberId)
  const projectRoots = new Set([resolve(projectCwd)])
  try { projectRoots.add(realpathSync.native(projectCwd)) } catch {}
  const projectPrefixes = [...projectRoots].map(root => decodedToolInputText(root).replace(/\/$/, '')).filter(Boolean)
  const seen = new WeakSet<object>()
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      assertToolInputStringAllowed(candidate, memberId, projectPrefixes)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    if (seen.has(candidate)) return
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    for (const item of Object.values(candidate as Record<string, unknown>)) {
      visit(item)
    }
  }
  visit(value)
}

function roleIdentity(roleRef: string): string {
  return roleRef.trim().split('@')[0] ?? roleRef.trim()
}

function fallbackMemberId(roleRef: string): string {
  const tail = roleIdentity(roleRef).split(':').pop() ?? 'agent'
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `agent-${slug || 'agent'}`
}

function validMemberId(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

export function assertMatOSProjectMemberId(memberId: string): string {
  const value = memberId.trim()
  if (!validMemberId(value)) {
    throw new Error(`Invalid MatOS project member id: ${memberId}`)
  }
  return value
}

export async function resolveMatOSProjectMemberBinding(input: {
  cwd: string
  roleRef: string
  memberId?: string
}): Promise<MatOSProjectMemberBinding | undefined> {
  const projectCwd = await findMatOSProjectRoot(input.cwd)
  if (!projectCwd) return undefined
  const metadata = await readMatOSProjectMetadata(projectCwd)
  const projectId = stringValue(metadata.id)
  if (!projectId) return undefined
  return {
    metadata,
    projectCwd,
    projectId,
    memberId: resolveMemberId(metadata, input.roleRef, input.memberId),
    roleRef: input.roleRef,
  }
}

function teamRecords(metadata: MatOSProjectMetadata): JsonRecord[] {
  if (metadata.team === undefined) return []
  if (!Array.isArray(metadata.team)) {
    throw new Error('Invalid MatOS project team: expected an array')
  }
  if (metadata.team.length > 256) {
    throw new Error('Invalid MatOS project team: exceeds 256 members')
  }
  return metadata.team.map((item, index) => {
    const record = typeof item === 'string' ? { roleRef: item } : objectValue(item)
    const roleRef = stringValue(record.roleRef) ?? stringValue(record.role_ref)
    const kind = stringValue(record.kind)
    const userId = stringValue(record.userId) ?? stringValue(record.user_id)
    // Cross-user project collaborators are recorded in the shared project
    // authority as role-less human members. They participate in attribution
    // and private-root isolation, but they are not runnable agents and must
    // not make otherwise valid role bindings fail to materialize.
    if (!roleRef && (kind !== 'human' || !userId)) {
      throw new Error(`Invalid MatOS project team member at index ${index}`)
    }
    if (!roleRef && !memberRecordId(record)) {
      throw new Error(`Invalid MatOS project team member at index ${index}`)
    }
    return record
  })
}

export function matOSProjectRoleRefs(metadata: MatOSProjectMetadata): string[] {
  return unique(teamRecords(metadata).flatMap(record => {
    const roleRef = stringValue(record.roleRef) ?? stringValue(record.role_ref)
    return roleRef ? [roleRef] : []
  }))
}

function memberRecordId(record: JsonRecord): string | undefined {
  const explicit = stringValue(record.memberId) ?? stringValue(record.member_id)
  if (explicit) return assertMatOSProjectMemberId(explicit)
  const roleRef = stringValue(record.roleRef) ?? stringValue(record.role_ref)
  return roleRef ? fallbackMemberId(roleRef) : undefined
}

function resolveMemberId(
  metadata: MatOSProjectMetadata,
  roleRef: string,
  requestedMemberId?: string,
): string {
  const records = teamRecords(metadata)
  if (requestedMemberId) {
    const memberId = assertMatOSProjectMemberId(requestedMemberId)
    const matchingMembers = records.filter(candidate => memberRecordId(candidate) === memberId)
    if (matchingMembers.length > 1) {
      throw new Error(`MatOS project member has multiple bindings: ${memberId}`)
    }
    const record = matchingMembers[0]
    const memberRole = record
      ? stringValue(record.roleRef) ?? stringValue(record.role_ref)
      : undefined
    if (records.length > 0 && !record) {
      throw new Error(`MatOS project member not found: ${memberId}`)
    }
    if (record && !memberRole) {
      throw new Error(`MatOS project member '${memberId}' is not bound to an agent role`)
    }
    if (memberRole && roleIdentity(memberRole) !== roleIdentity(roleRef)) {
      throw new Error(`MatOS project member '${memberId}' is not bound to ${roleRef}`)
    }
    return memberId
  }
  const matchingRecords = records.filter(record => {
    const memberRole = stringValue(record.roleRef) ?? stringValue(record.role_ref)
    return memberRole ? roleIdentity(memberRole) === roleIdentity(roleRef) : false
  })
  if (matchingRecords.length > 1) {
    throw new Error(`MatOS project role has multiple member bindings: ${roleIdentity(roleRef)}`)
  }
  const matching = matchingRecords[0]
  if (records.length > 0 && !matching) {
    throw new Error(`MatOS role is not a member of project '${String(metadata.id ?? '')}': ${roleRef}`)
  }
  return memberRecordId(matching ?? {}) ?? fallbackMemberId(roleRef)
}

async function readExplicitSettings(cwd: string, value: string | undefined): Promise<JsonRecord> {
  if (!value) return {}
  const trimmed = value.trim()
  let raw = trimmed
  if (!trimmed.startsWith('{')) {
    raw = await readFile(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed), 'utf8')
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MatOS project access settings must merge with a JSON object')
  }
  return parsed as JsonRecord
}

function takeSettingsArg(args: string[]): { args: string[]; value?: string } {
  const out: string[] = []
  let value: string | undefined
  let seen = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--settings') {
      if (seen) throw new Error('Only one --settings option can be used with MatOS project access')
      const next = args[index + 1]
      if (!next || next.startsWith('--')) {
        throw new Error('--settings requires a JSON object or file path')
      }
      seen = true
      value = next
      index += 1
      continue
    }
    if (arg?.startsWith('--settings=')) {
      if (seen) throw new Error('Only one --settings option can be used with MatOS project access')
      seen = true
      value = arg.slice('--settings='.length)
      if (!value) throw new Error('--settings requires a JSON object or file path')
      continue
    }
    if (arg !== undefined) out.push(arg)
  }
  return { args: out, value }
}

function normalizedFilesystemPath(cwd: string, value: string): string | undefined {
  const trimmed = value.trim().replace(/\/(?:\*\*?|[^/]*\*)+$/u, '')
  if (!trimmed || trimmed.startsWith('~')) return undefined
  if (trimmed.startsWith('//')) return resolve(`/${trimmed.slice(2)}`)
  return resolve(cwd, trimmed)
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  const rel = relative(normalizedRoot, normalizedCandidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function canonicalFilesystemPath(cwd: string, value: string): Promise<string | undefined> {
  const candidate = normalizedFilesystemPath(cwd, value)
  if (!candidate) return undefined
  return realpath(candidate).catch(() => candidate)
}

async function safeExplicitAllowRead(input: {
  cwd: string
  values: string[]
  protectedRoot: string
  allowedRoots: string[]
}): Promise<string[]> {
  const protectedRoot = await canonicalFilesystemPath(input.cwd, input.protectedRoot)
  const allowedRoots = await Promise.all(
    input.allowedRoots.map(root => canonicalFilesystemPath(input.cwd, root)),
  )
  const candidates = await Promise.all(
    input.values.map(value => canonicalFilesystemPath(input.cwd, value)),
  )
  return input.values.filter((_value, index) => {
    const candidate = candidates[index]
    if (!candidate || !protectedRoot) return true
    const overlapsProtectedRoot =
      isPathWithin(protectedRoot, candidate) || isPathWithin(candidate, protectedRoot)
    if (!overlapsProtectedRoot) return true
    return allowedRoots.some(root => Boolean(root) && isPathWithin(root!, candidate))
  })
}

function absolutePermissionPath(path: string): string {
  return `//${resolve(path).replace(/^\/+/, '')}`
}

async function writePolicySettings(cwd: string, memberId: string, settings: JsonRecord): Promise<string> {
  const content = `${JSON.stringify(settings, null, 2)}\n`
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const path = join(cwd, '.matos', 'runtime', 'project-access', `${memberId}-${digest}.json`)
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
  return path
}

export async function materializeMatOSProjectAccessPolicy(input: {
  cwd: string
  roleRef: string
  memberId?: string
  explicitSettings?: JsonRecord
  nestedSandboxAvailable?: boolean
}): Promise<MatOSProjectAccessPolicy | undefined> {
  const binding = await resolveMatOSProjectMemberBinding(input)
  if (!binding) return undefined
  const { metadata, projectCwd, projectId, memberId } = binding
  const privateRoot = join(projectCwd, PROJECT_PRIVATE_RELATIVE_PATH)
  const memberPrivateRoot = join(privateRoot, memberId)
  await mkdir(memberPrivateRoot, { recursive: true, mode: 0o700 })

  const configuredMemberIds = teamRecords(metadata)
    .map(memberRecordId)
    .filter((value): value is string => Boolean(value))
  const onDiskMemberIds = await readdir(privateRoot, { withFileTypes: true })
    .then(entries => entries
      .filter(entry => entry.isDirectory() && validMemberId(entry.name))
      .map(entry => entry.name))
    .catch(() => [])
  const deniedPrivateRoots = unique([...configuredMemberIds, ...onDiskMemberIds])
    .filter(candidate => candidate !== memberId)
    .map(candidate => join(privateRoot, assertMatOSProjectMemberId(candidate)))

  const explicit = input.explicitSettings ?? {}
  const explicitPermissions = objectValue(explicit.permissions)
  const explicitSandbox = objectValue(explicit.sandbox)
  const explicitFilesystem = objectValue(explicitSandbox.filesystem)
  const nestedSandboxAvailable =
    input.nestedSandboxAvailable ??
    process.env.MATOS_NESTED_SANDBOX_AVAILABLE !== '0'
  const matosRoot = join(projectCwd, '.matos')
  const sharedAssetsRoot = join(matosRoot, 'assets')
  const discoveredInternalPaths = await readdir(matosRoot, { withFileTypes: true })
    .then(entries => entries
      .filter(entry => entry.name !== 'assets' && entry.name !== 'private')
      .map(entry => join(matosRoot, entry.name)))
    .catch(() => [])
  const protectedRuntimePaths = unique([
    ...PROJECT_INTERNAL_TOP_LEVEL_NAMES.map(name => join(matosRoot, name)),
    ...discoveredInternalPaths,
    join(matosRoot, 'project-metadata'),
    join(matosRoot, 'project-gitignore'),
  ])
  const denyRules = [...deniedPrivateRoots, ...protectedRuntimePaths].flatMap(path => {
    const absolute = absolutePermissionPath(path)
    return [
      `Read(${absolute})`,
      `Read(${absolute}/**)`,
      `Edit(${absolute})`,
      `Edit(${absolute}/**)`,
      `NotebookEdit(${absolute})`,
      `NotebookEdit(${absolute}/**)`,
    ]
  })
  const explicitAllowRead = await safeExplicitAllowRead({
    cwd: input.cwd,
    values: stringArray(explicitFilesystem.allowRead),
    protectedRoot: matosRoot,
    allowedRoots: [sharedAssetsRoot, memberPrivateRoot],
  })
  const settings: JsonRecord = {
    ...explicit,
    permissions: {
      ...explicitPermissions,
      deny: unique([...stringArray(explicitPermissions.deny), ...denyRules]),
    },
    sandbox: {
      ...explicitSandbox,
      enabled: nestedSandboxAvailable,
      failIfUnavailable: nestedSandboxAvailable,
      allowUnsandboxedCommands: !nestedSandboxAvailable,
      filesystem: {
        ...explicitFilesystem,
        denyRead: unique([...stringArray(explicitFilesystem.denyRead), matosRoot]),
        allowRead: unique([...explicitAllowRead, sharedAssetsRoot, memberPrivateRoot]),
        denyWrite: unique([
          ...stringArray(explicitFilesystem.denyWrite),
          ...deniedPrivateRoots,
          ...protectedRuntimePaths,
        ]),
        allowWrite: unique([...stringArray(explicitFilesystem.allowWrite), memberPrivateRoot]),
      },
    },
  }
  const settingsPath = await writePolicySettings(projectCwd, memberId, settings)
  const memberBriefs = objectValue(metadata.memberBriefs)
  const memberBrief =
    stringValue(memberBriefs[input.roleRef]) ??
    stringValue(memberBriefs[roleIdentity(input.roleRef)])
  return {
    projectCwd,
    projectId,
    memberId,
    roleRef: input.roleRef,
    matosRoot,
    sharedAssetsRoot,
    privateRoot,
    memberPrivateRoot,
    deniedPrivateRoots,
    protectedRuntimePaths,
    settingsPath,
    ...(stringValue(metadata.goal) ? { goal: stringValue(metadata.goal) } : {}),
    ...(memberBrief ? { memberBrief } : {}),
  }
}

export function renderMatOSProjectAccessPrompt(policy: MatOSProjectAccessPolicy): string {
  return [
    '## MatOS project workspace',
    `This run is member ${policy.memberId} (${policy.roleRef}) inside project ${policy.projectId}.`,
    `The project root ${policy.projectCwd} is shared with all project agents. Shared files are discoverable on demand; do not preload or quote the whole tree into context.`,
    `Your persistent private workspace is ${policy.memberPrivateRoot}. Other agents cannot list, read, or write it. Keep scratch notes and private intermediate state there, but publish collaboration inputs and final deliverables into the shared project root or artifacts/.`,
    policy.goal ? `Project goal: ${policy.goal}` : '',
    policy.memberBrief ? `Your responsibility: ${policy.memberBrief}` : '',
  ].filter(Boolean).join('\n')
}

export async function applyMatOSProjectAccessPolicyArgs(input: {
  cwd: string
  roleRef: string
  args: string[]
  memberId?: string
}): Promise<{ args: string[]; policy?: MatOSProjectAccessPolicy }> {
  const extracted = takeSettingsArg(input.args)
  const explicitSettings = await readExplicitSettings(input.cwd, extracted.value)
  const policy = await materializeMatOSProjectAccessPolicy({
    cwd: input.cwd,
    roleRef: input.roleRef,
    memberId: input.memberId,
    explicitSettings,
  })
  if (!policy) return { args: input.args }
  return {
    args: ['--settings', policy.settingsPath, ...extracted.args],
    policy,
  }
}

export function isMatOSProjectFolder(cwd: string): Promise<boolean> {
  return readFile(matOSProjectMetadataPath(cwd), 'utf8').then(() => true, () => false)
}
