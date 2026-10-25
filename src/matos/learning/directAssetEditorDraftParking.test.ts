import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  parkDirectEditorRuntimeAssetsAsDraft,
  shouldAutoRollbackAcceptedRunForRegression,
} from './directAssetEditor.js'

async function writeManifest(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('direct editor draft parking', () => {
  test('parks enabled manifests back to draft, including metadata mirror', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-draft-parking-'))
    const skillDir = join(root, 'skills', 'new-skill')
    await mkdir(skillDir, { recursive: true })
    const manifestPath = join(skillDir, 'asset.json')
    await writeManifest(manifestPath, {
      id: 'new-skill',
      type: 'skill',
      name: 'New Skill',
      version: '0.1.0',
      lifecycle: { status: 'enabled' },
      metadata: { lifecycle: 'enabled' },
    })

    await parkDirectEditorRuntimeAssetsAsDraft([manifestPath])

    const parked = await readManifest(manifestPath)
    expect((parked.lifecycle as Record<string, unknown>).status).toBe('draft')
    expect((parked.metadata as Record<string, unknown>).lifecycle).toBe('draft')
  })

  test('leaves non-enabled manifests and unreadable paths untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-draft-parking-skip-'))
    const dir = join(root, 'skills', 'already-draft')
    await mkdir(dir, { recursive: true })
    const manifestPath = join(dir, 'asset.json')
    await writeManifest(manifestPath, {
      id: 'already-draft',
      type: 'skill',
      name: 'Already Draft',
      version: '0.1.0',
      lifecycle: { status: 'draft', reason: 'authored draft' },
    })

    await parkDirectEditorRuntimeAssetsAsDraft([
      manifestPath,
      join(root, 'skills', 'missing', 'asset.json'),
    ])

    const untouched = await readManifest(manifestPath)
    expect((untouched.lifecycle as Record<string, unknown>).reason).toBe(
      'authored draft',
    )
    expect((untouched.lifecycle as Record<string, unknown>).status).toBe('draft')
  })
})

describe('regression probation gate', () => {
  const failed = { status: 'completed', overallOk: false }
  const passed = { status: 'completed', overallOk: true }
  const uncovered = { status: 'no-benchmarks', overallOk: true }

  test('is evidence-only by default', () => {
    expect(shouldAutoRollbackAcceptedRunForRegression(failed, {})).toBe(false)
    expect(shouldAutoRollbackAcceptedRunForRegression(failed, undefined)).toBe(
      false,
    )
  })

  test('rolls back only clearly-failed completed regressions when opted in', () => {
    const env = { MATOS_EVOLUTION_REGRESSION_AUTO_ROLLBACK: '1' }
    expect(shouldAutoRollbackAcceptedRunForRegression(failed, env)).toBe(true)
    expect(shouldAutoRollbackAcceptedRunForRegression(passed, env)).toBe(false)
    // Absence of benchmark coverage is not evidence of regression.
    expect(shouldAutoRollbackAcceptedRunForRegression(uncovered, env)).toBe(false)
    expect(shouldAutoRollbackAcceptedRunForRegression(undefined, env)).toBe(false)
  })

  test('explicit off wins over an ambient on', () => {
    expect(
      shouldAutoRollbackAcceptedRunForRegression(failed, {
        MATOS_EVOLUTION_REGRESSION_AUTO_ROLLBACK: '0',
      }),
    ).toBe(false)
  })
})
