import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { refreshWorkflowBudgetLedger } from './budget.js'
import { createWorkflowRun, readWorkflowRun } from './workflowStore.js'
import type { MatOSWorkflowRunStatus } from './types.js'

const roots: string[] = []
const created = Date.parse('2026-09-13T00:00:00Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(status: MatOSWorkflowRunStatus): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-budget-clock-'))
  roots.push(root)
  const handle = await createWorkflowRun({
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:budget-clock@1.0.0',
    graphSnapshot: {
      schemaVersion: 1,
      name: 'Budget clock',
      parameters: {},
      outputs: {},
      nodes: [{ id: 'step', type: 'exec', command: 'true', dependsOn: [] }],
    },
    workspaceDir: root,
  })
  await writeFile(join(handle.dir, 'run.json'), JSON.stringify({
    ...await readWorkflowRun(handle.dir),
    status,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created + 10_000).toISOString(),
  }))
  return handle.dir
}

test.each(['completed', 'failed', 'cancelled'] as const)(
  'budget elapsed time stays fixed when inspecting a %s run',
  async status => {
    const runDir = await fixture(status)
    const now = spyOn(Date, 'now').mockReturnValue(created + 60_000)
    try {
      const first = await refreshWorkflowBudgetLedger(runDir)
      now.mockReturnValue(created + 3_600_000)
      const later = await refreshWorkflowBudgetLedger(runDir)
      expect(first.totals.elapsedWallTimeMs).toBe(10_000)
      expect(later.totals.elapsedWallTimeMs).toBe(10_000)
      expect(later.ownTotals.elapsedWallTimeMs).toBe(10_000)
    } finally {
      now.mockRestore()
    }
  },
)

test.each(['running', 'waiting_input', 'paused'] as const)(
  'budget elapsed time continues while a run is %s',
  async status => {
    const runDir = await fixture(status)
    const now = spyOn(Date, 'now').mockReturnValue(created + 60_000)
    try {
      expect((await refreshWorkflowBudgetLedger(runDir)).totals.elapsedWallTimeMs).toBe(60_000)
      now.mockReturnValue(created + 120_000)
      expect((await refreshWorkflowBudgetLedger(runDir)).totals.elapsedWallTimeMs).toBe(120_000)
    } finally {
      now.mockRestore()
    }
  },
)
