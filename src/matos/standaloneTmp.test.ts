import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ensureMatOSStandaloneTmp } from './standaloneTmp'

test('deep standalone state supports real Unix sockets without moving data onto the root disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-short-temp-'))
  const target = join(root, 'very-long-private-state-directory-name'.repeat(4), 'tmp')
  let alias: string | undefined
  const server = createServer()
  try {
    alias = await ensureMatOSStandaloneTmp(target)
    expect(await ensureMatOSStandaloneTmp(target)).toBe(alias)
    expect(await realpath(alias)).toBe(await realpath(target))
    await writeFile(join(alias, 'data.txt'), 'in-state')
    expect(await readFile(join(target, 'data.txt'), 'utf8')).toBe('in-state')
    const socket = join(alias, 'claude-http-01234567890123456789.sock')
    expect(Buffer.byteLength(socket)).toBeLessThan(108)
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socket, done) })
    expect(server.listening).toBe(true)
  } finally {
    if (server.listening) await new Promise<void>(done => server.close(() => done()))
    if (alias?.startsWith('/var/tmp/matos-')) await rm(alias)
    await rm(root, { recursive: true, force: true })
  }
})

test('a preexisting alias to a different target is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-short-boundary-'))
  const target = join(root, 'long-private-state-path'.repeat(5))
  await mkdir(target)
  const canonical = await realpath(target)
  const alias = join('/var/tmp', `matos-${process.getuid!()}-${createHash('sha256').update(canonical).digest('hex').slice(0,16)}`)
  try {
    await symlink(root, alias)
    await expect(ensureMatOSStandaloneTmp(target)).rejects.toThrow('another location')
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }) }
})
