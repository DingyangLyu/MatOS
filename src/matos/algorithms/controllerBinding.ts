import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import {
  createMatOSControllerBudgetUsage,
  createMatOSControllerSearchBounds,
  matOSControllerDigest,
  toMatOSControllerJsonValue,
  type MatOSControllerBudgetUsage,
  type MatOSControllerJsonValue,
  type MatOSControllerSearchBounds,
} from './controllers/protocol.js'
import { matOSControllerRegistry } from './controllers/registry.js'
import { ensureBuiltinMatOSWorkflowControllers } from './workflowControllers.js'

export type MatOSWorkflowControllerBinding = Readonly<{
  mode: 'active' | 'shadow'
  providerId: string
  providerVersion: string
  stateVersion: number
  implementationDigest: string
  assetRef?: string
  runtimeRef?: string
  config: MatOSControllerJsonValue
  configDigest: string
  objectiveRef: string
  seed: number
  bounds: MatOSControllerSearchBounds
  budgetLimits: MatOSControllerBudgetUsage
  onFailure: 'baseline' | 'pause' | 'fail'
}>

const DEFAULT_BOUNDS: MatOSControllerSearchBounds = {
  maxActions: 1,
  maxCandidates: 32,
  maxDepth: 4,
  maxWallTimeMs: 1_000,
  maxCostUsd: 0,
}

const DEFAULT_BUDGET: MatOSControllerBudgetUsage = {
  actions: 256,
  candidates: 4_096,
  transitions: 4_096,
  evaluations: 4_096,
  maxDepth: 256,
  wallTimeMs: 60_000,
  costUsd: 0,
}

export function workflowControllerConfigured(
  definition: MatOSWorkflowDefinition,
): boolean {
  return Boolean(
    definition.policy.controller &&
      definition.policy.controller.enabled !== false,
  )
}

export function workflowControllerFailureMode(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowControllerBinding['onFailure'] {
  return definition.policy.controller?.onFailure ?? 'baseline'
}

export function resolveMatOSWorkflowControllerBinding(input: {
  definition: MatOSWorkflowDefinition
  workflowRef: string
  pinnedProviderVersion?: string
}): MatOSWorkflowControllerBinding | undefined {
  const policy = input.definition.policy.controller
  if (!policy || policy.enabled === false) return undefined
  ensureBuiltinMatOSWorkflowControllers()
  const providerId = policy.provider?.trim()
  if (!providerId) throw new Error('Enabled workflow controller requires provider')
  const providerVersion =
    policy.version?.trim() || input.pinnedProviderVersion?.trim() || undefined
  const provider = matOSControllerRegistry.resolve(
    providerId,
    providerVersion,
  )
  const config = toMatOSControllerJsonValue(policy.config ?? {})
  const seed = policy.seed ?? 0
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('Workflow controller seed must be a non-negative safe integer')
  }
  const bounds = createMatOSControllerSearchBounds({
    ...DEFAULT_BOUNDS,
    ...(policy.bounds ?? {}),
  })
  const budgetLimits = createMatOSControllerBudgetUsage({
    ...DEFAULT_BUDGET,
    ...(policy.budget ?? {}),
  })
  if (budgetLimits.actions < 1) {
    throw new Error('Enabled workflow controller budget.actions must be at least 1')
  }
  return Object.freeze({
    mode: policy.mode ?? 'active',
    providerId: provider.id,
    providerVersion: provider.version,
    stateVersion: provider.stateVersion,
    implementationDigest: provider.implementationDigest,
    ...(provider.assetRef ? { assetRef: provider.assetRef } : {}),
    ...(provider.runtimeRef ? { runtimeRef: provider.runtimeRef } : {}),
    config,
    configDigest: matOSControllerDigest(config),
    objectiveRef:
      policy.objectiveRef?.trim() || `${input.workflowRef}#ready-set-order`,
    seed,
    bounds,
    budgetLimits,
    onFailure: workflowControllerFailureMode(input.definition),
  })
}

export function matOSWorkflowControllerBindingDigest(
  binding: MatOSWorkflowControllerBinding,
): string {
  return matOSControllerDigest({
    mode: binding.mode,
    providerId: binding.providerId,
    providerVersion: binding.providerVersion,
    stateVersion: binding.stateVersion,
    implementationDigest: binding.implementationDigest,
    ...(binding.assetRef ? { assetRef: binding.assetRef } : {}),
    ...(binding.runtimeRef ? { runtimeRef: binding.runtimeRef } : {}),
    configDigest: binding.configDigest,
    objectiveRef: binding.objectiveRef,
    seed: binding.seed,
    bounds: binding.bounds,
    budgetLimits: binding.budgetLimits,
    onFailure: binding.onFailure,
  })
}
