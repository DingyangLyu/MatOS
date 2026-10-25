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

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMatOSRunInvocation,
  cleanupMatOSRunInvocationMaterialization,
  normalizeRoleReference,
  type MatOSRunInvocation,
} from '../../cli/run.js'
import { configureMatOSEnvironment } from '../../env.js'
import { parseStructuredWorkflowResult } from '../outputContract.js'
import { readWorkflowRunControlAction } from '../workflowControl.js'
import {
  registerWorkflowLocalProcess,
  releaseWorkflowLocalProcess,
} from '../localProcessRegistry.js'
import {
  createNodeStreamSpill,
  retainBoundedStreamTail,
} from './streamCapture.js'
import type { MatOSWorkflowAttemptUsage, MatOSWorkflowNode } from '../types.js'
import { watchWorkflowRunCancellation } from '../workflowControl.js'

type SDKMessage = Record<string, unknown>

export type WorkflowAgentNodeInvocationInput = {
  cwd: string
  role: string
  prompt: string
  passthroughArgs?: string[]
  budget?: unknown
}

export type WorkflowAgentNodeRunResult = {
  output: Record<string, unknown>
  stdout: string
  stderr: string
  usage?: MatOSWorkflowAttemptUsage
}

/**
 * Feedback carried from a prior attempt that failed the node output contract
 * into the automatic repair retry. `errors` reaches the model as an explicit
 * prompt section; `upstreamSessionId` (the engine thread id of the failing
 * attempt) lets the retry resume the same transcript so the model sees its
 * own previous work. Scoped to contract-repair retries only: a full manual
 * node reset clears the persisted error and therefore starts fresh.
 */
export type WorkflowAgentContractRepair = {
  errors: string[]
  previousAttempt: number
  upstreamSessionId?: string
}

const CONTRACT_REPAIR_MAX_ERRORS = 20
const CONTRACT_REPAIR_MAX_ERROR_CHARS = 1_000

export function workflowAgentContractRepairSection(
  repair: WorkflowAgentContractRepair,
): string {
  const errors = repair.errors
    .slice(0, CONTRACT_REPAIR_MAX_ERRORS)
    .map(error =>
      error.length <= CONTRACT_REPAIR_MAX_ERROR_CHARS
        ? error
        : `${error.slice(0, CONTRACT_REPAIR_MAX_ERROR_CHARS)}...`,
    )
  return [
    `Your previous attempt (attempt ${repair.previousAttempt}) failed the output contract with these errors:`,
    ...errors.map(error => `- ${error}`),
    'Fix every listed error and return a final answer that satisfies the node output contract.',
  ].join('\n')
}

function getAgentEntrypointPath(): string {
  const override = process.env.MATOS_TEST_AGENT_ENTRYPOINT_PATH?.trim()
  if (override) return override
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'entrypoints',
    'agent.ts',
  )
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function workflowAgentPrompt(node: MatOSWorkflowNode): string | undefined {
  const prompt = stringValue(node.prompt)
  const systemPrompt = stringValue(node.systemPrompt)
  if (!systemPrompt) {
    return prompt
  }
  if (!prompt) {
    return systemPrompt
  }
  return [
    'Workflow node system instructions:',
    systemPrompt,
    '',
    'Workflow node user task:',
    prompt,
  ].join('\n')
}

type WorkflowAgentArtifactContextEntry = {
  label?: string
  path: string
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Default safety-net timeout for an agent node's headless CLI child. Agent/model
// calls are legitimately long (multi-turn tool use), so the ceiling is generous
// compared to exec nodes, but a hung model connection must not block the run
// forever. Callers may override per node (`timeoutSeconds`/`timeoutMs` or the
// same keys under `policy`) or globally via
// `MATOS_WORKFLOW_AGENT_NODE_TIMEOUT_MS`. An explicit `0` disables the timer.
const DEFAULT_AGENT_NODE_TIMEOUT_MS = 1_800_000
const MIN_AGENT_NODE_TIMEOUT_MS = 1_000
const MAX_AGENT_NODE_TIMEOUT_MS = 86_400_000

function requestedAgentNodeTimeoutMs(node: MatOSWorkflowNode): number {
  const policy =
    node.policy && typeof node.policy === 'object' ? node.policy : undefined
  const seconds =
    numericValue(node.timeoutSeconds) ?? numericValue(policy?.timeoutSeconds)
  if (seconds !== undefined) {
    return seconds * 1000
  }
  const millis = numericValue(node.timeoutMs) ?? numericValue(policy?.timeoutMs)
  if (millis !== undefined) {
    return millis
  }
  const envValue = Number(process.env.MATOS_WORKFLOW_AGENT_NODE_TIMEOUT_MS)
  if (Number.isFinite(envValue)) {
    return envValue
  }
  return DEFAULT_AGENT_NODE_TIMEOUT_MS
}

/**
 * Resolve the agent node timeout. Returns undefined when the timer is disabled
 * (explicit non-positive value), otherwise a bounded millisecond value.
 */
export function agentNodeTimeoutMs(node: MatOSWorkflowNode): number | undefined {
  const requested = requestedAgentNodeTimeoutMs(node)
  if (!Number.isFinite(requested) || requested <= 0) {
    return undefined
  }
  return Math.max(
    MIN_AGENT_NODE_TIMEOUT_MS,
    Math.min(MAX_AGENT_NODE_TIMEOUT_MS, Math.round(requested)),
  )
}

export function killAgentProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) {
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, signal)
      } catch (fallbackError) {
        void fallbackError
      }
    }
  }
}

/**
 * A run-level cancel request stopped this agent node: its headless CLI
 * process tree was signalled by the cancel path (registered-pid kill or
 * marker watcher). The node must settle as `cancelled`, never retried and
 * never treated as a plain failure.
 */
export class WorkflowAgentCancelledError extends Error {
  readonly code = 'workflow_agent_cancelled'
  readonly retryable = false
  readonly sameInputRetrySafe = false
  readonly details: Record<string, unknown>

  constructor(
    nodeId: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`Agent node was cancelled by a workflow run cancel request: ${nodeId}`)
    this.name = 'WorkflowAgentCancelledError'
    this.details = {
      nodeId,
      category: 'cancelled',
      hint: 'The workflow run was cancelled while this agent turn was executing; its process tree was terminated.',
      action: 'none',
      repairable: false,
      sameInputRetrySafe: false,
      retryable: false,
    }
  }
}

function collectArtifactContextEntries(
  value: unknown,
  fallbackLabel = 'artifact',
): WorkflowAgentArtifactContextEntry[] {
  if (typeof value === 'string' && value.trim()) {
    return [{ label: fallbackLabel, path: value.trim() }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectArtifactContextEntries(item, `${fallbackLabel}.${index}`),
    )
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  const record = value as Record<string, unknown>
  if (typeof record.path === 'string' && record.path.trim()) {
    return [{
      label:
        typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : fallbackLabel,
      path: record.path.trim(),
    }]
  }
  return Object.entries(record).flatMap(([key, item]) =>
    collectArtifactContextEntries(item, key),
  )
}

async function readWorkflowAgentArtifactContext(input: {
  cwd: string
  entries: WorkflowAgentArtifactContextEntry[]
  maxBytes: number
}): Promise<string | undefined> {
  const sections: string[] = []
  const seen = new Set<string>()
  for (const entry of input.entries) {
    const path = isAbsolute(entry.path)
      ? entry.path
      : resolve(input.cwd, entry.path)
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    try {
      const info = await stat(path)
      if (!info.isFile()) {
        sections.push(`- ${entry.label ?? path}: skipped; not a regular file (${path})`)
        continue
      }
      const limit = Math.max(1024, input.maxBytes)
      if (info.size > limit) {
        sections.push(
          `- ${entry.label ?? path}: skipped; file is ${info.size} bytes, limit is ${limit} (${path})`,
        )
        continue
      }
      const text = await readFile(path, 'utf8')
      if (text.includes('\0')) {
        sections.push(`- ${entry.label ?? path}: skipped; binary-looking file (${path})`)
        continue
      }
      sections.push(
        [
          `- ${entry.label ?? path} (${path})`,
          '```text',
          text.slice(0, limit),
          '```',
        ].join('\n'),
      )
    } catch (error) {
      sections.push(
        `- ${entry.label ?? path}: unreadable; ${
          error instanceof Error ? error.message : String(error)
        } (${path})`,
      )
    }
  }
  if (sections.length === 0) {
    return undefined
  }
  return [
    'Workflow artifact context:',
    'The following small upstream artifact contents were explicitly attached to this agent node. Use them as evidence; paths remain authoritative for larger follow-up reads.',
    ...sections,
  ].join('\n')
}

export async function workflowAgentPromptWithArtifactContext(
  node: MatOSWorkflowNode,
  options: { cwd: string },
): Promise<string | undefined> {
  const prompt = workflowAgentPrompt(node)
  const contextValue = node.artifactContext ?? node.contextArtifacts
  const entries = collectArtifactContextEntries(contextValue)
  if (!prompt || entries.length === 0) {
    return prompt
  }
  const maxBytes =
    numericValue(node.artifactContextMaxBytes) ??
    numericValue(node.contextArtifactMaxBytes) ??
    12_000
  const context = await readWorkflowAgentArtifactContext({
    cwd: options.cwd,
    entries,
    maxBytes,
  })
  return context ? `${prompt}\n\n${context}` : prompt
}

function stripWorkflowAgentTurnCaps(args: string[]): string[] {
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--max-turns') {
      index += 1
      continue
    }
    if (arg?.startsWith('--max-turns=')) {
      continue
    }
    filtered.push(arg)
  }
  return filtered
}

// Scientific roles do not inherit arbitrary workflow-local passthrough caps.
// An explicit native node budget, however, is an execution contract: enforce
// it in the agent loop, not only in the ledger after an unlimited call exits.
export function workflowAgentBudgetArgs(budget: unknown): string[] {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return []
  const turns = (budget as Record<string, unknown>).maxAgentTurns
  if (turns === undefined) return []
  if (typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns < 1) {
    throw new Error('Agent node maxAgentTurns budget must resolve to a positive integer before execution')
  }
  return ['--max-turns', String(turns)]
}

const WORKFLOW_AGENT_CONTEXT_PROFILES = new Set(['full', 'lean'])

function nodeContextProfile(node: MatOSWorkflowNode): string | undefined {
  const policy =
    node.policy && typeof node.policy === 'object'
      ? (node.policy as Record<string, unknown>)
      : undefined
  const requested =
    stringValue(node.contextProfile) ?? stringValue(policy?.contextProfile)
  return requested && WORKFLOW_AGENT_CONTEXT_PROFILES.has(requested)
    ? requested
    : undefined
}

/**
 * Context-profile args for an agent node's headless CLI child.
 *
 * Workflow agent nodes run one focused task, so they default to the lean
 * runtime profile: builder tools and delegated role definitions are dropped,
 * which measured ~16K fewer input tokens per node on role:compute. Precedence:
 * an explicit --context-profile in the node's passthroughArgs wins (returns
 * no extra args), then node.contextProfile / node.policy.contextProfile, then
 * a valid MATOS_CONTEXT_PROFILE env default (returns no extra args so the run
 * parser applies it), then the lean default.
 */
export function workflowAgentNodeContextProfileArgs(
  node: MatOSWorkflowNode,
  passthroughArgs: string[],
): string[] {
  const explicit = passthroughArgs.some(
    arg => arg === '--context-profile' || arg.startsWith('--context-profile='),
  )
  if (explicit) {
    return []
  }
  const requested = nodeContextProfile(node)
  if (requested) {
    return ['--context-profile', requested]
  }
  const envProfile = process.env.MATOS_CONTEXT_PROFILE?.trim().toLowerCase()
  if (envProfile && WORKFLOW_AGENT_CONTEXT_PROFILES.has(envProfile)) {
    return []
  }
  return ['--context-profile', 'lean']
}

export function workflowAgentInvocationDisablesTools(
  invocation: Pick<MatOSRunInvocation, 'agentArgs'>,
): boolean {
  const args = invocation.agentArgs
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--tools' && args[index + 1] === '') return true
    if (value === '--tools=') return true
  }
  return false
}

function resultFromSdkMessage(message: SDKMessage): string | undefined {
  return message.type === 'result' && message.subtype === 'success'
    ? getString(message.result)
    : undefined
}

function usageNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Normalize the headless SDK result envelope usage block
 * (`usage.input_tokens`, `num_turns`, `total_cost_usd`, ...) into the durable
 * attempt usage shape consumed by workflow budget accounting.
 */
export function usageFromSdkResultMessage(
  message: SDKMessage,
): MatOSWorkflowAttemptUsage | undefined {
  if (message.type !== 'result') {
    return undefined
  }
  const rawUsage =
    message.usage && typeof message.usage === 'object' && !Array.isArray(message.usage)
      ? (message.usage as Record<string, unknown>)
      : {}
  const inputTokens = usageNumber(rawUsage.input_tokens)
  const outputTokens = usageNumber(rawUsage.output_tokens)
  const cacheCreationInputTokens = usageNumber(rawUsage.cache_creation_input_tokens)
  const cacheReadInputTokens = usageNumber(rawUsage.cache_read_input_tokens)
  const agentTurns = usageNumber(message.num_turns)
  const totalCostUsd = usageNumber(message.total_cost_usd)
  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheCreationInputTokens ?? 0) +
    (cacheReadInputTokens ?? 0)
  const usage: MatOSWorkflowAttemptUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(agentTurns !== undefined ? { agentTurns } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

export async function buildWorkflowAgentNodeInvocation(
  input: WorkflowAgentNodeInvocationInput,
): Promise<MatOSRunInvocation> {
  const passthroughArgs = stripWorkflowAgentTurnCaps(input.passthroughArgs ?? [])
  return buildMatOSRunInvocation(
    [
      '--role',
      normalizeRoleReference(input.role),
      input.prompt,
      ...passthroughArgs,
      ...workflowAgentBudgetArgs(input.budget),
    ],
    input.cwd,
  )
}

export async function runWorkflowAgentNode(
  node: MatOSWorkflowNode,
  options: {
    cwd: string
    scopeRef?: string
    runDir?: string
    attempt?: number
    contractRepair?: WorkflowAgentContractRepair
  },
): Promise<WorkflowAgentNodeRunResult> {
  configureMatOSEnvironment()
  const role = typeof node.role === 'string' ? node.role : undefined
  const basePrompt = await workflowAgentPromptWithArtifactContext(node, {
    cwd: options.cwd,
  })
  // A contract-repair retry must not re-send the identical prompt: append the
  // prior attempt's contract errors so the model can actually fix them.
  const prompt =
    basePrompt && options.contractRepair
      ? `${basePrompt}\n\n${workflowAgentContractRepairSection(options.contractRepair)}`
      : basePrompt
  if (!role) {
    throw new Error(`Agent node requires role: ${node.id}`)
  }
  if (!prompt) {
    throw new Error(`Agent node requires prompt: ${node.id}`)
  }

  const nodePassthroughArgs = stringList(node.passthroughArgs)
  const invocation = await buildWorkflowAgentNodeInvocation({
    cwd: options.cwd,
    role,
    prompt,
    budget: node.budget,
    passthroughArgs: [
      ...workflowAgentNodeContextProfileArgs(node, nodePassthroughArgs),
      ...nodePassthroughArgs,
    ],
  })

  const timeoutMs = agentNodeTimeoutMs(node)

  try {
    // A contract-repair retry resumes the failing attempt's DSH session so
    // the model keeps its context instead of starting over.
    const resumeSessionId = options.contractRepair?.upstreamSessionId?.trim()
    const agentArgs = [
      ...invocation.agentArgs,
      ...(resumeSessionId && /^[A-Za-z0-9_.:-]{1,200}$/.test(resumeSessionId) ? ['--resume', resumeSessionId] : []),
    ]
    return await new Promise<WorkflowAgentNodeRunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [getAgentEntrypointPath(), ...agentArgs],
        {
          cwd: options.cwd,
          env: {
            ...process.env,
            ...(invocation.roleReference ? { MATOS_ROLE_REF: invocation.roleReference } : {}),
            ...(invocation.projectAccess ? {
              MATOS_PROJECT_CWD: invocation.projectAccess.projectCwd,
              MATOS_PROJECT_ID: invocation.projectAccess.projectId,
              MATOS_PROJECT_MEMBER_ID: invocation.projectAccess.memberId,
            } : {}),
          },
          // Own process group so a timeout can terminate the whole headless
          // agent subtree (model CLI + any tools it spawned), not just the
          // direct child.
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      let stdoutBuffer = ''
      let finalResult: string | undefined
      let finalUsage: MatOSWorkflowAttemptUsage | undefined
      let upstreamSessionId: string | undefined
      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      // Register the detached agent child so run cancellation can terminate
      // its process group even after this worker process dies.
      const runDir = options.runDir
      const registration = runDir
        ? registerWorkflowLocalProcess({
            runDir,
            nodeId: node.id,
            pid: child.pid,
            kind: 'agent',
          }).catch(() => {})
        : undefined
      const releaseRegistration = (): void => {
        if (!runDir || !registration) {
          return
        }
        void registration
          .then(() =>
            releaseWorkflowLocalProcess({
              runDir,
              nodeId: node.id,
              pid: child.pid,
            }),
          )
          .catch(() => {})
      }
      const stdoutSpill = createNodeStreamSpill(
        runDir,
        node.id,
        'live-stdout.log',
      )
      const stderrSpill = createNodeStreamSpill(
        runDir,
        node.id,
        'live-stderr.log',
      )
      const endSpills = (): void => {
        stdoutSpill?.end()
        stderrSpill?.end()
      }
      // In-process cancel watcher: kills this child as soon as the run's
      // control file flips to cancel, without waiting for the external
      // registry-based kill path. The SIGKILL escalation timer stays
      // referenced for the same reason as the timeout path below.
      const cancellation = watchWorkflowRunCancellation(options.runDir, () => {
        killAgentProcessTree(child.pid, 'SIGTERM')
        killTimer = setTimeout(() => {
          killAgentProcessTree(child.pid, 'SIGKILL')
        }, 5000)
      })
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              killAgentProcessTree(child.pid, 'SIGTERM')
              // Referenced (not unref'd): an unref'd escalation timer can
              // silently never fire when the event loop drains, leaving a
              // SIGTERM-ignoring agent subtree alive forever. clearTimers()
              // in the settle paths clears it on normal exit.
              killTimer = setTimeout(() => {
                killAgentProcessTree(child.pid, 'SIGKILL')
              }, 5000)
            }, timeoutMs)
      timeout?.unref?.()
      const clearTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout)
        }
        if (killTimer) {
          clearTimeout(killTimer)
        }
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        const text = String(chunk)
        // Bounded in-memory retention; the full SDK stream goes to the spill
        // file. Line-oriented result parsing below uses stdoutBuffer, which
        // only ever holds the current partial line.
        stdout = retainBoundedStreamTail(stdout, text)
        stdoutSpill?.write(text)
        stdoutBuffer += text
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {
            continue
          }
          try {
            const message = JSON.parse(trimmed) as SDKMessage
            const result = resultFromSdkMessage(message)
            if (result !== undefined) {
              finalResult = result
            }
            const usage = usageFromSdkResultMessage(message)
            if (usage) {
              finalUsage = usage
            }
            if (message.type === 'result' && typeof message.session_id === 'string') {
              upstreamSessionId = message.session_id
            }
          } catch {
            // Keep raw stdout for diagnostics; not every line is guaranteed JSON.
          }
        }
      })
      child.stderr.on('data', chunk => {
        const text = String(chunk)
        stderr = retainBoundedStreamTail(stderr, text)
        stderrSpill?.write(text)
      })
      child.on('error', error => {
        clearTimers()
        cancellation.stop()
        endSpills()
        releaseRegistration()
        reject(error)
      })
      const settleClose = async (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): Promise<void> => {
        clearTimers()
        cancellation.stop()
        endSpills()
        releaseRegistration()
        if (
          !timedOut &&
          (cancellation.cancelled() ||
            (signal !== null &&
              runDir !== undefined &&
              (await readWorkflowRunControlAction(runDir)) === 'cancel'))
        ) {
          // The agent child was stopped by a run cancel request: either the
          // in-process watcher saw the control file flip and killed it, or a
          // cancel requester signalled the registered pid externally.
          // Classify as cancellation so the node settles as cancelled
          // instead of a generic failure.
          reject(new WorkflowAgentCancelledError(node.id, stdout, stderr))
          return
        }
        if (timedOut) {
          const stderrTail = stderr.trim().slice(-4000)
          const error = new Error(
            `Agent node timed out after ${timeoutMs}ms: ${node.id}${
              stderrTail ? `\nstderr:\n${stderrTail}` : ''
            }`,
          )
          Object.assign(error, {
            stdout,
            stderr,
            exitCode: 124,
            timedOut: true,
          })
          reject(error)
          return
        }
        if (code !== 0) {
          const stdoutTail = stdout.trim().slice(-4000)
          const stderrTail = stderr.trim().slice(-4000)
          const diagnostics = [
            stderrTail ? `stderr:\n${stderrTail}` : '',
            stdoutTail ? `stdout:\n${stdoutTail}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          reject(
            new Error(
              `Agent node failed with exit code ${code ?? 1}: ${node.id}${
                diagnostics ? `\n${diagnostics}` : ''
              }`,
            ),
          )
          return
        }
        const structured = parseStructuredWorkflowResult(finalResult)
        resolve({
          stdout,
          stderr,
          output: {
            result: finalResult ?? '',
            ...(structured !== undefined ? { structured } : {}),
            role: invocation.roleReference,
            agentEngine: 'deepseek-harness',
            ...(upstreamSessionId ? { upstreamSessionId } : {}),
            ...(finalUsage ? { usage: finalUsage } : {}),
          },
          ...(finalUsage ? { usage: finalUsage } : {}),
        })
      }
      child.on('close', (code, signal) => {
        void settleClose(code, signal).catch(error => reject(error))
      })
    })
  } finally {
    await cleanupMatOSRunInvocationMaterialization(options.cwd, invocation)
  }
}
