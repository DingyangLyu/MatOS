import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunSnapshot,
} from './types.js'
import { scrubSecretsFromString } from '../sessions/traceContext.js'

const CONTROLLER_SECRET_ASSIGNMENT =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|passwd|credential)\b\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi

export function redactWorkflowControllerFailureText(
  error: unknown,
  maxLength = 1_000,
): string {
  const raw = error instanceof Error ? error.message : String(error)
  return scrubSecretsFromString(raw)
    .replace(CONTROLLER_SECRET_ASSIGNMENT, '$1[redacted]')
    .slice(0, maxLength)
}

export type WorkflowRunPersistedEvent = {
  runDir: string
  snapshot: MatOSWorkflowRunSnapshot
  phase: 'created' | 'updated'
}

export type WorkflowRunObserver = (
  event: WorkflowRunPersistedEvent,
) => void | Promise<void>

export type WorkflowRunObserverOptions = {
  /** A rejected creation observer prevents the run from being returned. */
  failClosedOnCreate?: boolean
}

const observers = new Map<
  string,
  { observer: WorkflowRunObserver; options: WorkflowRunObserverOptions }
>()

export type WorkflowReadySetAdviceInput = {
  runDir: string
  snapshot: MatOSWorkflowRunSnapshot
  definition: MatOSWorkflowDefinition
  nodeRuns: ReadonlyMap<string, MatOSWorkflowNodeRunSnapshot>
  readyNodeIds: readonly string[]
}

export type WorkflowReadySetAdvice = {
  orderedNodeIds: readonly string[]
  directive?: {
    status: 'paused' | 'failed'
    reason: string
  }
}

export type WorkflowReadySetAdvisor = (
  input: WorkflowReadySetAdviceInput,
) => WorkflowReadySetAdvice | Promise<WorkflowReadySetAdvice>

const readySetAdvisors = new Map<string, WorkflowReadySetAdvisor>()

export function registerWorkflowRunObserver(
  id: string,
  observer: WorkflowRunObserver,
  options: WorkflowRunObserverOptions = {},
): () => void {
  const normalized = id.trim()
  if (!normalized) throw new Error('Workflow run observer id is required')
  const registration = { observer, options }
  observers.set(normalized, registration)
  return () => {
    if (observers.get(normalized) === registration) observers.delete(normalized)
  }
}

export async function notifyWorkflowRunPersisted(
  event: WorkflowRunPersistedEvent,
): Promise<void> {
  const registrations = [...observers.values()]
  const settled = await Promise.allSettled(
    registrations.map(({ observer }) =>
      Promise.resolve().then(() => observer(event)),
    ),
  )
  if (event.phase !== 'created') return
  const failedCriticalIndex = settled.findIndex(
    (result, index) =>
      result.status === 'rejected' &&
      registrations[index]?.options.failClosedOnCreate === true,
  )
  if (failedCriticalIndex < 0) return
  const failed = settled[failedCriticalIndex]
  if (failed?.status === 'rejected') {
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error(String(failed.reason))
  }
}

export function registerWorkflowReadySetAdvisor(
  id: string,
  advisor: WorkflowReadySetAdvisor,
): () => void {
  const normalized = id.trim()
  if (!normalized) throw new Error('Workflow ready-set advisor id is required')
  readySetAdvisors.set(normalized, advisor)
  return () => {
    if (readySetAdvisors.get(normalized) === advisor) {
      readySetAdvisors.delete(normalized)
    }
  }
}

function assertExactReadySetPermutation(
  expected: readonly string[],
  actual: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some(nodeId => !expected.includes(nodeId))
  ) {
    throw new Error(
      'Workflow ready-set advisor must return every current ready node exactly once',
    )
  }
}

/**
 * Generic workflow extension boundary. Advisors may reorder the already-safe
 * ready set or request a fail-closed pause/failure. They cannot add nodes,
 * execute tools, or mutate run state through this API.
 */
export async function adviseWorkflowReadySet(
  input: WorkflowReadySetAdviceInput,
): Promise<WorkflowReadySetAdvice> {
  if (
    input.definition.policy.controller?.enabled !== false &&
    input.definition.policy.controller !== undefined &&
    readySetAdvisors.size === 0
  ) {
    throw new Error('Configured workflow controller has no registered advisor')
  }
  let orderedNodeIds = [...input.readyNodeIds]
  let directive: WorkflowReadySetAdvice['directive']
  for (const advisor of readySetAdvisors.values()) {
    const advice = await advisor({ ...input, readyNodeIds: orderedNodeIds })
    assertExactReadySetPermutation(orderedNodeIds, advice.orderedNodeIds)
    orderedNodeIds = [...advice.orderedNodeIds]
    if (advice.directive) {
      directive = advice.directive
      break
    }
  }
  return {
    orderedNodeIds,
    ...(directive ? { directive } : {}),
  }
}
