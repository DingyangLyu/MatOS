import {
  listMatOSWorkbenchProjectTimeline,
  sendMatOSWorkbenchProjectMessage,
  syncMatOSWorkbenchProjectConversations,
  syncMatOSWorkbenchProjectGroup,
} from '../workbench/projectGroups.js'
import { createMatOSProjectTask, updateMatOSProjectTask } from '../workbench/projectTasks.js'
import type { MatOSWorkbenchProjectTimelineEvent } from '../workbench/types.js'
import {
  context,
  objectValue,
  writeResult,
  type ParsedWorkbenchArgs,
  type WorkbenchIO,
} from './workbenchCliShared.js'

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string'
    ? (value as string | null)
    : undefined
}

/** Project-group bridge used by the web daemon (sync, tasks, timeline, messages). */
export async function projectsCommand(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
): Promise<number> {
  const subcommand = parsed.positionals[1]
  if (subcommand === 'sync') {
    if (!parsed.payloadJson) {
      io.stderr('Usage: matos workbench projects sync --payload-json <project-json> [--json]\n')
      return 1
    }
    let request: Record<string, unknown>
    try {
      request = objectValue(JSON.parse(parsed.payloadJson) as unknown) ?? {}
    } catch (error) {
      io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    const id = typeof request.id === 'string' ? request.id : ''
    const name = typeof request.name === 'string' ? request.name : ''
    return writeResult(parsed, io, await syncMatOSWorkbenchProjectGroup({
      ...context(parsed, io),
      id,
      name,
      description: typeof request.description === 'string' ? request.description : undefined,
      goal: typeof request.goal === 'string' ? request.goal : undefined,
      members: Array.isArray(request.members)
        ? request.members.filter((value): value is string => typeof value === 'string')
        : undefined,
      team: Array.isArray(request.team)
        ? request.team.filter((value): value is Record<string, unknown> =>
            Boolean(value) && typeof value === 'object' && !Array.isArray(value))
        : undefined,
      memberBriefs: objectValue(request.memberBriefs) as Record<string, string> | undefined,
      memberNames: objectValue(request.memberNames) as Record<string, string> | undefined,
      assetRefs: Array.isArray(request.assetRefs)
        ? request.assetRefs.filter((value): value is string => typeof value === 'string')
        : undefined,
      // Native sync validates this value; do not silently discard a misspelled
      // policy and accidentally unlock a reproducibility project.
      assetVersionPolicy: request.assetVersionPolicy as 'follow-accepted' | 'pinned' | undefined,
      expectedRevision: Number.isInteger(request.expectedRevision)
        ? Number(request.expectedRevision)
        : undefined,
    }))
  }
  if (subcommand === 'task-create') {
    if (!parsed.payloadJson) {
      io.stderr('Usage: matos workbench projects task-create --payload-json <task-json> [--json]\n')
      return 1
    }
    let request: Record<string, unknown>
    try {
      request = objectValue(JSON.parse(parsed.payloadJson) as unknown) ?? {}
    } catch (error) {
      io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    const conversationId = typeof request.conversationId === 'string' ? request.conversationId : ''
    const roleRef = typeof request.roleRef === 'string' ? request.roleRef : ''
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    if (!conversationId || !roleRef || !prompt) {
      io.stderr('task-create requires conversationId, roleRef, and prompt\n')
      return 1
    }
    return writeResult(parsed, io, await createMatOSProjectTask({
      ...context(parsed, io),
      taskId: typeof request.taskId === 'string' ? request.taskId : undefined,
      conversationId,
      roleRef,
      memberId: typeof request.memberId === 'string' ? request.memberId : undefined,
      prompt,
      sourceMessageId: typeof request.sourceMessageId === 'string' ? request.sourceMessageId : undefined,
      relayHop: Number.isInteger(request.relayHop) ? Number(request.relayHop) : undefined,
    }))
  }
  if (subcommand === 'task-update') {
    const taskId = parsed.targetId ?? parsed.positionals[2]
    if (!taskId || !parsed.payloadJson) {
      io.stderr('Usage: matos workbench projects task-update <task-id> --payload-json <status-json> [--json]\n')
      return 1
    }
    let request: Record<string, unknown>
    try {
      request = objectValue(JSON.parse(parsed.payloadJson) as unknown) ?? {}
    } catch (error) {
      io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    const status = typeof request.status === 'string' ? request.status : ''
    if (!['queued', 'running', 'succeeded', 'failed', 'canceled'].includes(status)) {
      io.stderr('task-update requires a valid status\n')
      return 1
    }
    return writeResult(parsed, io, await updateMatOSProjectTask({
      ...context(parsed, io),
      taskId,
      status: status as 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled',
      runId: nullableString(request.runId),
      error: nullableString(request.error),
    }))
  }
  if (subcommand === 'send') {
    let refs: MatOSWorkbenchProjectTimelineEvent['refs'] | undefined
    let payload: Record<string, unknown> | undefined
    if (parsed.payloadJson) {
      try {
        payload = objectValue(JSON.parse(parsed.payloadJson) as unknown)
        const requestedRefs = objectValue(payload?.refs)
        if (requestedRefs) {
          refs = requestedRefs as MatOSWorkbenchProjectTimelineEvent['refs']
        }
      } catch (error) {
        io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }
    return writeResult(parsed, io, await sendMatOSWorkbenchProjectMessage({
      ...context(parsed, io),
      projectId: parsed.projectId ?? parsed.positionals[2],
      conversationId: parsed.conversationId,
      topicId: parsed.topicId,
      areaId: parsed.areaId,
      senderKind: parsed.kind === 'agent' || parsed.kind === 'system' ? parsed.kind : 'human',
      senderId: parsed.targetId,
      memberId: parsed.memberId,
      roleRef: parsed.roleRef,
      text: parsed.message ?? parsed.positionals.slice(3).join(' '),
      eventId: typeof payload?.eventId === 'string' ? payload.eventId : undefined,
      createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : undefined,
      ...(refs ? { refs } : {}),
    }))
  }
  if (subcommand === 'timeline') {
    return writeResult(parsed, io, await listMatOSWorkbenchProjectTimeline({
      ...context(parsed, io),
      projectId: parsed.projectId ?? parsed.positionals[2],
      conversationId: parsed.conversationId,
      topicId: parsed.topicId,
      areaId: parsed.areaId,
      limit: parsed.limit,
      offset: parsed.offset,
    }))
  }
  if (subcommand === 'conversation-sync') {
    if (!parsed.payloadJson) {
      io.stderr('Usage: matos workbench projects conversation-sync --payload-json <json> [--json]\n')
      return 1
    }
    try {
      const payload = objectValue(JSON.parse(parsed.payloadJson) as unknown) ?? {}
      const conversations = Array.isArray(payload.conversations)
        ? payload.conversations.filter((value): value is Record<string, unknown> =>
            Boolean(value) && typeof value === 'object' && !Array.isArray(value))
          .map(record => ({
            id: typeof record.id === 'string' ? record.id : '',
            title: record.title === null
              ? null
              : typeof record.title === 'string' ? record.title : undefined,
            roleRef: record.roleRef === null
              ? null
              : typeof record.roleRef === 'string' ? record.roleRef : undefined,
            memberRefs: Array.isArray(record.memberRefs)
              ? record.memberRefs.filter((value): value is string => typeof value === 'string')
              : [],
            ...(record.createdAt !== undefined ? { createdAt: String(record.createdAt) } : {}),
            ...(record.updatedAt !== undefined ? { updatedAt: String(record.updatedAt) } : {}),
          }))
        : []
      return writeResult(parsed, io, await syncMatOSWorkbenchProjectConversations({
        ...context(parsed, io),
        conversations,
        expectedRevision: Number.isInteger(payload.expectedRevision)
          ? Number(payload.expectedRevision)
          : undefined,
      }))
    } catch (error) {
      io.stderr(`Invalid conversation sync payload: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  io.stderr('Usage: matos workbench projects sync|task-create|task-update|send|timeline|conversation-sync [--json]\n')
  return 1
}
