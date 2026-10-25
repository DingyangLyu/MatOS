import { createRequire } from 'module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { MatOSWorkbenchContext } from './types.js'

type FeedbackReport = {
  id: string
  createdAt: string
  updatedAt?: string
  resolvedAt?: string | null
  status: string
  kind: string
  severity: string
  title: string
  message?: string
  messagePreview?: string
  contact?: string
  context?: Record<string, unknown>
  attachments?: Array<{
    id: string
    name: string
    mimeType: string
    size: number
    fileName?: string
  }>
  statusHistory?: Array<{ status: string; at: string }>
  storagePath?: string
  viewerAccess?: 'full' | 'title'
}

type FeedbackAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
  buffer: Buffer
}

type FeedbackStore = {
  createFeedbackReport: (input: unknown, options?: { dir?: string }) => Promise<FeedbackReport>
  importGitFeedbackHistory: (
    records: Array<{ commit: string; committedAt: string; subject: string }>,
    options?: { dir?: string },
  ) => Promise<{ created: number; skipped: number; ids: string[] }>
  listFeedbackReports: (options?: { dir?: string }) => Promise<FeedbackReport[]>
  readFeedbackAttachment: (
    reportId: string,
    attachmentId: string,
    options?: { dir?: string },
  ) => Promise<FeedbackAttachment>
  updateFeedbackReportStatus: (
    reportId: string,
    status: string,
    options?: { dir?: string },
  ) => Promise<FeedbackReport>
}

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const feedbackStore = require('./feedbackStore.cjs') as FeedbackStore

const HISTORICAL_BUG_SUBJECT = /^(?:(?:fix|bugfix)(?:\([^)]+\))?!?:\s+|(?:fix|bugfix)\s+|bug(?:\([^)]+\))?!?:\s+)/i

export type MatOSFeedbackGitHistoryRecord = {
  commit: string
  committedAt: string
  subject: string
}

export function parseMatOSFeedbackGitHistory(stdout: string): MatOSFeedbackGitHistoryRecord[] {
  const seen = new Set<string>()
  const records: MatOSFeedbackGitHistoryRecord[] = []
  for (const rawRecord of String(stdout || '').split('\u001e')) {
    const [rawCommit, rawCommittedAt, ...subjectParts] = rawRecord
      .trim()
      .split('\u001f')
    const commit = rawCommit?.trim().toLowerCase() ?? ''
    const committedAt = rawCommittedAt?.trim() ?? ''
    const subject = subjectParts.join('\u001f').trim()
    if (
      !/^[a-f0-9]{7,64}$/.test(commit) ||
      !Number.isFinite(Date.parse(committedAt)) ||
      !HISTORICAL_BUG_SUBJECT.test(subject) ||
      seen.has(commit)
    ) {
      continue
    }
    seen.add(commit)
    records.push({ commit, committedAt, subject })
  }
  return records
}

function feedbackDir(env: Record<string, string | undefined> | undefined): string {
  return (
    env?.MATOS_FEEDBACK_DIR ||
    process.env.MATOS_FEEDBACK_DIR ||
    '/workspace/group/logs/feedback'
  )
}

function feedbackContext(input: MatOSWorkbenchContext): Record<string, string> {
  const env = input.env ?? process.env
  return {
    scopeRef: input.scopeRef || env.MATOS_SCOPE_ID || env.MATOS_SCOPE_REF || 'user:local',
    roleRef: env.MATOS_WORKSPACE_ROLE_REF || 'role:compute',
    runtimeRef: env.MATOS_RUNTIME_PROFILE_REF || (env.MATOS_STANDALONE === '1' ? 'runtime:local' : 'runtime:matos-openvscode'),
    workspaceDir: env.MATOS_WORKSPACE_DIR || (env.MATOS_STANDALONE === '1' ? input.cwd : '/workspace/group/shared'),
    feedbackDir: feedbackDir(env),
    traceId: env.MATOS_TRACE_ID || '',
    sessionId: env.MATOS_SESSION_ID || '',
  }
}

function isEnabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim())
}

function isFeedbackAdministrator(input: MatOSWorkbenchContext): boolean {
  const env = input.env ?? process.env
  // This capability is assigned to the trusted admin daemon by deployment.
  // Scope refs are user-controlled CLI input and therefore cannot grant it.
  return isEnabled(env.MATOS_FEEDBACK_ADMIN)
}

function reportPreview(
  report: FeedbackReport,
  viewerAccess: 'full' | 'title' = 'full',
): FeedbackReport {
  if (viewerAccess === 'title') {
    return {
      id: report.id,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      resolvedAt: report.resolvedAt ?? null,
      status: report.status,
      kind: report.kind,
      severity: report.severity,
      title: report.title,
      message: '',
      messagePreview: '',
      contact: '',
      context: {},
      attachments: [],
      viewerAccess,
    }
  }
  return {
    id: report.id,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    resolvedAt: report.resolvedAt ?? null,
    status: report.status,
    kind: report.kind,
    severity: report.severity,
    title: report.title,
    message: report.message,
    messagePreview: report.messagePreview ?? report.message?.slice(0, 180) ?? '',
    contact: report.contact,
    context: report.context,
    attachments: (report.attachments ?? []).map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })),
    statusHistory: report.statusHistory,
    storagePath: report.storagePath,
    viewerAccess,
  }
}

async function requireFeedbackReport(
  input: MatOSWorkbenchContext,
  reportId: string,
): Promise<FeedbackReport> {
  const reports = await feedbackStore.listFeedbackReports({
    dir: feedbackDir(input.env),
  })
  const report = reports.find(candidate => candidate.id === reportId)
  if (!report) {
    const error = new Error('Feedback report not found') as Error & { code?: string }
    error.code = 'ENOENT'
    throw error
  }
  return report
}

function feedbackSummary(reports: FeedbackReport[]): {
  statusCounts: Record<string, number>
  resolvedDaily: Record<string, number>
  fixedTotal: number
} {
  const statusCounts: Record<string, number> = {}
  const resolvedDaily: Record<string, number> = {}
  let fixedTotal = 0
  for (const report of reports) {
    const status = String(report.status || 'open')
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
    if (status !== 'resolved' && status !== 'closed') continue
    fixedTotal += 1
    const timestamp = report.resolvedAt || report.updatedAt || report.createdAt
    const parsed = Date.parse(String(timestamp || ''))
    if (!Number.isFinite(parsed)) continue
    const day = new Date(parsed).toISOString().slice(0, 10)
    resolvedDaily[day] = (resolvedDaily[day] ?? 0) + 1
  }
  return { statusCounts, resolvedDaily, fixedTotal }
}

export async function listMatOSWorkbenchFeedback(
  input: MatOSWorkbenchContext & {
    limit?: number
    offset?: number
  },
): Promise<{
  kind: 'matos.workbench.feedback.list'
  reports: FeedbackReport[]
  total: number
  summary: {
    statusCounts: Record<string, number>
    resolvedDaily: Record<string, number>
    fixedTotal: number
  }
  context: Record<string, string>
}> {
  const storedReports = await feedbackStore.listFeedbackReports({
    dir: feedbackDir(input.env),
  })
  const reports = storedReports.map(report => reportPreview(
    report,
    isFeedbackAdministrator(input) ? 'full' : 'title',
  ))
  const offset = input.offset ?? 0
  const limit = input.limit ?? reports.length
  return {
    kind: 'matos.workbench.feedback.list',
    reports: reports.slice(offset, offset + limit),
    total: reports.length,
    summary: feedbackSummary(storedReports),
    context: feedbackContext(input),
  }
}

export async function submitMatOSWorkbenchFeedback(
  input: MatOSWorkbenchContext & {
    request: unknown
  },
): Promise<{
  kind: 'matos.workbench.feedback.submit'
  report: FeedbackReport
  context: Record<string, string>
  notification?: unknown
}> {
  const request =
    typeof input.request === 'object' && input.request !== null
      ? (input.request as Record<string, unknown>)
      : {}
  const requestContext =
    typeof request.context === 'object' &&
    request.context !== null &&
    !Array.isArray(request.context)
      ? request.context as Record<string, unknown>
      : {}
  const report = await feedbackStore.createFeedbackReport(
    {
      ...request,
      context: {
        ...requestContext,
        ...feedbackContext(input),
      },
    },
    { dir: feedbackDir(input.env) },
  )
  return {
    kind: 'matos.workbench.feedback.submit',
    report: reportPreview(
      report,
      isFeedbackAdministrator(input) ? 'full' : 'title',
    ),
    context: feedbackContext(input),
    notification: { attempted: false, reason: 'stored-locally' },
  }
}

export async function updateMatOSWorkbenchFeedbackStatus(
  input: MatOSWorkbenchContext & {
    reportId: string
    status: string
  },
): Promise<{
  kind: 'matos.workbench.feedback.status'
  report: FeedbackReport
}> {
  if (!isFeedbackAdministrator(input)) {
    const error = new Error('Feedback status can only be changed by an administrator') as Error & { code?: string }
    error.code = 'EACCES'
    throw error
  }
  await requireFeedbackReport(input, input.reportId)
  const report = await feedbackStore.updateFeedbackReportStatus(
    input.reportId,
    input.status,
    { dir: feedbackDir(input.env) },
  )
  return {
    kind: 'matos.workbench.feedback.status',
    report: reportPreview(report),
  }
}

export async function backfillMatOSWorkbenchFeedbackFromGit(
  input: MatOSWorkbenchContext & {
    repositoryDir?: string
  },
): Promise<{
  kind: 'matos.workbench.feedback.backfill-git'
  discovered: number
  created: number
  skipped: number
  total: number
}> {
  const repositoryDir = input.repositoryDir?.trim() || input.cwd
  const result = await execFileAsync(
    'git',
    [
      '-C',
      repositoryDir,
      'log',
      '--all',
      '--no-merges',
      '--format=%H%x1f%cI%x1f%s%x1e',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    },
  )
  const records = parseMatOSFeedbackGitHistory(result.stdout)
  const imported = await feedbackStore.importGitFeedbackHistory(records, {
    dir: feedbackDir(input.env),
  })
  const reports = await feedbackStore.listFeedbackReports({
    dir: feedbackDir(input.env),
  })
  return {
    kind: 'matos.workbench.feedback.backfill-git',
    discovered: records.length,
    created: imported.created,
    skipped: imported.skipped,
    total: reports.length,
  }
}

export async function readMatOSWorkbenchFeedbackAttachment(
  input: MatOSWorkbenchContext & {
    reportId: string
    attachmentId: string
  },
): Promise<{
  kind: 'matos.workbench.feedback.attachment'
  attachment: {
    id: string
    name: string
    mimeType: string
    size: number
    base64: string
  }
}> {
  if (!isFeedbackAdministrator(input)) {
    const error = new Error('Feedback attachments are only available to administrators') as Error & { code?: string }
    error.code = 'EACCES'
    throw error
  }
  await requireFeedbackReport(input, input.reportId)
  const attachment = await feedbackStore.readFeedbackAttachment(
    input.reportId,
    input.attachmentId,
    { dir: feedbackDir(input.env) },
  )
  return {
    kind: 'matos.workbench.feedback.attachment',
    attachment: {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      base64: attachment.buffer.toString('base64'),
    },
  }
}
