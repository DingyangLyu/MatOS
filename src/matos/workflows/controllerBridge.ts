import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  matOSWorkflowControllerBindingDigest,
  resolveMatOSWorkflowControllerBinding,
  workflowControllerFailureMode,
  type MatOSWorkflowControllerBinding,
} from '../algorithms/controllerBinding.js'
import {
  addMatOSControllerBudgetUsage,
  createMatOSControllerBudget,
  createMatOSControllerObservation,
  matOSControllerDigest,
  type MatOSControllerAction,
  type MatOSControllerObservationStatus,
} from '../algorithms/controllers/protocol.js'
import { JsonlMatOSControllerCheckpointStore } from '../algorithms/controllers/checkpoint.js'
import {
  MatOSControllerRegistryError,
  matOSControllerRegistry,
} from '../algorithms/controllers/registry.js'
import { createMatOSControllerRunner } from '../algorithms/controllers/runner.js'
import {
  appendBoundedControllerFile,
  assertControllerPathHasNoSymlinks,
  readBoundedControllerFile,
  withControllerFileLock,
} from '../algorithms/controllers/storeIo.js'
import {
  readMatOSAlgorithmRunManifest,
  type MatOSAlgorithmRunManifest,
} from '../algorithms/manifest.js'
import { recordMatOSAlgorithmRunDecisionReference } from '../algorithms/runDecisionRefs.js'
import {
  proposeWorkflowGraphPatch,
  type WorkflowGraphPatchOperation,
  type WorkflowGraphPatchRisk,
} from './dynamicPatch.js'
import {
  recoverWorkflowRun,
  workflowRecoveryReportDigest,
} from './recovery.js'
import { applyWorkflowRecoveryRecommendation } from './workflowRuntime.js'
import {
  MatOSControllerActionReceiptStore,
  type MatOSControllerActionReceipt,
} from './controllerActionReceipts.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowEvent,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunSnapshot,
  WorkflowArtifactRef,
} from './types.js'
import { readWorkflowArtifacts } from './runState.js'
import {
  appendWorkflowEvent,
  readWorkflowRun,
  readWorkflowRunEvents,
} from './workflowStore.js'
import {
  redactWorkflowControllerFailureText,
  type WorkflowReadySetAdvice,
  type WorkflowReadySetAdviceInput,
} from './runObservers.js'

type ControllerPatchFile = {
  operations: WorkflowGraphPatchOperation[]
  reason?: string
  risk?: WorkflowGraphPatchRisk
}

const CONTROLLER_PATCH_MAX_BYTES = 1024 * 1024
const CONTROLLER_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024

class MatOSWorkflowControllerPinMismatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MatOSWorkflowControllerPinMismatchError'
  }
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'controller'
}

function checkpointPath(runDir: string, providerId: string): string {
  return join(runDir, 'controllers', `${safeToken(providerId)}.checkpoints.jsonl`)
}

function graphVersion(path: string): number {
  const match = path.match(/\.v([0-9]+)\.json$/)
  return match ? Number(match[1]) : 1
}

function workflowStatus(status: MatOSWorkflowRunSnapshot['status']): MatOSControllerObservationStatus {
  if (status === 'waiting_input' || status === 'waiting_approval') return 'waiting'
  if (status === 'created') return 'running'
  return status
}

function eventCursor(events: readonly MatOSWorkflowEvent[]): string {
  return events.at(-1)?.id ?? 'workflow-event:0'
}

function evidenceRef(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`
}

function artifactReferences(artifacts: readonly WorkflowArtifactRef[]): string[] {
  return artifacts.map(artifact =>
    evidenceRef('artifact', {
      id: artifact.id,
      kind: artifact.kind,
      nodeId: artifact.nodeId,
      sha256: artifact.sha256,
      source: artifact.source,
    }),
  )
}

function validationReferences(input: {
  artifacts: readonly WorkflowArtifactRef[]
  events: readonly MatOSWorkflowEvent[]
}): string[] {
  const artifactRefs = input.artifacts
    .filter(artifact => artifact.source === 'validation')
    .map(artifact =>
      evidenceRef('validation-artifact', {
        id: artifact.id,
        nodeId: artifact.nodeId,
        sha256: artifact.sha256,
      }),
    )
  const eventRefs = input.events
    .filter(event => event.type.includes('validation'))
    .map(event => evidenceRef('validation-event', { id: event.id, type: event.type }))
  return [...new Set([...artifactRefs, ...eventRefs])]
}

function nodeRefsByStatus(
  nodeRuns: ReadonlyMap<string, MatOSWorkflowNodeRunSnapshot>,
  statuses: readonly MatOSWorkflowNodeRunSnapshot['status'][],
): string[] {
  const allowed = new Set(statuses)
  return [...nodeRuns.values()]
    .filter(node => allowed.has(node.status))
    .map(node => node.nodeId)
    .sort()
}

function manifestBindingMatches(
  manifest: MatOSAlgorithmRunManifest,
  binding: MatOSWorkflowControllerBinding,
): boolean {
  const pinned = manifest.controller
  return Boolean(
    pinned &&
      pinned.providerId === binding.providerId &&
      pinned.providerVersion === binding.providerVersion &&
      pinned.stateVersion === binding.stateVersion &&
      pinned.implementationDigest === binding.implementationDigest &&
      pinned.assetRef === binding.assetRef &&
      pinned.runtimeRef === binding.runtimeRef &&
      pinned.configDigest === binding.configDigest &&
      pinned.bindingDigest === matOSWorkflowControllerBindingDigest(binding),
  )
}

function resolveManifestPinnedControllerBinding(input: {
  definition: MatOSWorkflowDefinition
  workflowRef: string
  manifest: MatOSAlgorithmRunManifest
}): MatOSWorkflowControllerBinding | undefined {
  const policy = input.definition.policy.controller
  if (!policy || policy.enabled === false) return undefined
  const configuredVersion = policy.version?.trim()
  const pinnedProviderVersion = configuredVersion
    ? undefined
    : input.manifest.controller?.providerVersion
  if (!configuredVersion && !pinnedProviderVersion) {
    throw new Error(
      'Pinned algorithm manifest does not identify a controller provider version',
    )
  }
  try {
    return resolveMatOSWorkflowControllerBinding({
      definition: input.definition,
      workflowRef: input.workflowRef,
      ...(pinnedProviderVersion ? { pinnedProviderVersion } : {}),
    })
  } catch (error) {
    throw new MatOSWorkflowControllerPinMismatchError(
      'Pinned controller provider is unavailable or no longer matches the run',
      { cause: error },
    )
  }
}

function createManifestPinnedController(
  binding: MatOSWorkflowControllerBinding,
) {
  try {
    return matOSControllerRegistry.create({
      providerId: binding.providerId,
      version: binding.providerVersion,
      config: binding.config,
      seed: binding.seed,
      bounds: binding.bounds,
      expectedImplementationDigest: binding.implementationDigest,
      ...(binding.assetRef ? { expectedAssetRef: binding.assetRef } : {}),
      ...(binding.runtimeRef ? { expectedRuntimeRef: binding.runtimeRef } : {}),
    })
  } catch (error) {
    if (
      error instanceof MatOSControllerRegistryError &&
      (error.code === 'unknown-provider' ||
        error.message.includes('pinned implementation identity'))
    ) {
      throw new MatOSWorkflowControllerPinMismatchError(
        'Pinned controller provider changed before it could be instantiated',
        { cause: error },
      )
    }
    throw error
  }
}

async function buildObservation(input: {
  advice: WorkflowReadySetAdviceInput
  binding: MatOSWorkflowControllerBinding
  manifest: MatOSAlgorithmRunManifest
  store: JsonlMatOSControllerCheckpointStore
}) {
  const [events, artifacts, latest] = await Promise.all([
    readWorkflowRunEvents(input.advice.runDir),
    readWorkflowArtifacts(input.advice.runDir),
    input.store.latest({
      runRef: input.advice.snapshot.runId,
      scopeRef: input.advice.snapshot.trace?.scopeRef ?? 'user:local',
      controllerId: input.binding.providerId,
    }),
  ])
  const used = addMatOSControllerBudgetUsage(
    (latest?.actionSequence ?? []).map(item => item.action.budgetUsage),
  )
  return createMatOSControllerObservation({
    runRef: input.advice.snapshot.runId,
    scopeRef: input.advice.snapshot.trace?.scopeRef ?? 'user:local',
    eventCursor: eventCursor(events),
    status: workflowStatus(input.advice.snapshot.status),
    manifest: {
      ref: 'algorithm-manifest.json',
      digest: input.manifest.manifestDigest,
    },
    graph: {
      snapshotRef: input.advice.snapshot.graphSnapshotPath,
      digest: matOSControllerDigest(input.advice.definition),
      version: graphVersion(input.advice.snapshot.graphSnapshotPath),
    },
    readyNodeRefs: [...input.advice.readyNodeIds],
    runningNodeRefs: nodeRefsByStatus(input.advice.nodeRuns, ['running']),
    completedNodeRefs: nodeRefsByStatus(input.advice.nodeRuns, [
      'completed',
      'skipped',
    ]),
    failedNodeRefs: nodeRefsByStatus(input.advice.nodeRuns, [
      'failed',
      'cancelled',
    ]),
    artifactRefs: artifactReferences(artifacts),
    validationRefs: validationReferences({ artifacts, events }),
    budget: createMatOSControllerBudget({
      limits: input.binding.budgetLimits,
      used,
    }),
  })
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`))
}

async function readControllerPatchFile(input: {
  runDir: string
  candidateRef: string
  patchDigest: string
}): Promise<ControllerPatchFile> {
  const candidateRoot = resolve(input.runDir, 'controller-candidates')
  const path = resolve(input.runDir, input.candidateRef)
  if (!isWithin(candidateRoot, path)) {
    throw new Error('Controller graph patch candidate must be under controller-candidates/')
  }
  await assertControllerPathHasNoSymlinks({
    root: resolve(input.runDir),
    path,
  })
  const raw = await readBoundedControllerFile({
    path,
    maxBytes: CONTROLLER_PATCH_MAX_BYTES,
  })
  const parsed = JSON.parse(raw as string) as ControllerPatchFile
  if (!parsed || !Array.isArray(parsed.operations)) {
    throw new Error('Controller graph patch candidate is malformed')
  }
  if (matOSControllerDigest(parsed) !== input.patchDigest) {
    throw new Error('Controller graph patch candidate digest mismatch')
  }
  return parsed
}

async function assertActionCas(input: {
  action: MatOSControllerAction
  observationDigest: string
  snapshot: MatOSWorkflowRunSnapshot
  definition: MatOSWorkflowDefinition
  manifest: MatOSAlgorithmRunManifest
  events: readonly MatOSWorkflowEvent[]
}): Promise<void> {
  const current = input.action.cas
  if (
    input.action.runRef !== input.snapshot.runId ||
    input.action.scopeRef !== (input.snapshot.trace?.scopeRef ?? 'user:local') ||
    current.expectedObservationDigest !== input.observationDigest ||
    current.expectedEventCursor !== eventCursor(input.events) ||
    current.expectedManifestDigest !== input.manifest.manifestDigest ||
    current.expectedGraphDigest !== matOSControllerDigest(input.definition) ||
    current.expectedGraphVersion !== graphVersion(input.snapshot.graphSnapshotPath)
  ) {
    throw new Error('Controller action failed workflow CAS validation')
  }
}

async function appendControllerEvidence(
  runDir: string,
  file: string,
  value: unknown,
): Promise<void> {
  const path = join(runDir, 'controllers', file)
  const data = `${JSON.stringify(value)}\n`
  await withControllerFileLock({
    path,
    operation: () =>
      appendBoundedControllerFile({
        path,
        data,
        maxBytes: CONTROLLER_EVIDENCE_MAX_BYTES,
      }),
  })
}

function actionEffectRef(action: MatOSControllerAction): string {
  const payload =
    action.type === 'propose-graph-patch'
      ? {
          type: action.type,
          patchDigest: action.candidate.patchDigest,
          baseGraphDigest: action.candidate.baseGraphDigest,
          baseGraphVersion: action.candidate.baseGraphVersion,
        }
      : action.type === 'recovery-request'
        ? {
            type: action.type,
            runRef: action.runRef,
            checkpointRef: action.checkpointRef,
            mode: action.mode,
            graphDigest: action.cas.expectedGraphDigest,
            graphVersion: action.cas.expectedGraphVersion,
          }
        : { type: action.type, actionId: action.actionId }
  return `controller-effect:${action.type}:${matOSControllerDigest(payload)}`
}

function proposedActionSafeRefs(action: MatOSControllerAction): string[] {
  if (action.type === 'propose-graph-patch') {
    return [`controller-patch:${action.candidate.patchDigest}`]
  }
  if (action.type === 'recovery-request') return [action.checkpointRef]
  return [action.actionId]
}

async function pauseAmbiguousReceipt(input: {
  store: MatOSControllerActionReceiptStore
  effectRef: string
  receipt: MatOSControllerActionReceipt
}): Promise<MatOSControllerActionReceipt> {
  if (input.receipt.status !== 'proposed') return input.receipt
  return (
    await input.store.transition({
      effectRef: input.effectRef,
      expectedReceiptId: input.receipt.receiptId,
      status: 'paused',
      safeRefs: ['controller-replay:ambiguous-proposal'],
    })
  ).receipt
}

async function applyControllerActions(input: {
  advice: WorkflowReadySetAdviceInput
  binding: MatOSWorkflowControllerBinding
  manifest: MatOSAlgorithmRunManifest
  observationDigest: string
  actions: readonly MatOSControllerAction[]
}): Promise<WorkflowReadySetAdvice> {
  const [snapshot, events] = await Promise.all([
    readWorkflowRun(input.advice.runDir),
    readWorkflowRunEvents(input.advice.runDir),
  ])
  for (const action of input.actions) {
    await assertActionCas({
      action,
      observationDigest: input.observationDigest,
      snapshot,
      definition: input.advice.definition,
      manifest: input.manifest,
      events,
    })
  }
  if (input.binding.mode === 'shadow') {
    await appendControllerEvidence(input.advice.runDir, 'shadow-actions.jsonl', {
      at: new Date().toISOString(),
      providerId: input.binding.providerId,
      actions: input.actions,
    })
    for (const action of input.actions) {
      recordMatOSAlgorithmRunDecisionReference(input.advice.runDir, {
        schemaVersion: 1,
        decisionId: action.actionId,
        at: new Date().toISOString(),
        runId: input.advice.snapshot.runId,
        surfaceId: 'run-controller',
        providerId: input.binding.providerId,
        source: 'explicit',
        inputDigest: input.observationDigest,
        applied: false,
        differsFromApplied: action.type !== 'noop',
        algorithmPlane: 'controller',
        providerVersion: input.binding.providerVersion,
        ...(input.binding.assetRef ? { assetRef: input.binding.assetRef } : {}),
        configDigest: input.binding.configDigest,
        implementationDigest: input.binding.implementationDigest,
        manifestDigest: input.manifest.manifestDigest,
      })
    }
    return { orderedNodeIds: input.advice.readyNodeIds }
  }

  let orderedNodeIds = [...input.advice.readyNodeIds]
  let directive: WorkflowReadySetAdvice['directive']
  const receiptStore = new MatOSControllerActionReceiptStore(
    input.advice.runDir,
  )
  for (const action of input.actions) {
    recordMatOSAlgorithmRunDecisionReference(input.advice.runDir, {
      schemaVersion: 1,
      decisionId: action.actionId,
      at: new Date().toISOString(),
      runId: input.advice.snapshot.runId,
      surfaceId: 'run-controller',
      providerId: input.binding.providerId,
      source: 'explicit',
      inputDigest: input.observationDigest,
      applied: true,
      algorithmPlane: 'controller',
      providerVersion: input.binding.providerVersion,
      ...(input.binding.assetRef ? { assetRef: input.binding.assetRef } : {}),
      configDigest: input.binding.configDigest,
      implementationDigest: input.binding.implementationDigest,
      manifestDigest: input.manifest.manifestDigest,
    })
    const effectRef = actionEffectRef(action)
    const proposal = await receiptStore.propose({
      action,
      effectRef,
      safeRefs: proposedActionSafeRefs(action),
    })
    if (proposal.replayed) {
      const receipt = await pauseAmbiguousReceipt({
        store: receiptStore,
        effectRef,
        receipt: proposal.receipt,
      })
      if (receipt.status === 'applied') {
        if (action.type === 'rank-ready') {
          orderedNodeIds = [...action.orderedNodeRefs]
        }
        if (
          action.type === 'request-validation' &&
          orderedNodeIds.includes(action.validationRef)
        ) {
          orderedNodeIds = [
            action.validationRef,
            ...orderedNodeIds.filter(nodeId => nodeId !== action.validationRef),
          ]
        }
        if (
          action.type === 'request-human' &&
          orderedNodeIds.includes(action.promptRef)
        ) {
          orderedNodeIds = [
            action.promptRef,
            ...orderedNodeIds.filter(nodeId => nodeId !== action.promptRef),
          ]
        }
        if (action.type === 'pause') {
          directive = { status: 'paused', reason: action.reason }
          break
        }
        if (action.type === 'stop-request' && action.status === 'failed') {
          directive = { status: 'failed', reason: action.reason }
          break
        }
        if (action.type === 'recovery-request') {
          const current = await readWorkflowRun(input.advice.runDir)
          if (current.status === 'failed') {
            directive = {
              status: 'failed',
              reason: 'native recovery was already applied and the run remains failed',
            }
            break
          }
        }
        continue
      }
      directive = {
        status: 'paused',
        reason: `controller action replay is ${receipt.status}; native review is required`,
      }
      break
    }

    try {
      if (action.type === 'rank-ready') {
        orderedNodeIds = [...action.orderedNodeRefs]
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'applied',
        })
        continue
      }
      if (action.type === 'noop') {
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'applied',
        })
        continue
      }
      if (action.type === 'request-validation') {
        const validationNode = input.advice.definition.nodes.find(
          node =>
            node.id === action.validationRef &&
            (node.type === 'validate' || node.type === 'guard'),
        )
        if (
          validationNode &&
          orderedNodeIds.includes(validationNode.id)
        ) {
          orderedNodeIds = [
            validationNode.id,
            ...orderedNodeIds.filter(nodeId => nodeId !== validationNode.id),
          ]
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'applied',
            safeRefs: [
              `workflow-validation:${matOSControllerDigest(validationNode.id)}`,
            ],
          })
          await appendWorkflowEvent(input.advice.runDir, {
            type: 'workflow.controller.request_validation_applied',
            data: {
              actionId: action.actionId,
              validationNodeId: validationNode.id,
            },
          })
          continue
        }
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'rejected',
          safeRefs: ['controller-action:validation-not-ready'],
        })
        await appendWorkflowEvent(input.advice.runDir, {
          type: 'workflow.controller.request_validation_rejected',
          data: { actionId: action.actionId, reason: 'validation-not-ready' },
        })
        directive = {
          status: 'paused',
          reason:
            'controller request-validation was rejected because it did not reference a ready native validation node',
        }
        break
      }
      if (action.type === 'pause') {
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'applied',
          safeRefs: ['workflow-run-status:paused'],
        })
        await appendWorkflowEvent(input.advice.runDir, {
          type: 'workflow.controller.pause_applied',
          data: { actionId: action.actionId, reason: action.reason },
        })
        directive = { status: 'paused', reason: action.reason }
        break
      }
      if (action.type === 'stop-request') {
        if (action.status === 'failed') {
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'applied',
            safeRefs: ['workflow-run-status:failed'],
          })
          await appendWorkflowEvent(input.advice.runDir, {
            type: 'workflow.controller.stop_request_applied',
            data: {
              actionId: action.actionId,
              status: action.status,
              reason: action.reason,
            },
          })
          directive = { status: 'failed', reason: action.reason }
          break
        }
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'rejected',
          safeRefs: [`controller-action:unsafe-stop-${action.status}`],
        })
        await appendWorkflowEvent(input.advice.runDir, {
          type: 'workflow.controller.stop_request_rejected',
          data: {
            actionId: action.actionId,
            status: action.status,
            reason: 'native-terminal-proof-required',
          },
        })
        directive = {
          status: 'paused',
          reason: `controller stop-request ${action.status} was rejected because native terminal proof is required`,
        }
        break
      }
      if (action.type === 'request-human') {
        const humanNode = input.advice.definition.nodes.find(
          node => node.id === action.promptRef && node.type === 'human',
        )
        if (humanNode && orderedNodeIds.includes(humanNode.id)) {
          orderedNodeIds = [
            humanNode.id,
            ...orderedNodeIds.filter(nodeId => nodeId !== humanNode.id),
          ]
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'applied',
            safeRefs: [
              `workflow-human:${matOSControllerDigest(humanNode.id)}`,
            ],
          })
          await appendWorkflowEvent(input.advice.runDir, {
            type: 'workflow.controller.request_human_applied',
            data: { actionId: action.actionId, humanNodeId: humanNode.id },
          })
          continue
        }
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'rejected',
          safeRefs: ['controller-action:native-human-node-required'],
        })
        await appendWorkflowEvent(input.advice.runDir, {
          type: 'workflow.controller.request_human_rejected',
          data: {
            actionId: action.actionId,
            promptRefDigest: matOSControllerDigest(action.promptRef),
            reason: 'native-human-node-required',
          },
        })
        directive = {
          status: 'paused',
          reason:
            'controller request-human was rejected because no ready native human node owns the request',
        }
        break
      }
      if (action.type === 'propose-graph-patch') {
        const candidate = await readControllerPatchFile({
          runDir: input.advice.runDir,
          candidateRef: action.candidate.candidateRef,
          patchDigest: action.candidate.patchDigest,
        })
        const proposed = await proposeWorkflowGraphPatch({
          runDir: input.advice.runDir,
          runId: input.advice.snapshot.runId,
          definition: input.advice.definition,
          operations: candidate.operations,
          reason: candidate.reason ?? action.reason,
          risk: candidate.risk,
          sourceNodeId: 'run-controller',
          decidedBy: `controller:${input.binding.providerId}`,
        })
        if (!proposed.ok || !proposed.patch) {
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'rejected',
            safeRefs: ['controller-patch:validation-rejected'],
          })
          throw new Error(
            `Controller graph patch rejected: ${proposed.errors.map(error => error.message).join('; ')}`,
          )
        }
        await appendWorkflowEvent(input.advice.runDir, {
          type: 'workflow.controller.graph_patch_proposed',
          data: { actionId: action.actionId, patchId: proposed.patch.patchId },
        })
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'paused',
          safeRefs: [`workflow-graph-patch:${proposed.patch.patchId}`],
        })
        directive = {
          status: 'paused',
          reason: `controller graph patch ${proposed.patch.patchId} requires native approval`,
        }
        break
      }
      if (action.type === 'recovery-request') {
        if (action.mode !== 'reconcile') {
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'rejected',
            safeRefs: ['workflow-recovery:unsupported-restore-request'],
          })
          directive = {
            status: 'paused',
            reason: 'controller recovery restore request requires native review',
          }
          break
        }
        const recovery = await recoverWorkflowRun(input.advice.runDir)
        const recoveryDigest = workflowRecoveryReportDigest(recovery)
        const recoveryRef = `workflow-recovery-report:${recoveryDigest}`
        const applied = await applyWorkflowRecoveryRecommendation(
          input.advice.runDir,
          { expectedRecoveryDigest: recoveryDigest },
        )
        const safeRefs = [
          recoveryRef,
          `workflow-recovery-action:${applied.appliedAction}`,
          `workflow-run-status:${applied.run.status}`,
        ]
        if (applied.appliedAction === 'none') {
          await receiptStore.transition({
            effectRef,
            expectedReceiptId: proposal.receipt.receiptId,
            status: 'rejected',
            safeRefs,
          })
          directive = {
            status: 'paused',
            reason: `native recovery requires review: ${recovery.classification}`,
          }
          break
        }
        const paused =
          applied.run.status === 'paused' ||
          applied.run.status === 'waiting_input' ||
          applied.run.status === 'waiting_approval'
        await receiptStore.transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: paused ? 'paused' : 'applied',
          safeRefs,
        })
        if (paused || applied.run.status === 'failed') {
          directive = {
            status: paused ? 'paused' : 'failed',
            reason: `native recovery ${applied.appliedAction} left run ${applied.run.status}`,
          }
          break
        }
        continue
      }
      const unreachable: never = action
      throw new Error(
        `Unsupported controller action ${(unreachable as MatOSControllerAction).type}`,
      )
    } catch (error) {
      await receiptStore
        .transition({
          effectRef,
          expectedReceiptId: proposal.receipt.receiptId,
          status: 'paused',
          safeRefs: ['controller-action:execution-ambiguous'],
        })
        .catch(() => undefined)
      throw error
    }
  }
  await appendControllerEvidence(input.advice.runDir, 'actions.jsonl', {
    at: new Date().toISOString(),
    providerId: input.binding.providerId,
    observationDigest: input.observationDigest,
    actions: input.actions,
  })
  return {
    orderedNodeIds,
    ...(directive ? { directive } : {}),
  }
}

async function failureAdvice(input: {
  advice: WorkflowReadySetAdviceInput
  mode: 'active' | 'shadow'
  onFailure: 'baseline' | 'pause' | 'fail'
  error: unknown
}): Promise<WorkflowReadySetAdvice> {
  const message = redactWorkflowControllerFailureText(input.error)
  await appendControllerEvidence(input.advice.runDir, 'failures.jsonl', {
    at: new Date().toISOString(),
    message,
  }).catch(() => undefined)
  const pinMismatch =
    input.error instanceof MatOSWorkflowControllerPinMismatchError
  if (!pinMismatch && (input.mode === 'shadow' || input.onFailure === 'baseline')) {
    return { orderedNodeIds: input.advice.readyNodeIds }
  }
  return {
    orderedNodeIds: input.advice.readyNodeIds,
    directive: {
      status: input.onFailure === 'fail' ? 'failed' : 'paused',
      reason: pinMismatch
        ? `workflow controller implementation pin mismatch: ${message.slice(0, 500)}`
        : `workflow controller failed closed: ${message.slice(0, 500)}`,
    },
  }
}

async function executeMatOSWorkflowReadySet(
  advice: WorkflowReadySetAdviceInput,
): Promise<WorkflowReadySetAdvice> {
  const policy = advice.definition.policy.controller
  if (!policy || policy.enabled === false) {
    return { orderedNodeIds: advice.readyNodeIds }
  }
  const mode = policy.mode ?? 'active'
  const onFailure = workflowControllerFailureMode(advice.definition)
  try {
    const manifest = await readMatOSAlgorithmRunManifest(advice.runDir)
    if (!manifest) {
      throw new Error('Pinned algorithm manifest is missing, corrupt, or mismatched')
    }
    const binding = resolveManifestPinnedControllerBinding({
      definition: advice.definition,
      workflowRef: advice.snapshot.workflowRef,
      manifest,
    })
    if (!binding) return { orderedNodeIds: advice.readyNodeIds }
    if (!manifestBindingMatches(manifest, binding)) {
      throw new MatOSWorkflowControllerPinMismatchError(
        'Pinned controller binding does not match the registered implementation',
      )
    }
    const store = new JsonlMatOSControllerCheckpointStore(
      checkpointPath(advice.runDir, binding.providerId),
    )
    const observation = await buildObservation({
      advice,
      binding,
      manifest,
      store,
    })
    const controller = createManifestPinnedController(binding)
    const runner = createMatOSControllerRunner({
      controller,
      checkpointStore: store,
      runRef: advice.snapshot.runId,
      definitionRef: advice.snapshot.workflowRef,
      objectiveRef: binding.objectiveRef,
      scopeRef: advice.snapshot.trace?.scopeRef ?? 'user:local',
      manifest: {
        ref: 'algorithm-manifest.json',
        digest: manifest.manifestDigest,
      },
      providerId: binding.providerId,
      configDigest: binding.configDigest,
      implementationDigest: binding.implementationDigest,
      ...(binding.assetRef ? { assetRef: binding.assetRef } : {}),
      ...(binding.runtimeRef ? { runtimeRef: binding.runtimeRef } : {}),
      seed: binding.seed,
      bounds: binding.bounds,
    })
    if (
      await store.latest({
        runRef: advice.snapshot.runId,
        scopeRef: advice.snapshot.trace?.scopeRef ?? 'user:local',
        controllerId: binding.providerId,
      })
    ) {
      await runner.restore()
    }
    const step = await runner.step(observation)
    return await applyControllerActions({
      advice,
      binding,
      manifest,
      observationDigest: observation.observationDigest,
      actions: step.actions,
    })
  } catch (error) {
    return failureAdvice({ advice, mode, onFailure, error })
  }
}

const MAX_ACTIVE_SHADOW_CONTROLLERS = 2
const MAX_PENDING_SHADOW_CONTROLLERS = 32
const MAX_PENDING_SHADOW_CONTROLLERS_PER_RUN = 4
const pendingShadowControllers = new Map<string, Promise<void>>()
const pendingShadowControllerEvidence = new Map<string, Promise<void>>()
const pendingShadowControllerCounts = new Map<string, number>()
const pendingShadowControllerSlotWaiters: Array<() => void> = []
const pendingShadowControllerFinalizers = new Map<string, Promise<void>>()
let pendingShadowControllerTotal = 0
let activeShadowControllerTotal = 0

async function acquireShadowControllerSlot(): Promise<void> {
  if (activeShadowControllerTotal < MAX_ACTIVE_SHADOW_CONTROLLERS) {
    activeShadowControllerTotal += 1
    return
  }
  await new Promise<void>(resolveSlot => {
    pendingShadowControllerSlotWaiters.push(resolveSlot)
  })
}

function releaseShadowControllerSlot(): void {
  const next = pendingShadowControllerSlotWaiters.shift()
  if (next) {
    next()
    return
  }
  activeShadowControllerTotal -= 1
}

function recordShadowControllerOverflow(
  advice: WorkflowReadySetAdviceInput,
  reason: 'per-run-capacity' | 'global-capacity',
): void {
  const prior = pendingShadowControllerEvidence.get(advice.runDir) ?? Promise.resolve()
  const evidence = prior
    .catch(() => undefined)
    .then(async () => {
      const data = {
        at: new Date().toISOString(),
        providerId: advice.definition.policy.controller?.provider,
        reason,
        pendingForRun: pendingShadowControllerCounts.get(advice.runDir) ?? 0,
        pendingTotal: pendingShadowControllerTotal,
        maxPendingForRun: MAX_PENDING_SHADOW_CONTROLLERS_PER_RUN,
        maxPendingTotal: MAX_PENDING_SHADOW_CONTROLLERS,
      }
      await Promise.all([
        appendControllerEvidence(
          advice.runDir,
          'shadow-overflow.jsonl',
          data,
        ),
        appendWorkflowEvent(advice.runDir, {
          type: 'workflow.controller.shadow_overflow',
          data,
        }),
      ])
    })
    .catch(() => undefined)
    .finally(() => {
      if (pendingShadowControllerEvidence.get(advice.runDir) === evidence) {
        pendingShadowControllerEvidence.delete(advice.runDir)
      }
    })
  pendingShadowControllerEvidence.set(advice.runDir, evidence)
}

function enqueueShadowController(advice: WorkflowReadySetAdviceInput): void {
  const pendingForRun = pendingShadowControllerCounts.get(advice.runDir) ?? 0
  if (pendingForRun >= MAX_PENDING_SHADOW_CONTROLLERS_PER_RUN) {
    recordShadowControllerOverflow(advice, 'per-run-capacity')
    return
  }
  if (pendingShadowControllerTotal >= MAX_PENDING_SHADOW_CONTROLLERS) {
    recordShadowControllerOverflow(advice, 'global-capacity')
    return
  }
  pendingShadowControllerCounts.set(advice.runDir, pendingForRun + 1)
  pendingShadowControllerTotal += 1
  const previous = pendingShadowControllers.get(advice.runDir) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      await acquireShadowControllerSlot()
      try {
        await executeMatOSWorkflowReadySet(advice)
      } finally {
        releaseShadowControllerSlot()
      }
    })
    .catch(() => undefined)
    .finally(() => {
      pendingShadowControllerTotal -= 1
      const remaining =
        (pendingShadowControllerCounts.get(advice.runDir) ?? 1) - 1
      if (remaining > 0) pendingShadowControllerCounts.set(advice.runDir, remaining)
      else pendingShadowControllerCounts.delete(advice.runDir)
    })
  pendingShadowControllers.set(advice.runDir, operation)
  void operation.then(() => {
    if (pendingShadowControllers.get(advice.runDir) === operation) {
      pendingShadowControllers.delete(advice.runDir)
    }
  })
}

async function flushShadowController(runDir: string): Promise<void> {
  await Promise.allSettled([
    pendingShadowControllers.get(runDir) ?? Promise.resolve(),
    pendingShadowControllerEvidence.get(runDir) ?? Promise.resolve(),
  ])
}

export async function waitForMatOSWorkflowShadowController(
  runDir: string,
): Promise<void> {
  await flushShadowController(runDir)
  await pendingShadowControllerFinalizers.get(runDir)
}

/** The only controller-to-workflow action bridge. */
export async function adviseMatOSWorkflowReadySet(
  advice: WorkflowReadySetAdviceInput,
): Promise<WorkflowReadySetAdvice> {
  const policy = advice.definition.policy.controller
  if (!policy || policy.enabled === false) {
    return { orderedNodeIds: advice.readyNodeIds }
  }
  if ((policy.mode ?? 'active') === 'shadow') {
    enqueueShadowController(advice)
    return { orderedNodeIds: advice.readyNodeIds }
  }
  return executeMatOSWorkflowReadySet(advice)
}

async function finalizeMatOSWorkflowControllerInternal(input: {
  runDir: string
  snapshot: MatOSWorkflowRunSnapshot
  definition: MatOSWorkflowDefinition
}, backgroundShadowFinalize = false): Promise<void> {
  const policy = input.definition.policy.controller
  if (!policy || policy.enabled === false) return
  if (input.snapshot.status === 'failed') {
    const events = await readWorkflowRunEvents(input.runDir).catch(() => [])
    const armIndex = events.findLastIndex(
      event => event.type === 'workflow.controller.failure_tick_armed',
    )
    if (armIndex >= 0) {
      const armEventId = events[armIndex]?.id
      const resolved = events.slice(armIndex + 1).some(event => {
        if (
          event.type !== 'workflow.controller.failure_tick_started' &&
          event.type !== 'workflow.controller.failure_tick_disarmed'
        ) {
          return false
        }
        return event.data.armEventId === armEventId
      })
      if (!resolved) return
    }
  }
  if ((policy.mode ?? 'active') === 'shadow' && !backgroundShadowFinalize) {
    if (!pendingShadowControllerFinalizers.has(input.runDir)) {
      let work!: Promise<void>
      work = new Promise<void>(resolveFinalize => {
        const immediate = setImmediate(() => {
          void finalizeMatOSWorkflowControllerInternal(input, true)
            .catch(() => undefined)
            .finally(resolveFinalize)
        })
        immediate.unref?.()
      }).finally(() => {
        if (pendingShadowControllerFinalizers.get(input.runDir) === work) {
          pendingShadowControllerFinalizers.delete(input.runDir)
        }
      })
      pendingShadowControllerFinalizers.set(input.runDir, work)
    }
    return
  }
  await flushShadowController(input.runDir)
  const finalizePath = join(input.runDir, 'controllers', 'finalize.json')
  try {
    await readFile(finalizePath, 'utf8')
    return
  } catch {
    // Finalize once per run; absence is the expected first-call state.
  }
  try {
    const manifest = await readMatOSAlgorithmRunManifest(input.runDir)
    if (!manifest) {
      throw new Error('Pinned controller manifest is unavailable during finalize')
    }
    const binding = resolveManifestPinnedControllerBinding({
      definition: input.definition,
      workflowRef: input.snapshot.workflowRef,
      manifest,
    })
    if (!binding || !manifestBindingMatches(manifest, binding)) {
      throw new MatOSWorkflowControllerPinMismatchError(
        'Pinned controller implementation is unavailable during finalize',
      )
    }
    const store = new JsonlMatOSControllerCheckpointStore(
      checkpointPath(input.runDir, binding.providerId),
    )
    const query = {
      runRef: input.snapshot.runId,
      scopeRef: input.snapshot.trace?.scopeRef ?? 'user:local',
      controllerId: binding.providerId,
    }
    if (!(await store.latest(query))) return
    const controller = createManifestPinnedController(binding)
    const runner = createMatOSControllerRunner({
      controller,
      checkpointStore: store,
      runRef: input.snapshot.runId,
      definitionRef: input.snapshot.workflowRef,
      objectiveRef: binding.objectiveRef,
      scopeRef: query.scopeRef,
      manifest: {
        ref: 'algorithm-manifest.json',
        digest: manifest.manifestDigest,
      },
      providerId: binding.providerId,
      configDigest: binding.configDigest,
      implementationDigest: binding.implementationDigest,
      ...(binding.assetRef ? { assetRef: binding.assetRef } : {}),
      ...(binding.runtimeRef ? { runtimeRef: binding.runtimeRef } : {}),
      seed: binding.seed,
      bounds: binding.bounds,
    })
    await runner.restore()
    const result = await runner.finalize()
    await mkdir(dirname(finalizePath), { recursive: true })
    await writeFile(
      finalizePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          finalizedAt: new Date().toISOString(),
          providerId: binding.providerId,
          providerVersion: binding.providerVersion,
          implementationDigest: binding.implementationDigest,
          ...(binding.assetRef ? { assetRef: binding.assetRef } : {}),
          ...(binding.runtimeRef ? { runtimeRef: binding.runtimeRef } : {}),
          result,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch (error) {
    const message = redactWorkflowControllerFailureText(error)
    await appendControllerEvidence(input.runDir, 'failures.jsonl', {
      at: new Date().toISOString(),
      phase: 'finalize',
      message,
    }).catch(() => undefined)
    if (error instanceof MatOSWorkflowControllerPinMismatchError) {
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.controller.implementation_pin_mismatch',
        data: { phase: 'finalize', message },
      }).catch(() => undefined)
    }
  }
}

export async function finalizeMatOSWorkflowController(input: {
  runDir: string
  snapshot: MatOSWorkflowRunSnapshot
  definition: MatOSWorkflowDefinition
}): Promise<void> {
  await finalizeMatOSWorkflowControllerInternal(input)
}
