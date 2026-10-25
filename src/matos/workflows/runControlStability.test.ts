// Focused stability regressions for run control (cooperative cancel/pause)
// and crash recovery in the generic workflow runtime. Hermetic: synthetic
// workflows over generic node types (exec, guard, map, subworkflow) with no
// model/provider dependencies.

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import {
  cancelWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
} from './workflowRuntime.js'
import { requestWorkflowRunControl } from './workflowControl.js'
import { registerWorkflowLocalProcess } from './localProcessRegistry.js'
import {
  readWorkflowRun,
  readWorkflowRunEvents,
  writeWorkflowRun,
} from './workflowStore.js'
import { nowIso, readNodeRun, writeNodeRun } from './runState.js'
import type { MatOSWorkflowDefinition } from './types.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function installChildWorkflowAsset(
  root: string,
  options: { id: string; command: string },
): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', options.id)
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: options.id,
    type: 'workflow',
    name: options.id,
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: options.id,
    parameters: {
      item: { type: 'string', default: 'none' },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {
      done: { value: '{{ nodes.say.outputs.stdout }}' },
    },
    nodes: [
      {
        id: 'say',
        type: 'exec',
        dependsOn: [],
        command: options.command,
      },
    ],
  })
}

describe('MatOS workflow run control stability', () => {
  test(
    'state-machine runs honor a queued cancel marker at the frame boundary',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-sm-cancel-'))
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:sm-cancel@0.1.0',
        workspaceDir: workspace,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'sm-cancel',
          parameters: {},
          policy: {
            approvalMode: 'bypass',
            defaultRisk: 'low',
            executionModel: 'state_machine',
            stateMachine: { initialNodeId: 'step', maxTransitions: 4 },
          },
          outputs: {},
          nodes: [
            {
              id: 'step',
              type: 'exec',
              dependsOn: [],
              command: 'printf ran > frame-ran.marker',
            },
            {
              id: 'wrap',
              type: 'exec',
              dependsOn: [],
              command: 'printf wrap',
            },
          ],
          transitions: [
            { id: 'step_to_wrap', from: 'step', to: 'wrap', route: 'success' },
          ],
        },
      })
      expect(run.status).toBe('created')

      // Cooperative cancel queued before the detached worker picks the run up.
      await requestWorkflowRunControl(run.runDir, 'cancel')
      const resumed = await resumeWorkflowRun(run.runDir)

      expect(resumed.status).toBe('cancelled')
      // No frame executed: the marker was honored at the frame boundary.
      expect(await exists(join(workspace, 'frame-ran.marker'))).toBe(false)
      expect(resumed.stateMachine?.frames ?? []).toHaveLength(0)
      // The marker was consumed, not left to re-cancel future operations.
      expect(await exists(join(run.runDir, 'control.json'))).toBe(false)
    },
    30_000,
  )

  test(
    'cancel terminates an in-flight exec node and settles the run cancelled',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-exec-run-cancel-'))
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:exec-cancel@0.1.0',
        workspaceDir: workspace,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'exec-cancel',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'long',
              type: 'exec',
              dependsOn: [],
              command:
                'printf started > exec-started.marker; sleep 30; printf finished > exec-finished.marker',
              timeoutSeconds: 60,
            },
          ],
        },
      })

      const startedAt = Date.now()
      const pending = resumeWorkflowRun(run.runDir)
      await waitFor(
        () => exists(join(workspace, 'exec-started.marker')),
        'exec node to start',
      )
      await requestWorkflowRunControl(run.runDir, 'cancel')

      const view = await pending
      expect(view.status).toBe('cancelled')
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      const nodeRun = await readNodeRun(run.runDir, 'long')
      expect(nodeRun?.status).toBe('cancelled')
      expect(await exists(join(workspace, 'exec-finished.marker'))).toBe(false)
    },
    30_000,
  )

  test(
    'retry backoff yields to a cancel request instead of sleeping through it',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-retry-cancel-'))
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:retry-cancel@0.1.0',
        workspaceDir: workspace,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'retry-cancel',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'flaky',
              type: 'exec',
              dependsOn: [],
              command: 'exit 7',
              policy: {
                retry: { maxAttempts: 5, backoffMs: 120_000 },
              },
            },
          ],
        },
      })

      const startedAt = Date.now()
      const pending = resumeWorkflowRun(run.runDir)
      await waitFor(
        async () =>
          (await readWorkflowRunEvents(run.runDir)).some(
            event => event.type === 'workflow.node.retry_scheduled',
          ),
        'first retry to be scheduled',
      )
      await requestWorkflowRunControl(run.runDir, 'cancel')

      const view = await pending
      expect(view.status).toBe('cancelled')
      // Cancelled long before the 120s backoff elapsed, with no extra attempt.
      expect(Date.now() - startedAt).toBeLessThan(30_000)
      const nodeRun = await readNodeRun(run.runDir, 'flaky')
      expect(nodeRun?.attempts).toBe(1)
      expect(nodeRun?.status).toBe('pending')
    },
    40_000,
  )

  test(
    'cancel stops an aggregate map from launching its remaining children',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-map-cancel-'))
      await installChildWorkflowAsset(root, {
        id: 'slow-item',
        command: 'sleep 0.4; printf done-{{ parameters.item }}',
      })

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:map-cancel@0.1.0',
        workspaceDir: root,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'map-cancel',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'scan',
              type: 'map',
              dependsOn: [],
              workflow: 'workflow:slow-item',
              items: ['a', 'b', 'c', 'd', 'e', 'f'],
              itemParameter: 'item',
              outputKeys: ['done'],
              failureMode: 'aggregate',
              maxParallel: 1,
            },
          ],
        },
      })

      const pending = resumeWorkflowRun(run.runDir)
      await waitFor(
        () => exists(join(run.runDir, 'iterations', 'scan', '1', 'iteration.json')),
        'first map iteration record',
      )
      await requestWorkflowRunControl(run.runDir, 'cancel')

      const view = await pending
      expect(view.status).toBe('cancelled')
      const nodeRun = await readNodeRun(run.runDir, 'scan')
      expect(nodeRun?.status).toBe('cancelled')
      const iterationDirs = await readdir(join(run.runDir, 'iterations', 'scan'))
      expect(iterationDirs.length).toBeLessThan(6)
      const output = nodeRun?.output as { summary?: { cancelled?: boolean } }
      expect(output?.summary?.cancelled).toBe(true)
    },
    40_000,
  )

  test(
    'resume adopts a completed subworkflow child instead of double-running it',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-sub-adopt-'))
      await installChildWorkflowAsset(root, {
        id: 'child',
        command: 'printf done-{{ parameters.item }}',
      })
      const workflowsDir = join(root, 'workflows')

      const parentDefinition: MatOSWorkflowDefinition = {
        schemaVersion: 1,
        name: 'sub-adopt-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'sub',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:child',
            parameters: { item: 'si' },
            outputKeys: ['done'],
          },
          {
            id: 'verify',
            type: 'guard',
            dependsOn: ['sub'],
            checks: [{ type: 'expression', value: 'true' }],
          },
        ],
      }

      const parent = await startWorkflowRun({
        cwd: root,
        workflowsDir,
        workflowRef: 'workflow:sub-adopt-parent@0.1.0',
        workspaceDir: root,
        parameters: {},
        advance: false,
        definition: parentDefinition,
      })
      const runsDir = dirname(parent.runDir)

      // Real completed child run, exactly as the crashed worker left it.
      const childDefinition = JSON.parse(
        await readFile(
          join(root, '.matos', 'assets', 'workflows', 'child', 'workflow.json'),
          'utf8',
        ),
      ) as MatOSWorkflowDefinition
      const child = await startWorkflowRun({
        cwd: root,
        workflowsDir,
        workflowRunsDir: runsDir,
        workflowRef: 'workflow:child@0.1.0',
        workspaceDir: root,
        parameters: { item: 'si' },
        definition: childDefinition,
      })
      expect(child.status).toBe('completed')

      // Crash state: node persisted `running`, child marker persisted, run
      // parked `running`, worker gone.
      await writeNodeRun(parent.runDir, {
        nodeId: 'sub',
        status: 'running',
        attempts: 1,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      })
      await mkdir(join(parent.runDir, 'child-runs'), { recursive: true })
      await writeJson(join(parent.runDir, 'child-runs', 'sub.json'), {
        nodeId: 'sub',
        workflowRef: 'workflow:child@0.1.0',
        childRunId: child.runId,
        status: 'created',
        detachOnParentCancel: false,
      })
      await writeWorkflowRun(parent.runDir, {
        ...(await readWorkflowRun(parent.runDir)),
        status: 'running',
      })

      const resumed = await resumeWorkflowRun(parent.runDir)

      expect(resumed.status).toBe('completed')
      const nodeRun = await readNodeRun(parent.runDir, 'sub')
      expect(nodeRun?.status).toBe('completed')
      expect(nodeRun?.output).toMatchObject({
        childRunId: child.runId,
        status: 'completed',
        outputs: { done: 'done-si' },
      })
      const verify = await readNodeRun(parent.runDir, 'verify')
      expect(verify?.status).toBe('completed')
      // No duplicate child run was started: runs dir holds parent + one child.
      const runDirs = await readdir(runsDir)
      expect(runDirs.sort()).toEqual(
        [parent.runId, child.runId].sort(),
      )
    },
    40_000,
  )

  test(
    'resume drives an orphaned non-terminal subworkflow child to completion',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-sub-resume-child-'))
      await installChildWorkflowAsset(root, {
        id: 'child',
        command: 'printf done-{{ parameters.item }}',
      })
      const workflowsDir = join(root, 'workflows')

      const parent = await startWorkflowRun({
        cwd: root,
        workflowsDir,
        workflowRef: 'workflow:sub-resume-parent@0.1.0',
        workspaceDir: root,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'sub-resume-parent',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'sub',
              type: 'subworkflow',
              dependsOn: [],
              workflow: 'workflow:child',
              parameters: { item: 'ge' },
              outputKeys: ['done'],
            },
          ],
        },
      })
      const runsDir = dirname(parent.runDir)

      // The child was created but its worker died before advancing any node.
      const childDefinition = JSON.parse(
        await readFile(
          join(root, '.matos', 'assets', 'workflows', 'child', 'workflow.json'),
          'utf8',
        ),
      ) as MatOSWorkflowDefinition
      const child = await startWorkflowRun({
        cwd: root,
        workflowsDir,
        workflowRunsDir: runsDir,
        workflowRef: 'workflow:child@0.1.0',
        workspaceDir: root,
        parameters: { item: 'ge' },
        advance: false,
        definition: childDefinition,
      })
      expect(child.status).toBe('created')

      await writeNodeRun(parent.runDir, {
        nodeId: 'sub',
        status: 'running',
        attempts: 1,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      })
      await mkdir(join(parent.runDir, 'child-runs'), { recursive: true })
      await writeJson(join(parent.runDir, 'child-runs', 'sub.json'), {
        nodeId: 'sub',
        workflowRef: 'workflow:child@0.1.0',
        childRunId: child.runId,
        status: 'created',
        detachOnParentCancel: false,
      })
      await writeWorkflowRun(parent.runDir, {
        ...(await readWorkflowRun(parent.runDir)),
        status: 'running',
      })

      const resumed = await resumeWorkflowRun(parent.runDir)

      expect(resumed.status).toBe('completed')
      expect((await readWorkflowRun(join(runsDir, child.runId))).status).toBe(
        'completed',
      )
      const nodeRun = await readNodeRun(parent.runDir, 'sub')
      expect(nodeRun?.status).toBe('completed')
      expect(nodeRun?.output).toMatchObject({
        childRunId: child.runId,
        outputs: { done: 'done-ge' },
      })
      const runDirs = await readdir(runsDir)
      expect(runDirs.sort()).toEqual([parent.runId, child.runId].sort())
    },
    40_000,
  )

  test(
    'cancel kills registered local children left behind by a dead worker',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-cancel-local-kill-'))
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:local-kill@0.1.0',
        workspaceDir: workspace,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'local-kill',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            { id: 'local-a', type: 'exec', dependsOn: [], command: 'sleep 30' },
            { id: 'local-b', type: 'exec', dependsOn: [], command: 'sleep 30' },
          ],
        },
      })

      // Crash state: the worker that spawned these detached children died,
      // leaving the nodes `running` and the process groups computing.
      const sleeperA = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      const sleeperB = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      sleeperA.unref()
      sleeperB.unref()
      for (const [nodeId, pid, kind] of [
        ['local-a', sleeperA.pid, 'exec'],
        ['local-b', sleeperB.pid, 'agent'],
      ] as const) {
        await writeNodeRun(run.runDir, {
          nodeId,
          status: 'running',
          attempts: 1,
          startedAt: nowIso(),
          updatedAt: nowIso(),
        })
        await registerWorkflowLocalProcess({
          runDir: run.runDir,
          nodeId,
          pid,
          kind,
        })
      }
      await writeWorkflowRun(run.runDir, {
        ...(await readWorkflowRun(run.runDir)),
        status: 'running',
      })

      const cancelled = await cancelWorkflowRun(run.runDir)
      expect(cancelled.status).toBe('cancelled')

      const pidGone = (pid: number | undefined): boolean => {
        if (!pid) {
          return true
        }
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      await waitFor(
        async () => pidGone(sleeperA.pid) && pidGone(sleeperB.pid),
        'registered local children to be terminated',
        10_000,
      )
      // Registrations were consumed and the terminations were recorded.
      expect(
        await exists(join(run.runDir, 'node-runs', 'local-a', 'local-process.json')),
      ).toBe(false)
      expect(
        await exists(join(run.runDir, 'node-runs', 'local-b', 'local-process.json')),
      ).toBe(false)
      const events = await readWorkflowRunEvents(run.runDir)
      const killEvent = events.find(
        event => event.type === 'workflow.run.local_processes_terminated',
      )
      expect(killEvent).toBeDefined()
      expect(
        (killEvent?.data as { processes?: Array<{ nodeId: string }> }).processes
          ?.map(process => process.nodeId)
          .sort(),
      ).toEqual(['local-a', 'local-b'])
    },
    30_000,
  )

  test(
    'resume resets an interrupted map carrier and re-runs it to completion',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-map-orphan-'))
      await installChildWorkflowAsset(root, {
        id: 'quick-item',
        command: 'printf done-{{ parameters.item }}',
      })

      const parent = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:map-orphan-parent@0.1.0',
        workspaceDir: root,
        parameters: {},
        advance: false,
        definition: {
          schemaVersion: 1,
          name: 'map-orphan-parent',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'scan',
              type: 'map',
              dependsOn: [],
              workflow: 'workflow:quick-item',
              items: ['si'],
              itemParameter: 'item',
              outputKeys: ['done'],
            },
          ],
        },
      })

      // Crash state: the map carrier is parked `running` with a dead worker.
      // Before the crash-recovery work this run was stuck forever: never
      // re-dispatched, never resettable, and retry_node rejected the
      // `running` status.
      await writeNodeRun(parent.runDir, {
        nodeId: 'scan',
        status: 'running',
        attempts: 1,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      })
      await writeWorkflowRun(parent.runDir, {
        ...(await readWorkflowRun(parent.runDir)),
        status: 'running',
      })

      // Adjudicated recovery semantics (fail-closed unstick fix merged with
      // the crash-recovery closure): an interrupted carrier with no adoptable
      // child records is reset and re-run to completion on resume, so long
      // unattended campaigns heal without a human retry. Carriers with
      // adoptable children are adopted instead of re-run (see
      // workflowRuntime.test.ts map adoption coverage), and deliberate
      // retry_node behavior keeps its own coverage there too.
      const resumed = await resumeWorkflowRun(parent.runDir)
      expect(resumed.status).toBe('completed')
      const nodeRun = await readNodeRun(parent.runDir, 'scan')
      expect(nodeRun?.status).toBe('completed')
    },
    40_000,
  )
})
