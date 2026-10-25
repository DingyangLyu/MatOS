import type { MatOSAsset } from '../assets/types.js'

export type MatOSWorkflowReadinessStatus =
  | 'verified'
  | 'beta'
  | 'experimental'
  | 'planning'
  | 'component'

export type MatOSWorkflowReadiness = {
  status: MatOSWorkflowReadinessStatus
  userFacing: boolean
  label: string
  reason?: string
  evidence?: string[]
}

const READINESS_STATUSES = new Set<string>([
  'verified',
  'beta',
  'experimental',
  'planning',
  'component',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value
    .map(item => optionalString(item))
    .filter((item): item is string => Boolean(item))
  return items.length ? items : undefined
}

function workflowRuntime(asset: MatOSAsset): Record<string, unknown> {
  return isRecord(asset.runtime.workflow) ? asset.runtime.workflow : {}
}

export function workflowRuntimeEngine(asset: MatOSAsset): string {
  return optionalString(workflowRuntime(asset).engine) ?? 'cmatos-native-workflow'
}

export function workflowRuntimeKind(asset: MatOSAsset): string {
  const kind = optionalString(workflowRuntime(asset).kind)
  return kind === 'component' || kind === 'template' ? kind : 'executable'
}

function workflowReadinessRecord(
  asset: MatOSAsset,
): Record<string, unknown> | undefined {
  const direct = asset.metadata.workflowReadiness
  if (isRecord(direct)) {
    return direct
  }
  const legacy = asset.metadata.readiness
  return isRecord(legacy) ? legacy : undefined
}

function defaultStatusFor(asset: MatOSAsset): MatOSWorkflowReadinessStatus {
  const kind = workflowRuntimeKind(asset)
  if (kind === 'component' || kind === 'template') {
    return 'component'
  }
  return 'experimental'
}

function labelFor(status: MatOSWorkflowReadinessStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified'
    case 'beta':
      return 'Beta'
    case 'planning':
      return 'Planning only'
    case 'component':
      return 'Component'
    case 'experimental':
    default:
      return 'Experimental'
  }
}

export function workflowReadinessForAsset(
  asset: MatOSAsset,
): MatOSWorkflowReadiness {
  const declared = workflowReadinessRecord(asset)
  const declaredStatus = optionalString(declared?.status)?.toLowerCase()
  const status = (
    declaredStatus && READINESS_STATUSES.has(declaredStatus)
      ? declaredStatus
      : defaultStatusFor(asset)
  ) as MatOSWorkflowReadinessStatus
  const userFacing =
    typeof declared?.userFacing === 'boolean'
      ? declared.userFacing
      : status === 'verified' || status === 'beta'

  return {
    status,
    userFacing,
    label: optionalString(declared?.label) ?? labelFor(status),
    ...(optionalString(declared?.reason)
      ? { reason: optionalString(declared?.reason) }
      : {}),
    ...(stringArray(declared?.evidence)
      ? { evidence: stringArray(declared?.evidence) }
      : {}),
  }
}

export function workflowHiddenFromDefaultWorkbench(asset: MatOSAsset): boolean {
  if (asset.type !== 'workflow') {
    return false
  }
  const declared = workflowReadinessRecord(asset)
  return declared?.userFacing === false
}
