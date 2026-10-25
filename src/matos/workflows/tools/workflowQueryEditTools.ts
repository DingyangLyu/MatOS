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

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MATOS_WORKFLOW_FACADE_TOOL_NAMES } from '../../tools/toolNames.js'
import {
  applyMatOSWorkbenchWorkflowRoleAttachment,
  previewMatOSWorkbenchWorkflowRoleAttachment,
} from '../../workbench/workflows.js'
import { matOSWorkflowService } from '../workflowService.js'
import { workflowNodeManifestForType } from '../nodeManifests.js'
import {
  instantiateWorkflowNodeTemplate,
  listWorkflowNodeTemplates,
  workflowNodeTemplateById,
} from '../nodeTemplates.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowParameter,
} from '../types.js'
import { validateWorkflowDefinition } from '../validateWorkflow.js'
import { buildWorkflowPreflight } from '../workflowPreflight.js'
import {
  WORKFLOW_RUNTIME_NODE_TYPES,
  WORKFLOW_SEMANTIC_NODE_TYPES,
  WORKFLOW_NODE_MANIFEST_SUMMARIES,
  compactWorkflowListResult,
  compactWorkflowRunEnvelopeForAgent,
  compactWorkflowToolValue,
  errorResult,
  effectiveAllowedWorkflowRefs,
  effectiveSessionWorkflowRefs,
  filterWorkflowListForAllowedRefs,
  filterWorkflowRunListForAllowedRefs,
  filterWorkflowTriggerListForAllowedRefs,
  jsonResult,
  metadataObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  parseParams,
  rememberPublishedWorkflowResult,
  textSchema,
  workflowAccessRestricted,
  workflowRefAllowed,
  workflowRefDeniedMessage,
  workflowRunDeniedMessage,
  workflowTriggerDeniedMessage,
  workflowDefinitionFromInput,
  workflowManifestNodeFromInput,
  workflowNodeFromInput,
  workflowOutputsFromInput,
  workflowParametersFromInput,
  workflowRunFiltersFromInput,
  workflowTransitionFromInput,
  type MatOSWorkflowTool,
  type MatOSWorkflowToolContext,
} from './workflowToolShared.js'

const WORKFLOW_EDIT_DRAFT_ACTIONS = new Set([
  'show_draft',
  'add_node',
  'add_manifest_node',
  'update_node',
  'delete_node',
  'connect',
  'disconnect',
  'connect_transition',
  'disconnect_transition',
  'set_state_machine',
  'set_parameters',
  'set_outputs',
  'validate_draft',
  'compile_draft',
  'replace_definition',
  'import_component',
  'publish_draft',
])

function workflowDraftSortKey(draft: Record<string, unknown>): string {
  return optionalString(draft.updatedAt) ??
    optionalString(draft.createdAt) ??
    optionalString(draft.draftId) ??
    ''
}

async function inferWorkflowEditDraftId(input: {
  cwd: string
  scopeRef?: string
}): Promise<string | undefined> {
  const payload = await matOSWorkflowService.drafts({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
  })
  const drafts = Array.isArray(payload.drafts)
    ? payload.drafts
        .filter(draft => draft !== null && typeof draft === 'object')
        .map(draft => draft as unknown as Record<string, unknown>)
    : []
  const sorted = [...drafts].sort((left, right) =>
    workflowDraftSortKey(right).localeCompare(workflowDraftSortKey(left)),
  )
  const latestEditable =
    sorted.find(draft => optionalString(draft.status) === 'draft') ?? sorted[0]
  return optionalString(latestEditable?.draftId)
}

// ---------------------------------------------------------------------------
// Context economy: compact projections + deterministic scaffolding.
//
// AutoMat traces showed workflow authoring dominating agent context: every
// draft mutation echoed the full definition back (O(n²) tokens over a build),
// `show` returned complete definitions (tens of KB per call), and agents
// reconstructed boilerplate structure from prose rules. The helpers below
// keep full definitions out of tool round trips: mutations return skeletons,
// show defaults to a summary, and `skeleton` emits a valid fill-in starting
// definition so the rules live in code, not in the agent's context.
// ---------------------------------------------------------------------------

/** Large free-text/config payload keys dropped from node skeletons. */
const NODE_SKELETON_DROPPED_KEYS = new Set([
  'prompt',
  'systemPrompt',
  'command',
  'args',
  'env',
  'checks',
  'input',
  'inputs',
  'toolInput',
  'candidate',
  'outputSchema',
  'outputContract',
  'inputContract',
  'artifactContract',
  'matosProduct',
  'computeLifecycle',
  'lifecycle',
  'responseSchema',
])

function workflowNodeSkeleton(node: Record<string, unknown>): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (NODE_SKELETON_DROPPED_KEYS.has(key) || value === undefined) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      skeleton[key] = typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value
      continue
    }
    if (key === 'dependsOn' && Array.isArray(value)) {
      skeleton[key] = value
    }
  }
  return skeleton
}

/** Compact, guidance-friendly view of a definition (no prompt/command bodies). */
function workflowDefinitionSummary(definition: MatOSWorkflowDefinition): Record<string, unknown> {
  const record = definition as unknown as Record<string, unknown>
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  return {
    name: definition.name,
    ...(record.version !== undefined ? { version: record.version } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    parameters: definition.parameters ?? {},
    policy: definition.policy ?? {},
    nodeCount: nodes.length,
    nodes: nodes.map(node => workflowNodeSkeleton(node as unknown as Record<string, unknown>)),
    outputs: definition.outputs ?? {},
  }
}

/**
 * Compact draft-mutation payload. Full definitions are echoed only on
 * request (`returnDefinition=true`) — validation carries the actionable
 * part, and the skeleton keeps ids/wiring visible for the next edit.
 */
function compactDraftMutationResult(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (optionalBoolean(raw.returnDefinition) === true) {
    return payload
  }
  const { definition, ...rest } = payload
  if (!definition || typeof definition !== 'object') {
    return payload
  }
  return {
    ...rest,
    summary: workflowDefinitionSummary(definition as MatOSWorkflowDefinition),
    note: 'Definition body omitted for context economy — pass returnDefinition=true for the full JSON, or read the draft file directly.',
  }
}

/** Deterministic placeholder for a required manifest field. */
function skeletonFieldPlaceholder(key: string): unknown {
  switch (key) {
    case 'command':
      return 'echo TODO-replace-with-real-command'
    case 'role':
      return 'role:compute'
    case 'prompt':
      return 'TODO: describe the task for this node'
    case 'backend':
      return 'local'
    case 'checks':
      return [{ type: 'file_exists', path: 'TODO/expected-output.file' }]
    case 'workflow':
      return 'workflow:TODO-child-workflow-id'
    case 'items':
      return '{{ parameters.items }}'
    case 'instrument':
      return 'TODO-instrument-id'
    default:
      return 'TODO'
  }
}

/**
 * Deterministic scaffold: a structurally valid, fill-in definition for the
 * requested node types — or curated node-template ids — wired as a linear
 * chain. The boilerplate rules (ids, dependsOn, policy, required fields,
 * proven node idioms) live here instead of agent context.
 */
function workflowSkeletonDefinition(input: {
  name: string
  nodeTypes: string[]
}): { definition?: MatOSWorkflowDefinition; error?: string } {
  const nodes: Record<string, unknown>[] = []
  const parameters: Record<string, MatOSWorkflowParameter> = {}
  const counts = new Map<string, number>()
  let previousId: string | undefined
  for (const entry of input.nodeTypes) {
    // Curated template ids take precedence: they carry proven node bodies
    // with parameterized fields, so the agent only adjusts parameter values.
    const template = workflowNodeTemplateById(entry)
    if (template) {
      const index = (counts.get(template.id) ?? 0) + 1
      counts.set(template.id, index)
      const id = `${template.id.replace(/[^A-Za-z0-9_]/g, '_')}_${index}`
      const instantiated = instantiateWorkflowNodeTemplate(template, {
        id,
        dependsOn: previousId ? [previousId] : [],
      })
      Object.assign(parameters, instantiated.parameters)
      nodes.push(instantiated.node as unknown as Record<string, unknown>)
      previousId = id
      continue
    }
    const manifest = workflowNodeManifestForType(entry)
    if (!manifest) {
      return {
        error: `Unknown workflow node type or template: ${entry} (templates: ${listWorkflowNodeTemplates()
          .map(item => item.id)
          .join(', ')})`,
      }
    }
    const index = (counts.get(entry) ?? 0) + 1
    counts.set(entry, index)
    const id = `${entry.replace(/[^A-Za-z0-9_]/g, '_')}_${index}`
    const node: Record<string, unknown> = {
      id,
      type: entry,
      dependsOn: previousId ? [previousId] : [],
    }
    for (const field of manifest.fields) {
      if (!field.required || field.key === 'id' || field.key === 'type') {
        continue
      }
      node[field.key] = field.default ?? skeletonFieldPlaceholder(field.key)
    }
    // Validator constraints the manifests cannot express as single required
    // fields: agent/dynamic nodes need prompt-or-systemPrompt.
    if (
      (entry === 'agent' || entry === 'dynamic') &&
      node.prompt === undefined &&
      node.systemPrompt === undefined
    ) {
      node.prompt = skeletonFieldPlaceholder('prompt')
    }
    nodes.push(node)
    previousId = id
  }
  return {
    definition: {
      schemaVersion: 1,
      name: input.name,
      version: '0.1.0',
      description: 'TODO: what this workflow reproduces or computes',
      parameters,
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: nodes as unknown as MatOSWorkflowDefinition['nodes'],
      outputs: {},
    } as MatOSWorkflowDefinition,
  }
}

function readDefinitionInput(
  context: MatOSWorkflowToolContext,
  raw: Record<string, unknown>,
): { definition?: MatOSWorkflowDefinition; error?: string } {
  const inline = workflowDefinitionFromInput(raw.definition)
  if (inline) {
    return { definition: inline as MatOSWorkflowDefinition }
  }
  const definitionFile = optionalString(raw.definitionFile)
  if (!definitionFile) {
    return {}
  }
  const filePath = isAbsolute(definitionFile)
    ? definitionFile
    : join(context.cwd, definitionFile)
  try {
    const parsed = workflowDefinitionFromInput(
      JSON.parse(readFileSync(filePath, 'utf8')),
    )
    return parsed
      ? { definition: parsed as MatOSWorkflowDefinition }
      : { error: `definitionFile "${definitionFile}" does not contain a workflow definition object` }
  } catch (error) {
    return {
      error: `could not read definitionFile "${definitionFile}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

export function createMatOSWorkflowQueryEditTools(
  context: MatOSWorkflowToolContext,
): MatOSWorkflowTool[] {
  return [
    {
      name: 'workflow_query',
      description:
        'Compact MatOS workflow read tool for all agents. Use action=context|manifest|templates|template|skeleton|list|show|validate|compile|preflight|compile_inspect|contracts|runs|drafts|show_draft|status|inspect|events|artifacts|patches|patch_inspect. show returns a compact summary by default (detail=full for the complete definition); templates lists curated parameterized node templates (QE runs, convergence guards, compute jobs, structured agent analysis); skeleton returns a valid fill-in definition for the given nodeTypes and/or template ids.',
      inputSchema: textSchema({
        action: {
          type: 'string',
          enum: [
            'context',
            'manifest',
            'templates',
            'template',
            'skeleton',
            'list',
            'show',
            'validate',
            'compile',
            'preflight',
            'compile_inspect',
            'contracts',
            'runs',
            'drafts',
            'show_draft',
            'status',
            'inspect',
            'events',
            'artifacts',
            'patches',
            'patch_inspect',
            'trigger_events',
            'triggers',
            'trigger',
          ],
          description: 'Read operation. Defaults to context.',
        },
        ref: { type: 'string', description: 'Workflow asset reference.' },
        draftId: { type: 'string', description: 'Workflow draft id.' },
        nodeType: { type: 'string', description: 'Workflow node manifest type for action=manifest.' },
        nodeTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Node types and/or template ids for action=skeleton, wired as a linear chain (e.g. ["qe-pw-exec","qe-convergence-guard","agent-analyze"] or ["exec","validate"]). Template ids expand to proven parameterized node bodies.',
        },
        templateId: {
          type: 'string',
          description: 'Template id for action=template.',
        },
        tag: {
          type: 'string',
          description: 'Optional tag filter for action=templates (e.g. materials, qe, guard).',
        },
        name: { type: 'string', description: 'Workflow name for action=skeleton.' },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            'For action=show|list: summary (default) omits prompt/command bodies (show) or returns compact capped rows (list); full restores the complete payload.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For action=list: explicit row columns to return (e.g. ["canonicalKey","name","tags"]).',
        },
        runId: { type: 'string', description: 'Workflow run id.' },
        triggerId: { type: 'string', description: 'Workflow trigger id.' },
        patchId: { type: 'string', description: 'Workflow patch id.' },
        query: {
          type: 'string',
          description:
            'Optional search query for action=runs and action=list (substring match over id/name/description/tags).',
        },
        filter: {
          type: 'object',
          description:
            'Structured run filters: workflowRef, status, traceId, sessionId, triggerId, source, updatedAfter, updatedBefore.',
        },
        workflowRef: { type: 'string', description: 'Filter workflow ref for action=runs.' },
        status: { type: 'string', description: 'Filter run status for action=runs.' },
        traceId: { type: 'string', description: 'Filter trace id for action=runs.' },
        sessionId: { type: 'string', description: 'Filter session id for action=runs.' },
        source: { type: 'string', description: 'Filter provenance source for action=runs.' },
        updatedAfter: { type: 'string', description: 'Filter updatedAt lower bound.' },
        updatedBefore: { type: 'string', description: 'Filter updatedAt upper bound.' },
        limit: { type: 'number', description: 'Optional page limit.' },
        offset: { type: 'number', description: 'Optional page offset.' },
        scope: { type: 'string', description: 'Optional runtime scope ref.' },
        params: { type: 'object', description: 'Workflow parameters for action=preflight.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const action = optionalString(raw.action) ?? 'context'
          const scopeRef = optionalString(raw.scope)
          const runId = optionalString(raw.runId)
          const draftId = optionalString(raw.draftId)
          const ref = optionalString(raw.ref)

          switch (action) {
            case 'context':
              return jsonResult({
                cwd: context.cwd,
                selectedRole: context.selectedRole,
                workflowAccessMode:
                  context.workflowAccessMode ??
                  (workflowAccessRestricted(context) ? 'role-mounted' : 'unrestricted'),
                allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
                sessionWorkflowRefs: effectiveSessionWorkflowRefs(context),
                workflowTools: [...MATOS_WORKFLOW_FACADE_TOOL_NAMES],
                nodeTypes: [...WORKFLOW_RUNTIME_NODE_TYPES],
                semanticNodeTypes: [...WORKFLOW_SEMANTIC_NODE_TYPES],
                nodeManifestCount: WORKFLOW_NODE_MANIFEST_SUMMARIES.length,
                nodeManifestTypes: WORKFLOW_NODE_MANIFEST_SUMMARIES.map(item => item.type),
                guidance: [
                  'Fastest authoring path: compose from curated node templates — workflow_query action=templates to browse, action=skeleton nodeTypes=[<template ids and/or node types>] for a pre-filled valid definition — then adjust parameter values, write the JSON to a file, and submit in one call: workflow_edit action=author id=<workflow-id> definitionFile=<path> (creates the draft, validates, publishes).',
                  'Use workflow_query for read-only discovery, validation, compile, run history, and artifacts. action=show returns a compact summary (parameters, node skeletons, outputs) by default; pass detail=full only when you need prompt/command bodies.',
                  'Use workflow_query action=manifest to inspect required fields before add_manifest_node.',
                  'Use workflow_query action=preflight or workflow_run dryRun=true before starting unfamiliar or newly authored workflows.',
                  'Use workflow_run for start/control/recover operations.',
                  context.workflowStartPolicy === 'tracked-cli-only'
                    ? 'The tracked CLI harness owns workflow execution: use the case-local launcher, then end the Agent segment after its durable handoff. Do not call workflow_run start/wait/pause/resume/cancel/retry/reconcile/recover_apply or poll the run.'
                    : 'For long-running workflows start with wait=false, then block for transitions with workflow_run action=wait (bounded long-poll with heartbeat/stall detection and next-step guidance) instead of polling status in a loop; interactive sessions are additionally notified when a detached run finishes, fails, stalls, or needs input.',
                  'Use workflow_edit action=fork_workflow when a similar workflow asset exists; then edit the draft instead of rebuilding from scratch.',
                  'Use workflow_edit for draft creation, graph editing, parameter editing, state-machine editing, and publishing.',
                  'Use workflow_edit action=attach_to_role after publish when a reusable workflow must become a durable role mount; first call without fingerprint for preview, then apply with the returned fingerprint.',
                  'Use workflow_edit action=set_parameters to patch top-level parameters instead of replacing the full definition.',
                  'Use {{ nodes.<nodeId>.artifacts.<artifactId>.path }} when a downstream node or workflow output needs a declared artifact path.',
                  'Tool/plugin/MCP/skill assets are mounted on agent roles or reached through exec/backend/compute adapters; do not model them as separate workflow node types.',
                  'Workflow specialist roles may also expose lower-level workflow_* tools for precise repair work.',
                ],
              })
            case 'manifest': {
              const nodeType = optionalString(raw.nodeType)
              if (!nodeType) {
                return jsonResult({
                  nodeManifests: WORKFLOW_NODE_MANIFEST_SUMMARIES,
                  summary: {
                    count: WORKFLOW_NODE_MANIFEST_SUMMARIES.length,
                    runtimeTypes: [...WORKFLOW_RUNTIME_NODE_TYPES],
                    semanticNodeTypes: [...WORKFLOW_SEMANTIC_NODE_TYPES],
                  },
                })
              }
              const manifest = WORKFLOW_NODE_MANIFEST_SUMMARIES.find(
                item => item.type === nodeType,
              )
              if (!manifest) {
                return errorResult(`Unknown workflow node manifest: ${nodeType}`)
              }
              return jsonResult({ manifest })
            }
            case 'list':
              return jsonResult(
                compactWorkflowListResult(
                  filterWorkflowListForAllowedRefs(
                    context,
                    await matOSWorkflowService.list({ cwd: context.cwd }) as Record<string, unknown>,
                  ),
                  {
                    detail: optionalString(raw.detail),
                    fields: raw.fields,
                    limit: raw.limit,
                    offset: raw.offset,
                    query: optionalString(raw.query),
                  },
                ),
              )
            case 'show':
              if (!ref) {
                return errorResult('workflow_query action=show requires ref')
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              {
                const shown = await matOSWorkflowService.show({ cwd: context.cwd, ref })
                const full = optionalString(raw.detail) === 'full'
                return jsonResult({
                  workflow: shown.workflow,
                  kind: shown.kind,
                  // Summary by default: parameters (the call contract), node
                  // skeletons, and outputs — without prompt/command bodies
                  // that dominated agent context in real traces. detail=full
                  // restores the complete definition.
                  ...(full
                    ? { definition: shown.definition }
                    : {
                        summary: workflowDefinitionSummary(
                          shown.definition as MatOSWorkflowDefinition,
                        ),
                        note: 'Definition bodies omitted — use detail=full for the complete definition.',
                      }),
                  validation: shown.validation,
                  nodeManifestSummary: {
                    count: shown.nodeManifests.length,
                    types: shown.nodeManifests.map(item => item.type),
                    inspectWith: 'workflow_query action=manifest nodeType=<type>',
                  },
                })
              }
            case 'templates': {
              const tag = optionalString(raw.tag)
              const nodeType = optionalString(raw.nodeType)
              const templates = listWorkflowNodeTemplates({ tag, nodeType })
              return jsonResult({
                templates: templates.map(template => ({
                  id: template.id,
                  title: template.title,
                  nodeType: template.nodeType,
                  tags: template.tags,
                  description: template.description,
                  parameterKeys: Object.keys(template.parameters),
                })),
                usage:
                  'Inspect one with action=template templateId=<id>; compose a workflow from templates with action=skeleton nodeTypes=[<template ids and/or node types>], then fill parameter values and submit via workflow_edit action=author.',
              })
            }
            case 'template': {
              const templateId = optionalString(raw.templateId) ?? optionalString(raw.nodeType)
              if (!templateId) {
                return errorResult('workflow_query action=template requires templateId')
              }
              const template = workflowNodeTemplateById(templateId)
              if (!template) {
                return errorResult(
                  `Unknown workflow node template: ${templateId} (available: ${listWorkflowNodeTemplates()
                    .map(item => item.id)
                    .join(', ')})`,
                )
              }
              return jsonResult({ template })
            }
            case 'skeleton': {
              const nodeTypesRaw = raw.nodeTypes
              const nodeTypes = Array.isArray(nodeTypesRaw)
                ? nodeTypesRaw.filter((item): item is string => typeof item === 'string')
                : typeof nodeTypesRaw === 'string'
                  ? nodeTypesRaw.split(',').map(item => item.trim()).filter(Boolean)
                  : []
              if (nodeTypes.length === 0) {
                return errorResult(
                  'workflow_query action=skeleton requires nodeTypes — node types and/or template ids (list templates with action=templates)',
                )
              }
              const skeleton = workflowSkeletonDefinition({
                name: optionalString(raw.name) ?? 'TODO-workflow-name',
                nodeTypes,
              })
              if (!skeleton.definition) {
                return errorResult(skeleton.error ?? 'invalid skeleton request')
              }
              return jsonResult({
                definition: skeleton.definition,
                validation: validateWorkflowDefinition(skeleton.definition),
                note:
                  'Fill the TODO placeholders (and asset refs like role:compute), then submit in one call: workflow_edit action=author id=<workflow-id> definitionFile=<path> (write the JSON to a file first).',
              })
            }
            case 'validate':
              if (!ref) {
                return errorResult('workflow_query action=validate requires ref')
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                await matOSWorkflowService.validate({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                }),
              )
            case 'compile':
              if (draftId) {
                return jsonResult(
                  await matOSWorkflowService.compileDraft({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                  }),
                )
              }
              if (!ref) {
                return errorResult(
                  'workflow_query action=compile requires ref or draftId',
                )
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                await matOSWorkflowService.compile({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                }),
              )
            case 'preflight': {
              if (!ref && !draftId) {
                return errorResult(
                  'workflow_query action=preflight requires ref or draftId',
                )
              }
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                await buildWorkflowPreflight({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                  draftId,
                  parameters: parseParams(raw.params),
                  workflowRefAllowed: candidate => workflowRefAllowed(context, candidate),
                }),
              )
            }
            case 'compile_inspect':
              if (!runId) {
                return errorResult('workflow_query action=compile_inspect requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.compileInspect({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                }),
              )
            case 'contracts':
              if (!ref && !draftId && !runId) {
                return errorResult(
                  'workflow_query action=contracts requires ref, draftId, or runId',
                )
              }
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              if (runId) {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.contracts({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                  draftId,
                  runId,
                }),
              )
            case 'runs': {
              const filter = workflowRunFiltersFromInput(raw)
              if (filter.workflowRef && !workflowRefAllowed(context, filter.workflowRef)) {
                return errorResult(workflowRefDeniedMessage(context, filter.workflowRef))
              }
              const detailFull = optionalString(raw.detail) === 'full'
              const listed = filterWorkflowRunListForAllowedRefs(
                context,
                (await matOSWorkflowService.listRuns({
                  cwd: context.cwd,
                  scopeRef,
                  query: optionalString(raw.query),
                  filter,
                  limit: optionalInteger(raw.limit),
                  offset: optionalInteger(raw.offset),
                  // Full rows re-inspect every run and read its whole event
                  // log; a runs listing is a table, not a drill-down. Use
                  // action=status/inspect on one runId for depth.
                  detail: detailFull ? 'full' : 'summary',
                  // Access-filter before pagination so page sizes and
                  // offsets stay meaningful under role-mounted restriction.
                  refAllowed: ref => workflowRefAllowed(context, ref),
                })) as unknown as Record<string, unknown>,
              )
              if (detailFull) {
                return jsonResult(listed)
              }
              const rows = Array.isArray(listed.runs)
                ? listed.runs.map(item => {
                    const record = metadataObject(item)
                    const snapshot = metadataObject(record.snapshot)
                    const run = metadataObject(record.run)
                    return {
                      runId: snapshot.runId ?? run.runId,
                      workflowRef: snapshot.workflowRef ?? run.workflowRef,
                      status: snapshot.status ?? run.status,
                      createdAt: snapshot.createdAt,
                      updatedAt: snapshot.updatedAt,
                      ...(snapshot.waitingNodeId
                        ? { waitingNodeId: snapshot.waitingNodeId }
                        : {}),
                      ...(snapshot.childDepth
                        ? { childDepth: snapshot.childDepth }
                        : {}),
                    }
                  })
                : []
              return jsonResult({
                ...listed,
                runs: rows,
                note:
                  'Compact run rows. Use action=status runId=... for live progress, action=inspect for node detail, or detail=full for complete legacy rows.',
              })
            }
            case 'drafts':
              return jsonResult(
                await matOSWorkflowService.drafts({ cwd: context.cwd, scopeRef }),
              )
            case 'show_draft': {
              if (!draftId) {
                return errorResult('workflow_query action=show_draft requires draftId')
              }
              return jsonResult(
                await matOSWorkflowService.showDraft({
                  cwd: context.cwd,
                  scopeRef,
                  draftId,
                }),
              )
            }
            case 'status':
              if (!runId) {
                return errorResult('workflow_query action=status requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.status({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'inspect': {
              if (!runId) {
                return errorResult('workflow_query action=inspect requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              const inspected = await matOSWorkflowService.inspect({
                cwd: context.cwd,
                scopeRef,
                runId,
              })
              const inspectNodeId = optionalString(raw.nodeId)
              if (inspectNodeId) {
                const run = metadataObject(inspected.run as unknown)
                const nodes = Array.isArray(run.nodes) ? run.nodes : []
                const node = nodes.find(
                  candidate => metadataObject(candidate).nodeId === inspectNodeId,
                )
                if (!node) {
                  return errorResult(
                    `workflow_query action=inspect: node ${inspectNodeId} has no run record in ${runId}`,
                  )
                }
                return jsonResult({
                  runId,
                  status: run.status,
                  node: node as Record<string, unknown>,
                })
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(inspected, {
                  detail: optionalString(raw.detail),
                }),
              )
            }
            case 'events': {
              if (!runId) {
                return errorResult('workflow_query action=events requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              const eventsResult = await matOSWorkflowService.events({
                cwd: context.cwd,
                scopeRef,
                runId,
              })
              const allEvents = Array.isArray(eventsResult.events)
                ? eventsResult.events
                : []
              const requestedTail = optionalInteger(raw.tail)
              const tail =
                requestedTail !== undefined && requestedTail > 0
                  ? Math.min(requestedTail, 1_000)
                  : 100
              const sliced = allEvents.slice(-tail)
              return jsonResult({
                events: compactWorkflowToolValue(sliced),
                totalEvents: allEvents.length,
                ...(allEvents.length > sliced.length
                  ? {
                      note: `showing last ${sliced.length} of ${allEvents.length} events; pass tail=<n> (up to 1000) for more`,
                    }
                  : {}),
              })
            }
            case 'artifacts':
              if (!runId) {
                return errorResult('workflow_query action=artifacts requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.artifacts({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                }),
              )
            case 'patches':
              if (!runId) {
                return errorResult('workflow_query action=patches requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.patches({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                }),
              )
            case 'patch_inspect': {
              const patchId = optionalString(raw.patchId)
              if (!runId || !patchId) {
                return errorResult(
                  'workflow_query action=patch_inspect requires runId and patchId',
                )
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.patchInspect({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                  patchId,
                }),
              )
            }
            case 'trigger_events':
              return jsonResult(matOSWorkflowService.triggerEvents({ cwd: context.cwd }))
            case 'triggers': {
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              const payload = await matOSWorkflowService.triggers({
                cwd: context.cwd,
                scopeRef,
                workflowRef: ref,
              })
              return jsonResult(
                filterWorkflowTriggerListForAllowedRefs(
                  context,
                  payload as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'trigger': {
              const triggerId = optionalString(raw.triggerId)
              if (!triggerId) {
                return errorResult('workflow_query action=trigger requires triggerId')
              }
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              const payload = await matOSWorkflowService.trigger({
                cwd: context.cwd,
                scopeRef,
                workflowRef: ref,
                triggerId,
              })
              const denied = workflowTriggerDeniedMessage(
                context,
                payload as unknown as Record<string, unknown>,
              )
              if (denied) {
                return errorResult(denied)
              }
              return jsonResult(
                payload as unknown as Record<string, unknown>,
              )
            }
            default:
              return errorResult(`Unsupported workflow_query action: ${action}`)
          }
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_edit',
      description:
        'Compact MatOS workflow draft/edit tool for all agents. Fastest full-authoring path: write the complete definition JSON to a file, then one call action=author with id + definitionFile (creates/resets the draft, validates, publishes) — get a valid starting structure from workflow_query action=skeleton. Prefer action=fork_workflow to derive a draft from an existing workflow asset. For draft actions, draftId is preferred but may be omitted to use the current scope latest editable draft. Use action=add_manifest_node / update_node / set_parameters for surgical edits to existing drafts. Guard/validate checks support expression, file_exists, file_size, grep, regex, numeric_range, and json_schema; use regex negate=true for forbidden fatal/non-finite text, numeric_range.notEqual for sentinels, and failureCode/repairHint/sourceNodeId for actionable feedback. Draft mutations return a compact summary; pass returnDefinition=true when the full definition JSON is needed.',
      inputSchema: textSchema({
        action: {
          type: 'string',
          enum: [
            'author',
            'create_draft',
            'fork_workflow',
            'drafts',
            'show_draft',
            'add_manifest_node',
            'add_node',
            'update_node',
            'delete_node',
            'connect',
            'disconnect',
            'connect_transition',
            'disconnect_transition',
            'set_state_machine',
            'set_parameters',
            'set_outputs',
            'validate_draft',
            'compile_draft',
            'replace_definition',
            'import_component',
            'publish_draft',
            'attach_to_role',
            'fork_run',
            'save_trigger',
            'delete_trigger',
          ],
          description: 'Edit operation.',
        },
        id: { type: 'string', description: 'Draft id or published workflow id.' },
        name: { type: 'string', description: 'Workflow or draft name.' },
        version: { type: 'string', description: 'Workflow version.' },
        description: { type: 'string', description: 'Workflow description.' },
        draftId: { type: 'string', description: 'Workflow draft id.' },
        ref: { type: 'string', description: 'Workflow asset reference.' },
        runId: { type: 'string', description: 'Workflow run id.' },
        roleRef: { type: 'string', description: 'Role asset ref for action=attach_to_role.' },
        fingerprint: { type: 'string', description: 'Confirmation fingerprint for action=attach_to_role apply.' },
        reason: { type: 'string', description: 'Reason for role attachment, trigger deletion, or audit.' },
        request: { type: 'object', description: 'Optional native workbench request payload.' },
        triggerId: { type: 'string', description: 'Workflow trigger id.' },
        trigger: { type: 'object', description: 'Trigger save/delete request payload.' },
        nodeId: { type: 'string', description: 'Workflow node id.' },
        nodeType: { type: 'string', description: 'MatOS workflow node manifest type for action=add_manifest_node.' },
        fields: { type: 'object', description: 'Manifest field values for action=add_manifest_node.' },
        node: { type: 'object', description: 'Complete node object.' },
        patch: { type: 'object', description: 'Partial node patch.' },
        dependsOn: { type: 'array', description: 'Optional dependency node ids for action=add_manifest_node.' },
        from: { type: 'string', description: 'Source node id.' },
        to: { type: 'string', description: 'Target node id.' },
        transitionId: { type: 'string', description: 'Transition id.' },
        transition: { type: 'object', description: 'State-machine transition.' },
        disable: { type: 'boolean', description: 'Disable state-machine mode.' },
        initialNodeId: { type: 'string', description: 'Initial state node id.' },
        maxTransitions: { type: 'number', description: 'Transition limit.' },
        maxFrames: { type: 'number', description: 'State-machine frame limit.' },
        parameters: { type: 'object', description: 'Workflow parameter specs for action=set_parameters.' },
        removeParameters: { type: 'array', description: 'Parameter ids to remove for action=set_parameters.' },
        removeParameterIds: { type: 'array', description: 'Alias for removeParameters.' },
        replace: { type: 'boolean', description: 'Replace the full parameter object instead of merging.' },
        outputs: { type: 'object', description: 'Workflow outputs object.' },
        definition: { type: 'object', description: 'Full workflow definition.' },
        definitionFile: {
          type: 'string',
          description:
            'Path to a JSON file holding the full workflow definition for action=author or action=replace_definition (preferred over inline definition for large graphs).',
        },
        publish: {
          type: 'boolean',
          description:
            'With action=author: publish after validation (default true). Set false to stop at a validated draft.',
        },
        returnDefinition: {
          type: 'boolean',
          description:
            'Draft mutations return a compact summary by default; set true to echo the full definition JSON.',
        },
        scope: { type: 'string', description: 'Optional runtime scope ref.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const action = optionalString(raw.action)
          const scopeRef = optionalString(raw.scope)
          const request = metadataObject(raw.request)
          const explicitDraftId =
            optionalString(raw.draftId) ?? optionalString(request.draftId)
          const draftId =
            explicitDraftId ??
            (action && WORKFLOW_EDIT_DRAFT_ACTIONS.has(action)
              ? await inferWorkflowEditDraftId({ cwd: context.cwd, scopeRef })
              : undefined)

          switch (action) {
            case 'author': {
              const id = optionalString(raw.id)
              if (!id) {
                return errorResult(
                  'workflow_edit action=author requires id (the workflow asset id, e.g. "si-dft-reproduction")',
                )
              }
              const definitionInput = readDefinitionInput(context, raw)
              if (definitionInput.error) {
                return errorResult(`workflow_edit action=author ${definitionInput.error}`)
              }
              if (!definitionInput.definition) {
                return errorResult(
                  'workflow_edit action=author requires definition (inline) or definitionFile (path to the definition JSON; get a starting structure from workflow_query action=skeleton)',
                )
              }
              const authored = await matOSWorkflowService.author({
                cwd: context.cwd,
                scopeRef,
                id,
                definition: definitionInput.definition,
                name: optionalString(raw.name),
                version: optionalString(raw.version),
                description: optionalString(raw.description),
                publish: optionalBoolean(raw.publish),
              })
              if (authored.published) {
                rememberPublishedWorkflowResult(context, authored)
              }
              return jsonResult({
                ok: authored.validation.ok,
                draftId: authored.draftId,
                validation: authored.validation,
                published: authored.published
                  ? { assetKey: authored.published.assetKey }
                  : null,
                workflowRef: authored.workflowRef,
                ...(authored.workflowRef
                  ? {
                      nextSteps: [
                        `Run it with workflow_run action=start ref=${authored.workflowRef} (add wait=false for long workflows, then action=wait).`,
                      ],
                    }
                  : authored.validation.ok
                    ? { note: 'Draft validated; publish=false kept it unpublished.' }
                    : {
                        note: 'Validation failed — fix the definition and re-run action=author with the same id (idempotent).',
                      }),
              })
            }
            case 'create_draft':
              return jsonResult(
                await matOSWorkflowService.createDraft({
                  cwd: context.cwd,
                  scopeRef,
                  id: optionalString(raw.id),
                  name: optionalString(raw.name),
                  version: optionalString(raw.version),
                  description: optionalString(raw.description),
                }) as unknown as Record<string, unknown>,
              )
            case 'fork_workflow': {
              const ref = optionalString(raw.ref)
              if (!ref) {
                return errorResult('workflow_edit action=fork_workflow requires ref')
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                await matOSWorkflowService.forkWorkflow({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                  id: optionalString(raw.id),
                  name: optionalString(raw.name),
                  version: optionalString(raw.version),
                  description: optionalString(raw.description),
                }),
              )
            }
            case 'drafts':
              return jsonResult(
                await matOSWorkflowService.drafts({ cwd: context.cwd, scopeRef }),
              )
            case 'show_draft': {
              if (!draftId) {
                return errorResult('workflow_edit action=show_draft requires draftId')
              }
              return jsonResult(
                await matOSWorkflowService.showDraft({
                  cwd: context.cwd,
                  scopeRef,
                  draftId,
                }),
              )
            }
            case 'add_node': {
              const node = workflowNodeFromInput(raw.node)
              if (!draftId) {
                return errorResult(
                  'workflow_edit action=add_node requires draftId (no editable draft found — call action=create_draft first)',
                )
              }
              if (!node) {
                return errorResult(
                  'workflow_edit action=add_node requires node with string id and type (use action=add_manifest_node with nodeType/fields for guided authoring)',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.addDraftNode({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    node,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'add_manifest_node': {
              const nodeInput = workflowManifestNodeFromInput({
                id: optionalString(raw.nodeId ?? raw.id),
                nodeType: optionalString(raw.nodeType),
                fields: raw.fields,
                dependsOn: raw.dependsOn,
              })
              if (!draftId || !nodeInput.node) {
                return errorResult(
                  !draftId
                    ? 'workflow_edit action=add_manifest_node requires draftId'
                    : nodeInput.error ?? 'Invalid manifest node input',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.addDraftNode({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    node: nodeInput.node,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'update_node': {
              const nodeId = optionalString(raw.nodeId)
              if (!draftId || !nodeId) {
                return errorResult(
                  !draftId
                    ? 'workflow_edit action=update_node requires draftId (no editable draft found — call action=create_draft first)'
                    : 'workflow_edit action=update_node requires nodeId',
                )
              }
              const patch = raw.patch
              if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
                return errorResult(
                  'workflow_edit action=update_node requires patch to be a non-empty object',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.updateDraftNode({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    nodeId,
                    patch: patch as Partial<MatOSWorkflowNode>,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'delete_node': {
              const nodeId = optionalString(raw.nodeId)
              if (!draftId || !nodeId) {
                return errorResult(
                  'workflow_edit action=delete_node requires draftId and nodeId',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.deleteDraftNode({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    nodeId,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'connect':
            case 'disconnect': {
              const from = optionalString(raw.from)
              const to = optionalString(raw.to)
              if (!draftId || !from || !to) {
                return errorResult(
                  `workflow_edit action=${action} requires draftId, from, and to`,
                )
              }
              const operation =
                action === 'connect'
                  ? matOSWorkflowService.connectDraftNodes
                  : matOSWorkflowService.disconnectDraftNodes
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await operation({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    from,
                    to,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'connect_transition': {
              const transition = workflowTransitionFromInput(raw.transition)
              if (!draftId || !transition) {
                return errorResult(
                  'workflow_edit action=connect_transition requires draftId and transition {from,to}',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.connectDraftTransition({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    transition,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'disconnect_transition': {
              const id = optionalString(raw.transitionId) ?? optionalString(raw.id)
              const from = optionalString(raw.from)
              const to = optionalString(raw.to)
              if (!draftId || (!id && !from && !to)) {
                return errorResult(
                  'workflow_edit action=disconnect_transition requires draftId and transitionId or from/to',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.disconnectDraftTransition({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    id,
                    from,
                    to,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'set_state_machine':
              if (!draftId) {
                return errorResult(
                  'workflow_edit action=set_state_machine requires draftId',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.setDraftStateMachine({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    disable: optionalBoolean(raw.disable),
                    initialNodeId: optionalString(raw.initialNodeId),
                    maxTransitions: optionalInteger(raw.maxTransitions),
                    maxFrames: optionalInteger(raw.maxFrames),
                  }) as unknown as Record<string, unknown>,
                ),
              )
            case 'set_parameters': {
              const rawParameters = raw.parameters
              const parameters =
                rawParameters === undefined
                  ? {}
                  : workflowParametersFromInput(rawParameters)
              const removeInput = raw.removeParameters ?? raw.removeParameterIds
              const remove = Array.isArray(removeInput)
                ? removeInput.filter((item): item is string => typeof item === 'string')
                : []
              const replace = optionalBoolean(raw.replace)
              if (!draftId) {
                return errorResult(
                  'workflow_edit action=set_parameters requires draftId',
                )
              }
              if (!parameters) {
                return errorResult(
                  'workflow_edit action=set_parameters requires parameter specs to be objects',
                )
              }
              if (
                Object.keys(parameters).length === 0 &&
                remove.length === 0 &&
                replace !== true
              ) {
                return errorResult(
                  'workflow_edit action=set_parameters requires parameters, removeParameters, or replace=true',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.setDraftParameters({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    parameters,
                    remove,
                    replace,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'set_outputs': {
              const outputs = workflowOutputsFromInput(raw.outputs)
              if (!draftId || !outputs) {
                return errorResult(
                  !draftId
                    ? 'workflow_edit action=set_outputs requires draftId (no editable draft found — call action=create_draft first)'
                    : 'workflow_edit action=set_outputs requires outputs (object keyed by output id, each value carrying a template reference such as {{ nodes.<nodeId>.outputs.<key> }})',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.setDraftOutputs({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    outputs,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'validate_draft': {
              if (!draftId) {
                return errorResult('workflow_edit action=validate_draft requires draftId')
              }
              const shown = await matOSWorkflowService.showDraft({
                cwd: context.cwd,
                scopeRef,
                draftId,
              })
              return jsonResult({
                draft: shown.draft,
                definition: shown.definition,
                validation: shown.validation,
              })
            }
            case 'compile_draft':
              if (!draftId) {
                return errorResult('workflow_edit action=compile_draft requires draftId')
              }
              return jsonResult(
                await matOSWorkflowService.compileDraft({
                  cwd: context.cwd,
                  scopeRef,
                  draftId,
                }),
              )
            case 'replace_definition': {
              // Large graphs inlined as tool arguments are the ones models
              // truncate; a file reference keeps the payload out of argv.
              const definitionInput = readDefinitionInput(context, raw)
              if (definitionInput.error) {
                return errorResult(
                  `workflow_edit action=replace_definition ${definitionInput.error}`,
                )
              }
              if (!draftId) {
                return errorResult(
                  'workflow_edit action=replace_definition requires draftId (no editable draft found — call action=create_draft first)',
                )
              }
              if (!definitionInput.definition) {
                return errorResult(
                  'workflow_edit action=replace_definition requires definition (inline object) or definitionFile (path to a JSON file with the full definition)',
                )
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.replaceDraftDefinition({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    definition: definitionInput.definition,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'import_component': {
              if (!draftId) {
                return errorResult(
                  'workflow_edit action=import_component requires draftId',
                )
              }
              const ref = optionalString(raw.ref)
              if (!ref) {
                return errorResult(
                  'workflow_edit action=import_component requires draftId and ref',
                )
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                compactDraftMutationResult(
                  raw,
                  await matOSWorkflowService.importComponent({
                    cwd: context.cwd,
                    scopeRef,
                    draftId,
                    ref,
                  }) as unknown as Record<string, unknown>,
                ),
              )
            }
            case 'publish_draft': {
              const id = optionalString(raw.id)
              if (!draftId) {
                return errorResult('workflow_edit action=publish_draft requires draftId')
              }
              const result = await matOSWorkflowService.publishDraft({
                  cwd: context.cwd,
                  scopeRef,
                  draftId,
                  id,
                  name: optionalString(raw.name),
                  version: optionalString(raw.version),
                  description: optionalString(raw.description),
                })
              rememberPublishedWorkflowResult(context, result)
              return jsonResult(result)
            }
            case 'attach_to_role': {
              const ref = optionalString(raw.ref)
              const roleRef = optionalString(raw.roleRef) ?? context.selectedRole
              if (!ref || !roleRef) {
                return errorResult(
                  'workflow_edit action=attach_to_role requires ref and roleRef (or selectedRole context)',
                )
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              const fingerprint = optionalString(raw.fingerprint)
              if (!fingerprint) {
                return jsonResult(
                  await previewMatOSWorkbenchWorkflowRoleAttachment({
                    cwd: context.cwd,
                    scopeRef,
                    ref,
                    roleRef,
                    request: raw.request ?? raw,
                  }) as unknown as Record<string, unknown>,
                )
              }
              return jsonResult(
                await applyMatOSWorkbenchWorkflowRoleAttachment({
                  cwd: context.cwd,
                  scopeRef,
                  ref,
                  roleRef,
                  request: raw.request ?? raw,
                  fingerprint,
                  reason: optionalString(raw.reason),
                }) as unknown as Record<string, unknown>,
              )
            }
            case 'fork_run': {
              const runId = optionalString(raw.runId)
              if (!runId) {
                return errorResult('workflow_edit action=fork_run requires runId')
              }
              {
                const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.forkRun({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                  id: optionalString(raw.id),
                  name: optionalString(raw.name),
                }),
              )
            }
            case 'save_trigger': {
              const ref = optionalString(raw.ref)
              if (!ref) {
                return errorResult('workflow_edit action=save_trigger requires ref')
              }
              if (!workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              return jsonResult(
                await matOSWorkflowService.saveTrigger({
                  cwd: context.cwd,
                  scopeRef,
                  workflowRef: ref,
                  request: raw.trigger ?? raw,
                }),
              )
            }
            case 'delete_trigger': {
              const triggerId = optionalString(raw.triggerId)
              if (!triggerId) {
                return errorResult(
                  'workflow_edit action=delete_trigger requires triggerId',
                )
              }
              const ref = optionalString(raw.ref)
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              if (!ref && effectiveAllowedWorkflowRefs(context).length > 0) {
                const payload = await matOSWorkflowService.trigger({
                  cwd: context.cwd,
                  scopeRef,
                  triggerId,
                })
                const denied = workflowTriggerDeniedMessage(
                  context,
                  payload as unknown as Record<string, unknown>,
                )
                if (denied) {
                  return errorResult(denied)
                }
              }
              return jsonResult(
                await matOSWorkflowService.deleteTrigger({
                  cwd: context.cwd,
                  scopeRef,
                  workflowRef: ref,
                  triggerId,
                  request: raw.trigger ?? raw,
                }),
              )
            }
            default:
              if (!action) {
                // An entirely empty input usually means the model/provider
                // dropped oversized tool arguments (typically a full inline
                // definition), not that the agent forgot the parameter.
                return errorResult(
                  Object.keys(raw).length === 0
                    ? 'workflow_edit received empty input — large tool arguments (for example a full inline definition) may have been dropped. Retry with an explicit action; for full definitions write the JSON to a file and call action=replace_definition with definitionFile, or make smaller node-level edits (add_manifest_node / update_node / set_outputs).'
                    : 'workflow_edit requires action',
                )
              }
              return errorResult(`Unsupported workflow_edit action: ${action}`)
          }
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]
}
