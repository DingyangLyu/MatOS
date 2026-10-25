import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readJson, writeJson } from './jsonIo.js'

export type WorkflowRunControlAction = 'cancel' | 'pause'

function workflowRunControlPath(runDir: string): string {
  return join(runDir, 'control.json')
}

export async function readWorkflowRunControlAction(
  runDir: string,
): Promise<WorkflowRunControlAction | undefined> {
  try {
    const control = await readJson<{ action?: unknown }>(
      workflowRunControlPath(runDir),
    )
    return control.action === 'cancel' || control.action === 'pause'
      ? control.action
      : undefined
  } catch {
    return undefined
  }
}

export async function requestWorkflowRunControl(
  runDir: string,
  action: WorkflowRunControlAction,
): Promise<void> {
  await writeJson(workflowRunControlPath(runDir), {
    action,
    requestedAt: new Date().toISOString(),
  })
}

export async function clearWorkflowRunControl(runDir: string): Promise<void> {
  await rm(workflowRunControlPath(runDir), { force: true }).catch(() => {})
}

/**
 * Invariant: waits inside the run advance loop (retry backoff and similar
 * scheduling sleeps) must stay responsive to the cooperative control marker.
 * Sleeps for up to `waitMs`, polling the marker, and returns early with the
 * observed action; returns the action immediately when one is already set.
 * A plain `delay(backoffMs)` here previously pinned cancel/pause requests
 * behind arbitrarily long retry backoffs.
 */
export async function waitWorkflowRunBackoff(
  runDir: string,
  waitMs: number,
  pollMs = 250,
): Promise<WorkflowRunControlAction | undefined> {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const action = await readWorkflowRunControlAction(runDir)
    if (action) {
      return action
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return undefined
    }
    await delay(Math.min(Math.max(pollMs, 10), remaining))
  }
}

const WORKFLOW_CANCEL_POLL_MS = 250

export type WorkflowRunCancellationWatcher = {
  signal: AbortSignal
  cancelled: () => boolean
  stop: () => void
}

/**
 * Poll the run's cooperative control marker and fire once when a cancel
 * request appears. Long-running node adapters (agent CLI children, exec
 * process trees) watch this so `matos workflow cancel` can settle an
 * in-flight node instead of waiting for it to reach a node boundary.
 */
export function watchWorkflowRunCancellation(
  runDir: string | undefined,
  onCancel?: () => void,
  pollMs = WORKFLOW_CANCEL_POLL_MS,
): WorkflowRunCancellationWatcher {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let cancelled = false

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
  const check = async (): Promise<void> => {
    if (stopped || !runDir) return
    const action = await readWorkflowRunControlAction(runDir)
    if (stopped) return
    if (action === 'cancel') {
      cancelled = true
      stopped = true
      controller.abort(new Error('Workflow run cancelled'))
      onCancel?.()
      return
    }
    timer = setTimeout(() => void check(), Math.max(10, pollMs))
    timer.unref?.()
  }
  void check()

  return {
    signal: controller.signal,
    cancelled: () => cancelled,
    stop,
  }
}
