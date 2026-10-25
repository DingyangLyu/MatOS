import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildWorkflowEvidenceFromRunDir,
  writeWorkflowEvidence,
} from './workflowEvidence.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('workflow evolution evidence', () => {
  test('summarizes a recovered failed workflow run without raw logs or secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-evidence-'))
    const runDir = join(root, 'workflows', 'runs', 'run-recovered')
    await mkdir(join(runDir, 'node-runs', 'submit'), { recursive: true })
    await mkdir(join(runDir, 'node-runs', 'recover'), { recursive: true })
    await writeJson(join(runDir, 'run.json'), {
      runId: 'run-recovered',
      workflowRef: 'workflow:materials-batch-analysis@0.1.0',
      status: 'completed',
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:01:00.000Z',
    })
    await writeJson(join(runDir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'failed',
      attempts: 2,
      error: { message: 'bad yaml with API_KEY=secret-value' },
    })
    await writeJson(join(runDir, 'node-runs', 'recover', 'node-run.json'), {
      nodeId: 'recover',
      status: 'completed',
      attempts: 1,
      outputs: { stdout: 'raw secret-value log' },
    })
    await writeJson(join(runDir, 'artifacts.json'), [
      {
        id: 'report',
        nodeId: 'recover',
        path: '/workspace/group/shared/report.json',
        kind: 'file',
      },
    ])
    await writeFile(
      join(runDir, 'events.jsonl'),
      [
        JSON.stringify({
          id: 'event-1',
          type: 'workflow.node.failed',
          trace: { traceId: 'trace-workflow-recovered' },
          data: { token: 'secret-value' },
        }),
        JSON.stringify({ id: 'event-2', type: 'workflow.run.completed' }),
        '',
      ].join('\n'),
      'utf8',
    )

    const evidence = await buildWorkflowEvidenceFromRunDir({ cwd: root, runDir })
    expect(evidence).toMatchObject({
      runId: 'run-recovered',
      workflowRef: 'workflow:materials-batch-analysis@0.1.0',
      status: 'completed',
      traceId: 'trace-workflow-recovered',
      suggestedAssetTypes: ['workflow', 'benchmark', 'skill'],
      nodeSummary: [
        { nodeId: 'recover', status: 'completed', attempts: 1, hasError: false },
        { nodeId: 'submit', status: 'failed', attempts: 2, hasError: true },
      ],
      eventTypes: ['workflow.node.failed', 'workflow.run.completed'],
      artifactRefs: [
        {
          id: 'report',
          nodeId: 'recover',
          path: '/workspace/group/shared/report.json',
          kind: 'file',
        },
      ],
    })
    expect(evidence.sourceRefs).toEqual([
      'workflow-run:run-recovered',
      'workflow-event:run-recovered#event-1',
      'workflow-event:run-recovered#event-2',
    ])
    expect(JSON.stringify(evidence)).not.toContain('secret-value')

    const written = await writeWorkflowEvidence(root, evidence)
    expect(written.path).toContain('workflow-evidence-run-recovered.json')
  })

  test('includes recovery classification in failed workflow evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-evidence-recovery-'))
    const runDir = join(root, 'workflows', 'runs', 'run-schema-failed')
    await mkdir(join(runDir, 'node-runs', 'draft'), { recursive: true })
    await writeJson(join(runDir, 'run.json'), {
      runId: 'run-schema-failed',
      workflowRef: 'workflow:deep-research@0.7.0',
      status: 'failed',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:01:00.000Z',
      graphSnapshotPath: 'graph.snapshot.json',
      parameters: {},
    })
    await writeJson(join(runDir, 'graph.snapshot.json'), {
      schemaVersion: 1,
      name: 'deep-research',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'draft',
          type: 'agent',
          dependsOn: [],
          role: 'role:deep-research',
          prompt: 'Return JSON.',
        },
      ],
    })
    await writeJson(join(runDir, 'node-runs', 'draft', 'node-run.json'), {
      nodeId: 'draft',
      status: 'failed',
      attempts: 1,
      error: { message: 'Workflow node output schema failed: API_KEY=secret-value' },
    })
    await writeFile(
      join(runDir, 'events.jsonl'),
      [
        JSON.stringify({ id: 'event-1', type: 'workflow.node.failed' }),
        JSON.stringify({ id: 'event-2', type: 'workflow.run.status_changed' }),
        '',
      ].join('\n'),
      'utf8',
    )

    const evidence = await buildWorkflowEvidenceFromRunDir({ cwd: root, runDir })

    expect(evidence.recovery).toMatchObject({
      classification: 'schema_failure',
      recommendedAction: 'retry_node',
      nodeId: 'draft',
    })
    expect(evidence.recovery?.reason).toContain('output/schema validation')
    expect(JSON.stringify(evidence.recovery)).not.toContain('secret-value')
  })
})
