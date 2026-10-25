import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type WorkflowLocalProcessTermination = {
  supported: boolean
  matchedPids: number[]
  terminatedPids: number[]
  killedPids: number[]
}

const DEFAULT_TERM_GRACE_MS = 1_500
const DEFAULT_POLL_MS = 50

function localProcessCancelPath(runDir: string): string {
  return join(runDir, 'local-process-cancel.json')
}

export async function requestWorkflowRunLocalProcessCancel(
  runDir: string,
): Promise<void> {
  await writeFile(
    localProcessCancelPath(runDir),
    `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
}

export async function workflowRunLocalProcessCancelRequested(
  runDir: string,
): Promise<boolean> {
  return readFile(localProcessCancelPath(runDir), 'utf8')
    .then(() => true)
    .catch(() => false)
}

export async function clearWorkflowRunLocalProcessCancel(
  runDir: string,
): Promise<void> {
  await rm(localProcessCancelPath(runDir), { force: true }).catch(() => {})
}

function workflowRunDirCandidates(runDir: string): Set<string> {
  const candidates = new Set<string>()
  if (runDir.length > 0) {
    candidates.add(runDir)
    candidates.add(resolve(runDir))
  }
  return candidates
}

// Interpreter/runtime argv images that merely host the MatOS CLI (shebang
// interpreters and JS runtimes); the token after them names the real program.
const MATOS_CLI_RUNTIME_WRAPPERS = new Set([
  'bash',
  'bun',
  'bunx',
  'dash',
  'deno',
  'env',
  'node',
  'nodejs',
  'sh',
  'zsh',
])
// The MatOS CLI image itself: the `bin/matos` shim or the
// `src/entrypoints/matos.ts` entrypoint (also matches bundled .js/.mjs/.cjs
// builds of the same entrypoint).
const MATOS_CLI_IMAGE_PATTERN = /^matos(\.(m?js|m?ts|cjs))?$/

function argvBasename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * True when an argv vector is a MatOS workflow CLI invocation, e.g.
 * `bash /app/bin/matos workflow run ...` or
 * `bun /app/src/entrypoints/matos.ts workflow resume ...`.
 *
 * Only the first non-wrapper, non-flag token may be the CLI image, so a
 * scientific command that merely mentions "matos workflow" somewhere in its
 * arguments is not misclassified (that would exempt a real leaf from
 * cleanup). Exported for direct regression testing.
 */
export function isMatOSWorkflowCliArgv(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.length === 0 || token.startsWith('-')) {
      continue
    }
    if (MATOS_CLI_RUNTIME_WRAPPERS.has(argvBasename(token))) {
      continue
    }
    if (!MATOS_CLI_IMAGE_PATTERN.test(argvBasename(token))) {
      return false
    }
    for (let rest = index + 1; rest < argv.length; rest += 1) {
      if (argv[rest].startsWith('-')) {
        continue
      }
      return argv[rest] === 'workflow'
    }
    return false
  }
  return false
}

async function processIsWorkflowOrchestrator(pid: number): Promise<boolean> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`)
    const argv = cmdline
      .toString('utf8')
      .split('\0')
      .filter(token => token.length > 0)
    return isMatOSWorkflowCliArgv(argv)
  } catch {
    return false
  }
}

async function processHasWorkflowRunDir(
  pid: number,
  candidates: Set<string>,
  nodeId?: string,
): Promise<boolean> {
  if (pid === process.pid || candidates.size === 0) {
    return false
  }
  try {
    const environment = await readFile(`/proc/${pid}/environ`)
    const entries = environment.toString('utf8').split('\0')
    const ownedExecProcess = entries.includes('MATOS_WORKFLOW_EXEC_PROCESS=1')
    const ownedNodeProcess = nodeId
      ? entries.includes(`MATOS_WORKFLOW_EXEC_NODE_ID=${nodeId}`)
      : true
    const ownedRunDir =
      ownedExecProcess &&
      ownedNodeProcess &&
      entries.some(entry => {
        if (!entry.startsWith('MATOS_WORKFLOW_RUN_DIR=')) {
          return false
        }
        return candidates.has(entry.slice('MATOS_WORKFLOW_RUN_DIR='.length))
      })
    if (!ownedRunDir) {
      return false
    }
    // Invariant: run-scoped cleanup may only reap LEAF work processes. A
    // nested `matos workflow ...` orchestrator launched inside an exec
    // command inherits this run's ownership markers unchanged (/proc environ
    // shows the environment from execve time), yet it manages its own child
    // run whose exec processes carry the *nested* run dir and are therefore
    // invisible to this scan. Signalling the orchestrator here would orphan
    // that entire scientific subtree, so it is never treated as owned. It is
    // still stopped when it shares the exec child's process group (the
    // process-group-first SIGTERM/SIGKILL at the exec boundary), while a
    // deliberately detached nested orchestrator is left to finish managing
    // its own run. Genuinely escaped leaves (e.g. setsid MPI ranks) do not
    // match the CLI cmdline shape and remain reapable.
    return !(await processIsWorkflowOrchestrator(pid))
  } catch {
    return false
  }
}

async function matchingWorkflowProcessPids(
  candidates: Set<string>,
  nodeId?: string,
): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const pids = entries
    .filter(entry => /^\d+$/.test(entry))
    .map(entry => Number(entry))
    .filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)
  const matches = await Promise.all(
    pids.map(async pid =>
      (await processHasWorkflowRunDir(pid, candidates, nodeId))
        ? pid
        : undefined,
    ),
  )
  return matches.filter((pid): pid is number => pid !== undefined)
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

/**
 * Terminates local processes owned by one workflow run, including MPI ranks or
 * other descendants that escaped the exec node's original process group.
 *
 * Ownership is established by the exec-specific marker and exact
 * MATOS_WORKFLOW_RUN_DIR value injected at the exec boundary. Requiring both
 * avoids interrupting short-lived local helpers used to control a remote
 * compute backend. Supplying nodeId further narrows cleanup to one failed node;
 * omitting it intentionally targets every exec node during whole-run cancel.
 * Every PID is rechecked immediately before signalling, which also avoids
 * signalling an unrelated process after PID reuse. The operation is Linux-only
 * and deliberately best-effort so cancellation itself cannot be blocked by an
 * unavailable or restricted /proc filesystem.
 *
 * Invariant: only LEAF work processes are reaped here. A nested
 * `matos workflow ...` orchestrator inherits this run's markers unchanged but
 * owns a separate child run; SIGKILLing it would orphan that run's scientific
 * descendants (they carry the nested run dir and are invisible to this scan),
 * so orchestrator processes are excluded from ownership and are instead
 * stopped via the exec child's process-group signalling at the exec boundary.
 */
export async function terminateWorkflowRunLocalProcesses(
  runDir: string,
  options: { nodeId?: string; termGraceMs?: number; pollMs?: number } = {},
): Promise<WorkflowLocalProcessTermination> {
  if (process.platform !== 'linux' || runDir.length === 0) {
    return {
      supported: false,
      matchedPids: [],
      terminatedPids: [],
      killedPids: [],
    }
  }
  const candidates = workflowRunDirCandidates(runDir)
  const matchedPids = await matchingWorkflowProcessPids(
    candidates,
    options.nodeId,
  )
  const terminatedPids: number[] = []
  for (const pid of matchedPids) {
    if (
      (await processHasWorkflowRunDir(pid, candidates, options.nodeId)) &&
      signalProcess(pid, 'SIGTERM')
    ) {
      terminatedPids.push(pid)
    }
  }

  const termGraceMs = Math.max(0, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS)
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS)
  const deadline = Date.now() + termGraceMs
  let remaining = terminatedPids
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    const ownership = await Promise.all(
      remaining.map(pid =>
        processHasWorkflowRunDir(pid, candidates, options.nodeId),
      ),
    )
    remaining = remaining.filter((_, index) => ownership[index])
  }

  const killedPids: number[] = []
  for (const pid of remaining) {
    if (
      (await processHasWorkflowRunDir(pid, candidates, options.nodeId)) &&
      signalProcess(pid, 'SIGKILL')
    ) {
      killedPids.push(pid)
    }
  }
  return {
    supported: true,
    matchedPids,
    terminatedPids,
    killedPids,
  }
}
