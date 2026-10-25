import { createHash } from 'node:crypto'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

/**
 * S3 workflow-optimize: maps a workflow authoring/repair/optimization intent
 * to the agent role and task directive that `matos workflow
 * optimize|repair|draft from-task` dispatch through the headless runner.
 *
 * The baseline provider carries the exact directive text and default role
 * that previously lived inline in `src/matos/cli/workflow.ts`. Strategies can
 * research alternative repair/optimization prompting or role routing; an
 * explicit `--role` from the user always wins over the decided role at the
 * call site.
 */

export type MatOSWorkflowOptimizeIntent =
  | 'optimize'
  | 'repair'
  | 'draft-from-task'

export type MatOSWorkflowOptimizeFailedNode = {
  id: string
  status?: string
  error?: string
}

export type MatOSWorkflowOptimizeInput = {
  intent: MatOSWorkflowOptimizeIntent
  /** Target workflow ref for `optimize`. */
  workflowRef?: string
  /** Failed run id for `repair`. */
  runId?: string
  /** Natural-language task for `draft-from-task`. */
  task?: string
  failedNodes?: MatOSWorkflowOptimizeFailedNode[]
  evidence?: string
  /** The call site's default role for this intent. */
  defaultRole: string
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
}

export type MatOSWorkflowOptimizeDecision = {
  role: string
  directive: string
}

const MAX_DIRECTIVE_CHARS = 20_000

function repairDirective(input: MatOSWorkflowOptimizeInput): string {
  const runId = input.runId ?? ''
  const lines = [
    `Repair MatOS workflow run ${runId}.`,
    'Steps:',
    `1. Inspect the failed run with workflow_inspect (runId ${runId}) and workflow_events to understand the failure.`,
    '2. Decide the minimal reversible graph fix.',
    '3. Either propose a graph patch with workflow_patch_propose against this run, or fork it with workflow_fork_run, edit the draft with the workflow draft tools, validate, and publish.',
    '4. Validate the fix before claiming success and report the patch id or published workflow ref.',
  ]
  const failedNodes = input.failedNodes ?? []
  if (failedNodes.length > 0) {
    lines.push(
      `Failed nodes: ${failedNodes
        .map(
          node =>
            `${node.id}${node.status ? `(${node.status})` : ''}${node.error ? `: ${node.error}` : ''}`,
        )
        .join('; ')}`,
    )
  }
  if (input.evidence) {
    lines.push(`Additional evidence/context: ${input.evidence}`)
  }
  return lines.join('\n')
}

function draftFromTaskDirective(input: MatOSWorkflowOptimizeInput): string {
  return [
    `Build a MatOS workflow for this task: ${input.task ?? ''}`,
    'Steps:',
    '1. Create a draft with workflow_create_draft.',
    '2. Add nodes with workflow_add_node (agent/exec/guard/human/backend/compute/subworkflow/map/loop) and wire them with workflow_connect.',
    '3. Declare node outputs with outputContract when downstream nodes need custom fields; node.outputs is UI-like metadata and is not the runtime contract.',
    '4. For backend/compute nodes, reference tool payload fields through payload, for example {{ nodes.generate_yaml.outputs.payload.yamlPath }} and {{ nodes.generate_yaml.outputs.payload.submitArgs.expectedTaskDigest }}.',
    '5. For backend submit nodes that create remote jobs, set lifecycle: { reconcileOnResume: true, cancelOnWorkflowCancel: true } so workflow_reconcile, recovery, and cancellation can manage the remote task after submission.',
    '6. Guard checks must use type=expression/file_exists/file_size/grep/regex/numeric_range/json_schema. Use file_size for non-empty artifacts, regex with negate=true for forbidden markers such as NaN/Inf, numeric_range.notEqual for sentinel values, and failureCode/repairHint/sourceNodeId for actionable feedback. Stdout markers should use {{ nodes.<nodeId>.outputs.stdout }} contains "MARKER" or the normalized alias check=stdout_contains.',
    '7. Define workflow outputs with workflow_set_outputs.',
    '8. Validate with workflow_validate_draft and fix any errors.',
    '9. Publish with workflow_publish_draft and report the published asset ref, node count, edge count, and validation status.',
  ].join('\n')
}

function optimizeDirective(input: MatOSWorkflowOptimizeInput): string {
  const workflowRef = input.workflowRef ?? ''
  const lines = [
    `Optimize MatOS workflow ${workflowRef}.`,
    'Steps:',
    `1. Load it with workflow_show (${workflowRef}) and workflow_compile to review structure, contracts, risk, and budget.`,
    '2. Identify improvements to preflight/validation guards, retry policy, compute resource/profile parameters, routing, and artifact checks.',
    '3. Fork or create a draft, apply the improvements with the workflow draft tools, and validate it.',
    '4. Publish the optimized draft and report the new asset ref plus a concise summary of the changes.',
  ]
  if (input.evidence) {
    lines.push(`Optimization evidence/query: ${input.evidence}`)
  }
  return lines.join('\n')
}

function baselineWorkflowOptimize(
  input: MatOSWorkflowOptimizeInput,
): MatOSWorkflowOptimizeDecision {
  const directive =
    input.intent === 'repair'
      ? repairDirective(input)
      : input.intent === 'draft-from-task'
        ? draftFromTaskDirective(input)
        : optimizeDirective(input)
  return { role: input.defaultRole, directive }
}

function sanitizeWorkflowOptimize(
  decision: MatOSWorkflowOptimizeDecision,
  input: MatOSWorkflowOptimizeInput,
): MatOSWorkflowOptimizeDecision {
  const fallback = baselineWorkflowOptimize(input)
  const role =
    typeof decision.role === 'string' && decision.role.trim().length > 0
      ? decision.role.trim()
      : fallback.role
  const rawDirective =
    typeof decision.directive === 'string' && decision.directive.trim().length > 0
      ? decision.directive.trim()
      : fallback.directive
  const directive =
    rawDirective.length > MAX_DIRECTIVE_CHARS
      ? rawDirective.slice(0, MAX_DIRECTIVE_CHARS)
      : rawDirective
  return { role, directive }
}

export const matOSWorkflowOptimizeSurface = createMatOSAlgorithmSurface<
  MatOSWorkflowOptimizeInput,
  MatOSWorkflowOptimizeDecision
>({
  surfaceId: 'workflow-optimize',
  envVar: 'MATOS_ALGO_WORKFLOW_OPTIMIZE',
  baseline: {
    description:
      'Native workflow optimize/repair/draft directives dispatched to the default workflow roles.',
    decide: baselineWorkflowOptimize,
  },
  sanitizeDecision: sanitizeWorkflowOptimize,
  inputDigest: input =>
    createHash('sha256')
      .update(
        JSON.stringify({
          intent: input.intent,
          workflowRef: input.workflowRef,
          runId: input.runId,
          task: input.task,
          failedNodes: input.failedNodes,
          evidence: input.evidence,
          defaultRole: input.defaultRole,
        }),
      )
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    intent: input.intent,
    role: decision.role,
    directiveChars: decision.directive.length,
    ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  }),
})

export function decideMatOSWorkflowOptimize(
  input: MatOSWorkflowOptimizeInput,
): MatOSAlgorithmDecisionOutcome<MatOSWorkflowOptimizeDecision> {
  return matOSWorkflowOptimizeSurface.decideSync(input, {
    env: input.env,
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  })
}
