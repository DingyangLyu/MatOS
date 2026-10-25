import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSBenchmarkCase } from '../learning/benchmarkRunner.js'
import { runMatOSAssetsCommand } from '../cli/assets.js'
import { draftMatOSIntakeBenchmarkCase } from './externalIntakeBenchmark.js'

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

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'matos-intakebench-repo-'))
  await writeFile(
    join(repo, 'README.md'),
    '# Relax CLI\n\nRelaxes a crystal with ASE.\n\n```bash\npython relax.py input.cif\n```\n',
    'utf8',
  )
  await writeFile(join(repo, 'requirements.txt'), 'ase\npymatgen\n', 'utf8')
  await writeFile(
    join(repo, 'relax.py'),
    'import sys\n\n\ndef main() -> None:\n    print(sys.argv)\n\n\nif __name__ == "__main__":\n    main()\n',
    'utf8',
  )
  return repo
}

describe('external intake benchmark draft', () => {
  test('builds an artifact-check case from a plan; undefined when no assets', () => {
    expect(
      draftMatOSIntakeBenchmarkCase({
        targetPack: {
          packId: 'p',
          manifestRelativePath: '.matos/assets/packs/p/matos.pack.json',
        },
        proposedAssets: [],
        provenance: { intakeRef: 'external-intake:p' },
      }),
    ).toBeUndefined()

    const draft = draftMatOSIntakeBenchmarkCase({
      targetPack: {
        packId: 'demo-pack',
        manifestRelativePath: '.matos/assets/packs/demo-pack/matos.pack.json',
      },
      proposedAssets: [
        {
          id: 'demo-tool',
          ref: 'tool:demo-tool@0.1.0',
          type: 'tool',
          primary: true,
          manifestRelativePath:
            '.matos/assets/packs/demo-pack/tool/demo-tool/asset.json',
        },
      ],
      provenance: { intakeRef: 'external-intake:demo', sourceFingerprint: 'abc123def' },
    })
    expect(draft?.case.kind).toBe('artifact-check')
    expect(draft?.case.id).toBe('intake-demo-pack-pack-integrity')
    expect(draft?.case.task.input.path).toContain('demo-tool/asset.json')
    expect(draft?.case.checks.some(check => check.value === 'demo-tool')).toBe(true)
    expect(draft?.case.checks.some(check => check.value === 'abc123def')).toBe(true)
  })

  test('factory --with-benchmark emits a benchmark that passes on the applied pack', async () => {
    const repo = await makeRepo()
    const ws = await mkdtemp(join(tmpdir(), 'matos-intakebench-ws-'))

    const preview = captureIO(ws)
    expect(
      await runMatOSAssetsCommand(
        ['factory', 'repo2asset', '--path', repo, '--with-benchmark', '--json'],
        preview.io,
      ),
    ).toBe(0)
    const previewJson = JSON.parse(preview.out())
    expect(previewJson.benchmark?.case?.kind).toBe('artifact-check')
    const benchmarkCase = previewJson.benchmark.case
    const fingerprint = previewJson.transaction.confirmationFingerprint
    expect(typeof fingerprint).toBe('string')

    const apply = captureIO(ws)
    expect(
      await runMatOSAssetsCommand(
        [
          'factory',
          'repo2asset',
          '--path',
          repo,
          '--fingerprint',
          fingerprint,
          '--apply',
          '--json',
        ],
        apply.io,
      ),
    ).toBe(0)

    const casePath = join(ws, 'intake-benchmark-case.json')
    await writeFile(casePath, JSON.stringify(benchmarkCase), 'utf8')
    const result = await runMatOSBenchmarkCase({
      cwd: ws,
      benchmarkRef: 'external-intake-benchmark',
      casePath,
    })
    expect(result.kind).toBe('artifact-check')
    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
  })
})
