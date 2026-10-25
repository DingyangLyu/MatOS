import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { completeNode } from './nodeLifecycle.js'
import { writeNodeRun } from './runState.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
} from './workflowStore.js'
import type { MatOSWorkflowNode, WorkflowArtifactRef } from './types.js'

const PRODUCER_NODE: MatOSWorkflowNode = {
  id: 'producer',
  type: 'exec',
  dependsOn: [],
  command: 'true',
  artifactContract: { report: { path: 'report.txt' } },
}

async function createArtifactRun(prefix: string): Promise<{
  runDir: string
  artifactRoot: string
  reportPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const handle = await createWorkflowRun({
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:artifact-provenance@0.1.0',
    parameters: {},
    graphSnapshot: {
      schemaVersion: 1,
      name: 'artifact provenance',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [PRODUCER_NODE],
    },
    workspaceDir: root,
  })
  const snapshot = await readWorkflowRun(handle.dir)
  const artifactRoot = snapshot.artifactRoot ?? join(handle.dir, 'artifacts-root')
  await mkdir(artifactRoot, { recursive: true })
  return {
    runDir: handle.dir,
    artifactRoot,
    reportPath: join(artifactRoot, 'report.txt'),
  }
}

async function readArtifacts(runDir: string): Promise<WorkflowArtifactRef[]> {
  return JSON.parse(
    await readFile(join(runDir, 'artifacts.json'), 'utf8'),
  ) as WorkflowArtifactRef[]
}

describe('workflow node artifact provenance', () => {
  // Regression for engine review defect P1-3: recordNodeArtifacts deduped
  // artifacts by id/path and skipped re-registration entirely, so after a
  // node retry the artifact file held attempt-2 bytes while artifacts.json
  // still attributed attempt 1 (and any recorded hash described overwritten
  // content).
  test('retry re-registration re-attributes the artifact to the producing attempt', async () => {
    const { runDir, reportPath } = await createArtifactRun(
      'matos-artifact-reattribute-',
    )

    await writeFile(reportPath, 'attempt-1 report bytes\n', 'utf8')
    await writeNodeRun(runDir, {
      nodeId: 'producer',
      status: 'running',
      attempts: 1,
      updatedAt: new Date().toISOString(),
    })
    await completeNode(runDir, PRODUCER_NODE, { exitCode: 0 })

    const firstRegistration = await readArtifacts(runDir)
    expect(firstRegistration).toHaveLength(1)
    expect(firstRegistration[0]).toMatchObject({
      id: 'report',
      nodeId: 'producer',
      attempt: 1,
      path: reportPath,
    })

    const attempt2Bytes = 'attempt-2 report bytes rewritten by the retry\n'
    await writeFile(reportPath, attempt2Bytes, 'utf8')
    await writeNodeRun(runDir, {
      nodeId: 'producer',
      status: 'running',
      attempts: 2,
      updatedAt: new Date().toISOString(),
    })
    await completeNode(runDir, PRODUCER_NODE, { exitCode: 0 })

    const artifacts = await readArtifacts(runDir)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      id: 'report',
      nodeId: 'producer',
      attempt: 2,
      path: reportPath,
      sha256: createHash('sha256').update(attempt2Bytes).digest('hex'),
      sizeBytes: Buffer.byteLength(attempt2Bytes),
    })

    const events = await readWorkflowRunEvents(runDir)
    const createdEvents = events.filter(
      event => event.type === 'workflow.artifact.created',
    )
    const updatedEvents = events.filter(
      event => event.type === 'workflow.artifact.updated',
    )
    expect(createdEvents).toHaveLength(1)
    expect(createdEvents[0]?.data).toMatchObject({ id: 'report', attempt: 1 })
    expect(updatedEvents).toHaveLength(1)
    expect(updatedEvents[0]?.data).toMatchObject({
      id: 'report',
      attempt: 2,
      previousAttempt: 1,
    })
  })

  test('same-attempt re-registration stays a no-op', async () => {
    const { runDir, reportPath } = await createArtifactRun(
      'matos-artifact-idempotent-',
    )
    await writeFile(reportPath, 'stable bytes\n', 'utf8')
    await writeNodeRun(runDir, {
      nodeId: 'producer',
      status: 'running',
      attempts: 1,
      updatedAt: new Date().toISOString(),
    })
    await completeNode(runDir, PRODUCER_NODE, { exitCode: 0 })
    await completeNode(runDir, PRODUCER_NODE, { exitCode: 0 })

    const artifacts = await readArtifacts(runDir)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ id: 'report', attempt: 1 })
    // First registration keeps the cheap no-hash path.
    expect(artifacts[0]?.sha256).toBeUndefined()
    const events = await readWorkflowRunEvents(runDir)
    expect(
      events.filter(event => event.type === 'workflow.artifact.updated'),
    ).toHaveLength(0)
  })
})
