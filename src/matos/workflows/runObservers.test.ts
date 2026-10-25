import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  notifyWorkflowRunPersisted,
  registerWorkflowRunObserver,
} from './runObservers.js'
import type { MatOSWorkflowRunSnapshot } from './types.js'

const snapshot: MatOSWorkflowRunSnapshot = {
  runId: 'run-observer-test',
  workflowRef: 'workflow:observer-test@1.0.0',
  status: 'created',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  parameters: {},
  outputs: {},
  graphSnapshotPath: 'graph.snapshot.json',
  artifactRoot: '/tmp/artifacts',
  projectCwd: '/tmp',
  workspaceDir: '/tmp',
}

async function creationEvent(suffix: string) {
  const runDir = await mkdtemp(join(tmpdir(), `matos-observer-${suffix}-`))
  await writeFile(
    join(runDir, 'graph.snapshot.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      name: `observer-${suffix}`,
      parameters: {},
      policy: {},
      nodes: [],
      outputs: {},
    })}\n`,
    'utf8',
  )
  return {
    runDir,
    snapshot: { ...snapshot, runId: `run-observer-${suffix}` },
    phase: 'created' as const,
  }
}

describe('workflow run observers', () => {
  test('critical asynchronous creation failures are fail-closed', async () => {
    const unregister = registerWorkflowRunObserver(
      'test-critical-created-observer',
      async () => {
        throw new Error('manifest publish failed')
      },
      { failClosedOnCreate: true },
    )
    try {
      const event = await creationEvent('critical')
      await expect(
        notifyWorkflowRunPersisted(event),
      ).rejects.toThrow('manifest publish failed')
    } finally {
      unregister()
    }
  })

  test('non-critical and update observer failures remain fail-soft', async () => {
    const unregister = registerWorkflowRunObserver(
      'test-fail-soft-observer',
      async () => {
        throw new Error('best-effort observer failed')
      },
      { failClosedOnCreate: false },
    )
    try {
      const event = await creationEvent('soft')
      await expect(
        notifyWorkflowRunPersisted(event),
      ).resolves.toBeUndefined()
      await expect(
        notifyWorkflowRunPersisted({ runDir: '/tmp/run', snapshot, phase: 'updated' }),
      ).resolves.toBeUndefined()
    } finally {
      unregister()
    }
  })
})
