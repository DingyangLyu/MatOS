import { test, expect } from 'bun:test'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readIndexedUsageEvents } from './incrementalEvents.js'

test('incremental usage index resumes tails, detects rewrites and rotation, and excludes transcript text', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-usage-index-'))
  const path = join(cwd, 'events.jsonl')
  try {
    const line = (id: string) => JSON.stringify({ id, type: 'matos.asset.used', data: { assetKey: 'knowledge:a@1.0.0', text: 'private transcript must not be indexed' } }) + '\n'
    await writeFile(path, Array.from({ length: 4000 }, (_, i) => line(String(i))).join(''))
    expect((await readIndexedUsageEvents(cwd, path)).events.length).toBe(4000)
    expect((await readIndexedUsageEvents(cwd, path)).bytesRead).toBe(0)
    await appendFile(path, line('next') + '{"id":"partial"')
    const append = await readIndexedUsageEvents(cwd, path)
    expect(append.bytesRead).toBeLessThan(20000)
    expect(append.events.length).toBe(4001)
    await appendFile(path, '}\n')
    expect((await readIndexedUsageEvents(cwd, path)).events.length).toBe(4002)
    await writeFile(path, line('rewritten'))
    expect((await readIndexedUsageEvents(cwd, path)).events).toMatchObject([{ id: 'rewritten' }])
    await rename(path, `${path}.old`)
    await writeFile(path, line('rotated'))
    expect((await readIndexedUsageEvents(cwd, path)).events).toMatchObject([{ id: 'rotated' }])
    const files = await readdir(join(cwd, '.matos/index/asset-usage-v1'))
    expect(await readFile(join(cwd, '.matos/index/asset-usage-v1', files[0]!), 'utf8')).not.toContain('private transcript')
    await rm(path)
    await expect(readIndexedUsageEvents(cwd, path)).rejects.toThrow()
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
