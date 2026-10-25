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

import { lstat,writeFile } from 'node:fs/promises'
import { relative,resolve,sep } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/types.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import {
loadWorkflowAsset,
workflowAssetNotFoundMessage,
} from '../workflows/loadWorkflow.js'
import type {
MatOSWorkflowDefinition,
MatOSWorkflowNode
} from '../workflows/types.js'
import { validateWorkflowDefinition } from '../workflows/validateWorkflow.js'
import { compileMatOSWorkflowDefinition } from '../workflows/workflowCompile.js'
import { showMatOSWorkbenchResource } from './resources.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchWorkflowDraftApplyResult,
MatOSWorkbenchWorkflowView
} from './types.js'

import { firstString } from './workbenchValues.js'
export function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

export function workspaceRelative(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path)).replace(/\\/g, '/')
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Workflow draft write path is outside the MatOS workspace: ${path}`)
  }
  return rel
}

export async function assertWritableFilePath(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (info?.isSymbolicLink()) {
    throw new Error(`Refusing to write workflow draft through symlink path: ${path}`)
  }
}

export function assertProjectWorkflowWriteTarget(cwd: string, asset: MatOSAsset): void {
  if (asset.source !== 'project') {
    throw new Error(
      `Workflow draft writes are only enabled for project-local workflow assets; ${asset.canonicalKey} comes from ${asset.source}.`,
    )
  }
  if (!asset.entryAbsolutePath) {
    throw new Error(`Workflow draft writes require an entry file: ${asset.canonicalKey}`)
  }
  if (!isWithin(asset.entryAbsolutePath, asset.manifestDir)) {
    throw new Error(
      `Workflow entry is outside the asset directory: ${workspaceRelative(
        cwd,
        asset.entryAbsolutePath,
      )}`,
    )
  }
}

export function snapshotSummary(
  snapshot: NonNullable<MatOSWorkbenchWorkflowDraftApplyResult['snapshots']['after']>,
) {
  return {
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    files: snapshot.files,
    assetRefs: snapshot.assetRefs,
  }
}

export function serializableWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  const { sourcePath: _sourcePath, compiled: _compiled, ...rest } = definition
  return rest
}

export function cloneWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  return serializableWorkflowDefinition(JSON.parse(JSON.stringify(definition)) as MatOSWorkflowDefinition)
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

export function stringListFrom(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

export function safeWorkflowNodeId(value: string): string {
  const normalized = value
    .trim()
    .replace(/^.*?:/, '')
    .replace(/@.*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'matos_tool'
}

export function workflowToolAssetRefFromRequest(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.assetRef,
    request.asset_ref,
    request.toolRef,
    request.tool_ref,
    request.pluginRef,
    request.plugin_ref,
    request.mcpRef,
    request.mcp_ref,
    request.skillRef,
    request.skill_ref,
    request.plugin_id,
    request.pluginID,
    request.tool_id,
    request.toolID,
  )
}

export function workflowToolNodeIdFromRequest(
  request: Record<string, unknown>,
  asset: MatOSAsset,
): string {
  return safeWorkflowNodeId(
    firstString(
      request.nodeId,
      request.node_id,
      request.node,
      request.targetNodeId,
      request.target_node_id,
      `${asset.type}_${asset.id}`,
    ) ?? `${asset.type}_${asset.id}`,
  )
}

export function workflowToolNodeDependsOn(request: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...stringListFrom(request.dependsOn),
    ...stringListFrom(request.depends_on),
    ...stringListFrom(request.afterNodeIds),
    ...stringListFrom(request.after_node_ids),
    ...stringListFrom(request.after),
    ...stringListFrom(request.upstream),
    ...stringListFrom(firstString(request.afterNodeId, request.after_node_id)),
  ])
}

export function nodeMatchesWorkflowToolAsset(node: MatOSWorkflowNode, asset: MatOSAsset): boolean {
  const candidates = [
    node.tool,
    node.toolRef,
    node.assetRef,
    node.plugin,
    node.pluginRef,
    node.mcp,
    node.mcpRef,
    node.skill,
    node.skillRef,
  ]
  return candidates.some(value => typeof value === 'string' && value === asset.canonicalKey)
}


export async function resolveWorkflowAsset(input: MatOSWorkbenchContext & { ref: string }): Promise<MatOSAsset> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const asset = registry.resolve(input.ref)
  if (!asset || asset.type !== 'workflow') {
    throw new Error(workflowAssetNotFoundMessage(registry, input.ref))
  }
  return asset
}

export async function showWorkflowView(
  input: MatOSWorkbenchContext & { ref: string },
): Promise<MatOSWorkbenchWorkflowView> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const loaded = await loadWorkflowAsset(registry, input.ref)
  const resource = await showMatOSWorkbenchResource({
    ...input,
    ref: loaded.asset.canonicalKey,
    includeGraph: true,
  })
  const validation = validateWorkflowDefinition(loaded.definition)
  return {
    resource: resource.resource,
    workflow: {
      id: loaded.asset.id,
      canonicalKey: loaded.asset.canonicalKey,
      name: loaded.asset.name,
    },
    kind: loaded.kind,
    definition: loaded.definition,
    validation,
    compile: compileMatOSWorkflowDefinition(loaded.definition, {
      workflowRef: loaded.asset.canonicalKey,
    }),
  }
}

export async function validateWorkflowDraftCurrentDefinition(input: {
  cwd: string
  workflowRef: string
}): Promise<{
  validation: MatOSAssetHistoryValidationResult
  compile: ReturnType<typeof compileMatOSWorkflowDefinition>
}> {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets)
  const asset = registry.resolve(input.workflowRef)
  if (!asset || asset.type !== 'workflow') {
    throw new Error(
      workflowAssetNotFoundMessage(
        registry,
        input.workflowRef,
        'MatOS workflow asset not found after workflow draft write',
      ),
    )
  }
  const loaded = await loadWorkflowAsset(registry, asset.canonicalKey)
  const assetValidation = await validateMatOSAssets([asset])
  const workflowValidation = validateWorkflowDefinition(loaded.definition)
  const compile = compileMatOSWorkflowDefinition(loaded.definition, {
    workflowRef: loaded.asset.canonicalKey,
  })
  return {
    compile,
    validation: {
      ok: assetValidation.ok && workflowValidation.ok && compile.ok,
      gateProfile: 'smoke',
      assetValidation: {
        ok: assetValidation.ok,
        errors: assetValidation.errors,
      },
      secretScan: {
        ok: true,
        findings: [],
      },
      workflowValidation: [
        workflowValidation,
        {
          ok: compile.ok,
          diagnostics: compile.diagnostics,
          metadata: compile.metadata,
        },
      ],
    },
  }
}

export async function writeWorkflowDraftDefinition(input: {
  asset: MatOSAsset
  definition: MatOSWorkflowDefinition
}): Promise<void> {
  if (!input.asset.entryAbsolutePath) {
    throw new Error(`Workflow ${input.asset.canonicalKey} has no entry file for canvas edits.`)
  }
  await assertWritableFilePath(input.asset.entryAbsolutePath)
  const yaml = stringifyYaml(serializableWorkflowDefinition(input.definition), {
    lineWidth: 0,
  })
  await writeFile(input.asset.entryAbsolutePath, yaml.endsWith('\n') ? yaml : `${yaml}\n`, 'utf8')
}
