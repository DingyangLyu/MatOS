import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { runMatOSAssetsCommand } from './assets.js'

const execFileAsync = promisify(execFile)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(result.stdout ?? '').trim()
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '.'])
  await git(cwd, [
    '-c',
    'user.name=MatOS Test',
    '-c',
    'user.email=matos-test@localhost',
    'commit',
    '-m',
    message,
  ])
}

describe('matos assets git sync-generated-scope', () => {
  test('syncs generated scoped assets through the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-cli-generated-sync-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-assets-cli-generated-sync-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'bob scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed bob assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/bob-assets/stable', seedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'bob-assets',
          repo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/bob-assets/stable',
            commit: seedCommit,
          },
          scope: 'user',
          scopeRef: 'user:bob',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })
    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'bob',
      'skills',
      'vasp-preflight-runbook',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-preflight-runbook',
      type: 'skill',
      name: 'VASP Preflight Runbook',
      version: '1.0.0',
      entry: 'SKILL.md',
    })
    await writeFile(
      join(generatedDir, 'SKILL.md'),
      '# VASP Preflight Runbook\n\nCheck VASP pseudopotentials before submitting jobs.\n',
      'utf8',
    )

    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runMatOSAssetsCommand(
      [
        'git',
        'sync-generated-scope',
        '--scope',
        'user',
        '--scope-ref',
        'user:bob',
        '--json',
      ],
      {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.join('')).toBe('')
    const payload = JSON.parse(stdout.join('')) as {
      ok: boolean
      copiedAssets: Array<{ canonicalRef: string }>
    }
    expect(payload.ok).toBe(true)
    expect(payload.copiedAssets.map(asset => asset.canonicalRef)).toEqual([
      'skill:vasp-preflight-runbook@1.0.0',
    ])
    expect(
      await git(repo, [
        'show',
        'accepted/bob-assets/stable:skill/vasp-preflight-runbook/SKILL.md',
      ]),
    ).toContain('Check VASP pseudopotentials')
  })
})
