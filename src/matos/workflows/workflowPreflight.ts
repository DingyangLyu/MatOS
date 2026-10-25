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

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { loadMatOSWorkbenchRuntimeAssets } from '../workbench/runtimeAssetView.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import { matOSWorkflowService } from './workflowService.js'
import { normalizeWorkflowMapItems } from './nodeAdapters/mapNode.js'
import {
  resolveWorkflowParameters,
  validateWorkflowParameters,
} from './runState.js'
import { resolveWorkflowTemplateValue } from './workflowExpressions.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from './types.js'

export type WorkflowPreflightIssue = {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  nodeId?: string
  path?: string
  ref?: string
  value?: unknown
}

export type WorkflowPreflightSourceFingerprint = {
  nodeId: string
  path: string
  exists: boolean
  size?: number
  mtimeMs?: number
  sha256?: string
  error?: string
}

export type WorkflowPreflightResult = {
  ok: boolean
  runnable: boolean
  source: 'workflow' | 'draft'
  workflowRef?: string
  draftId?: string
  kind?: string
  executable?: boolean
  validation?: unknown
  compile?: unknown
  issues: WorkflowPreflightIssue[]
  sourceFingerprints: WorkflowPreflightSourceFingerprint[]
  summary: {
    errorCount: number
    warningCount: number
    infoCount: number
    nodeCount: number
    checkedRefs: number
    checkedSourceFiles: number
  }
}

type WorkflowPreflightInput = {
  cwd: string
  scopeRef?: string
  ref?: string
  draftId?: string
  parameters?: Record<string, unknown>
  workflowRefAllowed?: (ref: string) => boolean
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function workflowKey(asset: MatOSAsset | undefined): string | undefined {
  return asset?.canonicalKey || (asset ? `${asset.type}:${asset.id}` : undefined)
}

function checkParameters(
  definition: MatOSWorkflowDefinition,
  parameters: Record<string, unknown>,
): WorkflowPreflightIssue[] {
  return validateWorkflowParameters(definition, parameters).map(issue => ({
    severity: 'error',
    code: issue.code,
    message: issue.message,
    path: `parameters.${issue.key}`,
    ...(issue.value !== undefined ? { value: issue.value } : {}),
  }))
}

function tokenLooksLikeSourceFile(token: string): boolean {
  return /\.(py|sh|bash|js|mjs|cjs|ts|tsx|json|ya?ml)$/i.test(token)
}

// Solver/launcher commands that routinely run for hours in scientific
// workflows. Used only to warn when such a command has no explicit timeout.
const LONG_RUNNING_SOLVER_PATTERN =
  /\b(?:mpirun|mpiexec|srun|vasp(?:_std|_gam|_ncl)?|lmp(?:_[a-z]+)?|lammps|pw\.x|cp2k(?:\.[a-z]+)?|orca|gmx(?:_mpi)?|abinit|siesta|castep|qe|nwchem|gaussian|g16|xtb|dftb\+)\b/i

function commandSourceTokens(command: string): string[] {
  const tokens = new Set<string>()
  const direct = command.match(
    /(?:^|\s)(?:python[0-9.]*|bash|sh|node|bun|tsx)\s+(['"]?)([^'"\s;|&<>]+\.(?:py|sh|bash|js|mjs|cjs|ts|tsx))\1/g,
  )
  for (const match of direct ?? []) {
    const parts = match.trim().split(/\s+/)
    const token = parts.at(-1)?.replace(/^['"]|['"]$/g, '')
    if (token && tokenLooksLikeSourceFile(token)) {
      tokens.add(token)
    }
  }
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^['"([{]+|['")}\],;]+$/g, '')
    if (
      tokenLooksLikeSourceFile(token) &&
      (token.startsWith('/') || token.startsWith('./') || token.startsWith('../'))
    ) {
      tokens.add(token)
    }
  }
  return [...tokens]
}

function execNodeBaseDir(cwd: string, node: MatOSWorkflowNode): string {
  const nodeCwd = stringValue(node.cwd)
  if (!nodeCwd) {
    return cwd
  }
  return isAbsolute(nodeCwd) ? nodeCwd : join(cwd, nodeCwd)
}

function resolveSourcePath(cwd: string, node: MatOSWorkflowNode, token: string): string {
  return isAbsolute(token) ? token : resolve(execNodeBaseDir(cwd, node), token)
}

async function fingerprintSourcePath(
  nodeId: string,
  path: string,
): Promise<WorkflowPreflightSourceFingerprint> {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return {
        nodeId,
        path,
        exists: false,
        error: 'not_a_file',
      }
    }
    const bytes = await readFile(path)
    return {
      nodeId,
      path,
      exists: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    return {
      nodeId,
      path,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function childWorkflowRefs(node: MatOSWorkflowNode): string[] {
  const refs: string[] = []
  if (
    node.type === 'subworkflow' ||
    node.type === 'supernode' ||
    node.type === 'map' ||
    node.type === 'loop' ||
    node.runtimeType === 'subworkflow' ||
    node.runtimeType === 'map' ||
    node.runtimeType === 'loop'
  ) {
    const ref = stringValue(node.workflow)
    if (ref && !ref.includes('{{')) {
      refs.push(ref)
    }
  }
  return refs
}

function roleRefs(node: MatOSWorkflowNode): string[] {
  if (node.type !== 'agent' && node.runtimeType !== 'agent' && node.type !== 'dynamic') {
    return []
  }
  const role = stringValue(node.role)
  return role && !role.includes('{{') ? [role] : []
}

export async function buildWorkflowPreflight(
  input: WorkflowPreflightInput,
): Promise<WorkflowPreflightResult> {
  if (!input.ref && !input.draftId) {
    throw new Error('Workflow preflight requires ref or draftId')
  }

  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const registry = buildMatOSAssetRegistry(assets)
  const issues: WorkflowPreflightIssue[] = []
  let source: 'workflow' | 'draft' = 'workflow'
  let definition: MatOSWorkflowDefinition
  let workflowRef: string | undefined
  let kind: string | undefined
  let validation: unknown
  let compile: unknown

  if (input.draftId) {
    source = 'draft'
    const shown = await matOSWorkflowService.showDraft({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      draftId: input.draftId,
    })
    definition = shown.definition
    workflowRef = `draft:${input.draftId}`
    validation = shown.validation
    compile = await matOSWorkflowService.compileDraft({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      draftId: input.draftId,
    }).catch(error => {
      issues.push({
        severity: 'error',
        code: 'compile_failed',
        message: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
  } else {
    const ref = input.ref ?? ''
    const shown = await matOSWorkflowService.show({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      ref,
    })
    definition = shown.definition as MatOSWorkflowDefinition
    workflowRef = stringValue(recordValue(shown.workflow).canonicalKey) ?? ref
    kind = stringValue(shown.kind)
    validation = shown.validation
    compile = await matOSWorkflowService.compile({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      ref,
    }).catch(error => {
      issues.push({
        severity: 'error',
        code: 'compile_failed',
        message: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
  }

  const validationRecord = recordValue(validation)
  if (validationRecord.ok === false) {
    issues.push({
      severity: 'error',
      code: 'workflow_validation_failed',
      message: 'Workflow definition validation failed.',
    })
  }

  const executable = source === 'draft' || !kind || kind === 'executable'
  if (!executable) {
    issues.push({
      severity: 'warning',
      code: 'workflow_not_executable',
      message: `Workflow kind is ${kind}; normal agent start is intended for executable workflows.`,
      ref: workflowRef,
    })
  }

  if (workflowRef && input.workflowRefAllowed && !input.workflowRefAllowed(workflowRef)) {
    issues.push({
      severity: 'error',
      code: 'workflow_not_mounted',
      message: `Workflow ${workflowRef} is not mounted on the selected role.`,
      ref: workflowRef,
    })
  }

  const parameters = input.parameters ?? {}
  let resolvedParameters = parameters
  const parameterIssues = checkParameters(definition, parameters)
  issues.push(...parameterIssues)
  if (parameterIssues.length === 0) {
    resolvedParameters = resolveWorkflowParameters(definition, parameters)
  }

  const checkedRefs = new Set<string>()
  const sourcePaths = new Map<string, { nodeId: string; path: string }>()
  for (const node of definition.nodes ?? []) {
    for (const ref of childWorkflowRefs(node)) {
      checkedRefs.add(ref)
      const asset = registry.resolve(ref)
      if (!asset || asset.type !== 'workflow') {
        issues.push({
          severity: 'error',
          code: 'missing_child_workflow',
          message: `Child workflow ${ref} was not found.`,
          nodeId: node.id,
          ref,
        })
      } else if (input.workflowRefAllowed && !input.workflowRefAllowed(workflowKey(asset) ?? ref)) {
        issues.push({
          severity: 'error',
          code: 'child_workflow_not_mounted',
          message: `Child workflow ${workflowKey(asset) ?? ref} is not mounted on the selected role.`,
          nodeId: node.id,
          ref: workflowKey(asset) ?? ref,
        })
      }
    }

    for (const ref of roleRefs(node)) {
      checkedRefs.add(ref)
      const asset = registry.resolve(ref)
      if (!asset || asset.type !== 'role') {
        issues.push({
          severity: 'error',
          code: 'missing_agent_role',
          message: `Agent role ${ref} was not found.`,
          nodeId: node.id,
          ref,
        })
      }
    }

    if (node.type === 'exec' || node.runtimeType === 'exec') {
      const command = stringValue(node.command)
      if (command) {
        for (const token of commandSourceTokens(command)) {
          const path = resolveSourcePath(input.cwd, node, token)
          sourcePaths.set(`${node.id}:${path}`, { nodeId: node.id, path })
        }
        // Long-lived solver invocations with no explicit timeout fall back to
        // the 5-minute default and get killed mid-run; that first wasted
        // multi-hour computation is far more expensive than this warning.
        const policy =
          node.policy && typeof node.policy === 'object'
            ? (node.policy as Record<string, unknown>)
            : undefined
        const hasExplicitTimeout =
          node.timeoutSeconds !== undefined ||
          node.timeoutMs !== undefined ||
          policy?.timeoutSeconds !== undefined ||
          policy?.timeoutMs !== undefined
        if (!hasExplicitTimeout && LONG_RUNNING_SOLVER_PATTERN.test(command)) {
          issues.push({
            severity: 'warning',
            code: 'exec_solver_without_timeout',
            message:
              `Exec node "${node.id}" runs a long-lived solver command but declares no timeoutSeconds; ` +
              'the default exec timeout is 300s and will kill it. Set an evidence-based timeoutSeconds ' +
              '(or MATOS_WORKFLOW_EXEC_NODE_TIMEOUT_MS deployment-wide).',
            nodeId: node.id,
          })
        }
      }
      if (Array.isArray(node.args)) {
        for (const arg of node.args) {
          if (typeof arg === 'string' && tokenLooksLikeSourceFile(arg)) {
            const path = resolveSourcePath(input.cwd, node, arg)
            sourcePaths.set(`${node.id}:${path}`, { nodeId: node.id, path })
          }
        }
      }
    }

    if (node.type === 'map' || node.runtimeType === 'map') {
      const resolvedItems = resolveWorkflowTemplateValue(node.items, {
        nodeRuns: new Map(),
        parameters: resolvedParameters,
        workflow: {},
      })
      const normalizedItems = normalizeWorkflowMapItems(resolvedItems)
      if (!normalizedItems) {
        issues.push({
          severity: 'error',
          code: 'map_items_not_array',
          message: `Map node "${node.id}" items must resolve to an array before execution.`,
          nodeId: node.id,
          path: `nodes.${node.id}.items`,
          value: resolvedItems,
        })
      } else if (normalizedItems.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'map_items_empty',
          message: `Map node "${node.id}" items resolved to an empty array.`,
          nodeId: node.id,
          path: `nodes.${node.id}.items`,
          value: resolvedItems,
        })
      }
    }
  }

  const sourceFingerprints = await Promise.all(
    [...sourcePaths.values()].map(item => fingerprintSourcePath(item.nodeId, item.path)),
  )
  for (const fingerprint of sourceFingerprints) {
    if (!fingerprint.exists) {
      issues.push({
        severity: 'warning',
        code: 'source_file_not_found',
        message: `Referenced source file is not readable: ${fingerprint.path}`,
        nodeId: fingerprint.nodeId,
        path: fingerprint.path,
      })
    }
  }

  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const warningCount = issues.filter(issue => issue.severity === 'warning').length
  const infoCount = issues.filter(issue => issue.severity === 'info').length

  return {
    ok: errorCount === 0,
    runnable: errorCount === 0 && executable,
    source,
    ...(workflowRef ? { workflowRef } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    ...(kind ? { kind } : {}),
    executable,
    validation,
    compile,
    issues,
    sourceFingerprints,
    summary: {
      errorCount,
      warningCount,
      infoCount,
      nodeCount: definition.nodes?.length ?? 0,
      checkedRefs: checkedRefs.size,
      checkedSourceFiles: sourceFingerprints.length,
    },
  }
}
