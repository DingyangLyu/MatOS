import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSEvolveCommand } from './evolve.js'
import { runMatOSAssetsCommand } from './assets.js'

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
  const repo = await mkdtemp(join(tmpdir(), 'matos-intake-repo-'))
  await writeFile(
    join(repo, 'README.md'),
    '# Demo Relax Tool\n\nA small CLI that relaxes a crystal structure with ASE.\n\n## Usage\n\n```bash\npython relax.py input.cif\n```\n',
    'utf8',
  )
  await writeFile(join(repo, 'requirements.txt'), 'ase\npymatgen\n', 'utf8')
  await writeFile(
    join(repo, 'relax.py'),
    'import sys\n\n\ndef main() -> None:\n    print("relax", sys.argv)\n\n\nif __name__ == "__main__":\n    main()\n',
    'utf8',
  )
  return repo
}

describe('matos evolve intake / assets factory aliases', () => {
  test('evolve intake repo classifies a local repo via the workbench intake', async () => {
    const repo = await makeRepo()
    const ws = await mkdtemp(join(tmpdir(), 'matos-intake-ws-'))
    const { io, out } = captureIO(ws)
    const code = await runMatOSEvolveCommand(
      ['intake', 'repo', '--path', repo, '--json'],
      io,
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(out())
    expect(parsed.mode).toBe('external-intake-classify')
    expect(Array.isArray(parsed.classification.proposals)).toBe(true)
    expect(parsed.classification.proposals.length).toBeGreaterThan(0)
  })

  test('assets factory repo2asset previews then applies a draft pack', async () => {
    const repo = await makeRepo()
    const ws = await mkdtemp(join(tmpdir(), 'matos-intake-ws2-'))

    const preview = captureIO(ws)
    const previewCode = await runMatOSAssetsCommand(
      ['factory', 'repo2asset', '--path', repo, '--json'],
      preview.io,
    )
    expect(previewCode).toBe(0)
    const previewJson = JSON.parse(preview.out())
    expect(previewJson.mode).toBe('external-intake-draft-pack-preview')
    const fingerprint = previewJson.transaction.confirmationFingerprint
    expect(typeof fingerprint).toBe('string')
    expect(fingerprint.length).toBeGreaterThan(0)

    const apply = captureIO(ws)
    const applyCode = await runMatOSAssetsCommand(
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
    )
    expect(applyCode).toBe(0)
    expect(JSON.parse(apply.out()).mode).toBe(
      'external-intake-draft-pack-controlled-write',
    )
    expect(existsSync(join(ws, '.matos', 'assets', 'packs'))).toBe(true)
  })

  test('evolve intake paper classifies a markdown paper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matos-intake-paper-'))
    const paper = join(dir, 'method.md')
    await writeFile(
      paper,
      '# A Method For X\n\nWe propose an algorithm for X. Table 1 reports MAE against a baseline.\n',
      'utf8',
    )
    const ws = await mkdtemp(join(tmpdir(), 'matos-intake-ws3-'))
    const { io, out } = captureIO(ws)
    const code = await runMatOSEvolveCommand(
      ['intake', 'paper', '--path', paper, '--json'],
      io,
    )
    expect(code).toBe(0)
    expect(JSON.parse(out()).mode).toBe('external-intake-classify')
  })

  test('rejects missing kind and missing source', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'matos-intake-ws4-'))
    expect(await runMatOSEvolveCommand(['intake', '--json'], captureIO(ws).io)).toBe(1)
    expect(
      await runMatOSEvolveCommand(['intake', 'repo', '--json'], captureIO(ws).io),
    ).toBe(1)
    expect(
      await runMatOSAssetsCommand(['factory', 'bogus', '--json'], captureIO(ws).io),
    ).toBe(1)
    expect(
      await runMatOSAssetsCommand(
        ['factory', 'repo2asset', '--json'],
        captureIO(ws).io,
      ),
    ).toBe(1)
    expect(
      await runMatOSAssetsCommand(
        ['factory', 'repo2asset', '--path', '/nonexistent-x', '--apply', '--json'],
        captureIO(ws).io,
      ),
    ).toBe(1)
  })
})
