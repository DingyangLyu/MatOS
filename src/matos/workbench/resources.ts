import { buildMatOSAssetGraphIndex } from '../assets/graph/buildGraphIndex.js'
import { buildMatOSAssetWorkbenchState } from '../assets/graph/viewModels.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import {
redactInternalAssetPaths,
shouldHideAssetFromUserSurface,
} from '../assets/sourceVisibility.js'
import type { MatOSAsset,MatOSAssetMountGroup } from '../assets/types.js'
import { workflowHiddenFromDefaultWorkbench } from '../workflows/workflowReadiness.js'
import { buildMatOSWorkbenchActionsForAsset } from './actions.js'
import {
listMatOSWorkbenchDynamicResources,
showMatOSWorkbenchDynamicResource,
} from './dynamicResources.js'
import {
applyMatOSWorkbenchRelease,
previewMatOSWorkbenchRelease,
} from './releases.js'
import {
buildMatOSWorkbenchRelatedEvidence
} from './resourceEvidence.js'
import {
applyMatOSWorkbenchRoleDraft,
previewMatOSWorkbenchRoleDraft,
} from './roleDrafts.js'
import { loadMatOSWorkbenchRuntimeAssets } from './runtimeAssetView.js'
import {
listMatOSWorkbenchRuntimeResources,
showMatOSWorkbenchRuntimeResource,
} from './runtimeResources.js'
import type {
MatOSWorkbenchResource,
MatOSWorkbenchResourceActionInvocation,
MatOSWorkbenchResourceList,
MatOSWorkbenchResourceQuery,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType
} from './types.js'

import {
buildMatOSWorkbenchGitGovernance,
buildMatOSWorkbenchResourceDetail,
firstString,
lineageForAsset,
matchesQuery,
matchesResourceTypeFilter,
normalizeResourceType,
objectRecord,
resourceMatchesQuery,
selectedAssetMetadata
} from './resourceViewModels.js'

export function packMatOSWorkbenchResource(
  asset: MatOSAsset,
  input: {
    cwd: string
    scopeRef?: string
    graphIndex?: Awaited<ReturnType<typeof buildMatOSAssetGraphIndex>>
    lightweight?: boolean
  },
): MatOSWorkbenchResource {
  const ref = asset.canonicalKey || `${asset.type}:${asset.id}`
  const gitGovernance = !input.lightweight
    ? buildMatOSWorkbenchGitGovernance(asset)
    : undefined
  const base: MatOSWorkbenchResource = {
    id: asset.id,
    ref,
    type: normalizeResourceType(asset.type),
    name: asset.name,
    ...(asset.description ? { description: asset.description } : {}),
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    lifecycle: asset.lifecycle.status,
    status: asset.lifecycle.status,
    ...(asset.tags.length ? { tags: asset.tags } : {}),
    ...(asset.source ? { source: asset.source } : {}),
    ...(asset.packId ? { packId: asset.packId } : {}),
    ...(asset.version ? { version: asset.version } : {}),
    ...(!input.lightweight && asset.dependencies.length ? { dependencies: asset.dependencies } : {}),
    ...(!input.lightweight && lineageForAsset(asset, input.graphIndex)
      ? { lineage: lineageForAsset(asset, input.graphIndex) }
      : {}),
    ...(!input.lightweight ? { metadata: selectedAssetMetadata(asset) } : {}),
    ...(gitGovernance ? { gitGovernance } : {}),
    actions: input.lightweight ? [] : buildMatOSWorkbenchActionsForAsset(asset),
  }
  return redactMatOSAssetOutput(
    redactInternalAssetPaths(asset, base as unknown as Record<string, unknown>),
    { cwd: input.cwd },
  ) as MatOSWorkbenchResource
}

function countResourcesByType(
  resources: MatOSWorkbenchResource[],
): Record<string, number> {
  const typeCounts: Record<string, number> = {}
  for (const resource of resources) {
    typeCounts[resource.type] = (typeCounts[resource.type] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(typeCounts).sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function matOSWorkbenchAssetSurfaceVisibilityError(
  asset: MatOSAsset,
  input: {
    includeDisabled?: boolean
    includeHidden?: boolean
    ref?: string
  } = {},
): string | undefined {
  const ref = input.ref ?? asset.canonicalKey
  if (!input.includeDisabled && asset.lifecycle.status !== 'enabled') {
    return `MatOS workbench resource is disabled on this surface: ${ref}`
  }
  if (
    !input.includeHidden &&
    (shouldHideAssetFromUserSurface(asset) ||
      workflowHiddenFromDefaultWorkbench(asset))
  ) {
    return `MatOS workbench resource is hidden from this surface: ${ref}`
  }
  return undefined
}

export function assertMatOSWorkbenchAssetSurfaceVisible(
  asset: MatOSAsset,
  input: {
    includeDisabled?: boolean
    includeHidden?: boolean
    ref?: string
  } = {},
): void {
  const error = matOSWorkbenchAssetSurfaceVisibilityError(asset, input)
  if (error) {
    throw new Error(error)
  }
}

export async function listMatOSWorkbenchResources(
  input: MatOSWorkbenchResourceQuery,
): Promise<MatOSWorkbenchResourceList> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  const types = new Set(input.types ?? [])
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const graphIndex = input.includeLineage
    ? await buildMatOSAssetGraphIndex({
        cwd: input.cwd,
        assets,
        options: {
          includeDisabled: input.includeDisabled,
          includeHidden: input.includeHidden,
          includeLineage: true,
        },
      })
    : undefined
  const visible = assets
    .filter(asset => (input.includeDisabled ? true : asset.lifecycle.status === 'enabled'))
    .filter(asset => (input.includeHidden ? true : !shouldHideAssetFromUserSurface(asset)))
    .filter(asset => (input.includeHidden ? true : !workflowHiddenFromDefaultWorkbench(asset)))
    .filter(asset => matchesResourceTypeFilter(asset, types))
    .filter(asset => matchesQuery(asset, input.query))
    .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey))
  const staticResources = visible
    .map(asset => packMatOSWorkbenchResource(asset, {
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      graphIndex,
      lightweight: input.lightweight,
    }))
  const runtime = await listMatOSWorkbenchRuntimeResources({
    ...input,
    limit: 500,
    offset: 0,
  })
  const dynamic = await listMatOSWorkbenchDynamicResources({
    ...input,
    limit: 500,
    offset: 0,
  })
  const matchedStaticResources = staticResources
    .filter(resource => resourceMatchesQuery(resource, input.query))
  const dynamicResources = [...runtime.resources, ...dynamic.resources]
    .filter(resource => resourceMatchesQuery(resource, input.query))
  const allResources = [...matchedStaticResources, ...dynamicResources]
    .sort((left, right) => left.ref.localeCompare(right.ref))
  const resources = allResources.slice(offset, offset + limit)
  const staticTypeCounts = countResourcesByType(matchedStaticResources)
  const dynamicTypeCounts = countResourcesByType(dynamicResources)
  const typeCounts = countResourcesByType(allResources)
  const groupMap = new Map<MatOSWorkbenchResourceType, MatOSWorkbenchResource[]>()
  for (const resource of resources) {
    groupMap.set(resource.type, [...(groupMap.get(resource.type) ?? []), resource])
  }
  return {
    resources,
    groups: [...groupMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, grouped]) => ({
        type,
        count: grouped.length,
        resources: grouped,
      })),
    summary: {
      count: resources.length,
      pageCount: resources.length,
      total: allResources.length,
      assetTotal: matchedStaticResources.length,
      staticTotal: matchedStaticResources.length,
      dynamicTotal: dynamicResources.length,
      offset,
      limit,
      typeCounts,
      staticTypeCounts,
      dynamicTypeCounts,
    },
  }
}

export async function showMatOSWorkbenchResource(
  input: MatOSWorkbenchResourceQuery & {
    ref: string
    includeGraph?: boolean
    includeDebug?: boolean
  },
): Promise<MatOSWorkbenchResourceShow> {
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const registry = buildMatOSAssetRegistry(assets, {
    includeDisabled: true,
  })
  const asset = registry.resolve(input.ref)
  if (!asset) {
    const runtime = await showMatOSWorkbenchRuntimeResource(input)
    if (runtime) {
      return runtime
    }
    const dynamic = await showMatOSWorkbenchDynamicResource(input)
    if (dynamic) {
      return dynamic
    }
    throw new Error(`MatOS workbench resource not found: ${input.ref}`)
  }
  assertMatOSWorkbenchAssetSurfaceVisible(asset, input)
  const graphIndex = input.includeGraph
    ? await buildMatOSAssetGraphIndex({
        cwd: input.cwd,
        assets,
        registry,
        options: {
          includeDisabled: true,
          includeHidden: input.includeHidden,
          includeLineage: true,
        },
      })
    : undefined
  const graph = graphIndex
    ? buildMatOSAssetWorkbenchState({
        index: graphIndex,
        selectedAssetRef: asset.canonicalKey,
        mode: 'lineage',
        depth: 2,
      })
    : undefined
  const resource = packMatOSWorkbenchResource(asset, {
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    graphIndex,
  })
  const relatedEvidence = input.includeGraph
    ? await buildMatOSWorkbenchRelatedEvidence({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        asset,
        resource,
        includeHidden: input.includeHidden,
      })
    : undefined
  return {
    resource,
    detail: buildMatOSWorkbenchResourceDetail({
      asset,
      cwd: input.cwd,
      resource,
      graph,
      graphIndex,
      relatedEvidence,
      includeDebug: input.includeDebug,
    }),
    ...(graph ? { graph } : {}),
  }
}

export async function graphMatOSWorkbenchResource(
  input: MatOSWorkbenchResourceQuery & {
    ref?: string
    mode?: 'explore' | 'lineage' | 'impact' | 'validate' | 'raw'
    direction?: 'dependencies' | 'reverse' | 'all'
  },
): Promise<{ graph: ReturnType<typeof buildMatOSAssetWorkbenchState> }> {
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const registry = buildMatOSAssetRegistry(assets, {
    includeDisabled: input.includeDisabled,
  })
  const index = await buildMatOSAssetGraphIndex({
    cwd: input.cwd,
    assets,
    registry,
    options: {
      includeDisabled: input.includeDisabled,
      includeHidden: input.includeHidden,
      includeLineage: true,
      includeUsage: true,
    },
  })
  const selectedAssetRef = input.ref
    ? registry.resolve(input.ref)?.canonicalKey ?? input.ref
    : undefined
  return {
    graph: buildMatOSAssetWorkbenchState({
      index,
      selectedAssetRef,
      mode: input.mode ?? (input.ref ? 'lineage' : 'explore'),
      query: input.query,
      direction: input.direction,
      types: input.types,
      limit: input.limit,
    }),
  }
}

export async function listMatOSWorkbenchResourceActions(
  input: MatOSWorkbenchResourceQuery & { ref: string },
): Promise<{ ref: string; actions: MatOSWorkbenchResource['actions'] }> {
  const shown = await showMatOSWorkbenchResource(input)
  return {
    ref: shown.resource.ref,
    actions: shown.resource.actions,
  }
}

function mountGroupForAsset(asset: MatOSAsset): MatOSAssetMountGroup | undefined {
  if (asset.type === 'workflow') {
    return 'workflows'
  }
  if (asset.type === 'tool') {
    return 'tools'
  }
  if (asset.type === 'skill') {
    return 'skills'
  }
  if (asset.type === 'plugin') {
    return 'plugins'
  }
  if (asset.type === 'mcp') {
    return 'mcp'
  }
  if (asset.type === 'knowledge') {
    return 'knowledge'
  }
  if (asset.type === 'data') {
    return 'data'
  }
  return undefined
}

function normalizeActionOperation(actionKey: string, request: Record<string, unknown>): 'attach' | 'detach' {
  const requested = firstString(request.operation, request.action, request.mode)
  if (requested === 'detach' || actionKey === 'detach') {
    return 'detach'
  }
  return 'attach'
}

function actionRequest(input: { request?: unknown; fingerprint?: string; reason?: string }): Record<string, unknown> {
  const request = objectRecord(input.request)
  return {
    ...request,
    ...(input.fingerprint ? { confirmationFingerprint: input.fingerprint } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  }
}

async function buildRoleAttachmentActionDraft(
  input: MatOSWorkbenchResourceQuery & {
    ref: string
    actionKey: string
    request?: unknown
  },
): Promise<{
  roleRef?: string
  assetRef?: string
  group?: MatOSAssetMountGroup
  operation: 'attach' | 'detach'
  request: Record<string, unknown>
  errors: Array<{ code: string; message: string }>
}> {
  const request = actionRequest(input)
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const selected = registry.resolve(input.ref)
  const operation = normalizeActionOperation(input.actionKey, request)
  const errors: Array<{ code: string; message: string }> = []
  if (!selected) {
    errors.push({
      code: 'resource_not_found',
      message: `MatOS resource not found: ${input.ref}`,
    })
    return { operation, request, errors }
  }

  const selectedRef = selected.canonicalKey
  const selectedIsRole = selected.type === 'role'
  const roleRef = selectedIsRole
    ? selectedRef
    : firstString(
        request.targetRef,
        request.target_ref,
        request.roleRef,
        request.role_ref,
        request.botId,
        request.bot_id,
      )
  const assetRef = selectedIsRole
    ? firstString(
        request.assetRef,
        request.asset_ref,
        request.resourceRef,
        request.resource_ref,
        request.pluginId,
        request.plugin_id,
        request.workflowId,
        request.workflow_id,
        request.datasetId,
        request.dataset_id,
      )
    : selectedRef
  const role = roleRef ? registry.resolve(roleRef) : undefined
  const asset = assetRef ? registry.resolve(assetRef) : undefined
  if (!roleRef) {
    errors.push({
      code: 'missing_role_ref',
      message: selectedIsRole
        ? 'Attach/detach action on a role requires assetRef.'
        : 'Attach/detach action on an attachable asset requires targetRef or roleRef.',
    })
  } else if (!role || role.type !== 'role') {
    errors.push({
      code: 'invalid_role_ref',
      message: `Attach/detach target is not a MatOS role: ${roleRef}`,
    })
  }
  if (!assetRef) {
    errors.push({
      code: 'missing_asset_ref',
      message: 'Attach/detach action requires an assetRef.',
    })
  } else if (!asset) {
    errors.push({
      code: 'invalid_asset_ref',
      message: `Attach/detach asset is not resolvable: ${assetRef}`,
    })
  }
  const requestedGroup = firstString(request.group, request.mountGroup, request.mount_group)
  const group = (
    requestedGroup === 'knowledge' ||
    requestedGroup === 'data' ||
    requestedGroup === 'skills' ||
    requestedGroup === 'tools' ||
    requestedGroup === 'mcp' ||
    requestedGroup === 'plugins' ||
    requestedGroup === 'workflows' ||
    requestedGroup === 'roles'
      ? requestedGroup
      : asset ? mountGroupForAsset(asset) : undefined
  ) as MatOSAssetMountGroup | undefined
  if (!group) {
    errors.push({
      code: 'unsupported_attachment_type',
      message: asset
        ? `MatOS asset type cannot be attached to roles through this action: ${asset.type}`
        : 'MatOS asset type cannot be attached to roles through this action.',
    })
  }
  if (!role || !asset || !roleRef || !assetRef || !group) {
    return { roleRef, assetRef, group, operation, request, errors }
  }

  const current = role.mounts[group] ?? []
  const next = operation === 'attach'
    ? [...new Set([...current, asset.canonicalKey])]
    : current.filter(ref => {
        const resolved = registry.resolve(ref)
        return ref !== assetRef && resolved?.canonicalKey !== asset.canonicalKey
      })
  return {
    roleRef: role.canonicalKey,
    assetRef: asset.canonicalKey,
    group,
    operation,
    request: {
      ...request,
      mounts: {
        [group]: next,
      },
      matos_attachment_action: {
        operation,
        roleRef: role.canonicalKey,
        assetRef: asset.canonicalKey,
        group,
      },
    },
    errors,
  }
}

function resourceActionMode(
  action: MatOSWorkbenchResource['actions'][number],
): MatOSWorkbenchResourceActionInvocation['mode'] {
  if (action.maturity === 'controlled-mutation') {
    return 'controlled-action-preview'
  }
  if (action.command) {
    return 'route-action-preview'
  }
  return 'read-only-action-preview'
}

function resourceActionReason(
  action: MatOSWorkbenchResource['actions'][number],
  mode: MatOSWorkbenchResourceActionInvocation['mode'],
): string {
  if (action.reason) {
    return action.reason
  }
  if (mode === 'controlled-action-preview') {
    return 'Native controlled mutations require explicit MatOS command execution, permission checks, history, rollback, and audit gates.'
  }
  if (mode === 'route-action-preview') {
    return 'MatOS resolved this action to a native command route. The workbench preview does not execute it automatically.'
  }
  return 'MatOS exposed this read-only action as metadata; there is no executable native route for this action.'
}

function releaseRequest(input: {
  actionKey: string
  request?: unknown
  fingerprint?: string
  reason?: string
}): {
  action: 'publish' | 'rollback'
  fingerprint?: string
  reason?: string
  releaseId?: string
  releaseName?: string
  snapshotRef?: string
} {
  const request = actionRequest(input)
  return {
    action: input.actionKey === 'rollback' ? 'rollback' : 'publish',
    fingerprint: input.fingerprint ?? firstString(
      request.fingerprint,
      request.confirmationFingerprint,
      request.confirmation_fingerprint,
      request.matos_confirmation_fingerprint,
    ),
    reason: input.reason ?? firstString(request.reason, request.matos_reason),
    releaseId: firstString(request.releaseId, request.release_id),
    releaseName: firstString(request.releaseName, request.release_name, request.name),
    snapshotRef: firstString(request.snapshotRef, request.snapshot_ref, request.snapshotId, request.snapshot_id),
  }
}

export async function invokeMatOSWorkbenchResourceAction(
  input: MatOSWorkbenchResourceQuery & {
    ref: string
    actionKey: string
    request?: unknown
    fingerprint?: string
    reason?: string
  },
): Promise<MatOSWorkbenchResourceActionInvocation> {
  const actions = await listMatOSWorkbenchResourceActions({
    ...input,
    includeDisabled: true,
  })
  const selected = actions.actions.find(candidate => candidate.key === input.actionKey)
  if (!selected) {
    throw new Error(`MatOS workbench action not found: ${input.actionKey}`)
  }
  const mode = resourceActionMode(selected)
  const enabled = selected.enabled !== false
  const reason = resourceActionReason(selected, mode)
  const errors = enabled
    ? []
    : [
        {
          code: 'action_disabled',
          message: reason,
        },
      ]

  if ((selected.key === 'publish' || selected.key === 'rollback') && enabled) {
    const release = releaseRequest(input)
    const releasePreview = await previewMatOSWorkbenchRelease({
      ...input,
      ref: actions.ref,
      action: release.action,
      ...(input.includeHidden !== undefined ? { includeHidden: input.includeHidden } : {}),
    })
    if (releasePreview.operatorReview.status === 'blocked') {
      return {
        mode: 'controlled-action-preview',
        ref: actions.ref,
        actionKey: selected.key,
        action: {
          ...selected,
          confirmationFingerprint: releasePreview.releasePacket.confirmationFingerprint,
        },
        invoked: false,
        readonly: true,
        reason: releasePreview.operatorReview.reason,
        ...(selected.command ? { route: selected.command } : {}),
        validation: {
          ok: false,
          errors: [{
            code: 'operator_promotion_blocked',
            message: releasePreview.operatorReview.reason,
          }],
        },
        write: {
          enabled: false,
          status: 'preview',
          reason: releasePreview.operatorReview.reason,
        },
        transaction: releasePreview.transaction,
        releasePreview,
      }
    }
    if (release.fingerprint) {
      const releaseApplyResult = await applyMatOSWorkbenchRelease({
        ...input,
        ref: actions.ref,
        action: release.action,
        fingerprint: release.fingerprint,
        ...(release.reason ? { reason: release.reason } : {}),
        ...(release.releaseId ? { releaseId: release.releaseId } : {}),
        ...(release.releaseName ? { releaseName: release.releaseName } : {}),
        ...(release.snapshotRef ? { snapshotRef: release.snapshotRef } : {}),
        ...(input.includeHidden !== undefined ? { includeHidden: input.includeHidden } : {}),
      })
      return {
        mode: 'controlled-action-preview',
        ref: actions.ref,
        actionKey: selected.key,
        action: selected,
        invoked: true,
        readonly: false,
        reason: `MatOS applied this ${release.action} action through the native release writer.`,
        ...(selected.command ? { route: selected.command } : {}),
        validation: {
          ok: releaseApplyResult.validation?.ok !== false,
          errors: releaseApplyResult.validation?.ok === false
            ? [{ code: 'release_validation_failed', message: 'Release apply validation failed.' }]
            : [],
        },
        write: {
          enabled: true,
          status: releaseApplyResult.write.status,
          reason: releaseApplyResult.write.reason ??
            `Native ${release.action} action applied through asset-history release gates.`,
        },
        transaction: releaseApplyResult.transaction,
        releasePreview: releaseApplyResult.preview,
        releaseApplyResult,
      }
    }
    return {
      mode: 'controlled-action-preview',
      ref: actions.ref,
      actionKey: selected.key,
      action: {
        ...selected,
        confirmationFingerprint: releasePreview.releasePacket.confirmationFingerprint,
      },
      invoked: false,
      readonly: true,
      reason: `MatOS prepared a native ${release.action} release preview for ${actions.ref}.`,
      ...(selected.command ? { route: selected.command } : {}),
      validation: {
        ok: true,
        errors: [],
      },
      write: {
        enabled: false,
        status: 'preview',
        reason: release.action === 'rollback'
          ? 'Re-run this action with a release id and the current confirmation fingerprint to apply rollback.'
          : 'Re-run this action with the current confirmation fingerprint to publish the release.',
      },
      transaction: releasePreview.transaction,
      releasePreview,
    }
  }

  if ((selected.key === 'attach' || selected.key === 'detach') && enabled) {
    const draftInput = await buildRoleAttachmentActionDraft(input)
    if (draftInput.errors.length > 0 || !draftInput.roleRef) {
      return {
        mode: 'controlled-action-preview',
        ref: actions.ref,
        actionKey: selected.key,
        action: selected,
        invoked: false,
        readonly: true,
        reason: draftInput.errors.length
          ? draftInput.errors.map(error => error.message).join(' ')
          : 'Attach/detach requires a resolved MatOS role target.',
        ...(selected.command ? { route: selected.command } : {}),
        validation: {
          ok: false,
          errors: draftInput.errors.length
            ? draftInput.errors
            : [{ code: 'missing_role_ref', message: 'Attach/detach requires a resolved MatOS role target.' }],
        },
        write: {
          enabled: false,
          status: 'preview',
          reason: 'Native role attachment actions require a valid role target and attachable asset before the controlled writer can run.',
        },
      }
    }

    if (input.fingerprint) {
      const appliedRoleDraft = await applyMatOSWorkbenchRoleDraft({
        ...input,
        ref: draftInput.roleRef,
        mutation: `${draftInput.operation}-resource`,
        request: draftInput.request,
        fingerprint: input.fingerprint,
        reason: input.reason,
      })
      return {
        mode: 'controlled-action-preview',
        ref: actions.ref,
        actionKey: selected.key,
        action: selected,
        invoked: true,
        readonly: false,
        reason: `MatOS applied this ${draftInput.operation} action through the native role draft writer.`,
        ...(selected.command ? { route: selected.command } : {}),
        validation: {
          ok: appliedRoleDraft.draft.validation.ok,
          errors: appliedRoleDraft.draft.validation.errors.map(error => ({
            code: error.code,
            message: error.message,
          })),
        },
        write: {
          enabled: true,
          status: appliedRoleDraft.write.status,
          reason: appliedRoleDraft.write.reason ??
            `Native role ${draftInput.operation} action applied through asset-history snapshots and validation gates.`,
        },
        transaction: appliedRoleDraft.transaction,
        draft: appliedRoleDraft.draft,
        appliedRoleDraft,
      }
    }

    const draft = await previewMatOSWorkbenchRoleDraft({
      ...input,
      ref: draftInput.roleRef,
      mutation: `${draftInput.operation}-resource`,
      request: draftInput.request,
    })
    return {
      mode: 'controlled-action-preview',
      ref: actions.ref,
      actionKey: selected.key,
      action: selected,
      invoked: false,
      readonly: true,
      reason: `MatOS prepared a native role ${draftInput.operation} draft for ${draftInput.assetRef ?? 'asset'} -> ${draftInput.roleRef}.`,
      ...(selected.command ? { route: selected.command } : {}),
      validation: {
        ok: draft.validation.ok,
        errors: draft.validation.errors.map(error => ({
          code: error.code,
          message: error.message,
        })),
      },
      write: {
        enabled: false,
        status: 'preview',
        reason: 'Re-run this action with the current confirmation fingerprint to apply the role attachment change.',
      },
      transaction: draft.transaction,
      draft,
    }
  }

  return {
    mode,
    ref: actions.ref,
    actionKey: selected.key,
    action: selected,
    invoked: false,
    readonly: true,
    reason,
    ...(selected.command ? { route: selected.command } : {}),
    validation: {
      ok: enabled,
      errors,
    },
    write: {
      enabled: false,
      reason: mode === 'controlled-action-preview'
        ? 'Controlled resource mutations stay behind native MatOS command execution, permission, history, rollback, and audit gates.'
        : 'Workbench action previews are read-only and do not mutate native MatOS state.',
    },
  }
}
