import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import {
  MATOS_ALGORITHM_SERIALIZED_INPUT_MAX_BYTES,
  serializeMatOSAlgorithmInput,
} from './serialization.js'

/**
 * Opt-in capture of real decision inputs for replay datasets.
 *
 * With `MATOS_ALGO_CAPTURE=1`, every decision on a serializable surface
 * appends `{at, surfaceId, providerId, inputDigest, input, decision}` to
 * `.matos/algorithms/captures/<surfaceId>.jsonl`. Inputs pass through the
 * per-surface serialization allowlist, so runtime handles and env values are
 * never written. Capture is disabled by default and must never fail or slow
 * the decision path.
 */

const CAPTURE_FILE_MAX_BYTES = 64 * 1024 * 1024

export type MatOSAlgorithmCaptureRecord = {
  schemaVersion: 1
  decisionId: string
  at: string
  surfaceId: string
  providerId: string
  inputDigest?: string
  input: Record<string, unknown>
  decision: unknown
  traceId?: string
  sessionId?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
  scopeRef?: string
}

function safeName(surfaceId: string): string {
  return surfaceId.replace(/[^a-z0-9-]+/gi, '-')
}

export function matOSAlgorithmCapturePath(
  cwd: string,
  surfaceId: string,
): string {
  return join(
    getMatOSDir(cwd),
    'algorithms',
    'captures',
    `${safeName(surfaceId)}.jsonl`,
  )
}

export function matOSAlgorithmCaptureEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = (env.MATOS_ALGO_CAPTURE ?? process.env.MATOS_ALGO_CAPTURE ?? '')
    .trim()
    .toLowerCase()
  return ['1', 'on', 'true'].includes(raw)
}

export function captureMatOSAlgorithmDecision(input: {
  cwd: string
  decisionId: string
  surfaceId: string
  providerId: string
  inputDigest?: string
  rawInput: unknown
  decision: unknown
  traceId?: string
  sessionId?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
  scopeRef?: string
}): void {
  const serialized = serializeMatOSAlgorithmInput(
    input.surfaceId,
    input.rawInput,
  )
  if (!serialized) {
    return
  }
  const record: MatOSAlgorithmCaptureRecord = {
    schemaVersion: 1,
    decisionId: input.decisionId,
    at: new Date().toISOString(),
    surfaceId: input.surfaceId,
    providerId: input.providerId,
    ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
    input: serialized,
    decision: input.decision,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
  }
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    return
  }
  if (line.length > MATOS_ALGORITHM_SERIALIZED_INPUT_MAX_BYTES) {
    return
  }
  const path = matOSAlgorithmCapturePath(input.cwd, input.surfaceId)
  void (async () => {
    try {
      const existing = await stat(path).catch(() => undefined)
      if (existing && existing.size > CAPTURE_FILE_MAX_BYTES) {
        return
      }
      await mkdir(join(getMatOSDir(input.cwd), 'algorithms', 'captures'), {
        recursive: true,
      })
      await appendFile(path, `${line}\n`, 'utf8')
    } catch {
      // Capture must never fail the decision path.
    }
  })()
}

export async function readMatOSAlgorithmCaptures(
  cwd: string,
  surfaceId: string,
): Promise<MatOSAlgorithmCaptureRecord[]> {
  const path = matOSAlgorithmCapturePath(cwd, surfaceId)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const records: MatOSAlgorithmCaptureRecord[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as MatOSAlgorithmCaptureRecord
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.surfaceId === surfaceId &&
        parsed.input &&
        typeof parsed.input === 'object'
      ) {
        records.push(parsed)
      }
    } catch {
      // Skip corrupt lines instead of failing the read.
    }
  }
  return records
}
