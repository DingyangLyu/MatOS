// Registry of locally spawned workflow node child processes.
//
// Invariant: every local node child (exec command, headless agent turn) is
// recorded in its node-run dir while it executes, so run cancellation can
// terminate the detached process group even when the worker that spawned it
// is gone. Exec/agent children are spawned `detached` (own process group) on
// purpose, which also means nothing kills them implicitly when their parent
// dies or when `cancelWorkflowRunInternal` flips run.json to `cancelled` —
// without this registry a cancelled run leaves VASP/OpenFOAM-style local
// compute running to completion.
//
// Pid-reuse safety: records capture the Linux /proc start-time ticks of the
// child at spawn. A kill is only delivered when the currently running pid has
// the same start time; otherwise the record is treated as stale and dropped.

import { readdir, readFile, rm } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readJson, writeJson } from './jsonIo.js'

export type WorkflowLocalProcessKind = 'exec' | 'agent'

export type WorkflowLocalProcessRecord = {
  pid: number
  kind: WorkflowLocalProcessKind
  nodeId: string
  ownerPid: number
  startedAt: string
  /** /proc/<pid>/stat field 22 at spawn; guards against pid reuse. */
  processStartTicks?: string
}

export type WorkflowLocalProcessKillResult = {
  nodeId: string
  pid: number
  kind: WorkflowLocalProcessKind
  outcome: 'terminated' | 'killed' | 'already_gone' | 'stale_record'
}

const LOCAL_PROCESS_FILE = 'local-process.json'
const DEFAULT_KILL_GRACE_MS = 2_000

function localProcessPath(runDir: string, nodeId: string): string {
  return join(runDir, 'node-runs', nodeId, LOCAL_PROCESS_FILE)
}

async function procStartTicks(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // Fields after the parenthesized comm (which may contain spaces/parens):
    // state ppid pgrp ... starttime is overall field 22 => index 19 here.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim()
    return afterComm.split(/\s+/)[19]
  } catch {
    return undefined
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Record a freshly spawned local node child. Best-effort: registration
 * failures must never break node execution, only weaken external kill.
 */
export async function registerWorkflowLocalProcess(input: {
  runDir: string
  nodeId: string
  pid: number | undefined
  kind: WorkflowLocalProcessKind
}): Promise<void> {
  if (!input.pid || input.pid <= 0) {
    return
  }
  try {
    mkdirSync(join(input.runDir, 'node-runs', input.nodeId), { recursive: true })
    const ticks = await procStartTicks(input.pid)
    const record: WorkflowLocalProcessRecord = {
      pid: input.pid,
      kind: input.kind,
      nodeId: input.nodeId,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
      ...(ticks ? { processStartTicks: ticks } : {}),
    }
    await writeJson(localProcessPath(input.runDir, input.nodeId), record)
  } catch {
    // Best-effort by design.
  }
}

/**
 * Drop the registration once the child settled. Only removes the record when
 * it still names the released pid, so a fast retry attempt that re-registered
 * the node is never clobbered by the previous attempt's async cleanup.
 */
export async function releaseWorkflowLocalProcess(input: {
  runDir: string
  nodeId: string
  pid: number | undefined
}): Promise<void> {
  try {
    const path = localProcessPath(input.runDir, input.nodeId)
    const record = await readJson<WorkflowLocalProcessRecord>(path)
    if (input.pid === undefined || record.pid === input.pid) {
      await rm(path, { force: true })
    }
  } catch {
    // Missing/unreadable record: nothing to release.
  }
}

async function listWorkflowLocalProcessRecords(
  runDir: string,
): Promise<WorkflowLocalProcessRecord[]> {
  let nodeIds: string[]
  try {
    nodeIds = await readdir(join(runDir, 'node-runs'))
  } catch {
    return []
  }
  const records: WorkflowLocalProcessRecord[] = []
  for (const nodeId of nodeIds.sort()) {
    try {
      const record = await readJson<WorkflowLocalProcessRecord>(
        localProcessPath(runDir, nodeId),
      )
      if (typeof record.pid === 'number' && record.pid > 0) {
        records.push({ ...record, nodeId })
      }
    } catch {
      continue
    }
  }
  return records
}

async function recordStillNamesLiveChild(
  record: WorkflowLocalProcessRecord,
): Promise<'live' | 'gone' | 'reused'> {
  if (!pidIsAlive(record.pid)) {
    return 'gone'
  }
  if (!record.processStartTicks) {
    // No spawn-time fingerprint (non-Linux or /proc unavailable): treat the
    // live pid as ours, matching the pre-registry kill-by-pgid behavior.
    return 'live'
  }
  const currentTicks = await procStartTicks(record.pid)
  if (currentTicks === undefined) {
    return 'gone'
  }
  return currentTicks === record.processStartTicks ? 'live' : 'reused'
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, signal)
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Terminate every registered local child of this run whose node is still
 * `running`: SIGTERM first, then SIGKILL for survivors after a bounded grace.
 * Stale records (dead or reused pids) are dropped without signalling.
 */
export async function killWorkflowRunLocalProcesses(
  runDir: string,
  options: { graceMs?: number } = {},
): Promise<WorkflowLocalProcessKillResult[]> {
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS
  const results: WorkflowLocalProcessKillResult[] = []
  const candidates: WorkflowLocalProcessRecord[] = []

  for (const record of await listWorkflowLocalProcessRecords(runDir)) {
    const nodeRunStatus = await readJson<{ status?: unknown }>(
      join(runDir, 'node-runs', record.nodeId, 'node-run.json'),
    )
      .then(nodeRun => nodeRun.status)
      .catch(() => undefined)
    if (nodeRunStatus !== undefined && nodeRunStatus !== 'running') {
      // The node settled; a leftover record is a crash remnant of a finished
      // child. Drop it without signalling anything.
      await releaseWorkflowLocalProcess({
        runDir,
        nodeId: record.nodeId,
        pid: record.pid,
      })
      continue
    }
    const liveness = await recordStillNamesLiveChild(record)
    if (liveness === 'live') {
      candidates.push(record)
      continue
    }
    await releaseWorkflowLocalProcess({
      runDir,
      nodeId: record.nodeId,
      pid: record.pid,
    })
    results.push({
      nodeId: record.nodeId,
      pid: record.pid,
      kind: record.kind,
      outcome: liveness === 'gone' ? 'already_gone' : 'stale_record',
    })
  }

  if (candidates.length === 0) {
    return results
  }
  for (const record of candidates) {
    killProcessGroup(record.pid, 'SIGTERM')
  }
  const deadline = Date.now() + Math.max(0, graceMs)
  let survivors = candidates
  for (;;) {
    const next: WorkflowLocalProcessRecord[] = []
    for (const record of survivors) {
      if ((await recordStillNamesLiveChild(record)) === 'live') {
        next.push(record)
      } else {
        await releaseWorkflowLocalProcess({
          runDir,
          nodeId: record.nodeId,
          pid: record.pid,
        })
        results.push({
          nodeId: record.nodeId,
          pid: record.pid,
          kind: record.kind,
          outcome: 'terminated',
        })
      }
    }
    survivors = next
    if (survivors.length === 0 || Date.now() >= deadline) {
      break
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  for (const record of survivors) {
    killProcessGroup(record.pid, 'SIGKILL')
    await releaseWorkflowLocalProcess({
      runDir,
      nodeId: record.nodeId,
      pid: record.pid,
    })
    results.push({
      nodeId: record.nodeId,
      pid: record.pid,
      kind: record.kind,
      outcome: 'killed',
    })
  }
  return results
}
