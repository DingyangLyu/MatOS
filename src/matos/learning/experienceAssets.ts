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

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetReferences,
  getMatOSAssetSubgraph,
} from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import { withMatOSAssetHistoryLock } from '../assets/history/index.js'
import { getMatOSAssetsDir } from '../project.js'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import { readMatOSSessionEventsFromPath } from '../sessions/sessionIndex.js'
import { hasMatOSSecretLookingContent } from '../assets/secretScan.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import { ensureGeneratedAssetDir, writeGeneratedAssetFile } from './generatedAssetFiles.js'
import { refineMatOSExperienceWithLLM } from './experienceRefiner.js'
import {
  runMatOSUserFeedbackAnalysis,
  type MatOSUserFeedbackAnalysis,
  type MatOSUserFeedbackAnalyzer,
} from './userFeedbackSignals.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'

const EXPERIENCE_VERSION = '0.1.0'
const MAX_EXAMPLES = 12
const MAX_EXCERPT_CHARS = 500
// Bound LLM-produced arrays so a malformed/oversized refiner output cannot write
// a giant asset.json / EXPERIENCE.md.
const MAX_LIST_ITEMS = 20
const MAX_FAILURE_MODES = 8
const MAX_SOURCE_REFS = 50
const REDACTED_EXCERPT = '<REDACTED>'

function capArray<T>(values: T[], limit: number): T[] {
  return values.length > limit ? values.slice(0, limit) : values
}
const GENERIC_TOOL_SLUGS = new Set([
  'bash',
  'read',
  'glob',
  'grep',
  'ls',
  'taskcreate',
  'taskoutput',
  'taskupdate',
])
const ACCEPTANCE_PATTERN =
  /(就是这样|这样就对|结果是对|是对的|正确|成功|可以|没问题|很好|works?|correct|good)/i
const CORRECTION_PATTERN =
  /(不对|不是|错了|失败|报错|应该|需要|注意|改成|修一下|不应该|must|should|failed|error)/i
const ASSET_GRAPH_EVOLUTION_TARGET_REF = 'knowledge:asset-graph-evolution-runbook'

export type ExperienceExample = {
  traceRef: string
  sessionRef?: string
  outcome: string
  excerpt?: string
  toolName?: string
  errorSummary?: string
  recoverySummary?: string
  sourceRefs: string[]
}

export type ExperienceScenario = {
  domain: string
  taskType: string
  failureMode: string
  appliesWhen: string[]
  doesNotApplyWhen: string[]
}

export type ExperienceFailureMode = {
  name: string
  symptoms: string[]
  rootCause: string
  avoidance: string[]
}

type ExperienceQuality = {
  level: 'low' | 'medium' | 'high'
  score: number
  reasons: string[]
}

type ToolCompletionFact = {
  toolName: string
  toolSlug: string
  isError: boolean
  summary?: string
}

type ExperienceTargetAssetType =
  | 'role'
  | 'skill'
  | 'workflow'
  | 'tool'
  | 'mcp'
  | 'knowledge'

const EXPERIENCE_TARGET_ASSET_TYPES = new Set<ExperienceTargetAssetType>([
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
])

type ExperienceDraft = {
  id: string
  baseId?: string
  mergeKey: string
  name: string
  summary: string
  scope?: 'user' | 'team' | 'project'
  scopeRef?: string
  sourceFormat?: string
  roles: string[]
  tools: string[]
  toolNames: string[]
  signalKinds: string[]
  scenario?: ExperienceScenario
  quality?: ExperienceQuality
  problemSignals?: string[]
  failureModes?: ExperienceFailureMode[]
  recommendedActions?: string[]
  avoidRepeating?: string[]
  checklist?: string[]
  targetAssetRefs?: string[]
  targetAssetTypes?: ExperienceTargetAssetType[]
  directEditRecommended?: boolean
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  examples: ExperienceExample[]
}

export type MatOSExperienceRefinerInput = {
  cwd: string
  sessionPath: string
  events: MatOSEventSource[]
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  traceEnv?: Record<string, string>
}

export type MatOSExperienceRefinerResult = {
  shouldWrite: boolean
  reason?: string
  id?: string
  mergeKey?: string
  name?: string
  summary?: string
  scenario?: ExperienceScenario
  problemSignals?: string[]
  failureModes?: ExperienceFailureMode[]
  recommendedActions?: string[]
  avoidRepeating?: string[]
  checklist?: string[]
  targetAssetRefs?: string[]
  targetAssetTypes?: ExperienceTargetAssetType[]
  directEditRecommended?: boolean
  examples?: Array<Partial<ExperienceExample>>
}

export type MatOSExperienceRefiner = (
  input: MatOSExperienceRefinerInput,
) => Promise<MatOSExperienceRefinerResult | undefined>

export type MatOSExperienceAssetSummary = {
  ref: string
  id: string
  name: string
  version: string | undefined
  description: string | undefined
  lifecycle: string
  manifestPath: string
  entryPath: string | undefined
  sourcePath: string
  mergeKey: unknown
  evidenceCount: unknown
  signalKinds: unknown
  metadata: Record<string, unknown>
}

type ExistingExperienceMetadata = {
  examples?: unknown
}

type ExperienceWriteScope = {
  scope: 'user' | 'team' | 'project'
  scopeRef: string
  scopeId: string
  rootKind: 'users' | 'teams' | 'projects'
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/@[^@]+$/, '')
      .replace(/^[a-z0-9-]+:/, '')
      .replace(/_/g, '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'general'
  )
}

function safeScopeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'default'
  )
}

function eventScopeRef(event: MatOSEventSource): string | undefined {
  const data =
    event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {}
  return (
    stringValue(event.scopeRef) ??
    stringValue(data.scopeRef) ??
    stringValue(data.scope)
  )
}

function experienceWriteScopeFromScopeRef(
  scopeRef: string | undefined,
): ExperienceWriteScope | undefined {
  const ref = scopeRef?.trim()
  if (!ref) {
    return undefined
  }
  if (ref.startsWith('user:')) {
    return {
      scope: 'user',
      scopeRef: ref,
      scopeId: safeScopeId(ref),
      rootKind: 'users',
    }
  }
  if (ref.startsWith('team:')) {
    return {
      scope: 'team',
      scopeRef: ref,
      scopeId: safeScopeId(ref),
      rootKind: 'teams',
    }
  }
  if (ref.startsWith('project:')) {
    return {
      scope: 'project',
      scopeRef: ref,
      scopeId: safeScopeId(ref),
      rootKind: 'projects',
    }
  }
  return undefined
}

function experienceWriteScopeFromEvents(
  events: MatOSEventSource[],
): ExperienceWriteScope | undefined {
  return experienceWriteScopeFromScopeRef(events.map(eventScopeRef).find(Boolean))
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function redactedStringValue(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? undefined
        : JSON.stringify(value)
  if (!raw || raw.trim().length === 0) {
    return undefined
  }
  const redacted = redactTraceValue(raw)
  if (typeof redacted !== 'string') {
    return undefined
  }
  const trimmed = redacted.trim()
  if (!trimmed || trimmed === REDACTED_EXCERPT) {
    return undefined
  }
  return trimmed.slice(0, MAX_EXCERPT_CHARS)
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = redactedStringValue(value)
    if (text) {
      return text
    }
  }
  return undefined
}

function sentenceList(values: string[]): string[] {
  return unique(values.map(value => value.trim()).filter(Boolean))
}

function markdownList(values: string[]): string[] {
  return values.length ? values.map(value => `- ${value}`) : ['- No specific item recorded.']
}

function traceRefFor(event: MatOSEventSource): string {
  return `trace:${event.traceId || event.sessionId || 'unknown'}`
}

function sessionRefFor(event: MatOSEventSource | undefined): string | undefined {
  return event?.sessionId ? `session:${event.sessionId}` : undefined
}

function isErrorLike(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

function successfulExit(data: Record<string, unknown>): boolean {
  return data.exitCode === undefined || data.exitCode === 0
}

function signalKindsFrom(events: MatOSEventSource[]): string[] {
  const kinds: string[] = []
  for (const event of events) {
    const text = stringValue(event.data.prompt ?? event.data.promptPreview)
    if (event.type === 'matos.turn.started' && text) {
      if (CORRECTION_PATTERN.test(text)) {
        kinds.push('correction')
      }
      if (ACCEPTANCE_PATTERN.test(text)) {
        kinds.push('acceptance')
      }
      continue
    }
    if (
      event.type === 'matos.tool.call.completed' &&
      isErrorLike(event.data.isError)
    ) {
      kinds.push('failure')
      continue
    }
    if (
      event.type === 'matos.session.failed' ||
      (event.type === 'matos.turn.completed' &&
        event.data.exitCode !== undefined &&
        !successfulExit(event.data))
    ) {
      kinds.push('failure')
      continue
    }
    if (
      event.type === 'matos.session.completed' ||
      (event.type === 'matos.turn.completed' && successfulExit(event.data))
    ) {
      kinds.push('success')
    }
  }
  return unique(kinds)
}

function hasActionableExperienceSignal(signalKinds: string[]): boolean {
  return signalKinds.some(kind =>
    ['acceptance', 'correction', 'failure'].includes(kind),
  )
}

function isZeroTurnResultOnlySession(events: MatOSEventSource[]): boolean {
  return events.some(
    event =>
      event.type === 'matos.session.completed' &&
      event.data.numTurns === 0,
  )
}

function roleSlugsFrom(events: MatOSEventSource[]): string[] {
  return unique(events.map(event => slug(event.roleRef ?? '')).filter(Boolean))
}

function toolSlugsFrom(events: MatOSEventSource[]): string[] {
  const tools: string[] = []
  for (const event of events) {
    const toolName = stringValue(event.data.toolName)
    if (toolName) {
      tools.push(slug(toolName))
    }
  }
  return unique(tools)
}

function toolNamesFrom(events: MatOSEventSource[]): string[] {
  const toolNames: string[] = []
  for (const event of events) {
    const toolName = stringValue(event.data.toolName)
    if (toolName) {
      toolNames.push(toolName)
    }
  }
  return unique(toolNames)
}

function promptExcerptsFrom(events: MatOSEventSource[]): string[] {
  const excerpts: string[] = []
  for (const event of events) {
    if (event.type !== 'matos.turn.started') {
      continue
    }
    const prompt = redactedStringValue(event.data.prompt ?? event.data.promptPreview)
    if (!prompt) {
      continue
    }
    excerpts.push(prompt)
  }
  return unique(excerpts)
}

function outcomeFrom(signalKinds: string[]): string {
  if (signalKinds.includes('failure') && signalKinds.includes('success')) {
    return 'failure-to-success'
  }
  if (signalKinds.includes('correction')) {
    return 'correction'
  }
  if (signalKinds.includes('acceptance')) {
    return 'acceptance'
  }
  if (signalKinds.includes('success')) {
    return 'success'
  }
  return 'observed'
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  return strings.length > 0 ? strings.map(item => item.trim()) : undefined
}

function hasSecretLikeText(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(value) ||
      hasMatOSSecretLookingContent(value) ||
      /\bbearer\s+[a-z0-9._-]{16,}/i.test(value) ||
      // Reuse the trace scrubber's coverage (JWT `eyJ...`, AWS `AKIA...`, etc.):
      // if it would change the string, it contains a secret-like token.
      redactTraceValue(value) !== value
    )
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretLikeText)
  }
  if (!value || typeof value !== 'object') {
    return false
  }
  return Object.values(value).some(hasSecretLikeText)
}

function isMeaningfulExperienceId(id: string): boolean {
  return /[a-z0-9]/i.test(id)
}

function validScenario(value: unknown): ExperienceScenario | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const domain = stringValue(raw.domain)
  const taskType = stringValue(raw.taskType)
  const failureMode = stringValue(raw.failureMode)
  const appliesWhen = nonEmptyStringArray(raw.appliesWhen)
  const doesNotApplyWhen = nonEmptyStringArray(raw.doesNotApplyWhen)
  if (!domain || !taskType || !failureMode || !appliesWhen || !doesNotApplyWhen) {
    return undefined
  }
  return { domain, taskType, failureMode, appliesWhen, doesNotApplyWhen }
}

function validFailureModes(value: unknown): ExperienceFailureMode[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const modes = value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }
    const raw = item as Record<string, unknown>
    const name = stringValue(raw.name)
    const symptoms = nonEmptyStringArray(raw.symptoms)
    const rootCause = stringValue(raw.rootCause)
    const avoidance = nonEmptyStringArray(raw.avoidance)
    if (!name || !symptoms || !rootCause || !avoidance) {
      return []
    }
    return [
      {
        name,
        symptoms: capArray(symptoms, MAX_LIST_ITEMS),
        rootCause,
        avoidance: capArray(avoidance, MAX_LIST_ITEMS),
      },
    ]
  })
  return modes.length > 0 ? capArray(modes, MAX_FAILURE_MODES) : undefined
}

function buildExperienceDraftFromRefinerResult(
  result: MatOSExperienceRefinerResult | undefined,
  events: MatOSEventSource[],
  feedbackAnalysis?: MatOSUserFeedbackAnalysis,
): ExperienceDraft | undefined {
  if (
    result?.shouldWrite !== true ||
    hasSecretLikeText(result) ||
    hasSecretLikeText(feedbackAnalysis)
  ) {
    return undefined
  }
  const id = stringValue(result.id)
  const mergeKey = stringValue(result.mergeKey)
  const name = stringValue(result.name)
  const summary = stringValue(result.summary)
  const scenario = validScenario(result.scenario)
  const failureModes = validFailureModes(result.failureModes)
  const problemSignals = nonEmptyStringArray(result.problemSignals)
  const recommendedActions = nonEmptyStringArray(result.recommendedActions)
  const avoidRepeating = nonEmptyStringArray(result.avoidRepeating)
  const checklist = nonEmptyStringArray(result.checklist)
  const targetAssetRefs = cleanTargetAssetRefs(result.targetAssetRefs)
  const explicitTargetAssetTypes = cleanTargetAssetTypes(result.targetAssetTypes)
  const targetAssetTypes = unique([
    ...explicitTargetAssetTypes,
    ...targetAssetTypesFromRefs(targetAssetRefs),
  ])
  if (
    !id ||
    !isMeaningfulExperienceId(id) ||
    !mergeKey ||
    !name ||
    !summary ||
    !scenario ||
    !failureModes ||
    !recommendedActions ||
    !avoidRepeating ||
    !checklist
  ) {
    return undefined
  }
  const first = events[0]
  const traceRef = first ? traceRefFor(first) : 'trace:unknown'
  const sourceRefs = capArray(
    unique([
      traceRef,
      ...(first?.sessionId ? [`session:${first.sessionId}`] : []),
      ...events
        .filter(event => !event.type.startsWith('matos.learning.'))
        .map(event => `event:${event.id}`),
    ]),
    MAX_SOURCE_REFS,
  )
  const examples =
    Array.isArray(result.examples) && result.examples.length > 0
      ? capArray(result.examples, MAX_EXAMPLES)
      : [{ outcome: outcomeFrom(signalKindsFrom(events)) }]
  return {
    id: slug(id),
    mergeKey,
    name,
    summary,
    sourceFormat: 'matos-experience-llm-v1',
    roles: roleSlugsFrom(events),
    tools: toolSlugsFrom(events),
    toolNames: toolNamesFrom(events),
    signalKinds: signalKindsFrom(events),
    scenario,
    problemSignals: capArray(problemSignals ?? [], MAX_LIST_ITEMS),
    failureModes,
    recommendedActions: capArray(recommendedActions, MAX_LIST_ITEMS),
    avoidRepeating: capArray(avoidRepeating, MAX_LIST_ITEMS),
    checklist: capArray(checklist, MAX_LIST_ITEMS),
    ...(targetAssetRefs.length > 0 ? { targetAssetRefs } : {}),
    ...(targetAssetTypes.length > 0 ? { targetAssetTypes } : {}),
    ...(result.directEditRecommended === true ||
    targetAssetRefs.length > 0 ||
    targetAssetTypes.length > 0
      ? { directEditRecommended: true }
      : {}),
    ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
    examples: examples.map(example => ({
      traceRef,
      ...(sessionRefFor(first) ? { sessionRef: sessionRefFor(first) } : {}),
      outcome: stringValue(example.outcome) ?? outcomeFrom(signalKindsFrom(events)),
      ...(redactedStringValue(example.excerpt)
        ? { excerpt: redactedStringValue(example.excerpt) }
        : {}),
      ...(stringValue(example.toolName)
        ? { toolName: stringValue(example.toolName) }
        : {}),
      ...(redactedStringValue(example.errorSummary)
        ? { errorSummary: redactedStringValue(example.errorSummary) }
        : {}),
      ...(redactedStringValue(example.recoverySummary)
        ? { recoverySummary: redactedStringValue(example.recoverySummary) }
        : {}),
      sourceRefs,
    })),
  }
}

function toolFactsFrom(events: MatOSEventSource[]): ToolCompletionFact[] {
  const facts: ToolCompletionFact[] = []
  for (const event of events) {
    if (event.type !== 'matos.tool.call.completed') {
      continue
    }
    const toolName = stringValue(event.data.toolName)
    if (!toolName) {
      continue
    }
    facts.push({
      toolName,
      toolSlug: slug(toolName),
      isError: isErrorLike(event.data.isError),
      summary: firstStringValue(
        event.data.resultPreview,
        event.data.errorSummary,
        event.data.error,
        event.data.message,
        event.data.stderr,
        event.data.outputPreview,
        event.data.result,
      ),
    })
  }
  return facts
}

function textCorpusFrom(input: {
  prompts: string[]
  toolFacts: ToolCompletionFact[]
  toolNames: string[]
}): string {
  return [
    ...input.prompts,
    ...input.toolFacts.flatMap(fact => [fact.toolName, fact.summary ?? '']),
    ...input.toolNames,
  ]
    .filter(Boolean)
    .join('\n')
}

function targetAssetTypeFromRef(
  ref: string,
): ExperienceTargetAssetType | undefined {
  const prefix = ref.trim().split(':', 1)[0] as ExperienceTargetAssetType
  return EXPERIENCE_TARGET_ASSET_TYPES.has(prefix) ? prefix : undefined
}

function cleanTargetAssetRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return capArray(
    unique(
      value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => {
          if (
            !item ||
            !item.includes(':') ||
            item.includes('/') ||
            item.includes('\\') ||
            item.includes('\0')
          ) {
            return false
          }
          if (
            /(^|[._:-])(env|secret|secrets|token|tokens|credential|credentials|password|passwd|auth|id_rsa)([._:@-]|$)/i.test(
              item,
            )
          ) {
            return false
          }
          return Boolean(targetAssetTypeFromRef(item))
        }),
    ),
    MAX_LIST_ITEMS,
  )
}

function targetAssetTypesFromRefs(refs: string[]): ExperienceTargetAssetType[] {
  return unique(
    refs
      .map(targetAssetTypeFromRef)
      .filter((type): type is ExperienceTargetAssetType => Boolean(type)),
  )
}

function cleanTargetAssetTypes(value: unknown): ExperienceTargetAssetType[] {
  if (!Array.isArray(value)) {
    return []
  }
  return capArray(
    unique(
      value
        .filter((item): item is string => typeof item === 'string')
        .filter((item): item is ExperienceTargetAssetType =>
          EXPERIENCE_TARGET_ASSET_TYPES.has(item as ExperienceTargetAssetType),
        ),
    ),
    MAX_LIST_ITEMS,
  )
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function allMountRefs(asset: MatOSAsset): string[] {
  return unique(getMatOSAssetReferences(asset))
}

function canonicalRefBase(ref: string): string {
  return ref.trim().replace(/@[^@/]+$/, '')
}

function assetRefBase(asset: MatOSAsset): string {
  return canonicalRefBase(asset.canonicalKey)
}

function sameAssetRef(left: string, right: string): boolean {
  return canonicalRefBase(left) === canonicalRefBase(right)
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, ' ')
    .toLowerCase()
}

const TARGET_TOKEN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'api',
  'asset',
  'call',
  'code',
  'error',
  'failed',
  'failure',
  'for',
  'from',
  'in',
  'is',
  'json',
  'matos',
  'mcp',
  'of',
  'on',
  'or',
  'result',
  'the',
  'to',
  'tool',
  'true',
  'with',
])

function tokensFor(value: string): string[] {
  return unique(
    normalizeSearchText(value)
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !TARGET_TOKEN_STOPWORDS.has(token)),
  )
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function nestedStringValue(
  object: Record<string, unknown>,
  path: string[],
): string | undefined {
  let current: unknown = object
  for (const key of path) {
    current = objectValue(current)[key]
  }
  return stringValue(current)
}

function assetSearchTexts(asset: MatOSAsset): string[] {
  const metadata = objectValue(asset.metadata)
  return [
    asset.id,
    asset.type,
    asset.name,
    asset.description ?? '',
    asset.canonicalKey,
    ...asset.tags,
    ...asset.dependencies,
    ...allMountRefs(asset),
    stringValue(metadata.binding) ?? '',
    stringValue(metadata.family) ?? '',
    nestedStringValue(metadata, ['executor', 'mcpName']) ?? '',
    ...stringArrayValue(metadata.aliases),
    ...stringArrayValue(metadata.toolNames),
    ...stringArrayValue(metadata.toolReferences),
  ].filter(Boolean)
}

function assetTokens(asset: MatOSAsset): string[] {
  return tokensFor(assetSearchTexts(asset).join(' '))
}

function resolveAssetRef(
  assets: MatOSAsset[],
  ref: string,
): MatOSAsset | undefined {
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const resolved = registry.resolve(ref)
  if (resolved) {
    return resolved
  }
  const normalized = canonicalRefBase(ref)
  return assets.find(asset => {
    const base = assetRefBase(asset)
    return (
      base === normalized ||
      asset.canonicalKey === ref.trim() ||
      `${asset.type}:${asset.id}` === normalized ||
      asset.id === normalized
    )
  })
}

function sessionRoleAssets(input: {
  events: MatOSEventSource[]
  assets: MatOSAsset[]
}): MatOSAsset[] {
  const refs = unique(
    input.events
      .map(event => event.roleRef)
      .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0),
  )
  return refs
    .map(ref => resolveAssetRef(input.assets, ref.includes(':') ? ref : `role:${ref}`))
    .filter((asset): asset is MatOSAsset => Boolean(asset))
}

function eventAssetRefs(event: MatOSEventSource): string[] {
  const data = objectValue(event.data)
  const refs: string[] = []
  for (const key of ['assetRef', 'ref', 'canonicalKey', 'workflowRef']) {
    const value = stringValue(data[key])
    if (value) {
      refs.push(value)
    }
  }
  if (event.type === 'matos.asset.loaded') {
    const type = stringValue(data.type)
    const id = stringValue(data.id)
    if (type && id) {
      refs.push(`${type}:${id}`)
    }
  }
  if (event.roleRef?.trim()) {
    refs.push(
      event.roleRef.trim().includes(':')
        ? event.roleRef.trim()
        : `role:${event.roleRef.trim()}`,
    )
  }
  return refs
}

function expandSessionAssets(input: {
  events: MatOSEventSource[]
  assets: MatOSAsset[]
}): MatOSAsset[] {
  const registry = buildMatOSAssetRegistry(input.assets, { includeDisabled: true })
  const selected = new Map<string, MatOSAsset>()
  const seedRefs = orderedUnique([
    ...input.events.flatMap(eventAssetRefs),
    ...sessionRoleAssets(input).map(asset => asset.canonicalKey),
  ])
  for (const ref of seedRefs) {
    for (const asset of getMatOSAssetSubgraph(registry, ref)) {
      if (asset.canonicalKey && !selected.has(asset.canonicalKey)) {
        selected.set(asset.canonicalKey, asset)
      }
    }
  }
  return [...selected.values()]
}

function assetMatchesToolFact(asset: MatOSAsset, fact: ToolCompletionFact): boolean {
  const metadata = objectValue(asset.metadata)
  const identifiers = unique([
    asset.id,
    asset.name,
    asset.canonicalKey,
    `${asset.type}:${asset.id}`,
    stringValue(metadata.binding) ?? '',
    nestedStringValue(metadata, ['executor', 'mcpName']) ?? '',
    ...stringArrayValue(metadata.aliases),
    ...stringArrayValue(metadata.toolNames),
  ])
  const factIdentifiers = unique([
    fact.toolName,
    fact.toolSlug,
    normalizeSearchText(fact.toolName).replace(/\s+/g, '-'),
    normalizeSearchText(fact.toolName).replace(/\s+/g, '_'),
  ])
  return identifiers.some(identifier => {
    const normalizedIdentifier = normalizeSearchText(identifier).replace(/\s+/g, '-')
    return factIdentifiers.some(factIdentifier => {
      const normalizedFact = normalizeSearchText(factIdentifier).replace(/\s+/g, '-')
      return normalizedIdentifier === normalizedFact
    })
  })
}

function tokenOverlapScore(left: string[], right: string[]): number {
  const rightSet = new Set(right)
  return left.reduce((score, token) => score + (rightSet.has(token) ? 1 : 0), 0)
}

function assetIsTargetType(asset: MatOSAsset): boolean {
  return EXPERIENCE_TARGET_ASSET_TYPES.has(asset.type as ExperienceTargetAssetType)
}

function assetIsToolFailureTargetType(asset: MatOSAsset): boolean {
  return assetIsTargetType(asset) && asset.type !== 'role'
}

function assetDependsOnAny(asset: MatOSAsset, refs: string[]): boolean {
  return allMountRefs(asset).some(ref =>
    refs.some(targetRef => sameAssetRef(ref, targetRef)),
  )
}

function dynamicToolFailureTargets(input: {
  events: MatOSEventSource[]
  corpus: string
  toolFacts: ToolCompletionFact[]
  assets?: MatOSAsset[]
}): { refs: string[]; types: ExperienceTargetAssetType[] } {
  const errored = input.toolFacts.filter(fact => fact.isError)
  if (errored.length === 0 || !input.assets?.length) {
    return { refs: [], types: [] }
  }
  const contextAssets = expandSessionAssets({
    events: input.events,
    assets: input.assets,
  })
  const contextKeys = new Set(contextAssets.map(asset => asset.canonicalKey))
  const candidateAssets = contextAssets
    .filter(asset => asset.lifecycle.status !== 'disabled')
    .filter(assetIsToolFailureTargetType)
  const matched = new Map<string, MatOSAsset>()

  for (const fact of errored) {
    for (const asset of candidateAssets) {
      if (assetMatchesToolFact(asset, fact)) {
        matched.set(asset.canonicalKey, asset)
      }
    }
  }

  const evidenceTokens = tokensFor(
    [
      input.corpus,
      ...errored.flatMap(fact => [fact.toolName, fact.toolSlug, fact.summary ?? '']),
    ].join(' '),
  )
  const relevantContextAssets = candidateAssets
    .map(asset => ({
      asset,
      score: tokenOverlapScore(evidenceTokens, assetTokens(asset)),
    }))
    .filter(item => item.score >= 2)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.asset.canonicalKey.localeCompare(b.asset.canonicalKey),
    )
    .slice(0, MAX_LIST_ITEMS)
  for (const item of relevantContextAssets) {
    matched.set(item.asset.canonicalKey, item.asset)
  }

  const matchedRefs = [...matched.values()].map(asset => assetRefBase(asset))
  for (const asset of candidateAssets) {
    if (!contextKeys.has(asset.canonicalKey)) {
      continue
    }
    if (assetDependsOnAny(asset, matchedRefs)) {
      matched.set(asset.canonicalKey, asset)
    }
  }

  if (matched.size === 0 && errored.some(fact => !GENERIC_TOOL_SLUGS.has(fact.toolSlug))) {
    return { refs: [], types: ['tool', 'mcp', 'knowledge'] }
  }
  const refs = orderedUnique([...matched.values()]
    .map(asset => assetRefBase(asset))
  )
    .slice(0, MAX_LIST_ITEMS)
  return {
    refs,
    types: targetAssetTypesFromRefs(refs),
  }
}

function hasAssetGraphSignal(input: {
  corpus: string
  toolFacts: ToolCompletionFact[]
}): boolean {
  const corpus = input.corpus.toLowerCase()
  return input.toolFacts.some(fact => {
    const text = [
      fact.toolName,
      fact.toolSlug,
      fact.summary ?? '',
    ]
      .join(' ')
      .toLowerCase()
    if (
      /asset[-_]graph|asset[-_]related|asset[-_]impact|asset[-_]lineage/.test(text)
    ) {
      return true
    }
    if (/asset[-_]search|asset[-_]list|asset[-_]show|asset[-_]read/.test(text)) {
      return /(graphrank|asset graph|图谱|依赖图|关系图|lineage|related|dependency|dependencies|rank)/i.test(
        corpus,
      )
    }
    return false
  })
}

function dynamicAssetGraphEvolutionTargets(input: {
  corpus: string
  toolFacts: ToolCompletionFact[]
}): { refs: string[]; types: ExperienceTargetAssetType[] } {
  if (!hasAssetGraphSignal(input)) {
    return { refs: [], types: [] }
  }
  return {
    refs: [ASSET_GRAPH_EVOLUTION_TARGET_REF],
    types: ['knowledge'],
  }
}

function dynamicWorkflowFailureTargets(input: {
  events: MatOSEventSource[]
  assets?: MatOSAsset[]
}): { refs: string[]; types: ExperienceTargetAssetType[] } {
  if (!input.assets?.length) {
    return { refs: [], types: [] }
  }
  const hasWorkflowFailure = input.events.some(event => {
    const data = objectValue(event.data)
    return (
      event.type === 'matos.session.failed' ||
      stringValue(data.status)?.toLowerCase() === 'failed'
    )
  })
  if (!hasWorkflowFailure) {
    return { refs: [], types: [] }
  }
  const workflowRefs = orderedUnique(
    input.events.flatMap(event => {
      const workflowRef = stringValue(objectValue(event.data).workflowRef)
      return workflowRef ? [workflowRef] : []
    }),
  )
  if (workflowRefs.length === 0) {
    return { refs: [], types: [] }
  }
  const registry = buildMatOSAssetRegistry(input.assets, { includeDisabled: true })
  const targets = new Map<string, MatOSAsset>()
  for (const ref of workflowRefs) {
    for (const asset of getMatOSAssetSubgraph(registry, ref)) {
      if (
        asset.lifecycle.status !== 'disabled' &&
        assetIsToolFailureTargetType(asset)
      ) {
        targets.set(asset.canonicalKey, asset)
      }
    }
  }
  const refs = orderedUnique(
    [...targets.values()].map(asset => assetRefBase(asset)),
  ).slice(0, MAX_LIST_ITEMS)
  return {
    refs,
    types: targetAssetTypesFromRefs(refs),
  }
}

function dynamicExperienceTargets(input: {
  events: MatOSEventSource[]
  corpus: string
  toolFacts: ToolCompletionFact[]
  assets?: MatOSAsset[]
}): { refs: string[]; types: ExperienceTargetAssetType[] } {
  const toolTargets = dynamicToolFailureTargets(input)
  const graphTargets = dynamicAssetGraphEvolutionTargets({
    corpus: input.corpus,
    toolFacts: input.toolFacts,
  })
  const workflowTargets = dynamicWorkflowFailureTargets({
    events: input.events,
    assets: input.assets,
  })
  const refs = orderedUnique([
    ...toolTargets.refs,
    ...graphTargets.refs,
    ...workflowTargets.refs,
  ]).slice(0, MAX_LIST_ITEMS)
  return {
    refs,
    types: unique([
      ...toolTargets.types,
      ...graphTargets.types,
      ...workflowTargets.types,
      ...targetAssetTypesFromRefs(refs),
    ]),
  }
}

function dynamicToolFailureScenario(input: {
  targetAssetRefs: string[]
  targetAssetTypes: ExperienceTargetAssetType[]
  toolName: string
}): ExperienceScenario | undefined {
  if (input.targetAssetRefs.length === 0 && input.targetAssetTypes.length === 0) {
    return undefined
  }
  const taskType = slug(
    input.targetAssetRefs[0] ?? input.toolName ?? input.targetAssetTypes[0] ?? 'tool',
  )
  return {
    domain: 'tooling',
    taskType,
    failureMode: 'session-tool-asset-gap',
    appliesWhen: [
      'A MatOS session has a concrete failed tool or MCP-backed tool call.',
      'The failed call can be routed through the session role graph and asset registry to actual mounted assets, or to a new asset type when no existing asset matches.',
    ],
    doesNotApplyWhen: [
      'The failure is only a generic shell/file operation with no reusable MatOS tool behavior.',
      'The relevant asset was not part of the active role/session context and cannot be safely inferred from the evidence.',
    ],
  }
}

function queuePayloadScenario(): ExperienceScenario {
  return {
    domain: 'compute',
    taskType: 'queue-submission',
    failureMode: 'payload-incompatible',
    appliesWhen: [
      'A MatOS compute agent is choosing a remote resource queue for a submitted compute job.',
      'The submit path can fail because the queue supports only DevInstance payload types or does not list Job/CustomTask compatibility.',
      'The agent has queue metadata, submit errors, or user feedback mentioning payload compatibility, CustomTask, or queue workload types.',
    ],
    doesNotApplyWhen: [
      'The task is a DevInstance launch rather than a CustomTask submission.',
      'The queue is known to support CustomTask and the failure is only a transient scheduler delay.',
    ],
  }
}

function stuckQueueScenario(): ExperienceScenario {
  return {
    domain: 'compute',
    taskType: 'queue-submission',
    failureMode: 'stuck-queue',
    appliesWhen: [
      'A submitted remote compute job remains in Queue while the agent is trying to select an idle GPU queue.',
      'The evidence mentions idle GPUs, waiting in Queue, scheduler delay, or a queue that appears free but does not start the job.',
    ],
    doesNotApplyWhen: [
      'The submit call failed before a task id was created.',
      'The queue is explicitly incompatible with CustomTask payloads.',
    ],
  }
}

function apiConnectivityScenario(): ExperienceScenario {
  return {
    domain: 'runtime',
    taskType: 'api-connectivity',
    failureMode: 'connection-refused',
    appliesWhen: [
      'A MatOS conversation or workflow is interrupted by API connectivity, authentication, or provider transport failures.',
      'The evidence includes ConnectionRefused, invalid API key, authentication failure, retry exhaustion, or provider endpoint errors.',
    ],
    doesNotApplyWhen: [
      'The failure is a domain tool error with a healthy model/API transport.',
      'The issue is only a slow job scheduler queue.',
    ],
  }
}

function lowQualityExperienceScenario(): ExperienceScenario {
  return {
    domain: 'assets',
    taskType: 'evolution',
    failureMode: 'low-quality-experience',
    appliesWhen: [
      'The self-evolution system creates generic experience assets that do not describe a reusable scenario, root cause, or recovery procedure.',
      'The evidence mentions low-quality generated experience, general-bash drafts, or noisy asset accumulation.',
    ],
    doesNotApplyWhen: [
      'The generated experience already has a specific scenario, failure mode, and useful action checklist.',
    ],
  }
}

function assetGraphEvolutionScenario(): ExperienceScenario {
  return {
    domain: 'assets',
    taskType: 'asset-graph',
    failureMode: 'graph-routing-gap',
    appliesWhen: [
      'A MatOS agent used asset_graph, graph-ranked asset_search, or related asset graph discovery while trying to reuse assets or build a workflow.',
      'The graph result was too noisy, missed a useful source asset, used the wrong profile, or did not help the agent choose role/tool/skill/workflow dependencies.',
      'The stable fix should be encoded by editing source assets, graph guidance, role mounts, workflow dependencies, or tool/skill metadata rather than by hand-editing graph output.',
    ],
    doesNotApplyWhen: [
      'The issue is only a one-off search query wording problem with no reusable graph or asset routing lesson.',
      'The graph output was correct and the failure belongs entirely to a downstream compute or external service tool.',
    ],
  }
}

function classifyScenario(input: {
  corpus: string
  toolFacts: ToolCompletionFact[]
}): ExperienceScenario | undefined {
  const corpus = input.corpus.toLowerCase()
  const hasSpecificErroredTool = input.toolFacts.some(
    fact => fact.isError && !GENERIC_TOOL_SLUGS.has(fact.toolSlug),
  )
  if (
    hasSpecificErroredTool &&
    /(customtask|payload|excluding customtask|workload types?|devinstance)/i.test(
      input.corpus,
    )
  ) {
    return queuePayloadScenario()
  }
  if (
    hasSpecificErroredTool &&
    /(queue|排队|stuck|idle gpu|空闲|scheduler|调度|gpu)/i.test(input.corpus)
  ) {
    return stuckQueueScenario()
  }
  if (
    /(connectionrefused|unable to connect|invalid api key|authentication fails|api key|provider|retrying)/i.test(
      input.corpus,
    )
  ) {
    return apiConnectivityScenario()
  }
  if (
    /(general-bash|low-quality experience|experience 太垃圾|经验太垃圾|自进化|self-evolution)/i.test(
      input.corpus,
    )
  ) {
    return lowQualityExperienceScenario()
  }
  if (
    hasAssetGraphSignal(input) &&
    /(asset_graph|asset graph|graphrank|图谱|依赖图|关系图|检索|复用|workflow|工作流|asset|资产|noisy|noise|missing|missed|profile|dependency|lineage)/i.test(
      input.corpus,
    )
  ) {
    return assetGraphEvolutionScenario()
  }
  if (corpus.includes('customtask') && corpus.includes('queue')) {
    return queuePayloadScenario()
  }
  return undefined
}

function failureModeFor(input: {
  scenario: ExperienceScenario
  errorSummary?: string
}): ExperienceFailureMode {
  if (input.scenario.failureMode === 'payload-incompatible') {
    return {
      name: 'Queue payload incompatibility',
      symptoms: sentenceList([
        'Submit fails with a message that the resource queue allows DevInstance payload types but excludes CustomTask.',
        input.errorSummary ?? '',
        'The queue may look idle, but it cannot accept the requested CustomTask workload.',
      ]),
      rootCause:
        'Queue selection looked only at apparent availability or historical task usage instead of checking workload/payload compatibility for the exact submit type.',
      avoidance: [
        'Query queue metadata with the intended payload type before generating or submitting the YAML.',
        'Treat queues that lack Job/CustomTask support as incompatible even if they have idle GPUs.',
        'Keep the incompatible queue marked in the local decision context so the agent does not retry it blindly.',
      ],
    }
  }
  if (input.scenario.failureMode === 'stuck-queue') {
    return {
      name: 'Scheduler queue remains pending',
      symptoms: sentenceList([
        'A submitted task stays in Queue for longer than expected.',
        input.errorSummary ?? '',
        'Queue telemetry may report idle GPUs while the scheduler still does not launch the worker.',
      ]),
      rootCause:
        'Queue availability was inferred from aggregate GPU counts without confirming scheduler readiness, priority, quota, and flavor compatibility for the submitted job.',
      avoidance: [
        'After submission, poll both task status and queue capability instead of assuming idle GPUs imply immediate start.',
        'If the task remains queued, retry with a documented attempt directory and a compatible flavor only after superseding the stuck task.',
      ],
    }
  }
  if (input.scenario.domain === 'tooling') {
    return {
      name: 'Known MatOS tool or MCP failure',
      symptoms: sentenceList([
        'A MatOS tool or MCP-backed tool returned a concrete error during normal agent use.',
        input.errorSummary ?? '',
        'The failure maps to one or more editable MatOS tool, MCP, skill, or knowledge assets.',
      ]),
      rootCause:
        'The reusable behavior gap belongs in the mapped MatOS asset: schema/prompt/code, path/env translation, preflight checks, status/error classification, service bridge logic, or runbook guidance.',
      avoidance: [
        'Inspect and update the mapped MatOS asset instead of leaving the lesson only as an experience.',
        'Prefer the smallest asset-local fix: prompt/schema/tool code/MCP config/runbook guidance before broad role changes.',
        'Run a real tool smoke or preserve a concrete reproduction before treating the fix as complete.',
      ],
    }
  }
  if (input.scenario.failureMode === 'graph-routing-gap') {
    return {
      name: 'Asset graph routing or discovery gap',
      symptoms: sentenceList([
        'A MatOS agent used asset graph discovery but the result did not make the next asset, workflow, or dependency choice clear.',
        input.errorSummary ?? '',
        'The evidence mentions graph profile selection, noisy edges, missing dependencies, or failure to reuse existing role/skill/tool/workflow assets.',
      ]),
      rootCause:
        'The graph is derived from source assets and evidence. A noisy or incomplete graph usually means the source asset manifests, mounts, dependencies, summaries, tags, workflow links, or graph usage guidance need a focused update.',
      avoidance: [
        'Do not edit generated graph indexes or trace JSONL to force a relationship.',
        'Update the source role, skill, workflow, tool, MCP, or knowledge assets that should own the relationship, then regenerate and validate the graph.',
        'Use profile=core for agent planning by default; use discovery or evidence only when weak similarity or trace usage is intentionally needed.',
      ],
    }
  }
  if (input.scenario.domain === 'runtime') {
    return {
      name: 'Model/API transport disruption',
      symptoms: sentenceList([
        'The user-facing conversation reports connection refusal, authentication failure, or repeated provider retries.',
        input.errorSummary ?? '',
      ]),
      rootCause:
        'The model provider transport, endpoint, token, or local network path became unavailable while MatOS was still running.',
      avoidance: [
        'Check provider env, endpoint health, and token validity before assuming the agent logic failed.',
        'Record the recovery path as an operational experience only when it includes a stable mitigation.',
      ],
    }
  }
  return {
    name: 'Low-quality experience draft',
    symptoms: sentenceList([
      'Generated experience is too generic to guide a future agent.',
      input.errorSummary ?? '',
    ]),
    rootCause:
      'The experience writer used a broad role/tool merge key and wrote a template without scenario, root cause, or anti-regression guidance.',
    avoidance: [
      'Require a scenario-specific merge key before writing an experience asset.',
      'Reject generic Bash-only evidence unless it contains a concrete, reusable failure mode.',
    ],
  }
}

function recommendedActionsFor(scenario: ExperienceScenario): string[] {
  if (scenario.failureMode === 'payload-incompatible') {
    return [
      'Before submitting a remote CustomTask job, query known queues with payload=CustomTask and the required GPU count.',
      'Prefer queues that report Job/CustomTask compatibility and enough idle GPUs; do not rank DevInstance-only queues above compatible queues.',
      'Generate YAML inside a unique attempt directory, then compute and pass the expected YAML digest for production submit.',
      'If a queue rejects CustomTask, mark it incompatible for this submit path and try the next compatible idle queue.',
    ]
  }
  if (scenario.failureMode === 'stuck-queue') {
    return [
      'Poll the task status and queue capability together; do not infer launch success from idle GPU count alone.',
      'If the queue remains stuck, create a new attempt directory and resubmit only with explicit supersede metadata.',
      'Preserve the stuck task id, wait time, flavor, and queue name in the experience evidence.',
    ]
  }
  if (scenario.domain === 'runtime') {
    return [
      'Check API base URL, provider mode, token validity, and network reachability before retrying the same conversation path.',
      'Use a known-good provider configuration for smoke tests and avoid printing raw tokens in logs or docs.',
      'Record whether recovery required env changes, service restart, or only waiting for provider availability.',
    ]
  }
  if (scenario.domain === 'tooling') {
    return [
      'Open the mapped target asset files and identify whether the fix belongs in prompt guidance, schema, MCP/tool implementation code, path/env translation, health checks, status parsing, or runbook text.',
      'Make the smallest direct asset edit that would change the next agent session behavior for this failure family.',
      'Preserve the failing tool name, root cause, and successful recovery as evidence refs or concise prose without copying secrets.',
      'Run a real tool smoke, deterministic validation, or focused reproduction after the edit whenever the tool can be exercised safely.',
    ]
  }
  if (scenario.failureMode === 'graph-routing-gap') {
    return [
      'Treat the graph as derived state: find the source role, skill, workflow, tool, MCP, or knowledge asset whose metadata or dependency edge should change.',
      'For planning and workflow composition, call asset_graph or graph-ranked asset_search with profile=core first; switch to discovery/evidence only for weak similarity or trace-backed usage questions.',
      'When an asset is missing from a result, add or correct top-level dependencies, role mounts, workflow dependencies, tool metadata, skill toolReferences, summaries, or tags instead of editing graph output.',
      'After the asset edit, run matos assets validate and matos assets graph-index --profile core; use discovery/evidence profiles only for the specific behavior being changed.',
    ]
  }
  return [
    'Only write an experience draft when the evidence contains a reusable scenario, root cause, and action checklist.',
    'Reject generic role/tool memories such as general-bash unless they have a specific failure mode.',
  ]
}

function avoidRepeatingFor(scenario: ExperienceScenario): string[] {
  if (scenario.failureMode === 'payload-incompatible') {
    return [
      'Do not select a queue only because it has idle GPUs.',
      'Do not retry a DevInstance-only queue for CustomTask after the submit API has rejected the payload.',
      'Do not hand-edit the queue name in YAML without rechecking digest, attempt directory, and compatibility.',
    ]
  }
  if (scenario.failureMode === 'stuck-queue') {
    return [
      'Do not keep waiting silently when the user asked for active probing.',
      'Do not submit repeated attempts into the same workdir or benchmark case without supersede metadata.',
    ]
  }
  if (scenario.domain === 'runtime') {
    return [
      'Do not treat provider/network failures as proof that the requested MatOS feature is broken.',
      'Do not paste API keys or raw auth tokens into trace, docs, or asset examples.',
    ]
  }
  if (scenario.domain === 'tooling') {
    return [
      'Do not stop after writing an experience if an editable tool, MCP, skill, or knowledge asset is clearly responsible.',
      'Do not route a tool implementation failure only into a broad role prompt unless the mapped target asset is unavailable.',
      'Do not hide a recurring tool error behind generic retry advice without adding preflight, error classification, or runbook guidance.',
    ]
  }
  if (scenario.failureMode === 'graph-routing-gap') {
    return [
      'Do not hand-edit generated graph index JSON, cached view-models, or trace records to make the graph look correct.',
      'Do not create duplicate wrapper assets only to force a search hit when an existing asset should gain a dependency, mount, summary, tag, or workflow edge.',
      'Do not use broad discovery/evidence profiles as the default planning path when core dependency structure is enough.',
    ]
  }
  return [
    'Do not write an experience asset whose lesson is only "a tool failed".',
    'Do not merge unrelated failures into a role/tool bucket.',
  ]
}

function checklistFor(scenario: ExperienceScenario): string[] {
  if (scenario.failureMode === 'payload-incompatible') {
    return [
      'Queue supports Job/CustomTask for the requested payload.',
      'Queue has enough idle GPUs for the chosen flavor.',
      'Workdir includes a unique attempt directory.',
      'YAML digest passed to submit matches the current file.',
      'Rejected queues are recorded as incompatible for this submit path.',
    ]
  }
  if (scenario.failureMode === 'stuck-queue') {
    return [
      'Task id, queue, flavor, and wait duration are recorded.',
      'Queue capability and task status were checked after submission.',
      'Any retry uses a new attempt directory and supersede metadata.',
    ]
  }
  if (scenario.domain === 'runtime') {
    return [
      'Provider env and endpoint are checked.',
      'Token validity is checked without exposing the token value.',
      'Recovery action is recorded separately from the raw failure text.',
    ]
  }
  if (scenario.domain === 'tooling') {
    return [
      'Target asset refs point to editable MatOS assets.',
      'The direct editor prompt includes the mapped tool/MCP/skill/knowledge assets before broad role targets.',
      'The proposed edit stays inside asset-local prompt/schema/config/code/runbook files.',
      'A validation, smoke, or focused reproduction result is attached or recorded.',
    ]
  }
  if (scenario.failureMode === 'graph-routing-gap') {
    return [
      'The edited source asset owns the intended edge or retrieval hint.',
      'No generated graph index, cache, or trace JSONL was manually edited.',
      'matos assets validate succeeds after the source asset edit.',
      'matos assets graph-index --profile core shows the expected strong relationship or keeps weak edges out of the default planning graph.',
    ]
  }
  return [
    'The asset has a scenario-specific merge key.',
    'The markdown includes root cause and anti-regression guidance.',
    'Evidence references are preserved without copying secrets.',
  ]
}

function qualityFor(input: {
  scenario?: ExperienceScenario
  signalKinds: string[]
  toolFacts: ToolCompletionFact[]
  prompts: string[]
}): ExperienceQuality | undefined {
  if (!input.scenario) {
    return undefined
  }
  const errorFacts = input.toolFacts.filter(fact => fact.isError)
  const hasToolErrorDetail = errorFacts.some(fact => fact.summary)
  const hasUserFeedback = input.prompts.some(
    prompt => CORRECTION_PATTERN.test(prompt) || ACCEPTANCE_PATTERN.test(prompt),
  )
  const hasRecovery =
    input.signalKinds.includes('failure') && input.signalKinds.includes('success')
  const hasNonGenericTool = input.toolFacts.some(
    fact => !GENERIC_TOOL_SLUGS.has(fact.toolSlug),
  )
  const reasons = [
    input.scenario ? 'known-scenario' : '',
    hasToolErrorDetail ? 'tool-error-detail' : '',
    hasUserFeedback ? 'user-feedback' : '',
    hasRecovery ? 'failure-to-success' : '',
    hasNonGenericTool ? 'non-generic-tool' : '',
  ].filter(Boolean)

  if (
    errorFacts.length > 0 &&
    !hasNonGenericTool &&
    !hasToolErrorDetail &&
    !hasUserFeedback
  ) {
    return undefined
  }
  if (reasons.length < 2) {
    return undefined
  }
  const score = Math.min(1, reasons.length / 5)
  return {
    level: score >= 0.8 ? 'high' : score >= 0.4 ? 'medium' : 'low',
    score,
    reasons,
  }
}

function buildExperienceDraftFromEvents(
  events: MatOSEventSource[],
  targetContext?: { assets?: MatOSAsset[] },
): ExperienceDraft | undefined {
  const signalKinds = signalKindsFrom(events)
  if (!hasActionableExperienceSignal(signalKinds)) {
    return undefined
  }
  const roles = roleSlugsFrom(events)
  const tools = toolSlugsFrom(events)
  const toolNames = toolNamesFrom(events)
  const toolFacts = toolFactsFrom(events)
  const errorFacts = toolFacts.filter(fact => fact.isError)
  const errorSummary = errorFacts.find(fact => fact.summary)?.summary
  const toolName = toolNames[0] ?? tools[0] ?? 'general'
  const excerpts = promptExcerptsFrom(events)
  const corpus = textCorpusFrom({ prompts: excerpts, toolFacts, toolNames })
  const targetAssets = dynamicExperienceTargets({
    events,
    corpus,
    toolFacts,
    assets: targetContext?.assets,
  })
  const targetAssetRefs = targetAssets.refs
  const targetAssetTypes = targetAssets.types
  const scenario =
    classifyScenario({ corpus, toolFacts }) ??
    dynamicToolFailureScenario({
      targetAssetRefs,
      targetAssetTypes,
      toolName,
    })
  const quality = qualityFor({ scenario, signalKinds, toolFacts, prompts: excerpts })
  if (!scenario || !quality) {
    return undefined
  }
  const id = slug(`${scenario.domain}-${scenario.taskType}-${scenario.failureMode}`)
  const mergeKey = `${scenario.domain}:${scenario.taskType}:${scenario.failureMode}`
  const first = events[0]
  const traceRef = first ? traceRefFor(first) : 'trace:unknown'
  const failureMode = failureModeFor({ scenario, errorSummary })
  const recommendedActions = recommendedActionsFor(scenario)
  const avoidRepeating = avoidRepeatingFor(scenario)
  const checklist = checklistFor(scenario)
  const problemSignals = sentenceList([
    ...failureMode.symptoms,
    ...(errorSummary ? [`Observed error detail: ${errorSummary}`] : []),
  ])
  const sourceRefs = unique([
    traceRef,
    ...(first?.sessionId ? [`session:${first.sessionId}`] : []),
    ...events
      .filter(event => !event.type.startsWith('matos.learning.'))
      .map(event => `event:${event.id}`),
  ])

  return {
    id,
    mergeKey,
    name: `Experience: ${scenario.domain} / ${scenario.taskType} / ${scenario.failureMode}`,
    summary: `Reusable experience for ${scenario.domain} ${scenario.taskType} work when the failure mode is ${scenario.failureMode}.`,
    roles,
    tools,
    toolNames,
    signalKinds,
    scenario,
    quality,
    problemSignals,
    failureModes: [failureMode],
    recommendedActions,
    avoidRepeating,
    checklist,
    ...(targetAssetRefs.length > 0 ? { targetAssetRefs } : {}),
    ...(targetAssetTypes.length > 0 ? { targetAssetTypes } : {}),
    ...(targetAssetRefs.length > 0 || targetAssetTypes.length > 0
      ? { directEditRecommended: true }
      : {}),
    examples: [
      {
        traceRef,
        ...(sessionRefFor(first) ? { sessionRef: sessionRefFor(first) } : {}),
        outcome: outcomeFrom(signalKinds),
        ...(excerpts[0] || errorSummary
          ? { excerpt: excerpts[0] ?? errorSummary }
          : {}),
        ...(toolName ? { toolName } : {}),
        ...(errorSummary ? { errorSummary } : {}),
        ...(signalKinds.includes('success')
          ? {
              recoverySummary:
                'The session completed after the failure; preserve the corrected procedure and avoid retrying the rejected path.',
            }
          : {}),
        sourceRefs,
      },
    ],
  }
}

function withDynamicTargetHints(input: {
  draft: ExperienceDraft
  events: MatOSEventSource[]
  assets?: MatOSAsset[]
}): ExperienceDraft {
  if (!input.assets?.length) {
    return input.draft
  }
  const toolFacts = toolFactsFrom(input.events)
  const toolNames = toolNamesFrom(input.events)
  const excerpts = promptExcerptsFrom(input.events)
  const corpus = textCorpusFrom({ prompts: excerpts, toolFacts, toolNames })
  const targetAssets = dynamicExperienceTargets({
    events: input.events,
    corpus,
    toolFacts,
    assets: input.assets,
  })
  const targetAssetRefs = unique([
    ...(input.draft.targetAssetRefs ?? []),
    ...targetAssets.refs,
  ])
  const targetAssetTypes = unique([
    ...(input.draft.targetAssetTypes ?? []),
    ...targetAssets.types,
    ...targetAssetTypesFromRefs(targetAssetRefs),
  ])
  if (targetAssetRefs.length === 0 && targetAssetTypes.length === 0) {
    return input.draft
  }
  return {
    ...input.draft,
    targetAssetRefs,
    targetAssetTypes,
    directEditRecommended: input.draft.directEditRecommended ?? true,
  }
}

function safeExamples(value: unknown): ExperienceExample[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }
    const raw = item as Record<string, unknown>
    const traceRef = stringValue(raw.traceRef)
    if (!traceRef) {
      return []
    }
    return [
      {
        traceRef,
        ...(stringValue(raw.sessionRef)
          ? { sessionRef: stringValue(raw.sessionRef) }
          : {}),
        outcome: stringValue(raw.outcome) ?? 'observed',
        ...(stringValue(raw.excerpt)
          ? { excerpt: stringValue(raw.excerpt) }
          : {}),
        ...(stringValue(raw.toolName)
          ? { toolName: stringValue(raw.toolName) }
          : {}),
        ...(stringValue(raw.errorSummary)
          ? { errorSummary: stringValue(raw.errorSummary) }
          : {}),
        ...(stringValue(raw.recoverySummary)
          ? { recoverySummary: stringValue(raw.recoverySummary) }
          : {}),
        sourceRefs: Array.isArray(raw.sourceRefs)
          ? raw.sourceRefs.filter(
              (sourceRef): sourceRef is string => typeof sourceRef === 'string',
            )
          : [],
      },
    ]
  })
}

async function readExistingExamples(
  manifestPath: string,
): Promise<ExperienceExample[]> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      metadata?: ExistingExperienceMetadata
    }
    return safeExamples(parsed.metadata?.examples)
  } catch {
    return []
  }
}

function mergeExamples(
  current: ExperienceExample[],
  next: ExperienceExample[],
): ExperienceExample[] {
  const byTrace = new Map<string, ExperienceExample>()
  for (const example of [...current, ...next]) {
    const existing = byTrace.get(example.traceRef)
    byTrace.set(example.traceRef, {
      ...existing,
      ...example,
      sourceRefs: unique([
        ...(existing?.sourceRefs ?? []),
        ...example.sourceRefs,
      ]),
    })
  }
  return [...byTrace.values()]
    .sort((a, b) => a.traceRef.localeCompare(b.traceRef))
    .slice(-MAX_EXAMPLES)
}

function experiencesRoot(cwd: string, scope?: ExperienceWriteScope): string {
  if (scope) {
    return join(
      getMatOSAssetsDir(cwd),
      'generated',
      'scopes',
      scope.rootKind,
      scope.scopeId,
      'evolution',
      'experiences',
    )
  }
  return join(getMatOSAssetsDir(cwd), 'generated', 'evolution', 'experiences')
}

function assetDir(cwd: string, id: string, scope?: ExperienceWriteScope): string {
  return join(experiencesRoot(cwd, scope), id)
}

async function findExperienceIdByMergeKey(
  cwd: string,
  mergeKey: string,
  scope?: ExperienceWriteScope,
): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(experiencesRoot(cwd, scope))
  } catch {
    return undefined
  }
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(
        await readFile(join(experiencesRoot(cwd, scope), entry, 'asset.json'), 'utf8'),
      ) as { metadata?: { mergeKey?: unknown } }
      if (stringValue(parsed.metadata?.mergeKey) === mergeKey) {
        return entry
      }
    } catch {
      // Ignore unreadable or partial experience assets.
    }
  }
  return undefined
}

function manifestPath(cwd: string, id: string, scope?: ExperienceWriteScope): string {
  return join(assetDir(cwd, id, scope), 'asset.json')
}

function entryPath(cwd: string, id: string, scope?: ExperienceWriteScope): string {
  return join(assetDir(cwd, id, scope), 'EXPERIENCE.md')
}

function scopedExperienceDraft(
  draft: ExperienceDraft,
  scope: ExperienceWriteScope | undefined,
): ExperienceDraft {
  if (!scope) {
    return draft
  }
  const scopedId = slug(`${scope.scopeId}-${draft.id}`)
  return {
    ...draft,
    id: scopedId,
    baseId: draft.baseId ?? draft.id,
    scope: scope.scope,
    scopeRef: scope.scopeRef,
  }
}

function manifestFor(input: {
  draft: ExperienceDraft
  examples: ExperienceExample[]
}): Record<string, unknown> {
  const v2Metadata = input.draft.scenario
    ? {
        scenario: input.draft.scenario,
        quality: input.draft.quality,
        problemSignals: input.draft.problemSignals ?? [],
        failureModes: input.draft.failureModes ?? [],
        recommendedActions: input.draft.recommendedActions ?? [],
        avoidRepeating: input.draft.avoidRepeating ?? [],
        checklist: input.draft.checklist ?? [],
        ...(input.draft.targetAssetRefs?.length
          ? { targetAssetRefs: input.draft.targetAssetRefs }
          : {}),
        ...(input.draft.targetAssetTypes?.length
          ? { targetAssetTypes: input.draft.targetAssetTypes }
          : {}),
        ...(input.draft.directEditRecommended === true
          ? { directEditRecommended: true }
          : {}),
        ...(input.draft.feedbackAnalysis
          ? { feedbackAnalysis: input.draft.feedbackAnalysis }
          : {}),
      }
    : {}
  return {
    schemaVersion: 1,
    id: input.draft.id,
    type: 'experience',
    name: input.draft.name,
    version: EXPERIENCE_VERSION,
    description: input.draft.summary,
    entry: 'EXPERIENCE.md',
    tags: ['generated', 'learning', 'draft', 'experience'],
    lifecycle: { status: 'draft' },
    metadata: {
      sourceFormat:
        input.draft.sourceFormat ??
        (input.draft.scenario
          ? 'matos-experience-draft-v2'
          : 'matos-experience-draft'),
      lifecycle: 'draft',
      mergeKey: input.draft.mergeKey,
      ...(input.draft.scope ? { scope: input.draft.scope } : {}),
      ...(input.draft.scopeRef ? { scopeRef: input.draft.scopeRef } : {}),
      ...(input.draft.baseId ? { baseExperienceId: input.draft.baseId } : {}),
      evidenceCount: input.examples.length,
      roles: input.draft.roles,
      tools: input.draft.tools,
      toolNames: input.draft.toolNames,
      signalKinds: input.draft.signalKinds,
      ...(input.draft.targetAssetRefs?.length
        ? { targetAssetRefs: input.draft.targetAssetRefs }
        : {}),
      ...(input.draft.targetAssetTypes?.length
        ? { targetAssetTypes: input.draft.targetAssetTypes }
        : {}),
      ...(input.draft.directEditRecommended === true
        ? { directEditRecommended: true }
        : {}),
      examples: input.examples,
      ...v2Metadata,
    },
  }
}

function markdownFor(input: {
  draft: ExperienceDraft
  examples: ExperienceExample[]
}): string {
  if (input.draft.scenario) {
    const scenario = input.draft.scenario
    const failureMode = input.draft.failureModes?.[0]
    const displayTools = input.draft.toolNames.length
      ? input.draft.toolNames.join(', ')
      : 'the relevant tools'
    return [
      `# ${input.draft.name}`,
      '',
      input.draft.summary,
      '',
      '## Background And Applicability',
      ...markdownList(scenario.appliesWhen),
      '',
      '## Problem Signals',
      ...markdownList(input.draft.problemSignals ?? []),
      '',
      '## Error Case',
      ...markdownList(
        input.examples.map(example =>
          [
            example.toolName ? `Tool ${example.toolName}` : `Tools: ${displayTools}`,
            example.errorSummary ? `reported: ${example.errorSummary}` : '',
            `outcome: ${example.outcome}`,
          ]
            .filter(Boolean)
            .join(' - '),
        ),
      ),
      '',
      '## Root Cause',
      failureMode?.rootCause ?? 'No root cause was recorded.',
      '',
      '## Recommended Procedure',
      ...markdownList(input.draft.recommendedActions ?? []),
      '',
      ...(input.draft.targetAssetRefs?.length
        ? [
            '## Suggested Asset Targets',
            ...markdownList(input.draft.targetAssetRefs),
            '',
          ]
        : []),
      ...(input.draft.feedbackAnalysis
        ? [
            '## User Feedback Critic',
            input.draft.feedbackAnalysis.summary,
            '',
            '### Direct-Edit Eligible Feedback',
            ...markdownList(
              input.draft.feedbackAnalysis.decisions
                .filter(decision => decision.recommendedAction === 'direct_edit')
                .map(decision => `${decision.signalId}: ${decision.why}`),
            ),
            '',
          ]
        : []),
      '## Avoid Repeating',
      ...markdownList(input.draft.avoidRepeating ?? []),
      '',
      '## Applicability Boundaries',
      ...markdownList(scenario.doesNotApplyWhen),
      '',
      '## Anti-Regression Checklist',
      ...markdownList(input.draft.checklist ?? []),
      '',
      '## Evidence',
      ...input.examples.flatMap(example => [
        `- ${example.traceRef}${example.sessionRef ? ` / ${example.sessionRef}` : ''} (${example.outcome})`,
        ...(example.excerpt ? [`  - Example: ${example.excerpt}`] : []),
        ...(example.errorSummary
          ? [`  - Error summary: ${example.errorSummary}`]
          : []),
        ...(example.recoverySummary
          ? [`  - Recovery summary: ${example.recoverySummary}`]
          : []),
      ]),
      '',
    ].join('\n')
  }
  const displayTools = input.draft.toolNames.length
    ? input.draft.toolNames
    : input.draft.tools
  const toolList = displayTools.length
    ? displayTools.join(', ')
    : 'general tools'
  const roleList = input.draft.roles.length
    ? input.draft.roles.join(', ')
    : 'general roles'
  return [
    `# ${input.draft.name}`,
    '',
    input.draft.summary,
    '',
    '## General Lesson',
    `Treat repeated corrections, failures, and accepted outcomes for ${roleList} / ${toolList} as reusable soft policy, not as a hard rule.`,
    '',
    '## Soft Policy',
    `- Before repeating a failed action with ${toolList}, check whether prior examples contain a user correction or accepted successful path.`,
    '- Prefer the generalized condition/action from the examples; do not overfit to exact paths, users, or transient queue/resource names.',
    '- Keep trace details as examples for provenance. Do not expose secrets, raw credentials, or unrelated transcript text.',
    '',
    '## Evidence Examples',
    ...input.examples.flatMap(example => [
      `- ${example.traceRef}${example.sessionRef ? ` / ${example.sessionRef}` : ''} (${example.outcome})`,
      ...(example.excerpt ? [`  - Example: ${example.excerpt}`] : []),
    ]),
    '',
  ].join('\n')
}

export async function writeMatOSExperienceDraftAsset(input: {
  cwd: string
  draft: ExperienceDraft
  scopeRef?: string
}): Promise<string> {
  // Serialize the mergeKey lookup + read-merge-write. Without this, concurrent
  // triggers can both miss the mergeKey lookup and create two directories, or
  // interleave the read-modify-write and drop merged examples.
  return withMatOSAssetHistoryLock(
    { cwd: input.cwd, operation: 'experience-write' },
    async () => {
      const scope = experienceWriteScopeFromScopeRef(input.scopeRef)
      const scopedDraft = scopedExperienceDraft(input.draft, scope)
      const resolvedId =
        (await findExperienceIdByMergeKey(input.cwd, input.draft.mergeKey, scope)) ??
        scopedDraft.id
      const draft = { ...scopedDraft, id: resolvedId }
      const dir = assetDir(input.cwd, draft.id, scope)
      // Containment guard: the resolved id can come from a raw directory entry.
      const root = resolve(experiencesRoot(input.cwd, scope))
      const resolvedDir = resolve(dir)
      if (resolvedDir !== root && !resolvedDir.startsWith(`${root}${sep}`)) {
        throw new Error(
          `Refusing experience write outside the experiences root: ${draft.id}`,
        )
      }
      await ensureGeneratedAssetDir(dir)
      const existing = await readExistingExamples(
        manifestPath(input.cwd, draft.id, scope),
      )
      const examples = mergeExamples(existing, draft.examples)
      await writeGeneratedAssetFile(
        manifestPath(input.cwd, draft.id, scope),
        `${JSON.stringify(manifestFor({ draft, examples }), null, 2)}\n`,
      )
      await writeGeneratedAssetFile(
        entryPath(input.cwd, draft.id, scope),
        markdownFor({ draft, examples }),
      )
      return `experience:${draft.id}@${EXPERIENCE_VERSION}`
    },
  )
}

export async function listMatOSExperienceAssets(
  cwd: string,
): Promise<MatOSExperienceAssetSummary[]> {
  const assets = await loadMatOSAssets(cwd)
  return assets
    .filter(asset => asset.type === 'experience')
    .map(asset => ({
      ref: asset.canonicalKey,
      id: asset.id,
      name: asset.name,
      version: asset.version,
      description: asset.description,
      lifecycle: asset.lifecycle.status,
      manifestPath: asset.manifestPath,
      entryPath: asset.entryAbsolutePath,
      sourcePath: asset.sourcePath,
      mergeKey: asset.metadata.mergeKey,
      evidenceCount: asset.metadata.evidenceCount,
      signalKinds: asset.metadata.signalKinds,
      metadata: asset.metadata,
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
}

export async function maintainMatOSExperienceAssetsForSession(input: {
  cwd: string
  sessionPath: string
  hidden?: boolean
  traceEnv?: Record<string, string>
  feedbackAnalyzer?: MatOSUserFeedbackAnalyzer
  refiner?: MatOSExperienceRefiner
}): Promise<string[]> {
  if (
    input.hidden ||
    process.env.MATOS_EXPERIENCE_REFINER === 'off' ||
    process.env.MATOS_EXPERIENCE_REFINER === 'disabled' ||
    (!input.refiner &&
      process.env.NODE_ENV === 'test' &&
      process.env.MATOS_EXPERIENCE_REFINER !== 'llm')
  ) {
    return []
  }
  const events: MatOSEventSource[] = (
    await readMatOSSessionEventsFromPath(input.sessionPath)
  ).map(event => ({
    ...event,
    sourcePath: input.sessionPath,
  }))
  if (isZeroTurnResultOnlySession(events)) {
    return []
  }
  let feedbackAnalysis: MatOSUserFeedbackAnalysis | undefined
  try {
    if (
      input.feedbackAnalyzer ||
      (process.env.MATOS_USER_FEEDBACK_ANALYZER !== 'off' &&
        process.env.MATOS_USER_FEEDBACK_ANALYZER !== 'disabled' &&
        !(process.env.NODE_ENV === 'test' && process.env.MATOS_USER_FEEDBACK_ANALYZER !== 'llm'))
    ) {
      feedbackAnalysis = await (input.feedbackAnalyzer ?? runMatOSUserFeedbackAnalysis)({
        cwd: input.cwd,
        sessionPath: input.sessionPath,
        events,
        traceEnv: input.traceEnv,
      })
    }
  } catch {
    feedbackAnalysis = undefined
  }
  let refined: MatOSExperienceRefinerResult | undefined
  try {
    refined = await (input.refiner ?? refineMatOSExperienceWithLLM)({
      cwd: input.cwd,
      sessionPath: input.sessionPath,
      events,
      ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
      traceEnv: input.traceEnv,
    })
  } catch {
    refined = undefined
  }
  if (
    refined?.shouldWrite === false ||
    hasSecretLikeText(refined) ||
    hasSecretLikeText(feedbackAnalysis)
  ) {
    return []
  }
  const assets = await loadMatOSAssets(input.cwd).catch(() => [])
  const draftFromRefiner = buildExperienceDraftFromRefinerResult(
    refined,
    events,
    feedbackAnalysis,
  )
  const draft = draftFromRefiner
    ? withDynamicTargetHints({ draft: draftFromRefiner, events, assets })
    : buildExperienceDraftFromEvents(events, { assets })
  if (!draft) {
    return []
  }
  return [
    await writeMatOSExperienceDraftAsset({
      cwd: input.cwd,
      draft,
      scopeRef: experienceWriteScopeFromEvents(events)?.scopeRef,
    }),
  ]
}

export async function maintainMatOSExperienceAssetsForWorkflowEvidence(input: {
  cwd: string
  evidence: MatOSWorkflowEvidence
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  refiner?: MatOSExperienceRefiner
}): Promise<string[]> {
  if (
    process.env.MATOS_EXPERIENCE_REFINER === 'off' ||
    process.env.MATOS_EXPERIENCE_REFINER === 'disabled' ||
    (!input.refiner &&
      process.env.NODE_ENV === 'test' &&
      process.env.MATOS_EXPERIENCE_REFINER !== 'llm')
  ) {
    return []
  }
  const traceId = input.evidence.traceId ?? input.evidence.runId
  const sessionId =
    input.evidence.sessionId ?? `workflow:${input.evidence.runId}`
  const events: MatOSEventSource[] = [
    {
      id: input.evidence.evidenceId,
      schemaVersion: 1,
      traceId,
      sessionId,
      timestamp: input.evidence.createdAt,
      execution: 'workflow',
      roleRef: 'role:workflow',
      type:
        input.evidence.status === 'failed'
          ? 'matos.session.failed'
          : 'matos.session.completed',
      data: {
        workflowRef: input.evidence.workflowRef,
        runId: input.evidence.runId,
        status: input.evidence.status,
        nodeSummary: input.evidence.nodeSummary,
        eventTypes: input.evidence.eventTypes,
        artifactRefs: input.evidence.artifactRefs,
        recovery: input.evidence.recovery,
        occurrenceCount: input.evidence.occurrenceCount,
        relatedEvidenceIds: input.evidence.relatedEvidenceIds,
        relatedRunIds: input.evidence.relatedRunIds,
        fullWorkflowEvidence: input.evidence,
        suggestedAssetTypes: input.evidence.suggestedAssetTypes,
        sourceRefs: input.evidence.sourceRefs,
      },
      sourcePath:
        input.evidence.path ?? `workflow-evidence:${input.evidence.evidenceId}`,
    },
  ]
  let refined: MatOSExperienceRefinerResult | undefined
  try {
    refined = await (input.refiner ?? refineMatOSExperienceWithLLM)({
      cwd: input.cwd,
      sessionPath:
        input.evidence.path ?? `workflow-evidence:${input.evidence.evidenceId}`,
      events,
      ...(input.feedbackAnalysis ? { feedbackAnalysis: input.feedbackAnalysis } : {}),
    })
  } catch {
    return []
  }
  const assets = await loadMatOSAssets(input.cwd).catch(() => [])
  const draftFromRefiner = buildExperienceDraftFromRefinerResult(
    refined,
    events,
    input.feedbackAnalysis,
  )
  const draft = draftFromRefiner
    ? withDynamicTargetHints({ draft: draftFromRefiner, events, assets })
    : undefined
  if (!draft) {
    return []
  }
  return [
    await writeMatOSExperienceDraftAsset({
      cwd: input.cwd,
      draft,
      scopeRef: experienceWriteScopeFromEvents(events)?.scopeRef,
    }),
  ]
}
