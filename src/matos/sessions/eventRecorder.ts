import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMatOSEvolutionProvider } from '../learning/evolutionProvider.js'
import { observeMatOSSelfEvolutionEvent } from '../learning/evolutionMonitor.js'
import { appendMatOSSessionEvent } from './eventStorage.js'
import type { MatOSEvent, MatOSEventInput } from './eventTypes.js'
import { resolveMatOSSessionsDir } from './sessionPaths.js'
import {
  buildMatOSTraceEnv,
  createMatOSTraceContext,
  redactTraceValue,
  type MatOSTraceContext,
  type MatOSTraceContextInput,
} from './traceContext.js'

export type MatOSEventRecorder = {
  sessionId: string
  traceId: string
  traceContext: MatOSTraceContext
  traceEnv: Record<string, string>
  path: string
  record: (event: MatOSEventInput) => Promise<void>
  close: () => Promise<void>
}

type CreateRecorderMetadata = MatOSTraceContextInput & {
  command: string
  cwd: string
  hidden?: boolean
  userVisible?: boolean
  suppressSessionStarted?: boolean
}

function createEvent(
  traceContext: MatOSTraceContext,
  event: MatOSEventInput,
): MatOSEvent {
  const eventTraceContext = {
    ...traceContext,
    ...Object.fromEntries(
      Object.entries(event.traceContext ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  } as MatOSTraceContext
  return {
    id: randomUUID(),
    schemaVersion: eventTraceContext.schemaVersion,
    traceId: eventTraceContext.traceId,
    sessionId: eventTraceContext.sessionId ?? '',
    ...(eventTraceContext.parentSessionId
      ? { parentSessionId: eventTraceContext.parentSessionId }
      : {}),
    ...(eventTraceContext.turnId ? { turnId: eventTraceContext.turnId } : {}),
    ...(eventTraceContext.userId ? { userId: eventTraceContext.userId } : {}),
    ...(eventTraceContext.scopeRef ? { scopeRef: eventTraceContext.scopeRef } : {}),
    ...(eventTraceContext.workspaceId
      ? { workspaceId: eventTraceContext.workspaceId }
      : {}),
    ...(eventTraceContext.runtimeRef
      ? { runtimeRef: eventTraceContext.runtimeRef }
      : {}),
    ...(eventTraceContext.execution
      ? { execution: eventTraceContext.execution }
      : {}),
    ...(eventTraceContext.roleRef ? { roleRef: eventTraceContext.roleRef } : {}),
    timestamp: new Date().toISOString(),
    type: event.type,
    data: redactTraceValue(event.data ?? {}) as Record<string, unknown>,
  }
}

export async function createMatOSEventRecorder(
  cwd: string,
  metadata: CreateRecorderMetadata,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<MatOSEventRecorder> {
  const env = options.env ?? process.env
  const sessionId = metadata.sessionId ?? env.MATOS_SESSION_ID ?? randomUUID()
  const traceContext = createMatOSTraceContext({
    sessionId,
    env,
    metadata,
  })
  const sessionsDir = resolveMatOSSessionsDir(cwd)
  const path = join(sessionsDir, `${sessionId}.jsonl`)
  const evolutionProvider = resolveMatOSEvolutionProvider()

  await mkdir(sessionsDir, { recursive: true })
  let closed = false

  const recorder: MatOSEventRecorder = {
    sessionId,
    traceId: traceContext.traceId,
    traceContext,
    traceEnv: buildMatOSTraceEnv(traceContext),
    path,
    async record(event) {
      const fullEvent = createEvent(traceContext, event)
      const outcome = await appendMatOSSessionEvent(path, fullEvent)
      if (outcome === 'appended' && evolutionProvider.enabled) {
        void observeMatOSSelfEvolutionEvent({
          cwd,
          sessionId,
          sessionPath: path,
          event: fullEvent,
          hidden: metadata.hidden === true && metadata.userVisible === false,
        }).catch(() => {
          // Realtime self-evolution must never interrupt event recording.
        })
      }
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      try {
        await evolutionProvider.scheduleSessionCloseJobs({
          cwd,
          sessionId,
          sessionPath: path,
          hidden: metadata.hidden === true && metadata.userVisible === false,
        })
      } catch {
        // Background evolution must not interrupt the user-visible runtime path.
      }
    },
  }

  if (!metadata.suppressSessionStarted) {
    await recorder.record({
      type: 'matos.session.started',
      data: metadata,
    })
  }

  return recorder
}
