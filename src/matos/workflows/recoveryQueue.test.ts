import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  drainWorkflowRemoteRecoveryQueue,
  dueWorkflowRemoteRecoveryJobs,
  listWorkflowRemoteRecoveryQueue,
  refreshWorkflowRemoteRecoveryQueue,
} from './recoveryQueue.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createRemoteRecoveryRun(input: {
  workflowsDir: string
  workflowRunsDir: string
  name: string
  nodeId?: string
  runStatus?: 'waiting_input' | 'cancelled'
  lifecycle?: Record<string, unknown>
  outputLifecycle: Record<string, unknown>
}): Promise<{ runId: string; runDir: string }> {
  const nodeId = input.nodeId ?? 'submit'
  const handle = await createWorkflowRun({
    workflowsDir: input.workflowsDir,
    workflowRunsDir: input.workflowRunsDir,
    workflowRef: `workflow:${input.name}@0.1.0`,
    parameters: {},
    workspaceDir: input.workflowsDir,
    graphSnapshot: {
      schemaVersion: 1,
      name: input.name,
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
      outputs: {},
      nodes: [
        {
          id: nodeId,
          type: 'compute',
          dependsOn: [],
          backend: 'hpc-queue',
          operation: 'submit',
          ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
        },
      ],
    },
  })
  await mkdir(join(handle.dir, 'node-runs', nodeId), { recursive: true })
  await writeJson(join(handle.dir, 'node-runs', nodeId, 'node-run.json'), {
    nodeId,
    status: 'completed',
    attempts: 1,
    updatedAt: new Date().toISOString(),
    output: {
      ok: true,
      backend: 'hpc-queue',
      operation: 'submit',
      taskId: `t-${input.name}`,
      status: 'Submitted',
      artifacts: [],
      diagnostics: {
        lifecycle: input.outputLifecycle,
      },
    },
  })
  await writeWorkflowRun(handle.dir, {
    ...(await readWorkflowRun(handle.dir)),
    status: input.runStatus ?? 'waiting_input',
    waitingNodeId: input.runStatus === 'cancelled' ? undefined : 'review',
  })
  return { runId: handle.runId, runDir: handle.dir }
}

describe('MatOS workflow remote recovery queue', () => {
  test('refreshes durable due waiting and blocked remote recovery jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovery-queue-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const queueDir = join(workflowsDir, 'remote-recovery-queue')
    const now = '2026-06-04T12:00:00.000Z'
    const futureRetry = '2999-06-04T12:05:00.000Z'

    const dueRun = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'due-reconcile',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-due-reconcile',
            error: 'temporary status outage',
            nextRetryAt: '2026-06-04T11:55:00.000Z',
          },
        ],
      },
    })
    const waitingRun = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'waiting-cancel',
      runStatus: 'cancelled',
      outputLifecycle: {
        cancelFailures: [
          {
            taskId: 't-waiting-cancel',
            error: 'temporary cancel outage',
            nextRetryAt: futureRetry,
          },
        ],
      },
    })
    const blockedRun = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'blocked-reconcile',
      lifecycle: { reconcileEscalateAfterFailures: 3 },
      outputLifecycle: {
        reconcileFailures: [
          { taskId: 't-blocked-reconcile', error: 'first outage' },
          { taskId: 't-blocked-reconcile', error: 'second outage' },
          { taskId: 't-blocked-reconcile', error: 'third outage' },
        ],
      },
    })

    const refreshed = await refreshWorkflowRemoteRecoveryQueue({
      workflowRunsDir,
      queueDir,
      now,
    })
    const jobs = refreshed.jobs.sort((a, b) => a.runId.localeCompare(b.runId))

    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: dueRun.runId,
          runDir: dueRun.runDir,
          status: 'queued',
          recommendedAction: 'reconcile_compute',
          classification: 'compute_reconcile_failure',
          dueAt: now,
          remoteRecovery: expect.objectContaining({
            kind: 'reconcile',
            taskId: 't-due-reconcile',
            latestError: 'temporary status outage',
          }),
        }),
        expect.objectContaining({
          runId: waitingRun.runId,
          status: 'waiting',
          recommendedAction: 'wait',
          dueAt: futureRetry,
        }),
        expect.objectContaining({
          runId: blockedRun.runId,
          status: 'blocked',
          recommendedAction: 'request_human_review',
          classification: 'compute_remote_exception_escalated',
          remoteRecovery: expect.objectContaining({
            escalated: true,
            failureCount: 3,
          }),
        }),
      ]),
    )

    const persisted = await listWorkflowRemoteRecoveryQueue({ queueDir })
    expect(persisted.map(job => job.jobId).sort()).toEqual(
      refreshed.jobs.map(job => job.jobId).sort(),
    )
    const due = await dueWorkflowRemoteRecoveryJobs({ queueDir, now })
    expect(due.map(job => job.runId)).toEqual([dueRun.runId])

    const queueFile = await readFile(join(queueDir, `${due[0]!.jobId}.json`), 'utf8')
    expect(queueFile).toContain('t-due-reconcile')
  })

  test('drains only due remote recovery jobs and persists apply outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovery-drain-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const queueDir = join(workflowsDir, 'remote-recovery-queue')
    const now = '2026-06-04T12:00:00.000Z'

    const dueRun = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'due-drain',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-due-drain',
            error: 'temporary status outage',
            nextRetryAt: '2026-06-04T11:55:00.000Z',
          },
        ],
      },
    })
    await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'waiting-drain',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-waiting-drain',
            error: 'temporary status outage',
            nextRetryAt: '2999-06-04T12:05:00.000Z',
          },
        ],
      },
    })
    await refreshWorkflowRemoteRecoveryQueue({ workflowRunsDir, queueDir, now })

    const drain = await drainWorkflowRemoteRecoveryQueue({
      queueDir,
      now,
      applyJob: async job => ({
        appliedAction: job.recommendedAction,
        runId: job.runId,
        taskId: job.remoteRecovery.taskId,
      }),
    })

    expect(drain.ran).toEqual([
      expect.objectContaining({
        runId: dueRun.runId,
        status: 'completed',
        attempts: 1,
        result: expect.objectContaining({
          appliedAction: 'reconcile_compute',
          taskId: 't-due-drain',
        }),
      }),
    ])
    expect(drain.skipped.map(job => job.status)).toEqual(['waiting'])

    const persisted = await listWorkflowRemoteRecoveryQueue({ queueDir })
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: dueRun.runId,
          status: 'completed',
          attempts: 1,
          completedAt: expect.any(String),
        }),
      ]),
    )
  })

  test('drains only jobs accepted by the queue-level apply predicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovery-drain-filter-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const queueDir = join(workflowsDir, 'remote-recovery-queue')
    const now = '2026-06-04T12:00:00.000Z'

    const allowed = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'allowed-drain',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-allowed-drain',
            error: 'temporary status outage',
            nextRetryAt: '2026-06-04T11:55:00.000Z',
          },
        ],
      },
    })
    const denied = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'denied-drain',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-denied-drain',
            error: 'temporary status outage',
            nextRetryAt: '2026-06-04T11:55:00.000Z',
          },
        ],
      },
    })
    await refreshWorkflowRemoteRecoveryQueue({ workflowRunsDir, queueDir, now })

    const appliedRunIds: string[] = []
    const drain = await drainWorkflowRemoteRecoveryQueue({
      queueDir,
      now,
      shouldApplyJob: job => job.workflowRef === 'workflow:allowed-drain@0.1.0',
      applyJob: async job => {
        appliedRunIds.push(job.runId)
        return { runId: job.runId }
      },
    })

    expect(appliedRunIds).toEqual([allowed.runId])
    expect(drain.ran.map(job => job.runId)).toEqual([allowed.runId])
    expect(drain.skipped).toEqual([])

    const persisted = await listWorkflowRemoteRecoveryQueue({ queueDir })
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: allowed.runId, status: 'completed' }),
        expect.objectContaining({ runId: denied.runId, status: 'queued' }),
      ]),
    )
  })

  test('prunes queued jobs whose run directory was deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovery-prune-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const queueDir = join(workflowsDir, 'remote-recovery-queue')
    const now = '2026-06-04T12:00:00.000Z'

    const run = await createRemoteRecoveryRun({
      workflowsDir,
      workflowRunsDir,
      name: 'gone-reconcile',
      outputLifecycle: {
        reconcileFailures: [
          {
            source: 'manual_reconcile',
            taskId: 't-gone-reconcile',
            error: 'temporary status outage',
            nextRetryAt: '2026-06-04T11:55:00.000Z',
          },
        ],
      },
    })

    const first = await refreshWorkflowRemoteRecoveryQueue({
      workflowRunsDir,
      queueDir,
      now,
    })
    const jobId = first.jobs.find(job => job.runId === run.runId)?.jobId
    if (!jobId) {
      throw new Error('expected a queued recovery job for the run')
    }

    // The run directory disappears (for example the user deleted the run): its
    // queued job must be pruned instead of accumulating forever.
    await rm(run.runDir, { recursive: true, force: true })
    const second = await refreshWorkflowRemoteRecoveryQueue({
      workflowRunsDir,
      queueDir,
      now,
    })
    expect(second.removed).toContain(jobId)
    expect(await listWorkflowRemoteRecoveryQueue({ queueDir })).toEqual([])
  })
})
