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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMatOSChildEnv,
  buildMatOSRoleLaunchInvocation,
} from '../cli/run.js'
import { resolveMatOSProviderEnv } from '../provider/profile.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import {
  buildEvolutionRoleCacheInfo,
  buildEvolutionRoleInvocation,
  cleanupEvolutionRoleInvocationFiles,
  extractEvolutionRoleSdkResult,
  readCachedEvolutionRoleRun,
  resolveEvolutionRoleModelEnv,
  runEvolutionRole,
  type EvolutionRoleInvocationInput,
  type EvolutionRoleRunResult,
  type MatOSEvolutionSdkResult,
  writeCachedEvolutionRoleRun,
} from './evolutionRoleRunner.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'
import { parseRoleJsonResult } from './roleJson.js'
import { accountEvolutionResult, incrementalEvolutionResult, numericUsage } from '../usage/evolutionUsage.js'
import { accountEvolutionRoleSpend } from './evolutionBudgetGate.js'

type SDKMessage = Record<string, unknown>

export const MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION =
  'matos-evolution-shared-prompt-cache-v3'

export type MatOSEvolutionSharedEvidencePrefix = {
  schemaVersion: 1
  cacheVersion: typeof MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION
  jobId: string
  trigger?: unknown
  sessionPath?: string
  events?: unknown[]
  priorRecords?: unknown[]
  workflowEvidence?: unknown
}

export type MatOSEvolutionSharedPromptCacheRunner = {
  roleRunner: MatOSEvolutionSharedPromptCacheRoleRunner
  close: () => Promise<void>
}

export function resolveMatOSEvolutionSharedPromptCacheModel(input: {
  traceEnv?: Record<string, string | undefined>
}): { env: Record<string, string>; args: string[] } {
  const env = resolveEvolutionRoleModelEnv({
    roleReference: 'role:self-evolution-worker',
    traceEnv: input.traceEnv,
  })
  const model = input.traceEnv?.MATOS_DSH_MODEL?.trim() || env.MATOS_DSH_MODEL
  return {
    env,
    args: model ? ['--model', model] : [],
  }
}

function providerScopeRefFromTraceEnv(
  traceEnv: Record<string, string | undefined> | undefined,
): string | undefined {
  return traceEnv?.MATOS_SCOPE_REF?.trim() || traceEnv?.MATOS_SCOPE_ID?.trim()
}

export type MatOSEvolutionSharedPromptCacheRoleRunner = ((
  input: EvolutionRoleInvocationInput,
) => Promise<EvolutionRoleRunResult>) & {
  usesSharedEvidencePrefix: true
  sharedEvidencePrefixKey: string
  sharedEvidenceCwd: string
  sharedStageExtraArgs?: readonly string[]
}

type SharedTurnOutcome = {
  result: EvolutionRoleRunResult
  /**
   * True when the shared child itself failed to produce a result (already
   * closed, overlapping directives, stdin failure, timeout, or child death) —
   * infrastructure jitter rather than a model verdict. Such stages must fall
   * back to a standalone role run instead of failing the whole chain.
   */
  transportFailure: boolean
}

type PendingRun = {
  resolve: (outcome: SharedTurnOutcome) => void
  roleReference: string
  stdoutStart: number
  stderrStart: number
  timeout?: ReturnType<typeof setTimeout>
}

type SharedRunnerState = {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  stdoutBuffer: string
  pending?: PendingRun
  closed: boolean
  previousUsage?: MatOSEvolutionSdkResult
}

const DEFAULT_EVOLUTION_SHARED_TURN_TIMEOUT_MS = 10 * 60 * 1000
const EVOLUTION_SHARED_KILL_GRACE_MS = 5_000
const EVOLUTION_SHARED_CLOSE_GRACE_MS = 1_000

function resolveSharedTurnTimeoutMs(): number {
  const raw = process.env.MATOS_EVOLUTION_SHARED_TURN_TIMEOUT_MS
  if (raw === undefined) {
    return DEFAULT_EVOLUTION_SHARED_TURN_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EVOLUTION_SHARED_TURN_TIMEOUT_MS
}

function terminateSharedChild(child: ChildProcessWithoutNullStreams): void {
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    child.kill('SIGKILL')
  }, EVOLUTION_SHARED_KILL_GRACE_MS)
  killTimer.unref?.()
}

function getAgentEntrypointPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'agent.ts',
  )
}

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

function argValue(args: readonly string[], key: string): string | undefined {
  const index = args.indexOf(key)
  return index >= 0 ? args[index + 1] : undefined
}

function splitToolList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )
}

function knownSandboxArgKeys(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key !== '--permission-mode' && key !== '--disallowed-tools') {
      return false
    }
    index += 1
  }
  return true
}

export function sharedPromptCacheStageArgsCompatible(
  stageArgs: readonly string[] | undefined,
  workerArgs: readonly string[] = EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS,
): boolean {
  const args = stageArgs ?? []
  if (args.length === 0) {
    return true
  }
  if (!knownSandboxArgKeys(args) || !knownSandboxArgKeys(workerArgs)) {
    return false
  }
  const stagePermission = argValue(args, '--permission-mode')
  const workerPermission = argValue(workerArgs, '--permission-mode')
  if (stagePermission && workerPermission && stagePermission !== workerPermission) {
    return false
  }
  const workerDisallowed = splitToolList(argValue(workerArgs, '--disallowed-tools'))
  const stageDisallowed = splitToolList(argValue(args, '--disallowed-tools'))
  for (const tool of stageDisallowed) {
    if (!workerDisallowed.has(tool)) {
      return false
    }
  }
  return true
}

export function sharedPromptCacheRoleRunnerSupportsStageArgs(
  roleRunner: MatOSEvolutionSharedPromptCacheRoleRunner,
  stageArgs: readonly string[] | undefined,
): boolean {
  if (!roleRunner.sharedStageExtraArgs) {
    return !stageArgs || stageArgs.length === 0
  }
  return sharedPromptCacheStageArgsCompatible(
    stageArgs,
    roleRunner.sharedStageExtraArgs,
  )
}

function cleanValue(value: unknown): unknown {
  const redacted = redactTraceValue(value)
  if (Array.isArray(redacted)) {
    return redacted.map(cleanValue)
  }
  if (!redacted || typeof redacted !== 'object') {
    return redacted
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(redacted)) {
    output[key] = cleanValue(item)
  }
  return output
}

function sdkUserLine(content: string): string {
  return `${JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  })}\n`
}

function resolvePendingFromResult(
  state: SharedRunnerState,
  sdkResult: MatOSEvolutionSdkResult,
): void {
  const pending = state.pending
  if (!pending) {
    return
  }
  state.pending = undefined
  if (pending.timeout) {
    clearTimeout(pending.timeout)
  }
  const stdout = state.stdout.slice(pending.stdoutStart)
  const stderr = state.stderr.slice(pending.stderrStart)
  const incremental = incrementalEvolutionResult(sdkResult, state.previousUsage ?? {})
  state.previousUsage = sdkResult
  sdkResult = incremental
  pending.resolve({
    transportFailure: false,
    result: {
      exitCode: sdkResult.isError ? 1 : 0,
      roleReference: pending.roleReference,
      ...(sdkResult.resultText ? { resultText: sdkResult.resultText } : {}),
      ...(sdkResult.resultText
        ? { parsedResult: parseRoleJsonResult(sdkResult.resultText) }
        : {}),
      stdout,
      stderr,
      ...(sdkResult.upstreamSessionId
        ? { upstreamSessionId: sdkResult.upstreamSessionId }
        : {}),
      ...(sdkResult.usage ? { usage: sdkResult.usage } : {}),
      ...(sdkResult.modelUsage ? { modelUsage: sdkResult.modelUsage } : {}),
      ...(sdkResult.totalCostUsd !== undefined
        ? { totalCostUsd: sdkResult.totalCostUsd }
        : {}),
      ...(sdkResult.durationMs !== undefined
        ? { durationMs: sdkResult.durationMs }
        : {}),
      ...(sdkResult.durationApiMs !== undefined
        ? { durationApiMs: sdkResult.durationApiMs }
        : {}),
      ...(sdkResult.numTurns !== undefined
        ? { numTurns: sdkResult.numTurns }
        : {}),
    },
  })
}

function processStdoutLine(state: SharedRunnerState, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }
  try {
    const sdkResult = extractEvolutionRoleSdkResult(
      JSON.parse(trimmed) as SDKMessage,
    )
    if (sdkResult) {
      resolvePendingFromResult(state, sdkResult)
    }
  } catch {
    // Non-JSON stream output remains in stdout diagnostics.
  }
}

function resolvePendingOnClose(
  state: SharedRunnerState,
  exitCode: number,
  reason?: string,
): void {
  const pending = state.pending
  if (!pending) {
    return
  }
  state.pending = undefined
  if (pending.timeout) {
    clearTimeout(pending.timeout)
  }
  pending.resolve({
    transportFailure: true,
    result: {
      exitCode: exitCode || 1,
      roleReference: pending.roleReference,
      stdout: state.stdout.slice(pending.stdoutStart),
      stderr: state.stderr.slice(pending.stderrStart) || reason || '',
    },
  })
}

function sharedEvidencePrefixPrompt(
  evidence: MatOSEvolutionSharedEvidencePrefix,
): string {
  return [
    '<matos-evolution-shared-evidence-prefix>',
    JSON.stringify(sharedEvidenceCacheMaterial(evidence)),
    '</matos-evolution-shared-evidence-prefix>',
    '',
    'This is the stable shared evidence prefix for the current hidden MatOS self-evolution chain.',
    'The following turns will append small stage directives for critic, experience, editor, and judge work.',
    'Keep this prefix available as the authoritative trajectory/evidence context. Do not repeat it unless a later directive asks for a short redacted excerpt.',
    'Reply with JSON only: {"schemaVersion":1,"ready":true}',
  ].join('\n')
}

export function sharedEvidenceCacheMaterial(evidence: MatOSEvolutionSharedEvidencePrefix): unknown {
  // Job identity belongs in trace env, not the cache-critical prompt prefix.
  // Preserve actual evidence timestamps, scope/provenance, versions and content.
  const { jobId: _jobId, ...material } = evidence
  return cleanValue(material)
}

export function restoreSharedEvidenceForStandalone(roleInput: EvolutionRoleInvocationInput, evidence: MatOSEvolutionSharedEvidencePrefix, sharedCwd: string): EvolutionRoleInvocationInput {
  if (roleInput.cwd !== sharedCwd || !sharedPromptCacheStageArgsCompatible(roleInput.extraArgs)) return roleInput
  return { ...roleInput, prompt: `<matos-evolution-shared-evidence-prefix>\n${JSON.stringify(sharedEvidenceCacheMaterial(evidence))}\n</matos-evolution-shared-evidence-prefix>\n${roleInput.prompt}` }
}

async function sendSharedTurn(
  state: SharedRunnerState,
  input: {
    roleReference: string
    prompt: string
  },
): Promise<SharedTurnOutcome> {
  if (state.closed) {
    return {
      transportFailure: true,
      result: {
        exitCode: 1,
        roleReference: input.roleReference,
        stdout: '',
        stderr: 'MatOS evolution shared prompt cache runner is already closed.',
      },
    }
  }
  if (state.pending) {
    return {
      transportFailure: true,
      result: {
        exitCode: 1,
        roleReference: input.roleReference,
        stdout: '',
        stderr: 'MatOS evolution shared prompt cache runner received overlapping stage directives.',
      },
    }
  }
  const timeoutMs = resolveSharedTurnTimeoutMs()
  return new Promise<SharedTurnOutcome>(resolve => {
    const pending: PendingRun = {
      resolve,
      roleReference: input.roleReference,
      stdoutStart: state.stdout.length,
      stderrStart: state.stderr.length,
    }
    pending.timeout = setTimeout(() => {
      if (state.pending !== pending) {
        return
      }
      state.pending = undefined
      state.closed = true
      terminateSharedChild(state.child)
      resolve({
        transportFailure: true,
        result: {
          exitCode: 1,
          roleReference: input.roleReference,
          stdout: state.stdout.slice(pending.stdoutStart),
          stderr: `evolution shared turn timed out after ${timeoutMs}ms`,
        },
      })
    }, timeoutMs)
    state.pending = pending
    state.child.stdin.write(sdkUserLine(input.prompt), error => {
      if (error) {
        // A broken stdin means the shared child can no longer accept stage
        // directives; mark the runner closed so later stages fall back to
        // standalone execution instead of failing the same way.
        state.closed = true
        resolvePendingOnClose(state, 1, error.message)
      }
    })
  })
}

export function usesMatOSEvolutionSharedEvidencePrefix(
  roleRunner: unknown,
): roleRunner is MatOSEvolutionSharedPromptCacheRoleRunner {
  return Boolean(
    typeof roleRunner === 'function' &&
      (roleRunner as { usesSharedEvidencePrefix?: boolean })
        .usesSharedEvidencePrefix === true,
  )
}

export function buildMatOSEvolutionSharedEvidencePrefix(input: {
  jobId: string
  trigger?: unknown
  sessionPath?: string
  events?: unknown[]
  priorRecords?: unknown[]
  workflowEvidence?: unknown
}): MatOSEvolutionSharedEvidencePrefix {
  return {
    schemaVersion: 1,
    cacheVersion: MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION,
    jobId: input.jobId,
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.priorRecords ? { priorRecords: input.priorRecords } : {}),
    ...(input.workflowEvidence !== undefined
      ? { workflowEvidence: input.workflowEvidence }
      : {}),
  }
}

export async function createMatOSEvolutionSharedPromptCacheRunner(input: {
  cwd: string
  jobId?: string
  evidence: MatOSEvolutionSharedEvidencePrefix
  traceEnv?: Record<string, string>
}): Promise<MatOSEvolutionSharedPromptCacheRunner | undefined> {
  if (
    process.env.MATOS_EVOLUTION_SHARED_PROMPT_CACHE === 'off' ||
    process.env.MATOS_EVOLUTION_SHARED_PROMPT_CACHE === 'disabled'
  ) {
    return undefined
  }

  const jobId = input.jobId ?? input.evidence.jobId
  const provider = await resolveMatOSProviderEnv({
    cwd: input.cwd,
    scopeRef: providerScopeRefFromTraceEnv(input.traceEnv),
    env: { ...process.env, ...(input.traceEnv ?? {}) },
  })
  const modelOverride = resolveMatOSEvolutionSharedPromptCacheModel({
    traceEnv: input.traceEnv,
  })
  const invocation = await buildMatOSRoleLaunchInvocation(
    'self-evolution-worker',
    input.cwd,
    [
      ...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS,
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      ...modelOverride.args,
      '--max-turns',
      '12',
      '--no-session-persistence',
    ],
    // Hidden worker: never subject to project membership enforcement, which
    // would reject the shared-prefix runner inside user project directories.
    { projectAccessMode: 'internal-hidden' },
  )
  const env = buildMatOSChildEnv(provider.env as NodeJS.ProcessEnv, {
    ...modelOverride.env,
    ...(input.traceEnv ?? {}),
    MATOS_EVOLUTION_JOB_ID: jobId,
    MATOS_EVOLUTION_SHARED_PROMPT_CACHE_KEY: digest(
      stableJson(sharedEvidenceCacheMaterial(input.evidence)),
    ),
    MATOS_INTERNAL_HIDDEN_RUN: '1',
  })
  if (env.NODE_ENV === 'test') {
    delete env.NODE_ENV
  }

  const child = spawn(
    process.execPath,
    [getAgentEntrypointPath(), ...invocation.agentArgs],
    {
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  const state: SharedRunnerState = {
    child,
    stdout: '',
    stderr: '',
    stdoutBuffer: '',
    closed: false,
  }

  // The shared child needs its materialized cli-arg files for as long as it
  // is alive; remove them only once it exits so they cannot leak evidence
  // material under `.matos/runtime`.
  const cleanupSharedInvocationFiles = () => {
    void cleanupEvolutionRoleInvocationFiles({
      cleanupFiles: invocation.cliArgFiles ?? [],
    })
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    const text = String(chunk)
    state.stdout += text
    state.stdoutBuffer += text
    const lines = state.stdoutBuffer.split('\n')
    state.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      processStdoutLine(state, line)
    }
  })
  child.stderr.on('data', chunk => {
    state.stderr += String(chunk)
  })
  child.on('close', code => {
    state.closed = true
    const trailing = state.stdoutBuffer.trim()
    if (trailing) {
      processStdoutLine(state, trailing)
    }
    resolvePendingOnClose(state, code ?? 1)
    cleanupSharedInvocationFiles()
  })
  child.on('error', error => {
    state.closed = true
    resolvePendingOnClose(state, 1, error.message)
    cleanupSharedInvocationFiles()
  })

  // Local stage cache hits must not trigger an otherwise unused LLM prefix turn.
  let prefixReady: Promise<boolean> | undefined
  const ensurePrefix = () => prefixReady ??= (async () => {
    const outcome = await sendSharedTurn(state, { roleReference: invocation.roleReference,
      prompt: sharedEvidencePrefixPrompt({ ...input.evidence, jobId }) })
    await accountEvolutionResult(input.cwd, 'shared-evidence-prefix', outcome.result, env)
    await accountEvolutionRoleSpend(input.cwd, 'shared-evidence-prefix', outcome.result)
    if (outcome.result.exitCode === 0) return true
    state.closed = true
    terminateSharedChild(state.child)
    return false
  })()
  // Only same-sandbox stages received stripped prompts. Never copy the full
  // evidence into an isolated editor with a different cwd/tool policy.
  const standalone = (roleInput: EvolutionRoleInvocationInput) => runEvolutionRole(restoreSharedEvidenceForStandalone(roleInput, input.evidence, input.cwd))

  const stageSpend = new Map<string, { usage: Record<string, number>; cost: number }>()
  const roleRunner = (async (
    roleInput: EvolutionRoleInvocationInput,
  ): Promise<EvolutionRoleRunResult> => {
    if (
      roleInput.cwd !== input.cwd ||
      !sharedPromptCacheStageArgsCompatible(roleInput.extraArgs) ||
      // A dead or busy shared child is infrastructure jitter, not a stage
      // verdict. Fall back to a standalone role run instead of failing every
      // remaining stage (which cascaded into judge failures and rollbacks of
      // already-applied edits).
      state.closed ||
      state.pending !== undefined
    ) {
      return standalone(roleInput)
    }
    const roleInvocation = await buildEvolutionRoleInvocation(roleInput)
    try {
      const cache = await buildEvolutionRoleCacheInfo({
        invocation: roleInvocation,
        source: roleInput,
      })
      if (cache) {
        const cached = await readCachedEvolutionRoleRun({
          cwd: roleInput.cwd,
          cache,
        })
        if (cached) {
          return cached
        }
      }
      if (!await ensurePrefix()) return standalone(roleInput)
      const outcome = await sendSharedTurn(state, {
        roleReference: `role:${roleInput.role.replace(/^role:/, '')}`,
        prompt: [
          `<matos-evolution-stage-directive stage="${roleInput.role}" jobId="${roleInput.jobId}" createdAt="${nowIso()}">`,
          roleInput.prompt,
          '</matos-evolution-stage-directive>',
        ].join('\n'),
      })
      await accountEvolutionResult(input.cwd, roleInput.role, outcome.result, env)
      const key = `${roleInput.role}:${outcome.result.upstreamSessionId ?? ''}`
      const spent = stageSpend.get(key) ?? { usage: {}, cost: 0 }
      for (const [name, amount] of Object.entries(numericUsage(outcome.result.usage))) spent.usage[name] = (spent.usage[name] ?? 0) + amount
      spent.cost += outcome.result.totalCostUsd ?? 0
      stageSpend.set(key, spent)
      await accountEvolutionRoleSpend(input.cwd, roleInput.role, { ...outcome.result, usage: spent.usage, totalCostUsd: spent.cost })
      if (outcome.transportFailure) {
        // The shared child died, timed out, or refused the turn mid-stage.
        // Retry the stage standalone; runEvolutionRole handles its own cache.
        return standalone(roleInput)
      }
      const result = outcome.result
      if (cache) {
        const resultWithCache = {
          ...result,
          cache,
        }
        // Only persist successful, parseable stage results. Caching failed or
        // unparseable runs would poison the shared role-run cache (same path the
        // standard runner reads) and replay bad output for up to the cache TTL.
        const hasParsedObject =
          result.parsedResult &&
          typeof result.parsedResult === 'object' &&
          !Array.isArray(result.parsedResult)
        if (result.exitCode === 0 && hasParsedObject) {
          await writeCachedEvolutionRoleRun({
            cwd: roleInput.cwd,
            cache,
            result: resultWithCache,
          })
        }
        return resultWithCache
      }
      return result
    } finally {
      // The stage invocation was built only for cache fingerprinting; its
      // materialized cli-arg/prompt files must not leak.
      await cleanupEvolutionRoleInvocationFiles(roleInvocation)
    }
  }) as MatOSEvolutionSharedPromptCacheRoleRunner
  roleRunner.usesSharedEvidencePrefix = true
  roleRunner.sharedEvidencePrefixKey = digest(stableJson(sharedEvidenceCacheMaterial(input.evidence)))
  roleRunner.sharedEvidenceCwd = input.cwd
  roleRunner.sharedStageExtraArgs = [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS]

  return {
    roleRunner,
    close: async () => {
      if (state.closed) {
        return
      }
      state.closed = true
      await new Promise<void>(resolve => {
        let settled = false
        let sigtermTimer: ReturnType<typeof setTimeout> | undefined
        let sigkillTimer: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
          if (settled) {
            return
          }
          settled = true
          if (sigtermTimer) {
            clearTimeout(sigtermTimer)
          }
          if (sigkillTimer) {
            clearTimeout(sigkillTimer)
          }
          resolve()
        }
        child.once('close', finish)
        child.stdin.end()
        sigtermTimer = setTimeout(() => {
          child.kill('SIGTERM')
          sigkillTimer = setTimeout(() => {
            child.kill('SIGKILL')
          }, EVOLUTION_SHARED_KILL_GRACE_MS)
          sigkillTimer.unref?.()
        }, EVOLUTION_SHARED_CLOSE_GRACE_MS)
        sigtermTimer.unref?.()
      })
    },
  }
}
