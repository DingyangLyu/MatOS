/**
 * Per-surface allowlists of decision-input fields that may leave the process
 * (exec strategy stdin, capture rows, frozen replay datasets).
 *
 * Runtime handles (registries, env maps, callbacks) and anything not listed
 * here are never serialized, so process secrets cannot leak into strategy
 * processes or dataset files.
 */

import {
  redactTraceValue,
  scrubSecretsFromString,
} from '../sessions/traceContext.js'

const SURFACE_INPUT_FIELDS: Record<string, readonly string[]> = {
  'evolution-policy': ['schemaVersion', 'phase', 'trigger', 'scopeRef', 'constraints', 'signals', 'candidate'],
  'context-ranking': [
    'kind',
    'index',
    'query',
    'assetTypes',
    'limit',
    'candidateKeys',
    'allowedTools',
  ],
  'approval-policy': ['baselineDecision', 'definition', 'node'],
  'workflow-optimize': [
    'intent',
    'workflowRef',
    'runId',
    'task',
    'failedNodes',
    'evidence',
    'defaultRole',
  ],
  'tool-selection': ['roleRef', 'allowedTools', 'disallowedTools'],
  'continuation-policy': [
    'baselineAction',
    'candidateActions',
    'requiredValidationPassed',
    'budgetExceeded',
    'replaySafe',
    'reason',
  ],
  'inference-routing': [
    'roleRef',
    'baselineRoute',
    'candidateRoutes',
    'taskClass',
    'remainingBudget',
  ],
  'asset-selection': [
    'roleRef',
    'candidateAssetKeys',
    'requiredAssetKeys',
    'maxAssets',
    'query',
  ],
  'verification-policy': [
    'requiredChecks',
    'candidateChecks',
    'maxAdditionalChecks',
  ],
  'recovery-policy': ['report', 'candidateActions'],
}

// Keep serialized rows bounded: a single capture row or exec stdin payload
// larger than this is dropped instead of written.
export const MATOS_ALGORITHM_SERIALIZED_INPUT_MAX_BYTES = 1024 * 1024

const MAX_SERIALIZED_DEPTH = 8
const MAX_SERIALIZED_KEYS = 256
const MAX_SERIALIZED_ARRAY = 1024
const MAX_SERIALIZED_STRING = 16 * 1024
const HOST_PATH_PATTERN =
  /(?:\b[A-Za-z]:\\[^\s"'<>]+|\/(?:tmp|home|root|opt|var|etc|usr|vepfs|mnt|workspace|workspaces)(?:\/[^\s"'<>]*)?)/g

function safeString(value: string): string {
  return scrubSecretsFromString(value)
    .replace(HOST_PATH_PATTERN, '[redacted-host-path]')
    .slice(0, MAX_SERIALIZED_STRING)
}

function safeSerializableValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SERIALIZED_DEPTH) return '[max-depth]'
  if (typeof value === 'string') return safeString(value)
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SERIALIZED_ARRAY)
      .map(item => safeSerializableValue(item, depth + 1))
  }
  if (!value || typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_SERIALIZED_KEYS)) {
    const sanitized = safeSerializableValue(item, depth + 1)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

function safeWorkflowDefinition(value: unknown): Record<string, unknown> {
  const definition =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const policy =
    definition.policy &&
    typeof definition.policy === 'object' &&
    !Array.isArray(definition.policy)
      ? (definition.policy as Record<string, unknown>)
      : {}
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  return {
    ...(typeof definition.name === 'string' ? { name: definition.name } : {}),
    ...(typeof definition.version === 'string'
      ? { version: definition.version }
      : {}),
    policy: {
      ...(policy.approvalMode !== undefined
        ? { approvalMode: policy.approvalMode }
        : {}),
      ...(policy.defaultRisk !== undefined
        ? { defaultRisk: policy.defaultRisk }
        : {}),
      ...(policy.budget !== undefined ? { budget: policy.budget } : {}),
    },
    nodes: nodes.slice(0, MAX_SERIALIZED_ARRAY).map(item => safeWorkflowNode(item)),
  }
}

function safeWorkflowNode(value: unknown): Record<string, unknown> {
  const node =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    ...(typeof node.id === 'string' ? { id: node.id } : {}),
    ...(typeof node.type === 'string' ? { type: node.type } : {}),
    ...(typeof node.runtimeType === 'string'
      ? { runtimeType: node.runtimeType }
      : {}),
    ...(typeof node.targetType === 'string'
      ? { targetType: node.targetType }
      : {}),
    ...(Array.isArray(node.dependsOn) ? { dependsOn: node.dependsOn } : {}),
    ...(node.policy && typeof node.policy === 'object'
      ? { policy: node.policy }
      : {}),
  }
}

function safeRecoveryReport(value: unknown): Record<string, unknown> {
  const report =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const evidence =
    report.evidence &&
    typeof report.evidence === 'object' &&
    !Array.isArray(report.evidence)
      ? (report.evidence as Record<string, unknown>)
      : {}
  return {
    ...(typeof report.runId === 'string' ? { runId: report.runId } : {}),
    ...(typeof report.workflowRef === 'string'
      ? { workflowRef: report.workflowRef }
      : {}),
    ...(typeof report.status === 'string' ? { status: report.status } : {}),
    ...(typeof report.classification === 'string'
      ? { classification: report.classification }
      : {}),
    ...(typeof report.recommendedAction === 'string'
      ? { recommendedAction: report.recommendedAction }
      : {}),
    ...(typeof report.nodeId === 'string' ? { nodeId: report.nodeId } : {}),
    evidence: {
      ...(Array.isArray(evidence.failedNodeIds)
        ? { failedNodeIds: evidence.failedNodeIds }
        : {}),
      ...(Array.isArray(evidence.runningNodeIds)
        ? { runningNodeIds: evidence.runningNodeIds }
        : {}),
      ...(Array.isArray(evidence.readyNodeIds)
        ? { readyNodeIds: evidence.readyNodeIds }
        : {}),
      ...(Array.isArray(evidence.pendingNodeIds)
        ? { pendingNodeIds: evidence.pendingNodeIds }
        : {}),
      ...(typeof evidence.eventCount === 'number'
        ? { eventCount: evidence.eventCount }
        : {}),
      ...(typeof evidence.artifactCount === 'number'
        ? { artifactCount: evidence.artifactCount }
        : {}),
    },
  }
}

export function matOSAlgorithmSurfaceInputFields(
  surfaceId: string,
): readonly string[] | undefined {
  return SURFACE_INPUT_FIELDS[surfaceId]
}

export function matOSAlgorithmSurfaceIsSerializable(
  surfaceId: string,
): boolean {
  return Boolean(SURFACE_INPUT_FIELDS[surfaceId])
}

export function serializeMatOSAlgorithmInput(
  surfaceId: string,
  input: unknown,
): Record<string, unknown> | undefined {
  const fields = SURFACE_INPUT_FIELDS[surfaceId]
  if (!fields) {
    return undefined
  }
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const payload: Record<string, unknown> = {}
  for (const field of fields) {
    if (source[field] !== undefined) {
      if (surfaceId === 'recovery-policy' && field === 'report') {
        payload[field] = safeRecoveryReport(source[field])
      } else if (surfaceId === 'approval-policy' && field === 'definition') {
        payload[field] = safeWorkflowDefinition(source[field])
      } else if (surfaceId === 'approval-policy' && field === 'node') {
        payload[field] = safeWorkflowNode(source[field])
      } else {
        payload[field] = source[field]
      }
    }
  }
  return safeSerializableValue(redactTraceValue(payload)) as Record<
    string,
    unknown
  >
}
