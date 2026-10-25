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

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createWorkflowRunWatcher,
  listWorkflowRunWatches,
  readWorkflowRunHeartbeat,
  registerWorkflowRunWatch,
  waitForWorkflowRun,
  workflowRunPulse,
  WORKFLOW_HEARTBEAT_FILE,
  type WorkflowRunNotification,
} from './runPulse.js'
import { resumeWorkflowRun, respondToWorkflowNode, startWorkflowRun } from './workflowRuntime.js'
import { readWorkflowRun } from './workflowStore.js'
import type { MatOSWorkflowDefinition } from './types.js'

function execDefinition(name: string, command: string): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name,
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes: [{ id: 'work', type: 'exec', dependsOn: [], command }],
  }
}

async function completedRun(root: string) {
  return startWorkflowRun({
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:pulse-demo@0.1.0',
    parameters: {},
    workspaceDir: root,
    definition: execDefinition('pulse-demo', 'printf pulse-ok'),
  })
}

describe('workflow run pulse', () => {
  test('new active detached watches hold the headless drain until their real terminal notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-watch-drain-'))
    const watcher = createWorkflowRunWatcher({ cwd: root, sessionId: 'drain-chat', onNotification: () => {} })
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'), workflowRef: 'workflow:drain-probe',
      parameters: {}, workspaceDir: root, advance: false,
      definition: execDefinition('drain-probe', 'printf drain-done'),
    })
    await registerWorkflowRunWatch({ cwd: root, sessionId: 'drain-chat', runId: run.runId, runDir: run.runDir })
    const intervalScan = watcher.tick()
    const boundaryScan = watcher.tick()
    expect(boundaryScan).toBe(intervalScan)
    await boundaryScan
    expect(watcher.hasPendingRuns()).toBe(true)
    await resumeWorkflowRun(run.runDir)
    expect(await watcher.tick()).toHaveLength(1)
    expect(watcher.hasPendingRuns()).toBe(false)
  })
  test('historical active watches do not pin a new headless session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-watch-historical-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'), workflowRef: 'workflow:old-probe',
      parameters: {}, workspaceDir: root, advance: false,
      definition: execDefinition('old-probe', 'printf old-done'),
    })
    await registerWorkflowRunWatch({ cwd: root, sessionId: 'previous-chat', runId: run.runId, runDir: run.runDir })
    const path = join(root, '.matos/runtime/workflow-run-watch', `${run.runId}.json`)
    const entry = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...entry, registeredAt: '2000-01-01T00:00:00Z' }))
    const watcher = createWorkflowRunWatcher({ cwd: root, sessionId: 'new-chat', onNotification: () => {} })
    await watcher.tick()
    expect(watcher.hasPendingRuns()).toBe(false)
    await resumeWorkflowRun(run.runDir)
    expect(await watcher.tick()).toHaveLength(0)
    expect(await listWorkflowRunWatches(root)).toHaveLength(1)
  })
  test('advancing a run stamps a heartbeat and pulse explains a completed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-pulse-'))
    const run = await completedRun(root)
    expect(run.status).toBe('completed')

    // The advance loop stamped a heartbeat (start + final stamp on stop).
    expect(existsSync(join(run.runDir, WORKFLOW_HEARTBEAT_FILE))).toBe(true)
    const heartbeat = await readWorkflowRunHeartbeat(run.runDir)
    expect(heartbeat?.pid).toBe(process.pid)
    expect(heartbeat?.processAlive).toBe(true)
    expect(heartbeat?.ageSeconds).toBeLessThan(60)

    const pulse = await workflowRunPulse(run.runDir)
    expect(pulse.status).toBe('completed')
    expect(pulse.terminal).toBe(true)
    expect(pulse.stalled).toBe(false)
    expect(pulse.progress.totalNodes).toBe(1)
    expect(pulse.progress.settledNodes).toBe(1)
    expect(pulse.guidance.join(' ')).toContain('Run completed')
  })

  test('pulse reports failed nodes with error summaries and repair guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-pulse-fail-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pulse-fail@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: execDefinition('pulse-fail', 'echo boom >&2; exit 3'),
    })
    expect(run.status).toBe('failed')

    const pulse = await workflowRunPulse(run.runDir)
    expect(pulse.status).toBe('failed')
    expect(pulse.progress.failed.map(node => node.nodeId)).toEqual(['work'])
    expect(pulse.progress.failed[0]?.error).toBeTruthy()
    expect(pulse.guidance.join(' ')).toContain('retry_node')
  })

  test('pulse identifies an explicit upstream producer rejected by validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-pulse-causal-fail-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pulse-causal-fail@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'pulse-causal-fail',
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
                failureCode: 'non_finite_result',
                repairHint: 'Repair the producer token=secret-pulse-value.',
                sourceNodeId: 'produce',
              },
            ],
          },
        ],
      },
    })
    expect(run.status).toBe('failed')

    const pulse = await workflowRunPulse(run.runDir)
    expect(pulse.progress.failed).toEqual([
      expect.objectContaining({
        nodeId: 'validate',
        attempts: 1,
        sourceNodeIds: ['produce'],
      }),
    ])
    expect(pulse.guidance.join(' ')).toContain('upstream producer node(s): produce')
    expect(JSON.stringify(pulse)).not.toContain('secret-pulse-value')
  })

  test('a dead worker turns an active run into stalled with recovery guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-pulse-stall-'))
    const run = await completedRun(root)

    // Rewrite the durable state to look like a run whose detached worker was
    // SIGKILLed mid-flight: status running, heartbeat old and from a dead pid.
    const snapshot = await readWorkflowRun(run.runDir)
    await writeFile(
      join(run.runDir, 'run.json'),
      `${JSON.stringify({ ...snapshot, status: 'running' }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(run.runDir, WORKFLOW_HEARTBEAT_FILE),
      `${JSON.stringify({
        pid: 999999999,
        at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })}\n`,
      'utf8',
    )

    const pulse = await workflowRunPulse(run.runDir)
    expect(pulse.status).toBe('running')
    expect(pulse.stalled).toBe(true)
    expect(pulse.heartbeat?.stale).toBe(true)
    expect(pulse.guidance.join(' ')).toContain('no live worker heartbeat')
    expect(pulse.guidance.join(' ')).toContain('action=resume')
  })

  test('wait returns immediately for a settled run and carries the event cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-wait-'))
    const run = await completedRun(root)

    const first = await waitForWorkflowRun({ runDir: run.runDir, timeoutSeconds: 5 })
    expect(first.timedOut).toBe(false)
    expect(first.pulse.terminal).toBe(true)
    expect(first.newEvents.length).toBeGreaterThan(0)
    expect(first.nextSinceEventId).toBeTruthy()
    expect(first.newEvents.map(event => event.type)).toContain('workflow.run.completed')

    // Cursor: a second wait from the last seen event returns no stale events.
    const second = await waitForWorkflowRun({
      runDir: run.runDir,
      timeoutSeconds: 5,
      sinceEventId: first.nextSinceEventId ?? undefined,
    })
    expect(second.newEvents).toEqual([])
  })

  test('wait blocks on a waiting_input run and reports the respond path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-wait-input-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pulse-human@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'pulse-human',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'ask', type: 'human', dependsOn: [], prompt: 'continue?' },
          { id: 'work', type: 'exec', dependsOn: ['ask'], command: 'printf done' },
        ],
      },
    })
    expect(run.status).toBe('waiting_input')

    const waited = await waitForWorkflowRun({ runDir: run.runDir, timeoutSeconds: 5 })
    expect(waited.timedOut).toBe(false)
    expect(waited.pulse.waiting).toEqual({ nodeId: 'ask', kind: 'input' })
    expect(waited.pulse.guidance.join(' ')).toContain('action=respond')

    await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'ask',
      response: { approved: true },
    })
    const settled = await waitForWorkflowRun({ runDir: run.runDir, timeoutSeconds: 10 })
    expect(settled.pulse.status).toBe('completed')
  })

  test('watcher pushes one notification per transition and clears terminal watches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-watch-'))
    const run = await completedRun(root)

    await registerWorkflowRunWatch({
      cwd: root,
      sessionId: 'terminal-chat',
      runId: run.runId,
      runDir: run.runDir,
      workflowRef: 'workflow:pulse-demo@0.1.0',
    })
    expect((await listWorkflowRunWatches(root)).map(entry => entry.runId)).toEqual([
      run.runId,
    ])

    const notifications: WorkflowRunNotification[] = []
    const watcher = createWorkflowRunWatcher({
      cwd: root,
      sessionId: 'terminal-chat',
      onNotification: notification => notifications.push(notification),
    })

    const emitted = await watcher.tick()
    expect(emitted).toHaveLength(1)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.statusClass).toBe('completed')
    expect(notifications[0]?.message).toContain('<workflow-notification>')
    expect(notifications[0]?.message).toContain(run.runId)
    expect(notifications[0]?.message).toContain('completed')

    // Terminal watch entries are consumed: no repeat, registry emptied.
    expect(await watcher.tick()).toHaveLength(0)
    expect(await listWorkflowRunWatches(root)).toEqual([])
  })

  test('watcher notifies waiting_input once, then again on the terminal transition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-watch-input-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pulse-human@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'pulse-human',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [{ id: 'ask', type: 'human', dependsOn: [], prompt: 'continue?' }],
      },
    })
    await registerWorkflowRunWatch({
      cwd: root,
      sessionId: 'human-chat',
      runId: run.runId,
      runDir: run.runDir,
    })

    const notifications: WorkflowRunNotification[] = []
    const watcher = createWorkflowRunWatcher({
      cwd: root,
      sessionId: 'human-chat',
      onNotification: notification => notifications.push(notification),
    })

    await watcher.tick()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.statusClass).toBe('waiting_input')
    expect(watcher.hasPendingRuns()).toBe(false)
    expect(notifications[0]?.message).toContain('action=respond')
    // Same waiting state: no duplicate push.
    await watcher.tick()
    expect(notifications).toHaveLength(1)

    await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'ask',
      response: 'go ahead',
    })
    await watcher.tick()
    expect(notifications).toHaveLength(2)
    expect(notifications[1]?.statusClass).toBe('completed')
    expect(await listWorkflowRunWatches(root)).toEqual([])
  })

  test('heartbeat file survives with final stamp contents after the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-run-hb-'))
    const run = await completedRun(root)
    const raw = JSON.parse(
      await readFile(join(run.runDir, WORKFLOW_HEARTBEAT_FILE), 'utf8'),
    ) as { pid: number; at: string }
    expect(raw.pid).toBe(process.pid)
    expect(Number.isFinite(Date.parse(raw.at))).toBe(true)
  })
})
