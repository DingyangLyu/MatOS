import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMatOSBuildInfo } from './buildInfo.js'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'matos-build-info-'))
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

test('reads build-info.json stamped by the channel image refresh', () => {
  const root = makeRoot()
  writeFileSync(
    join(root, 'build-info.json'),
    JSON.stringify({
      commit: 'a'.repeat(40),
      commitShort: 'a'.repeat(12),
      builtAt: '2026-08-12T00:00:00Z',
      channel: 'stable',
      dirty: false,
    }),
  )

  const info = resolveMatOSBuildInfo({ root, version: '9.9.9' })
  expect(info.source).toBe('build-info')
  expect(info.version).toBe('9.9.9')
  expect(info.commit).toBe('a'.repeat(40))
  expect(info.commitShort).toBe('a'.repeat(12))
  expect(info.builtAt).toBe('2026-08-12T00:00:00Z')
  expect(info.channel).toBe('stable')
  expect(info.dirty).toBe(false)
})

test('derives commitShort when the file only carries the full commit', () => {
  const root = makeRoot()
  writeFileSync(join(root, 'build-info.json'), JSON.stringify({ commit: 'b'.repeat(40) }))

  const info = resolveMatOSBuildInfo({ root, version: '1.0.0' })
  expect(info.source).toBe('build-info')
  expect(info.commitShort).toBe('b'.repeat(12))
  expect(info.channel).toBeNull()
  expect(info.dirty).toBeNull()
})

test('falls back to the live git HEAD for host checkouts', () => {
  const root = makeRoot()
  runGit(root, ['init', '--quiet'])
  runGit(root, ['config', 'user.email', 'matos-test@example.invalid'])
  runGit(root, ['config', 'user.name', 'matos-test'])
  writeFileSync(join(root, 'file.txt'), 'x\n')
  runGit(root, ['add', 'file.txt'])
  runGit(root, ['commit', '--quiet', '-m', 'init'])

  const info = resolveMatOSBuildInfo({ root, version: '1.0.0' })
  expect(info.source).toBe('git')
  expect(info.commit ?? '').toMatch(/^[0-9a-f]{40}$/)
  expect(info.commitShort).toBe((info.commit ?? '').slice(0, 12))
})

test('corrupt build-info.json falls through instead of throwing', () => {
  const root = makeRoot()
  writeFileSync(join(root, 'build-info.json'), 'not-json{')

  const info = resolveMatOSBuildInfo({ root, version: '1.0.0' })
  expect(info.source).toBe('unknown')
  expect(info.commit).toBeNull()
})

test('degrades to unknown when neither build-info nor git are available', () => {
  const root = makeRoot()

  const info = resolveMatOSBuildInfo({ root, version: '1.0.0' })
  expect(info.source).toBe('unknown')
  expect(info.commit).toBeNull()
  expect(info.version).toBe('1.0.0')
})
