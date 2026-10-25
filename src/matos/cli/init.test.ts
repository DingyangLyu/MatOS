import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSInit } from './init.js'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('matos init', () => {
  test('creates the first-stage .matos project structure idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-init-'))

    await runMatOSInit({ cwd: root, stdout: () => {}, stderr: () => {} })
    await runMatOSInit({ cwd: root, stdout: () => {}, stderr: () => {} })

    expect(await exists(join(root, '.matos', 'matos.json'))).toBe(true)
    expect(await exists(join(root, '.matos', 'assets', 'data'))).toBe(true)
    expect(await exists(join(root, '.matos', 'assets', 'knowledges'))).toBe(
      true,
    )
    expect(await exists(join(root, '.matos', 'assets', 'tools'))).toBe(true)
    expect(await exists(join(root, '.matos', 'assets', 'skills'))).toBe(true)
    expect(await exists(join(root, '.matos', 'assets', 'roles'))).toBe(true)
    expect(await exists(join(root, '.matos', 'assets', 'workflows'))).toBe(true)
    expect(await exists(join(root, '.matos', 'sessions'))).toBe(true)

    const config = JSON.parse(
      await readFile(join(root, '.matos', 'matos.json'), 'utf8'),
    )
    expect(config.version).toBe(1)
    expect(config.assetRoots).toContain('assets')
  })
})
