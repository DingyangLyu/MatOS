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

import type { MatOSUserFeedbackAnalysis } from './userFeedbackSignals.js'
import { directEditableFeedbackDecisions } from './userFeedbackSignals.js'

export const MATOS_EVOLUTION_TARGET_ASSET_TYPES = [
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
] as const

export type MatOSEvolutionTargetAssetType =
  (typeof MATOS_EVOLUTION_TARGET_ASSET_TYPES)[number]

export type MatOSEvolutionTargetContract = {
  schemaVersion: 1
  mode?: 'shadow' | 'advisory' | 'strict'
  expectedTypes: MatOSEvolutionTargetAssetType[]
  requiredAnyTypes?: MatOSEvolutionTargetAssetType[]
  preferredRefs: string[]
  allowedFallbackTypes?: MatOSEvolutionTargetAssetType[]
  disallowedFallbackTypes?: MatOSEvolutionTargetAssetType[]
  roleFallbackAllowed?: boolean
  reason?: string
  source?: 'feedback' | 'workflow' | 'explicit' | 'experience'
}

export type MatOSDirectAssetEditorTargetDecision = {
  selectedTypes: MatOSEvolutionTargetAssetType[]
  selectedRefs: string[]
  rejectedRefs?: string[]
  fallbackUsed?: boolean
  fallbackReason?: string
  reason?: string
  confidence?: number
}

export type MatOSEvolutionTargetConformance = {
  schemaVersion: 1
  status: 'matched' | 'deviated' | 'unconstrained' | 'unknown'
  mode: 'shadow' | 'advisory' | 'strict'
  expectedTypes: MatOSEvolutionTargetAssetType[]
  actualTypes: MatOSEvolutionTargetAssetType[]
  preferredRefs: string[]
  actualRefs: string[]
  fallbackUsed: boolean
  allowed: boolean
  severity: 'none' | 'low' | 'medium' | 'high'
  reason: string
}

export type MatOSDirectAssetEditorAcceptanceEvidence = {
  schemaVersion: 1
  observedChanges?: import('./directAssetEditorChanges.js').MatOSObservedAssetChanges
  targetConformance: MatOSEvolutionTargetConformance
  highRiskAssetPolicy?: MatOSEvolutionHighRiskAssetPolicy
}

export type MatOSEvolutionHighRiskAssetPolicy = {
  schemaVersion: 1
  status: 'clear' | 'blocked'
  blocked: boolean
  severity: 'none' | 'medium' | 'high'
  highRiskCreatedTypes: MatOSEvolutionTargetAssetType[]
  highRiskActualTypes: MatOSEvolutionTargetAssetType[]
  highRiskExpectedTypes: MatOSEvolutionTargetAssetType[]
  reason: string
}

const HIGH_RISK_DIRECT_EDIT_TYPES = new Set<MatOSEvolutionTargetAssetType>([
  'role',
  'workflow',
])

function isTargetAssetType(value: unknown): value is MatOSEvolutionTargetAssetType {
  return (
    typeof value === 'string' &&
    (MATOS_EVOLUTION_TARGET_ASSET_TYPES as readonly string[]).includes(value)
  )
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined
}

function cleanRef(ref: string): string | undefined {
  const trimmed = ref.trim()
  return trimmed || undefined
}

function assetTypeFromRef(ref: string): MatOSEvolutionTargetAssetType | undefined {
  const prefix = ref.trim().split(':', 1)[0]
  return isTargetAssetType(prefix) ? prefix : undefined
}

function canonicalRefBase(ref: string): string {
  return ref.trim().replace(/@[^@/]+$/, '')
}

function sameAssetRef(a: string, b: string): boolean {
  const left = canonicalRefBase(a)
  const right = canonicalRefBase(b)
  return left === right || a.trim() === b.trim()
}

function typedRef(defaultType: MatOSEvolutionTargetAssetType, ref: string): string | undefined {
  const trimmed = cleanRef(ref)
  if (!trimmed) {
    return undefined
  }
  return trimmed.includes(':') ? trimmed : `${defaultType}:${trimmed}`
}

function normalizedToolRefs(toolName: string): string[] {
  const trimmed = cleanRef(toolName)
  if (!trimmed) {
    return []
  }
  const id = trimmed.includes(':')
    ? trimmed.split(':').slice(1).join(':')
    : trimmed
  const normalized = id
    .replace(/_/g, '-')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return [
    trimmed.includes(':') ? trimmed : `tool:${trimmed}`,
    normalized ? `tool:${normalized}` : undefined,
  ].filter((ref): ref is string => Boolean(ref))
}

function targetTypeArray(value: unknown): MatOSEvolutionTargetAssetType[] {
  return unique(
    stringArray(value)
      .map(item => item.trim())
      .filter(isTargetAssetType),
  )
}

export function normalizeMatOSEvolutionTargetContract(
  value: unknown,
): MatOSEvolutionTargetContract | undefined {
  const raw = objectValue(value)
  const expectedTypes = targetTypeArray(raw.expectedTypes)
  const preferredRefs = unique(
    stringArray(raw.preferredRefs).map(ref => ref.trim()).filter(Boolean),
  )
  if (expectedTypes.length === 0 && preferredRefs.length === 0) {
    return undefined
  }
  const refTypes = preferredRefs
    .map(assetTypeFromRef)
    .filter((type): type is MatOSEvolutionTargetAssetType => Boolean(type))
  const mode =
    raw.mode === 'strict' || raw.mode === 'shadow' || raw.mode === 'advisory'
      ? raw.mode
      : 'advisory'
  const source =
    raw.source === 'feedback' ||
    raw.source === 'workflow' ||
    raw.source === 'explicit' ||
    raw.source === 'experience'
      ? raw.source
      : undefined
  return {
    schemaVersion: 1,
    mode,
    expectedTypes: unique([...expectedTypes, ...refTypes]),
    requiredAnyTypes: targetTypeArray(raw.requiredAnyTypes),
    preferredRefs,
    allowedFallbackTypes: targetTypeArray(raw.allowedFallbackTypes),
    disallowedFallbackTypes: targetTypeArray(raw.disallowedFallbackTypes),
    ...(boolValue(raw.roleFallbackAllowed) !== undefined
      ? { roleFallbackAllowed: boolValue(raw.roleFallbackAllowed) }
      : {}),
    ...(typeof raw.reason === 'string' && raw.reason.trim()
      ? { reason: raw.reason.trim() }
      : {}),
    ...(source ? { source } : {}),
  }
}

function configuredTargetContractMode(
  env?: Record<string, string | undefined>,
): 'shadow' | 'advisory' | 'strict' | undefined {
  const raw =
    env?.MATOS_EVOLUTION_TARGET_CONTRACT_MODE ??
    process.env.MATOS_EVOLUTION_TARGET_CONTRACT_MODE
  if (raw === 'shadow' || raw === 'advisory' || raw === 'strict') {
    return raw
  }
  return undefined
}

export function buildMatOSEvolutionTargetContract(input: {
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  workflowEvidence?: unknown
  env?: Record<string, string | undefined>
  scope?: string
  ownedSourceEventRefs?: string[]
}): MatOSEvolutionTargetContract | undefined {
  const expectedTypes = new Set<MatOSEvolutionTargetAssetType>()
  const preferredRefs = new Set<string>()
  const scoped =
    input.scope === 'user' ||
    input.scope === 'team' ||
    input.scope === 'project'
  const directSignalIds = new Set(
    directEditableFeedbackDecisions(input.feedbackAnalysis, {
      scoped,
      ownedSourceEventRefs: input.ownedSourceEventRefs,
    }).map(decision => decision.signalId),
  )
  for (const signal of input.feedbackAnalysis?.signals ?? []) {
    if (!directSignalIds.has(signal.id)) {
      continue
    }
    for (const type of signal.target.assetTypes ?? []) {
      if (isTargetAssetType(type)) {
        expectedTypes.add(type)
      }
    }
    for (const ref of signal.target.assetRefs ?? []) {
      const clean = cleanRef(ref)
      if (clean) {
        preferredRefs.add(clean)
      }
      const type = clean ? assetTypeFromRef(clean) : undefined
      if (type) {
        expectedTypes.add(type)
      }
    }
    for (const ref of signal.target.roleRefs ?? []) {
      const typed = typedRef('role', ref)
      if (typed) {
        preferredRefs.add(typed)
        expectedTypes.add('role')
      }
    }
    for (const ref of signal.target.workflowRefs ?? []) {
      const typed = typedRef('workflow', ref)
      if (typed) {
        preferredRefs.add(typed)
        expectedTypes.add('workflow')
      }
    }
    for (const ref of signal.target.toolRefs ?? []) {
      const typed = typedRef('tool', ref)
      if (typed) {
        preferredRefs.add(typed)
        expectedTypes.add('tool')
      }
    }
    // Bare tool-name mentions create a tool contract only when the critic
    // explicitly targeted the tool asset type. Critic prose naming a built-in
    // tool (e.g. "Bash") must not mint strict contracts at nonexistent
    // tool: refs, which would deterministically roll back legitimate edits
    // after the critic and editor spend was already paid.
    if ((signal.target.assetTypes ?? []).includes('tool')) {
      for (const name of signal.target.toolNames ?? []) {
        for (const ref of normalizedToolRefs(name)) {
          preferredRefs.add(ref)
        }
        expectedTypes.add('tool')
      }
    }
    for (const ref of signal.target.mcpRefs ?? []) {
      const typed = typedRef('mcp', ref)
      if (typed) {
        preferredRefs.add(typed)
        expectedTypes.add('mcp')
      }
    }
    for (const ref of signal.target.knowledgeRefs ?? []) {
      const typed = typedRef('knowledge', ref)
      if (typed) {
        preferredRefs.add(typed)
        expectedTypes.add('knowledge')
      }
    }
  }

  const workflow = objectValue(input.workflowEvidence)
  const workflowRef =
    typeof workflow.workflowRef === 'string' && workflow.workflowRef.trim()
      ? workflow.workflowRef.trim()
      : undefined
  if (workflowRef) {
    preferredRefs.add(workflowRef)
    expectedTypes.add('workflow')
  }

  if (expectedTypes.size === 0 && preferredRefs.size === 0) {
    return undefined
  }
  const behaviorTargeted = [...preferredRefs].some(ref => {
    const type = assetTypeFromRef(ref)
    return type === 'tool' || type === 'mcp'
  })
  const narrowTypes = [...expectedTypes].filter(type => type !== 'role')
  return {
    schemaVersion: 1,
    mode:
      configuredTargetContractMode(input.env) ??
      (behaviorTargeted ? 'strict' : 'advisory'),
    expectedTypes: [...expectedTypes].sort(),
    ...(behaviorTargeted ? { requiredAnyTypes: [...expectedTypes].filter(type => type === 'tool' || type === 'mcp') } : {}),
    preferredRefs: [...preferredRefs].sort(),
    roleFallbackAllowed: narrowTypes.length === 0,
    ...(narrowTypes.length > 0 ? { disallowedFallbackTypes: ['role'] } : {}),
    reason:
      narrowTypes.length > 0
        ? 'Direct-edit target contract was derived from explicit non-role feedback targets.'
        : 'Direct-edit target contract was derived from explicit feedback targets.',
    source: workflowRef ? 'workflow' : 'feedback',
  }
}

export function normalizeMatOSDirectAssetEditorTargetDecision(
  value: unknown,
): MatOSDirectAssetEditorTargetDecision | undefined {
  const raw = objectValue(value)
  const selectedTypes = targetTypeArray(raw.selectedTypes)
  const selectedRefs = unique(
    stringArray(raw.selectedRefs).map(ref => ref.trim()).filter(Boolean),
  )
  const refTypes = selectedRefs
    .map(assetTypeFromRef)
    .filter((type): type is MatOSEvolutionTargetAssetType => Boolean(type))
  if (selectedTypes.length === 0 && selectedRefs.length === 0) {
    return undefined
  }
  return {
    selectedTypes: unique([...selectedTypes, ...refTypes]),
    selectedRefs,
    rejectedRefs: unique(
      stringArray(raw.rejectedRefs).map(ref => ref.trim()).filter(Boolean),
    ),
    ...(typeof raw.fallbackUsed === 'boolean'
      ? { fallbackUsed: raw.fallbackUsed }
      : {}),
    ...(typeof raw.fallbackReason === 'string' && raw.fallbackReason.trim()
      ? { fallbackReason: raw.fallbackReason.trim() }
      : {}),
    ...(typeof raw.reason === 'string' && raw.reason.trim()
      ? { reason: raw.reason.trim() }
      : {}),
    ...(numberValue(raw.confidence) !== undefined
      ? { confidence: numberValue(raw.confidence) }
      : {}),
  }
}

export function evaluateMatOSEvolutionTargetConformance(input: {
  contract?: MatOSEvolutionTargetContract
  actualRefs?: string[]
  editorOutput: {
    targetDecision?: MatOSDirectAssetEditorTargetDecision
    createdAssets?: string[]
    updatedAssets?: string[]
    disabledAssets?: string[]
  }
}): MatOSEvolutionTargetConformance {
  const contract = normalizeMatOSEvolutionTargetContract(input.contract)
  const mode = contract?.mode ?? 'advisory'
  const targetDecision = input.editorOutput.targetDecision
  const actualRefs = unique((input.actualRefs ?? [
    ...(targetDecision?.selectedRefs ?? []),
    ...(input.editorOutput.updatedAssets ?? []),
    ...(input.editorOutput.createdAssets ?? []),
    ...(input.editorOutput.disabledAssets ?? []),
  ]).map(ref => ref.trim()).filter(Boolean))
  const actualTypes = unique([
    ...(input.actualRefs ? [] : targetDecision?.selectedTypes ?? []),
    ...actualRefs
      .map(assetTypeFromRef)
      .filter((type): type is MatOSEvolutionTargetAssetType => Boolean(type)),
  ]).sort()
  if (!contract) {
    return {
      schemaVersion: 1,
      status: 'unconstrained',
      mode,
      expectedTypes: [],
      actualTypes,
      preferredRefs: [],
      actualRefs,
      fallbackUsed: false,
      allowed: true,
      severity: 'none',
      reason: 'No target contract was provided for this direct edit.',
    }
  }
  if (actualTypes.length === 0 && actualRefs.length === 0) {
    return {
      schemaVersion: 1,
      status: 'unknown',
      mode,
      expectedTypes: contract.expectedTypes,
      actualTypes: [],
      preferredRefs: contract.preferredRefs,
      actualRefs: [],
      fallbackUsed: targetDecision?.fallbackUsed === true,
      allowed: mode !== 'strict',
      severity: mode === 'strict' ? 'high' : 'medium',
      reason: 'The editor did not report any selected or updated target asset.',
    }
  }
  const expectedTypes = contract.expectedTypes
  const disallowed = new Set(contract.disallowedFallbackTypes ?? [])
  const allowedFallbacks = new Set(contract.allowedFallbackTypes ?? [])
  const typeMatches =
    expectedTypes.length === 0 ||
    actualTypes.some(type => expectedTypes.includes(type))
  const refMatches =
    contract.preferredRefs.length === 0 ||
    actualRefs.some(actual =>
      contract.preferredRefs.some(preferred => sameAssetRef(actual, preferred)),
    )
  const disallowedTypeUsed = actualTypes.some(
    type => disallowed.has(type) && !expectedTypes.includes(type),
  )
  const fallbackUsed =
    targetDecision?.fallbackUsed === true ||
    (expectedTypes.length > 0 && actualTypes.some(type => !expectedTypes.includes(type)))
  const fallbackAllowed =
    !fallbackUsed ||
    actualTypes.every(type => expectedTypes.includes(type) || allowedFallbacks.has(type)) ||
    (contract.roleFallbackAllowed === true && actualTypes.every(type => type === 'role'))
  const requiredTypeMatches = !contract.requiredAnyTypes?.length || actualTypes.some(type => contract.requiredAnyTypes!.includes(type))
  const matched = typeMatches && refMatches && requiredTypeMatches && !disallowedTypeUsed
  const deviated = !matched || disallowedTypeUsed || !fallbackAllowed
  return {
    schemaVersion: 1,
    status: deviated ? 'deviated' : 'matched',
    mode,
    expectedTypes,
    actualTypes,
    preferredRefs: contract.preferredRefs,
    actualRefs,
    fallbackUsed,
    allowed: !deviated || mode !== 'strict',
    severity: deviated ? (mode === 'strict' ? 'high' : 'medium') : 'none',
    reason: deviated
      ? `Target decision deviated from contract: expected ${expectedTypes.join(', ') || 'any'} / ${contract.preferredRefs.join(', ') || 'any ref'}, got ${actualTypes.join(', ') || 'unknown'} / ${actualRefs.join(', ') || 'no refs'}.`
      : 'Target decision conforms to the direct-edit target contract.',
  }
}

export function targetConformanceBlocksAcceptance(
  conformance: MatOSEvolutionTargetConformance,
): boolean {
  return (
    conformance.mode === 'strict' &&
    conformance.status !== 'matched' &&
    conformance.allowed === false
  )
}

function highRiskTypes(
  values: MatOSEvolutionTargetAssetType[],
): MatOSEvolutionTargetAssetType[] {
  return unique(values.filter(type => HIGH_RISK_DIRECT_EDIT_TYPES.has(type))).sort()
}

export function evaluateMatOSEvolutionHighRiskAssetPolicy(input: {
  contract?: MatOSEvolutionTargetContract
  targetConformance: MatOSEvolutionTargetConformance
  editorOutput: {
    targetDecision?: MatOSDirectAssetEditorTargetDecision
    createdAssets?: string[]
    updatedAssets?: string[]
    disabledAssets?: string[]
  }
}): MatOSEvolutionHighRiskAssetPolicy {
  const contract = normalizeMatOSEvolutionTargetContract(input.contract)
  const createdTypes = highRiskTypes(
    (input.editorOutput.createdAssets ?? [])
      .map(assetTypeFromRef)
      .filter((type): type is MatOSEvolutionTargetAssetType => Boolean(type)),
  )
  const actualTypes = highRiskTypes(input.targetConformance.actualTypes)
  const expectedTypes = highRiskTypes(contract?.expectedTypes ?? [])
  const highRiskTouched = actualTypes.length > 0 || createdTypes.length > 0
  const clear = (reason: string): MatOSEvolutionHighRiskAssetPolicy => ({
    schemaVersion: 1,
    status: 'clear',
    blocked: false,
    severity: 'none',
    highRiskCreatedTypes: createdTypes,
    highRiskActualTypes: actualTypes,
    highRiskExpectedTypes: expectedTypes,
    reason,
  })
  const blocked = (
    reason: string,
    severity: 'medium' | 'high' = 'high',
  ): MatOSEvolutionHighRiskAssetPolicy => ({
    schemaVersion: 1,
    status: 'blocked',
    blocked: true,
    severity,
    highRiskCreatedTypes: createdTypes,
    highRiskActualTypes: actualTypes,
    highRiskExpectedTypes: expectedTypes,
    reason,
  })

  if (!highRiskTouched) {
    return clear('No high-risk role or workflow asset was created or selected.')
  }
  if (input.targetConformance.mode === 'shadow') {
    return clear('High-risk asset policy is observing only because target mode is shadow.')
  }

  const highRiskExpectedOrActual =
    expectedTypes.length > 0 || actualTypes.length > 0
  if (
    highRiskExpectedOrActual &&
    input.targetConformance.status === 'deviated'
  ) {
    return blocked(
      `Role/workflow direct edits must not deviate from the deterministic target contract: ${input.targetConformance.reason}`,
    )
  }

  if (createdTypes.length > 0) {
    if (!contract) {
      return blocked(
        `Creating new ${createdTypes.join('/')} assets requires an explicit target contract; update existing assets or create a lower-risk skill/knowledge/tool/MCP asset instead.`,
      )
    }
    const unexpectedCreated = createdTypes.filter(
      type => !contract.expectedTypes.includes(type),
    )
    if (unexpectedCreated.length > 0) {
      return blocked(
        `Creating new ${unexpectedCreated.join('/')} assets is outside the target contract expected types: ${contract.expectedTypes.join(', ') || 'none'}.`,
      )
    }
    if (input.targetConformance.status !== 'matched') {
      return blocked(
        `Creating new ${createdTypes.join('/')} assets requires matched target conformance, got ${input.targetConformance.status}: ${input.targetConformance.reason}`,
      )
    }
  }

  return clear('High-risk role/workflow edit matches the deterministic target contract.')
}

export function highRiskAssetPolicyBlocksAcceptance(
  policy: MatOSEvolutionHighRiskAssetPolicy | undefined,
): boolean {
  return policy?.blocked === true
}
