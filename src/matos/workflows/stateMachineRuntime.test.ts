import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { nextStateMachineTransition } from './stateMachineScheduler.js'
import {
  listWorkflowFrames,
  writeFrameNodeRun,
  writeWorkflowFrame,
} from './stateMachineStore.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNodeRunSnapshot,
} from './types.js'
import {
  respondToWorkflowNode,
  resumeWorkflowRun,
  startWorkflowRun,
} from './workflowRuntime.js'
import { classifyStateMachineRecovery } from './stateMachineRecovery.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'

function nodeRun(
  status: MatOSWorkflowNodeRunSnapshot['status'],
): MatOSWorkflowNodeRunSnapshot {
  return {
    nodeId: 'review',
    status,
    attempts: 1,
    updatedAt: '2026-06-07T00:00:00.000Z',
    output: { ok: false },
  }
}

describe('MatOS state-machine workflow scheduler', () => {
  test('selects the first transition whose route guard and traversal cap match', () => {
    const definition: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'state-machine-scheduler',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'review', maxTransitions: 4 },
      },
      outputs: {},
      nodes: [
        { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
        {
          id: 'review',
          type: 'guard',
          dependsOn: [],
          checks: [{ type: 'expression', value: 'false' }],
        },
      ],
      transitions: [
        {
          id: 'review_to_draft',
          from: 'review',
          to: 'draft',
          route: 'failure',
          maxTraversals: 2,
        },
        { id: 'review_done', from: 'review', to: 'review', route: 'success' },
      ],
    }

    expect(
      nextStateMachineTransition({
        definition,
        activeNodeId: 'review',
        nodeRun: nodeRun('failed'),
        state: {},
        transitionCounts: new Map([['review_to_draft', 1]]),
      })?.id,
    ).toBe('review_to_draft')

    expect(
      nextStateMachineTransition({
        definition,
        activeNodeId: 'review',
        nodeRun: nodeRun('failed'),
        state: {},
        transitionCounts: new Map([['review_to_draft', 2]]),
      }),
    ).toBeUndefined()
  })
})

describe('MatOS state-machine workflow runtime', () => {
  test('runs a bounded state-machine workflow with an explicit transition cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-run-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-cycle@0.1.0',
      workspaceDir: workspace,
      parameters: { revision: 1 },
      definition: {
        schemaVersion: 1,
        name: 'state-machine-cycle',
        parameters: { revision: { type: 'number', default: 1 } },
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'draft', maxTransitions: 4 },
        },
        outputs: {
          state: { value: '{{ workflow.state }}' },
          finalNodeId: { value: '{{ workflow.finalNodeId }}' },
        },
        nodes: [
          { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
          { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
          { id: 'done', type: 'exec', dependsOn: [], command: 'printf done' },
        ],
        transitions: [
          { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
          {
            id: 'review_to_draft',
            from: 'review',
            to: 'draft',
            route: 'success',
            guard: '{{ parameters.revision }} == 1',
            reducer: { revision: 2 },
            maxTraversals: 1,
          },
          {
            id: 'review_done',
            from: 'review',
            to: 'done',
            route: 'success',
            guard: '{{ parameters.revision }} == 2',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.finalNodeId).toBe('done')
    expect(run.outputs.state).toMatchObject({ revision: 2 })

    const frames = await listWorkflowFrames(run.runDir)
    expect(frames.map(frame => frame.activeNodeId)).toEqual([
      'draft',
      'review',
      'draft',
      'review',
      'done',
    ])

    const firstDraftFrame = JSON.parse(
      await readFile(join(run.runDir, 'frames', '000001', 'node-run.json'), 'utf8'),
    )
    const secondDraftFrame = JSON.parse(
      await readFile(join(run.runDir, 'frames', '000003', 'node-run.json'), 'utf8'),
    )
    expect(firstDraftFrame.nodeId).toBe('draft')
    expect(secondDraftFrame.nodeId).toBe('draft')
    expect(firstDraftFrame.idempotencyKey).not.toBe(
      secondDraftFrame.idempotencyKey,
    )

    const budget = JSON.parse(
      await readFile(join(run.runDir, 'budget.json'), 'utf8'),
    )
    expect(budget.schemaVersion).toBe(1)
    expect(budget.runId).toBe(run.runId)
    expect(budget.totals.nodeAttempts).toBe(5)
    expect(budget.totals.toolCalls).toBe(5)
    expect(budget.totals.agentCalls).toBe(0)
    expect(budget.totals.backendJobs).toBe(0)
    expect(budget.totals.wallTimeMs).toBeGreaterThanOrEqual(0)
    expect(budget.byNode.draft.nodeAttempts).toBe(2)
    expect(budget.byNode.review.nodeAttempts).toBe(2)
    expect(budget.byNode.done.nodeAttempts).toBe(1)
    expect(run.budget?.totals.nodeAttempts).toBe(5)
    expect(run.stateMachine?.frames).toHaveLength(5)
  })

  test('resumes from the next frame without rerunning completed frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-resume-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const definition: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'state-machine-resume',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'draft', maxTransitions: 2 },
      },
      outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
      nodes: [
        { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
        { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
      ],
      transitions: [
        { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
      ],
    }
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-resume@0.1.0',
      parameters: {},
      graphSnapshot: definition,
      workspaceDir: workspace,
      projectCwd: root,
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })
    await writeWorkflowFrame(handle.dir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'draft',
      status: 'completed',
      state: {},
      transitionEdgeId: 'draft_to_review',
      nodeRunPath: 'node-run.json',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
    })
    await writeFrameNodeRun({
      runDir: handle.dir,
      frameIndex: 1,
      nodeRun: {
        nodeId: 'draft',
        status: 'completed',
        attempts: 1,
        updatedAt: '2026-06-07T00:00:01.000Z',
        idempotencyKey: 'persisted-frame-1-key',
      },
    })

    const resumed = await resumeWorkflowRun(handle.dir)

    expect(resumed.status).toBe('completed')
    expect(resumed.outputs.finalNodeId).toBe('review')
    expect((await listWorkflowFrames(handle.dir)).map(frame => frame.activeNodeId))
      .toEqual(['draft', 'review'])
    const firstFrame = JSON.parse(
      await readFile(join(handle.dir, 'frames', '000001', 'node-run.json'), 'utf8'),
    )
    expect(firstFrame.idempotencyKey).toBe('persisted-frame-1-key')
  })

  test('resumes failed terminal frames through failure transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-failed-resume-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const definition: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'state-machine-failed-resume',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'draft', maxTransitions: 3 },
      },
      outputs: {
        finalNodeId: { value: '{{ workflow.finalNodeId }}' },
        state: { value: '{{ workflow.state }}' },
      },
      nodes: [
        {
          id: 'draft',
          type: 'exec',
          dependsOn: [],
          command: 'printf should-not-rerun-draft >&2; exit 9',
        },
        { id: 'repair', type: 'exec', dependsOn: [], command: 'printf repair' },
      ],
      transitions: [
        {
          id: 'draft_to_repair',
          from: 'draft',
          to: 'repair',
          route: 'failure',
          reducer: { recoveredFrom: 'draft' },
        },
      ],
    }

    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-failed-resume@0.1.0',
      parameters: {},
      graphSnapshot: definition,
      workspaceDir: workspace,
      projectCwd: root,
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })
    await writeWorkflowFrame(handle.dir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'draft',
      status: 'failed',
      state: {},
      nodeRunPath: 'node-run.json',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
    })
    await writeFrameNodeRun({
      runDir: handle.dir,
      frameIndex: 1,
      nodeRun: {
        nodeId: 'draft',
        status: 'failed',
        attempts: 1,
        updatedAt: '2026-06-07T00:00:01.000Z',
        error: 'persisted failure before resume',
        idempotencyKey: 'persisted-failed-frame-key',
      },
    })

    const resumed = await resumeWorkflowRun(handle.dir)

    expect(resumed.status).toBe('completed')
    expect(resumed.outputs.finalNodeId).toBe('repair')
    expect(resumed.outputs.state).toMatchObject({ recoveredFrom: 'draft' })
    const frames = await listWorkflowFrames(handle.dir)
    expect(frames.map(frame => frame.activeNodeId)).toEqual(['draft', 'repair'])
    expect(frames[0]).toMatchObject({
      activeNodeId: 'draft',
      status: 'completed',
      transitionEdgeId: 'draft_to_repair',
    })
    const firstFrame = JSON.parse(
      await readFile(join(handle.dir, 'frames', '000001', 'node-run.json'), 'utf8'),
    )
    expect(firstFrame.idempotencyKey).toBe('persisted-failed-frame-key')
  })

  test('pauses a state-machine run on a human frame and resumes after a real response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-human-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-human@0.1.0',
      workspaceDir: workspace,
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'state-machine-human',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'draft', maxTransitions: 4 },
        },
        outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
        nodes: [
          { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Approve the draft?',
            responseSchema: { type: 'object' },
          },
          { id: 'done', type: 'exec', dependsOn: [], command: 'printf done' },
        ],
        transitions: [
          { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
          { id: 'review_to_done', from: 'review', to: 'done', route: 'success' },
        ],
      },
    })

    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('review')
    const recovery = await classifyStateMachineRecovery(run.runDir)
    expect(recovery.recommendation).toBe('human_review')

    const completed = await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'review',
      response: { approved: true },
    })
    expect(completed.status).toBe('completed')
    expect(completed.outputs.finalNodeId).toBe('done')
    expect((await listWorkflowFrames(run.runDir)).map(frame => frame.activeNodeId))
      .toEqual(['draft', 'review', 'done'])
  })

  test('rejects invalid human response schema without leaving waiting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-human-schema-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-human-schema@0.1.0',
      workspaceDir: workspace,
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'state-machine-human-schema',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'review', maxTransitions: 2 },
        },
        outputs: { approved: { value: '{{ nodes.review.outputs.approved }}' } },
        nodes: [
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Approve?',
            responseSchema: {
              type: 'object',
              required: ['approved'],
              properties: { approved: { type: 'boolean' } },
            },
          },
        ],
      },
    })

    await expect(
      respondToWorkflowNode({
        runDir: run.runDir,
        nodeId: 'review',
        response: { note: 'missing approved' },
      }),
    ).rejects.toThrow('failed responseSchema')

    const waiting = await readWorkflowRun(run.runDir)
    expect(waiting.status).toBe('waiting_input')
    expect(waiting.waitingNodeId).toBe('review')

    const completed = await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'review',
      response: '{"approved":true}',
    })
    expect(completed.status).toBe('completed')
    expect(completed.outputs.approved).toBe(true)
  })

  test('recovers a state-machine run interrupted mid-frame from durable frame evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-interrupt-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const definition: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'state-machine-interrupt',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'draft', maxTransitions: 3 },
      },
      outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
      nodes: [
        { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
        { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
      ],
      transitions: [
        { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
      ],
    }

    // Persist the exact on-disk shape of a run whose process died mid-frame:
    // run.json still says running, frame 1 exists with status running, and no
    // node attempt finished. This is the long-interruption recovery case.
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-interrupt@0.1.0',
      parameters: {},
      graphSnapshot: definition,
      workspaceDir: workspace,
      projectCwd: root,
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })
    await writeWorkflowFrame(handle.dir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'draft',
      status: 'running',
      state: {},
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
    })

    const recovery = await classifyStateMachineRecovery(handle.dir)
    expect(recovery.recommendation).toBe('resume_current_frame')
    expect(recovery.activeNodeId).toBe('draft')
    expect(recovery.frameIndex).toBe(1)

    const resumed = await resumeWorkflowRun(handle.dir)
    expect(resumed.status).toBe('completed')
    expect(resumed.outputs.finalNodeId).toBe('review')
    const frames = await listWorkflowFrames(handle.dir)
    expect(frames.map(frame => frame.activeNodeId)).toEqual(['draft', 'review'])
    expect(frames.every(frame => frame.status === 'completed')).toBe(true)
  })

  test('fails a state-machine run when the declared budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-state-machine-budget-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:state-machine-budget@0.1.0',
      workspaceDir: workspace,
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'state-machine-budget',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'draft', maxTransitions: 8 },
          budget: { maxToolCalls: 2, onExceeded: 'fail' },
        },
        outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
        nodes: [
          { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
          { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
          { id: 'done', type: 'exec', dependsOn: [], command: 'printf done' },
        ],
        transitions: [
          { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
          { id: 'review_to_done', from: 'review', to: 'done', route: 'success' },
        ],
      },
    })

    expect(run.status).toBe('failed')
    expect(String(run.outputs.error ?? '')).toContain('budget exhausted')
    expect((await listWorkflowFrames(run.runDir)).map(frame => frame.activeNodeId))
      .toEqual(['draft', 'review'])
    expect(run.budget?.violations).toEqual([
      { limit: 'maxToolCalls', max: 2, observed: 2 },
    ])
  })
})
