import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { parseMatOSAssetReference } from '../assets/refs.js'
import { buildMatOSAssetRegistry, type MatOSAssetRegistry } from '../assets/registry.js'
import type {
  MatOSAsset,
  MatOSAssetManifest,
  MatOSAssetMountGroup,
} from '../assets/types.js'
import { runMatOSAssetTypeListCommand } from './assets.js'

type RolesIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

type ParsedRoleArgs = {
  positionals: string[]
  json: boolean
  model?: string
  effort?: string
  permissionMode?: string
  maxTurns?: number
  error?: string
}

type RoleDelegationEdge = {
  from: string
  to: string
  reference: string
}

const NATIVE_MANIFEST_NAMES = new Set(['asset.json', 'matos.asset.json'])

function writeJson(io: RolesIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

function parseArgs(args: string[]): ParsedRoleArgs {
  const parsed: ParsedRoleArgs = { positionals: [], json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--model') {
      parsed.model = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length)
    } else if (arg === '--effort') {
      parsed.effort = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--effort=')) {
      parsed.effort = arg.slice('--effort='.length)
    } else if (arg === '--permission-mode') {
      parsed.permissionMode = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--permission-mode=')) {
      parsed.permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--max-turns') {
      const parsedMaxTurns = Number(args[index + 1])
      // 0 is the explicit "clear the override" sentinel (see updateRoleRuntime).
      if (!Number.isInteger(parsedMaxTurns) || parsedMaxTurns < 0) {
        parsed.error = '--max-turns must be a non-negative integer (0 clears the override)'
      } else {
        parsed.maxTurns = parsedMaxTurns
      }
      index += 1
    } else if (arg?.startsWith('--max-turns=')) {
      const parsedMaxTurns = Number(arg.slice('--max-turns='.length))
      if (!Number.isInteger(parsedMaxTurns) || parsedMaxTurns < 0) {
        parsed.error = '--max-turns must be a non-negative integer (0 clears the override)'
      } else {
        parsed.maxTurns = parsedMaxTurns
      }
    } else if (arg) {
      parsed.positionals.push(arg)
    }
  }
  return parsed
}

function normalizeRoleReference(reference: string | undefined): string {
  const raw = (reference ?? '').trim()
  return raw.includes(':') ? raw : `role:${raw}`
}

function assertRole(
  registry: MatOSAssetRegistry,
  reference: string | undefined,
): MatOSAsset {
  const normalized = normalizeRoleReference(reference)
  const role = registry.resolve(normalized)
  if (!role || role.type !== 'role') {
    throw new Error(`MatOS role asset not found: ${normalized}`)
  }
  return role
}

function assertAsset(
  registry: MatOSAssetRegistry,
  reference: string | undefined,
): MatOSAsset {
  const raw = (reference ?? '').trim()
  if (!raw) {
    throw new Error('MatOS asset reference is required')
  }
  const asset = registry.resolve(raw)
  if (!asset) {
    throw new Error(`MatOS asset not found: ${raw}`)
  }
  return asset
}

function writableRoleManifestPath(role: MatOSAsset): string {
  if (!NATIVE_MANIFEST_NAMES.has(basename(role.manifestPath))) {
    throw new Error(
      `Role delegation can only edit native role manifests: ${role.canonicalKey}`,
    )
  }
  return role.manifestPath
}

async function readRoleManifest(role: MatOSAsset): Promise<MatOSAssetManifest> {
  return JSON.parse(
    await readFile(writableRoleManifestPath(role), 'utf8'),
  ) as MatOSAssetManifest
}

async function writeRoleManifest(
  role: MatOSAsset,
  manifest: MatOSAssetManifest,
): Promise<void> {
  await writeFile(
    writableRoleManifestPath(role),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function pushUnique(values: string[], value: string): boolean {
  if (values.includes(value)) {
    return false
  }
  values.push(value)
  return true
}

function removeEmptyMountGroups(
  mounts: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const [key, value] of Object.entries(mounts)) {
    if (Array.isArray(value) && value.length === 0) {
      delete mounts[key]
    }
  }
  return Object.keys(mounts).length > 0 ? mounts : undefined
}

function roleDelegationReference(
  inputReference: string | undefined,
  target: MatOSAsset,
): string {
  const parsed = parseMatOSAssetReference(normalizeRoleReference(inputReference))
  return parsed.version ? target.canonicalKey : `role:${target.id}`
}

function roleCapabilityReference(
  inputReference: string | undefined,
  target: MatOSAsset,
): string {
  const raw = (inputReference ?? '').trim()
  const parsed = parseMatOSAssetReference(raw)
  return parsed.version ? target.canonicalKey : `${target.type}:${target.id}`
}

function mountGroupForAsset(asset: MatOSAsset): MatOSAssetMountGroup | undefined {
  if (asset.type === 'knowledge') return 'knowledge'
  if (asset.type === 'data') return 'data'
  if (asset.type === 'skill') return 'skills'
  if (asset.type === 'tool') return 'tools'
  if (asset.type === 'mcp') return 'mcp'
  if (asset.type === 'plugin') return 'plugins'
  if (asset.type === 'workflow') return 'workflows'
  if (asset.type === 'role') return 'roles'
  return undefined
}

function delegationEdgesForRole(
  registry: MatOSAssetRegistry,
  role: MatOSAsset,
): RoleDelegationEdge[] {
  return (role.mounts.roles ?? [])
    .map(reference => {
      const target = registry.resolve(reference)
      if (!target || target.type !== 'role') {
        return undefined
      }
      return {
        from: role.canonicalKey,
        to: target.canonicalKey,
        reference,
      }
    })
    .filter((edge): edge is RoleDelegationEdge => Boolean(edge))
    .sort((left, right) => left.to.localeCompare(right.to))
}

async function loadRegistry(cwd: string): Promise<MatOSAssetRegistry> {
  return buildMatOSAssetRegistry(await loadMatOSAssets(cwd), {
    includeDisabled: true,
  })
}

async function listDelegations(
  io: RolesIO,
  roleReference: string | undefined,
  json: boolean,
): Promise<number> {
  const registry = await loadRegistry(io.cwd)
  const roles = roleReference
    ? [assertRole(registry, roleReference)]
    : registry.assets.filter(asset => asset.type === 'role')
  const delegations = roles.flatMap(role => delegationEdgesForRole(registry, role))

  if (json) {
    writeJson(io, { delegations })
    return 0
  }
  if (delegations.length === 0) {
    io.stdout('No MatOS role delegations found\n')
    return 0
  }
  for (const edge of delegations) {
    io.stdout(`${edge.from} -> ${edge.to} (${edge.reference})\n`)
  }
  return 0
}

async function addDelegation(
  io: RolesIO,
  fromReference: string | undefined,
  toReference: string | undefined,
  json: boolean,
): Promise<number> {
  const registry = await loadRegistry(io.cwd)
  const from = assertRole(registry, fromReference)
  const to = assertRole(registry, toReference)
  const reference = roleDelegationReference(toReference, to)
  const manifest = await readRoleManifest(from)
  const dependencies = stringArray(manifest.dependencies)
  const mounts = objectValue(manifest.mounts)
  const roles = stringArray(mounts.roles)
  const dependenciesChanged = pushUnique(dependencies, reference)
  const rolesChanged = pushUnique(roles, reference)
  const changed = dependenciesChanged || rolesChanged

  manifest.dependencies = dependencies
  manifest.mounts = {
    ...mounts,
    roles,
  }
  await writeRoleManifest(from, manifest)

  const edge = { from: from.canonicalKey, to: to.canonicalKey, reference }
  if (json) {
    writeJson(io, { changed, edge })
  } else {
    io.stdout(`${changed ? 'added' : 'already present'} ${edge.from} -> ${edge.to}\n`)
  }
  return 0
}

type RoleAttachmentResult = {
  role: string
  asset: string
  reference: string
  mountGroup: MatOSAssetMountGroup
  changed: boolean
}

async function attachRoleCapability(
  io: RolesIO,
  roleReference: string | undefined,
  assetReference: string | undefined,
  json: boolean,
): Promise<number> {
  const registry = await loadRegistry(io.cwd)
  const role = assertRole(registry, roleReference)
  const asset = assertAsset(registry, assetReference)
  if (asset.canonicalKey === role.canonicalKey) {
    throw new Error(`Cannot attach a role to itself: ${role.canonicalKey}`)
  }
  const mountGroup = mountGroupForAsset(asset)
  if (!mountGroup) {
    throw new Error(
      `Asset type cannot be attached to a role capability slot: ${asset.type}`,
    )
  }

  const reference =
    asset.type === 'role'
      ? roleDelegationReference(assetReference, asset)
      : roleCapabilityReference(assetReference, asset)
  const manifest = await readRoleManifest(role)
  const dependencies = stringArray(manifest.dependencies)
  const mounts = objectValue(manifest.mounts)
  const mountRefs = stringArray(mounts[mountGroup])
  const dependenciesChanged = pushUnique(dependencies, reference)
  const mountsChanged = pushUnique(mountRefs, reference)
  const changed = dependenciesChanged || mountsChanged

  manifest.dependencies = dependencies
  manifest.mounts = {
    ...mounts,
    [mountGroup]: mountRefs,
  }
  await writeRoleManifest(role, manifest)

  const result: RoleAttachmentResult = {
    role: role.canonicalKey,
    asset: asset.canonicalKey,
    reference,
    mountGroup,
    changed,
  }
  if (json) {
    writeJson(io, result)
  } else {
    io.stdout(
      `${changed ? 'attached' : 'already present'} ${result.reference} to ${result.role} (${result.mountGroup})\n`,
    )
  }
  return 0
}

async function detachRoleCapability(
  io: RolesIO,
  roleReference: string | undefined,
  assetReference: string | undefined,
  json: boolean,
): Promise<number> {
  const registry = await loadRegistry(io.cwd)
  const role = assertRole(registry, roleReference)
  const asset = assertAsset(registry, assetReference)
  const mountGroup = mountGroupForAsset(asset)
  if (!mountGroup) {
    throw new Error(
      `Asset type cannot be detached from a role capability slot: ${asset.type}`,
    )
  }

  const manifest = await readRoleManifest(role)
  const dependencies = stringArray(manifest.dependencies)
  const mounts = objectValue(manifest.mounts)
  const mountRefs = stringArray(mounts[mountGroup])
  const nextDependencies = dependencies.filter(
    reference => !isSameAssetReference(registry, reference, asset),
  )
  const nextMountRefs = mountRefs.filter(
    reference => !isSameAssetReference(registry, reference, asset),
  )
  const changed =
    nextDependencies.length !== dependencies.length ||
    nextMountRefs.length !== mountRefs.length

  manifest.dependencies = nextDependencies
  const nextMounts = removeEmptyMountGroups({
    ...mounts,
    [mountGroup]: nextMountRefs,
  })
  if (nextMounts) {
    manifest.mounts = nextMounts
  } else {
    delete manifest.mounts
  }
  await writeRoleManifest(role, manifest)

  const result: RoleAttachmentResult = {
    role: role.canonicalKey,
    asset: asset.canonicalKey,
    reference: roleCapabilityReference(assetReference, asset),
    mountGroup,
    changed,
  }
  if (json) {
    writeJson(io, result)
  } else {
    io.stdout(
      `${changed ? 'detached' : 'not present'} ${result.reference} from ${result.role} (${result.mountGroup})\n`,
    )
  }
  return 0
}

function isSameAssetReference(
  registry: MatOSAssetRegistry,
  reference: string,
  target: MatOSAsset,
): boolean {
  const resolved = registry.resolve(reference)
  return resolved?.canonicalKey === target.canonicalKey
}

function hasRuntimePatch(parsed: ParsedRoleArgs): boolean {
  return (
    parsed.model !== undefined ||
    parsed.effort !== undefined ||
    parsed.permissionMode !== undefined ||
    parsed.maxTurns !== undefined
  )
}

async function updateRoleRuntime(
  io: RolesIO,
  roleReference: string | undefined,
  parsed: ParsedRoleArgs,
): Promise<number> {
  if (!hasRuntimePatch(parsed)) {
    io.stderr(
      'Usage: matos roles runtime set <role-ref> [--model <model>] [--effort <effort>] [--permission-mode <mode>] [--max-turns <n>] [--json]\n',
    )
    return 1
  }
  const registry = await loadRegistry(io.cwd)
  const role = assertRole(registry, roleReference)
  const manifest = await readRoleManifest(role)
  const runtime = objectValue(manifest.runtime)
  const before = { ...runtime }

  // Empty-string (and --max-turns 0) clear the override back to the
  // deployment/env default instead of persisting a falsy literal that the
  // runtime composition would otherwise project into the agent graph.
  if (parsed.model !== undefined) {
    if (parsed.model.trim() === '') delete runtime.model
    else runtime.model = parsed.model
  }
  if (parsed.effort !== undefined) {
    if (parsed.effort.trim() === '') delete runtime.effort
    else runtime.effort = parsed.effort
  }
  if (parsed.permissionMode !== undefined) {
    if (parsed.permissionMode.trim() === '') delete runtime.permissionMode
    else runtime.permissionMode = parsed.permissionMode
  }
  if (parsed.maxTurns !== undefined) {
    if (parsed.maxTurns === 0) delete runtime.maxTurns
    else runtime.maxTurns = parsed.maxTurns
  }

  if (Object.keys(runtime).length > 0) {
    manifest.runtime = runtime
  } else {
    delete manifest.runtime
  }
  await writeRoleManifest(role, manifest)
  const changed = JSON.stringify(before) !== JSON.stringify(runtime)

  if (parsed.json) {
    writeJson(io, {
      changed,
      role: role.canonicalKey,
      runtime,
    })
  } else {
    io.stdout(`${changed ? 'updated' : 'unchanged'} runtime for ${role.canonicalKey}\n`)
  }
  return 0
}

async function removeDelegation(
  io: RolesIO,
  fromReference: string | undefined,
  toReference: string | undefined,
  json: boolean,
): Promise<number> {
  const registry = await loadRegistry(io.cwd)
  const from = assertRole(registry, fromReference)
  const to = assertRole(registry, toReference)
  const manifest = await readRoleManifest(from)
  const dependencies = stringArray(manifest.dependencies)
  const mounts = objectValue(manifest.mounts)
  const roles = stringArray(mounts.roles)
  const nextDependencies = dependencies.filter(
    reference => !isSameAssetReference(registry, reference, to),
  )
  const nextRoles = roles.filter(
    reference => !isSameAssetReference(registry, reference, to),
  )
  const changed =
    nextDependencies.length !== dependencies.length ||
    nextRoles.length !== roles.length

  manifest.dependencies = nextDependencies
  const nextMounts = removeEmptyMountGroups({
    ...mounts,
    roles: nextRoles,
  })
  if (nextMounts) {
    manifest.mounts = nextMounts
  } else {
    delete manifest.mounts
  }
  await writeRoleManifest(from, manifest)

  const edge = {
    from: from.canonicalKey,
    to: to.canonicalKey,
    reference: roleDelegationReference(toReference, to),
  }
  if (json) {
    writeJson(io, { changed, edge })
  } else {
    io.stdout(`${changed ? 'removed' : 'not present'} ${edge.from} -> ${edge.to}\n`)
  }
  return 0
}

async function runDelegateCommand(
  args: string[],
  io: RolesIO,
): Promise<number> {
  const subcommand = args[0] ?? 'list'
  const parsed = parseArgs(args.slice(1))
  try {
    if (subcommand === 'list') {
      return listDelegations(io, parsed.positionals[0], parsed.json)
    }
    if (subcommand === 'add') {
      if (!parsed.positionals[0] || !parsed.positionals[1]) {
        io.stderr('Usage: matos roles delegate add <from-role> <to-role>\n')
        return 1
      }
      return addDelegation(
        io,
        parsed.positionals[0],
        parsed.positionals[1],
        parsed.json,
      )
    }
    if (subcommand === 'remove' || subcommand === 'rm') {
      if (!parsed.positionals[0] || !parsed.positionals[1]) {
        io.stderr('Usage: matos roles delegate remove <from-role> <to-role>\n')
        return 1
      }
      return removeDelegation(
        io,
        parsed.positionals[0],
        parsed.positionals[1],
        parsed.json,
      )
    }
    io.stderr(`Unknown matos roles delegate command: ${subcommand}\n`)
    return 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function runMatOSRolesCommand(
  args: string[],
  io: RolesIO,
): Promise<number> {
  const command = args[0] ?? 'list'
  if (command === 'list') {
    return runMatOSAssetTypeListCommand('role', io, args.slice(1))
  }
  if (command === 'attach') {
    const parsed = parseArgs(args.slice(1))
    if (parsed.error) {
      io.stderr(`${parsed.error}\n`)
      return 1
    }
    if (!parsed.positionals[0] || !parsed.positionals[1]) {
      io.stderr('Usage: matos roles attach <role-ref> <asset-ref> [--json]\n')
      return 1
    }
    try {
      return attachRoleCapability(
        io,
        parsed.positionals[0],
        parsed.positionals[1],
        parsed.json,
      )
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (command === 'detach') {
    const parsed = parseArgs(args.slice(1))
    if (parsed.error) {
      io.stderr(`${parsed.error}\n`)
      return 1
    }
    if (!parsed.positionals[0] || !parsed.positionals[1]) {
      io.stderr('Usage: matos roles detach <role-ref> <asset-ref> [--json]\n')
      return 1
    }
    try {
      return detachRoleCapability(
        io,
        parsed.positionals[0],
        parsed.positionals[1],
        parsed.json,
      )
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (command === 'runtime') {
    const subcommand = args[1] ?? 'show'
    const parsed = parseArgs(args.slice(2))
    if (parsed.error) {
      io.stderr(`${parsed.error}\n`)
      return 1
    }
    if (subcommand === 'set' || subcommand === 'update') {
      return updateRoleRuntime(io, parsed.positionals[0], parsed)
    }
    io.stderr(`Unknown matos roles runtime command: ${subcommand}\n`)
    return 1
  }
  if (command === 'delegate') {
    return runDelegateCommand(args.slice(1), io)
  }
  io.stderr(`Unknown matos roles command: ${command}\n`)
  return 1
}
