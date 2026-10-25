'use strict'

const fs = require('fs/promises')
const path = require('path')
const { randomBytes } = require('crypto')

const SECRET_KEY_PATTERN = /token|secret|password|credential|authorization|api[_-]?key/i
const REPORT_ID_PATTERN = /^feedback-[A-Za-z0-9-]{8,120}$/
const ATTACHMENT_ID_PATTERN = /^image-[A-Za-z0-9-]{3,80}$/
const FEEDBACK_STATUSES = new Set([
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'closed',
  'rejected',
])
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const GIT_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i

function redactText(value) {
  return String(value || '')
    .replace(/\b(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .replace(/\bsecret-[A-Za-z0-9._-]+/g, '[redacted]')
}

function cleanString(value, maxLength) {
  return redactText(value).trim().slice(0, maxLength)
}

function sanitizeContext(context) {
  const clean = {}
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return clean
  }
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      continue
    }
    if (typeof value === 'string') {
      clean[key] = cleanString(value, 500)
    }
  }
  return clean
}

function invalidInput(message) {
  const error = new Error(message)
  error.code = 'EINVAL'
  return error
}

function safeReportId(value) {
  const id = String(value || '').trim()
  if (!REPORT_ID_PATTERN.test(id)) {
    throw invalidInput('Invalid feedback report id')
  }
  return id
}

function safeAttachmentId(value) {
  const id = String(value || '').trim()
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    throw invalidInput('Invalid feedback attachment id')
  }
  return id
}

function detectImage(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', extension: 'jpg' }
  }
  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { mimeType: 'image/gif', extension: 'gif' }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  return undefined
}

function reportPath(dir, id) {
  return path.join(dir, `${safeReportId(id)}.json`)
}

function attachmentDir(dir, id) {
  return path.join(dir, `${safeReportId(id)}.attachments`)
}

async function writeReport(dir, report) {
  const storagePath = reportPath(dir, report.id)
  const tempPath = `${storagePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await fs.rename(tempPath, storagePath)
  return storagePath
}

function historicalSeverity(subject) {
  if (/security|cross-user|credential|secret|data loss|corrupt|cannot start|unavailable|crash/i.test(subject)) {
    return 'blocking'
  }
  if (/fail|broken|regression|permission|timeout|hang|stale|drift|race|404|500|503/i.test(subject)) {
    return 'high'
  }
  return 'normal'
}

function historicalTitle(subject) {
  const stripped = String(subject || '')
    .replace(/^(?:fix|bugfix)(?:\([^)]+\))?!?:\s*/i, '')
    .replace(/^(?:fix|bugfix)\s+/i, '')
    .trim()
  return cleanString(`[历史反馈] ${stripped || subject}`, 200)
}

async function importGitFeedbackHistory(records, options = {}) {
  if (!Array.isArray(records)) {
    throw invalidInput('Git feedback history must be an array')
  }
  if (records.length > 10000) {
    throw invalidInput('Git feedback history cannot exceed 10000 records')
  }
  const dir = options.dir || process.env.MATOS_FEEDBACK_DIR || '/workspace/group/logs/feedback'
  await fs.mkdir(dir, { recursive: true })
  const result = { created: 0, skipped: 0, ids: [] }
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw invalidInput('Invalid Git feedback history record')
    }
    const commit = String(record.commit || '').trim().toLowerCase()
    const subject = cleanString(record.subject, 500)
    const timestamp = new Date(String(record.committedAt || ''))
    if (!GIT_COMMIT_PATTERN.test(commit) || !subject || Number.isNaN(timestamp.getTime())) {
      throw invalidInput('Git feedback history requires commit, committedAt, and subject')
    }
    const id = `feedback-git-${commit}`
    const storagePath = reportPath(dir, id)
    try {
      await fs.access(storagePath)
      result.skipped += 1
      continue
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    const committedAt = timestamp.toISOString()
    const message = cleanString(
      `历史问题回填：用户曾反馈与此修复相关的问题，现已完成处理。\n\nGit 修复记录：${subject}\n提交：${commit.slice(0, 12)}`,
      8000,
    )
    const report = {
      id,
      createdAt: committedAt,
      updatedAt: committedAt,
      resolvedAt: committedAt,
      status: 'resolved',
      kind: 'bug',
      severity: historicalSeverity(subject),
      title: historicalTitle(subject),
      message,
      messagePreview: message.slice(0, 180),
      contact: '',
      context: sanitizeContext({
        source: 'git-history',
        sourceCommit: commit,
        sourceSubject: subject,
        historicalBackfill: 'true',
        visibility: 'title-only',
        timestampBasis: 'fix-commit-time',
      }),
      attachments: [],
      statusHistory: [
        { status: 'open', at: committedAt },
        { status: 'resolved', at: committedAt },
      ],
    }
    await writeReport(dir, report)
    result.created += 1
    result.ids.push(id)
  }
  return result
}

async function persistAttachments(input, options) {
  const descriptors = Array.isArray(input?.attachmentPaths)
    ? input.attachmentPaths
    : []
  if (descriptors.length > MAX_ATTACHMENTS) {
    throw invalidInput(`A feedback report can include at most ${MAX_ATTACHMENTS} images`)
  }
  if (!descriptors.length) return []

  const targetDir = attachmentDir(options.dir, options.reportId)
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
  const attachments = []
  try {
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        throw invalidInput('Invalid feedback attachment descriptor')
      }
      const sourcePath = String(descriptor.path || '').trim()
      if (!sourcePath) throw invalidInput('Feedback attachment path is required')
      const stat = await fs.stat(sourcePath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
        throw invalidInput('Feedback images must be non-empty files no larger than 5 MB')
      }
      const buffer = await fs.readFile(sourcePath)
      const detected = detectImage(buffer)
      if (!detected) {
        throw invalidInput('Feedback attachments must be PNG, JPEG, GIF, or WebP images')
      }
      const id = `image-${index + 1}-${randomBytes(4).toString('hex')}`
      const fileName = `${id}.${detected.extension}`
      const originalName = cleanString(
        path.basename(String(descriptor.name || fileName)),
        180,
      ) || fileName
      await fs.writeFile(path.join(targetDir, fileName), buffer, { mode: 0o600 })
      attachments.push({
        id,
        name: originalName,
        mimeType: detected.mimeType,
        size: buffer.length,
        fileName,
      })
    }
    return attachments
  } catch (error) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function reportId(now) {
  return `feedback-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 17)}-${randomBytes(3).toString('hex')}`
}

async function createFeedbackReport(input, options = {}) {
  const now = options.now ? options.now() : new Date()
  const dir = options.dir || process.env.MATOS_FEEDBACK_DIR || '/workspace/group/logs/feedback'
  await fs.mkdir(dir, { recursive: true })
  const message = cleanString(input?.message, 8000)
  const id = reportId(now)
  const attachments = await persistAttachments(input, { dir, reportId: id })
  const report = {
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    resolvedAt: null,
    status: 'open',
    kind: cleanString(input?.kind || 'bug', 40) || 'bug',
    severity: cleanString(input?.severity || 'normal', 40) || 'normal',
    title: cleanString(input?.title || 'Untitled feedback', 200) || 'Untitled feedback',
    message,
    messagePreview: message.slice(0, 180),
    contact: cleanString(input?.contact, 200),
    context: sanitizeContext(input?.context),
    attachments,
    statusHistory: [{ status: 'open', at: now.toISOString() }],
  }
  try {
    const storagePath = await writeReport(dir, report)
    return { ...report, storagePath }
  } catch (error) {
    await fs.rm(attachmentDir(dir, id), { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function listFeedbackReports(options = {}) {
  const dir = options.dir || process.env.MATOS_FEEDBACK_DIR || '/workspace/group/logs/feedback'
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const results = await Promise.allSettled(
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(async entry => {
        const raw = await fs.readFile(path.join(dir, entry.name), 'utf8')
        const report = JSON.parse(raw)
        if (
          !report ||
          typeof report !== 'object' ||
          Array.isArray(report) ||
          !REPORT_ID_PATTERN.test(String(report.id || '')) ||
          entry.name !== `${report.id}.json` ||
          !String(report.title || '').trim() ||
          !FEEDBACK_STATUSES.has(String(report.status || '')) ||
          !Number.isFinite(Date.parse(String(report.createdAt || '')))
        ) {
          throw invalidInput(`Invalid feedback record: ${entry.name}`)
        }
        return report
      }),
  )
  const reports = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  return reports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

async function updateFeedbackReportStatus(reportId, status, options = {}) {
  const dir = options.dir || process.env.MATOS_FEEDBACK_DIR || '/workspace/group/logs/feedback'
  const id = safeReportId(reportId)
  const nextStatus = String(status || '').trim().toLowerCase()
  if (!FEEDBACK_STATUSES.has(nextStatus)) {
    throw invalidInput(`Unsupported feedback status: ${nextStatus || '(empty)'}`)
  }
  const now = options.now ? options.now() : new Date()
  const storagePath = reportPath(dir, id)
  const report = JSON.parse(await fs.readFile(storagePath, 'utf8'))
  report.status = nextStatus
  report.updatedAt = now.toISOString()
  if (nextStatus === 'resolved' || nextStatus === 'closed') {
    report.resolvedAt = report.resolvedAt || now.toISOString()
  } else {
    report.resolvedAt = null
  }
  const history = Array.isArray(report.statusHistory) ? report.statusHistory : []
  report.statusHistory = [
    ...history,
    { status: nextStatus, at: now.toISOString() },
  ].slice(-50)
  await writeReport(dir, report)
  return { ...report, storagePath }
}

async function readFeedbackAttachment(reportId, attachmentId, options = {}) {
  const dir = options.dir || process.env.MATOS_FEEDBACK_DIR || '/workspace/group/logs/feedback'
  const id = safeReportId(reportId)
  const targetId = safeAttachmentId(attachmentId)
  const report = JSON.parse(await fs.readFile(reportPath(dir, id), 'utf8'))
  const attachments = Array.isArray(report.attachments) ? report.attachments : []
  const attachment = attachments.find(item => item && item.id === targetId)
  if (!attachment) {
    const error = new Error('Feedback attachment not found')
    error.code = 'ENOENT'
    throw error
  }
  const fileName = String(attachment.fileName || '')
  if (!fileName || path.basename(fileName) !== fileName) {
    throw invalidInput('Invalid feedback attachment metadata')
  }
  const buffer = await fs.readFile(path.join(attachmentDir(dir, id), fileName))
  return {
    id: targetId,
    name: cleanString(attachment.name || fileName, 180),
    mimeType: String(attachment.mimeType || 'application/octet-stream'),
    size: buffer.length,
    buffer,
  }
}

module.exports = {
  createFeedbackReport,
  importGitFeedbackHistory,
  listFeedbackReports,
  readFeedbackAttachment,
  updateFeedbackReportStatus,
}
