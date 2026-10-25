import type { MatOSEventSource } from '../sessions/eventTypes.js'
import type { MatOSSelfEvolutionTrigger } from './evolutionMonitor.js'
import { isMatOSExpectedToolGuardEvent } from './evolutionExpectedToolGuards.js'
import { classifyPromptUserFeedbackSignal } from './evolutionMonitorFeedback.js'

const TRIVIAL_SUCCESSFUL_SESSION_EVENT_TYPES = new Set([
  'matos.session.started',
  'matos.session.completed',
  'matos.workspace.start.requested',
  'matos.workspace.started',
  'matos.workspace.stopped',
  'matos.workspace.restarted',
  'matos.workspace.doctor.completed',
  'matos.workspace.pruned',
  'matos.workspace.project.attached',
])

function eventDataExitCode(event: MatOSEventSource): number | undefined {
  const exitCode = event.data?.exitCode
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) {
    return exitCode
  }
  if (typeof exitCode === 'string' && exitCode.trim() !== '') {
    const parsed = Number(exitCode)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function eventDataFieldHasContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim() !== ''
  }
  if (value === undefined || value === null) {
    return false
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return typeof value === 'object' || value === true
}

// Structured failure detection only. The previous serialized-substring check
// (`serialized.includes('error')`) was defeated by benign zero counters such as
// `"errorCount":0`, which blocked the trivial-session skip and started hidden
// LLM work for successful workspace lifecycle sessions.
function eventDataHasFailureSignal(event: MatOSEventSource): boolean {
  const data = event.data ?? {}
  const exitCode = eventDataExitCode(event)
  return (
    event.type.includes('failed') ||
    event.type.includes('failure') ||
    event.type.includes('error') ||
    data.isError === true ||
    (exitCode !== undefined && exitCode !== 0) ||
    eventDataFieldHasContent(data.error) ||
    eventDataFieldHasContent(data.errorMessage)
  )
}

export function shouldSkipTrivialSuccessfulSessionEvolution(input: {
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
}): boolean {
  if (input.trigger.kind !== 'session-end' || input.events.length === 0) {
    return false
  }
  const completedEvents = input.events.filter(
    event => event.type === 'matos.session.completed',
  )
  if (completedEvents.length === 0) {
    return false
  }
  if (
    completedEvents.some(event => {
      const exitCode = eventDataExitCode(event)
      return exitCode !== undefined && exitCode !== 0
    })
  ) {
    return false
  }
  if (
    input.events.every(
      event =>
        TRIVIAL_SUCCESSFUL_SESSION_EVENT_TYPES.has(event.type) &&
        !eventDataHasFailureSignal(event),
    )
  ) {
    return true
  }
  return isMinimalSignalSuccessfulSession(input.events)
}

// Minimum-signal gate: a successful single-turn session with no failure
// signals and no feedback-looking prompt has nothing to learn from. Sentinel
// and smoke runs ("Reply with exactly: ...") previously paid a full hidden
// session-close pipeline (worker + shared prefix + critic) for zero yield.
function isMinimalSignalSuccessfulSession(
  events: MatOSEventSource[],
): boolean {
  let turnCount = 0
  for (const event of events) {
    if (eventDataHasFailureSignal(event)) {
      return false
    }
    // Expected-guard outcomes (e.g. a submit blocked by active_task_collision)
    // carry no isError/error fields, so they look "successful" here — but the
    // trigger quality gate owns them: it records a deterministic
    // 'expected-tool-guard-only' skip (no LLM spend) instead of this gate's
    // silent drop. Swallowing them here erased that operator-visible record.
    if (isMatOSExpectedToolGuardEvent(event)) {
      return false
    }
    if (event.type === 'matos.turn.started') {
      turnCount += 1
      if (turnCount > 1) {
        return false
      }
      const prompt = event.data?.prompt ?? event.data?.promptPreview
      if (
        typeof prompt === 'string' &&
        classifyPromptUserFeedbackSignal(prompt) !== 'none'
      ) {
        return false
      }
    }
  }
  return turnCount <= 1
}
