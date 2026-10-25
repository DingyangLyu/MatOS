import { loadMatOSRuntimeAssets as loadMatOSAssets } from '../../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../../assets/registry.js'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
} from '../../tools/matosToolRunner.js'
import type { MatOSWorkflowNode } from '../types.js'
import { currentMatOSWorkflowExecutionContext } from '../executionContext.js'
import { computeJobSpecForNode, computeToolRefForSpec } from './computeNode.js'
import {
  assertSafeMatOSAlgorithmComponentInput,
  matOSAlgorithmComponentConfigDigest,
  matOSAlgorithmComponentDeclarationForNode,
  parseMatOSAlgorithmDecisionReceipt,
  verifyMatOSAlgorithmComponentPin,
} from '../../algorithms/componentTool.js'
import { appendMatOSAlgorithmRunDecisionReference } from '../../algorithms/runDecisionRefs.js'
import { appendWorkflowEvent } from '../workflowStore.js'
import { scrubSecretsFromString } from '../../sessions/traceContext.js'

export type BackendNodeResult = {
  output: Record<string, unknown>
  stdout: string
  stderr: string
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function defaultToolForBackend(node: MatOSWorkflowNode): string {
  if (node.targetType === 'instrument') {
    // The instrument adapter contract requires an explicit tool asset ref;
    // validation enforces this before runs start.
    throw new Error(
      `Instrument node requires an explicit adapter tool asset ref: ${node.id}`,
    )
  }
  if (node.targetType === 'compute') {
    const computeToolRef = computeToolRefForSpec(computeJobSpecForNode(node))
    if (computeToolRef) {
      return computeToolRef
    }
  }

  throw new Error(`Backend node requires tool for backend: ${node.id}`)
}

function parseToolPayload(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return {}
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return { stdout }
  }
}

function componentErrorText(value: string): string {
  return scrubSecretsFromString(value)
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/gu, ' [redacted-path]')
    .slice(0, 1_000)
}

function structuredToolError(payload: unknown): string | undefined {
  const value = metadataObject(payload)
  for (const key of ['error', 'message', 'detail']) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) {
      return field.trim()
    }
  }
  return undefined
}

export function workflowBackendFailureDetail(options: {
  stderr: string
  stdout: string
  payload: unknown
  algorithmComponent?: boolean
}): string {
  const raw =
    options.stderr.trim() ||
    structuredToolError(options.payload) ||
    options.stdout.trim() ||
    'no diagnostic output'
  return options.algorithmComponent
    ? componentErrorText(raw)
    : scrubSecretsFromString(raw).slice(0, 1_000)
}

export async function runWorkflowBackendNode(
  node: MatOSWorkflowNode,
  options: { cwd: string },
): Promise<BackendNodeResult> {
  const toolRef = optionalString(node.tool) ?? defaultToolForBackend(node)
  const toolAllowlist = Array.isArray(node.toolAllowlist)
    ? node.toolAllowlist
        .map(item => optionalString(item))
        .filter((item): item is string => Boolean(item))
    : []
  if (toolAllowlist.length > 0 && !toolAllowlist.includes(toolRef)) {
    throw new Error(
      `MatOS backend tool is outside node toolAllowlist: ${toolRef}`,
    )
  }
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(options.cwd))
  const asset = registry.resolve(toolRef)
  if (!asset || asset.type !== 'tool') {
    throw new Error(`MatOS backend tool asset not found: ${toolRef}`)
  }
  const componentDeclaration = matOSAlgorithmComponentDeclarationForNode(node)
  const assetDeclaresAlgorithmDecision =
    asset.metadata.algorithmDecision !== undefined
  if (assetDeclaresAlgorithmDecision && !componentDeclaration) {
    throw new Error(
      `Algorithm-producing tool ${asset.canonicalKey} requires an explicit workflow node algorithmDecision declaration`,
    )
  }
  const execution = currentMatOSWorkflowExecutionContext()
  const componentPin = componentDeclaration
    ? execution?.algorithmComponentPins?.get(node.id)
    : undefined
  if (componentDeclaration && (!execution || !componentPin)) {
    throw new Error(
      `Algorithm component node ${node.id} cannot execute without an immutable run-manifest pin`,
    )
  }
  if (componentPin) {
    await verifyMatOSAlgorithmComponentPin({
      cwd: options.cwd,
      node,
      pin: componentPin,
    })
  }

  const [tool] = await loadMatOSToolDefinitions([asset.absolutePath])
  if (!tool) {
    throw new Error(`MatOS backend tool definition not found: ${toolRef}`)
  }

  const toolInput = metadataObject(node.input ?? node.toolInput ?? node.inputs)
  const effectiveInput: Record<string, unknown> = { ...toolInput }
  const idempotency = metadataObject(asset.metadata.workflowIdempotency)
  if (execution && effectiveInput.action === idempotency.action && typeof idempotency.field === 'string') {
    if (idempotency.field !== 'requestId') throw new Error('Unsupported workflow idempotency field')
    // The node identity survives retries/resume; attempt must not enter the key.
    // Nested workflow invocations own distinct run IDs.
    const requestId = `${execution.runId}:${node.id}`
    if (effectiveInput.requestId !== undefined && effectiveInput.requestId !== requestId) {
      throw new Error('Workflow submit requestId is owned by the native workflow runtime')
    }
    effectiveInput.requestId = requestId
  }
  if (componentPin) {
    assertSafeMatOSAlgorithmComponentInput(
      effectiveInput,
      `Workflow node ${node.id} algorithm component input`,
    )
  }
  const result = await callMatOSTool(tool, effectiveInput)
  const payload = parseToolPayload(result.stdout)
  const output = {
    ok: result.exitCode === 0,
    backend: optionalString(node.backend),
    toolRef,
    toolId: tool.id,
    exitCode: result.exitCode,
    payload,
  }
  if (result.exitCode !== 0) {
    const detail = workflowBackendFailureDetail({
      stderr: result.stderr,
      stdout: result.stdout,
      payload,
      algorithmComponent: Boolean(componentPin),
    })
    throw new Error(
      `${componentPin ? 'Algorithm component' : 'Backend'} tool failed: ${tool.id} (${result.exitCode ?? 'timeout'}): ${detail}`,
    )
  }
  if (componentPin && execution) {
    // Detect a same-version file replacement that occurred while the process
    // was running. The receipt is ignored unless both pre/post hashes match.
    await verifyMatOSAlgorithmComponentPin({
      cwd: options.cwd,
      node,
      pin: componentPin,
    })
    assertSafeMatOSAlgorithmComponentInput(
      payload,
      `Workflow node ${node.id} algorithm component output`,
    )
    const receipt = parseMatOSAlgorithmDecisionReceipt({
      payload,
      payloadBytes: Buffer.byteLength(result.stdout, 'utf8'),
      pin: componentPin,
      runId: execution.runId,
      nodeId: node.id,
      attempt: execution.attempt ?? 0,
      inputDigest: matOSAlgorithmComponentConfigDigest(effectiveInput),
    })
    try {
      await appendMatOSAlgorithmRunDecisionReference(execution.runDir, {
        schemaVersion: 1,
        decisionId: receipt.decisionId,
        providerDecisionId: receipt.providerDecisionId,
        at: new Date().toISOString(),
        runId: execution.runId,
        nodeId: node.id,
        attempt: receipt.attempt,
        providerId: componentPin.providerId,
        source: 'asset-tool',
        applied: true,
        algorithmPlane: componentPin.plane,
        providerVersion: componentPin.providerVersion,
        assetRef: componentPin.assetRef,
        configDigest: componentPin.configDigest,
        inputDigest: receipt.inputDigest,
        implementationDigest: componentPin.implementationDigest,
        manifestDigest: componentPin.manifestDigest,
        receiptDigest: receipt.receiptDigest,
        evaluationRefs: receipt.evaluationRefs,
        validationRefs: receipt.validationRefs,
        metricRefs: receipt.metricRefs,
      })
    } catch {
      // Learning evidence must never block a valid user-visible run. The
      // terminal outcome detects a completed component without its receipt
      // and marks that generation incomplete/training-ineligible.
      await appendWorkflowEvent(execution.runDir, {
        type: 'workflow.algorithm.decision_capture_failed',
        data: {
          nodeId: node.id,
          attempt: receipt.attempt,
          providerId: componentPin.providerId,
          reason: 'decision-reference-io',
        },
      }).catch(() => undefined)
    }
  }

  return {
    output,
    stdout: result.stdout,
    stderr: componentPin ? componentErrorText(result.stderr) : result.stderr,
  }
}
