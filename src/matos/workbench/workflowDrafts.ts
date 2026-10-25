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

import {
createMatOSAssetHistorySnapshot,
restoreMatOSAssetHistorySnapshot,
withMatOSAssetHistoryLock,
} from '../assets/history/index.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { loadWorkflowAsset } from '../workflows/loadWorkflow.js'
import type {
MatOSWorkflowDefinition,
MatOSWorkflowNode
} from '../workflows/types.js'
import { validateWorkflowDefinition } from '../workflows/validateWorkflow.js'
import { compileMatOSWorkflowDefinition } from '../workflows/workflowCompile.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchWorkflowDraftApplyResult,
MatOSWorkbenchWorkflowDraftIssue,
MatOSWorkbenchWorkflowDraftPreview
} from './types.js'
import { previewMatOSWorkbenchWriteTransaction } from './writeTransactions.js'

import {
firstString,
isRecord,
recordAt,
} from './workbenchValues.js'
import { buildWorkflowDraftDiff } from './workflowDraftDiff.js'
import { workflowDefinitionToDraftSchema } from './workflowDraftProjection.js'
import { definitionFromCozeCanvas } from './workflowDraftSchema.js'
import {
assertProjectWorkflowWriteTarget,
cloneWorkflowDefinition,
nodeMatchesWorkflowToolAsset,
resolveWorkflowAsset,
showWorkflowView,
snapshotSummary,
uniqueStrings,
validateWorkflowDraftCurrentDefinition,
workflowToolAssetRefFromRequest,
workflowToolNodeDependsOn,
workflowToolNodeIdFromRequest,
workspaceRelative,
writeWorkflowDraftDefinition,
} from './workflowDraftWrite.js'

const WORKFLOW_TOOL_NODE_ASSET_TYPES = new Set(['tool', 'plugin', 'mcp', 'skill'])

async function buildWorkflowToolAttachmentDraft(input: MatOSWorkbenchContext & {
  ref: string
  operation: 'attach' | 'detach'
  assetRef?: string
  mutation?: string
  request?: unknown
}): Promise<MatOSWorkbenchWorkflowDraftPreview> {
  const request = isRecord(input.request) ? input.request : {}
  const assetRef = input.assetRef ?? workflowToolAssetRefFromRequest(request)
  if (!assetRef) {
    throw new Error('Workflow tool-node draft requires assetRef/toolRef in the request.')
  }

  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const loaded = await loadWorkflowAsset(registry, input.ref)
  const asset = registry.resolve(assetRef)
  if (!asset || !WORKFLOW_TOOL_NODE_ASSET_TYPES.has(asset.type)) {
    throw new Error(`MatOS callable asset not found for workflow tool-node draft: ${assetRef}`)
  }

  const definition = cloneWorkflowDefinition(loaded.definition)
  definition.parameters = definition.parameters ?? {}
  definition.outputs = definition.outputs ?? {}
  definition.nodes = definition.nodes.map(node => ({
    ...node,
    dependsOn: Array.isArray(node.dependsOn) ? [...node.dependsOn] : [],
  }))
  definition.edges = [...(definition.edges ?? [])]

  const nodeId = workflowToolNodeIdFromRequest(request, asset)
  const explicitNode = Boolean(firstString(request.nodeId, request.node_id, request.node, request.targetNodeId, request.target_node_id))
  const matchingIndexes = definition.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => (explicitNode ? node.id === nodeId : node.id === nodeId || nodeMatchesWorkflowToolAsset(node, asset)))
    .map(item => item.index)
  const issues: MatOSWorkbenchWorkflowDraftIssue[] = []

  if (input.operation === 'attach') {
    const existing = definition.nodes.find(node => node.id === nodeId)
    if (existing && !nodeMatchesWorkflowToolAsset(existing, asset)) {
      issues.push({
        severity: 'error',
        code: 'workflow_tool_node_id_conflict',
        message: `Workflow node "${nodeId}" already exists and is not attached to ${asset.canonicalKey}.`,
        nodeId,
        path: `nodes.${nodeId}`,
      })
    } else {
      const dependsOn = workflowToolNodeDependsOn(request)
      const description = firstString(
        request.label,
        request.name,
        request.description,
        `Run ${asset.name || asset.id}`,
      )
      const node: MatOSWorkflowNode = {
        ...(existing ?? {}),
        id: nodeId,
        type: 'backend',
        dependsOn: uniqueStrings([
          ...((existing?.dependsOn as string[] | undefined) ?? []),
          ...dependsOn,
        ]),
        ...(description ? { description } : {}),
        backend: firstString(request.backend, request.adapter) ?? 'matos-tool',
        tool: asset.canonicalKey,
        assetRef: asset.canonicalKey,
        assetType: asset.type,
        ...(firstString(request.api, request.apiId, request.api_id) ? {
          api: firstString(request.api, request.apiId, request.api_id),
        } : {}),
        ...(isRecord(request.parameters) ? { parameters: request.parameters } : {}),
        policy: {
          ...((isRecord(existing?.policy) ? existing?.policy : {}) as Record<string, unknown>),
          ...((isRecord(request.policy) ? request.policy : {}) as Record<string, unknown>),
          risk: firstString(recordAt(request, 'policy')?.risk, request.risk) ?? existing?.policy?.risk ?? 'medium',
        },
      }
      if (existing) {
        definition.nodes = definition.nodes.map(item => (item.id === nodeId ? node : item))
      } else {
        definition.nodes.push(node)
      }
    }
  } else {
    const removeIds = new Set<string>()
    for (const index of matchingIndexes) {
      const node = definition.nodes[index]
      if (node) {
        removeIds.add(node.id)
      }
    }
    if (removeIds.size === 0) {
      issues.push({
        severity: 'warning',
        code: 'workflow_tool_node_not_found',
        message: `No workflow node matched ${asset.canonicalKey}; detach preview is a no-op.`,
        path: `nodes.${nodeId}`,
      })
    }
    definition.nodes = definition.nodes
      .filter(node => !removeIds.has(node.id))
      .map(node => ({
        ...node,
        dependsOn: (node.dependsOn ?? []).filter(dep => !removeIds.has(dep)),
      }))
    definition.edges = definition.edges.filter(edge => !removeIds.has(edge.from) && !removeIds.has(edge.to))
    if (Array.isArray(definition.transitions)) {
      definition.transitions = definition.transitions.filter(edge => !removeIds.has(edge.from) && !removeIds.has(edge.to))
    }
  }

  return previewMatOSWorkbenchWorkflowDefinitionDraft({
    ...input,
    ref: loaded.asset.canonicalKey,
    mutation: input.mutation ?? `${input.operation}-tool`,
    request: {
      ...request,
      workflowRef: loaded.asset.canonicalKey,
      assetRef: asset.canonicalKey,
      operation: input.operation,
      nodeId,
    },
    definition,
    schema: workflowDefinitionToDraftSchema(definition),
    ignoredNodeCount: 0,
    issues,
  })
}

export async function previewMatOSWorkbenchWorkflowToolAttachment(
  input: MatOSWorkbenchContext & {
    ref: string
    operation: 'attach' | 'detach'
    assetRef?: string
    mutation?: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowDraftPreview> {
  return buildWorkflowToolAttachmentDraft(input)
}

function previewMatOSWorkbenchWorkflowDefinitionDraft(
  input: MatOSWorkbenchContext & {
    ref?: string
    mutation?: string
    request?: unknown
    definition: MatOSWorkflowDefinition
    schema: Record<string, unknown>
    ignoredNodeCount: number
    issues?: MatOSWorkbenchWorkflowDraftIssue[]
  },
): MatOSWorkbenchWorkflowDraftPreview {
  const request = isRecord(input.request) ? input.request : {}
  const definition = input.definition
  const issues = [...(input.issues ?? [])]
  const ignoredNodeCount = input.ignoredNodeCount
  if (definition.nodes.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'empty_canvas',
      message: 'No executable MatOS workflow nodes were found in the Coze canvas payload.',
    })
  }
  const validation = validateWorkflowDefinition(definition)
  const compile = compileMatOSWorkflowDefinition(definition, {
    ...(input.ref ? { workflowRef: input.ref } : {}),
  })
  const validationIssues: MatOSWorkbenchWorkflowDraftIssue[] = validation.errors.map(error => ({
    severity: 'error',
    code: error.code,
    message: error.message,
    ...(error.nodeId ? { nodeId: error.nodeId } : {}),
    ...(error.path ? { path: error.path } : {}),
  }))
  const allIssues = [...issues, ...validationIssues]
  const errorCount = allIssues.filter(issue => issue.severity === 'error').length
  const warningCount = allIssues.filter(issue => issue.severity === 'warning').length
  const validationErrorIssues = allIssues.filter(issue => issue.severity === 'error')
  const summary = {
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges?.length ?? 0,
    transitionCount: definition.transitions?.length ?? 0,
    ignoredNodeCount,
    warningCount,
    errorCount,
  }
  const diff = buildWorkflowDraftDiff({ definition, summary, issues: allIssues })
  const transaction = previewMatOSWorkbenchWriteTransaction({
    source: 'coze-workflow-canvas',
    requestedMutation: input.mutation ?? 'preview',
    ...(input.ref ? { targetRef: input.ref } : {}),
    targetType: 'workflow',
    scopeRef: input.scopeRef,
    patch: definition,
    validationOk: validation.ok && errorCount === 0,
    errorCount,
    warningCount,
    validationEvidence: {
      validation,
      issues: allIssues,
      diff,
    },
    deterministicSmoke: {
      ok: compile.ok,
      summary: compile.ok
        ? `Native workflow compile passed for ${summary.nodeCount} executable node(s).`
        : 'Native workflow compile failed; persistent write must remain blocked.',
      evidence: {
        compile,
      },
    },
  })
  return {
    ...(input.ref ? { workflowRef: input.ref } : {}),
    mutation: input.mutation ?? 'preview',
    source: 'coze-canvas',
    mode: 'draft-preview',
    definition,
    diff,
    validation: {
      ok: validation.ok && validationErrorIssues.length === 0,
      errors: validationErrorIssues,
    },
    compile,
    issues: allIssues,
    summary,
    write: {
      enabled: false,
      reason:
        validation.ok && validationErrorIssues.length === 0 && compile.ok
          ? 'Coze workflow canvas mutation preview is ready for an explicit MatOS apply request with the current confirmation fingerprint.'
          : 'Coze workflow canvas mutation apply is blocked until workflow draft validation and compile errors are fixed.',
      nextAction: {
        key: validation.ok ? 'validate' : 'edit',
        label: validation.ok ? 'Validate native workflow' : 'Fix workflow draft',
        enabled: true,
        maturity: 'route-only',
        command: {
          argv: input.ref
            ? ['matos', 'workbench', 'workflows', 'validate', input.ref, '--json']
            : ['matos', 'workbench', 'workflows', 'draft', '--json'],
          command: input.ref
            ? `matos workbench workflows validate ${input.ref} --json`
            : 'matos workbench workflows draft --json',
        },
      },
    },
    transaction,
    raw: {
      schema: input.schema,
      request,
    },
  }
}

export async function previewMatOSWorkbenchWorkflowDraft(
  input: MatOSWorkbenchContext & {
    ref?: string
    mutation?: string
    request?: unknown
    currentDefinition?: MatOSWorkflowDefinition
  },
): Promise<MatOSWorkbenchWorkflowDraftPreview> {
  const request = isRecord(input.request) ? input.request : {}
  const issues: MatOSWorkbenchWorkflowDraftIssue[] = []
  const { definition, schema, ignoredNodeCount } = definitionFromCozeCanvas(
    request,
    issues,
    input.currentDefinition,
  )
  return previewMatOSWorkbenchWorkflowDefinitionDraft({
    ...input,
    request,
    definition,
    schema,
    ignoredNodeCount,
    issues,
  })
}

export async function loadMatOSWorkbenchWorkflowDefinition(
  input: MatOSWorkbenchContext & { ref: string },
): Promise<MatOSWorkflowDefinition | undefined> {
  try {
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
    const loaded = await loadWorkflowAsset(registry, input.ref)
    return loaded.definition
  } catch {
    return undefined
  }
}

async function applyMatOSWorkbenchWorkflowDraftPreview(
  input: MatOSWorkbenchContext & {
    fingerprint: string
    reason?: string
  },
  draft: MatOSWorkbenchWorkflowDraftPreview,
): Promise<MatOSWorkbenchWorkflowDraftApplyResult> {
    const workflowRef = draft.workflowRef
    if (!workflowRef) {
      throw new Error('Workflow draft apply requires a resolved MatOS workflow ref.')
    }
    if (!draft.validation.ok || !draft.compile.ok) {
      throw new Error('Workflow draft apply is blocked because draft validation or compile failed.')
    }
    if (draft.summary.nodeCount <= 0) {
      throw new Error('Workflow draft apply is blocked because the Coze canvas has no executable workflow nodes.')
    }
    if (input.fingerprint !== draft.transaction.confirmationFingerprint) {
      throw new Error(
        'Workflow draft apply confirmation fingerprint does not match the current MatOS draft transaction.',
      )
    }

    const before = await showWorkflowView({ ...input, ref: workflowRef }).catch(() => undefined)
    const asset = await resolveWorkflowAsset({ ...input, ref: workflowRef })
    assertProjectWorkflowWriteTarget(input.cwd, asset)
    if (!asset.entryAbsolutePath) {
      throw new Error(`Workflow ${asset.canonicalKey} has no entry file for canvas edits.`)
    }
    const touchedPaths = [workspaceRelative(input.cwd, asset.entryAbsolutePath)]
    const beforeSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      message: `workbench workflow draft before ${workflowRef}`,
      paths: touchedPaths,
      assetRefs: [workflowRef],
      provenance: {
        source: 'matos-workbench',
        operation: 'workflows.apply-draft',
        mutation: draft.mutation,
        confirmationFingerprint: draft.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })

    await writeWorkflowDraftDefinition({
      asset,
      definition: draft.definition,
    })

    const afterSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      parentCommit: beforeSnapshot.commit,
      message: `workbench workflow draft after ${workflowRef}`,
      paths: touchedPaths,
      assetRefs: [workflowRef],
      provenance: {
        source: 'matos-workbench',
        operation: 'workflows.apply-draft',
        mutation: draft.mutation,
        beforeSnapshot: beforeSnapshot.snapshotId,
        confirmationFingerprint: draft.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })

    const { validation, compile } = await validateWorkflowDraftCurrentDefinition({
      cwd: input.cwd,
      workflowRef,
    })
    if (!validation.ok) {
      await restoreMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: beforeSnapshot.snapshotId,
        compareSnapshotId: afterSnapshot.snapshotId,
        removeCreatedFiles: true,
      })
      const rollbackSnapshot = await createMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        kind: 'direct-editor-rollback',
        scope: 'project',
        parentCommit: afterSnapshot.commit,
        message: `workbench workflow draft rollback ${workflowRef}`,
        paths: touchedPaths,
        assetRefs: [workflowRef],
        provenance: {
          source: 'matos-workbench',
          operation: 'workflows.apply-draft.rollback',
          beforeSnapshot: beforeSnapshot.snapshotId,
          afterSnapshot: afterSnapshot.snapshotId,
          confirmationFingerprint: draft.transaction.confirmationFingerprint,
          reason: 'post-write validation failed',
        },
      })
      return {
        workflowRef,
        mutation: draft.mutation,
        source: 'coze-canvas',
        mode: 'controlled-write',
        applied: false,
        readonly: false,
        draft,
        transaction: draft.transaction,
        ...(before ? { before } : {}),
        snapshots: {
          before: snapshotSummary(beforeSnapshot),
          after: snapshotSummary(afterSnapshot),
          rollback: snapshotSummary(rollbackSnapshot),
        },
        validation,
        compile,
        write: {
          enabled: true,
          status: 'rolled-back',
          reason: 'Post-write validation failed; MatOS restored the before snapshot.',
        },
        audit: {
          target: 'matos-asset-history',
          operation: 'workflows.apply-draft',
          reason: input.reason,
        },
      }
    }

    const after = await showWorkflowView({ ...input, ref: workflowRef })
    return {
      workflowRef,
      mutation: draft.mutation,
      source: 'coze-canvas',
      mode: 'controlled-write',
      applied: true,
      readonly: false,
      draft,
      transaction: draft.transaction,
      ...(before ? { before } : {}),
      after,
      snapshots: {
        before: snapshotSummary(beforeSnapshot),
        after: snapshotSummary(afterSnapshot),
      },
      validation,
      compile,
      write: {
        enabled: true,
        status: 'applied',
      },
      audit: {
        target: 'matos-asset-history',
        operation: 'workflows.apply-draft',
        reason: input.reason,
      },
    }
}

export async function applyMatOSWorkbenchWorkflowDraft(
  input: MatOSWorkbenchContext & {
    ref: string
    mutation?: string
    request?: unknown
    fingerprint: string
    reason?: string
  },
): Promise<MatOSWorkbenchWorkflowDraftApplyResult> {
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'workbench-workflows-apply-draft',
  }, async () => {
    const currentDefinition = await loadMatOSWorkbenchWorkflowDefinition(input)
    const draft = await previewMatOSWorkbenchWorkflowDraft({
      ...input,
      mutation: input.mutation ?? 'apply-draft',
      ...(currentDefinition ? { currentDefinition } : {}),
    })
    return applyMatOSWorkbenchWorkflowDraftPreview(input, draft)
  })
}

export async function applyMatOSWorkbenchWorkflowToolAttachment(
  input: MatOSWorkbenchContext & {
    ref: string
    operation: 'attach' | 'detach'
    assetRef?: string
    mutation?: string
    request?: unknown
    fingerprint: string
    reason?: string
  },
): Promise<MatOSWorkbenchWorkflowDraftApplyResult> {
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'workbench-workflows-tool-node',
  }, async () => {
    const draft = await buildWorkflowToolAttachmentDraft({
      ...input,
      mutation: input.mutation ?? `${input.operation}-tool`,
    })
    return applyMatOSWorkbenchWorkflowDraftPreview(input, draft)
  })
}
