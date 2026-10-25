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

import { MATOS_WORKFLOW_TOOL_NAMES } from '../../tools/toolNames.js'
import { matOSWorkflowService } from '../workflowService.js'
import type { MatOSWorkflowNode } from '../types.js'
import { spawnDetachedWorkflowAdvance } from '../detachedRunner.js'
import { registerWorkflowRunWatch } from '../runPulse.js'
import { buildWorkflowPreflight } from '../workflowPreflight.js'
import { createMatOSWorkflowQueryEditTools } from './workflowQueryEditTools.js'
import {
  WORKFLOW_RUNTIME_NODE_TYPES,
  WORKFLOW_SEMANTIC_NODE_TYPES,
  WORKFLOW_NODE_MANIFEST_SUMMARIES,
  compactWorkflowListResult,
  compactWorkflowRunEnvelopeForAgent,
  compactWorkflowToolValue,
  effectiveAllowedWorkflowRefs,
  effectiveSessionWorkflowRefs,
  errorResult,
  jsonResult,
  metadataObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  parseParams,
  parseResponse,
  rememberPublishedWorkflowResult,
  textSchema,
  withWorkflowToolResultSchemas,
  workflowAccessRestricted,
  filterWorkflowListForAllowedRefs,
  workflowRefAllowed,
  workflowRefDeniedMessage,
  workflowRunDeniedMessage,
  workflowNodeFromInput,
  workflowOutputsFromInput,
  workflowRunProvenanceFromInput,
  type MatOSWorkflowTool,
  type MatOSWorkflowToolContext,
  type MatOSWorkflowToolResult,
} from './workflowToolShared.js'

export type {
  MatOSWorkflowTool,
  MatOSWorkflowToolContext,
  MatOSWorkflowToolOutputSchema,
  MatOSWorkflowToolResult,
} from './workflowToolShared.js'

const TRACKED_CLI_HARNESS_OWNED_ACTIONS = new Set([
  'wait',
  'pause',
  'resume',
  'cancel',
  'retry_node',
  'skip_node',
  'reconcile',
  'recover_apply',
  'recover_drain',
  'patch_approve',
  'patch_reject',
  'patch_apply',
])

function trackedCliHarnessOwnedActionMessage(action: string): string {
  return (
    `workflow_run action=${action} is disabled while the tracked CLI harness owns execution. ` +
    'End the Agent segment after RUN_WORKFLOW_TRACKED.sh returns its durable handoff. ' +
    'Use status/inspect/events/artifacts/recover for read-only diagnosis; respond/approve/deny ' +
    'only for an explicitly waiting node; launch repaired or replacement work through the ' +
    'case-local RUN_WORKFLOW_TRACKED.sh.'
  )
}

export function createMatOSWorkflowTools(
  context: MatOSWorkflowToolContext,
): MatOSWorkflowTool[] {
  return withWorkflowToolResultSchemas([
    ...createMatOSWorkflowQueryEditTools(context),
    {
      name: 'workflow_context',
      description:
        'Show active MatOS workflow runtime context and available workflow tools.',
      inputSchema: textSchema({}),
      async call() {
        return jsonResult({
          cwd: context.cwd,
          selectedRole: context.selectedRole,
          workflowAccessMode:
            context.workflowAccessMode ?? (workflowAccessRestricted(context) ? 'role-mounted' : 'unrestricted'),
          allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
          sessionWorkflowRefs: effectiveSessionWorkflowRefs(context),
          workflowTools: [...MATOS_WORKFLOW_TOOL_NAMES],
          nodeTypes: [...WORKFLOW_RUNTIME_NODE_TYPES],
          semanticNodeTypes: [...WORKFLOW_SEMANTIC_NODE_TYPES],
          nodeManifests: WORKFLOW_NODE_MANIFEST_SUMMARIES,
          authoringGuidance: [
            'Use workflow_create_draft, workflow_add_node, workflow_connect, workflow_set_outputs, workflow_validate_draft, and workflow_publish_draft for native authoring.',
            'Use workflow_query action=manifest to inspect required fields before add_manifest_node; use workflow_run action=preflight or dryRun=true before executing unfamiliar workflows.',
            'Use workflow_compile before run/publish to inspect compiled node contracts, graph diagnostics, risk, and budget estimates.',
            'Declare custom node outputs with outputContract; node.outputs is UI-like metadata and is not the runtime contract checked by downstream template references.',
            'Backend/compute nodes expose their tool result under payload. Reference generated YAML and submit metadata as {{ nodes.generate_yaml.outputs.payload.yamlPath }} and {{ nodes.generate_yaml.outputs.payload.submitArgs.expectedTaskDigest }}, not top-level yamlPath.',
            'For backend submit nodes that create remote jobs, set lifecycle: { reconcileOnResume: true, cancelOnWorkflowCancel: true } so workflow_reconcile, recovery, and cancellation can manage the remote task after submission.',
            'Guard/validate checks support expression, file_exists, file_size, grep, regex, numeric_range, and json_schema. Use regex with negate=true for forbidden fatal/non-finite text, file_size for non-empty artifacts, and numeric_range.notEqual for explicit sentinel rejection. Add failureCode, failureMessage, repairHint, retryable, and sourceNodeId so failures are directly actionable.',
            'When a failed validation check names sourceNodeId, repair and retry that causal producer even if it completed; retry_node invalidates only its affected downstream closure.',
            'After workflow_run writes submission artifacts, do not patch those files from stale reads. Put final metadata generation inside the workflow, or read the latest file before writing a full replacement.',
            'Use workflow_contracts to compare run artifacts against declared artifact contracts; downstream nodes and outputs can reference declared artifacts with {{ nodes.<nodeId>.artifacts.<artifactId>.path }}.',
            'Use compute semantic nodes for real materials/HPC work; they route through the existing backend/tool infrastructure.',
            'Tool/plugin/MCP/skill assets are mounted on agent roles or reached through exec/backend/compute adapters; do not model them as separate workflow node types.',
            'Use map or bounded loop nodes only with finite items/maxIterations and child workflow assets.',
            'Use workflow_pause, workflow_resume, workflow_reconcile, workflow_recover, workflow_recover_apply, workflow_recover_queue, workflow_recover_drain, workflow_retry_node, workflow_skip_node, workflow_artifacts, and workflow_events for lifecycle control, recovery, and debugging.',
            'To repair a failed run, propose a graph patch with workflow_patch_propose, then review it with workflow_patches/workflow_patch_inspect and gate it with workflow_patch_approve/workflow_patch_reject/workflow_patch_apply; or fork it with workflow_fork_run, edit the draft, and republish.',
          ],
        })
      },
    },
    {
      name: 'workflow_list',
      description:
        'List active MatOS workflow assets (compact capped rows with pagination; detail=full for complete rows).',
      inputSchema: textSchema({
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary (default) returns compact capped rows; full restores complete rows.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit row columns to return.',
        },
        query: {
          type: 'string',
          description: 'Substring match over id/name/description/tags.',
        },
        limit: { type: 'number', description: 'Optional page limit.' },
        offset: { type: 'number', description: 'Optional page offset.' },
      }),
      async call(input) {
        const raw = metadataObject(input)
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
      },
    },
    {
      name: 'workflow_show',
      description: 'Show a MatOS workflow definition by asset reference.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Workflow reference, for example workflow:relax.',
          },
        },
        ['ref'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const ref = optionalString(raw.ref) ?? ''
          if (!workflowRefAllowed(context, ref)) {
            return errorResult(workflowRefDeniedMessage(context, ref))
          }
          return jsonResult(
            await matOSWorkflowService.show({
              cwd: context.cwd,
              ref,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_validate',
      description: 'Validate a MatOS workflow definition by asset reference.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Workflow reference, for example workflow:relax.',
          },
        },
        ['ref'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const ref = optionalString(raw.ref) ?? ''
          if (!workflowRefAllowed(context, ref)) {
            return errorResult(workflowRefDeniedMessage(context, ref))
          }
          return jsonResult(
            await matOSWorkflowService.validate({
              cwd: context.cwd,
              ref,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_run',
      description:
        'Compact MatOS workflow execution/control tool. Omit action or use action=start with ref or draftId to start a run; add wait=false to start long-running workflows in a detached background worker and return the runId immediately, then block for progress with action=wait (bounded long-poll with heartbeat, progress, new events, and next-step guidance — prefer it over status-poll loops); use action=preflight or dryRun=true for static checks without execution. retry_node can retry an explicitly identified causal producer even if it completed, invalidating only its affected downstream closure. Use action=status|inspect|events|artifacts|respond|approve|deny|approval_status|pause|resume|cancel|retry_node|skip_node|reconcile|recover|recover_apply|recover_queue|recover_drain|patch_propose|patch_inspect|patch_approve|patch_reject|patch_apply for lifecycle control. Run views are compact by default (node outputs/errors bounded with previews); use action=inspect nodeId=<id> for one node\'s full payload, detail=full for an uncompacted view, and events tail=<n> for a longer event window.',
      inputSchema: textSchema(
        {
          action: {
            type: 'string',
            enum: [
              'start',
              'preflight',
              'wait',
              'status',
              'inspect',
              'events',
              'artifacts',
              'respond',
              'approve',
              'deny',
              'approval_status',
              'pause',
              'resume',
              'cancel',
              'retry_node',
              'skip_node',
              'reconcile',
              'recover',
              'recover_apply',
              'recover_queue',
              'recover_drain',
              'patch_propose',
              'patch_inspect',
              'patch_approve',
              'patch_reject',
              'patch_apply',
            ],
            description: 'Run operation. Defaults to start for backward compatibility.',
          },
          ref: { type: 'string', description: 'Workflow asset reference.' },
          draftId: { type: 'string', description: 'Workflow draft id for action=preflight.' },
          params: { type: 'object', description: 'Workflow parameters.' },
          dryRun: {
            type: 'boolean',
            description: 'When true with action=start, run preflight only and do not execute the workflow.',
          },
          wait: {
            type: 'boolean',
            description:
              'With action=start: when false, create the run, hand execution to a detached background worker, and return the runId immediately instead of blocking until the workflow finishes. Required for long-running workflows (DFT/HPC/compute pipelines) so the agent turn and its tool-call watchdog are not blocked; follow up with action=wait (bounded long-poll) instead of status-poll loops. Defaults to true (block until the run reaches a terminal or waiting state).',
          },
          provenance: {
            type: 'object',
            description:
              'Optional run provenance: source, triggerId, triggerEventId, triggerAppId, payloadDigest, parentRunId.',
          },
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Workflow node id.' },
          timeoutSeconds: {
            type: 'number',
            description:
              'With action=wait: max seconds to block for the next run transition (default 60, max 600). On timeout the call returns the current pulse with timedOut=true — call wait again to keep watching.',
          },
          sinceEventId: {
            type: 'string',
            description:
              'With action=wait: event cursor from the previous wait result (nextSinceEventId) so newEvents only carries unseen events.',
          },
          response: {
            type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
            description: 'Response payload for human/approval nodes.',
          },
          approvedFingerprint: {
            type: 'string',
            description: 'Expected approval fingerprint.',
          },
          reason: { type: 'string', description: 'Reason for denial/skip/patch.' },
          failedChildrenOnly: {
            type: 'boolean',
            description: 'Retry only failed map/loop children when supported.',
          },
          operations: {
            type: 'array',
            description: 'Patch operations for action=patch_propose.',
            items: { type: 'object', additionalProperties: true },
          },
          patchId: { type: 'string', description: 'Dynamic graph patch id.' },
          risk: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Declared patch risk.',
          },
          sourceNodeId: {
            type: 'string',
            description: 'Optional source node id for patch proposals.',
          },
          detail: {
            type: 'string',
            enum: ['full'],
            description:
              'detail=full disables run-view compaction (full node outputs/errors). Default responses keep node payloads bounded with previews; prefer action=inspect nodeId=<id> to fetch one node\'s full payload instead of the whole run.',
          },
          tail: {
            type: 'number',
            description:
              'With action=events: number of most recent events to return (default 100, max 1000).',
          },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        [],
      ),
      async call(input, callContext) {
        try {
          const raw = metadataObject(input)
          const action = optionalString(raw.action) ?? 'start'
          const scopeRef = optionalString(raw.scope)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (
            context.workflowStartPolicy === 'tracked-cli-only' &&
            TRACKED_CLI_HARNESS_OWNED_ACTIONS.has(action)
          ) {
            return errorResult(trackedCliHarnessOwnedActionMessage(action))
          }
          if (action !== 'start' && runId) {
            const denied = await workflowRunDeniedMessage({ context, scopeRef, runId })
            if (denied) {
              return errorResult(denied)
            }
          }

          switch (action) {
            case 'preflight': {
              const ref = optionalString(raw.ref)
              const draftId = optionalString(raw.draftId)
              if (!ref && !draftId) {
                return errorResult('workflow_run action=preflight requires ref or draftId')
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
            case 'start': {
              const ref = optionalString(raw.ref)
              const draftId = optionalString(raw.draftId)
              if (!ref && !draftId) {
                return errorResult('workflow_run action=start requires ref or draftId')
              }
              if (ref && !workflowRefAllowed(context, ref)) {
                return errorResult(workflowRefDeniedMessage(context, ref))
              }
              if (optionalBoolean(raw.dryRun) === true) {
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
              if (context.workflowStartPolicy === 'tracked-cli-only') {
                return errorResult(
                  'Direct workflow_run start is disabled for this tracked execution. Use the case-local RUN_WORKFLOW_TRACKED.sh launcher; after it reports a durable handoff, do not wait or poll and end the Agent segment so the harness can resume it.',
                )
              }
              // wait=false: deferred start. Create the run (validated and
              // persisted, status=created), hand execution to a detached
              // `matos workflow resume` worker, and return immediately so a
              // long workflow (DFT/HPC pipeline) cannot stall the agent turn
              // until a chat-run inactivity watchdog kills it.
              const detachRequested = optionalBoolean(raw.wait) === false
              const startInput = {
                cwd: context.cwd,
                scopeRef,
                parameters: parseParams(raw.params),
                recordSession: false,
                provenance: workflowRunProvenanceFromInput(
                  raw.provenance,
                  'agent_tool',
                ),
                ...(detachRequested ? { advance: false as const } : {}),
              }
              const started = draftId
                ? await matOSWorkflowService.runDraft({ ...startInput, draftId })
                : await matOSWorkflowService.run({ ...startInput, ref: ref ?? '' })
              if (!detachRequested) {
                return jsonResult(
                  compactWorkflowRunEnvelopeForAgent(started, {
                    detail: optionalString(raw.detail),
                  }),
                )
              }
              const sessionId = callContext ? callContext.sessionId : process.env.MATOS_WORKFLOW_SESSION_ID
              const detach = spawnDetachedWorkflowAdvance({
                cwd: context.cwd,
                scopeRef,
                sessionId,
                run: started.run,
              })
              // Register for push notification: an interactive session's run
              // watcher injects terminal/waiting/stalled transitions back into
              // the agent, so a forgotten run still surfaces.
              await registerWorkflowRunWatch({
                cwd: context.cwd,
                sessionId,
                runId: started.run.runId,
                runDir: started.run.runDir,
                workflowRef: ref ?? undefined,
              })
              return jsonResult({
                ...compactWorkflowRunEnvelopeForAgent(started, {
                  detail: optionalString(raw.detail),
                }),
                detached: detach.ok,
                ...(detach.ok === false
                  ? {
                      detachError: detach.error,
                      note:
                        `Run ${started.run.runId} was created but the background worker failed to start. ` +
                        'Advance it with workflow_run action=resume runId=... or `matos workflow resume <runId>`.',
                    }
                  : {
                      note:
                        `Workflow run ${started.run.runId} is executing in a detached background worker. ` +
                        `Block for its next transition with workflow_run action=wait runId=${started.run.runId} ` +
                        '(bounded long-poll, default 60s, returns progress + new events + guidance). ' +
                        'In an interactive session you will also be notified automatically when the run finishes, fails, stalls, or needs input.',
                    }),
              })
            }
            case 'wait': {
              if (!runId) {
                return errorResult('workflow_run action=wait requires runId')
              }
              const rawTimeout = raw.timeoutSeconds
              const timeoutSeconds =
                typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
                  ? rawTimeout
                  : undefined
              const waited = await matOSWorkflowService.wait({
                cwd: context.cwd,
                scopeRef,
                runId,
                timeoutSeconds,
                sinceEventId: optionalString(raw.sinceEventId),
              })
              return jsonResult(waited as unknown as Record<string, unknown>)
            }
            case 'status': {
              if (!runId) {
                return errorResult('workflow_run action=status requires runId')
              }
              const status = await matOSWorkflowService.status({
                cwd: context.cwd,
                scopeRef,
                runId,
              })
              // The raw run view answers "what is the state"; the pulse
              // answers "is anything still alive and what should I do next".
              const pulse = await matOSWorkflowService
                .pulse({ cwd: context.cwd, scopeRef, runId })
                .then(result => result.pulse)
                .catch(() => undefined)
              return jsonResult({
                ...compactWorkflowRunEnvelopeForAgent(status, {
                  detail: optionalString(raw.detail),
                }),
                ...(pulse ? { pulse } : {}),
              })
            }
            case 'inspect': {
              if (!runId) {
                return errorResult('workflow_run action=inspect requires runId')
              }
              const inspected = await matOSWorkflowService.inspect({
                cwd: context.cwd,
                scopeRef,
                runId,
              })
              // Per-node drill-down: the full output/error payload for one
              // node without shipping every node's payload into context.
              if (nodeId) {
                const run = metadataObject(inspected.run as unknown)
                const nodes = Array.isArray(run.nodes) ? run.nodes : []
                const node = nodes.find(
                  candidate => metadataObject(candidate).nodeId === nodeId,
                )
                if (!node) {
                  return errorResult(
                    `workflow_run action=inspect: node ${nodeId} has no run record in ${runId}`,
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
                return errorResult('workflow_run action=events requires runId')
              }
              const eventsResult = await matOSWorkflowService.events({
                cwd: context.cwd,
                scopeRef,
                runId,
              })
              const allEvents = Array.isArray(eventsResult.events)
                ? eventsResult.events
                : []
              // Bounded tail by default: event logs grow for the run's whole
              // life, and agents almost always want the most recent activity.
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
                return errorResult('workflow_run action=artifacts requires runId')
              }
              return jsonResult(
                await matOSWorkflowService.artifacts({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                }),
              )
            case 'respond':
              if (!runId || !nodeId) {
                return errorResult('workflow_run action=respond requires runId and nodeId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.respond({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    nodeId,
                    response: parseResponse(raw.response),
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'approve':
              if (!runId || !nodeId) {
                return errorResult('workflow_run action=approve requires runId and nodeId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.approve({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    nodeId,
                    fingerprint: optionalString(raw.approvedFingerprint),
                    response: parseResponse(raw.response),
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'deny':
              if (!runId || !nodeId) {
                return errorResult('workflow_run action=deny requires runId and nodeId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.deny({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    nodeId,
                    reason: optionalString(raw.reason),
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'approval_status':
              if (!runId) {
                return errorResult('workflow_run action=approval_status requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  (await matOSWorkflowService.approvalStatus({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                  })) as Record<string, unknown>,
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'pause':
              if (!runId) {
                return errorResult('workflow_run action=pause requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.pause({ cwd: context.cwd, scopeRef, runId }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'resume':
              if (!runId) {
                return errorResult('workflow_run action=resume requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.resume({ cwd: context.cwd, scopeRef, runId }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'cancel':
              if (!runId) {
                return errorResult('workflow_run action=cancel requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.cancel({ cwd: context.cwd, scopeRef, runId }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'retry_node':
              if (!runId || !nodeId) {
                return errorResult(
                  'workflow_run action=retry_node requires runId and nodeId',
                )
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.retryNode({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    nodeId,
                    failedChildrenOnly: optionalBoolean(raw.failedChildrenOnly),
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'skip_node':
              if (!runId || !nodeId) {
                return errorResult(
                  'workflow_run action=skip_node requires runId and nodeId',
                )
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.skipNode({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    nodeId,
                    reason: optionalString(raw.reason),
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'reconcile':
              if (!runId) {
                return errorResult('workflow_run action=reconcile requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  await matOSWorkflowService.reconcile({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                  }),
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'recover':
              if (!runId) {
                return errorResult('workflow_run action=recover requires runId')
              }
              return jsonResult(
                await matOSWorkflowService.recover({ cwd: context.cwd, scopeRef, runId }),
              )
            case 'recover_apply':
              if (!runId) {
                return errorResult('workflow_run action=recover_apply requires runId')
              }
              return jsonResult(
                compactWorkflowRunEnvelopeForAgent(
                  (await matOSWorkflowService.recoverApply({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                  })) as Record<string, unknown>,
                  { detail: optionalString(raw.detail) },
                ),
              )
            case 'recover_queue':
              return jsonResult(
                await matOSWorkflowService.recoverQueue({
                  cwd: context.cwd,
                  scopeRef,
                  allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
                }) as Record<string, unknown>,
              )
            case 'recover_drain':
              return jsonResult(
                await matOSWorkflowService.recoverDrain({
                  cwd: context.cwd,
                  scopeRef,
                  allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
                }) as Record<string, unknown>,
              )
            case 'patch_propose': {
              const operations = Array.isArray(raw.operations)
                ? raw.operations
                : undefined
              if (!runId || !operations) {
                return errorResult(
                  'workflow_run action=patch_propose requires runId and operations[]',
                )
              }
              const risk = optionalString(raw.risk)
              const result = await matOSWorkflowService.patchPropose({
                cwd: context.cwd,
                scopeRef,
                runId,
                operations,
                reason: optionalString(raw.reason),
                ...(risk === 'low' || risk === 'medium' || risk === 'high'
                  ? { risk }
                  : {}),
                sourceNodeId: optionalString(raw.sourceNodeId),
              })
              if (!result.ok) {
                return errorResult(
                  `workflow_run patch_propose validation failed: ${result.errors
                    .map(error => `${error.code}: ${error.message}`)
                    .join('; ')}`,
                )
              }
              return jsonResult({ ...result })
            }
            case 'patch_inspect':
            case 'patch_approve':
            case 'patch_reject':
            case 'patch_apply': {
              const patchId = optionalString(raw.patchId)
              if (!runId || !patchId) {
                return errorResult(
                  `workflow_run action=${action} requires runId and patchId`,
                )
              }
              if (action === 'patch_inspect') {
                return jsonResult(
                  await matOSWorkflowService.patchInspect({
                    cwd: context.cwd,
                    scopeRef,
                    runId,
                    patchId,
                  }),
                )
              }
              const operation =
                action === 'patch_approve'
                  ? matOSWorkflowService.patchApprove
                  : action === 'patch_reject'
                    ? matOSWorkflowService.patchReject
                    : matOSWorkflowService.patchApply
              return jsonResult(
                await operation({
                  cwd: context.cwd,
                  scopeRef,
                  runId,
                  patchId,
                  reason: optionalString(raw.reason),
                  decidedBy: 'agent',
                }),
              )
            }
            default:
              return errorResult(`Unsupported workflow_run action: ${action}`)
          }
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_compile',
      description:
        'Compile a MatOS workflow and return normalized contracts, diagnostics, risk, and budget estimates without running it.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Workflow reference, for example workflow:relax. Omit when compiling a draft.',
          },
          draftId: {
            type: 'string',
            description: 'Editable workflow draft id to compile before publishing.',
          },
          scope: {
            type: 'string',
            description: 'Optional runtime scope ref.',
          },
        },
        [],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          if (draftId) {
            return jsonResult(
              await matOSWorkflowService.compileDraft({
                cwd: context.cwd,
                scopeRef: optionalString(raw.scope),
                draftId,
              }),
            )
          }
          const ref = optionalString(raw.ref) ?? ''
          if (!workflowRefAllowed(context, ref)) {
            return errorResult(workflowRefDeniedMessage(context, ref))
          }
          return jsonResult(
            await matOSWorkflowService.compile({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              ref,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_contracts',
      description:
        'Inspect compiled workflow contracts for an asset, draft, or run, including declared artifact contract status.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Workflow asset reference, for example workflow:relax.',
          },
          draftId: {
            type: 'string',
            description: 'Editable workflow draft id.',
          },
          runId: {
            type: 'string',
            description: 'Workflow run id to compare against produced artifacts.',
          },
          scope: {
            type: 'string',
            description: 'Optional runtime scope ref.',
          },
        },
        [],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const scopeRef = optionalString(raw.scope)
          const ref = optionalString(raw.ref)
          if (ref && !workflowRefAllowed(context, ref)) {
            return errorResult(workflowRefDeniedMessage(context, ref))
          }
          const runId = optionalString(raw.runId)
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
              draftId: optionalString(raw.draftId),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_compile_inspect',
      description:
        'Inspect the compiled workflow snapshot stored for a completed or in-progress run.',
      inputSchema: textSchema(
        {
          runId: {
            type: 'string',
            description: 'Workflow run id.',
          },
          scope: {
            type: 'string',
            description: 'Optional runtime scope ref.',
          },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_compile_inspect requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.compileInspect({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_status',
      description: 'Show current status for a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        return inspectRunTool(context, input)
      },
    },
    {
      name: 'workflow_inspect',
      description: 'Inspect a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        return inspectRunTool(context, input)
      },
    },
    {
      name: 'workflow_events',
      description: 'List append-only events for a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_events requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.events({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_artifacts',
      description:
        'List durable artifact references recorded for a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_artifacts requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.artifacts({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patches',
      description:
        'List durable dynamic graph patch ledger entries for a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_patches requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.patches({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patch_propose',
      description:
        'Propose a dynamic graph patch against a MatOS workflow run from outside a dynamic node. Validates the operations against the run graph, records a "proposed" ledger entry, and returns it for review/approval/apply. Use this to repair a failed run without forking and republishing.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id to patch.' },
          operations: {
            type: 'array',
            description:
              'Graph patch operations: add_node, update_node, add_edge, remove_edge, set_outputs (delete_node is rejected for active runs).',
            items: { type: 'object', additionalProperties: true },
          },
          reason: {
            type: 'string',
            description: 'Why this patch is proposed (failure summary or fix rationale).',
          },
          risk: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Optional declared risk; the effective risk is recomputed from the operations.',
          },
          sourceNodeId: {
            type: 'string',
            description: 'Optional node id the patch relates to.',
          },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'operations'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const operations = Array.isArray(raw.operations)
            ? raw.operations
            : undefined
          if (!runId || !operations) {
            return errorResult(
              'workflow_patch_propose requires runId and a non-empty operations[] array',
            )
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          const risk = optionalString(raw.risk)
          const result = await matOSWorkflowService.patchPropose({
            cwd: context.cwd,
            scopeRef: optionalString(raw.scope),
            runId,
            operations,
            reason: optionalString(raw.reason),
            ...(risk === 'low' || risk === 'medium' || risk === 'high'
              ? { risk }
              : {}),
            sourceNodeId: optionalString(raw.sourceNodeId),
          })
          if (!result.ok) {
            return errorResult(
              `workflow_patch_propose validation failed: ${result.errors
                .map(error => `${error.code}: ${error.message}`)
                .join('; ')}`,
            )
          }
          return jsonResult({ ...result })
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patch_inspect',
      description:
        'Inspect one durable dynamic graph patch ledger entry for a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          patchId: { type: 'string', description: 'Dynamic graph patch id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'patchId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const patchId = optionalString(raw.patchId)
          if (!runId || !patchId) {
            return errorResult('workflow_patch_inspect requires runId and patchId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.patchInspect({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              patchId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patch_approve',
      description:
        'Approve a proposed dynamic graph patch ledger entry without applying it yet.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          patchId: { type: 'string', description: 'Dynamic graph patch id.' },
          reason: { type: 'string', description: 'Optional approval reason.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'patchId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const patchId = optionalString(raw.patchId)
          if (!runId || !patchId) {
            return errorResult('workflow_patch_approve requires runId and patchId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.patchApprove({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              patchId,
              reason: optionalString(raw.reason),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patch_reject',
      description:
        'Reject a proposed dynamic graph patch ledger entry and fail the waiting dynamic node.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          patchId: { type: 'string', description: 'Dynamic graph patch id.' },
          reason: { type: 'string', description: 'Optional rejection reason.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'patchId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const patchId = optionalString(raw.patchId)
          if (!runId || !patchId) {
            return errorResult('workflow_patch_reject requires runId and patchId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.patchReject({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              patchId,
              reason: optionalString(raw.reason),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_patch_apply',
      description:
        'Apply an approved dynamic graph patch ledger entry and resume the workflow scheduler.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          patchId: { type: 'string', description: 'Dynamic graph patch id.' },
          reason: { type: 'string', description: 'Optional apply reason.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'patchId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const patchId = optionalString(raw.patchId)
          if (!runId || !patchId) {
            return errorResult('workflow_patch_apply requires runId and patchId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.patchApply({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              patchId,
              reason: optionalString(raw.reason),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_approval_status',
      description:
        'Return pending workflow approval nodes with action fingerprints and resolved action input summaries.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        return approvalStatusTool(context, input)
      },
    },
    {
      name: 'workflow_respond',
      description: 'Respond to a waiting human node in a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Waiting node id.' },
          response: { description: 'Structured response or text.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (!runId || !nodeId) {
            return errorResult('workflow_respond requires runId and nodeId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.respond({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              nodeId,
              response: parseResponse(raw.response),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_approve',
      description: 'Approve a waiting backend or policy-gated workflow node.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Waiting approval node id.' },
          approvedFingerprint: {
            type: 'string',
            description: 'Optional expected action fingerprint to verify.',
          },
          response: { description: 'Structured approval response.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (!runId || !nodeId) {
            return errorResult('workflow_approve requires runId and nodeId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.approve({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              nodeId,
              fingerprint: optionalString(raw.approvedFingerprint),
              response: parseResponse(raw.response),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_deny',
      description: 'Deny a waiting backend or policy-gated workflow node.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Waiting approval node id.' },
          reason: { type: 'string', description: 'Denial reason.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (!runId || !nodeId) {
            return errorResult('workflow_deny requires runId and nodeId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.deny({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              nodeId,
              reason: optionalString(raw.reason),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_create_draft',
      description:
        'Create an editable MatOS workflow draft for agent- or user-authored workflow evolution.',
      inputSchema: textSchema({
        id: { type: 'string', description: 'Optional stable draft id.' },
        name: { type: 'string', description: 'Draft workflow name.' },
        version: { type: 'string', description: 'Optional workflow version.' },
        description: { type: 'string', description: 'Optional draft description.' },
        scope: { type: 'string', description: 'Optional runtime scope ref.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          return jsonResult(
            await matOSWorkflowService.createDraft({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              id: optionalString(raw.id),
              name: optionalString(raw.name),
              version: optionalString(raw.version),
              description: optionalString(raw.description),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_show_draft',
      description: 'Show an editable MatOS workflow draft definition and provenance.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          if (!draftId) {
            return errorResult('workflow_show_draft requires draftId')
          }
          return jsonResult(
            await matOSWorkflowService.showDraft({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_add_node',
      description:
        'Add one node to an editable MatOS workflow draft. Native runtime node types are agent, exec, guard, human, backend, subworkflow, map, and loop. Semantic node types compute, approval_gate, validate, and supernode are compiled into native runtime nodes. Exec nodes stream-detect narrow fatal process signatures by default; set detectKnownProcessFailures=false only for diagnostic/log-replay commands that intentionally print fatal logs. Guard/validate checks support expression, file_exists, file_size, grep, regex, numeric_range, and json_schema. Use regex negate=true for forbidden text, numeric_range.notEqual for sentinels, and failureCode/repairHint/sourceNodeId for actionable feedback. Relative file paths resolve under the workflow workspace; keep producer and validator paths consistent.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          node: { type: 'object', description: 'Complete workflow node object.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'node'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const node = workflowNodeFromInput(raw.node)
          if (!draftId || !node) {
            return errorResult('workflow_add_node requires draftId and node')
          }
          return jsonResult(
            await matOSWorkflowService.addDraftNode({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              node,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_update_node',
      description:
        'Patch one node in an editable MatOS workflow draft. Prefer native top-level node fields. For real scientific jobs use compute/backend semantics; for repeated work use map or bounded loop with explicit child workflow references. Exec nodes stream-detect narrow fatal process signatures by default; diagnostic/log-replay commands may explicitly set detectKnownProcessFailures=false. Guard/validate checks support expression, file_exists, file_size, grep, regex, numeric_range, and json_schema; use failureCode and repairHint to make failed checks actionable and keep producer/validator paths consistent.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          nodeId: { type: 'string', description: 'Node id to update.' },
          patch: { type: 'object', description: 'Partial node fields to merge.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'nodeId', 'patch'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const nodeId = optionalString(raw.nodeId)
          if (!draftId || !nodeId) {
            return errorResult('workflow_update_node requires draftId and nodeId')
          }
          return jsonResult(
            await matOSWorkflowService.updateDraftNode({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              nodeId,
              patch: metadataObject(raw.patch) as Partial<MatOSWorkflowNode>,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_delete_node',
      description:
        'Delete one node from an editable MatOS workflow draft and remove incoming edges.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          nodeId: { type: 'string', description: 'Node id to delete.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const nodeId = optionalString(raw.nodeId)
          if (!draftId || !nodeId) {
            return errorResult('workflow_delete_node requires draftId and nodeId')
          }
          return jsonResult(
            await matOSWorkflowService.deleteDraftNode({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              nodeId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_connect',
      description:
        'Connect two draft nodes by adding the source node as a dependency of the target node.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          from: { type: 'string', description: 'Source dependency node id.' },
          to: { type: 'string', description: 'Target dependent node id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'from', 'to'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const from = optionalString(raw.from)
          const to = optionalString(raw.to)
          if (!draftId || !from || !to) {
            return errorResult('workflow_connect requires draftId, from, and to')
          }
          return jsonResult(
            await matOSWorkflowService.connectDraftNodes({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              from,
              to,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_disconnect',
      description:
        'Disconnect two draft nodes by removing the source dependency from the target node.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          from: { type: 'string', description: 'Source dependency node id.' },
          to: { type: 'string', description: 'Target dependent node id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'from', 'to'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const from = optionalString(raw.from)
          const to = optionalString(raw.to)
          if (!draftId || !from || !to) {
            return errorResult('workflow_disconnect requires draftId, from, and to')
          }
          return jsonResult(
            await matOSWorkflowService.disconnectDraftNodes({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              from,
              to,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_set_outputs',
      description:
        'Replace the outputs object for an editable MatOS workflow draft. Use templates like {{ nodes.<nodeId>.outputs.<field> }} and {{ nodes.<nodeId>.artifacts.<artifactId>.path }}; guard nodes expose outputs.ok, exec nodes expose outputs.exitCode/stdout/stderr, and steps.* templates are invalid.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          outputs: {
            type: 'object',
            description:
              'Workflow outputs object, for example {"ok":{"value":"{{ nodes.check_file.outputs.ok }}"}}.',
          },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'outputs'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const outputs = workflowOutputsFromInput(raw.outputs)
          if (!draftId || !outputs) {
            return errorResult('workflow_set_outputs requires draftId and outputs')
          }
          return jsonResult(
            await matOSWorkflowService.setDraftOutputs({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              outputs,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_validate_draft',
      description: 'Validate an editable MatOS workflow draft.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          if (!draftId) {
            return errorResult('workflow_validate_draft requires draftId')
          }
          const shown = await matOSWorkflowService.showDraft({
            cwd: context.cwd,
            scopeRef: optionalString(raw.scope),
            draftId,
          })
          return jsonResult({
            draft: shown.draft,
            definition: shown.definition,
            validation: shown.validation,
          })
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_import_component',
      description:
        'Import a reusable workflow component or workflow asset into an editable draft.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          ref: { type: 'string', description: 'Workflow asset reference to import.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId', 'ref'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const ref = optionalString(raw.ref)
          if (!draftId || !ref) {
            return errorResult('workflow_import_component requires draftId and ref')
          }
          if (!workflowRefAllowed(context, ref)) {
            return errorResult(workflowRefDeniedMessage(context, ref))
          }
          return jsonResult(
            await matOSWorkflowService.importComponent({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              ref,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_publish_draft',
      description:
        'Publish an editable workflow draft into the project MatOS workflow asset registry. The id may be bare (my-flow) or type-qualified (workflow:my-flow); when omitted, draftId is used. The returned published.assetKey is the canonical ref to run.',
      inputSchema: textSchema(
        {
          draftId: { type: 'string', description: 'Workflow draft id.' },
          id: {
            type: 'string',
            description:
              'Published workflow asset id, for example my-flow or workflow:my-flow.',
          },
          name: { type: 'string', description: 'Published workflow name.' },
          version: { type: 'string', description: 'Published workflow version.' },
          description: {
            type: 'string',
            description: 'Optional published workflow description.',
          },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['draftId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const draftId = optionalString(raw.draftId)
          const id = optionalString(raw.id)
          if (!draftId) {
            return errorResult('workflow_publish_draft requires draftId')
          }
          const result = await matOSWorkflowService.publishDraft({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              draftId,
              id,
              name: optionalString(raw.name),
              version: optionalString(raw.version),
              description: optionalString(raw.description),
            })
          rememberPublishedWorkflowResult(context, result)
          return jsonResult(result)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_fork_run',
      description: 'Fork a completed or in-progress workflow run graph into a draft.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          id: { type: 'string', description: 'Optional target draft id.' },
          name: { type: 'string', description: 'Optional draft workflow name.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_fork_run requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.forkRun({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              id: optionalString(raw.id),
              name: optionalString(raw.name),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_cancel',
      description: 'Cancel a MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_cancel requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.cancel({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_pause',
      description: 'Pause a MatOS workflow run between node executions.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_pause requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.pause({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_resume',
      description: 'Resume a paused MatOS workflow run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_resume requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.resume({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_reconcile',
      description:
        'Refresh submitted backend/compute job status and logs for a MatOS workflow run without resuming or replacing it.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_reconcile requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.reconcile({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_recover',
      description:
        'Inspect the recovery plan for a paused or failed MatOS workflow run (classifies recoverable nodes such as compute, approval, schema, and dynamic) without changing the run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_recover requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.recover({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_recover_apply',
      description:
        'Apply the recovery plan for a MatOS workflow run: reconcile submitted compute jobs and resume recoverable nodes so the run can continue.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          if (!runId) {
            return errorResult('workflow_recover_apply requires runId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            (await matOSWorkflowService.recoverApply({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
            })) as unknown as Record<string, unknown>,
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_recover_queue',
      description:
        'Refresh the MatOS workflow remote recovery queue, surfacing interrupted runs that are pending recovery in this scope.',
      inputSchema: textSchema({
        scope: { type: 'string', description: 'Optional runtime scope ref.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          return jsonResult(
            (await matOSWorkflowService.recoverQueue({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
            })) as unknown as Record<string, unknown>,
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_recover_drain',
      description:
        'Drain the MatOS workflow remote recovery queue by applying recovery to queued interrupted runs in this scope.',
      inputSchema: textSchema({
        scope: { type: 'string', description: 'Optional runtime scope ref.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          return jsonResult(
            (await matOSWorkflowService.recoverDrain({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              allowedWorkflowRefs: effectiveAllowedWorkflowRefs(context),
            })) as unknown as Record<string, unknown>,
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_retry_node',
      description:
        'Retry a failed, skipped, or cancelled MatOS workflow node and continue the run. A completed producer may also be retried when a failed downstream validation check explicitly identifies it with sourceNodeId; that invalidates and recomputes only the affected downstream closure.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Workflow node id to retry.' },
          failedChildrenOnly: {
            type: 'boolean',
            description:
              'For failed aggregate map nodes, retry only failed child workflows instead of rerunning successful children.',
          },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (!runId || !nodeId) {
            return errorResult('workflow_retry_node requires runId and nodeId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.retryNode({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              nodeId,
              failedChildrenOnly: optionalBoolean(raw.failedChildrenOnly),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'workflow_skip_node',
      description:
        'Skip a pending or failed MatOS workflow node and continue the run.',
      inputSchema: textSchema(
        {
          runId: { type: 'string', description: 'Workflow run id.' },
          nodeId: { type: 'string', description: 'Workflow node id to skip.' },
          reason: { type: 'string', description: 'Human-readable skip reason.' },
          scope: { type: 'string', description: 'Optional runtime scope ref.' },
        },
        ['runId', 'nodeId'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const runId = optionalString(raw.runId)
          const nodeId = optionalString(raw.nodeId)
          if (!runId || !nodeId) {
            return errorResult('workflow_skip_node requires runId and nodeId')
          }
          const denied = await runDeniedToolResult(context, raw, runId)
          if (denied) {
            return denied
          }
          return jsonResult(
            await matOSWorkflowService.skipNode({
              cwd: context.cwd,
              scopeRef: optionalString(raw.scope),
              runId,
              nodeId,
              reason: optionalString(raw.reason),
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ])
}

async function inspectRunTool(
  context: MatOSWorkflowToolContext,
  input: unknown,
): Promise<MatOSWorkflowToolResult> {
  try {
    const raw = metadataObject(input)
    const runId = optionalString(raw.runId)
    if (!runId) {
      return errorResult('workflow_inspect requires runId')
    }
    const denied = await runDeniedToolResult(context, raw, runId)
    if (denied) {
      return denied
    }
    return jsonResult(
      await matOSWorkflowService.inspect({
        cwd: context.cwd,
        scopeRef: optionalString(raw.scope),
        runId,
      }),
    )
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function approvalStatusTool(
  context: MatOSWorkflowToolContext,
  input: unknown,
): Promise<MatOSWorkflowToolResult> {
  try {
    const raw = metadataObject(input)
    const runId = optionalString(raw.runId)
    if (!runId) {
      return errorResult('workflow_approval_status requires runId')
    }
    const denied = await runDeniedToolResult(context, raw, runId)
    if (denied) {
      return denied
    }
    return jsonResult(
      (await matOSWorkflowService.approvalStatus({
        cwd: context.cwd,
        scopeRef: optionalString(raw.scope),
        runId,
      })) as Record<string, unknown>,
    )
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function runDeniedToolResult(
  context: MatOSWorkflowToolContext,
  raw: Record<string, unknown>,
  runId: string,
): Promise<MatOSWorkflowToolResult | undefined> {
  const denied = await workflowRunDeniedMessage({
    context,
    scopeRef: optionalString(raw.scope),
    runId,
  })
  return denied ? errorResult(denied) : undefined
}

function unsupportedWorkflowTool(name: string): MatOSWorkflowTool {
  return {
    name,
    description: `${name} is reserved for the workflow runtime control surface and is not implemented in this stage.`,
    inputSchema: textSchema({}),
    async call() {
      return errorResult(`${name} is not implemented in this stage`)
    },
  }
}
