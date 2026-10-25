import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { runMatOSEvolveCommand } from './evolve.js'

function captureIO(cwd: string) {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      cwd,
      env: process.env,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-f2a-cli-'))
  await mkdir(join(root, '.matos', 'evolution', 'episodes'), { recursive: true })
  await writeFile(
    getMatOSConfigPath(root),
    `${JSON.stringify(
      { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    join(root, '.matos', 'evolution', 'episodes', 'episode-cli-uf-0.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        episodeId: 'episode-cli-uf-0',
        intakeId: 'intake-cli',
        createdAt: '2026-07-09T12:00:00.000Z',
        kind: 'user-feedback',
        summary: 'User reported a queue mismatch on VASP submission.',
        observedFailure: 'partition not allowed for this account',
        suspectedRefs: [],
        evidenceRefs: { feedbackIds: ['fb-1'] },
        privacy: { redacted: true },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

describe('matos evolve Failure2Asset CLI', () => {
  test('proposals generate -> draft-assets -> benchmarks draft/run', async () => {
    const root = await createWorkspace()

    const generate = captureIO(root)
    expect(
      await runMatOSEvolveCommand(
        ['proposals', 'generate', '--episode', 'episode-cli-uf-0', '--json'],
        generate.io,
      ),
    ).toBe(0)
    const generated = JSON.parse(generate.out()) as {
      proposals: Array<{ proposalId: string; action: string }>
    }
    expect(generated.proposals).toHaveLength(1)
    const proposalId = generated.proposals[0].proposalId
    expect(generated.proposals[0].action).toBe('create-knowledge-runbook')

    const draft = captureIO(root)
    expect(
      await runMatOSEvolveCommand(
        ['draft-assets', '--proposal', proposalId, '--json'],
        draft.io,
      ),
    ).toBe(0)
    const draftResult = JSON.parse(draft.out()) as {
      applied: boolean
      validation: { ok: boolean }
      targetPackPath: string
    }
    expect(draftResult.applied).toBe(true)
    expect(draftResult.validation.ok).toBe(true)
    expect(existsSync(join(root, draftResult.targetPackPath))).toBe(true)

    const benchDraft = captureIO(root)
    expect(
      await runMatOSEvolveCommand(
        ['benchmarks', 'draft', '--proposal', proposalId, '--json'],
        benchDraft.io,
      ),
    ).toBe(0)
    expect(JSON.parse(benchDraft.out()).case.kind).toBe('artifact-check')

    const benchRun = captureIO(root)
    expect(
      await runMatOSEvolveCommand(
        ['benchmarks', 'run', '--proposal', proposalId, '--json'],
        benchRun.io,
      ),
    ).toBe(0)
    const runResult = JSON.parse(benchRun.out()) as {
      result: { status: string; ok: boolean }
    }
    expect(runResult.result.status).toBe('succeeded')
    expect(runResult.result.ok).toBe(true)
  })

  test('factory runs the full pipeline in one command', async () => {
    const root = await createWorkspace()
    const factory = captureIO(root)
    expect(
      await runMatOSEvolveCommand(
        ['factory', '--episode', 'episode-cli-uf-0', '--json'],
        factory.io,
      ),
    ).toBe(0)
    const result = JSON.parse(factory.out()) as {
      proposals: Array<{
        draftAssets: { applied: boolean }
        regression: { status: string }
      }>
    }
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].draftAssets.applied).toBe(true)
    expect(result.proposals[0].regression.status).toBe('succeeded')
  })

  test('rejects missing episode / proposal arguments', async () => {
    const root = await createWorkspace()
    expect(
      await runMatOSEvolveCommand(['proposals', 'generate', '--json'], captureIO(root).io),
    ).toBe(1)
    expect(
      await runMatOSEvolveCommand(['draft-assets', '--json'], captureIO(root).io),
    ).toBe(1)
    expect(
      await runMatOSEvolveCommand(['benchmarks', 'run', '--json'], captureIO(root).io),
    ).toBe(1)
    expect(
      await runMatOSEvolveCommand(['factory', '--json'], captureIO(root).io),
    ).toBe(1)
  })
})
