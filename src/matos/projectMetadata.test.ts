import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureMatOSProjectInternalGitignore,
  mutateMatOSProjectMetadata,
  readMatOSProjectMetadata,
} from './projectMetadata.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MatOS project metadata transaction', () => {
  test('serializes first creation and concurrent revisions without losing updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-metadata-'))
    roots.push(root)
    const initialized = await mutateMatOSProjectMetadata(root, current => ({
      ...current,
      id: 'alpha',
      name: 'Alpha',
      counter: 0,
      createdAt: '2026-07-10T00:00:00.000Z',
    }))
    expect(initialized.metadata.revision).toBe(1)

    await Promise.all(Array.from({ length: 20 }, () =>
      mutateMatOSProjectMetadata(root, current => ({
        ...current,
        counter: Number(current.counter ?? 0) + 1,
      }))))

    const metadata = await readMatOSProjectMetadata(root)
    expect(metadata.counter).toBe(20)
    expect(metadata.revision).toBe(21)
    expect(metadata.id).toBe('alpha')
  })

  test('does not rewrite metadata when a mutator reports no change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-metadata-'))
    roots.push(root)
    await mutateMatOSProjectMetadata(root, () => ({ id: 'alpha', name: 'Alpha' }))
    const unchanged = await mutateMatOSProjectMetadata(root, () => undefined)
    expect(unchanged.changed).toBe(false)
    expect(unchanged.metadata.revision).toBe(1)
  })

  test('preserves user ignore rules while adding private runtime protections once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-gitignore-'))
    roots.push(root)
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(root, '.matos', '.gitignore'), 'custom-cache/\n', 'utf8')
    await Promise.all(Array.from({ length: 8 }, () =>
      ensureMatOSProjectInternalGitignore(root)))
    const content = await readFile(join(root, '.matos', '.gitignore'), 'utf8')
    expect(content).toContain('custom-cache/')
    expect(content).toContain('\n*\n')
    expect(content).toContain('!project.json')
    expect(content).toContain('!assets/**')
    expect(content.match(/^private\/$/gm)).toHaveLength(1)
    expect(content.match(/^workbench\/$/gm)).toHaveLength(1)
  })
})
