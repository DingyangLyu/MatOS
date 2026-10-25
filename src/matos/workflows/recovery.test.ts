/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { recoverWorkflowRun } from './recovery.js'
import type { MatOSWorkflowNode } from './types.js'
import { inspectWorkflowRunView } from './runState.js'
import { writeFrameNodeRun, writeWorkflowFrame } from './stateMachineStore.js'
import { resumeWorkflowRun, startWorkflowRun } from './workflowRuntime.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS workflow recovery classifier', () => {
  test('classifies waiting human runs as requiring human review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-human-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-human@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'recover-human',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Review recovery case',
          },
        ],
      },
    })

    const recovery = await recoverWorkflowRun(run.runDir)

    expect(recovery).toMatchObject({
      runId: run.runId,
      classification: 'human_wait',
      recommendedAction: 'request_human_review',
      nodeId: 'review',
    })
  })

  test('classifies failed agent output contract runs as schema failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-schema-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-schema@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-schema',
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
            outputSchema: {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'draft'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'draft', 'node-run.json'), {
      nodeId: 'draft',
      status: 'failed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: { ok: 'not-a-boolean' },
      error: { message: 'Workflow node output schema failed: /ok must be boolean' },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'failed',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      runId: handle.runId,
      classification: 'schema_failure',
      recommendedAction: 'retry_node',
      nodeId: 'draft',
    })
  })

  test('recovery targets a completed producer explicitly named by a failed validator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-producer-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-producer@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'recover-producer',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'produce',
            type: 'exec',
            dependsOn: [],
            command: 'printf NaN > result.txt',
          },
          {
            id: 'validate',
            type: 'guard',
            dependsOn: ['produce'],
            checks: [
              {
                type: 'regex',
                path: 'result.txt',
                pattern: 'NaN',
                negate: true,
                sourceNodeId: 'produce',
                failureCode: 'non_finite_result',
              },
            ],
          },
        ],
      },
    })
    expect(run.status).toBe('failed')

    const recovery = await recoverWorkflowRun(run.runDir)
    expect(recovery).toMatchObject({
      classification: 'validation_failure',
      recommendedAction: 'retry_node',
      nodeId: 'produce',
      evidence: { causalSourceNodeIds: ['produce'] },
    })
    expect(recovery.reason).toContain('repair and retry the producer')
  })

  test('classifies failed dynamic graph patch runs as dynamic patch failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-dynamic-patch-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-dynamic-patch@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-dynamic-patch',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'apply_dynamic_research_graph',
            type: 'dynamic',
            dependsOn: [],
            input: {
              candidatePath: '/workspace/group/shared/missing-dynamic-patch.json',
            },
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'apply_dynamic_research_graph'), {
      recursive: true,
    })
    await writeJson(
      join(
        handle.dir,
        'node-runs',
        'apply_dynamic_research_graph',
        'node-run.json',
      ),
      {
        nodeId: 'apply_dynamic_research_graph',
        status: 'failed',
        attempts: 1,
        updatedAt: new Date().toISOString(),
        error: {
          message:
            'Dynamic workflow patch validation failed: missing dynamic_graph_patch.json',
        },
      },
    )
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'failed',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      runId: handle.runId,
      classification: 'dynamic_graph_patch_failure',
      recommendedAction: 'request_human_review',
      nodeId: 'apply_dynamic_research_graph',
    })
    expect(recovery.reason).toContain('Dynamic graph patch')
  })

  test('uses persisted side-effect replay strategy before retrying failed backend nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-side-effect-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-side-effect@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-side-effect',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'backend',
            dependsOn: [],
            backend: 'hpc-queue',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'failed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      error: { message: 'submission process exited after remote task creation' },
      sideEffect: {
        class: 'external_backend',
        replaySafe: false,
        replayStrategy: 'reconcile_before_resubmit',
        external: true,
        receipt: {
          backend: 'hpc-queue',
          taskId: 't-recover-side-effect',
          status: 'submitted',
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'failed',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      runId: handle.runId,
      classification: 'backend_failure',
      recommendedAction: 'reconcile_compute',
      nodeId: 'submit',
    })
    expect(recovery.reason).toContain('t-recover-side-effect')
  })

  test('uses declared exec side-effect policy before retrying failed local commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-exec-side-effect-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-exec-side-effect@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'recover exec side effect',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'exec',
            dependsOn: [],
            command: 'printf submitted; exit 17',
            policy: {
              sideEffect: {
                class: 'external_backend',
                receipt: {
                  backend: 'hpc-queue',
                  taskId: 't-exec-side-effect',
                  status: 'submitted',
                },
              },
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const nodeRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'submit', 'node-run.json'), 'utf8'),
    )
    expect(nodeRun.sideEffect).toMatchObject({
      class: 'external_backend',
      replaySafe: false,
      replayStrategy: 'reconcile_before_resubmit',
      external: true,
      receipt: {
        backend: 'hpc-queue',
        taskId: 't-exec-side-effect',
      },
    })

    const recovery = await recoverWorkflowRun(run.runDir)

    expect(recovery).toMatchObject({
      runId: run.runId,
      classification: 'backend_failure',
      recommendedAction: 'reconcile_compute',
      nodeId: 'submit',
    })
    expect(recovery.reason).toContain('t-exec-side-effect')
  })

  test('resume resets orphaned in-flight rerun-safe nodes after a killed runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-orphan-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-orphan@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'recover-orphan',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'prepare',
            type: 'exec',
            dependsOn: [],
            command: 'printf prepared >> prepared.log',
          },
          {
            id: 'finish',
            type: 'exec',
            dependsOn: ['prepare'],
            command: 'printf finished >> finished.log',
          },
        ],
      },
    })
    expect(run.status).toBe('completed')

    // Simulate a SIGKILL that died mid-attempt: the node-run is persisted as
    // `running` with no live executor and the run snapshot says `running`.
    const finishRunPath = join(run.runDir, 'node-runs', 'finish', 'node-run.json')
    const finishRecord = JSON.parse(await readFile(finishRunPath, 'utf8'))
    await writeFile(
      finishRunPath,
      JSON.stringify({
        ...finishRecord,
        status: 'running',
        attempts: 1,
      }),
      'utf8',
    )
    await writeWorkflowRun(run.runDir, {
      ...(await readWorkflowRun(run.runDir)),
      status: 'running',
      waitingNodeId: undefined,
    })

    const recovery = await recoverWorkflowRun(run.runDir)
    expect(recovery).toMatchObject({
      classification: 'interrupted_process',
      recommendedAction: 'resume',
    })

    const resumed = await resumeWorkflowRun(run.runDir)
    expect(resumed.status).toBe('completed')

    // The orphaned in-flight node was reset and re-executed; the node that
    // completed before the interruption was not rerun.
    expect(await readFile(join(root, 'prepared.log'), 'utf8')).toBe('prepared')
    const events = JSON.parse(
      JSON.stringify(
        (await readFile(join(run.runDir, 'events.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
      ),
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workflow.recovery.node_reset',
          data: expect.objectContaining({
            nodeIds: ['finish'],
            reason: 'interrupted_in_flight',
          }),
        }),
      ]),
    )
  })

  test('classifies interrupted static workflows and resumes without rerunning completed nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-interrupt-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-interrupt@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'recover-interrupt',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'prepare',
            type: 'exec',
            dependsOn: [],
            command: 'printf prepared >> prepared.log',
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['prepare'],
            prompt: 'Review after interruption',
          },
        ],
      },
    })
    expect(run.status).toBe('waiting_input')
    await rm(join(run.runDir, 'node-runs', 'review'), {
      recursive: true,
      force: true,
    })
    await writeWorkflowRun(run.runDir, {
      ...(await readWorkflowRun(run.runDir)),
      status: 'running',
      waitingNodeId: undefined,
    })

    const recovery = await recoverWorkflowRun(run.runDir)
    expect(recovery).toMatchObject({
      classification: 'interrupted_process',
      recommendedAction: 'resume',
    })

    const resumed = await resumeWorkflowRun(run.runDir)
    expect(resumed.status).toBe('waiting_input')
    expect(resumed.waitingNodeId).toBe('review')
    expect(await readFile(join(root, 'prepared.log'), 'utf8')).toBe('prepared')
  })

  test('inspection exposes recovery only for stale running locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-stale-lock-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-stale-lock@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-stale-lock',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'work',
            type: 'exec',
            dependsOn: [],
            command: 'printf work',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'work'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'work', 'node-run.json'), {
      nodeId: 'work',
      status: 'running',
      attempts: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
      waitingNodeId: undefined,
    })

    const lockDir = join(handle.dir, '.run.lock')
    await mkdir(lockDir)
    await writeJson(join(lockDir, 'lock.json'), {
      owner: 'pid:99999999',
      pid: 99999999,
      acquiredAt: '2026-06-30T00:00:00.000Z',
    })

    const stale = await inspectWorkflowRunView(handle.dir)
    expect(stale.runtimeState?.lock).toMatchObject({
      state: 'stale',
      pid: 99999999,
    })
    expect(stale.recovery).toMatchObject({
      classification: 'interrupted_process',
      recommendedAction: 'resume',
      nodeId: 'work',
    })

    await rm(lockDir, { recursive: true, force: true })
    await mkdir(lockDir)
    // Fresh acquiredAt: a lock without a recorded process start time falls
    // back to the age backstop, so an old timestamp would read as stale even
    // for a live pid (see runLock lockMetadataIsStale).
    await writeJson(join(lockDir, 'lock.json'), {
      owner: `pid:${process.pid}`,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })

    const live = await inspectWorkflowRunView(handle.dir)
    expect(live.runtimeState?.lock).toMatchObject({
      state: 'held',
      pid: process.pid,
    })
    expect(live.recovery).toBeUndefined()
  })

  test('includes state-machine frame evidence for resumable cyclic runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-state-machine-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-state-machine@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-state-machine',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'draft', maxTransitions: 2 },
        },
        outputs: {},
        nodes: [
          { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
          { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
        ],
        transitions: [
          { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
        ],
      },
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
      },
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'interrupted_process',
      recommendedAction: 'resume',
      nodeId: 'draft',
      evidence: {
        stateMachine: {
          frameCount: 1,
          latestFrameStatus: 'completed',
          activeNodeId: 'draft',
          frameIndex: 1,
          recommendation: 'advance_next_frame',
        },
      },
    })
    expect(recovery.reason).toContain('next transition')
  })

  test('routes interrupted state-machine human frames to human review', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-workflow-recover-state-machine-human-'),
    )
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-state-machine-human@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-state-machine-human',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          executionModel: 'state_machine',
          stateMachine: { initialNodeId: 'gate', maxTransitions: 2 },
        },
        outputs: {},
        nodes: [
          { id: 'gate', type: 'human', dependsOn: [], prompt: 'approve?' },
          { id: 'done', type: 'exec', dependsOn: [], command: 'printf done' },
        ],
        transitions: [
          { id: 'gate_to_done', from: 'gate', to: 'done', route: 'success' },
        ],
      },
    })
    // Simulate a process killed after persisting the waiting frame but before
    // the run status switched to waiting_input.
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })
    await writeWorkflowFrame(handle.dir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'gate',
      status: 'waiting_input',
      state: {},
      nodeRunPath: 'node-run.json',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'human_wait',
      recommendedAction: 'request_human_review',
      nodeId: 'gate',
      evidence: {
        stateMachine: {
          frameCount: 1,
          latestFrameStatus: 'waiting_input',
          activeNodeId: 'gate',
          recommendation: 'human_review',
        },
      },
    })
  })

  test('recommends compute reconciliation when a waiting run has remote status failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-compute-reconcile-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-compute-reconcile@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-compute-reconcile',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['submit'],
            prompt: 'Review compute task',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-recover-status',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            reconcileFailures: [
              {
                source: 'manual_reconcile',
                taskId: 't-recover-status',
                error: 'temporary remote status outage',
              },
            ],
          },
        },
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'review'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'review', 'node-run.json'), {
      nodeId: 'review',
      status: 'waiting_input',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {},
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
      waitingNodeId: 'review',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_reconcile_failure',
      recommendedAction: 'reconcile_compute',
      nodeId: 'submit',
      reason: expect.stringContaining('t-recover-status'),
    })
  })

  test('waits before retrying compute reconciliation inside remote recovery cooldown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-reconcile-cooldown-'))
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-reconcile-cooldown@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-reconcile-cooldown',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-reconcile-cooldown',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            reconcileFailures: [
              {
                source: 'manual_reconcile',
                taskId: 't-reconcile-cooldown',
                error: 'temporary remote status outage',
                nextRetryAt,
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_reconcile_failure',
      recommendedAction: 'wait',
      nodeId: 'submit',
      reason: expect.stringContaining(nextRetryAt),
    })
  })

  test('uses the latest compute reconciliation failure when recovery cooldowns accumulate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-reconcile-latest-'))
    const oldRetryAt = new Date(Date.now() - 60_000).toISOString()
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-reconcile-latest@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-reconcile-latest',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 2,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-reconcile-latest',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            reconcileFailures: [
              {
                source: 'resume_reconcile',
                taskId: 't-reconcile-latest',
                error: 'first remote status outage',
                recordedAt: oldRetryAt,
                nextRetryAt: oldRetryAt,
              },
              {
                source: 'manual_reconcile',
                taskId: 't-reconcile-latest',
                error: 'second remote status outage',
                recordedAt: nextRetryAt,
                nextRetryAt,
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
    })

    const recovery = await recoverWorkflowRun(handle.dir)
    const reason = recovery.reason

    expect(recovery).toMatchObject({
      classification: 'compute_reconcile_failure',
      recommendedAction: 'wait',
      nodeId: 'submit',
    })
    expect(reason).toEqual(expect.stringContaining(nextRetryAt))
    expect(reason).toEqual(expect.stringContaining('t-reconcile-latest'))
  })

  test('escalates repeated compute reconciliation exceptions for operator review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-reconcile-escalate-'))
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-reconcile-escalate@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-reconcile-escalate',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
            lifecycle: {
              reconcileEscalateAfterFailures: 3,
            },
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 3,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-reconcile-escalate',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            reconcileFailures: [
              {
                source: 'resume_reconcile',
                taskId: 't-reconcile-escalate',
                error: 'first remote status outage',
              },
              {
                source: 'manual_reconcile',
                taskId: 't-reconcile-escalate',
                error: 'second remote status outage',
              },
              {
                source: 'manual_reconcile',
                taskId: 't-reconcile-escalate',
                error: 'third remote status outage',
                nextRetryAt,
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
    })

    const recovery = await recoverWorkflowRun(handle.dir)
    const reason = recovery.reason

    expect(recovery).toMatchObject({
      classification: 'compute_remote_exception_escalated',
      recommendedAction: 'request_human_review',
      nodeId: 'submit',
      reason: expect.stringContaining('3 consecutive reconcile failures'),
      remoteRecovery: {
        kind: 'reconcile',
        taskId: 't-reconcile-escalate',
        failureCount: 3,
        escalationThreshold: 3,
        escalated: true,
        nextRetryAt,
        latestError: 'third remote status outage',
      },
    })
    expect(reason).toContain('t-reconcile-escalate')
    expect(reason).toContain(nextRetryAt)
  })

  test('recommends compute reconciliation for stale submitted remote jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-compute-stale-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-compute-stale@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-compute-stale',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
            lifecycle: {
              reconcileOnResume: true,
              cancelOnWorkflowCancel: true,
            },
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['submit'],
            prompt: 'Review stale compute task',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: '2026-06-01T00:00:00.000Z',
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-stale-reconcile',
        status: 'Submitted',
        artifacts: [],
        diagnostics: { lifecycle: {} },
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'review'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'review', 'node-run.json'), {
      nodeId: 'review',
      status: 'waiting_input',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {},
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
      waitingNodeId: 'review',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_reconcile_due',
      recommendedAction: 'reconcile_compute',
      nodeId: 'submit',
      reason: expect.stringContaining('t-stale-reconcile'),
    })
  })

  test('treats lifecycle backend outputs without an operation as stale submits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-backend-implicit-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-backend-implicit@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-backend-implicit',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'backend',
            dependsOn: [],
            backend: 'hpc-queue',
            lifecycle: {
              reconcileOnResume: true,
            },
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['submit'],
            prompt: 'Review backend task',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    // Generic backend receipts may omit `operation` and nest ids in payload.
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: '2026-06-01T00:00:00.000Z',
      output: {
        ok: true,
        backend: 'hpc-queue',
        status: 'Submitted',
        payload: { taskId: 't-backend-implicit' },
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'review'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'review', 'node-run.json'), {
      nodeId: 'review',
      status: 'waiting_input',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {},
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
      waitingNodeId: 'review',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_reconcile_due',
      recommendedAction: 'reconcile_compute',
      nodeId: 'submit',
      reason: expect.stringContaining('t-backend-implicit'),
    })
  })

  test('excludes lifecycle backend outputs with an explicit non-submit operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-backend-status-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-backend-status@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-backend-status',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'monitor',
            type: 'backend',
            dependsOn: [],
            backend: 'hpc-queue',
            lifecycle: {
              reconcileOnResume: true,
            },
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['monitor'],
            prompt: 'Review monitored task',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'monitor'), { recursive: true })
    // A status/list query result that references a foreign task must not be
    // reclassified as this node's own stale submitted job.
    await writeJson(join(handle.dir, 'node-runs', 'monitor', 'node-run.json'), {
      nodeId: 'monitor',
      status: 'completed',
      attempts: 1,
      updatedAt: '2026-06-01T00:00:00.000Z',
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'status',
        taskId: 't-foreign-task',
        status: 'Running',
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'review'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'review', 'node-run.json'), {
      nodeId: 'review',
      status: 'waiting_input',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {},
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
      waitingNodeId: 'review',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'human_wait',
      recommendedAction: 'request_human_review',
      nodeId: 'review',
    })
  })

  test('recommends remote cancel retry when a cancelled run has compute cancel failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-compute-cancel-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-compute-cancel@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-compute-cancel',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-recover-cancel',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            cancelFailures: [
              {
                taskId: 't-recover-cancel',
                error: 'temporary cancel outage',
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'cancelled',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_cancel_failure',
      recommendedAction: 'retry_remote_cancel',
      nodeId: 'submit',
      reason: expect.stringContaining('t-recover-cancel'),
    })
  })

  test('waits before retrying remote compute cancellation inside recovery cooldown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-cancel-cooldown-'))
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-cancel-cooldown@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-cancel-cooldown',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-cancel-cooldown',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            cancelFailures: [
              {
                taskId: 't-cancel-cooldown',
                error: 'temporary cancel outage',
                nextRetryAt,
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'cancelled',
    })

    const recovery = await recoverWorkflowRun(handle.dir)

    expect(recovery).toMatchObject({
      classification: 'compute_cancel_failure',
      recommendedAction: 'wait',
      nodeId: 'submit',
      reason: expect.stringContaining(nextRetryAt),
    })
  })

  test('uses the latest remote compute cancel failure when recovery cooldowns accumulate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-cancel-latest-'))
    const oldRetryAt = new Date(Date.now() - 60_000).toISOString()
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString()
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-cancel-latest@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-cancel-latest',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 2,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-cancel-latest',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            cancelFailures: [
              {
                taskId: 't-cancel-latest',
                error: 'first cancel outage',
                recordedAt: oldRetryAt,
                nextRetryAt: oldRetryAt,
              },
              {
                taskId: 't-cancel-latest',
                error: 'second cancel outage',
                recordedAt: nextRetryAt,
                nextRetryAt,
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'cancelled',
    })

    const recovery = await recoverWorkflowRun(handle.dir)
    const reason = recovery.reason

    expect(recovery).toMatchObject({
      classification: 'compute_cancel_failure',
      recommendedAction: 'wait',
      nodeId: 'submit',
    })
    expect(reason).toEqual(expect.stringContaining(nextRetryAt))
    expect(reason).toEqual(expect.stringContaining('t-cancel-latest'))
  })

  test('escalates repeated remote compute cancel exceptions for operator review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recover-cancel-escalate-'))
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recover-cancel-escalate@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'recover-cancel-escalate',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
            lifecycle: {
              cancelEscalateAfterFailures: 2,
            },
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 2,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-cancel-escalate',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            cancelFailures: [
              {
                taskId: 't-cancel-escalate',
                error: 'first cancel outage',
              },
              {
                taskId: 't-cancel-escalate',
                error: 'second cancel outage',
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'cancelled',
    })

    const recovery = await recoverWorkflowRun(handle.dir)
    const reason = recovery.reason

    expect(recovery).toMatchObject({
      classification: 'compute_remote_exception_escalated',
      recommendedAction: 'request_human_review',
      nodeId: 'submit',
      reason: expect.stringContaining('2 consecutive cancel failures'),
    })
    expect(reason).toContain('t-cancel-escalate')
  })
})

// ---------------------------------------------------------------------------
// Failure-text anchoring (B8)
//
// The classifier previously matched loose substrings: 'must be' filed any
// domain error as a schema failure and 'api' matched inside words like
// "rapid". These tests lock the tightened anchors — structured error codes
// plus specific word-bounded phrases — for both directions: genuine failures
// stay detected and ordinary scientific error text is no longer misfiled.
// ---------------------------------------------------------------------------

describe('MatOS workflow recovery classifier: failure text anchoring', () => {
  async function classifyFailedNode(input: {
    slug: string
    node: MatOSWorkflowNode
    error: Record<string, unknown>
  }) {
    const root = await mkdtemp(
      join(tmpdir(), `matos-workflow-recover-${input.slug}-`),
    )
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: `workflow:recover-${input.slug}@0.1.0`,
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: `recover-${input.slug}`,
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [input.node],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', input.node.id), {
      recursive: true,
    })
    await writeJson(
      join(handle.dir, 'node-runs', input.node.id, 'node-run.json'),
      {
        nodeId: input.node.id,
        status: 'failed',
        attempts: 1,
        updatedAt: new Date().toISOString(),
        error: input.error,
      },
    )
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'failed',
    })
    return recoverWorkflowRun(handle.dir)
  }

  test('anchors schema failures to the structured output_contract_failed code', async () => {
    // Contract errors can carry a bare Ajv message with no recognizable
    // phrase; the stable error code must classify them on its own.
    const recovery = await classifyFailedNode({
      slug: 'schema-code',
      node: { id: 'draft', type: 'exec', dependsOn: [], command: 'echo hi' },
      error: {
        message: '/energy must be number',
        code: 'output_contract_failed',
      },
    })
    expect(recovery).toMatchObject({
      classification: 'schema_failure',
      recommendedAction: 'retry_node',
      nodeId: 'draft',
    })
  })

  test('does not misfile scientific "must be" text as a schema failure', async () => {
    // Previously any message containing 'must be' became schema_failure.
    const recovery = await classifyFailedNode({
      slug: 'domain-must-be',
      node: { id: 'relax', type: 'exec', dependsOn: [], command: 'run-relax' },
      error: { message: 'lattice parameter must be positive; got a=-4.05' },
    })
    expect(recovery).toMatchObject({
      classification: 'tool_failure',
      recommendedAction: 'retry_node',
      nodeId: 'relax',
    })
  })

  test('does not misfile agent domain text as a model API failure', async () => {
    // Previously 'api' matched inside "rapid" and bare 'connection' matched
    // descriptive prose.
    const recovery = await classifyFailedNode({
      slug: 'agent-domain',
      node: {
        id: 'analyze',
        type: 'agent',
        dependsOn: [],
        role: 'role:analyst',
        prompt: 'analyze the oxidation series',
      },
      error: {
        message:
          'rapid oxidation analysis produced no valid candidates; connection between adsorbate layers unresolved',
      },
    })
    expect(recovery).toMatchObject({
      classification: 'tool_failure',
      recommendedAction: 'retry_node',
      nodeId: 'analyze',
    })
  })

  test('still detects genuine model API failures on agent nodes', async () => {
    const cases: Array<[string, string]> = [
      ['agent-api', 'OpenAI API request failed with status 500'],
      ['agent-rate', 'rate limit exceeded, retry after 20s'],
      ['agent-timeout', 'Agent node timed out after 30000ms: analyze'],
      ['agent-conn', 'request failed: connection refused (ECONNREFUSED)'],
      ['agent-auth', 'authentication failed for provider'],
    ]
    for (const [slug, message] of cases) {
      const recovery = await classifyFailedNode({
        slug,
        node: {
          id: 'analyze',
          type: 'agent',
          dependsOn: [],
          role: 'role:analyst',
          prompt: 'go',
        },
        error: { message },
      })
      expect({ slug, classification: recovery.classification }).toEqual({
        slug,
        classification: 'model_api_failure',
      })
    }
  })

  test('still detects schema failures from genuine message phrases', async () => {
    // The historical message formats (with and without a space in
    // "outputSchema") keep classifying without the structured code.
    const cases: Array<[string, string]> = [
      ['schema-spaced', 'Workflow node output schema failed: /ok must be boolean'],
      ['schema-camel', 'Agent node draft outputSchema failed: /ok must be boolean'],
      ['schema-contract', 'output contract violated: missing required key "energy"'],
    ]
    for (const [slug, message] of cases) {
      const recovery = await classifyFailedNode({
        slug,
        node: { id: 'draft', type: 'exec', dependsOn: [], command: 'echo hi' },
        error: { message },
      })
      expect({ slug, classification: recovery.classification }).toEqual({
        slug,
        classification: 'schema_failure',
      })
    }
  })
})
