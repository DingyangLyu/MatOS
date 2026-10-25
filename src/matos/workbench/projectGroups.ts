import { createHash,randomUUID } from 'node:crypto'
import { appendFile,mkdir,open,readFile,rename,rm,stat,writeFile } from 'node:fs/promises'
import { basename,join,relative,resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as lockfile from 'proper-lockfile'
import {
getDefaultMatOSConfig,
getMatOSConfigPath,
getMatOSDir,
getMatOSSessionsDir,
} from '../project.js'
import { matOSProjectAssetRefs } from '../projectAssets.js'
import {
ensureMatOSProjectInternalGitignore,
mutateMatOSProjectMetadata,
readMatOSProjectMetadata,
type MatOSProjectMetadata as ProjectMetadata,
} from '../projectMetadata.js'
import { listMatOSWorkbenchProjects } from './projectCatalog.js'
import { slugSegment } from './projectShared.js'
import {
prepareMatOSWorkbenchRoleDebugRun,
resolveMatOSWorkbenchRoleSummaries,
resolveMatOSWorkbenchRoleSummaryResolution
} from './roles.js'
import {
latestMatOSResumeLinkFromSessionEvents,
stableProjectChatSessionIds,
} from './sessionLinks.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchProjectArea,
MatOSWorkbenchProjectChatSubmitResult,
MatOSWorkbenchProjectConversation,
MatOSWorkbenchProjectGroup,
MatOSWorkbenchProjectGroupMutation,
MatOSWorkbenchProjectListItem,
MatOSWorkbenchProjectMember,
MatOSWorkbenchProjectMessageSendResult,
MatOSWorkbenchProjectTimeline,
MatOSWorkbenchProjectTimelineEvent,
} from './types.js'

const PROJECT_METADATA_RELATIVE_PATH = join('.matos', 'project.json')
const PROJECT_GROUP_EVENTS_RELATIVE_PATH = join('.matos', 'workbench', 'project-events.jsonl')

type ProjectSelection = {
  project: MatOSWorkbenchProjectListItem
  metadata: ProjectMetadata
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(
        value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(item => item.trim()),
      )]
    : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, text]) => [key, text.trim()])
      .filter(([, text]) => text.length > 0),
  )
}

function roleResolutionWarningsFromMetadata(
  value: unknown,
): NonNullable<MatOSWorkbenchProjectGroup['profile']['roleResolutionWarnings']> {
  if (!Array.isArray(value)) return []
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map(record => ({
      code: stringValue(record.code) ?? 'role_asset_fallback',
      requestedRoleRef: stringValue(record.requestedRoleRef) ?? '',
      fallbackRoleRef: stringValue(record.fallbackRoleRef) ?? '',
      message: stringValue(record.message) ?? '',
    }))
    .filter(item => item.requestedRoleRef && item.fallbackRoleRef && item.message)
}

function memberIdForRoleRef(roleRef: string): string {
  const tail = roleRef.split(':').pop()?.split('@')[0] ?? roleRef
  return `agent-${slugSegment(tail, 'agent')}`
}

function assertProjectMemberId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid MatOS project member id: ${value}`)
  }
  return value
}

function projectMemberKind(value: unknown): MatOSWorkbenchProjectMember['kind'] {
  const kind = stringValue(value)
  return kind === 'human' || kind === 'agent' || kind === 'service' ||
      kind === 'workflow' || kind === 'external'
    ? kind
    : 'agent'
}

function roleIdentity(roleRef: string): string {
  return roleRef.trim().split('@')[0] ?? roleRef.trim()
}

function memberForRoleRef(
  group: MatOSWorkbenchProjectGroup,
  roleRef: string,
): MatOSWorkbenchProjectMember | undefined {
  const identity = roleIdentity(roleRef)
  return group.members.find(member =>
    member.roleRef ? roleIdentity(member.roleRef) === identity : false,
  )
}

// In cross-user shared projects, human messages must carry the acting user's
// own member identity. The workspace runtime exports the caller's scope ref
// as MATOS_SCOPE_ID; match it against the human members recorded in the
// project metadata (userId is the member's scope ref).
function humanMemberForScope(
  group: MatOSWorkbenchProjectGroup,
  input: { scopeRef?: string; env?: Record<string, string | undefined> },
): MatOSWorkbenchProjectMember | undefined {
  const scopeRef = (
    input.scopeRef ??
    input.env?.MATOS_SCOPE_ID ??
    process.env.MATOS_SCOPE_ID
  )?.trim()
  if (!scopeRef) {
    return undefined
  }
  return group.members.find(
    member => member.kind === 'human' && member.userId === scopeRef,
  )
}

function stableEventId(seed: string): string {
  return `evt-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

function defaultRoleRefForProjectChat(input: {
  roleRef?: string
  areaId?: string
  group: MatOSWorkbenchProjectGroup
}): string {
  const requested = stringValue(input.roleRef)
  if (requested) {
    return requested
  }
  const areaRole = input.areaId
    ? input.group.areas.find(area => area.areaId === input.areaId)?.defaultRoleRef
    : undefined
  if (areaRole) {
    return areaRole
  }
  const firstMemberRole = input.group.members.find(member => member.roleRef)?.roleRef
  if (firstMemberRole) {
    return firstMemberRole
  }
  return input.group.project.team.agents[0]?.roleRef ?? 'role:compute'
}

function projectChatPrompt(input: {
  group: MatOSWorkbenchProjectGroup
  timeline: MatOSWorkbenchProjectTimeline
  message: string
  roleRef: string
  latestEventId?: string
}): string {
  const recentEvents = input.timeline.events
    .filter(event => event.eventId !== input.latestEventId)
    .slice(-12)
  const eventLines = recentEvents.map(event => {
    const role = event.sender.roleRef ? ` ${event.sender.roleRef}` : ''
    return `- ${event.createdAt} ${event.sender.kind}${role}: ${event.text}`
  })
  const memberBrief =
    input.group.profile.memberBriefs[input.roleRef] ??
    input.group.profile.memberBriefs[roleIdentity(input.roleRef)]
  return [
    'You are replying inside MatOS Project Chat.',
    '',
    'Use the native MatOS role, mounted assets, skills, tools, and project context available to you. Answer the latest user message as the selected project agent. If you need to run tools, do so through the normal MatOS runtime and keep the reply concise enough for a chat timeline.',
    '',
    `Project: ${input.group.project.name} (${input.group.project.id})`,
    `Project cwd: ${input.group.project.cwd}`,
    `Conversation: ${input.timeline.conversationId}`,
    input.timeline.topicId ? `Topic: ${input.timeline.topicId}` : '',
    input.timeline.areaId ? `Area: ${input.timeline.areaId}` : '',
    `Selected role: ${input.roleRef}`,
    input.group.profile.goal ? `Project goal: ${input.group.profile.goal}` : '',
    memberBrief ? `Selected member responsibility: ${memberBrief}` : '',
    'Shared project files are discoverable on demand. Read only task-relevant files instead of loading the whole project tree into context.',
    input.group.assetRefs.length ? `Project assets: ${input.group.assetRefs.join(', ')}` : 'Project assets: none',
    input.group.workflowRefs.length ? `Project workflows: ${input.group.workflowRefs.join(', ')}` : 'Project workflows: none',
    '',
    'Recent project timeline:',
    eventLines.length ? eventLines.join('\n') : '- no prior project messages',
    '',
    'Latest user message:',
    input.message,
  ].filter(Boolean).join('\n')
}

function normalizeProjectAreaKind(value: unknown): MatOSWorkbenchProjectArea['kind'] {
  const text = stringValue(value)
  const allowed = new Set<MatOSWorkbenchProjectArea['kind']>([
    'discussion',
    'planning',
    'agent-run',
    'workflow',
    'assets',
    'compute',
    'paper',
    'incident',
    'custom',
  ])
  return text && allowed.has(text as MatOSWorkbenchProjectArea['kind'])
    ? text as MatOSWorkbenchProjectArea['kind']
    : 'custom'
}

function teamEntries(metadata: ProjectMetadata): Array<Record<string, unknown>> {
  return Array.isArray(metadata.team)
    ? metadata.team
        .map(item => typeof item === 'string' ? { roleRef: item } : item)
        .filter((item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function membersFromMetadata(
  metadata: ProjectMetadata,
  project: MatOSWorkbenchProjectListItem,
): MatOSWorkbenchProjectMember[] {
  const members = new Map<string, MatOSWorkbenchProjectMember>()
  const roles = new Map<string, string>()
  for (const record of teamEntries(metadata)) {
    const kind = projectMemberKind(record.kind)
    const roleRef =
      stringValue(record.roleRef) ??
      stringValue(record.role_ref) ??
      stringValue(record.ref) ??
      stringValue(record.role)
    const rawMemberId =
      stringValue(record.memberId) ??
      stringValue(record.member_id) ??
      (roleRef ? memberIdForRoleRef(roleRef) : undefined)
    if (!rawMemberId) {
      continue
    }
    const memberId = assertProjectMemberId(rawMemberId)
    const existingMember = members.get(memberId)
    if (
      existingMember?.roleRef &&
      roleRef &&
      roleIdentity(existingMember.roleRef) !== roleIdentity(roleRef)
    ) {
      throw new Error(`MatOS project member '${memberId}' is assigned to multiple roles`)
    }
    if (roleRef) {
      const identity = roleIdentity(roleRef)
      const existingRoleMember = roles.get(identity)
      if (existingRoleMember && existingRoleMember !== memberId) {
        throw new Error(`MatOS project role '${identity}' is assigned to multiple members`)
      }
      roles.set(identity, memberId)
    }
    members.set(memberId, {
      memberId,
      kind,
      displayName: stringValue(record.displayName) ?? stringValue(record.label) ?? stringValue(record.name) ?? roleRef ?? memberId,
      ...(roleRef ? { roleRef } : {}),
      ...(stringValue(record.userId) ?? stringValue(record.user_id)
        ? { userId: stringValue(record.userId) ?? stringValue(record.user_id) }
        : {}),
      source: stringValue(record.source) === 'explicit' ? 'explicit' : 'metadata',
      ...(Array.isArray(record.defaultTools) ? { defaultTools: arrayOfStrings(record.defaultTools) } : {}),
      ...(stringValue(record.runtimeRef) ?? stringValue(record.runtime_ref)
        ? { runtimeRef: stringValue(record.runtimeRef) ?? stringValue(record.runtime_ref) }
        : {}),
    })
  }
  for (const agent of project.team.agents) {
    const memberId = memberIdForRoleRef(agent.roleRef)
    const roleAlreadyRepresented = [...members.values()].some(member =>
      member.roleRef && roleIdentity(member.roleRef) === roleIdentity(agent.roleRef))
    if (!members.has(memberId) && !roleAlreadyRepresented) {
      members.set(memberId, {
        memberId,
        kind: 'agent',
        displayName: agent.label,
        roleRef: agent.roleRef,
        source: 'derived',
      })
    }
  }
  return [...members.values()].sort((left, right) => left.memberId.localeCompare(right.memberId))
}

function conversationsFromMetadata(metadata: ProjectMetadata): MatOSWorkbenchProjectConversation[] {
  const configured = Array.isArray(metadata.conversations) ? metadata.conversations : []
  const conversations = configured
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map(record => ({
      id: stringValue(record.id) ?? 'main',
      title: stringValue(record.title) ?? stringValue(record.name) ??
        stringValue(record.id) ?? 'Main',
      ...(stringValue(record.roleRef) ?? stringValue(record.role_ref)
        ? { roleRef: stringValue(record.roleRef) ?? stringValue(record.role_ref) }
        : {}),
      memberRefs: arrayOfStrings(record.memberRefs ?? record.member_refs),
      ...(stringValue(record.createdAt) ? { createdAt: stringValue(record.createdAt) } : {}),
      ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt) } : {}),
      topicCount: Number(record.topicCount ?? record.topic_count ?? 0),
      messageCount: Number(record.messageCount ?? record.message_count ?? 0),
    }))
  return conversations.length
    ? conversations
    : [{ id: 'main', title: 'Main', memberRefs: [], topicCount: 0, messageCount: 0 }]
}

function defaultProjectConversationId(
  metadata: ProjectMetadata,
  conversations: MatOSWorkbenchProjectConversation[],
): string {
  const configured = stringValue((metadata as Record<string, unknown>).defaultConversationId) ??
    stringValue((metadata as Record<string, unknown>).default_conversation_id)
  if (configured && conversations.some(conversation => conversation.id === configured)) {
    return configured
  }
  if (conversations.some(conversation => conversation.id === 'main')) {
    return 'main'
  }
  return conversations[0]?.id ?? 'main'
}

function areasFromMetadata(metadata: ProjectMetadata): MatOSWorkbenchProjectArea[] {
  const configured = Array.isArray(metadata.areas) ? metadata.areas : []
  return configured
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map(record => {
      const areaId = stringValue(record.areaId) ?? stringValue(record.area_id) ?? stringValue(record.id) ?? 'area'
      return {
        areaId,
        name: stringValue(record.name) ?? areaId,
        kind: normalizeProjectAreaKind(record.kind),
        ...(stringValue(record.defaultRoleRef) ?? stringValue(record.default_role_ref)
          ? { defaultRoleRef: stringValue(record.defaultRoleRef) ?? stringValue(record.default_role_ref) }
          : {}),
        defaultWorkflowRefs: arrayOfStrings(record.defaultWorkflowRefs ?? record.default_workflow_refs),
        defaultAssetRefs: arrayOfStrings(record.defaultAssetRefs ?? record.default_asset_refs),
        ...(stringValue(record.workspacePath) ?? stringValue(record.workspace_path)
          ? { workspacePath: stringValue(record.workspacePath) ?? stringValue(record.workspace_path) }
          : {}),
        ...(stringValue(record.createdAt) ? { createdAt: stringValue(record.createdAt) } : {}),
        ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt) } : {}),
      }
    })
}

function eventLogPath(cwd: string): string {
  return join(cwd, PROJECT_GROUP_EVENTS_RELATIVE_PATH)
}

async function withTimelineLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const workbenchDir = join(getMatOSDir(cwd), 'workbench')
  const anchor = join(workbenchDir, 'project-events')
  await mkdir(workbenchDir, { recursive: true })
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

async function repairTimelineTail(cwd: string, validLines: string[]): Promise<void> {
  const path = eventLogPath(cwd)
  const temporaryPath = `${path}.repair.${process.pid}.${randomUUID()}`
  try {
    await writeFile(
      temporaryPath,
      validLines.length > 0 ? `${validLines.join('\n')}\n` : '',
      { encoding: 'utf8', mode: 0o600 },
    )
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function readTimelineEventsUnlocked(
  cwd: string,
  options: { repairTornTail?: boolean } = {},
): Promise<MatOSWorkbenchProjectTimelineEvent[]> {
  let text = ''
  try {
    text = await readFile(eventLogPath(cwd), 'utf8')
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
  const events: MatOSWorkbenchProjectTimelineEvent[] = []
  const validLines: string[] = []
  let repairedTail = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      if (index === lastNonEmptyIndex && !hasTerminatingNewline) {
        if (options.repairTornTail) {
          await repairTimelineTail(cwd, validLines)
          repairedTail = true
        }
        break
      }
      throw new Error(
        `Invalid MatOS project timeline at ${eventLogPath(cwd)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid MatOS project timeline record at ${eventLogPath(cwd)}`)
    }
    const event = parsed as MatOSWorkbenchProjectTimelineEvent
    if (
      !event.eventId ||
      !event.projectId ||
      !event.conversationId ||
      !event.createdAt ||
      typeof event.text !== 'string' ||
      !event.sender ||
      !['human', 'agent', 'system'].includes(event.sender.kind) ||
      typeof event.sender.id !== 'string'
    ) {
      throw new Error(`Invalid MatOS project timeline record at ${eventLogPath(cwd)}`)
    }
    validLines.push(line)
    events.push(event)
  }
  // A crash can land every JSON byte but miss only the final newline. Repair
  // that valid tail before a later append, otherwise two valid records become
  // one malformed line.
  if (
    options.repairTornTail &&
    !repairedTail &&
    !hasTerminatingNewline &&
    lastNonEmptyIndex >= 0
  ) {
    await repairTimelineTail(cwd, validLines)
  }
  return events
}

// Appends scan only the newest slice of the log for torn-tail repair and
// duplicate-event detection. Idempotent retries (Open Design outbox replays,
// daemon restarts) always happen close to the original write, so a bounded
// window preserves that guarantee while keeping appends O(window) instead of
// re-reading an ever-growing group-chat history on every message.
const TIMELINE_APPEND_SCAN_BYTES = 1024 * 1024

async function appendTimelineEvent(
  cwd: string,
  event: MatOSWorkbenchProjectTimelineEvent,
): Promise<boolean> {
  return withTimelineLock(cwd, async () => {
    const path = eventLogPath(cwd)
    let size = 0
    try {
      size = (await stat(path)).size
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    if (size <= TIMELINE_APPEND_SCAN_BYTES) {
      // Small logs keep the exact legacy behavior: full validation, full
      // dedupe, and torn-tail rewrite.
      const events = await readTimelineEventsUnlocked(cwd, { repairTornTail: true })
      const existing = events.find(candidate => candidate.eventId === event.eventId)
      if (existing) {
        if (!isDeepStrictEqual(existing, { ...event, createdAt: existing.createdAt })) {
          throw new Error(`MatOS project timeline event id collision: ${event.eventId}`)
        }
        return false
      }
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
      return true
    }

    const handle = await open(path, 'r+')
    try {
      const readTail = async (bytes: number): Promise<{ tail: string; size: number }> => {
        const info = await handle.stat()
        const length = Math.min(bytes, info.size)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, info.size - length)
        return { tail: buffer.toString('utf8'), size: info.size }
      }
      let { tail, size: fileSize } = await readTail(TIMELINE_APPEND_SCAN_BYTES)
      if (!tail.endsWith('\n')) {
        // A crash landed a partial final line. Truncate the torn bytes so the
        // new record starts on a clean line; the removed fragment was never a
        // complete event. Byte math must use Buffer lengths - the timeline
        // carries multi-byte UTF-8 text.
        const tailBuffer = Buffer.from(tail, 'utf8')
        const lastNewline = tailBuffer.lastIndexOf(0x0a)
        if (lastNewline < 0) {
          throw new Error(
            `Invalid MatOS project timeline at ${path}: unterminated line exceeds scan window`,
          )
        }
        await handle.truncate(fileSize - (tailBuffer.length - lastNewline - 1))
        tail = tailBuffer.subarray(0, lastNewline + 1).toString('utf8')
      }
      // The first scanned line may start mid-record; dedupe only against
      // complete lines.
      const lines = tail.split('\n').filter(Boolean)
      const completeLines = tail.startsWith('\n') ? lines : lines.slice(1)
      for (const line of completeLines) {
        let parsed: { eventId?: unknown } | undefined
        try {
          parsed = JSON.parse(line) as { eventId?: unknown }
        } catch {
          continue
        }
        if (parsed?.eventId === event.eventId) {
          const existing = parsed as unknown as MatOSWorkbenchProjectTimelineEvent
          if (!isDeepStrictEqual(existing, { ...event, createdAt: existing.createdAt })) {
            throw new Error(`MatOS project timeline event id collision: ${event.eventId}`)
          }
          return false
        }
      }
    } finally {
      await handle.close()
    }
    // Top-level appendFile opens with the 'a' flag; FileHandle.appendFile on
    // an 'r+' handle writes from position 0 and would corrupt the log head.
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
    return true
  })
}

async function readProjectMetadata(cwd: string): Promise<ProjectMetadata> {
  return readMatOSProjectMetadata(cwd, { allowMissing: true })
}

async function selectProject(
  input: MatOSWorkbenchContext & { projectId?: string },
): Promise<ProjectSelection> {
  const projectId = stringValue(input.projectId)
  // Callers pass timeline pagination (limit/offset) and search fields in the
  // same input object; none of them may leak into the project-catalog page or
  // a large timeline offset makes every project "not found".
  const listed = await listMatOSWorkbenchProjects({
    cwd: input.cwd,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...(input.env ? { env: input.env } : {}),
    limit: projectId ? 1000 : 200,
    offset: 0,
  })
  const project = listed.projects.find(item =>
    item.id === input.projectId ||
    item.relativePath === input.projectId ||
    basename(item.cwd) === input.projectId,
  )
  if (projectId && !project) {
    throw new Error(`MatOS project not found: ${projectId}`)
  }
  const selectedProject = project ?? listed.projects[0]
  if (!selectedProject) {
    throw new Error(`No MatOS project found under ${input.cwd}`)
  }
  return {
    project: selectedProject,
    metadata: await readProjectMetadata(selectedProject.cwd),
  }
}

async function conversationsForProject(
  metadata: ProjectMetadata,
  project: MatOSWorkbenchProjectListItem,
): Promise<MatOSWorkbenchProjectConversation[]> {
  const conversations = new Map<string, MatOSWorkbenchProjectConversation>()
  const topicIds = new Map<string, Set<string>>()
  for (const conversation of conversationsFromMetadata(metadata)) {
    conversations.set(conversation.id, { ...conversation })
    topicIds.set(conversation.id, new Set())
  }
  for (const event of await readTimelineEvents(project.cwd)) {
    // Catalog IDs may be disambiguated when mounted projects reuse metadata IDs.
    // Keep reading legacy timeline records carrying the canonical metadata ID.
    const canonicalProjectId = stringValue(metadata.id)
    if (event.projectId !== project.id && event.projectId !== canonicalProjectId) {
      continue
    }
    const conversationId = stringValue(event.conversationId) ?? 'main'
    const current = conversations.get(conversationId) ?? {
      id: conversationId,
      title: conversationId === 'main' ? 'Main' : conversationId,
      memberRefs: [],
      topicCount: 0,
      messageCount: 0,
    }
    current.messageCount += 1
    if (!current.createdAt || event.createdAt < current.createdAt) {
      current.createdAt = event.createdAt
    }
    if (!current.updatedAt || event.createdAt > current.updatedAt) {
      current.updatedAt = event.createdAt
    }
    conversations.set(conversationId, current)
    if (event.topicId) {
      const topics = topicIds.get(conversationId) ?? new Set<string>()
      topics.add(event.topicId)
      topicIds.set(conversationId, topics)
    }
  }
  return [...conversations.values()]
    .map(conversation => ({
      ...conversation,
      topicCount: Math.max(conversation.topicCount, topicIds.get(conversation.id)?.size ?? 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function groupFromSelection(
  input: MatOSWorkbenchContext,
  selection: ProjectSelection,
): Promise<MatOSWorkbenchProjectGroup> {
  return {
    mode: 'matos-project-group',
    project: selection.project,
    members: membersFromMetadata(selection.metadata, selection.project),
    conversations: await conversationsForProject(selection.metadata, selection.project),
    areas: areasFromMetadata(selection.metadata),
    assetRefs: matOSProjectAssetRefs(selection.metadata),
    assetVersionPolicy: selection.metadata.assetVersionPolicy ?? 'follow-accepted',
    workflowRefs: arrayOfStrings(selection.metadata.workflowRefs),
    profile: {
      revision: Number.isInteger(Number(selection.metadata.revision))
        ? Math.max(0, Number(selection.metadata.revision))
        : 0,
      ...(stringValue(selection.metadata.goal) ? { goal: stringValue(selection.metadata.goal) } : {}),
      memberBriefs: stringRecord(selection.metadata.memberBriefs),
      memberNames: stringRecord(selection.metadata.memberNames),
      ...(roleResolutionWarningsFromMetadata(selection.metadata.roleResolutionWarnings).length
        ? {
            roleResolutionWarnings: roleResolutionWarningsFromMetadata(
              selection.metadata.roleResolutionWarnings,
            ),
          }
        : {}),
      visibilityPolicy: {
        shared: 'project-root',
        private: '.matos/private/<member-id>',
      },
    },
    store: {
      metadataPath: selection.project.metadataPath ??
        relative(input.cwd, join(selection.project.cwd, PROJECT_METADATA_RELATIVE_PATH)),
      eventLogRelativePath: relative(resolve(input.cwd), eventLogPath(selection.project.cwd)),
    },
  }
}

export async function showMatOSWorkbenchProjectGroup(
  input: MatOSWorkbenchContext & { projectId?: string },
): Promise<MatOSWorkbenchProjectGroup> {
  return await groupFromSelection(input, await selectProject(input))
}

export async function syncMatOSWorkbenchProjectConversations(input: MatOSWorkbenchContext & {
  conversations: Array<{
    id: string
    title?: string | null
    roleRef?: string | null
    memberRefs?: string[]
    createdAt?: string | number
    updatedAt?: string | number
  }>
  expectedRevision?: number
}): Promise<{ mode: 'matos-project-conversations-sync'; changed: boolean; conversations: MatOSWorkbenchProjectConversation[] }> {
  if (input.conversations.length > 5_000) {
    throw new Error('MatOS project conversation sync exceeds 5 000 records')
  }
  if (
    input.expectedRevision !== undefined &&
    (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
  ) {
    throw new Error(`Invalid MatOS project metadata revision: ${input.expectedRevision}`)
  }
  const seenIds = new Set<string>()
  const canonical = input.conversations.map(record => {
    const id = stringValue(record.id)
    if (!id) throw new Error('MatOS project conversation requires an id')
    if (id.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(id)) {
      throw new Error(`Invalid MatOS project conversation id: ${id}`)
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate MatOS project conversation id: ${id}`)
    }
    seenIds.add(id)
    const title = record.title === null ? null : stringValue(record.title) ?? id
    if (typeof title === 'string' && title.length > 500) {
      throw new Error(`MatOS project conversation title exceeds 500 characters: ${id}`)
    }
    const createdAt = record.createdAt === undefined
      ? undefined
      : String(record.createdAt).trim()
    const updatedAt = record.updatedAt === undefined
      ? undefined
      : String(record.updatedAt).trim()
    for (const [label, timestamp] of [['createdAt', createdAt], ['updatedAt', updatedAt]] as const) {
      if (
        timestamp !== undefined &&
        !(Number.isFinite(Number(timestamp)) || Number.isFinite(Date.parse(timestamp)))
      ) {
        throw new Error(`Invalid MatOS project conversation ${label}: ${id}`)
      }
    }
    const memberRefs = arrayOfStrings(record.memberRefs)
    if (memberRefs.length > 64) {
      throw new Error(`MatOS project conversation roster exceeds 64 members: ${id}`)
    }
    return {
      id,
      title,
      ...(stringValue(record.roleRef) ? { roleRef: stringValue(record.roleRef) } : {}),
      memberRefs,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    }
  })
  const mutation = await mutateMatOSProjectMetadata(input.cwd, current => {
    const rawCurrentRevision = Number(current.revision)
    const currentRevision = Number.isInteger(rawCurrentRevision) && rawCurrentRevision >= 0
      ? rawCurrentRevision
      : 0
    if (
      input.expectedRevision !== undefined &&
      currentRevision !== input.expectedRevision
    ) {
      throw new Error(
        `MatOS project metadata revision conflict: expected ${input.expectedRevision}, got ${currentRevision}`,
      )
    }
    const projectRoles = new Map<string, string>()
    for (const member of teamEntries(current)) {
      const roleRef = stringValue(member.roleRef) ?? stringValue(member.role_ref)
      if (roleRef) projectRoles.set(roleIdentity(roleRef), roleRef)
    }
    const conversations = canonical.map(conversation => {
      const roleRef = stringValue(conversation.roleRef)
      const canonicalRoleRef = roleRef
        ? projectRoles.get(roleIdentity(roleRef)) ?? roleRef
        : undefined
      if (projectRoles.size > 0 && roleRef && !projectRoles.has(roleIdentity(roleRef))) {
        throw new Error(`MatOS project conversation role is not a project member: ${roleRef}`)
      }
      const memberRefs = conversation.memberRefs.map(memberRef => {
        const canonicalMemberRef = projectRoles.get(roleIdentity(memberRef))
        if (projectRoles.size > 0 && !canonicalMemberRef) {
          throw new Error(`MatOS project conversation member is not in the project: ${memberRef}`)
        }
        return canonicalMemberRef ?? memberRef
      })
      return {
        ...conversation,
        ...(canonicalRoleRef ? { roleRef: canonicalRoleRef } : {}),
        memberRefs,
      }
    })
    return isDeepStrictEqual(current.conversations, conversations)
      ? undefined
      : { ...current, conversations }
  })
  return {
    mode: 'matos-project-conversations-sync',
    changed: mutation.changed,
    conversations: conversationsFromMetadata(mutation.metadata),
  }
}

export async function syncMatOSWorkbenchProjectGroup(input: MatOSWorkbenchContext & {
  id: string
  name: string
  description?: string
  goal?: string
  members?: string[]
  team?: Record<string, unknown>[]
  memberBriefs?: Record<string, string>
  memberNames?: Record<string, string>
  assetRefs?: string[]
  assetVersionPolicy?: 'follow-accepted' | 'pinned'
  expectedRevision?: number
}): Promise<{
  mode: 'matos-project-group-sync'
  changed: boolean
  project: MatOSWorkbenchProjectGroup
}> {
  const id = stringValue(input.id)
  const name = stringValue(input.name)
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Invalid MatOS project id: ${input.id}`)
  }
  if (!name) {
    throw new Error('MatOS project sync requires a name')
  }
  if (
    input.expectedRevision !== undefined &&
    (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
  ) {
    throw new Error(`Invalid MatOS project metadata revision: ${input.expectedRevision}`)
  }
  const memberBriefs = stringRecord(input.memberBriefs)
  const memberNames = stringRecord(input.memberNames)
  const assetRefs = input.assetRefs === undefined
    ? undefined
    : arrayOfStrings(input.assetRefs).slice(0, 64)
  const requiredRoleAssetIdentities = new Set(
    (assetRefs ?? [])
      .filter(ref => ref.startsWith('role:'))
      .map(roleIdentity),
  )
  if (input.assetVersionPolicy !== undefined) {
    matOSProjectAssetRefs({ assetVersionPolicy: input.assetVersionPolicy })
  }
  if ((input.env?.MATOS_STANDALONE ?? process.env.MATOS_STANDALONE) === '1') {
    const { ensureMatOSStandaloneAssets } = await import('../standaloneAssets.js')
    await ensureMatOSStandaloneAssets(input.cwd, { scopeRef: `project:${id}`, env: input.env })
  }

  await mkdir(join(input.cwd, '.matos', 'assets'), { recursive: true })
  await mkdir(join(input.cwd, '.matos', 'private'), { recursive: true })
  await mkdir(join(input.cwd, '.matos', 'workbench'), { recursive: true })
  await mkdir(getMatOSSessionsDir(input.cwd), { recursive: true })
  await mkdir(join(input.cwd, 'artifacts'), { recursive: true })
  await ensureMatOSProjectInternalGitignore(input.cwd)
  try {
    await readFile(getMatOSConfigPath(input.cwd), 'utf8')
  } catch {
    await writeFile(
      getMatOSConfigPath(input.cwd),
      `${JSON.stringify(getDefaultMatOSConfig(), null, 2)}\n`,
      'utf8',
    )
  }

  const canonicalMembers = new Map<
    string,
    {
      memberId: string
      roleRef?: string
      label: string
      kind: MatOSWorkbenchProjectMember['kind']
      source: string
      displayName?: string
      userId?: string
      defaultTools?: string[]
      runtimeRef?: string
    }
  >()
  const requestedMembers: Record<string, unknown>[] = input.team !== undefined
    ? input.team
    : arrayOfStrings(input.members).map(roleRef => ({ roleRef }))
  const assignedRoles = new Map<string, string>()
  // One shared lightweight resolution for every member: sync only needs the
  // canonical ref + display name, not the full resource graph per role
  // (which costs ~20s per member on container-scale registries).
  const requestedRoleRefs = requestedMembers.flatMap(record => {
    const roleRef = stringValue(record.roleRef) ?? stringValue(record.role_ref)
    return roleRef ? [roleRef] : []
  })
  const roleResolution = await resolveMatOSWorkbenchRoleSummaryResolution({
    ...input,
    refs: requestedRoleRefs,
  })
  const roleSummaries = roleResolution.summaries
  const roleResolutionWarnings: Array<{
    code: string
    requestedRoleRef: string
    fallbackRoleRef: string
    message: string
  }> = []
  for (const requestedRecord of requestedMembers) {
    const requested = stringValue(requestedRecord.roleRef) ?? stringValue(requestedRecord.role_ref)
    if (!requested) {
      const kind = projectMemberKind(requestedRecord.kind)
      const userId = stringValue(requestedRecord.userId) ?? stringValue(requestedRecord.user_id)
      if (kind !== 'human' || !userId) {
        throw new Error('MatOS project team member requires a roleRef')
      }
      const rawMemberId = stringValue(requestedRecord.memberId) ??
        stringValue(requestedRecord.member_id)
      if (!rawMemberId) {
        throw new Error('MatOS human project member requires a memberId')
      }
      const memberId = assertProjectMemberId(rawMemberId)
      if (canonicalMembers.has(memberId)) {
        throw new Error(`MatOS project member '${memberId}' is assigned to multiple roles`)
      }
      canonicalMembers.set(memberId, {
        memberId,
        label:
          stringValue(requestedRecord.label) ??
          stringValue(requestedRecord.displayName) ??
          userId,
        kind,
        userId,
        source: stringValue(requestedRecord.source) ?? 'explicit',
        ...(stringValue(requestedRecord.displayName)
          ? { displayName: stringValue(requestedRecord.displayName) }
          : {}),
        ...(Array.isArray(requestedRecord.defaultTools)
          ? { defaultTools: arrayOfStrings(requestedRecord.defaultTools) }
          : {}),
        ...(stringValue(requestedRecord.runtimeRef) ?? stringValue(requestedRecord.runtime_ref)
          ? { runtimeRef: stringValue(requestedRecord.runtimeRef) ?? stringValue(requestedRecord.runtime_ref) }
          : {}),
      })
      continue
    }
    let role = roleSummaries.get(requested)
    // A role explicitly attached as a project asset is an integrity
    // requirement, not a preference. If its accepted copy cannot be
    // resolved, fail the sync and preserve the previous authority instead of
    // silently rewriting the project to Compute.
    const fallback = !role && !requiredRoleAssetIdentities.has(roleIdentity(requested))
      ? roleResolution.fallback
      : undefined
    if (!role && fallback) {
      role = fallback
      roleResolutionWarnings.push({
        code: 'role_asset_fallback',
        requestedRoleRef: requested,
        fallbackRoleRef: fallback.ref,
        message:
          `MatOS role asset not found: ${requested}; fell back to ${fallback.ref}.`,
      })
    }
    if (!role) {
      throw new Error(`MatOS role asset not found: ${requested}`)
    }
    const roleRef = role.ref
    const memberId = assertProjectMemberId(
      stringValue(requestedRecord.memberId) ??
      stringValue(requestedRecord.member_id) ??
      memberIdForRoleRef(roleRef),
    )
    const identity = roleIdentity(roleRef)
    const existingMember = canonicalMembers.get(memberId)
    if (
      existingMember &&
      (!existingMember.roleRef || roleIdentity(existingMember.roleRef) !== identity)
    ) {
      throw new Error(`MatOS project member '${memberId}' is assigned to multiple roles`)
    }
    const existingRoleMember = assignedRoles.get(identity)
    if (existingRoleMember && existingRoleMember !== memberId) {
      if (fallback) {
        roleResolutionWarnings.push({
          code: 'role_asset_fallback_skipped',
          requestedRoleRef: requested,
          fallbackRoleRef: roleRef,
          message:
            `MatOS role asset not found: ${requested}; fallback ${roleRef} was already assigned to member '${existingRoleMember}', so this duplicate team entry was skipped.`,
        })
        continue
      }
      throw new Error(`MatOS project role '${identity}' is assigned to multiple members`)
    }
    assignedRoles.set(identity, memberId)
    canonicalMembers.set(memberId, {
      memberId,
      roleRef,
      label:
        stringValue(requestedRecord.label) ??
        stringValue(requestedRecord.displayName) ??
        stringValue(memberNames[requested]) ??
        stringValue(memberNames[roleIdentity(requested)]) ??
        stringValue(memberNames[roleRef]) ??
        stringValue(memberNames[roleIdentity(roleRef)]) ??
        role.name,
      kind: projectMemberKind(requestedRecord.kind),
      source: stringValue(requestedRecord.source) ?? 'explicit',
      ...(stringValue(requestedRecord.displayName)
        ? { displayName: stringValue(requestedRecord.displayName) }
        : {}),
      ...(stringValue(requestedRecord.userId) ?? stringValue(requestedRecord.user_id)
        ? { userId: stringValue(requestedRecord.userId) ?? stringValue(requestedRecord.user_id) }
        : {}),
      ...(Array.isArray(requestedRecord.defaultTools)
        ? { defaultTools: arrayOfStrings(requestedRecord.defaultTools) }
        : {}),
      ...(stringValue(requestedRecord.runtimeRef) ?? stringValue(requestedRecord.runtime_ref)
        ? { runtimeRef: stringValue(requestedRecord.runtimeRef) ?? stringValue(requestedRecord.runtime_ref) }
        : {}),
    })
  }
  const now = new Date().toISOString()
  const mutation = await mutateMatOSProjectMetadata(input.cwd, current => {
    const rawCurrentRevision = Number(current.revision)
    const currentRevision = Number.isInteger(rawCurrentRevision) && rawCurrentRevision >= 0
      ? rawCurrentRevision
      : 0
    if (
      input.expectedRevision !== undefined &&
      currentRevision !== input.expectedRevision
    ) {
      throw new Error(
        `MatOS project metadata revision conflict: expected ${input.expectedRevision}, got ${currentRevision}`,
      )
    }
    const currentId = stringValue(current.id)
    if (currentId && currentId !== id) {
      throw new Error(`MatOS project id is immutable: ${currentId} cannot become ${id}`)
    }
    const next: ProjectMetadata = {
      ...current,
      schemaVersion: 1,
      id,
      name,
      createdAt: stringValue(current.createdAt) ?? now,
      ...(input.description !== undefined
        ? { description: stringValue(input.description) ?? '' }
        : {}),
      ...(input.goal !== undefined ? { goal: stringValue(input.goal) ?? '' } : {}),
      ...(!currentId || input.members !== undefined || input.team !== undefined
        ? { team: [...canonicalMembers.values()] }
        : {}),
      ...(!currentId || input.memberBriefs !== undefined
        ? { memberBriefs }
        : {}),
      ...(!currentId || input.memberNames !== undefined
        ? { memberNames }
        : {}),
      ...(input.assetVersionPolicy !== undefined ? { assetVersionPolicy: input.assetVersionPolicy } : {}),
      ...(assetRefs !== undefined || input.assetVersionPolicy !== undefined ? {
        assetRefs: matOSProjectAssetRefs({
          ...current,
          assetRefs: assetRefs ?? current.assetRefs,
          assetVersionPolicy: input.assetVersionPolicy ?? current.assetVersionPolicy,
        }),
      } : {}),
      roleResolutionWarnings: roleResolutionWarnings.length
        ? roleResolutionWarnings
        : undefined,
      visibilityPolicy: {
        shared: 'project-root',
        private: '.matos/private/<member-id>',
      },
    }
    const comparableCurrent = { ...current, revision: undefined, updatedAt: undefined }
    const comparableNext = { ...next, revision: undefined, updatedAt: undefined }
    return JSON.stringify(comparableCurrent) === JSON.stringify(comparableNext)
      ? undefined
      : next
  })
  const project = await showMatOSWorkbenchProjectGroup({ cwd: input.cwd, env: input.env })
  return {
    mode: 'matos-project-group-sync',
    changed: mutation.changed,
    project,
  }
}

export async function actMatOSWorkbenchProjectMember(input: MatOSWorkbenchContext & {
  projectId?: string
  assetCwd?: string
  action: 'add-agent' | 'remove'
  roleRef?: string
  memberId?: string
  displayName?: string
}): Promise<MatOSWorkbenchProjectGroupMutation> {
  const selection = await selectProject(input)
  let canonicalRoleRef: string | undefined
  if (input.action === 'add-agent') {
    const roleRef = stringValue(input.roleRef)
    if (!roleRef) {
      throw new Error('projects member-add requires --role <role-ref>')
    }
    canonicalRoleRef = (await resolveMatOSWorkbenchRoleSummaries({
      ...input,
      cwd: input.assetCwd ?? selection.project.cwd,
      refs: [roleRef],
    })).get(roleRef)!.ref
  }
  let removedHumanUserId: string | undefined
  const mutation = await mutateMatOSProjectMetadata(selection.project.cwd, current => {
    const team = teamEntries(current)
    if (input.action === 'add-agent') {
      const roleRef = canonicalRoleRef!
      const memberId = assertProjectMemberId(
        stringValue(input.memberId) ?? memberIdForRoleRef(roleRef),
      )
      const existing = team.find(record =>
        (stringValue(record.memberId) ?? stringValue(record.member_id) ?? (stringValue(record.roleRef) ? memberIdForRoleRef(String(record.roleRef)) : undefined)) === memberId,
      )
      if (existing) {
        if (stringValue(existing.roleRef) && roleIdentity(String(existing.roleRef)) !== roleIdentity(roleRef)) {
          throw new Error(`MatOS project member '${memberId}' is already bound to ${String(existing.roleRef)}`)
        }
        return undefined
      }
      const roleOwner = team.find(record => {
        const existingRole = stringValue(record.roleRef) ?? stringValue(record.role_ref)
        return existingRole && roleIdentity(existingRole) === roleIdentity(roleRef)
      })
      if (roleOwner) {
        const ownerId = stringValue(roleOwner.memberId) ??
          stringValue(roleOwner.member_id) ??
          memberIdForRoleRef(roleRef)
        throw new Error(`MatOS project role '${roleIdentity(roleRef)}' is already assigned to member '${ownerId}'`)
      }
      return {
        ...current,
        team: [
          ...team,
          {
            memberId,
            kind: 'agent',
            roleRef,
            label: stringValue(input.displayName) ?? roleRef,
            source: 'explicit',
          },
        ],
      }
    }

    const memberId = stringValue(input.memberId)
    if (!memberId) {
      throw new Error('projects member-remove requires --member-id <id>')
    }
    const next = team.filter(record => {
      const recordId =
        stringValue(record.memberId) ??
        stringValue(record.member_id) ??
        (stringValue(record.roleRef) ? memberIdForRoleRef(String(record.roleRef)) : undefined)
      if (recordId !== memberId) {
        return true
      }
      if (record.kind === 'human' && (stringValue(record.userId) ?? stringValue(record.user_id))) {
        removedHumanUserId = stringValue(record.userId) ?? stringValue(record.user_id)
      }
      return false
    })
    return next.length === team.length ? undefined : { ...current, team: next }
  })
  return {
    mode: 'matos-project-group-mutation',
    changed: mutation.changed,
    action: input.action,
    project: await showMatOSWorkbenchProjectGroup({ ...input, projectId: selection.project.id }),
    ...(removedHumanUserId
      ? {
          warning:
            `Removing the human member only edits project metadata; the workspace mount grant for ${removedHumanUserId} stays active until an operator runs 'matos gateway projects unshare'.`,
        }
      : {}),
  }
}

/**
 * Adds a freshly-created Role to a project and, when requested, replaces the
 * currently executing agent in one project-metadata transaction.  Role
 * creation itself can be backed by a remote accepted ref, so it cannot share
 * this filesystem lock; all project-side effects (roster + assetRefs) can and
 * must remain atomic.
 */
export async function bindMatOSWorkbenchCreatedRole(input: MatOSWorkbenchContext & {
  projectId?: string
  assetCwd?: string
  roleRef: string
  displayName?: string
  mode: 'add' | 'replace-current'
  assetVersionPolicy?: 'follow-accepted' | 'pinned'
  currentMemberId?: string
  currentRoleRef?: string
}): Promise<MatOSWorkbenchProjectGroupMutation & {
  roleRef: string
  memberId: string
  removedCurrent?: { memberId: string; roleRef: string }
}> {
  const selection = await selectProject(input)
  const requestedRoleRef = stringValue(input.roleRef)
  if (!requestedRoleRef) {
    throw new Error('Project Role binding requires a role ref')
  }
  const canonicalRoleRef = (await resolveMatOSWorkbenchRoleSummaries({
    ...input,
    cwd: input.assetCwd ?? selection.project.cwd,
    refs: [requestedRoleRef],
  })).get(requestedRoleRef)!.ref
  const createdMemberId = assertProjectMemberId(memberIdForRoleRef(canonicalRoleRef))
  const currentMemberId = stringValue(input.currentMemberId)
  const currentRoleRef = stringValue(input.currentRoleRef)
  if (input.mode === 'replace-current' && (!currentMemberId || !currentRoleRef)) {
    throw new Error(
      'Project Role replacement requires the current agent member id and role ref',
    )
  }

  let removedCurrent: { memberId: string; roleRef: string } | undefined
  const mutation = await mutateMatOSProjectMetadata(selection.project.cwd, current => {
    const team = teamEntries(current)
    const createdOwner = team.find(record => {
      const existingRole = stringValue(record.roleRef) ?? stringValue(record.role_ref)
      return existingRole && roleIdentity(existingRole) === roleIdentity(canonicalRoleRef)
    })
    const createdMember = team.find(record => {
      const recordId =
        stringValue(record.memberId) ??
        stringValue(record.member_id) ??
        (stringValue(record.roleRef)
          ? memberIdForRoleRef(String(record.roleRef))
          : undefined)
      return recordId === createdMemberId
    })
    if (
      createdMember &&
      (!stringValue(createdMember.roleRef) ||
        roleIdentity(String(createdMember.roleRef)) !== roleIdentity(canonicalRoleRef))
    ) {
      throw new Error(
        `MatOS project member '${createdMemberId}' is already assigned to another identity`,
      )
    }
    if (createdOwner && createdOwner !== createdMember) {
      const ownerId =
        stringValue(createdOwner.memberId) ??
        stringValue(createdOwner.member_id) ??
        createdMemberId
      throw new Error(
        `MatOS project role '${roleIdentity(canonicalRoleRef)}' is already assigned to member '${ownerId}'`,
      )
    }

    let nextTeam = [...team]
    if (input.mode === 'replace-current') {
      if (currentMemberId === createdMemberId) {
        throw new Error('The current and replacement project members are identical')
      }
      const currentIndex = team.findIndex(record => {
        const recordId =
          stringValue(record.memberId) ??
          stringValue(record.member_id) ??
          (stringValue(record.roleRef)
            ? memberIdForRoleRef(String(record.roleRef))
            : undefined)
        return recordId === currentMemberId
      })
      if (currentIndex < 0) {
        throw new Error(
          `Current project member '${currentMemberId}' was not found; refusing to report a successful replacement`,
        )
      }
      const currentRecord = team[currentIndex]!
      const currentKind = projectMemberKind(currentRecord.kind)
      const actualCurrentRole =
        stringValue(currentRecord.roleRef) ?? stringValue(currentRecord.role_ref)
      if (currentKind !== 'agent' || !actualCurrentRole) {
        throw new Error(
          `Project member '${currentMemberId}' is not an agent and cannot be replaced by role_edit`,
        )
      }
      if (roleIdentity(actualCurrentRole) !== roleIdentity(currentRoleRef!)) {
        throw new Error(
          `Project member '${currentMemberId}' is bound to ${actualCurrentRole}, not the current role ${currentRoleRef}`,
        )
      }
      removedCurrent = { memberId: currentMemberId!, roleRef: actualCurrentRole }
      nextTeam = nextTeam.filter((_, index) => index !== currentIndex)
    }

    if (!createdOwner) {
      nextTeam.push({
        memberId: createdMemberId,
        kind: 'agent',
        roleRef: canonicalRoleRef,
        label: stringValue(input.displayName) ?? canonicalRoleRef,
        source: 'explicit',
      })
    }
    const assetRefs = arrayOfStrings(current.assetRefs)
    const nextAssetRefs = assetRefs.includes(canonicalRoleRef)
      ? assetRefs
      : [...assetRefs, canonicalRoleRef]
    const nextAssetVersionPolicy = input.assetVersionPolicy ?? current.assetVersionPolicy
    if (
      isDeepStrictEqual(team, nextTeam) &&
      isDeepStrictEqual(assetRefs, nextAssetRefs) &&
      nextAssetVersionPolicy === current.assetVersionPolicy
    ) {
      return undefined
    }
    return {
      ...current,
      team: nextTeam,
      assetRefs: nextAssetRefs,
      ...(nextAssetVersionPolicy
        ? { assetVersionPolicy: nextAssetVersionPolicy }
        : {}),
    }
  })
  return {
    mode: 'matos-project-group-mutation',
    changed: mutation.changed,
    action: input.mode === 'replace-current' ? 'replace-agent' : 'add-agent',
    roleRef: canonicalRoleRef,
    memberId: createdMemberId,
    ...(removedCurrent ? { removedCurrent } : {}),
    project: await showMatOSWorkbenchProjectGroup({
      ...input,
      projectId: selection.project.id,
    }),
  }
}

export async function bindMatOSWorkbenchProjectRef(input: MatOSWorkbenchContext & {
  projectId?: string
  kind: 'asset' | 'workflow'
  ref: string
}): Promise<MatOSWorkbenchProjectGroupMutation> {
  const ref = stringValue(input.ref)
  if (!ref) {
    throw new Error('projects bind requires a canonical ref')
  }
  const selection = await selectProject(input)
  const key = input.kind === 'workflow' ? 'workflowRefs' : 'assetRefs'
  const mutation = await mutateMatOSProjectMetadata(selection.project.cwd, current => {
    const refs = arrayOfStrings(current[key])
    return refs.includes(ref) ? undefined : { ...current, [key]: [...refs, ref] }
  })
  return {
    mode: 'matos-project-group-mutation',
    changed: mutation.changed,
    action: input.kind === 'workflow' ? 'bind-workflow' : 'bind-asset',
    project: await showMatOSWorkbenchProjectGroup({ ...input, projectId: selection.project.id }),
  }
}

export async function createMatOSWorkbenchProjectArea(input: MatOSWorkbenchContext & {
  projectId?: string
  kind: MatOSWorkbenchProjectArea['kind']
  name: string
  defaultRoleRef?: string
  defaultAssetRefs?: string[]
  defaultWorkflowRefs?: string[]
}): Promise<MatOSWorkbenchProjectGroupMutation> {
  const name = stringValue(input.name)
  if (!name) {
    throw new Error('projects area-create requires --name <name>')
  }
  const selection = await selectProject(input)
  const canonicalDefaultRoleRef = input.defaultRoleRef
    ? (await resolveMatOSWorkbenchRoleSummaries({
        ...input,
        cwd: selection.project.cwd,
        refs: [input.defaultRoleRef],
      })).get(input.defaultRoleRef)!.ref
    : undefined
  const now = new Date().toISOString()
  const areaId = slugSegment(name, input.kind || 'area')
  const mutation = await mutateMatOSProjectMetadata(selection.project.cwd, current => {
    const areas = areasFromMetadata(current)
    if (areas.some(area => area.areaId === areaId)) {
      return undefined
    }
    return {
      ...current,
      areas: [
        ...areas,
        {
          areaId,
          name,
          kind: normalizeProjectAreaKind(input.kind),
          ...(canonicalDefaultRoleRef ? { defaultRoleRef: canonicalDefaultRoleRef } : {}),
          defaultAssetRefs: input.defaultAssetRefs ?? [],
          defaultWorkflowRefs: input.defaultWorkflowRefs ?? [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }
  })
  return {
    mode: 'matos-project-group-mutation',
    changed: mutation.changed,
    action: 'area-create',
    project: await showMatOSWorkbenchProjectGroup({ ...input, projectId: selection.project.id }),
  }
}

async function readTimelineEvents(cwd: string): Promise<MatOSWorkbenchProjectTimelineEvent[]> {
  return withTimelineLock(cwd, () =>
    readTimelineEventsUnlocked(cwd, { repairTornTail: true }))
}

export async function listMatOSWorkbenchProjectTimeline(input: MatOSWorkbenchContext & {
  projectId?: string
  conversationId?: string
  topicId?: string
  areaId?: string
  limit?: number
  offset?: number
}): Promise<MatOSWorkbenchProjectTimeline> {
  const selection = await selectProject(input)
  const conversationId = stringValue(input.conversationId) ??
    defaultProjectConversationId(
      selection.metadata,
      conversationsFromMetadata(selection.metadata),
    )
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  if (!conversationsFromMetadata(selection.metadata).some(
    conversation => conversation.id === conversationId,
  )) {
    throw new Error(`MatOS project conversation not found: ${conversationId}`)
  }
  const canonicalProjectId = stringValue(selection.metadata.id)
  const events = (await readTimelineEvents(selection.project.cwd))
    .filter(event =>
      event.projectId === selection.project.id ||
      event.projectId === canonicalProjectId,
    )
    .filter(event => event.conversationId === conversationId)
    .filter(event => !input.topicId || event.topicId === input.topicId)
    .filter(event => !input.areaId || event.areaId === input.areaId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const page = events.slice(offset, offset + limit)
  return {
    mode: 'matos-project-timeline',
    project: selection.project,
    conversationId,
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.areaId ? { areaId: input.areaId } : {}),
    events: page,
    summary: {
      count: page.length,
      total: events.length,
      offset,
      limit,
    },
  }
}

export async function sendMatOSWorkbenchProjectMessage(input: MatOSWorkbenchContext & {
  projectId?: string
  conversationId?: string
  topicId?: string
  areaId?: string
  senderKind?: 'human' | 'agent' | 'system'
  senderId?: string
  memberId?: string
  roleRef?: string
  text: string
  refs?: MatOSWorkbenchProjectTimelineEvent['refs']
  eventId?: string
  createdAt?: string
}): Promise<MatOSWorkbenchProjectMessageSendResult> {
  const text = stringValue(input.text)
  if (!text) {
    throw new Error('projects send requires --message <text>')
  }
  const selection = await selectProject(input)
  const group = await groupFromSelection(input, selection)
  let memberId = stringValue(input.memberId)
  let roleRef = stringValue(input.roleRef)
  let senderId = stringValue(input.senderId)
  if (input.senderKind === 'agent' && group.members.length > 0) {
    const byMember = memberId
      ? group.members.find(member => member.memberId === memberId)
      : undefined
    const byRole = roleRef ? memberForRoleRef(group, roleRef) : undefined
    const member = byMember ?? byRole
    if (!member?.roleRef) {
      throw new Error('MatOS project agent messages require a project member identity')
    }
    if (byMember && roleRef && roleIdentity(byMember.roleRef) !== roleIdentity(roleRef)) {
      throw new Error(`MatOS project member '${byMember.memberId}' is not bound to ${roleRef}`)
    }
    memberId = member.memberId
    roleRef = member.roleRef
  } else if ((input.senderKind ?? 'human') === 'human') {
    // Attribute messages to the authenticated scope's human member. A caller
    // may provide memberId/senderId as consistency hints, but never to
    // impersonate another collaborator in a shared project.
    const humanMember = humanMemberForScope(group, input)
    if (humanMember) {
      if (memberId && memberId !== humanMember.memberId) {
        throw new Error(`MatOS project human messages must use the acting member ${humanMember.memberId}`)
      }
      const actingSenderId = humanMember.userId ?? humanMember.memberId
      if (senderId && senderId !== actingSenderId) {
        throw new Error('MatOS project human messages must use the acting user identity')
      }
      memberId = humanMember.memberId
      senderId = actingSenderId
    }
  }
  const createdAt = stringValue(input.createdAt) ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`Invalid MatOS project event timestamp: ${createdAt}`)
  }
  const conversationId = stringValue(input.conversationId) ??
    defaultProjectConversationId(
      selection.metadata,
      group.conversations,
    )
  const conversation = group.conversations.find(item => item.id === conversationId)
  if (!conversation) {
    throw new Error(`MatOS project conversation not found: ${conversationId}`)
  }
  const senderMember = group.members.find(member => member.memberId === memberId)
  const allowedByRoster = conversation.memberRefs.some(ref =>
    ref === memberId ||
    (ref.startsWith('role:') && senderMember?.roleRef &&
      roleIdentity(ref) === roleIdentity(senderMember.roleRef)),
  )
  if (conversation.memberRefs.length > 0 && (!memberId || !allowedByRoster)) {
    throw new Error(`MatOS project conversation does not allow member ${memberId ?? '(unknown)'}`)
  }
  const event: MatOSWorkbenchProjectTimelineEvent = {
    eventId: stringValue(input.eventId) ??
      stableEventId(`${selection.project.id}:${conversationId}:${createdAt}:${randomUUID()}`),
    createdAt,
    projectId: selection.project.id,
    conversationId,
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.areaId ? { areaId: input.areaId } : {}),
    sender: {
      kind: input.senderKind ?? 'human',
      id: senderId ?? 'user',
      ...(memberId ? { memberId } : {}),
      ...(roleRef ? { roleRef } : {}),
    },
    eventType: input.senderKind === 'agent' ? 'agent.message' : 'message',
    text,
    refs: input.refs ?? {},
  }
  await appendTimelineEvent(selection.project.cwd, event)
  return {
    mode: 'matos-project-message-send',
    event,
    timeline: await listMatOSWorkbenchProjectTimeline({
      ...input,
      projectId: selection.project.id,
      conversationId,
    }),
  }
}

export async function submitMatOSWorkbenchProjectChat(input: MatOSWorkbenchContext & {
  projectId?: string
  conversationId?: string
  topicId?: string
  areaId?: string
  roleRef?: string
  senderId?: string
  memberId?: string
  text: string
  maxTurns?: number
}): Promise<MatOSWorkbenchProjectChatSubmitResult> {
  const group = await showMatOSWorkbenchProjectGroup(input)
  const requestedRoleRef = defaultRoleRefForProjectChat({
    roleRef: input.roleRef,
    areaId: input.areaId,
    group,
  })
  const roleRef = (await resolveMatOSWorkbenchRoleSummaries({
    ...input,
    cwd: group.project.cwd,
    refs: [requestedRoleRef],
  })).get(requestedRoleRef)!.ref
  const requestedMember = input.memberId
    ? group.members.find(member => member.memberId === input.memberId)
    : undefined
  if (input.memberId && !requestedMember) {
    throw new Error(`MatOS project member not found: ${input.memberId}`)
  }
  if (
    requestedMember?.roleRef &&
    roleIdentity(requestedMember.roleRef) !== roleIdentity(roleRef)
  ) {
    throw new Error(
      `MatOS project member '${requestedMember.memberId}' is bound to ${requestedMember.roleRef}, not ${roleRef}`,
    )
  }
  const roleMember = requestedMember ?? memberForRoleRef(group, roleRef)
  if (group.members.length > 0 && !roleMember) {
    throw new Error(`MatOS role is not a member of project '${group.project.id}': ${roleRef}`)
  }
  const memberId = roleMember?.memberId ?? memberIdForRoleRef(roleRef)
  // The human turn belongs to the acting user, not to the agent member the
  // chat targets; in shared multi-user projects the agent-member fallback
  // made every participant's messages indistinguishable.
  const humanMember = humanMemberForScope(group, input)
  const human = await sendMatOSWorkbenchProjectMessage({
    ...input,
    projectId: group.project.id,
    senderKind: 'human',
    senderId:
      input.senderId ?? humanMember?.userId ?? humanMember?.memberId,
    memberId: humanMember?.memberId ?? memberId,
    roleRef,
    text: input.text,
  })
  // Upstream chat sessions carry user-specific context and permissions. In
  // shared projects, key the session by the acting human member rather than
  // the target Agent member so two collaborators never resume one another's
  // conversation state.
  const chatSessionMemberId = humanMember?.memberId ?? memberId
  const chatSession = stableProjectChatSessionIds({
    projectId: group.project.id,
    conversationId: human.timeline.conversationId,
    topicId: human.timeline.topicId,
    areaId: human.timeline.areaId,
    roleRef,
    memberId: chatSessionMemberId,
  })
  const projectSessionDir = getMatOSSessionsDir(group.project.cwd)
  const projectEnv = {
    ...input.env,
    MATOS_WORKSPACE_DIR: group.project.cwd,
    MATOS_SESSION_DIR: projectSessionDir,
    MATOS_PROJECT_MEMBER_ID: memberId,
  }
  const previousResume = await latestMatOSResumeLinkFromSessionEvents({
    cwd: group.project.cwd,
    env: projectEnv,
    matosSessionId: chatSession.sessionId,
    roleRef,
  })
  const prompt = projectChatPrompt({
    group,
    timeline: human.timeline,
    message: human.event.text,
    roleRef,
    latestEventId: human.event.eventId,
  })
  const run = await prepareMatOSWorkbenchRoleDebugRun({
    ...input,
    cwd: group.project.cwd,
    env: {
      ...projectEnv,
      MATOS_PROJECT_ID: group.project.id,
      MATOS_PROJECT_CONVERSATION_ID: human.timeline.conversationId,
      ...(human.timeline.topicId ? { MATOS_PROJECT_TOPIC_ID: human.timeline.topicId } : {}),
      ...(human.timeline.areaId ? { MATOS_PROJECT_AREA_ID: human.timeline.areaId } : {}),
      MATOS_SESSION_ID: chatSession.sessionId,
      MATOS_TRACE_ID: chatSession.traceId,
      MATOS_CHAT_SESSION_ID: chatSession.sessionId,
      ...(previousResume
        ? {
            MATOS_UPSTREAM_SESSION_ID: previousResume.upstreamSessionId,
            MATOS_RESUME_COMMAND: previousResume.command,
          }
        : {}),
    },
    ref: roleRef,
    message: prompt,
    maxTurns: input.maxTurns,
    submit: true,
    resumeSessionId: previousResume?.upstreamSessionId,
  })
  return {
    mode: 'matos-project-chat-submit',
    event: human.event,
    timeline: human.timeline,
    roleRef: run.role.resource.ref,
    prompt: {
      source: 'matos-project-chat-context',
      length: prompt.length,
      timelineEventCount: human.timeline.events.length,
    },
    ...(run.job
      ? {
          job: {
            jobId: run.job.jobId,
            ...(run.job.pid !== undefined ? { pid: run.job.pid } : {}),
            status: run.job.status,
            ...(run.job.cwd ? { cwd: run.job.cwd } : {}),
            metadata: {
              ...run.job.metadata,
              projectId: group.project.id,
              conversationId: human.timeline.conversationId,
              memberId,
              matosChatSessionId: chatSession.sessionId,
              ...(previousResume
                ? {
                    upstreamSessionId: previousResume.upstreamSessionId,
                    resumeCommand: previousResume.command,
                  }
                : {}),
              ...(human.timeline.topicId ? { topicId: human.timeline.topicId } : {}),
              ...(human.timeline.areaId ? { areaId: human.timeline.areaId } : {}),
            },
          },
        }
      : {}),
    session: {
      matosSessionId: chatSession.sessionId,
      traceId: chatSession.traceId,
      ...(previousResume ? { resume: previousResume } : {}),
    },
    summary: {
      source: 'matos-project-chat',
      submitted: Boolean(run.job),
      projectId: group.project.id,
      conversationId: human.timeline.conversationId,
      ...(human.timeline.topicId ? { topicId: human.timeline.topicId } : {}),
      ...(human.timeline.areaId ? { areaId: human.timeline.areaId } : {}),
      roleRef: run.role.resource.ref,
    },
  }
}
