import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunWatcher, listWorkflowRunWatches, registerWorkflowRunWatch } from './runPulse.js'
import { resumeWorkflowRun, startWorkflowRun } from './workflowRuntime.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function pendingRun() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-owner-'))
  roots.push(root)
  const run = await startWorkflowRun({
    workflowsDir: join(root, 'workflows'), workflowRef: 'workflow:owner-test@0.1.0',
    parameters: {}, workspaceDir: root, advance: false,
    definition: { schemaVersion: 1, name: 'owner-test', parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' }, outputs: {},
      nodes: [{ id: 'work', type: 'exec', dependsOn: [], command: 'printf owner-test-done' }],
    },
  })
  return { root, run }
}

test('only the originating chat waits and receives a real workflow completion', async () => {
  const { root, run } = await pendingRun()
  const owner = createWorkflowRunWatcher({ cwd: root, sessionId: 'chat-a', onNotification: () => {} })
  const other = createWorkflowRunWatcher({ cwd: root, sessionId: 'chat-b', onNotification: () => {} })
  await registerWorkflowRunWatch({ cwd: root, runId: run.runId, runDir: run.runDir, sessionId: 'chat-a' })
  await owner.tick()
  await other.tick()
  expect(owner.hasPendingRuns()).toBe(true)
  expect(other.hasPendingRuns()).toBe(false)
  expect((await resumeWorkflowRun(run.runDir)).status).toBe('completed')
  expect(await other.tick()).toEqual([])
  expect(await listWorkflowRunWatches(root)).toHaveLength(1)
  expect(await owner.tick()).toHaveLength(1)
  expect(await owner.tick()).toEqual([])
  expect(await listWorkflowRunWatches(root)).toEqual([])
})

test('a resumed native session keeps ownership of an older pending workflow', async () => {
  const { root, run } = await pendingRun()
  await registerWorkflowRunWatch({ cwd: root, runId: run.runId, runDir: run.runDir, sessionId: 'resumed-chat' })
  const file = join(root, '.matos/runtime/workflow-run-watch', run.runId + '.json')
  const entry = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...entry, registeredAt: '2000-01-01T00:00:00Z' }))
  const owner = createWorkflowRunWatcher({ cwd: root, sessionId: 'resumed-chat', onNotification: () => {} })
  await owner.tick()
  expect(owner.hasPendingRuns()).toBe(true)
  await resumeWorkflowRun(run.runDir)
  expect(await owner.tick()).toHaveLength(1)
})

test('unowned legacy watches are retained without delivery to an arbitrary chat', async () => {
  const { root, run } = await pendingRun()
  await registerWorkflowRunWatch({ cwd: root, runId: run.runId, runDir: run.runDir })
  const watcher = createWorkflowRunWatcher({ cwd: root, sessionId: 'new-chat', onNotification: () => {} })
  await watcher.tick()
  expect(watcher.hasPendingRuns()).toBe(false)
  await resumeWorkflowRun(run.runDir)
  expect(await watcher.tick()).toEqual([])
  expect(await listWorkflowRunWatches(root)).toHaveLength(1)
})

test('session switching and stopped watchers cannot consume the previous chat notification', async () => {
  const { root, run } = await pendingRun()
  await registerWorkflowRunWatch({ cwd: root, runId: run.runId, runDir: run.runDir, sessionId: 'chat-a' })
  let sessionId = 'chat-a'
  const watcher = createWorkflowRunWatcher({ cwd: root, sessionId: () => sessionId, onNotification: () => {} })
  await watcher.tick()
  expect(watcher.hasPendingRuns()).toBe(true)
  sessionId = 'chat-b'
  expect(watcher.hasPendingRuns()).toBe(false)
  await resumeWorkflowRun(run.runDir)
  expect(await watcher.tick()).toEqual([])
  sessionId = 'chat-a'
  watcher.stop()
  expect(await watcher.tick()).toEqual([])
  const resumed = createWorkflowRunWatcher({ cwd: root, sessionId: 'chat-a', onNotification: () => {} })
  expect(await resumed.tick()).toHaveLength(1)
})

test('an in-flight scan stops without consuming a notification and a failed consumer can retry', async () => {
  const { root, run } = await pendingRun()
  await registerWorkflowRunWatch({ cwd: root, runId: run.runId, runDir: run.runDir, sessionId: 'chat-a' })
  await resumeWorkflowRun(run.runDir)
  const stopped = createWorkflowRunWatcher({ cwd: root, sessionId: 'chat-a', onNotification: () => { throw new Error('must not be called') } })
  const scan = stopped.tick()
  stopped.stop()
  expect(await scan).toEqual([])
  expect(await listWorkflowRunWatches(root)).toHaveLength(1)
  let throws = true
  const watcher = createWorkflowRunWatcher({ cwd: root, sessionId: 'chat-a', onNotification: () => {
    if (throws) throw new Error('Queue unavailable')
  } })
  await expect(watcher.tick()).rejects.toThrow('Queue unavailable')
  expect(await listWorkflowRunWatches(root)).toHaveLength(1)
  throws = false
  expect(await watcher.tick()).toHaveLength(1)
  expect(await listWorkflowRunWatches(root)).toEqual([])
})
