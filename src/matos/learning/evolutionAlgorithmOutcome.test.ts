import { rm } from 'node:fs/promises'
import { expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { readMatOSAlgorithmOutcomes } from '../algorithms/outcomes/ledger.js'
import { createMatOSEvolutionAlgorithmRuntime } from './evolutionAlgorithmRuntime.js'
import { recordEvolutionAlgorithmOutcome } from './evolutionAlgorithmOutcome.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'

test('native outcome ledger deduplicates evolution transactions, denies foreign scope and never invents rewards', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-outcome-' })
  const env = {
    MATOS_USER_ID: 'alice',
    MATOS_SCOPE_REF: 'user:alice',
    MATOS_ALGO_CAPTURE: '0',
    MATOS_ALGO_TELEMETRY: '0',
  }
  try {
    const algorithm = await createMatOSEvolutionAlgorithmRuntime({
      cwd,
      scopeRef: 'user:alice',
      env,
    })
    await algorithm.decide({
      schemaVersion: 1,
      phase: 'observed',
      trigger: { kind: 'user-feedback', key: 'test' },
      constraints: { canAnalyze: true, canEdit: true, maxSignals: 2 },
      signals: [],
    })
    const run: MatOSDirectAssetEditorRunRecord = {
      runId: 'evolution-ledger-test',
      scope: 'user',
      status: 'accepted',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:01.000Z',
      input: {
        generatedAt: '2026-09-13T00:00:00.000Z',
        scope: 'user',
        scopeRef: 'user:alice',
        editableRoots: [],
        experiences: [],
        targetAssets: [],
        currentEvolutionContext: { algorithm: algorithm.journal() },
      },
      editorOutput: {
        summary: 'Accepted transaction',
        modifiedFiles: [],
        createdAssets: [],
        updatedAssets: [],
        disabledAssets: [],
        evidenceRefs: [],
      },
      modifiedFiles: [],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
      roleExitCode: 0,
    }
    expect(await recordEvolutionAlgorithmOutcome(cwd, run, env)).toBe(true)
    expect(await recordEvolutionAlgorithmOutcome(cwd, run, env)).toBe(true)
    const records = await readMatOSAlgorithmOutcomes(cwd, {}, { env })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'evolution-run',
      trainingEligible: false,
      metrics: { nativePublicationAccepted: true, effectivenessProven: false },
      evidenceCompleteness: { status: 'incomplete' },
    })
    expect(records[0]).not.toHaveProperty('reward')
    expect(
      await recordEvolutionAlgorithmOutcome(
        cwd,
        { ...run, input: { ...run.input, scopeRef: 'user:bob' } },
        env,
      ),
    ).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
