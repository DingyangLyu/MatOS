import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMatOSEvolutionProvider } from '../learning/evolutionProvider.js'
import { observeMatOSSelfEvolutionEvent } from '../learning/evolutionMonitor.js'
import { appendMatOSSessionEvent } from './eventStorage.js'
import type { MatOSEvent, MatOSEventInput } from './eventTypes.js'
import { resolveMatOSSessionsDir } from './sessionPaths.js'
import { redactTraceValue, traceContextFromEnv } from './traceContext.js'

function createTraceEventFromEnv(
  event: MatOSEventInput,
  env: NodeJS.ProcessEnv,
): MatOSEvent | undefined {
  const traceContext = traceContextFromEnv(env)
  if (!traceContext?.sessionId) {
    return undefined
  }
  const eventTraceContext = {
    ...traceContext,
    ...Object.fromEntries(
      Object.entries(event.traceContext ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  } as typeof traceContext
  return {
    id: randomUUID(),
    schemaVersion: eventTraceContext.schemaVersion,
    traceId: eventTraceContext.traceId,
    sessionId: eventTraceContext.sessionId ?? traceContext.sessionId,
    ...(eventTraceContext.parentSessionId
      ? { parentSessionId: eventTraceContext.parentSessionId }
      : {}),
    ...(eventTraceContext.turnId ? { turnId: eventTraceContext.turnId } : {}),
    ...(eventTraceContext.userId ? { userId: eventTraceContext.userId } : {}),
    ...(eventTraceContext.scopeRef
      ? { scopeRef: eventTraceContext.scopeRef }
      : {}),
    ...(eventTraceContext.workspaceId
      ? { workspaceId: eventTraceContext.workspaceId }
      : {}),
    ...(eventTraceContext.runtimeRef
      ? { runtimeRef: eventTraceContext.runtimeRef }
      : {}),
    ...(eventTraceContext.execution
      ? { execution: eventTraceContext.execution }
      : {}),
    ...(eventTraceContext.roleRef
      ? { roleRef: eventTraceContext.roleRef }
      : {}),
    timestamp: new Date().toISOString(),
    type: event.type,
    data: redactTraceValue(event.data ?? {}) as Record<string, unknown>,
  }
}

export async function recordMatOSTraceEventFromEnv(
  event: MatOSEventInput,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  cwd ??= env.MATOS_PROJECT_CWD || process.cwd()
  try {
    const fullEvent = createTraceEventFromEnv(event, env)
    if (!fullEvent) {
      return false
    }
    const sessionsDir = resolveMatOSSessionsDir(cwd)
    await mkdir(sessionsDir, { recursive: true })
    const outcome = await appendMatOSSessionEvent(
      join(sessionsDir, `${fullEvent.sessionId}.jsonl`),
      fullEvent,
    )
    const evolutionProvider = resolveMatOSEvolutionProvider()
    if (outcome === 'appended' && evolutionProvider.enabled) {
      void observeMatOSSelfEvolutionEvent({
        cwd,
        sessionId: fullEvent.sessionId,
        sessionPath: join(sessionsDir, `${fullEvent.sessionId}.jsonl`),
        event: fullEvent,
        hidden: env.MATOS_INTERNAL_HIDDEN_RUN === '1',
      }).catch(() => {
        // Realtime self-evolution must never interrupt inherited trace writes.
      })
    }
    return true
  } catch {
    return false
  }
}
