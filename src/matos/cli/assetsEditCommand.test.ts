import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { runMatOSCli } from './main.js'

const execFileAsync = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MatOS Test',
      GIT_AUTHOR_EMAIL: 'matos-test@example.invalid',
      GIT_COMMITTER_NAME: 'MatOS Test',
      GIT_COMMITTER_EMAIL: 'matos-test@example.invalid',
    },
  })
  return stdout.trim()
}

async function scopedWorkspace(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), 'matos-assets-edit-'))
  const repo = await mkdtemp(join(tmpdir(), 'matos-assets-edit-repo-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeFile(join(repo, 'README.md'), 'local user assets\n', 'utf8')
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'seed'])
  const seed = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['branch', 'accepted/local-assets/stable', seed])
  await writeFile(
    getMatOSConfigPath(root),
    `${JSON.stringify({
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [
        {
          type: 'git',
          id: 'local-assets',
          repo,
          ref: 'main',
          runtimeRef: { mode: 'accepted-ref', ref: 'accepted/local-assets/stable', commit: seed },
          scope: 'user',
          scopeRef: 'user:local',
          refresh: 'manual',
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  )
  return { root, repo }
}

async function cli(root: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runMatOSCli(args, {
    cwd: root,
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
    launchAgent: async () => 99,
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('matos assets edit', () => {
  test('creates and then updates a user-scope skill through the accepted ref', async () => {
    const { root, repo } = await scopedWorkspace()
    const first = join(root, 'SKILL.md')
    await writeFile(first, '---\nname: Crystallized flow\n---\n\n# Crystallized flow\n\nFirst draft.\n', 'utf8')

    const created = await cli(root, [
      'assets', 'edit', '--type', 'skill', '--id', 'crystallized-flow',
      '--name', 'Crystallized flow', '--description', 'Reusable steps from a run.',
      '--content-file', first, '--action', 'upsert', '--scope', 'user:local',
      '--reason', 'automation proposal test', '--json',
    ])
    expect(created.code).toBe(0)
    const createdPayload = JSON.parse(created.stdout) as {
      ok: boolean
      action: string
      assetRef: string
      asset?: { sourceScopeRef?: string }
    }
    expect(createdPayload).toMatchObject({
      ok: true,
      action: 'create',
      assetRef: 'skill:crystallized-flow@0.1.0',
      asset: { sourceScopeRef: 'user:local' },
    })
    expect(
      await git(repo, ['show', 'accepted/local-assets/stable:skill/crystallized-flow/SKILL.md']),
    ).toContain('First draft.')

    await writeFile(first, '# Crystallized flow\n\nSecond draft.\n', 'utf8')
    const updated = await cli(root, [
      'assets', 'edit', '--type', 'skill', '--id', 'crystallized-flow',
      '--content-file', first, '--action', 'upsert', '--scope', 'user:local', '--json',
    ])
    expect(updated.code).toBe(0)
    expect(JSON.parse(updated.stdout)).toMatchObject({ ok: true, action: 'update' })
    expect(
      await git(repo, ['show', 'accepted/local-assets/stable:skill/crystallized-flow/SKILL.md']),
    ).toContain('Second draft.')
  })

  test('rejects incomplete and unknown arguments without writing', async () => {
    const { root } = await scopedWorkspace()
    const missing = await cli(root, ['assets', 'edit', '--type', 'skill', '--json'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('Usage: matos assets edit')

    const unknown = await cli(root, ['assets', 'edit', '--type', 'skill', '--id', 'x', '--bogus', 'y'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('Unknown asset edit option: --bogus')
  })

  test('reports asset_edit refusals as JSON with a failing exit code', async () => {
    const { root } = await scopedWorkspace()
    const result = await cli(root, [
      'assets', 'edit', '--type', 'role', '--id', 'not-here', '--scope', 'user:local', '--json',
    ])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: 'Use role_edit for role assets.' })
  })
})
