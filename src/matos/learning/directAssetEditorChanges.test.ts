import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { createMatOSAssetHistorySnapshot } from '../assets/history/index.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { observeDirectEditorAssetChanges } from './directAssetEditorChanges.js'
import { evaluateDirectEditorUsability } from './directAssetEditor.js'
import { evaluateMatOSEvolutionTargetConformance } from './evolutionTargetGovernance.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('actual changes use nearest manifest ownership and treat version changes as updates', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-change-evidence-' })
  roots.push(cwd)
  const parent = 'matos-assets/packs/matos-core/skills/parent'
  const child = `${parent}/knowledge/child`
  const manifest = (type: string, id: string, version = '1.0.0') =>
    JSON.stringify({
      schemaVersion: 1,
      type,
      id,
      version,
      name: id,
      entry: 'entry.md',
    })
  await mkdir(join(cwd, child), { recursive: true })
  await writeFile(join(cwd, parent, 'asset.json'), manifest('skill', 'parent'))
  await writeFile(join(cwd, parent, 'entry.md'), 'parent unchanged\n')
  await writeFile(
    join(cwd, child, 'asset.json'),
    manifest('knowledge', 'child'),
  )
  await writeFile(join(cwd, child, 'entry.md'), 'before\n')
  const before = await createMatOSAssetHistorySnapshot({
    cwd,
    scope: 'core',
    kind: 'manual',
  })
  await writeFile(
    join(cwd, child, 'asset.json'),
    manifest('knowledge', 'child', '1.0.1'),
  )
  await writeFile(join(cwd, child, 'entry.md'), 'after\n')
  const after = await createMatOSAssetHistorySnapshot({
    cwd,
    scope: 'core',
    kind: 'manual',
  })
  const observed = await observeDirectEditorAssetChanges({
    cwd,
    beforeSnapshot: before.snapshotId,
    afterSnapshot: after.snapshotId,
  })
  expect(observed.actualRefs).toEqual([
    'knowledge:child@1.0.0',
    'knowledge:child@1.0.1',
  ])
  expect(observed.createdAssets).toEqual([])
  expect(observed.updatedAssets).toEqual(['knowledge:child@1.0.1'])
  expect(observed.disabledAssets).toEqual([])
  const empty = await observeDirectEditorAssetChanges({
    cwd,
    beforeSnapshot: before.snapshotId,
    afterSnapshot: after.snapshotId,
    onlyPaths: [],
  })
  expect(empty.actualRefs).toEqual([])
  const evidence = evaluateMatOSEvolutionTargetConformance({
    editorOutput: { updatedAssets: ['tool:invented@1.0.0'] },
    actualRefs: observed.actualRefs,
  })
  expect(evidence.actualTypes).toEqual(['knowledge'])
  expect(evidence.actualRefs).toEqual(observed.actualRefs)
  await rm(join(cwd, child), { recursive: true })
  const deleted = await createMatOSAssetHistorySnapshot({
    cwd,
    scope: 'core',
    kind: 'manual',
  })
  const removal = await observeDirectEditorAssetChanges({
    cwd,
    beforeSnapshot: after.snapshotId,
    afterSnapshot: deleted.snapshotId,
  })
  expect(removal.actualRefs).toEqual(['knowledge:child@1.0.1'])
  expect(removal.disabledAssets).toEqual(['knowledge:child@1.0.1'])
})

test('crashed baseline cannot excuse invalid candidates or secret findings', () => {
  const valid = {
    ok: true,
    gateProfile: 'smoke' as const,
    assetValidation: { ok: true, errors: [] },
    secretScan: { ok: true, findings: [] },
    workflowValidation: [],
  }
  expect(
    evaluateDirectEditorUsability(undefined, valid, {
      baselineUnavailable: true,
    }).usable,
  ).toBe(true)
  const invalid = {
    ...valid,
    ok: false,
    assetValidation: {
      ok: false,
      errors: [{ code: 'invalid', message: 'Broken candidate' }],
    },
  }
  expect(
    evaluateDirectEditorUsability(undefined, invalid, {
      baselineUnavailable: true,
    }),
  ).toMatchObject({
    usable: false,
    introducedErrors: [
      { code: 'baseline_validation_unavailable' },
      { code: 'invalid' },
    ],
  })
  expect(
    evaluateDirectEditorUsability(
      undefined,
      {
        ...valid,
        secretScan: {
          ok: false,
          findings: [{ path: 'entry.md', reason: 'secret' }],
        },
      },
      { baselineUnavailable: true },
    ).usable,
  ).toBe(false)
})
