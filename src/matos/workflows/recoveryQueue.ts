import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  recoverWorkflowRun,
  type WorkflowRecoveryClassification,
  type WorkflowRecoveryRecommendedAction,
  type WorkflowRemoteRecoveryEvidence,
} from './recovery.js'
import { readJson, writeJson } from './jsonIo.js'

export type WorkflowRemoteRecoveryJobStatus =
  | 'queued'
  | 'waiting'
  | 'blocked'
  | 'running'
  | 'completed'
  | 'failed'

export type WorkflowRemoteRecoveryJob = {
  jobId: string
  runId: string
  runDir: string
  workflowRef: string
  nodeId?: string
  classification: WorkflowRecoveryClassification
  recommendedAction: WorkflowRecoveryRecommendedAction
  status: WorkflowRemoteRecoveryJobStatus
  reason: string
  remoteRecovery: WorkflowRemoteRecoveryEvidence
  dueAt: string
  createdAt: string
  updatedAt: string
  attempts: number
  startedAt?: string
  completedAt?: string
  failedAt?: string
  result?: unknown
  error?: string
}

export type RefreshWorkflowRemoteRecoveryQueueResult = {
  jobs: WorkflowRemoteRecoveryJob[]
  removed: string[]
}

export type DrainWorkflowRemoteRecoveryQueueResult = {
  ran: WorkflowRemoteRecoveryJob[]
  skipped: WorkflowRemoteRecoveryJob[]
}

function nowIso(input?: string | Date): string {
  if (input instanceof Date) {
    return input.toISOString()
  }
  return input ?? new Date().toISOString()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sanitizeJobPart(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

function jobPath(queueDir: string, jobId: string): string {
  return join(queueDir, `${jobId}.json`)
}

// A claim left by a crashed drainer is stolen once it is older than this.
const RECOVERY_JOB_CLAIM_STALE_MS = 30 * 60 * 1000

function jobClaimDir(queueDir: string, jobId: string): string {
  return join(queueDir, '.claims', jobId)
}

// Atomically claim a due job so two concurrent drainers cannot both apply it.
// A directory create is atomic on POSIX; a stale claim is stolen with an atomic
// rename so racing drainers cannot both reclaim it. Job files are `*.json`, so
// the `.claims` subdirectory is ignored by the queue readers.
async function claimRecoveryJob(queueDir: string, jobId: string): Promise<boolean> {
  await mkdir(join(queueDir, '.claims'), { recursive: true })
  const claimDir = jobClaimDir(queueDir, jobId)
  try {
    await mkdir(claimDir)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    try {
      const info = await stat(claimDir)
      if (Date.now() - info.mtimeMs > RECOVERY_JOB_CLAIM_STALE_MS) {
        const steal = `${claimDir}.stale-${process.pid}-${Date.now()}`
        try {
          await rename(claimDir, steal)
          await rm(steal, { recursive: true, force: true })
          await mkdir(claimDir)
          return true
        } catch {
          return false
        }
      }
    } catch {
      return false
    }
    return false
  }
}

async function releaseRecoveryJobClaim(
  queueDir: string,
  jobId: string,
): Promise<void> {
  await rm(jobClaimDir(queueDir, jobId), { recursive: true, force: true }).catch(
    () => {},
  )
}

function parseTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function recoveryJobStatus(input: {
  recommendedAction: WorkflowRecoveryRecommendedAction
  remoteRecovery: WorkflowRemoteRecoveryEvidence
  dueAt: string
  now: string
}): WorkflowRemoteRecoveryJobStatus | undefined {
  if (
    input.recommendedAction === 'request_human_review' ||
    input.remoteRecovery.escalated === true
  ) {
    return 'blocked'
  }
  if (input.recommendedAction === 'wait') {
    return 'waiting'
  }
  if (
    input.recommendedAction !== 'reconcile_compute' &&
    input.recommendedAction !== 'retry_remote_cancel'
  ) {
    return undefined
  }
  return parseTime(input.dueAt) <= parseTime(input.now) ? 'queued' : 'waiting'
}

async function readExistingJob(
  queueDir: string,
  jobId: string,
): Promise<WorkflowRemoteRecoveryJob | undefined> {
  try {
    return await readJson<WorkflowRemoteRecoveryJob>(jobPath(queueDir, jobId))
  } catch {
    return undefined
  }
}

async function writeJob(
  queueDir: string,
  job: WorkflowRemoteRecoveryJob,
): Promise<void> {
  await mkdir(queueDir, { recursive: true })
  await writeJson(jobPath(queueDir, job.jobId), job)
}

async function workflowRunDirs(workflowRunsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(workflowRunsDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(workflowRunsDir, entry.name))
}

async function recoveryJobFromRun(input: {
  queueDir: string
  runDir: string
  now: string
}): Promise<WorkflowRemoteRecoveryJob | undefined> {
  const recovery = await recoverWorkflowRun(input.runDir)
  if (!recovery.remoteRecovery) {
    return undefined
  }
  const dueAt = recovery.remoteRecovery.nextRetryAt ?? input.now
  const status = recoveryJobStatus({
    recommendedAction: recovery.recommendedAction,
    remoteRecovery: recovery.remoteRecovery,
    dueAt,
    now: input.now,
  })
  if (!status) {
    return undefined
  }
  const kind = recovery.remoteRecovery.kind
  const taskId = recovery.remoteRecovery.taskId
  const jobId = [
    'workflow-remote-recovery',
    sanitizeJobPart(recovery.runId, 'run'),
    sanitizeJobPart(recovery.nodeId, 'node'),
    sanitizeJobPart(kind, 'remote'),
    sanitizeJobPart(taskId, recovery.classification),
  ].join('-')
  const existing = await readExistingJob(input.queueDir, jobId)
  return {
    jobId,
    runId: recovery.runId,
    runDir: recovery.runDir,
    workflowRef: recovery.workflowRef,
    ...(recovery.nodeId ? { nodeId: recovery.nodeId } : {}),
    classification: recovery.classification,
    recommendedAction: recovery.recommendedAction,
    status,
    reason: recovery.reason,
    remoteRecovery: recovery.remoteRecovery,
    dueAt,
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
    attempts: existing?.attempts ?? 0,
    ...(existing?.result && existing.status === status
      ? { result: existing.result }
      : {}),
  }
}

export async function listWorkflowRemoteRecoveryQueue(input: {
  queueDir: string
}): Promise<WorkflowRemoteRecoveryJob[]> {
  let entries
  try {
    entries = await readdir(input.queueDir, { withFileTypes: true })
  } catch {
    return []
  }
  const jobs: WorkflowRemoteRecoveryJob[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    try {
      jobs.push(
        await readJson<WorkflowRemoteRecoveryJob>(join(input.queueDir, entry.name)),
      )
    } catch {
      // Ignore corrupt queue entries; refresh will rewrite entries for live runs.
    }
  }
  return jobs.sort((a, b) => a.jobId.localeCompare(b.jobId))
}

export async function refreshWorkflowRemoteRecoveryQueue(input: {
  workflowRunsDir: string
  queueDir: string
  now?: string | Date
}): Promise<RefreshWorkflowRemoteRecoveryQueueResult> {
  const now = nowIso(input.now)
  await mkdir(input.queueDir, { recursive: true })
  const runDirs = await workflowRunDirs(input.workflowRunsDir)
  const seenRunIds = new Set<string>()
  const activeJobIds = new Set<string>()
  const jobs: WorkflowRemoteRecoveryJob[] = []
  for (const runDir of runDirs) {
    const job = await recoveryJobFromRun({
      queueDir: input.queueDir,
      runDir,
      now,
    }).catch(() => undefined)
    if (job) {
      seenRunIds.add(job.runId)
      activeJobIds.add(job.jobId)
      await writeJob(input.queueDir, job)
      jobs.push(job)
      continue
    }
    try {
      const recovery = await recoverWorkflowRun(runDir)
      seenRunIds.add(recovery.runId)
    } catch {
      // Ignore incomplete or corrupt run dirs during queue refresh.
    }
  }

  const removed: string[] = []
  for (const existing of await listWorkflowRemoteRecoveryQueue({
    queueDir: input.queueDir,
  })) {
    if (activeJobIds.has(existing.jobId)) {
      continue
    }
    // Prune a job when its run was seen this scan but no longer needs recovery,
    // or when its run directory is gone entirely. A run that is merely
    // unreadable this scan (transient/corrupt) keeps its job so a flapping read
    // does not drop pending recovery work.
    const runResolved = seenRunIds.has(existing.runId)
    const runDirGone = !runResolved && !(await exists(existing.runDir))
    if (!runResolved && !runDirGone) {
      continue
    }
    await rm(jobPath(input.queueDir, existing.jobId), { force: true })
    removed.push(existing.jobId)
  }

  return { jobs: jobs.sort((a, b) => a.jobId.localeCompare(b.jobId)), removed }
}

export async function dueWorkflowRemoteRecoveryJobs(input: {
  queueDir: string
  now?: string | Date
}): Promise<WorkflowRemoteRecoveryJob[]> {
  const now = nowIso(input.now)
  return (await listWorkflowRemoteRecoveryQueue({ queueDir: input.queueDir }))
    .filter(job => job.status === 'queued' && parseTime(job.dueAt) <= parseTime(now))
    .sort((a, b) => parseTime(a.dueAt) - parseTime(b.dueAt))
}

export async function drainWorkflowRemoteRecoveryQueue(input: {
  queueDir: string
  now?: string | Date
  applyJob: (job: WorkflowRemoteRecoveryJob) => Promise<unknown>
  shouldApplyJob?: (job: WorkflowRemoteRecoveryJob) => boolean
}): Promise<DrainWorkflowRemoteRecoveryQueueResult> {
  const now = nowIso(input.now)
  const jobs = (await listWorkflowRemoteRecoveryQueue({ queueDir: input.queueDir }))
    .filter(job => input.shouldApplyJob ? input.shouldApplyJob(job) : true)
  const due = jobs.filter(
    job => job.status === 'queued' && parseTime(job.dueAt) <= parseTime(now),
  )
  const skipped = jobs.filter(job => !due.some(dueJob => dueJob.jobId === job.jobId))
  const ran: WorkflowRemoteRecoveryJob[] = []

  for (const job of due) {
    // Claim the job so two concurrent drainers cannot both apply it. The
    // applyJob run lock already serializes per run, but the claim avoids the
    // duplicate work and double status writes entirely.
    if (!(await claimRecoveryJob(input.queueDir, job.jobId))) {
      continue
    }
    try {
      const running: WorkflowRemoteRecoveryJob = {
        ...job,
        status: 'running',
        attempts: job.attempts + 1,
        startedAt: now,
        updatedAt: now,
      }
      await writeJob(input.queueDir, running)
      try {
        const result = await input.applyJob(running)
        const completed: WorkflowRemoteRecoveryJob = {
          ...running,
          status: 'completed',
          completedAt: now,
          updatedAt: now,
          result,
        }
        await writeJob(input.queueDir, completed)
        ran.push(completed)
      } catch (error) {
        const failed: WorkflowRemoteRecoveryJob = {
          ...running,
          status: 'failed',
          failedAt: now,
          updatedAt: now,
          error: error instanceof Error ? error.message : String(error),
        }
        await writeJob(input.queueDir, failed)
        ran.push(failed)
      }
    } finally {
      await releaseRecoveryJobClaim(input.queueDir, job.jobId)
    }
  }

  if (!(await exists(input.queueDir))) {
    await mkdir(input.queueDir, { recursive: true })
  }
  return { ran, skipped }
}
