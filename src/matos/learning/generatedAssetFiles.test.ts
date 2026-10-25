import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  sweepStaleGeneratedAssetTmpFiles,
  writeGeneratedAssetFile,
} from './generatedAssetFiles.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempDir(): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-generated-asset-files-' })
  roots.push(root)
  return root
}

async function seedFile(
  dir: string,
  name: string,
  ageMs: number,
): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, 'residue\n', 'utf8')
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    await utimes(path, past, past)
  }
  return path
}

describe('generated asset file writes', () => {
  test('a write sweeps stale dot-tmp crash residue but keeps everything else', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    // Crash residue: writeFile succeeded, the process died before rename.
    const staleTmp = `.${randomUUID()}.tmp`
    await seedFile(dir, staleTmp, 2 * DAY_MS)
    // A concurrent in-flight write must never be swept.
    const freshTmp = `.${randomUUID()}.tmp`
    await seedFile(dir, freshTmp, 0)
    // Non-matching names are untouchable regardless of age.
    await seedFile(dir, 'asset.json', 2 * DAY_MS)
    await seedFile(dir, '.keep', 2 * DAY_MS)
    await seedFile(dir, `${randomUUID()}.tmp`, 2 * DAY_MS) // not dot-prefixed
    await seedFile(dir, '.not-a-uuid.tmp', 2 * DAY_MS)

    await writeGeneratedAssetFile(join(dir, 'EXPERIENCE.md'), 'content\n')

    const names = new Set(await readdir(dir))
    expect(names.has(staleTmp)).toBe(false)
    expect(names.has(freshTmp)).toBe(true)
    expect(names.has('asset.json')).toBe(true)
    expect(names.has('.keep')).toBe(true)
    expect(names.has('.not-a-uuid.tmp')).toBe(true)
    expect(names.has('EXPERIENCE.md')).toBe(true)
    expect(await readFile(join(dir, 'EXPERIENCE.md'), 'utf8')).toBe('content\n')
  })

  test('direct sweep is age-gated and bounded per call', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < 4; index += 1) {
      await seedFile(dir, `.${randomUUID()}.tmp`, 2 * DAY_MS)
    }
    const boundedRemovals = await sweepStaleGeneratedAssetTmpFiles(dir, {
      maxRemovals: 2,
    })
    expect(boundedRemovals).toBe(2)
    expect((await readdir(dir)).length).toBe(2)

    // Below the age gate nothing is removed.
    const youngDir = await tempDir()
    await seedFile(youngDir, `.${randomUUID()}.tmp`, HOUR_MS)
    expect(await sweepStaleGeneratedAssetTmpFiles(youngDir)).toBe(0)
    expect((await readdir(youngDir)).length).toBe(1)

    // Missing directories are a no-op, not an error.
    expect(
      await sweepStaleGeneratedAssetTmpFiles(join(youngDir, 'missing')),
    ).toBe(0)
  })
})
