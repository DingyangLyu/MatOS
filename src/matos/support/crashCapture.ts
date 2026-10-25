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

// MatOS crash capture: long-lived MatOS processes (daemon, workflow runner,
// evolution worker) could die without leaving any durable record of why. This module appends a small redacted crash record
// to $MATOS_OPS_DIR/crashes/crashes.jsonl for:
//   - uncaught exceptions (via `uncaughtExceptionMonitor`, which observes the
//     default fatal handling without changing it),
//   - unhandled promise rejections (recorded, then rethrown so Bun/Node
//     default fatality is preserved exactly; the rethrow is skipped when the
//     application installed its own `unhandledRejection` listener),
//   - explicit fatal-exit call sites (`recordMatOSFatalExit`),
//   - sampled swallowed promise rejections from the `bestEffort` helper
//     (`recordMatOSSwallowed`, kind "swallowed").
//
// Contract: strictly best-effort. Every write path is wrapped so the crash
// channel itself can never throw, recurse, or change process semantics. The
// file is size-capped (rotate at 16MB, keep one `.1` archive) and every
// captured text field is scrubbed against secret-looking environment values
// before it is written.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_MATOS_DEPLOY_ROOT } from '../runtime/deploymentRoots.js'

export type MatOSCrashRecordKind = 'crash' | 'fatal-exit' | 'swallowed'

export type MatOSCrashRecord = {
  ts: string
  kind: MatOSCrashRecordKind
  /** uncaughtException | unhandledRejection | fatal-exit | best-effort */
  origin: string
  component: string
  /** bestEffort swallow label (kind "swallowed" only). */
  label?: string
  pid: number
  /** argv[0..2] only; never the full command line. */
  argv: string[]
  message: string
  stack?: string
  memoryRssBytes?: number
  heapUsedBytes?: number
  uptimeSeconds: number
  recentLogTail?: string[]
}

type EnvLike = Record<string, string | undefined>

const MAX_MESSAGE_CHARS = 2000
const MAX_STACK_CHARS = 8000
const MAX_LOG_TAIL_BYTES = 4096
const MAX_LOG_TAIL_LINES = 12
export const MATOS_CRASH_LOG_ROTATE_BYTES = 16 * 1024 * 1024
const SWALLOWED_SAMPLE_WINDOW_MS = 60_000

const SECRET_ENV_KEY_PATTERN =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|WEBHOOK|COOKIE)/i
const MIN_SECRET_VALUE_LENGTH = 6

let installedComponent: string | undefined
let installedRecentLogPath: string | undefined
let handlersInstalled = false
let writingRecord = false
let lastRethrownReason: unknown = null
const swallowedSampleByLabel = new Map<string, number>()

function isWorkspaceShell(cwd: string, env: EnvLike): boolean {
  return (
    env.MATOS_MODE === '1' ||
    Boolean(env.MATOS_WORKSPACE_DIR) ||
    cwd.startsWith('/workspace/')
  )
}

/**
 * Crash channel directory. Resolution mirrors the other MatOS ops paths:
 * explicit $MATOS_OPS_DIR (script-side name) first, then $MATOS_OPS_ROOT
 * (deployment-roots name), then a container-visible per-user fallback when
 * running inside a workspace container, then the host deploy-root default.
 */
export function resolveMatOSCrashLogDir(
  env: EnvLike = process.env,
  cwd: string = safeCwd(),
): string {
  const opsDir = env.MATOS_OPS_DIR?.trim()
  if (opsDir) {
    return join(opsDir, 'crashes')
  }
  const opsRoot = env.MATOS_OPS_ROOT?.trim()
  if (opsRoot) {
    return join(opsRoot, 'crashes')
  }
  if (isWorkspaceShell(cwd, env)) {
    const home =
      env.HOME && env.HOME.startsWith('/') ? env.HOME : '/home/workspace'
    return join(home, '.matos', 'crashes')
  }
  const deployRoot = env.MATOS_DEPLOY_ROOT?.trim() || DEFAULT_MATOS_DEPLOY_ROOT
  return join(deployRoot, 'ops', 'crashes')
}

export function resolveMatOSCrashLogPath(
  env: EnvLike = process.env,
  cwd: string = safeCwd(),
): string {
  return join(resolveMatOSCrashLogDir(env, cwd), 'crashes.jsonl')
}

function safeCwd(): string {
  try {
    return process.cwd()
  } catch {
    return '/'
  }
}

// Tests (bun test sets NODE_ENV=test) must never append to the live deploy
// ops root through the hardcoded default. An explicit MATOS_OPS_DIR /
// MATOS_OPS_ROOT target re-enables the channel for crash-capture tests.
function crashChannelSuppressed(env: EnvLike): boolean {
  if (env.MATOS_CRASH_CAPTURE === '0') {
    return true
  }
  if (env.MATOS_OPS_DIR?.trim() || env.MATOS_OPS_ROOT?.trim()) {
    return false
  }
  return env.NODE_ENV === 'test'
}

function collectSecretEnvValues(env: EnvLike): Array<[string, string]> {
  const values: Array<[string, string]> = []
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === 'string' &&
      value.length >= MIN_SECRET_VALUE_LENGTH &&
      SECRET_ENV_KEY_PATTERN.test(key)
    ) {
      values.push([key, value])
    }
  }
  // Longest values first so overlapping secrets never leave partial residue.
  return values.sort((a, b) => b[1].length - a[1].length)
}

/**
 * Scrub a text fragment against secret-looking environment values (keys
 * matching TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH/WEBHOOK/COOKIE). Used
 * for crash messages/stacks/log tails and for support-bundle log tails.
 */
export function redactMatOSSensitiveText(
  text: string,
  env: EnvLike = process.env,
): string {
  let redacted = text
  for (const [key, value] of collectSecretEnvValues(env)) {
    redacted = redacted.split(value).join(`[redacted:${key}]`)
  }
  return redacted
}

function defaultComponent(): string {
  const entry = basename(String(process.argv[1] ?? '')).replace(
    /\.(ts|tsx|js|mjs|cjs)$/,
    '',
  )
  return entry || 'matos'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error && error.stack ? error.stack : undefined
}

function readRecentLogTail(path: string, env: EnvLike): string[] | undefined {
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size === 0) {
      return undefined
    }
    const readBytes = Math.min(MAX_LOG_TAIL_BYTES, stats.size)
    const buffer = Buffer.alloc(readBytes)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, readBytes, stats.size - readBytes)
    } finally {
      closeSync(fd)
    }
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-MAX_LOG_TAIL_LINES)
    return lines.length > 0
      ? lines.map(line => redactMatOSSensitiveText(line, env))
      : undefined
  } catch {
    return undefined
  }
}

function rotateIfOversized(path: string): void {
  try {
    if (statSync(path).size >= MATOS_CRASH_LOG_ROTATE_BYTES) {
      // rename replaces any existing archive: rotate at 16MB, keep exactly one.
      renameSync(path, `${path}.1`)
    }
  } catch {
    // Missing file or unreadable stat: nothing to rotate.
  }
}

function appendCrashRecord(record: MatOSCrashRecord, env: EnvLike): boolean {
  if (writingRecord) {
    // Never recurse: a crash raised while writing a crash record is dropped.
    return false
  }
  writingRecord = true
  try {
    const dir = resolveMatOSCrashLogDir(env)
    const path = join(dir, 'crashes.jsonl')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    rotateIfOversized(path)
    appendFileSync(path, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  } finally {
    writingRecord = false
  }
}

function buildRecord(input: {
  kind: MatOSCrashRecordKind
  origin: string
  component?: string
  label?: string
  error: unknown
  env: EnvLike
  includeLogTail?: boolean
}): MatOSCrashRecord {
  const env = input.env
  let memoryRssBytes: number | undefined
  let heapUsedBytes: number | undefined
  try {
    const usage = process.memoryUsage()
    memoryRssBytes = usage.rss
    heapUsedBytes = usage.heapUsed
  } catch {
    // memory usage is diagnostic sugar only
  }
  const stack = errorStack(input.error)
  const recentLogTail =
    input.includeLogTail !== false && installedRecentLogPath
      ? readRecentLogTail(installedRecentLogPath, env)
      : undefined
  return {
    ts: new Date().toISOString(),
    kind: input.kind,
    origin: input.origin,
    component: input.component ?? installedComponent ?? defaultComponent(),
    ...(input.label ? { label: input.label } : {}),
    pid: process.pid,
    argv: process.argv
      .slice(0, 3)
      .map(arg => redactMatOSSensitiveText(String(arg), env)),
    message: redactMatOSSensitiveText(
      errorMessage(input.error),
      env,
    ).slice(0, MAX_MESSAGE_CHARS),
    ...(stack
      ? { stack: redactMatOSSensitiveText(stack, env).slice(0, MAX_STACK_CHARS) }
      : {}),
    ...(memoryRssBytes !== undefined ? { memoryRssBytes } : {}),
    ...(heapUsedBytes !== undefined ? { heapUsedBytes } : {}),
    uptimeSeconds: Math.round(process.uptime()),
    ...(recentLogTail ? { recentLogTail } : {}),
  }
}

function safeRecord(input: {
  kind: MatOSCrashRecordKind
  origin: string
  component?: string
  label?: string
  error: unknown
  env?: EnvLike
  includeLogTail?: boolean
}): boolean {
  try {
    const env = input.env ?? process.env
    if (crashChannelSuppressed(env)) {
      return false
    }
    return appendCrashRecord(buildRecord({ ...input, env }), env)
  } catch {
    return false
  }
}

export type MatOSCrashCaptureOptions = {
  component: string
  /**
   * Optional log whose tail (last ~12 lines, redacted) is embedded in crash
   * records when it is cheaply readable at crash time.
   */
  recentLogPath?: string
  env?: EnvLike
}

/**
 * Install process-level crash capture. Idempotent: the first component wins,
 * later calls are no-ops. Never changes process semantics:
 * `uncaughtExceptionMonitor` observes the default fatal path, and the
 * `unhandledRejection` listener rethrows (restoring default fatality) unless
 * the application installed its own rejection listener.
 */
export function installMatOSCrashCapture(
  options: MatOSCrashCaptureOptions,
): void {
  try {
    if (!installedComponent) {
      installedComponent = options.component
      installedRecentLogPath = options.recentLogPath
    }
    if (handlersInstalled) {
      return
    }
    const env = options.env ?? process.env
    if (env.MATOS_CRASH_CAPTURE === '0') {
      return
    }
    handlersInstalled = true
    process.on('uncaughtExceptionMonitor', (error: unknown) => {
      if (error === lastRethrownReason && error !== null) {
        // Already recorded when the unhandledRejection listener rethrew it.
        return
      }
      safeRecord({ kind: 'crash', origin: 'uncaughtException', error })
    })
    process.on('unhandledRejection', (reason: unknown) => {
      safeRecord({ kind: 'crash', origin: 'unhandledRejection', error: reason })
      if (process.listenerCount('unhandledRejection') > 1) {
        // Another listener owns the outcome; observing only.
        return
      }
      lastRethrownReason = reason
      // Restore the default outcome: an unhandled rejection is fatal.
      throw reason
    })
  } catch {
    // Crash capture must never break the process it protects.
  }
}

/**
 * Record an explicit fatal exit (entrypoint catch blocks that are about to
 * terminate the process). Best-effort; returns whether a record was written.
 */
export function recordMatOSFatalExit(input: {
  component?: string
  error: unknown
  origin?: string
}): boolean {
  return safeRecord({
    kind: 'fatal-exit',
    origin: input.origin ?? 'fatal-exit',
    component: input.component,
    error: input.error,
  })
}

/**
 * Record a swallowed rejection from the bestEffort helper. Sampled: at most
 * one record per label per minute so a hot failure loop cannot flood the
 * crash channel. Never throws.
 */
export function recordMatOSSwallowed(label: string, error: unknown): boolean {
  try {
    const now = Date.now()
    const last = swallowedSampleByLabel.get(label)
    if (last !== undefined && now - last < SWALLOWED_SAMPLE_WINDOW_MS) {
      return false
    }
    swallowedSampleByLabel.set(label, now)
    return safeRecord({
      kind: 'swallowed',
      origin: 'best-effort',
      label,
      error,
      includeLogTail: false,
    })
  } catch {
    return false
  }
}
