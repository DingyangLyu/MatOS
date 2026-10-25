import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as lockfile from 'proper-lockfile'

export const MATOS_PROJECT_METADATA_RELATIVE_PATH = join('.matos', 'project.json')

const PROJECT_INTERNAL_GITIGNORE_MARKER = '# MatOS project-local runtime state'
const PROJECT_INTERNAL_GITIGNORE_PATTERNS = [
  '*',
  '!.gitignore',
  '!project.json',
  '!matos.json',
  '!assets/',
  '!assets/**',
  'private/',
  'runtime/',
  'sessions/',
  'workbench/',
  'project-metadata',
  'project-metadata.lock',
  'project-gitignore',
  'project-gitignore.lock',
]

export type MatOSProjectMetadata = Record<string, unknown> & {
  schemaVersion?: number
  revision?: number
  id?: string
  name?: string
  description?: string
  goal?: string
  createdAt?: string
  updatedAt?: string
  team?: unknown
  memberBriefs?: unknown
  memberNames?: unknown
  roleResolutionWarnings?: unknown
  assetRefs?: unknown
  assetVersionPolicy?: 'follow-accepted' | 'pinned'
  workflowRefs?: unknown
  conversations?: unknown
  areas?: unknown
}

export function matOSProjectMetadataPath(cwd: string): string {
  return join(cwd, MATOS_PROJECT_METADATA_RELATIVE_PATH)
}

function matOSProjectMetadataLockAnchor(cwd: string): string {
  return join(cwd, '.matos', 'project-metadata')
}

export async function ensureMatOSProjectInternalGitignore(cwd: string): Promise<void> {
  const matosDir = join(cwd, '.matos')
  const path = join(matosDir, '.gitignore')
  const anchor = join(matosDir, 'project-gitignore')
  await mkdir(matosDir, { recursive: true })
  await writeFile(anchor, '', { flag: 'a', mode: 0o600 })
  const release = await lockfile.lock(anchor, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
  })
  try {
    const current = await readFile(path, 'utf8').catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return ''
      throw error
    })
    const lines = new Set(current.split('\n').map(line => line.trim()).filter(Boolean))
    const missing = PROJECT_INTERNAL_GITIGNORE_PATTERNS.filter(pattern => !lines.has(pattern))
    if (missing.length === 0) return
    const prefix = current && !current.endsWith('\n') ? `${current}\n` : current
    const marker = lines.has(PROJECT_INTERNAL_GITIGNORE_MARKER)
      ? ''
      : `${prefix ? '\n' : ''}${PROJECT_INTERNAL_GITIGNORE_MARKER}\n`
    const next = `${prefix}${marker}${missing.join('\n')}\n`
    const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
    try {
      await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o644 })
      await rename(temporaryPath, path)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  } finally {
    await release()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function parseMetadata(raw: string, path: string): MatOSProjectMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid MatOS project metadata at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid MatOS project metadata object at ${path}`)
  }
  return parsed as MatOSProjectMetadata
}

export async function readMatOSProjectMetadata(
  cwd: string,
  options: { allowMissing?: boolean } = {},
): Promise<MatOSProjectMetadata> {
  const path = matOSProjectMetadataPath(cwd)
  try {
    return parseMetadata(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (options.allowMissing && isNodeError(error) && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export async function findMatOSProjectRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    try {
      await readMatOSProjectMetadata(current)
      return current
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function writeMatOSProjectMetadataAtomic(
  cwd: string,
  metadata: MatOSProjectMetadata,
): Promise<void> {
  const path = matOSProjectMetadataPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

export async function mutateMatOSProjectMetadata(
  cwd: string,
  mutate: (current: MatOSProjectMetadata) => MatOSProjectMetadata | undefined,
): Promise<{ changed: boolean; metadata: MatOSProjectMetadata }> {
  const path = matOSProjectMetadataPath(cwd)
  const anchor = matOSProjectMetadataLockAnchor(cwd)
  await mkdir(dirname(anchor), { recursive: true })
  await writeFile(anchor, '', { flag: 'a', mode: 0o600 })

  const release = await lockfile.lock(anchor, {
    realpath: false,
    stale: 30_000,
    retries: {
      retries: 100,
      factor: 1.2,
      minTimeout: 10,
      maxTimeout: 100,
    },
  })
  try {
    const current = await readMatOSProjectMetadata(cwd, { allowMissing: true })
    const requested = mutate(current)
    if (!requested) {
      return { changed: false, metadata: current }
    }
    const now = new Date().toISOString()
    const currentRevision = Number(current.revision)
    const metadata: MatOSProjectMetadata = {
      ...requested,
      schemaVersion: Math.max(1, Number(requested.schemaVersion) || 1),
      revision: Number.isInteger(currentRevision) && currentRevision >= 0
        ? currentRevision + 1
        : 1,
      updatedAt: now,
    }
    await writeMatOSProjectMetadataAtomic(cwd, metadata)
    return { changed: true, metadata }
  } finally {
    await release()
  }
}
