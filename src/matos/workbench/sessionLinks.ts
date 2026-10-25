import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMatOSSessionsDir } from '../sessions/sessionPaths.js'

export type MatOSWorkbenchResumeLink = {
  source: 'matos-session-events'
  matosSessionId: string
  upstreamSessionId: string
  command: string
  argv: string[]
  eventType?: string
  eventId?: string
  timestamp?: string
  roleRef?: string
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resumeCommand(argv: string[]): string {
  const [command, ...args] = argv
  return [command, ...args.map(shellArg)].filter(Boolean).join(' ')
}

export function stableProjectChatSessionIds(input: {
  projectId: string
  conversationId: string
  topicId?: string
  areaId?: string
  roleRef: string
  memberId: string
}): { sessionId: string; traceId: string } {
  const digest = createHash('sha256')
    .update([
      input.projectId,
      input.conversationId,
      input.topicId ?? '',
      input.areaId ?? '',
      roleIdentity(input.roleRef),
      input.memberId,
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 24)
  return {
    sessionId: `project-chat-${digest}`,
    traceId: `trace-project-chat-${digest}`,
  }
}

function roleIdentity(roleRef: string): string {
  return roleRef.trim().split('@')[0] ?? roleRef.trim()
}

export function buildMatOSResumeLink(input: {
  matosSessionId: string
  upstreamSessionId: string
  roleRef?: string
  eventType?: string
  eventId?: string
  timestamp?: string
}): MatOSWorkbenchResumeLink {
  const argv = [
    'matos',
    ...(input.roleRef ? ['--role', input.roleRef] : []),
    '--resume',
    input.upstreamSessionId,
  ]
  return {
    source: 'matos-session-events',
    matosSessionId: input.matosSessionId,
    upstreamSessionId: input.upstreamSessionId,
    command: resumeCommand(argv),
    argv,
    ...(input.eventType ? { eventType: input.eventType } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(input.roleRef ? { roleRef: input.roleRef } : {}),
  }
}

function sessionEventsPath(input: {
  cwd: string
  env?: Record<string, string | undefined>
  sessionId: string
}): string {
  const configuredDir = stringValue(input.env?.MATOS_SESSION_DIR)
  const dir = configuredDir ?? resolveMatOSSessionsDir(input.cwd)
  return join(dir, `${input.sessionId}.jsonl`)
}

export async function latestMatOSResumeLinkFromSessionEvents(input: {
  cwd: string
  env?: Record<string, string | undefined>
  matosSessionId?: string
  roleRef?: string
}): Promise<MatOSWorkbenchResumeLink | undefined> {
  const matosSessionId = stringValue(input.matosSessionId)
  if (!matosSessionId) {
    return undefined
  }

  let text = ''
  try {
    text = await readFile(
      sessionEventsPath({
        cwd: input.cwd,
        env: input.env,
        sessionId: matosSessionId,
      }),
      'utf8',
    )
  } catch {
    return undefined
  }

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = objectValue(JSON.parse(lines[index]!))
      const data = objectValue(event?.data)
      const upstreamSessionId = stringValue(data?.upstreamSessionId)
      if (!event || !upstreamSessionId) {
        continue
      }
      if (input.roleRef) {
        const eventRoleRef = stringValue(event.roleRef) ?? stringValue(data?.roleRef)
        if (!eventRoleRef || roleIdentity(eventRoleRef) !== roleIdentity(input.roleRef)) {
          continue
        }
      }
      return buildMatOSResumeLink({
        matosSessionId,
        upstreamSessionId,
        roleRef: input.roleRef,
        eventType: stringValue(event.type),
        eventId: stringValue(event.id),
        timestamp: stringValue(event.timestamp),
      })
    } catch {
      continue
    }
  }

  return undefined
}
