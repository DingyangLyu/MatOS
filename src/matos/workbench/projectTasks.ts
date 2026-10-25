import { randomUUID } from 'node:crypto'
import { appendFile,mkdir,readFile,rename,rm,writeFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
import * as lockfile from 'proper-lockfile'
import { readMatOSProjectMetadata } from '../projectMetadata.js'
import type { MatOSWorkbenchContext } from './types.js'

export type MatOSProjectTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type MatOSProjectTask = {
  taskId: string
  projectId: string
  conversationId: string
  roleRef: string
  memberId?: string
  prompt: string
  status: MatOSProjectTaskStatus
  runId?: string
  sourceMessageId?: string
  relayHop: number
  error?: string
  createdAt: string
  updatedAt: string
}

type MatOSProjectTaskEvent = {
  eventId: string
  eventType: 'task.created' | 'task.updated'
  createdAt: string
  task: MatOSProjectTask
}

const TASK_EVENTS_RELATIVE_PATH = join('.matos', 'workbench', 'project-tasks.jsonl')

function taskEventsPath(cwd: string): string {
  return join(cwd, TASK_EVENTS_RELATIVE_PATH)
}

function taskLockAnchor(cwd: string): string {
  return join(cwd, '.matos', 'workbench', 'project-tasks')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function validStatus(value: unknown): value is MatOSProjectTaskStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' ||
    value === 'failed' || value === 'canceled'
}

function roleIdentity(value: string): string {
  return value.trim().split('@')[0] ?? value.trim()
}

function memberIdForRoleRef(roleRef: string): string {
  const tail = roleIdentity(roleRef).split(':').pop() ?? 'agent'
  const slug = tail.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `agent-${slug || 'agent'}`
}

function assertTaskId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new Error(`Invalid MatOS project task id: ${value}`)
  }
  return value
}

function assertTaskMemberId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid MatOS project member id: ${value}`)
  }
  return value
}

function projectTeam(metadata: Record<string, unknown>): Array<{
  memberId: string
  roleRef: string
}> {
  if (!Array.isArray(metadata.team)) return []
  return metadata.team.flatMap(item => {
    const record = typeof item === 'string'
      ? { roleRef: item }
      : item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {}
    const roleRef = stringValue(record.roleRef) ?? stringValue(record.role_ref)
    if (!roleRef) return []
    const memberId = assertTaskMemberId(
      stringValue(record.memberId) ?? stringValue(record.member_id) ??
        memberIdForRoleRef(roleRef),
    )
    return [{ memberId, roleRef }]
  })
}

function assertTaskMember(input: {
  metadata: Record<string, unknown>
  roleRef: string
  memberId?: string
}): { roleRef: string; memberId?: string } {
  const roleRef = stringValue(input.roleRef)
  if (!roleRef || !roleIdentity(roleRef).startsWith('role:')) {
    throw new Error(`Invalid MatOS project task role: ${input.roleRef}`)
  }
  const team = projectTeam(input.metadata)
  if (team.length === 0) {
    return {
      roleRef,
      ...(input.memberId ? { memberId: assertTaskMemberId(input.memberId) } : {}),
    }
  }
  const member = input.memberId
    ? team.find(candidate => candidate.memberId === input.memberId)
    : team.find(candidate => roleIdentity(candidate.roleRef) === roleIdentity(roleRef))
  if (!member) {
    throw new Error(`MatOS project task role is not a project member: ${roleRef}`)
  }
  if (roleIdentity(member.roleRef) !== roleIdentity(roleRef)) {
    throw new Error(`MatOS project member '${member.memberId}' is not bound to ${roleRef}`)
  }
  return { roleRef: member.roleRef, memberId: member.memberId }
}

const TASK_TRANSITIONS: Record<MatOSProjectTaskStatus, ReadonlySet<MatOSProjectTaskStatus>> = {
  queued: new Set(['queued', 'running', 'failed', 'canceled']),
  running: new Set(['running', 'queued', 'succeeded', 'failed', 'canceled']),
  succeeded: new Set(['succeeded']),
  failed: new Set(['failed']),
  canceled: new Set(['canceled']),
}

async function withTaskLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const anchor = taskLockAnchor(cwd)
  await mkdir(dirname(anchor), { recursive: true })
  await writeFile(anchor, '', { flag: 'a', mode: 0o600 })
  const release = await lockfile.lock(anchor, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
  })
  try {
    return await run()
  } finally {
    await release()
  }
}

async function repairTaskLedgerTail(cwd: string, lines: string[]): Promise<void> {
  const path = taskEventsPath(cwd)
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(temporaryPath, lines.length ? `${lines.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function readTaskEvents(
  cwd: string,
  options: { repairTornTail?: boolean } = {},
): Promise<MatOSProjectTaskEvent[]> {
  let text = ''
  try {
    text = await readFile(taskEventsPath(cwd), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  const hasTerminatingNewline = text.endsWith('\n')
  let lastNonEmptyIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      lastNonEmptyIndex = index
      break
    }
  }
  const events: MatOSProjectTaskEvent[] = []
  const validLines: string[] = []
  let repairedTail = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      if (index === lastNonEmptyIndex && !hasTerminatingNewline) {
        if (options.repairTornTail) {
          await repairTaskLedgerTail(cwd, validLines)
          repairedTail = true
        }
        break
      }
      throw new Error(
        `Invalid MatOS project task ledger at ${taskEventsPath(cwd)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    validLines.push(line)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid MatOS project task record at ${taskEventsPath(cwd)}`)
    }
    const event = parsed as MatOSProjectTaskEvent
    if (!event.task?.taskId || !validStatus(event.task.status)) {
      throw new Error(`Invalid MatOS project task record at ${taskEventsPath(cwd)}`)
    }
    events.push(event)
  }
  if (
    options.repairTornTail &&
    !repairedTail &&
    !hasTerminatingNewline &&
    lastNonEmptyIndex >= 0
  ) {
    await repairTaskLedgerTail(cwd, validLines)
  }
  return events
}

function reduceTasks(events: MatOSProjectTaskEvent[]): MatOSProjectTask[] {
  const tasks = new Map<string, MatOSProjectTask>()
  for (const event of events) tasks.set(event.task.taskId, event.task)
  return [...tasks.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export async function listMatOSProjectTasks(input: MatOSWorkbenchContext & {
  conversationId?: string
  status?: MatOSProjectTaskStatus
}): Promise<{ mode: 'matos-project-tasks'; tasks: MatOSProjectTask[] }> {
  return withTaskLock(input.cwd, async () => {
    const tasks = reduceTasks(await readTaskEvents(input.cwd, { repairTornTail: true }))
      .filter(task => !input.conversationId || task.conversationId === input.conversationId)
      .filter(task => !input.status || task.status === input.status)
    return { mode: 'matos-project-tasks', tasks }
  })
}

export async function createMatOSProjectTask(input: MatOSWorkbenchContext & {
  taskId?: string
  conversationId: string
  roleRef: string
  memberId?: string
  prompt: string
  sourceMessageId?: string
  relayHop?: number
}): Promise<{ mode: 'matos-project-task-create'; task: MatOSProjectTask }> {
  return withTaskLock(input.cwd, async () => {
    const metadata = await readMatOSProjectMetadata(input.cwd)
    const projectId = stringValue(metadata.id)
    if (!projectId) throw new Error(`MatOS project metadata has no id: ${input.cwd}`)
    const conversationId = stringValue(input.conversationId)
    const prompt = stringValue(input.prompt)
    if (!conversationId) throw new Error('MatOS project task requires a conversation id')
    if (!prompt) throw new Error('MatOS project task requires a prompt')
    if (prompt.length > 32_000) throw new Error('MatOS project task prompt exceeds 32 000 characters')
    const binding = assertTaskMember({
      metadata,
      roleRef: input.roleRef,
      memberId: input.memberId,
    })
    const taskId = assertTaskId(stringValue(input.taskId) ?? `task-${randomUUID()}`)
    const sourceMessageId = stringValue(input.sourceMessageId)
    const relayHop = Number.isInteger(input.relayHop)
      ? Math.max(0, Math.min(8, Number(input.relayHop)))
      : 0
    const existing = reduceTasks(await readTaskEvents(input.cwd, { repairTornTail: true }))
      .find(task => task.taskId === taskId)
    if (existing) {
      if (
        existing.projectId !== projectId ||
        existing.conversationId !== conversationId ||
        roleIdentity(existing.roleRef) !== roleIdentity(binding.roleRef) ||
        existing.memberId !== binding.memberId ||
        existing.prompt !== prompt ||
        existing.sourceMessageId !== sourceMessageId ||
        existing.relayHop !== relayHop
      ) {
        throw new Error(`MatOS project task id collision: ${taskId}`)
      }
      return { mode: 'matos-project-task-create', task: existing }
    }
    const now = new Date().toISOString()
    const task: MatOSProjectTask = {
      taskId,
      projectId,
      conversationId,
      roleRef: binding.roleRef,
      ...(binding.memberId ? { memberId: binding.memberId } : {}),
      prompt,
      status: 'queued',
      ...(sourceMessageId ? { sourceMessageId } : {}),
      relayHop,
      createdAt: now,
      updatedAt: now,
    }
    const event: MatOSProjectTaskEvent = {
      eventId: `task-event-${randomUUID()}`,
      eventType: 'task.created',
      createdAt: now,
      task,
    }
    await appendFile(taskEventsPath(input.cwd), `${JSON.stringify(event)}\n`, 'utf8')
    return { mode: 'matos-project-task-create', task }
  })
}

export async function updateMatOSProjectTask(input: MatOSWorkbenchContext & {
  taskId: string
  status: MatOSProjectTaskStatus
  runId?: string | null
  error?: string | null
}): Promise<{ mode: 'matos-project-task-update'; task: MatOSProjectTask }> {
  return withTaskLock(input.cwd, async () => {
    const current = reduceTasks(await readTaskEvents(input.cwd, { repairTornTail: true }))
      .find(task => task.taskId === input.taskId)
    if (!current) throw new Error(`MatOS project task not found: ${input.taskId}`)
    if (!TASK_TRANSITIONS[current.status].has(input.status)) {
      throw new Error(
        `Invalid MatOS project task transition: ${current.status} -> ${input.status}`,
      )
    }
    const hasRunId = Object.prototype.hasOwnProperty.call(input, 'runId')
    const nextRunId = hasRunId
      ? input.runId === null ? undefined : stringValue(input.runId)
      : current.runId
    const hasError = Object.prototype.hasOwnProperty.call(input, 'error')
    const nextError = hasError
      ? input.error === null ? undefined : stringValue(input.error)
      : input.status === 'queued'
        ? current.error
        : undefined
    if (
      current.status === input.status &&
      current.runId === nextRunId &&
      current.error === nextError
    ) {
      return { mode: 'matos-project-task-update', task: current }
    }
    const now = new Date().toISOString()
    const { runId: _previousRunId, error: _previousError, ...base } = current
    const task: MatOSProjectTask = {
      ...base,
      status: input.status,
      ...(nextRunId ? { runId: nextRunId } : {}),
      ...(nextError ? { error: nextError } : { error: undefined }),
      updatedAt: now,
    }
    const event: MatOSProjectTaskEvent = {
      eventId: `task-event-${randomUUID()}`,
      eventType: 'task.updated',
      createdAt: now,
      task,
    }
    await appendFile(taskEventsPath(input.cwd), `${JSON.stringify(event)}\n`, 'utf8')
    return { mode: 'matos-project-task-update', task }
  })
}
