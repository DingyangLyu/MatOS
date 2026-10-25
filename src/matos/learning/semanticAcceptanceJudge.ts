import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/index.js'
import { getMatOSDir } from '../project.js'
import {
  evolutionRoleCacheExpired,
  isEvolutionRoleAuthenticationFailure,
  isEvolutionRoleContextOverflowFailure,
  isEvolutionRoleQuotaFailure,
  pruneEvolutionCacheDirEntries,
  resolveEvolutionRoleCacheTtlMs,
  resolveEvolutionRoleExecutionEnv,
  roleModelId,
  roleProviderFingerprint,
  runEvolutionRole,
  shouldPruneEvolutionCacheDir,
  writeFileAtomic,
  type EvolutionRoleInvocationInput,
  type EvolutionRoleRunResult,
  type MatOSEvolutionModelUsage,
  type MatOSEvolutionUsage,
} from './evolutionRoleRunner.js'
import {
  sharedPromptCacheRoleRunnerSupportsStageArgs,
  usesMatOSEvolutionSharedEvidencePrefix,
} from './evolutionSharedPromptCache.js'
import { redactTraceValue } from '../sessions/traceContext.js'

export const SEMANTIC_ACCEPTANCE_PROMPT_VERSION =
  'matos-semantic-acceptance-v4'

// Match the JSON-only evolution role denylist: the judge prompt embeds
// attacker-influenceable diff/editor output, so block Skill and the evolution
// MCP context/request tools in addition to write/exec/network tools.
const SEMANTIC_ACCEPTANCE_JUDGE_EXTRA_ARGS = [
  '--permission-mode',
  'dontAsk',
  '--disallowed-tools',
  'Bash,PowerShell,Write,Edit,NotebookEdit,Task,Agent,SendMessage,TeamCreate,TeamDelete,WebFetch,WebSearch,Skill,mcp__matos_asset__evolution_context,mcp__matos_asset__evolution_request',
] as const

export type MatOSSemanticAcceptanceVerdict =
  | 'accept'
  | 'rollback'

export type MatOSSemanticAcceptanceRisk = 'low' | 'medium' | 'high'

export type MatOSSemanticAcceptanceCacheInfo = {
  key: string
  hit: boolean
  path: string
  promptVersion: string
  modelId: string
  inputHash: string
}

export type MatOSSemanticAcceptanceResult = {
  schemaVersion: 1
  verdict: MatOSSemanticAcceptanceVerdict
  confidence: number
  reason: string
  resolvedUserProblem: boolean
  overfitRisk: MatOSSemanticAcceptanceRisk
  assetPollutionRisk: MatOSSemanticAcceptanceRisk
  missingEvidence: string[]
  recommendedFollowup: string[]
  cache: MatOSSemanticAcceptanceCacheInfo
  judgeRoleExitCode: number
  // True only when the judge role process itself failed (non-zero exit), as
  // opposed to the judge actually deciding to roll the edit back. Callers can
  // use this to tell "judge run failed" apart from "judge rejected the edit".
  judgeFailed?: boolean
  createdAt: string
  upstreamSessionId?: string
  usage?: MatOSEvolutionUsage
  modelUsage?: MatOSEvolutionModelUsage
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
}

export type MatOSSemanticAcceptanceJudgeInput = {
  cwd: string
  runId: string
  scope: string
  scopeRef?: string
  beforeSnapshot: string
  afterSnapshot: string
  diffPatchPath?: string
  promptInput: unknown
  editorOutput: unknown
  acceptanceEvidence?: unknown
  validation: MatOSAssetHistoryValidationResult
  modifiedFiles: string[]
  createdAssets: string[]
  updatedAssets: string[]
  disabledAssets: string[]
  evidenceRefs: string[]
  roleRunner?: MatOSSemanticAcceptanceRoleRunner
  env?: Record<string, string | undefined>
}

export type MatOSSemanticAcceptanceRoleRunner = (
  input: EvolutionRoleInvocationInput,
) => Promise<EvolutionRoleRunResult>

export type MatOSSemanticAcceptanceJudge = (
  input: MatOSSemanticAcceptanceJudgeInput,
) => Promise<MatOSSemanticAcceptanceResult>

function nowIso(): string {
  return new Date().toISOString()
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stableValue((value as Record<string, unknown>)[key])
  }
  return output
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function semanticCacheDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'direct-editor', 'semantic-cache')
}

function semanticCachePath(cwd: string, key: string): string {
  return join(semanticCacheDir(cwd), `${key}.json`)
}

const semanticCacheLastPruneAt = new Map<string, number>()

// Shared prune: TTL-expired verdicts plus leaked writeFileAtomic `.tmp`
// residue, which the previous json-only scan never removed.
async function pruneSemanticAcceptanceCache(cwd: string): Promise<void> {
  await pruneEvolutionCacheDirEntries(semanticCacheDir(cwd))
}

function isSemanticVerdict(value: unknown): value is MatOSSemanticAcceptanceVerdict {
  return (
    value === 'accept' ||
    value === 'rollback'
  )
}

async function readDiffPatch(input: {
  cwd: string
  diffPatchPath?: string
}): Promise<string> {
  if (!input.diffPatchPath) {
    return ''
  }
  return readFile(join(input.cwd, input.diffPatchPath), 'utf8').catch(() => '')
}

function eventDigestFromPromptInput(promptInput: unknown): string {
  const currentContext = recordValue(promptInput).currentEvolutionContext
  const context = recordValue(currentContext)
  return digest(stableJson({
    trigger: context.trigger,
    sessionPath: context.sessionPath,
    workflowEvidence: context.workflowEvidence,
    events: context.events,
    monitorRecords: context.monitorRecords,
  }))
}

async function buildCacheInfo(input: {
  run: MatOSSemanticAcceptanceJudgeInput
  sharedEvidencePrefix: boolean
  extraArgs: readonly string[]
  executionEnv: Record<string, string | undefined>
}): Promise<{
  cache: MatOSSemanticAcceptanceCacheInfo
  diffPatch: string
}> {
  const diffPatch = await readDiffPatch({
    cwd: input.run.cwd,
    diffPatchPath: input.run.diffPatchPath,
  })
  // Derive model + provider identity from the env the role runner actually
  // executes with (provider profile rewrite included), never from raw
  // process.env: a profile-driven model/provider change must invalidate old
  // verdicts instead of replaying them for the cache TTL. Reuses the
  // role-runner helpers so the model and provider endpoint/secret are covered.
  const modelId = roleModelId(input.executionEnv)
  const promptInputRecord = recordValue(input.run.promptInput)
  const currentContext = recordValue(promptInputRecord.currentEvolutionContext)
  const trigger = recordValue(currentContext.trigger)
  const cacheInput = {
    afterSnapshot: input.run.afterSnapshot,
    beforeSnapshot: input.run.beforeSnapshot,
    scope: input.run.scope,
    scopeRef: input.run.scopeRef ?? '',
    diffHash: digest(diffPatch),
    // Distinguish "no diff" from "diff path set but unreadable" so distinct edits
    // with a missing/corrupt diff cannot collide on the same constant diffHash.
    diffPath: input.run.diffPatchPath ?? '',
    changedFiles: input.run.modifiedFiles,
    experienceRefs: unique([
      ...input.run.evidenceRefs,
      ...stringArray(currentContext.experienceRefs),
    ]),
    triggerKey: trigger.key,
    sessionPath: currentContext.sessionPath,
    eventDigest: eventDigestFromPromptInput(input.run.promptInput),
    promptInputHash: digest(stableJson(input.run.promptInput)),
    editorOutputHash: digest(stableJson(input.run.editorOutput)),
    acceptanceEvidenceHash: digest(stableJson(input.run.acceptanceEvidence ?? null)),
    validationHash: digest(stableJson(input.run.validation)),
    sharedEvidencePrefix: input.sharedEvidencePrefix,
    judgeExtraArgsHash: digest(stableJson(input.extraArgs)),
    promptVersion: SEMANTIC_ACCEPTANCE_PROMPT_VERSION,
    modelId,
    providerFingerprint: roleProviderFingerprint(input.executionEnv),
  }
  const inputHash = digest(stableJson(cacheInput))
  const key = `semantic-${inputHash.slice(0, 32)}`
  return {
    diffPatch,
    cache: {
      key,
      hit: false,
      path: join(
        '.matos',
        'evolution',
        'direct-editor',
        'semantic-cache',
        `${key}.json`,
      ).replace(/\\/g, '/'),
      promptVersion: SEMANTIC_ACCEPTANCE_PROMPT_VERSION,
      modelId,
      inputHash,
    },
  }
}

function normalizeSemanticAcceptance(
  value: unknown,
  input: {
    cache: MatOSSemanticAcceptanceCacheInfo
    roleExitCode: number
    judgeFailed?: boolean
    upstreamSessionId?: string
    usage?: MatOSEvolutionUsage
    modelUsage?: MatOSEvolutionModelUsage
    totalCostUsd?: number
    durationMs?: number
    durationApiMs?: number
    numTurns?: number
    fallbackReason?: string
  },
): MatOSSemanticAcceptanceResult {
  const raw = recordValue(value)
  const verdict = enumValue(
    raw.verdict,
    ['accept', 'rollback'] as const,
    'rollback',
  )
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim()
      : input.fallbackReason ?? 'Semantic acceptance judge did not provide a reason.'
  return {
    schemaVersion: 1,
    verdict,
    confidence: numberValue(raw.confidence, input.roleExitCode === 0 ? 0.5 : 0),
    reason,
    resolvedUserProblem: raw.resolvedUserProblem === true,
    overfitRisk: enumValue(raw.overfitRisk, ['low', 'medium', 'high'] as const, 'medium'),
    assetPollutionRisk: enumValue(
      raw.assetPollutionRisk,
      ['low', 'medium', 'high'] as const,
      'medium',
    ),
    missingEvidence: unique(stringArray(raw.missingEvidence)),
    recommendedFollowup: unique(stringArray(raw.recommendedFollowup)),
    cache: input.cache,
    judgeRoleExitCode: input.roleExitCode,
    ...((input.judgeFailed ?? input.roleExitCode !== 0)
      ? { judgeFailed: true }
      : {}),
    createdAt: nowIso(),
    ...(input.upstreamSessionId ? { upstreamSessionId: input.upstreamSessionId } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.modelUsage ? { modelUsage: input.modelUsage } : {}),
    ...(input.totalCostUsd !== undefined
      ? { totalCostUsd: input.totalCostUsd }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.durationApiMs !== undefined
      ? { durationApiMs: input.durationApiMs }
      : {}),
    ...(input.numTurns !== undefined ? { numTurns: input.numTurns } : {}),
  }
}

function semanticJudgePrompt(input: {
  run: MatOSSemanticAcceptanceJudgeInput
  diffPatch: string
  cache: MatOSSemanticAcceptanceCacheInfo
  sharedEvidencePrefix?: boolean
}): string {
  const promptInputRecord = recordValue(input.run.promptInput)
  const currentContext = recordValue(promptInputRecord.currentEvolutionContext)
  const scoped =
    input.run.scope === 'user' ||
    input.run.scope === 'team' ||
    input.run.scope === 'project'
  return [
    'You are the hidden MatOS semantic acceptance judge for a direct self-evolution edit.',
    input.sharedEvidencePrefix
      ? 'Do not call tools. Use the earlier matos-evolution-shared-evidence-prefix as the full user/agent trajectory evidence.'
      : 'Do not call tools. Use only the evidence in this prompt.',
    'Your job is not to check JSON syntax. Deterministic validation already ran.',
    'Your job is to decide whether the edit should be kept for users.',
    'This is a prospective acceptance decision, not evidence that later user behavior improved. Never claim observed effectiveness from this package alone.',
    'Judge against the full user/agent trajectory, prior hidden LLM outputs, the direct-editor output, the before/after diff, and validation evidence.',
    'When the trigger is a concrete tool or MCP failure and an editable tool/MCP target is identified, roll back a knowledge-only or role-only edit. A runbook may document recovery, but it does not implement a preflight, schema constraint, structured error, or deterministic guard.',
    'Set resolvedUserProblem=true only when the edit changes the responsible behavior surface and deterministic validation directly exercises that behavior. For instruction-only edits or plausible future improvements, set it to false.',
    ...(scoped
      ? [
          'For user, team, and project scoped assets, accept low-risk edits when they preserve scope boundaries, pass deterministic validation, and plausibly improve the owner\'s next-session behavior from explicit preferences, concrete corrections, successful procedures, repeated failures, or tool/workflow lessons.',
          'Do not reject a scoped edit merely because the evidence would be one-off or too narrow for core/global assets; scoped assets are versioned, owner-specific, and recoverable by Gitea accepted refs and rollback.',
          'Use rollback when the edit misreads the user, crosses scope boundaries, writes secrets, conflicts with existing assets, weakens safety, introduces misleading instructions, lacks any plausible next-session benefit, or should clearly be human-reviewed.',
        ]
      : [
          'Accept only when the edit clearly improves the reusable MatOS asset behavior for the observed problem, is not overfit to a one-off complaint, and does not pollute role, skill, workflow, tool, MCP, or knowledge behavior.',
          'Use rollback when the edit misreads the user, overgeneralizes, conflicts with existing assets, weakens safety, or introduces misleading instructions.',
        ]),
    'During the current test-stage rollout, there are only two allowed verdicts: accept or rollback.',
    scoped
      ? 'For scoped assets, useful but narrow low-risk edits may be accepted; rollback high-risk, ambiguous safety-impacting, cross-scope, or human-review-needed edits.'
      : 'Use rollback for useful but weak, ambiguous, high-risk, or human-review-needed edits.',
    'Return JSON only. No markdown, no commentary, no code fences.',
    'Return exactly this JSON shape:',
    '{"verdict":"accept|rollback","confidence":0.0,"reason":"...","resolvedUserProblem":true,"overfitRisk":"low|medium|high","assetPollutionRisk":"low|medium|high","missingEvidence":[],"recommendedFollowup":[]}',
    'Acceptance package:',
    JSON.stringify(
      {
        runId: input.run.runId,
        scope: input.run.scope,
        ...(input.run.scopeRef ? { scopeRef: input.run.scopeRef } : {}),
        beforeSnapshot: input.run.beforeSnapshot,
        afterSnapshot: input.run.afterSnapshot,
        changedFiles: input.run.modifiedFiles,
        createdAssets: input.run.createdAssets,
        updatedAssets: input.run.updatedAssets,
        disabledAssets: input.run.disabledAssets,
        evidenceRefs: input.run.evidenceRefs,
        validation: input.run.validation,
        ...(input.run.acceptanceEvidence
          ? { acceptanceEvidence: input.run.acceptanceEvidence }
          : {}),
        editorOutput: input.run.editorOutput,
        ...(input.sharedEvidencePrefix
          ? {
              sharedEvidencePrefix: true,
              promptInputHash: digest(stableJson(input.run.promptInput)),
              trigger: currentContext.trigger,
              sessionPath: currentContext.sessionPath,
              experienceRefs: currentContext.experienceRefs,
              workflowEvidence: currentContext.workflowEvidence,
            }
          : { promptInput: input.run.promptInput }),
        diffPatch: input.diffPatch,
        cacheInputHash: input.cache.inputHash,
      },
      null,
      2,
    ),
  ].join('\n')
}

async function readCachedSemanticAcceptance(input: {
  cwd: string
  cache: MatOSSemanticAcceptanceCacheInfo
}): Promise<MatOSSemanticAcceptanceResult | undefined> {
  try {
    const cached = JSON.parse(
      await readFile(semanticCachePath(input.cwd, input.cache.key), 'utf8'),
    ) as MatOSSemanticAcceptanceResult
    if (
      cached.schemaVersion !== 1 ||
      !isSemanticVerdict(cached.verdict) ||
      cached.cache?.key !== input.cache.key ||
      cached.cache?.promptVersion !== input.cache.promptVersion ||
      cached.cache?.modelId !== input.cache.modelId ||
      cached.cache?.inputHash !== input.cache.inputHash ||
      evolutionRoleCacheExpired(
        cached.createdAt,
        resolveEvolutionRoleCacheTtlMs(),
      )
    ) {
      return undefined
    }
    return {
      ...cached,
      cache: {
        ...cached.cache,
        hit: true,
      },
    }
  } catch {
    return undefined
  }
}

async function writeCachedSemanticAcceptance(input: {
  cwd: string
  result: MatOSSemanticAcceptanceResult
}): Promise<void> {
  const dir = semanticCacheDir(input.cwd)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(
    semanticCachePath(input.cwd, input.result.cache.key),
    `${JSON.stringify(input.result, null, 2)}\n`,
  )
  if (shouldPruneEvolutionCacheDir(semanticCacheLastPruneAt, dir)) {
    await pruneSemanticAcceptanceCache(input.cwd)
  }
}

// True when the judge role process failed to produce a verdict at all
// (non-zero exit, timeout, or no parseable JSON object), as opposed to the
// judge semantically deciding to roll the edit back.
function judgeExecutionFailed(result: EvolutionRoleRunResult): boolean {
  return (
    result.exitCode !== 0 ||
    !result.parsedResult ||
    typeof result.parsedResult !== 'object' ||
    Array.isArray(result.parsedResult)
  )
}

// Auth, billing-quota, and context-overflow failures are deterministic for an
// identical retry; only transient infrastructure failures (timeouts, 429/529
// throttling, dead shared runners, network blips) are worth one more attempt.
function judgeFailureIsRetryable(result: EvolutionRoleRunResult): boolean {
  return (
    !isEvolutionRoleAuthenticationFailure(result) &&
    !isEvolutionRoleQuotaFailure(result) &&
    !isEvolutionRoleContextOverflowFailure(result)
  )
}

export async function runMatOSSemanticAcceptanceJudge(
  input: MatOSSemanticAcceptanceJudgeInput,
): Promise<MatOSSemanticAcceptanceResult> {
  const roleRunner = input.roleRunner ?? runEvolutionRole
  const judgeExtraArgs = [...SEMANTIC_ACCEPTANCE_JUDGE_EXTRA_ARGS]
  // Gate 2 must be a strong judge. The shared-prefix worker runs on the fast
  // evolution model, so routing the verdict through it silently weakened
  // semantic acceptance on the default path (and measured cloud prefix-cache
  // reuse was zero, so the shared turn saved nothing). Standalone judging on
  // role:semantic-acceptance-judge (strong default model) is now the default;
  // set MATOS_EVOLUTION_JUDGE_SHARED_PREFIX=1 to opt back into the shared
  // worker turn.
  const judgeEnv = input.env ?? process.env
  const sharedPrefixOptIn = judgeEnv.MATOS_EVOLUTION_JUDGE_SHARED_PREFIX === '1'
  const usesSharedEvidencePrefix =
    sharedPrefixOptIn &&
    usesMatOSEvolutionSharedEvidencePrefix(roleRunner) &&
    sharedPromptCacheRoleRunnerSupportsStageArgs(roleRunner, judgeExtraArgs)
  const executionEnv = await resolveEvolutionRoleExecutionEnv({
    cwd: input.cwd,
    roleReference: usesSharedEvidencePrefix
      ? 'role:self-evolution-worker'
      : 'role:semantic-acceptance-judge',
  })
  const { cache, diffPatch } = await buildCacheInfo({
    run: input,
    sharedEvidencePrefix: usesSharedEvidencePrefix,
    extraArgs: judgeExtraArgs,
    executionEnv,
  })
  const cached = await readCachedSemanticAcceptance({ cwd: input.cwd, cache })
  if (cached) {
    return cached
  }
  const runJudge = (
    runner: MatOSSemanticAcceptanceRoleRunner,
    judgeCache: MatOSSemanticAcceptanceCacheInfo,
    sharedEvidencePrefix: boolean,
  ) =>
    runner({
      cwd: input.cwd,
      role: 'semantic-acceptance-judge',
      jobId: `semantic-acceptance-${input.runId}`,
      prompt: semanticJudgePrompt({
        run: input,
        diffPatch,
        cache: judgeCache,
        sharedEvidencePrefix,
      }),
      hidden: true,
      // Do not cap turns here. Some providers report multiple internal turns for
      // a single JSON-only answer; a low cap turns a valid verdict into a forced
      // rollback. The judge is already bounded by timeout and a no-tool sandbox.
      maxTurns: 0,
      // Sandbox the judge: it only reads the prompt and emits JSON. Without this it
      // inherits the default bypassPermissions/--dangerously-skip-permissions with
      // no tool restriction, which is a prompt-injection escape vector because the
      // prompt embeds attacker-influenceable diff/editorOutput content.
      extraArgs: judgeExtraArgs,
    })

  let effectiveCache = cache
  let result = await runJudge(roleRunner, cache, usesSharedEvidencePrefix)
  if (judgeExecutionFailed(result) && judgeFailureIsRetryable(result)) {
    // Retry once before condemning the edit: a judge execution failure is
    // infrastructure jitter, not a semantic rollback, and it must not destroy
    // an already-applied edit. Shared-prefix runners retry through the
    // standalone runner (their child may be the failing component); plain
    // runners simply get one more attempt.
    const retryRunner = usesMatOSEvolutionSharedEvidencePrefix(roleRunner)
      ? runEvolutionRole
      : roleRunner
    if (usesSharedEvidencePrefix) {
      // The standalone retry cannot rely on the shared evidence prefix, so
      // rebuild the prompt and cache identity for a self-contained run.
      const standaloneEnv = await resolveEvolutionRoleExecutionEnv({
        cwd: input.cwd,
        roleReference: 'role:semantic-acceptance-judge',
      })
      const standalone = await buildCacheInfo({
        run: input,
        sharedEvidencePrefix: false,
        extraArgs: judgeExtraArgs,
        executionEnv: standaloneEnv,
      })
      const cachedStandalone = await readCachedSemanticAcceptance({
        cwd: input.cwd,
        cache: standalone.cache,
      })
      if (cachedStandalone) {
        return cachedStandalone
      }
      effectiveCache = standalone.cache
      result = await runJudge(retryRunner, standalone.cache, false)
    } else {
      result = await runJudge(retryRunner, cache, false)
    }
  }

  const executionFailed = judgeExecutionFailed(result)
  const normalized = normalizeSemanticAcceptance(
    executionFailed ? undefined : result.parsedResult,
    {
      cache: effectiveCache,
      roleExitCode: result.exitCode,
      judgeFailed: executionFailed,
      ...(executionFailed
        ? {
            fallbackReason: `judge-run-failed: ${
              result.stderr ||
              `semantic acceptance judge exited ${result.exitCode} without a parseable verdict for ${basename(input.diffPatchPath ?? input.runId)}`
            }`,
          }
        : {}),
      ...(result.upstreamSessionId
        ? { upstreamSessionId: result.upstreamSessionId }
        : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
      ...(result.totalCostUsd !== undefined
        ? { totalCostUsd: result.totalCostUsd }
        : {}),
      ...(result.durationMs !== undefined
        ? { durationMs: result.durationMs }
        : {}),
      ...(result.durationApiMs !== undefined
        ? { durationApiMs: result.durationApiMs }
        : {}),
      ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
    },
  )

  const safeNormalized = redactTraceValue(
    normalized,
  ) as MatOSSemanticAcceptanceResult
  // Only persist a successful, parseable verdict, redacted before write. Caching
  // judge failures (timeouts/API blips -> forced rollback) would pin a rollback
  // for the cache TTL, and persisting unredacted output could leak secrets the
  // judge echoed in its reason.
  if (!executionFailed) {
    await writeCachedSemanticAcceptance({
      cwd: input.cwd,
      result: safeNormalized,
    })
  }
  return safeNormalized
}
