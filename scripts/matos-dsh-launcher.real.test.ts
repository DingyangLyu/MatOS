import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'

const runtime = process.env.MATOS_DSH_TEST_BIN
const node = process.env.MATOS_DSH_TEST_NODE
const launcher = resolve(import.meta.dir, 'matos-dsh-launcher.sh')

// Exercise the real preinstalled CLI. This is not a replacement runtime.
test.skipIf(!runtime || !node)('preinstalled DSH starts offline without npx', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-dsh-offline-launch-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await symlink(node!, join(bin, 'node'))
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      const child = spawn('/bin/bash', [launcher, '--version'], {
        env: { PATH: bin, MATOS_DSH_EXEC_BIN: runtime!, MATOS_NPX_BIN: join(root, 'no-npx'),
          MATOS_DSH_HOME: join(root, 'dsh'), MATOS_DSH_OFFLINE: '1',
          npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', b => { stdout += b })
      child.stderr.on('data', b => { stderr += b })
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }) })
    })
    expect(result.stderr).not.toContain('cannot find npx')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('0.2.1-alpha.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
