import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { startWorkflowRun } from '../workflows/workflowRuntime.js'
import { normalizeMatOSBenchmarkCase } from './benchmarkSchema.js'
import {
  generateMatOSWorkflowReplayCandidate,
  listMatOSStableImprovementCandidates,
  listMatOSWorkflowReplayCandidates,
  listMatOSWorkflowReplayClusters,
  maintainMatOSStableImprovementCandidates,
  maintainMatOSWorkflowReplayClusters,
  readMatOSWorkflowReplayCandidate,
  replayCandidateIdForRun,
  replayCandidateIsAutoVerifiable,
  replayClusterIdForSignature,
  stableImprovementIdForSignature,
  verifyMatOSWorkflowReplayCandidate,
} from './replayCandidates.js'
import { buildWorkflowEvidenceFromRunDir } from './workflowEvidence.js'

async function runFailingWorkflow(root: string) {
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  return startWorkflowRun({
    cwd: root,
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:replay-fixture@0.1.0',
    workspaceDir: workspace,
    parameters: {
      sections: 3,
      apiKey: 'super-secret-value-123456',
      note: 'API_KEY=super-secret-value-123456',
    },
    definition: {
      schemaVersion: 1,
      name: 'replay-fixture',
      parameters: {
        sections: { type: 'number', default: 3 },
        apiKey: { type: 'string', default: '' },
        note: { type: 'string', default: '' },
      },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' },
        {
          id: 'broken_step',
          type: 'exec',
          dependsOn: ['prepare'],
          command: 'printf broken >&2; exit 3',
        },
      ],
    },
  })
}

describe('MatOS workflow replay candidates', () => {
  test('materializes deterministic replay candidate drafts from a real failed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-replay-candidate-'))
    const run = await runFailingWorkflow(root)
    expect(run.status).toBe('failed')

    const evidence = await buildWorkflowEvidenceFromRunDir({
      cwd: root,
      runDir: run.runDir,
    })
    const candidate = await generateMatOSWorkflowReplayCandidate({
      cwd: root,
      evidence,
      runDir: run.runDir,
    })
    expect(candidate).toBeDefined()
    expect(candidate?.trigger).toBe('workflow-failed')
    expect(candidate?.workflowRef).toBe('workflow:replay-fixture@0.1.0')
    expect(candidate?.candidateId).toBe(replayCandidateIdForRun(run.runId))
    expect(candidate?.failedNodeIds).toEqual(['broken_step'])
    expect(candidate?.failureSignature).toMatch(/^[0-9a-f]{64}$/)
    expect(candidate?.provenance.evidenceRef).toBe(
      `workflow-evidence:${evidence.evidenceId}`,
    )

    const dir = join(
      root,
      '.matos',
      'evolution',
      'replay-candidates',
      candidate?.candidateId ?? '',
    )
    const signature = JSON.parse(
      await readFile(join(dir, 'failure_signature.json'), 'utf8'),
    )
    expect(signature.signature).toBe(candidate?.failureSignature)
    expect(signature.failedNodes).toMatchObject([
      { nodeId: 'broken_step', status: 'failed' },
    ])

    const repair = JSON.parse(
      await readFile(join(dir, 'repair_strategy.json'), 'utf8'),
    )
    expect(typeof repair.classification).toBe('string')
    expect(typeof repair.recommendedAction).toBe('string')

    const replayPlan = JSON.parse(
      await readFile(join(dir, 'replay_plan.json'), 'utf8'),
    )
    expect(replayPlan.workflowRef).toBe('workflow:replay-fixture@0.1.0')
    expect(replayPlan.expect.reproducesFailureSignature).toBe(
      candidate?.failureSignature,
    )
    expect(replayPlan.parameters.apiKey).toBe('[redacted]')
    expect(JSON.stringify(replayPlan)).not.toContain('super-secret-value-123456')

    const caseRaw = JSON.parse(
      await readFile(join(dir, 'benchmark', 'case.json'), 'utf8'),
    )
    expect(JSON.stringify(caseRaw)).not.toContain('super-secret-value-123456')
    const normalized = normalizeMatOSBenchmarkCase(caseRaw)
    expect(normalized.kind).toBe('workflow-run')
    expect(normalized.subjectRefs).toEqual(['workflow:replay-fixture@0.1.0'])
    expect(
      normalized.checks.some(check => check.type === 'secret-scan'),
    ).toBe(true)

    const second = await generateMatOSWorkflowReplayCandidate({
      cwd: root,
      evidence,
      runDir: run.runDir,
    })
    expect(second?.failureSignature).toBe(candidate?.failureSignature)
    expect(second?.createdAt).toBe(candidate?.createdAt ?? '')

    const listed = await listMatOSWorkflowReplayCandidates(root)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.candidateId).toBe(candidate?.candidateId ?? '')
    const read = await readMatOSWorkflowReplayCandidate(
      root,
      candidate?.candidateId ?? '',
    )
    expect(read?.benchmarkCaseId).toBe(candidate?.benchmarkCaseId)
  })

  test('skips clean completed runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-replay-clean-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:replay-clean@0.1.0',
      workspaceDir: workspace,
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'replay-clean',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' },
        ],
      },
    })
    expect(run.status).toBe('completed')

    const evidence = await buildWorkflowEvidenceFromRunDir({
      cwd: root,
      runDir: run.runDir,
    })
    expect(
      await generateMatOSWorkflowReplayCandidate({
        cwd: root,
        evidence,
        runDir: run.runDir,
      }),
    ).toBeUndefined()
    expect(await listMatOSWorkflowReplayCandidates(root)).toHaveLength(0)
  })

  test('clusters repeated same-signature failures and gates a reproduced improvement candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-replay-cluster-'))

    // Two real failed runs of the same workflow produce the same signature.
    const first = await runFailingWorkflow(root)
    const second = await runFailingWorkflow(root)
    expect(first.status).toBe('failed')
    expect(second.status).toBe('failed')

    for (const run of [first, second]) {
      const evidence = await buildWorkflowEvidenceFromRunDir({
        cwd: root,
        runDir: run.runDir,
      })
      const candidate = await generateMatOSWorkflowReplayCandidate({
        cwd: root,
        evidence,
        runDir: run.runDir,
      })
      expect(candidate).toBeDefined()
    }

    // One incident alone must not create a cluster; the second one does.
    const clusters = await maintainMatOSWorkflowReplayClusters(root)
    expect(clusters).toHaveLength(1)
    const cluster = clusters[0]
    expect(cluster?.clusterId).toBe(
      replayClusterIdForSignature(cluster?.failureSignature ?? ''),
    )
    expect(cluster?.occurrences).toBe(2)
    expect(cluster?.workflowRef).toBe('workflow:replay-fixture@0.1.0')
    expect(cluster?.proposal.kind).toBe('repeated-failure')
    expect(await listMatOSWorkflowReplayClusters(root)).toHaveLength(1)

    // No reproduced replay yet: no improvement candidate may exist.
    expect(await maintainMatOSStableImprovementCandidates(root)).toHaveLength(0)

    // Verify one candidate through a real local rerun of the same workflow.
    const candidateId = replayCandidateIdForRun(first.runId)
    const verified = await verifyMatOSWorkflowReplayCandidate({
      cwd: root,
      candidateId,
      definition: {
        nodes: [
          { type: 'exec', sideEffect: { replaySafe: true } },
          { type: 'exec', sideEffect: { replaySafe: true } },
        ],
      },
      runWorkflow: async ({ workflowRef, parameters }) => {
        expect(workflowRef).toBe('workflow:replay-fixture@0.1.0')
        const replay = await startWorkflowRun({
          cwd: root,
          workflowsDir: join(root, 'workflows'),
          workflowRef,
          workspaceDir: join(root, 'workspace'),
          parameters,
          definition: {
            schemaVersion: 1,
            name: 'replay-fixture',
            parameters: {
              sections: { type: 'number', default: 3 },
              apiKey: { type: 'string', default: '' },
              note: { type: 'string', default: '' },
            },
            policy: { approvalMode: 'bypass', defaultRisk: 'low' },
            outputs: {},
            nodes: [
              { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' },
              {
                id: 'broken_step',
                type: 'exec',
                dependsOn: ['prepare'],
                command: 'printf broken >&2; exit 3',
              },
            ],
          },
        })
        return {
          runId: replay.runId,
          status: replay.status,
          failedNodeIds: (replay.nodes ?? [])
            .filter(node => node.status === 'failed')
            .map(node => node.nodeId),
        }
      },
    })
    expect(verified?.verification?.status).toBe('reproduced')
    expect(verified?.verification?.signatureMatch).toBe(true)

    const resultPath = join(
      root,
      '.matos',
      'evolution',
      'replay-candidates',
      candidateId,
      'benchmark',
      'result.json',
    )
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    expect(result.reproduced).toBe(true)
    expect(result.replayFailedNodeIds).toEqual(['broken_step'])

    // Reproduced cluster materializes exactly one promotion-gated record.
    const improvements = await maintainMatOSStableImprovementCandidates(root)
    expect(improvements).toHaveLength(1)
    const improvement = improvements[0]
    expect(improvement?.id).toBe(
      stableImprovementIdForSignature(cluster?.failureSignature ?? ''),
    )
    expect(improvement?.status).toBe('awaiting-promotion')
    expect(improvement?.gates.promotion.status).toBe('blocked')
    expect(improvement?.draftRefs.replayCandidateIds).toContain(candidateId)
    expect(improvement?.evidence.reproducedRunIds.length).toBeGreaterThan(0)
    expect(await listMatOSStableImprovementCandidates(root)).toHaveLength(1)
  })

  test('does not treat waiting-for-human runs as replayable failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-replay-waiting-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:replay-waiting@0.1.0',
      workspaceDir: workspace,
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'replay-waiting',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['prepare'],
            prompt: 'Approve?',
            responseSchema: { type: 'object' },
          },
        ],
      },
    })
    expect(run.status).toBe('waiting_input')

    const evidence = await buildWorkflowEvidenceFromRunDir({
      cwd: root,
      runDir: run.runDir,
    })
    expect(
      await generateMatOSWorkflowReplayCandidate({
        cwd: root,
        evidence,
        runDir: run.runDir,
      }),
    ).toBeUndefined()
    expect(await listMatOSWorkflowReplayCandidates(root)).toHaveLength(0)
  })

  test('marks agent or backend workflows skipped-unsafe instead of replaying them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-replay-unsafe-'))
    const run = await runFailingWorkflow(root)
    const evidence = await buildWorkflowEvidenceFromRunDir({
      cwd: root,
      runDir: run.runDir,
    })
    const candidate = await generateMatOSWorkflowReplayCandidate({
      cwd: root,
      evidence,
      runDir: run.runDir,
    })
    expect(candidate).toBeDefined()

    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'exec' }, { type: 'guard' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'exec', sideEffect: { replaySafe: true } }, { type: 'guard' }],
      }),
    ).toBe(true)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'exec' }, { type: 'agent' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'backend' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'compute' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'dynamic' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'map' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'loop' }],
      }),
    ).toBe(false)
    expect(
      replayCandidateIsAutoVerifiable({
        nodes: [{ type: 'subworkflow' }],
      }),
    ).toBe(false)
    expect(replayCandidateIsAutoVerifiable({ nodes: [] })).toBe(false)

    let replayInvoked = false
    const skipped = await verifyMatOSWorkflowReplayCandidate({
      cwd: root,
      candidateId: candidate?.candidateId ?? '',
      definition: { nodes: [{ type: 'exec' }, { type: 'agent' }] },
      runWorkflow: async () => {
        replayInvoked = true
        return { runId: 'should-not-run', status: 'failed', failedNodeIds: [] }
      },
    })
    expect(replayInvoked).toBe(false)
    expect(skipped?.verification?.status).toBe('skipped-unsafe')

    const skippedExec = await verifyMatOSWorkflowReplayCandidate({
      cwd: root,
      candidateId: candidate?.candidateId ?? '',
      definition: { nodes: [{ type: 'exec' }, { type: 'guard' }] },
      runWorkflow: async () => {
        replayInvoked = true
        return { runId: 'should-not-run-exec', status: 'failed', failedNodeIds: [] }
      },
    })
    expect(replayInvoked).toBe(false)
    expect(skippedExec?.verification?.status).toBe('skipped-unsafe')

    const skippedMissingDefinition = await verifyMatOSWorkflowReplayCandidate({
      cwd: root,
      candidateId: candidate?.candidateId ?? '',
      runWorkflow: async () => {
        replayInvoked = true
        return {
          runId: 'should-not-run-without-definition',
          status: 'failed',
          failedNodeIds: [],
        }
      },
    })
    expect(replayInvoked).toBe(false)
    expect(skippedMissingDefinition?.verification?.status).toBe('skipped-unsafe')
  })
})
