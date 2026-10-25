import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMatOSDir } from '../project.js'
import { recoverWorkflowRun } from '../workflows/recovery.js'

export type MatOSWorkflowEvidence = {
  schemaVersion: 1
  evidenceId: string
  runId: string
  workflowRef: string
  status: string
  traceId?: string
  sessionId?: string
  sourceRefs: string[]
  nodeSummary: Array<{
    nodeId: string
    status: string
    attempts: number
    hasError: boolean
  }>
  eventTypes: string[]
  artifactRefs: Array<{
    id?: string
    nodeId?: string
    path?: string
    kind?: string
  }>
  recovery?: {
    classification: string
    recommendedAction: string
    nodeId?: string
    reason: string
  }
  suggestedAssetTypes: Array<'workflow' | 'benchmark' | 'skill' | 'knowledge'>
  occurrenceCount?: number
  relatedEvidenceIds?: string[]
  relatedRunIds?: string[]
  replayCandidateIds?: string[]
  createdAt: string
  path?: string
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function workflowEvidenceDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'learning', 'workflow-evidence')
}

function evidencePath(cwd: string, evidenceId: string): string {
  return join(workflowEvidenceDir(cwd), `${evidenceId}.json`)
}

export async function readWorkflowEvidence(
  cwd: string,
  evidenceId: string,
): Promise<MatOSWorkflowEvidence | undefined> {
  const path = evidencePath(cwd, evidenceId)
  if (!(await pathExists(path))) {
    return undefined
  }
  return { ...(await readJson<MatOSWorkflowEvidence>(path)), path }
}

export async function listWorkflowEvidence(
  cwd: string,
): Promise<MatOSWorkflowEvidence[]> {
  const dir = workflowEvidenceDir(cwd)
  if (!(await pathExists(dir))) {
    return []
  }
  const records: MatOSWorkflowEvidence[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const path = join(dir, entry.name)
    records.push({ ...(await readJson<MatOSWorkflowEvidence>(path)), path })
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function eventTypes(events: Array<{ type?: unknown }>): string[] {
  return [...new Set(events.map(event => String(event.type || '')).filter(Boolean))].sort()
}

function sourceRefsFor(runId: string, events: Array<{ id?: unknown }>): string[] {
  return events
    .filter(event => typeof event.id === 'string')
    .map(event => `workflow-event:${runId}#${event.id}`)
}

function traceIdFrom(events: Array<Record<string, unknown>>): string | undefined {
  for (const event of events) {
    const trace =
      event.trace && typeof event.trace === 'object' && !Array.isArray(event.trace)
        ? (event.trace as Record<string, unknown>)
        : undefined
    if (typeof trace?.traceId === 'string') {
      return trace.traceId
    }
    if (typeof event.traceId === 'string') {
      return event.traceId
    }
  }
  return undefined
}

function artifactRefsFrom(
  artifacts: Array<Record<string, unknown>>,
): MatOSWorkflowEvidence['artifactRefs'] {
  return artifacts.map(artifact => ({
    ...(typeof artifact.id === 'string' ? { id: artifact.id } : {}),
    ...(typeof artifact.nodeId === 'string' ? { nodeId: artifact.nodeId } : {}),
    ...(typeof artifact.path === 'string' ? { path: artifact.path } : {}),
    ...(typeof artifact.kind === 'string' ? { kind: artifact.kind } : {}),
  }))
}

export function redactedWorkflowEvidenceText(value: string): string {
  return value
    .replace(
      /([?&](?:token|secret|password|api[-_]?key|auth|authorization|credential|key)=)[^&#\s"'<>]+/gi,
      '$1[redacted]',
    )
    .replace(
      /([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASS|API[-_]?KEY|AUTH|CREDENTIAL)[A-Z0-9_-]*)(\s*[=:]\s*)[^\s"',}]+/gi,
      '$1$2[redacted]',
    )
}

const redactedText = redactedWorkflowEvidenceText

async function recoverySummaryFromRunDir(
  runDir: string,
): Promise<MatOSWorkflowEvidence['recovery'] | undefined> {
  try {
    const recovery = await recoverWorkflowRun(runDir)
    return {
      classification: recovery.classification,
      recommendedAction: recovery.recommendedAction,
      ...(recovery.nodeId ? { nodeId: recovery.nodeId } : {}),
      reason: redactedText(recovery.reason),
    }
  } catch {
    return undefined
  }
}

export async function buildWorkflowEvidenceFromRunDir(input: {
  cwd: string
  runDir: string
}): Promise<MatOSWorkflowEvidence> {
  const run = await readJson<Record<string, unknown>>(join(input.runDir, 'run.json'))
  const eventsRaw = await readFile(join(input.runDir, 'events.jsonl'), 'utf8').catch(
    () => '',
  )
  const events = eventsRaw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const artifactValues = (
    await readJson<unknown[]>(join(input.runDir, 'artifacts.json')).catch(() => [])
  )
  const artifacts = artifactValues.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  ) as Record<string, unknown>[]
  const nodeSummary: MatOSWorkflowEvidence['nodeSummary'] = []
  const nodeRunsDir = join(input.runDir, 'node-runs')
  if (await pathExists(nodeRunsDir)) {
    for (const entry of await readdir(nodeRunsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      const nodeRun = await readJson<Record<string, unknown>>(
        join(nodeRunsDir, entry.name, 'node-run.json'),
      )
      nodeSummary.push({
        nodeId: String(nodeRun.nodeId || entry.name),
        status: String(nodeRun.status || 'unknown'),
        attempts: typeof nodeRun.attempts === 'number' ? nodeRun.attempts : 0,
        hasError: nodeRun.error !== undefined,
      })
    }
  }
  const runId = String(run.runId)
  const failed = nodeSummary.some(node => node.status === 'failed')
  const recovered = failed && String(run.status) === 'completed'
  const traceId = traceIdFrom(events)
  const recovery = await recoverySummaryFromRunDir(input.runDir)
  return {
    schemaVersion: 1,
    evidenceId: `workflow-evidence-${runId}`,
    runId,
    workflowRef: String(run.workflowRef),
    status: String(run.status),
    ...(traceId ? { traceId } : {}),
    sourceRefs: [`workflow-run:${runId}`, ...sourceRefsFor(runId, events)],
    nodeSummary: nodeSummary.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    eventTypes: eventTypes(events),
    artifactRefs: artifactRefsFrom(artifacts),
    ...(recovery ? { recovery } : {}),
    suggestedAssetTypes: recovered
      ? ['workflow', 'benchmark', 'skill']
      : ['workflow', 'benchmark'],
    createdAt: new Date().toISOString(),
  }
}

export async function writeWorkflowEvidence(
  cwd: string,
  evidence: MatOSWorkflowEvidence,
): Promise<MatOSWorkflowEvidence> {
  const path = evidencePath(cwd, evidence.evidenceId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return { ...evidence, path }
}
