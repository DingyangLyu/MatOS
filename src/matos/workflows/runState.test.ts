import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { inspectWorkflowRunView, updateRunStatus } from './runState.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
} from './workflowStore.js'

async function createRunningRun(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const handle = await createWorkflowRun({
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:status-race@0.1.0',
    parameters: {},
    graphSnapshot: {
      schemaVersion: 1,
      name: 'status race',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [{ id: 'only', type: 'exec', label: 'Single step', dependsOn: [], command: 'true' }],
    },
    workspaceDir: root,
  })
  await updateRunStatus(handle.dir, 'running')
  return handle.dir
}

// Regression for engine review defect P1-1: updateRunStatus used to be an
// unlocked read-modify-write of run.json, so in a parallel scheduler batch a
// failing node racing an approval-gated sibling could erase the terminal
// `failed` status with a stale `waiting_approval` write and the run could
// later "complete" despite the failure.
describe('workflow run status race protection', () => {
  test('inspect preserves the pinned workflow identity and graph labels', async () => {
    const runDir = await createRunningRun('matos-run-view-')
    const view = await inspectWorkflowRunView(runDir)
    expect(view.workflowRef).toBe('workflow:status-race@0.1.0')
    expect(view.workflowName).toBe('status race')
    expect(view.graph?.nodes[0]?.label).toBe('Single step')
    expect(view.graph?.nodes[0]).not.toHaveProperty('command')
  })

  test('a racing waiting_approval update never overwrites failed (failure first)', async () => {
    const runDir = await createRunningRun('matos-run-status-race-')

    await Promise.all([
      updateRunStatus(runDir, 'failed'),
      updateRunStatus(runDir, 'waiting_approval', { waitingNodeId: 'gate' }),
    ])

    const snapshot = await readWorkflowRun(runDir)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.waitingNodeId).toBeUndefined()

    const events = await readWorkflowRunEvents(runDir)
    const rejected = events.find(
      event => event.type === 'workflow.run.status_change_rejected',
    )
    expect(rejected?.data).toMatchObject({
      from: 'failed',
      to: 'waiting_approval',
    })
    // The gate update must not have appended a status_changed event either.
    expect(
      events.filter(
        event =>
          event.type === 'workflow.run.status_changed' &&
          event.data.status === 'waiting_approval',
      ),
    ).toHaveLength(0)
  })

  test('failed wins when the approval-gate update lands first', async () => {
    const runDir = await createRunningRun('matos-run-status-race-rev-')

    await Promise.all([
      updateRunStatus(runDir, 'waiting_approval', { waitingNodeId: 'gate' }),
      updateRunStatus(runDir, 'failed'),
    ])

    const snapshot = await readWorkflowRun(runDir)
    expect(snapshot.status).toBe('failed')
  })

  test('rejected terminal overwrite returns the surviving snapshot', async () => {
    const runDir = await createRunningRun('matos-run-status-terminal-')

    await updateRunStatus(runDir, 'failed')
    const afterRejected = await updateRunStatus(runDir, 'waiting_input', {
      waitingNodeId: 'reviewer',
    })
    expect(afterRejected.status).toBe('failed')
    expect(afterRejected.waitingNodeId).toBeUndefined()

    // Explicit restart to running (operator retry/resume/respond paths) is
    // the one sanctioned transition out of a terminal state.
    const restarted = await updateRunStatus(runDir, 'running')
    expect(restarted.status).toBe('running')
  })
})
