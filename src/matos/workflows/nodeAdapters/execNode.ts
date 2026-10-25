import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { terminateWorkflowRunLocalProcesses } from '../localProcessLifecycle.js'
import { readWorkflowRunControlAction } from '../workflowControl.js'
import {
  registerWorkflowLocalProcess,
  releaseWorkflowLocalProcess,
} from '../localProcessRegistry.js'
import {
  createNodeStreamSpill,
  retainBoundedStreamTail,
} from './streamCapture.js'
import { watchWorkflowRunCancellation } from '../workflowControl.js'
import type { MatOSWorkflowNode } from '../types.js'

export type ExecNodeResult = {
  output: Record<string, unknown>
  stdout: string
  stderr: string
}

const DEFAULT_EXEC_NODE_TIMEOUT_MS = 300_000
const MIN_EXEC_NODE_TIMEOUT_MS = 1_000
// How often a running exec node re-reads the run's cooperative control marker
// so a cancel request can terminate the spawned process tree promptly instead
// of waiting for the node (up to 24h) to finish on its own.
// Scientific workflow nodes (DFT, MD, NEB, training, and similar jobs) often
// legitimately run for several hours. Keep a finite safety bound, but do not
// silently reduce an explicit multi-hour timeout to one hour.
const MAX_EXEC_NODE_TIMEOUT_MS = 24 * 60 * 60 * 1_000
// How long a SIGTERM to the exec process group may go unanswered before the
// group is SIGKILLed, and how long that SIGKILL may go unanswered before the
// node force-settles anyway (a descendant pinned in uninterruptible I/O on a
// network filesystem can survive even SIGKILL indefinitely).
const EXEC_NODE_KILL_ESCALATION_MS = 5_000
// After the child process itself exits, how long to keep waiting for 'close'
// (the final stdio flush) before force-settling the node. A descendant that
// escaped the process group inherits the stdout/stderr pipes; if it outlives
// the child, 'close' never fires at all.
const EXEC_NODE_EXIT_STREAM_FLUSH_GRACE_MS = 1_500
const PROCESS_FAILURE_STREAM_SCAN_CHARS = 64 * 1024

// Retention caps for captured stdio. Scientific solvers legitimately stream
// hundreds of MB; retaining it all (a) grows the orchestrator heap without
// bound and (b) used to flow verbatim into node-run.json and the run event
// log, where every later event append re-hashed it. The attempt log keeps a
// generous head+tail window for forensics; the node output (the part that
// downstream templates reference and run views embed) keeps a smaller one.
// Commands that need the full log should write it to a file under
// $MATOS_WORKFLOW_ARTIFACT_ROOT themselves.
const EXEC_STREAM_LOG_HEAD_CHARS = 1_000_000
const EXEC_STREAM_LOG_TAIL_CHARS = 1_000_000
const EXEC_STREAM_OUTPUT_HEAD_CHARS = 32_000
const EXEC_STREAM_OUTPUT_TAIL_CHARS = 32_000

/**
 * Bounded head+tail accumulator for a child stdio stream. Keeps the first
 * `headChars` and the last `tailChars`, dropping the middle with an explicit
 * marker, so memory stays bounded no matter how chatty the process is while
 * the parts that matter for diagnosis (banner/config echo at the start, the
 * error and summary at the end) survive.
 */
export class BoundedExecStream {
  private head = ''
  private tail = ''
  private dropped = 0
  totalChars = 0

  constructor(
    private readonly headChars: number = EXEC_STREAM_LOG_HEAD_CHARS,
    private readonly tailChars: number = EXEC_STREAM_LOG_TAIL_CHARS,
  ) {}

  append(text: string): void {
    this.totalChars += text.length
    if (this.head.length < this.headChars) {
      const take = Math.min(this.headChars - this.head.length, text.length)
      this.head += text.slice(0, take)
      text = text.slice(take)
    }
    if (text.length === 0) {
      return
    }
    const combined = this.tail + text
    if (combined.length <= this.tailChars) {
      this.tail = combined
      return
    }
    this.dropped += combined.length - this.tailChars
    this.tail = combined.slice(-this.tailChars)
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  value(): string {
    if (this.dropped === 0) {
      return this.head + this.tail
    }
    return `${this.head}\n…[exec stream truncated: ${this.dropped} chars omitted; full output was ${this.totalChars} chars]…\n${this.tail}`
  }
}

/**
 * Second-tier cap for the stream copy embedded in the node output (which run
 * views, downstream templates, and events reference). Head+tail with marker.
 */
export function execStreamForNodeOutput(value: string): string {
  const max = EXEC_STREAM_OUTPUT_HEAD_CHARS + EXEC_STREAM_OUTPUT_TAIL_CHARS
  if (value.length <= max + 200) {
    return value
  }
  const omitted = value.length - max
  return `${value.slice(0, EXEC_STREAM_OUTPUT_HEAD_CHARS)}\n…[stream truncated for node output: ${omitted} chars omitted; see the attempt stdout/stderr log for the retained window]…\n${value.slice(-EXEC_STREAM_OUTPUT_TAIL_CHARS)}`
}

type KnownProcessFailure = {
  id: string
  category:
    | 'mpi_abort'
    | 'out_of_memory'
    | 'process_crash'
    | 'unhandled_exception'
    | 'suppressed_exit'
  pattern: RegExp
  hint: string
  /** Some signatures are safe to classify only after the process exits. */
  closeOnly?: boolean
  /** A later, explicit recovery marker makes a close-only signature benign. */
  recoveryPattern?: RegExp
  /** A same-input replay is known to be unsafe or useless. */
  retryable?: boolean
  /** The workflow/input/runtime can plausibly be repaired before a new run. */
  repairable: boolean
}

type DetectedProcessFailure = {
  failure: KnownProcessFailure
  source: 'stdout' | 'stderr'
}

// These signatures mean that the child process itself failed even when a
// wrapper ends with `|| true`, loses PIPESTATUS, or otherwise returns zero.
// Keep this list deliberately narrow: domain quality criteria belong in a
// validate node, while unmistakable process failures belong at the exec
// boundary where they can be reported immediately.
const KNOWN_PROCESS_FAILURES: KnownProcessFailure[] = [
  {
    id: 'mpi-abort',
    category: 'mpi_abort',
    pattern: /\bMPI_ABORT was invoked\b|\bMPI_Abort\s*\(/,
    hint:
      'Inspect the first rank-local error before MPI_ABORT, repair the input or runtime, and rerun without suppressing the solver exit status.',
    repairable: true,
  },
  {
    id: 'memory-exhaustion',
    category: 'out_of_memory',
    pattern:
      /\bCUDA out of memory\b|\bOutOfMemoryError\b|\bstd::bad_alloc\b|\bCannot allocate memory\b/i,
    hint:
      'Reduce the memory footprint or select a worker/device with enough memory, then rerun the same scientific step.',
    repairable: true,
  },
  {
    id: 'native-process-crash',
    category: 'process_crash',
    pattern:
      /\bSegmentation fault\b|\bFloating point exception\b|\bBus error\b(?:\s*\(core dumped\))?/i,
    hint:
      'Inspect the native crash context and inputs; do not treat partial output as a completed result.',
    retryable: false,
    repairable: true,
  },
  {
    id: 'unhandled-exception',
    category: 'unhandled_exception',
    pattern:
      /\bUnhandledPromiseRejection\b|\bterminate called after throwing\b/,
    hint:
      'Repair the uncaught exception at its first stack frame and rerun the producing node.',
    repairable: true,
  },
  {
    id: 'suppressed-exit-status',
    category: 'suppressed_exit',
    pattern: /\b[A-Z][A-Z0-9_]{1,63}_EXIT(?:_CODE)?\s*[=:]\s*[1-9]\d*\b/,
    hint:
      'Preserve the child process exit status instead of converting it into successful output, then repair the first failing command before rerunning.',
    closeOnly: true,
    recoveryPattern:
      /\b(?:handled|recovered|recovery succeeded|fallback (?:parser )?succeeded|continuing after|intentionally ignored)\b/i,
    repairable: true,
  },
  {
    id: 'python-traceback',
    category: 'unhandled_exception',
    pattern:
      /Traceback \(most recent call last\):[\s\S]{0,20000}\n(?:[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)|SystemExit|KeyboardInterrupt):[^\n]*(?:\n|$)/,
    hint:
      'Inspect the final exception and its first relevant stack frame, repair the script or inputs, and do not let a wrapper hide the Python exit status.',
    closeOnly: true,
    recoveryPattern:
      /\b(?:handled|recovered|recovery succeeded|fallback (?:parser )?succeeded|continuing after|intentionally ignored)\b/i,
    repairable: true,
  },
]

export class WorkflowProcessFailureError extends Error {
  readonly code = 'workflow_process_failure_detected'
  readonly retryable?: boolean
  readonly repairable: boolean
  readonly sameInputRetrySafe = false
  readonly details: Record<string, unknown>

  constructor(
    nodeId: string,
    failure: KnownProcessFailure,
    source: 'stdout' | 'stderr',
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(`Exec node ${nodeId} detected process failure: ${failure.id}`)
    this.name = 'WorkflowProcessFailureError'
    this.retryable = failure.retryable
    this.repairable = failure.repairable
    this.details = {
      nodeId,
      category: failure.category,
      signatureId: failure.id,
      source,
      hint: failure.hint,
      action: failure.repairable ? 'repair_before_retry' : 'stop_and_inspect',
      repairable: failure.repairable,
      sameInputRetrySafe: false,
      ...(failure.retryable !== undefined
        ? { retryable: failure.retryable }
        : {}),
      ...(exitCode === 0 ? { suppressedFailure: true } : {}),
      detectedWhileRunning: exitCode === undefined,
    }
  }
}

function globalProcessFailureMatcher(pattern: RegExp): RegExp {
  return pattern.flags.includes('g')
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`)
}

// Shared, precompiled global matchers. ProcessFailureStreamScanner resets
// lastIndex before every scan and each scan is fully synchronous, so sharing
// across scanner instances is safe.
const PROCESS_FAILURE_MATCHERS = new Map(
  KNOWN_PROCESS_FAILURES.map(failure => [
    failure.id,
    {
      pattern: globalProcessFailureMatcher(failure.pattern),
      recoveryPattern: failure.recoveryPattern
        ? globalProcessFailureMatcher(failure.recoveryPattern)
        : undefined,
    },
  ]),
)

const NO_STREAM_OFFSET = -1

type ProcessFailureWindowMatch = {
  /** Absolute full-stream offset of the first matched character. */
  startOffset: number
  /** Absolute full-stream offset one past the last matched character. */
  endOffset: number
}

type ProcessFailureSignatureState = {
  /** End offset of the most recent committed failure marker, or -1. */
  failureEndOffset: number
  /** Start offset of the most recent committed recovery marker, or -1. */
  recoveryStartOffset: number
  /** Match ending exactly at the buffered text end, awaiting continuation. */
  tentativeFailure?: ProcessFailureWindowMatch
  tentativeRecovery?: ProcessFailureWindowMatch
}

/**
 * Incremental swallowed-failure scanner over the FULL text of one stdio
 * stream.
 *
 * The retained head+tail buffers (BoundedExecStream) drop the middle of very
 * chatty streams, so a close-time scan over them silently missed any failure
 * marker that fell into the dropped window: a solver that failed mid-run,
 * printed a couple more megabytes, and then had its exit status swallowed by
 * a `|| true` wrapper resolved SUCCESS. This scanner instead observes every
 * chunk through the same bounded rolling window the while-running scan uses
 * and records, per signature, the absolute stream offsets of the most recent
 * failure marker and the most recent recovery marker — so a marker that later
 * leaves every retained buffer still fails the node at close, and the
 * existing recovery semantics (`failureIsActive`) are preserved: a recovery
 * marker clears a failure only when it starts at or after that failure's end.
 *
 * A match that ends exactly at the end of the buffered text is held as
 * tentative rather than committed: the next chunk may extend or invalidate it
 * (trailing word boundaries and `$` anchors see an artificial text end at a
 * chunk boundary). Tentative matches are re-derived on the next append while
 * their text is still fully inside the window, committed at end of stream,
 * and — when a single oversized chunk evicts them before re-evaluation —
 * failure matches are committed (never trade toward false success) while
 * recovery matches are dropped (a spurious recovery could hide a real
 * failure).
 */
class ProcessFailureStreamScanner {
  private window = ''
  private totalChars = 0
  private readonly states = new Map<string, ProcessFailureSignatureState>(
    KNOWN_PROCESS_FAILURES.map(failure => [
      failure.id,
      {
        failureEndOffset: NO_STREAM_OFFSET,
        recoveryStartOffset: NO_STREAM_OFFSET,
      },
    ]),
  )

  append(text: string): void {
    // Pipe reads can exceed the rolling window. Scan overlapping bounded
    // slices before eviction so an error inside one large read is not lost.
    const step = Math.floor(PROCESS_FAILURE_STREAM_SCAN_CHARS / 2)
    for (let offset = 0; offset < text.length; offset += step) {
      this.scanChunk(text.slice(offset, offset + step))
    }
  }

  private scanChunk(text: string): void {
    if (text.length === 0) {
      return
    }
    this.totalChars += text.length
    this.window = processFailureScanTail(this.window, text)
    const windowStartOffset = this.totalChars - this.window.length
    for (const failure of KNOWN_PROCESS_FAILURES) {
      const state = this.states.get(failure.id)
      const matchers = PROCESS_FAILURE_MATCHERS.get(failure.id)
      if (!state || !matchers) {
        continue
      }
      // Settle tentative matches from the previous append first. While their
      // text is still fully inside the window the rescan below re-derives
      // them with the continuation present; once any part has been evicted
      // they can never be re-checked, so bias the verdict against false
      // success (commit failures, drop recoveries).
      if (
        state.tentativeFailure &&
        state.tentativeFailure.startOffset < windowStartOffset
      ) {
        state.failureEndOffset = Math.max(
          state.failureEndOffset,
          state.tentativeFailure.endOffset,
        )
      }
      state.tentativeFailure = undefined
      state.tentativeRecovery = undefined
      const failureScan = this.scanPattern(matchers.pattern, windowStartOffset)
      if (failureScan.committed) {
        state.failureEndOffset = Math.max(
          state.failureEndOffset,
          failureScan.committed.endOffset,
        )
      }
      state.tentativeFailure = failureScan.tentative
      if (matchers.recoveryPattern) {
        const recoveryScan = this.scanPattern(
          matchers.recoveryPattern,
          windowStartOffset,
        )
        if (recoveryScan.committed) {
          state.recoveryStartOffset = Math.max(
            state.recoveryStartOffset,
            recoveryScan.committed.startOffset,
          )
        }
        state.tentativeRecovery = recoveryScan.tentative
      }
    }
  }

  /** End of stream is a real text boundary: settle every tentative match. */
  settleAtStreamEnd(): void {
    for (const state of this.states.values()) {
      if (state.tentativeFailure) {
        state.failureEndOffset = Math.max(
          state.failureEndOffset,
          state.tentativeFailure.endOffset,
        )
        state.tentativeFailure = undefined
      }
      if (state.tentativeRecovery) {
        state.recoveryStartOffset = Math.max(
          state.recoveryStartOffset,
          state.tentativeRecovery.startOffset,
        )
        state.tentativeRecovery = undefined
      }
    }
  }

  /**
   * Recovery is relative to the most recent failure marker. For example,
   * `PRIMARY_EXIT=7; fallback succeeded; SECONDARY_EXIT=9` must remain a
   * failure because the later sentinel supersedes the earlier recovery.
   */
  failureIsActive(failure: KnownProcessFailure): boolean {
    const state = this.states.get(failure.id)
    if (!state || state.failureEndOffset === NO_STREAM_OFFSET) {
      return false
    }
    if (!failure.recoveryPattern) {
      return true
    }
    return state.recoveryStartOffset < state.failureEndOffset
  }

  private scanPattern(
    matcher: RegExp,
    windowStartOffset: number,
  ): {
    committed?: ProcessFailureWindowMatch
    tentative?: ProcessFailureWindowMatch
  } {
    matcher.lastIndex = 0
    let committed: ProcessFailureWindowMatch | undefined
    let tentative: ProcessFailureWindowMatch | undefined
    for (
      let match = matcher.exec(this.window);
      match;
      match = matcher.exec(this.window)
    ) {
      const windowMatch: ProcessFailureWindowMatch = {
        startOffset: windowStartOffset + match.index,
        endOffset: windowStartOffset + match.index + match[0].length,
      }
      if (match.index + match[0].length === this.window.length) {
        // Matches cannot overlap (the global matcher resumes after each
        // match), so only the final one can touch the text end.
        tentative = windowMatch
      } else {
        committed = windowMatch
      }
      if (match[0].length === 0) {
        matcher.lastIndex += 1
      }
    }
    return { committed, tentative }
  }
}

/**
 * While the process is still running, only stderr participates in fail-fast
 * termination. Genuine runtime failures (CUDA OOM, glibc segfault banners,
 * bad_alloc, MPI aborts) are emitted on stderr; benign occurrences of the
 * same phrases — a job analyzing an earlier crash log, a test suite echoing
 * expected errors — overwhelmingly go to stdout and must not get the process
 * killed mid-run. Close-only signatures are also skipped here because they
 * are safe to classify only after the process exits.
 */
function detectedProcessFailureWhileRunning(
  stderrScan: ProcessFailureStreamScanner,
): DetectedProcessFailure | undefined {
  for (const failure of KNOWN_PROCESS_FAILURES) {
    if (failure.closeOnly) {
      continue
    }
    if (stderrScan.failureIsActive(failure)) {
      return { failure, source: 'stderr' }
    }
  }
  return undefined
}

/**
 * At close, both streams are inspected for every signature, using the
 * incremental full-stream match state rather than the bounded head+tail
 * buffers, so a marker in the dropped middle of a chatty stream can never
 * turn into a false success.
 */
function detectedProcessFailureAtClose(
  stdoutScan: ProcessFailureStreamScanner,
  stderrScan: ProcessFailureStreamScanner,
): DetectedProcessFailure | undefined {
  stdoutScan.settleAtStreamEnd()
  stderrScan.settleAtStreamEnd()
  for (const failure of KNOWN_PROCESS_FAILURES) {
    if (stderrScan.failureIsActive(failure)) {
      return { failure, source: 'stderr' }
    }
    if (stdoutScan.failureIsActive(failure)) {
      return { failure, source: 'stdout' }
    }
  }
  return undefined
}

type WorkflowExecFailureOptions = {
  code: string
  category: 'process_start' | 'nonzero_exit' | 'timeout' | 'signal'
  message: string
  hint: string
  action: string
  stdout?: string
  stderr?: string
  exitCode?: number
  timedOut?: boolean
  sameInputRetrySafe?: boolean
  details?: Record<string, unknown>
}

/**
 * A generic exec-boundary failure with stable, agent-actionable metadata.
 * Command text is intentionally excluded because it may contain credentials;
 * full workflow definitions and bounded streams remain in the scoped run.
 */
export class WorkflowExecFailureError extends Error {
  readonly code: string
  readonly repairable = true
  readonly sameInputRetrySafe?: boolean
  readonly details: Record<string, unknown>
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly timedOut?: boolean

  constructor(nodeId: string, options: WorkflowExecFailureOptions) {
    super(options.message)
    this.name = 'WorkflowExecFailureError'
    this.code = options.code
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.exitCode = options.exitCode
    this.timedOut = options.timedOut
    this.sameInputRetrySafe = options.sameInputRetrySafe
    this.details = {
      nodeId,
      category: options.category,
      hint: options.hint,
      action: options.action,
      repairable: true,
      ...(options.sameInputRetrySafe !== undefined
        ? { sameInputRetrySafe: options.sameInputRetrySafe }
        : {}),
      ...(options.details ?? {}),
    }
  }
}

/**
 * A run-level cancel request stopped this exec node. The spawned process tree
 * was signalled (SIGTERM, then SIGKILL); the node must settle as `cancelled`,
 * never retried and never treated as a plain failure, so the scheduler's
 * control-marker handling can cancel the whole run.
 */
export class WorkflowExecCancelledError extends Error {
  readonly code = 'workflow_exec_cancelled'
  readonly retryable = false
  readonly sameInputRetrySafe = false
  readonly details: Record<string, unknown>

  constructor(
    nodeId: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`Exec node was cancelled by a workflow run cancel request: ${nodeId}`)
    this.name = 'WorkflowExecCancelledError'
    this.details = {
      nodeId,
      category: 'cancelled',
      hint: 'The workflow run was cancelled while this command was executing; its process tree was terminated.',
      action: 'none',
      repairable: false,
      sameInputRetrySafe: false,
      retryable: false,
    }
  }
}

export function killExecProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
) {
  if (!pid) {
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') {
      try {
        process.kill(pid, signal)
      } catch (fallbackError) {
        void fallbackError
      }
    }
  }
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function execNodeTimeoutMs(node: MatOSWorkflowNode): number {
  const policy =
    node.policy && typeof node.policy === 'object' ? node.policy : undefined
  const seconds =
    numericValue(node.timeoutSeconds) ?? numericValue(policy?.timeoutSeconds)
  const millis = numericValue(node.timeoutMs) ?? numericValue(policy?.timeoutMs)
  const requested = seconds !== undefined ? seconds * 1000 : millis
  if (requested === undefined) {
    // Deployment-level default override: scientific deployments whose exec
    // nodes routinely run DFT/MD for hours can raise the implicit timeout
    // without editing every workflow (the 5-minute default silently killed
    // long solvers whose authors forgot timeoutSeconds).
    const envDefault = Number(process.env.MATOS_WORKFLOW_EXEC_NODE_TIMEOUT_MS)
    if (Number.isFinite(envDefault) && envDefault > 0) {
      return Math.max(
        MIN_EXEC_NODE_TIMEOUT_MS,
        Math.min(MAX_EXEC_NODE_TIMEOUT_MS, Math.round(envDefault)),
      )
    }
    return DEFAULT_EXEC_NODE_TIMEOUT_MS
  }
  return Math.max(
    MIN_EXEC_NODE_TIMEOUT_MS,
    Math.min(MAX_EXEC_NODE_TIMEOUT_MS, Math.round(requested)),
  )
}

function execNodeArgs(node: MatOSWorkflowNode): string[] | undefined {
  if (node.args === undefined) {
    return undefined
  }
  if (!Array.isArray(node.args) || node.args.some(arg => typeof arg !== 'string')) {
    throw new Error(`Exec node args must be an array of strings: ${node.id}`)
  }
  return node.args
}

function bashExecutable(): string | undefined {
  if (existsSync('/bin/bash')) {
    return '/bin/bash'
  }
  if (existsSync('/usr/bin/bash')) {
    return '/usr/bin/bash'
  }
  return undefined
}

function commandRequestsBash(command: string): boolean {
  const firstLine = command.trimStart().split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.startsWith('#!') && /\bbash\b/.test(firstLine)) {
    return true
  }
  return (
    /\bset\s+-[a-zA-Z]*o\s+pipefail\b/.test(command) ||
    (/\bset\s+-[a-zA-Z]*\b/.test(command) && /\bpipefail\b/.test(command))
  )
}

function execNodeShell(node: MatOSWorkflowNode, command: string): string {
  if (typeof node.shell === 'string' && node.shell.trim().length > 0) {
    return node.shell.trim()
  }
  if (commandRequestsBash(command)) {
    return bashExecutable() ?? '/bin/sh'
  }
  return '/bin/sh'
}

function expandKnownExecPathVariable(
  value: string,
  options: {
    workspaceDir: string
    projectCwd?: string
    runDir?: string
    artifactRoot?: string
  },
): string {
  const replacements: Array<[string, string | undefined]> = [
    ['MATOS_WORKSPACE_DIR', options.workspaceDir],
    ['MATOS_PROJECT_CWD', options.projectCwd ?? options.workspaceDir],
    ['MATOS_WORKFLOW_RUN_DIR', options.runDir],
    ['MATOS_WORKFLOW_ARTIFACT_ROOT', options.artifactRoot],
  ]
  for (const [name, replacement] of replacements) {
    if (!replacement) {
      continue
    }
    const plain = `$${name}`
    const braced = `\${${name}}`
    if (value === plain || value.startsWith(`${plain}/`)) {
      return `${replacement}${value.slice(plain.length)}`
    }
    if (value === braced || value.startsWith(`${braced}/`)) {
      return `${replacement}${value.slice(braced.length)}`
    }
  }
  return value
}

function execNodeCwd(
  node: MatOSWorkflowNode,
  options: {
    workspaceDir: string
    projectCwd?: string
    runDir?: string
    artifactRoot?: string
  },
): string {
  if (typeof node.cwd !== 'string' || node.cwd.trim().length === 0) {
    return options.workspaceDir
  }
  const cwd = expandKnownExecPathVariable(node.cwd.trim(), options)
  return isAbsolute(cwd) ? cwd : join(options.workspaceDir, cwd)
}

function processFailureScanTail(previous: string, chunk: string): string {
  const combined = `${previous}${chunk}`
  return combined.length <= PROCESS_FAILURE_STREAM_SCAN_CHARS
    ? combined
    : combined.slice(-PROCESS_FAILURE_STREAM_SCAN_CHARS)
}

function execNodeEnv(node: MatOSWorkflowNode): Record<string, string> {
  if (!node.env || typeof node.env !== 'object' || Array.isArray(node.env)) {
    return {}
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(node.env)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      env[key] = String(value)
    }
  }
  return env
}

function execNodeProcessEnv(
  node: MatOSWorkflowNode,
  options: {
    workspaceDir: string
    projectCwd?: string
    runDir?: string
    artifactRoot?: string
    parameters?: Record<string, unknown>
    workflowSourcePath?: string
  },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...execNodeEnv(node),
    MATOS_PROJECT_CWD: options.projectCwd ?? options.workspaceDir,
    MATOS_WORKSPACE_DIR: options.workspaceDir,
    MATOS_WORKFLOW_RUN_DIR: options.runDir ?? '',
    MATOS_WORKFLOW_EXEC_PROCESS: '1',
    MATOS_WORKFLOW_EXEC_NODE_ID: node.id,
    MATOS_WORKFLOW_ARTIFACT_ROOT: options.artifactRoot ?? '',
    MATOS_WORKFLOW_PARAMETERS_JSON: JSON.stringify(options.parameters ?? {}),
    ...(options.workflowSourcePath
      ? {
          MATOS_WORKFLOW_SOURCE_PATH: options.workflowSourcePath,
          MATOS_WORKFLOW_SOURCE_DIR: dirname(options.workflowSourcePath),
        }
      : {}),
  }
}

export async function runWorkflowExecNode(
  node: MatOSWorkflowNode,
  options: {
    workspaceDir: string
    projectCwd?: string
    runDir?: string
    artifactRoot?: string
    parameters?: Record<string, unknown>
    workflowSourcePath?: string
  },
): Promise<ExecNodeResult> {
  if (typeof node.command !== 'string' || node.command.trim().length === 0) {
    throw new Error(`Exec node requires command: ${node.id}`)
  }
  const command = node.command
  const args = execNodeArgs(node)
  const timeoutMs = execNodeTimeoutMs(node)
  const detectKnownProcessFailures = node.detectKnownProcessFailures !== false
  const cwd = execNodeCwd(node, options)
  const shell = args ? undefined : execNodeShell(node, command)

  let cwdExists = false
  let cwdIsDirectory = false
  let cwdCauseCode: string | undefined
  try {
    const cwdStat = statSync(cwd)
    cwdExists = true
    cwdIsDirectory = cwdStat.isDirectory()
    if (!cwdIsDirectory) {
      cwdCauseCode = 'ENOTDIR'
    }
  } catch (error) {
    cwdCauseCode = (error as NodeJS.ErrnoException).code
  }
  if (!cwdExists || !cwdIsDirectory) {
    throw new WorkflowExecFailureError(node.id, {
      code: 'workflow_exec_start_failed',
      category: 'process_start',
      message: `Exec node working directory is unavailable: ${node.id}`,
      hint:
        cwdExists
          ? 'The configured working path exists but is not a directory; select or create a directory before retrying.'
          : 'Create the working directory in an upstream node or use a runtime path variable such as $MATOS_WORKSPACE_DIR or $MATOS_WORKFLOW_ARTIFACT_ROOT.',
      action: 'repair_workflow_path',
      details: {
        ...(cwdCauseCode ? { causeCode: cwdCauseCode } : {}),
        cwd,
        cwdExists,
        cwdIsDirectory,
      },
    })
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = args
        ? spawn(command, args, {
            cwd,
            detached: true,
            env: execNodeProcessEnv(node, options),
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(shell ?? '/bin/sh', ['-lc', command], {
            cwd,
            detached: true,
            env: execNodeProcessEnv(node, options),
            stdio: ['ignore', 'pipe', 'pipe'],
          })
    } catch (error) {
      const causeCode = (error as NodeJS.ErrnoException).code
      reject(
        new WorkflowExecFailureError(node.id, {
          code: 'workflow_exec_start_failed',
          category: 'process_start',
          message: `Exec node process could not start: ${node.id}`,
          hint:
            'Verify the executable, shell, working directory permissions, and runtime environment before retrying.',
          action: 'repair_workflow_or_runtime',
          details: {
            ...(causeCode ? { causeCode } : {}),
            cwd,
            cwdExists: true,
            cwdIsDirectory: true,
          },
        }),
      )
      return
    }
    const stdoutBuffer = new BoundedExecStream()
    const stderrBuffer = new BoundedExecStream()
    const stdoutFailureScan = new ProcessFailureStreamScanner()
    const stderrFailureScan = new ProcessFailureStreamScanner()
    let timedOut = false
    let settled = false
    let cancelledByControl = false
    let processFailure: WorkflowProcessFailureError | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined
    const clearLifecycleTimers = () => {
      clearTimeout(timeout)
      cancellation.stop()
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer)
      }
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer)
      }
    }
    // Process-group-first termination with reliable escalation. The SIGKILL
    // timer is deliberately kept referenced (no unref): an unref'd timer can
    // silently never fire when the event loop drains, which would leave a
    // SIGTERM-ignoring process tree alive forever. If even SIGKILL produces no
    // 'exit' (e.g. a tree pinned in uninterruptible I/O), a final bounded
    // timer force-settles the node so the workflow itself can never hang.
    const escalateExecProcessTreeTermination = () => {
      killExecProcessTree(child.pid, 'SIGTERM')
      if (killTimer) {
        return
      }
      killTimer = setTimeout(() => {
        killExecProcessTree(child.pid, 'SIGKILL')
        forceSettleTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          // Let the orchestrator exit later even if the unkillable child
          // handle stays open; the run-scoped /proc cleanup still runs inside
          // finalizeExecNode.
          child.unref()
          void finalizeExecNode(null, 'SIGKILL').catch(error => reject(error))
        }, EXEC_NODE_KILL_ESCALATION_MS)
      }, EXEC_NODE_KILL_ESCALATION_MS)
    }
    const detectStreamFailure = () => {
      if (!detectKnownProcessFailures || processFailure) {
        return
      }
      const detected = detectedProcessFailureWhileRunning(stderrFailureScan)
      if (!detected) {
        return
      }
      processFailure = new WorkflowProcessFailureError(
        node.id,
        detected.failure,
        detected.source,
        stdoutBuffer.value(),
        stderrBuffer.value(),
      )
      escalateExecProcessTreeTermination()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      escalateExecProcessTreeTermination()
    }, timeoutMs)
    timeout.unref?.()
    // Cooperative cancellation must reach a running exec node. The run-scoped
    // /proc sweep a cancel performs deliberately spares nested
    // `matos ... workflow` orchestrator processes (killing one would orphan
    // its child run's scientific subtree), relying on the process-group
    // termination owned by this exec boundary — so the boundary itself has to
    // observe the cancel marker and run the same sanctioned SIGTERM→SIGKILL
    // escalation used on timeout. Without this watcher, cancelling a run
    // whose exec node launched a nested workflow killed nothing and the node
    // promise never settled. The watcher is stopped in clearLifecycleTimers,
    // which every settlement path runs, so a normally completed node is never
    // signalled afterwards.
    const cancellation = watchWorkflowRunCancellation(options.runDir, () => {
      if (settled) return
      cancelledByControl = true
      escalateExecProcessTreeTermination()
    })

    // Cooperative cancellation: the scheduler only reads the run control
    // marker between nodes, so without this watcher an in-flight exec node
    // (including one that spawned a nested orchestrator) keeps its whole
    // process tree running until it finishes or times out. Pause is left to
    // the node boundary on purpose; only cancel terminates mid-command.
    const runDir = options.runDir
    // Register the detached child so run cancellation can terminate its
    // process group even after this worker process dies.
    const registration = runDir
      ? registerWorkflowLocalProcess({
          runDir,
          nodeId: node.id,
          pid: child.pid,
          kind: 'exec',
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
    const stdoutSpill = createNodeStreamSpill(runDir, node.id, 'live-stdout.log')
    const stderrSpill = createNodeStreamSpill(runDir, node.id, 'live-stderr.log')
    const endSpills = (): void => {
      stdoutSpill?.end()
      stderrSpill?.end()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const text = String(chunk)
      stdoutBuffer.append(text)
      stdoutSpill?.write(text)
      if (detectKnownProcessFailures) {
        stdoutFailureScan.append(text)
      }
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderrBuffer.append(text)
      stderrSpill?.write(text)
      if (detectKnownProcessFailures) {
        stderrFailureScan.append(text)
        detectStreamFailure()
      }
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearLifecycleTimers()
      endSpills()
      releaseRegistration()
      const causeCode = (error as NodeJS.ErrnoException).code
      reject(
        processFailure ??
          new WorkflowExecFailureError(node.id, {
            code: 'workflow_exec_start_failed',
            category: 'process_start',
            message: `Exec node process could not start: ${node.id}`,
            hint:
              causeCode === 'ENOENT'
                ? 'The working directory exists, so verify that the configured executable or shell exists and is accessible.'
                : 'Verify the executable, shell, working directory permissions, and runtime environment before retrying.',
            action: 'repair_workflow_or_runtime',
            stdout: stdoutBuffer.value(),
            stderr: stderrBuffer.value(),
            details: {
              ...(causeCode ? { causeCode } : {}),
              cwd,
              cwdExists: true,
            },
          }),
      )
    })
    // Single settlement point for the node. Invariant: every spawned exec
    // node settles exactly once, within a bounded time after its child dies
    // (or after SIGKILL escalation when it cannot die), and every failure
    // settlement below runs the run-scoped /proc cleanup
    // (terminateWorkflowRunLocalProcesses) even when 'close' never fires
    // because an escaped descendant still holds the stdio pipes open.
    const finalizeExecNode = async (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) {
        return
      }
      settled = true
      clearLifecycleTimers()
      endSpills()
      releaseRegistration()
      const stdout = stdoutBuffer.value()
      const stderr = stderrBuffer.value()
      if (
        !cancelledByControl &&
        signal &&
        !timedOut &&
        !processFailure &&
        runDir &&
        (await readWorkflowRunControlAction(runDir)) === 'cancel'
      ) {
        // The child was signalled externally by a cancel requester killing
        // the registered pid (this worker's own watcher may not have polled
        // yet). Classify as cancellation, not a generic signal failure.
        cancelledByControl = true
      }
      if (cancelledByControl) {
        if (runDir) {
          await terminateWorkflowRunLocalProcesses(runDir, {
            nodeId: node.id,
          })
        }
        reject(new WorkflowExecCancelledError(node.id, stdout, stderr))
        return
      }
      if (processFailure) {
        if (options.runDir) {
          await terminateWorkflowRunLocalProcesses(options.runDir, {
            nodeId: node.id,
          })
        }
        reject(processFailure)
        return
      }
      if (timedOut) {
        if (options.runDir) {
          await terminateWorkflowRunLocalProcesses(options.runDir, {
            nodeId: node.id,
          })
        }
        reject(
          new WorkflowExecFailureError(node.id, {
            code: 'workflow_exec_timeout',
            category: 'timeout',
            message: `Exec node timed out after ${timeoutMs}ms: ${node.id}`,
            hint:
              'Inspect progress and resource usage, then repair a hang or set an evidence-based timeout before rerunning.',
            action: 'inspect_timeout_before_retry',
            stdout,
            stderr,
            exitCode: 124,
            timedOut: true,
            details: { timeoutMs, cwd },
          }),
        )
        return
      }
      if (signal) {
        if (options.runDir) {
          await terminateWorkflowRunLocalProcesses(options.runDir, {
            nodeId: node.id,
          })
        }
        reject(
          new WorkflowExecFailureError(node.id, {
            code: 'workflow_exec_signaled',
            category: 'signal',
            message: `Exec node was terminated by signal ${signal}: ${node.id}`,
            hint:
              'Inspect resource limits, cancellation state, and the parent process before retrying a signal-terminated command.',
            action: 'inspect_signal_before_retry',
            sameInputRetrySafe: false,
            stdout,
            stderr,
            details: { signal, cwd },
          }),
        )
        return
      }
      const detected = detectKnownProcessFailures
        ? detectedProcessFailureAtClose(stdoutFailureScan, stderrFailureScan)
        : undefined
      if (detected) {
        if (options.runDir) {
          await terminateWorkflowRunLocalProcesses(options.runDir, {
            nodeId: node.id,
          })
        }
        reject(
          new WorkflowProcessFailureError(
            node.id,
            detected.failure,
            detected.source,
            stdout,
            stderr,
            code ?? undefined,
          ),
        )
        return
      }
      if (code === 0) {
        const outputStdout = execStreamForNodeOutput(stdout)
        const outputStderr = execStreamForNodeOutput(stderr)
        resolve({
          output: {
            exitCode: 0,
            stdout: outputStdout,
            stderr: outputStderr,
            ...(stdoutBuffer.truncated || outputStdout !== stdout
              ? { stdoutTruncated: true, stdoutChars: stdoutBuffer.totalChars }
              : {}),
            ...(stderrBuffer.truncated || outputStderr !== stderr
              ? { stderrTruncated: true, stderrChars: stderrBuffer.totalChars }
              : {}),
          },
          stdout,
          stderr,
        })
        return
      }
      const exitCode = code ?? 1
      if (options.runDir) {
        await terminateWorkflowRunLocalProcesses(options.runDir, {
          nodeId: node.id,
        })
      }
      reject(
        new WorkflowExecFailureError(node.id, {
          code: 'workflow_exec_nonzero_exit',
          category: 'nonzero_exit',
          message: `Exec node failed with exit code ${exitCode}: ${node.id}`,
          hint:
            'Inspect the node attempt stdout/stderr and any command-owned log, repair the first error, and preserve the failing exit status.',
          action: 'inspect_logs_and_repair',
          stdout,
          stderr,
          exitCode,
          details: { cwd },
        }),
      )
    }
    child.on('close', (code, signal) => {
      void finalizeExecNode(code, signal).catch(error => reject(error))
    })
    // Settle on 'exit' with a bounded wait for 'close'. 'close' additionally
    // requires both stdio pipes to end, which never happens when a descendant
    // that left the process group (e.g. an escaped MPI rank) inherited them
    // and keeps running. Waiting a short grace period first preserves the
    // normal path (full stdout/stderr flush via 'close'); afterwards the
    // pipes are forcibly destroyed, keeping whatever output was captured so
    // far, and the node settles so cleanup can reap the escaped descendants.
    child.on('exit', (code, signal) => {
      if (settled || closeGraceTimer) {
        return
      }
      closeGraceTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        void finalizeExecNode(code, signal).catch(error => reject(error))
      }, EXEC_NODE_EXIT_STREAM_FLUSH_GRACE_MS)
    })
  })
}
