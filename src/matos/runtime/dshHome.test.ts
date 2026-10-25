import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  ensureMatOSDshHome,
  matOSDshHome,
  resolveMatOSAgentEngineScope,
} from './dshHome.js'

describe('MatOS DSH home', () => {
  test('ignores non-runtime ambient trace scopes instead of crossing user roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-dsh-home-trace-scope-'))
    const scope = await resolveMatOSAgentEngineScope({
      cwd: root,
      env: {
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
        MATOS_SCOPE_REF: 'scope:trace-only',
      },
    })

    expect(scope.ref).toBe('user:local')
  })

  test('creates a private scoped home and honors absolute overrides only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-dsh-home-'))
    const env = { MATOS_RUNTIME_DATA_DIR: join(root, 'runtime') }
    const scope = await resolveMatOSAgentEngineScope({ cwd: root, env })
    const home = await ensureMatOSDshHome(scope, env)

    expect(home).toBe(join(scope.homeDir, 'dsh'))
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect(matOSDshHome(scope, { MATOS_DSH_HOME: join(root, 'custom') })).toBe(join(root, 'custom'))
    expect(() => matOSDshHome(scope, { MATOS_DSH_HOME: 'relative' })).toThrow('absolute')
  })
})
