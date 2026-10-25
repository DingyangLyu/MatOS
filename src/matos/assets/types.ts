export const MATOS_ASSET_TYPES = [
  'data',
  'knowledge',
  'tool',
  'skill',
  'role',
  'workflow',
  'benchmark',
  'benchmark-suite',
  'evaluation',
  'evolution-proposal',
  'experience',
  'plugin',
  'mcp',
  'runtime',
] as const

export type MatOSAssetType = (typeof MATOS_ASSET_TYPES)[number]

export const MATOS_ASSET_MOUNT_GROUPS = [
  'knowledge',
  'data',
  'skills',
  'tools',
  'mcp',
  'plugins',
  'workflows',
  'roles',
] as const

export type MatOSAssetMountGroup = (typeof MATOS_ASSET_MOUNT_GROUPS)[number]

export type MatOSAssetMounts = Partial<
  Record<MatOSAssetMountGroup, string[]>
>

export type MatOSAssetManifest = {
  schemaVersion?: unknown
  id?: unknown
  type?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  path?: unknown
  entry?: unknown
  tags?: unknown
  permissions?: unknown
  dependencies?: unknown
  mounts?: unknown
  runtime?: unknown
  lifecycle?: unknown
  overlayOf?: unknown
  metadata?: unknown
}

export type MatOSAssetLifecycleStatus =
  | 'enabled'
  | 'disabled'
  | 'deprecated'
  | 'draft'

export type MatOSAssetLifecycle = {
  status: MatOSAssetLifecycleStatus
  reason?: string
  updatedAt?: string
  origin?: string
}

export type MatOSAsset = {
  id: string
  type: string
  name: string
  version: string | undefined
  description: string | undefined
  canonicalKey: string
  relativePath: string
  absolutePath: string
  entryRelativePath: string | undefined
  entryAbsolutePath: string | undefined
  manifestPath: string
  manifestDir: string
  source: 'project' | 'pack' | 'mount'
  sourcePath: string
  packId: string | undefined
  packName: string | undefined
  packVersion: string | undefined
  tags: string[]
  permissions: string[] | Record<string, unknown>
  dependencies: string[]
  mounts: MatOSAssetMounts
  runtime: Record<string, unknown>
  lifecycle: MatOSAssetLifecycle
  metadata: Record<string, unknown>
}

export type MatOSAssetValidationError = {
  code:
    | 'duplicate_id'
    | 'duplicate_asset'
    | 'invalid_manifest'
    | 'invalid_type'
    | 'invalid_reference'
    | 'missing_field'
    | 'missing_path'
    | 'missing_entry'
    | 'missing_dependency'
    | 'missing_mount'
    | 'cyclic_dependency'
  assetId?: string
  assetKey?: string
  manifestPath: string
  message: string
}

export type MatOSAssetValidationResult = {
  ok: boolean
  errors: MatOSAssetValidationError[]
}

export function isSupportedMatOSAssetType(type: string): type is MatOSAssetType {
  return (MATOS_ASSET_TYPES as readonly string[]).includes(type)
}
