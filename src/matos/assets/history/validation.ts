import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadMatOSAssets } from '../loadAssets.js'
import { validateMatOSAssets } from '../validateAssets.js'
import { runMatOSAssetHistorySmokeChecks } from './smokeChecks.js'
import {
  hasMatOSSecretLookingContent,
  isMatOSSecretLookingFileName,
} from '../secretScan.js'
import { gitBuffer } from './gitBackend.js'
import {
  configuredAssetSourceRoots,
  listCurrentMatOSAssetHistoryFiles,
  matOSAssetHistoryCorePackRoot,
  resolveMatOSAssetHistoryRecordPath,
} from './policy.js'
import { readMatOSAssetHistorySnapshot } from './records.js'
import { mkdtempInMatOSTmp } from '../../runtime/tempDirs.js'
import type {
  MatOSAssetHistorySecretFinding,
  MatOSAssetHistoryScope,
  MatOSAssetHistorySnapshotRecord,
  MatOSAssetHistoryValidationResult,
} from './types.js'

export type ValidateMatOSAssetHistorySnapshotInput = {
  cwd: string
  snapshotId?: string
  scope?: MatOSAssetHistoryScope
  scopeRef?: string
  gateProfile?: 'structural' | 'smoke' | 'full'
}

const MAX_SECRET_SCAN_BYTES = 1024 * 1024
const CORE_SNAPSHOT_EDITABLE_SUBDIRS = new Set([
  'knowledge',
  'roles',
  'skills',
  'tools',
  'workflows',
])

async function secretFindingsForFiles(
  files: { path: string; absolutePath: string }[],
): Promise<MatOSAssetHistorySecretFinding[]> {
  const findings: MatOSAssetHistorySecretFinding[] = []
  for (const { path, absolutePath } of files) {
    if (isMatOSSecretLookingFileName(path)) {
      findings.push({ path, reason: 'secret-looking file name' })
      continue
    }
    const info = await lstat(absolutePath).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_SECRET_SCAN_BYTES) {
      continue
    }
    const raw = await readFile(absolutePath).catch(() => undefined)
    if (!raw) {
      continue
    }
    const text = raw.toString('utf8')
    if (
      Buffer.from(text, 'utf8').equals(raw) &&
      hasMatOSSecretLookingContent(text)
    ) {
      findings.push({ path, reason: 'secret-looking content' })
    }
  }
  return findings
}

export async function materializeSnapshotForValidation(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  root?: string
}): Promise<string> {
  const root = input.root ?? await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: 'matos-asset-history-validation-',
  })
  await mkdir(join(root, '.matos'), { recursive: true })
  const contextAssetRoots = await snapshotValidationContextAssetRoots({
    cwd: input.cwd,
    snapshot: input.snapshot,
  })
  await writeFile(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: ['assets', '../matos-assets', ...contextAssetRoots],
        includeDefaultAssetRoots: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  try {
    for (const file of input.snapshot.files) {
      const resolved = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: input.snapshot.scope,
        ...(input.snapshot.scopeRef
          ? { scopeRef: input.snapshot.scopeRef }
          : {}),
        path: file.path,
      })
      const targetPath = join(root, resolved.relativePath)
      const content = await readVerifiedSnapshotFileContent({
        cwd: input.cwd,
        snapshot: input.snapshot,
        path: resolved.relativePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content)
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return root
}

async function existingChildDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function isAssetPackRoot(root: string): Promise<boolean> {
  try {
    const info = await lstat(join(root, 'matos.pack.json'))
    return info.isFile()
  } catch {
    return false
  }
}

async function assetPackContextKey(root: string): Promise<string> {
  if (await isAssetPackRoot(root)) {
    try {
      const parsed = JSON.parse(await readFile(join(root, 'matos.pack.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined
      const id = typeof parsed?.id === 'string' && parsed.id.trim()
        ? parsed.id.trim()
        : basename(root)
      return `pack:${id}`
    } catch {
      return `pack:${basename(root)}`
    }
  }
  return `dir:${basename(root)}`
}

async function snapshotValidationContextAssetRoots(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
}): Promise<string[]> {
  const cwd = resolve(input.cwd)
  const coreRoot = resolve(matOSAssetHistoryCorePackRoot(cwd))
  const corePackKey = await assetPackContextKey(coreRoot)
  const contextRoots = new Map<string, { root: string; priority: number }>()
  const addContextRoot = async (packRoot: string, priority: number) => {
    const resolved = resolve(packRoot)
    if (input.snapshot.scope === 'core' && resolved === coreRoot) {
      return
    }
    const key = await assetPackContextKey(resolved)
    if (input.snapshot.scope === 'core' && key === corePackKey) {
      return
    }
    const existing = contextRoots.get(key)
    if (!existing || priority >= existing.priority) {
      contextRoots.set(key, { root: resolved, priority })
    }
  }
  const addPackRoot = async (packRoot: string, priority: number) => {
    await addContextRoot(packRoot, priority)
  }
  const addPackChildren = async (packsRoot: string, priority: number) => {
    for (const packRoot of await existingChildDirectories(packsRoot)) {
      await addPackRoot(packRoot, priority)
    }
  }

  if (input.snapshot.scope === 'core') {
    for (const coreChild of await existingChildDirectories(coreRoot)) {
      const name = coreChild.split(/[\\/]/).pop() ?? ''
      if (!CORE_SNAPSHOT_EDITABLE_SUBDIRS.has(name)) {
        await addContextRoot(coreChild, 10)
      }
    }
  } else {
    // A scoped user/team/project snapshot is only the candidate overlay. It may
    // legitimately depend on already-accepted core assets, so validate it
    // against the same read-only core context the runtime will compose.
    await addPackRoot(coreRoot, 10)
  }

  const packRootCandidates = [
    join(cwd, 'matos-assets', 'packs'),
    dirname(coreRoot),
  ]
  for (const packsRoot of [...new Set(packRootCandidates.map(root => resolve(root)))]) {
    await addPackChildren(packsRoot, 20)
  }

  // Production workspaces can keep editable packs outside the cwd while the
  // accepted runtime source cache lives under .matos/source-cache/git/<source>.
  // Snapshot validation should test the candidate files but still resolve
  // read-only dependencies from configured runtime source-cache packs.
  for (const sourceRoot of configuredAssetSourceRoots(cwd, 'core')) {
    const resolvedSourceRoot = resolve(sourceRoot)
    if (resolvedSourceRoot.endsWith(`${sep}packs`)) {
      await addPackChildren(resolvedSourceRoot, 30)
      continue
    }
    if (await isAssetPackRoot(resolvedSourceRoot)) {
      await addPackRoot(resolvedSourceRoot, 30)
    }
    await addPackChildren(join(resolvedSourceRoot, 'packs'), 30)
    await addPackChildren(join(resolvedSourceRoot, 'matos-assets', 'packs'), 30)
    await addPackChildren(join(resolvedSourceRoot, '.matos', 'assets', 'packs'), 30)
  }

  return [...contextRoots.values()]
    .map(entry => entry.root)
    .sort((a, b) => a.localeCompare(b))
}

export async function readVerifiedSnapshotFileContent(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  path: string
  sha256: string
  sizeBytes: number
}): Promise<Buffer> {
  const content = await gitBuffer(input.cwd, [
    'show',
    `${input.snapshot.commit}:${input.path}`,
  ])
  const sha256 = createHash('sha256').update(content).digest('hex')
  if (sha256 !== input.sha256) {
    throw new Error(`MatOS asset history snapshot hash mismatch for ${input.path}`)
  }
  if (content.byteLength !== input.sizeBytes) {
    throw new Error(`MatOS asset history snapshot size mismatch for ${input.path}`)
  }
  return content
}

function isWithinPath(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function validationErrorBelongsToRoot(error: unknown, root: string): boolean {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {}
  const manifestPath =
    typeof record.manifestPath === 'string' ? record.manifestPath : ''
  if (!manifestPath) {
    return true
  }
  return isWithinPath(manifestPath, root)
}

/**
 * Stable fingerprint for one asset-validation error so before/after baselines
 * can be compared differentially (same policy as the direct-editor Gate 1
 * fingerprint): volatile temp validation-root paths are scrubbed and the
 * asset version is dropped, because a restore/rollback legitimately changes
 * versions and must not re-key pre-existing environmental errors as new.
 */
export function matosAssetValidationErrorFingerprint(error: unknown): string {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {}
  const code = typeof record.code === 'string' ? record.code : ''
  const rawAssetKey =
    typeof record.assetKey === 'string'
      ? record.assetKey
      : typeof record.assetId === 'string'
        ? record.assetId
        : ''
  const assetKey = rawAssetKey.replace(/@[^@]*$/, '')
  const message =
    typeof record.message === 'string'
      ? record.message
          .replace(/[^\s"']*matos-asset-history-validation-[^\s"']*/g, '<validation-root>')
          .trim()
      : ''
  if (!code && !assetKey && !message) {
    return `raw\u0000${JSON.stringify(error) ?? ''}`
  }
  return `${code}\u0000${assetKey}\u0000${message}`
}

export async function validateMatOSAssetHistorySnapshot(
  input: ValidateMatOSAssetHistorySnapshotInput,
): Promise<MatOSAssetHistoryValidationResult> {
  const cwd = resolve(input.cwd)
  const snapshot = input.snapshotId
    ? await readMatOSAssetHistorySnapshot(cwd, input.snapshotId)
    : undefined
  if (input.snapshotId && !snapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotId}`)
  }
  const validationRoot = snapshot
    ? await materializeSnapshotForValidation({ cwd, snapshot })
    : cwd
  try {
    const loadedAssets = await loadMatOSAssets(validationRoot)
    const checkedAssets = snapshot
      ? loadedAssets.filter(asset => isWithinPath(asset.manifestPath, validationRoot))
      : loadedAssets
    const assetValidation = await validateMatOSAssets(loadedAssets)
    const structuralErrors = snapshot
      ? assetValidation.errors.filter(error =>
          validationErrorBelongsToRoot(error, validationRoot),
        )
      : assetValidation.errors
    // Gate 1 depth: smoke/full profiles add asset-type-specific load,
    // compose, and materialize probes on top of structural validation. Smoke
    // errors share the structural error shape and are merged into
    // assetValidation.errors so differential baseline fingerprinting in the
    // direct editor and release rollback applies to them unchanged.
    const gateProfile = input.gateProfile ?? 'structural'
    const smoke =
      gateProfile === 'smoke' || gateProfile === 'full'
        ? await runMatOSAssetHistorySmokeChecks({
            root: validationRoot,
            assets: loadedAssets,
            checkAssets: checkedAssets,
            gateProfile,
          })
        : undefined
    const combinedErrors = [
      ...structuralErrors,
      ...(smoke?.errors ?? []),
    ]
    const combinedAssetValidationOk = combinedErrors.length === 0
    // Snapshot validation scans the materialized temp tree, where logical
    // record paths are laid out verbatim. Live-tree validation must resolve
    // logical paths scope-aware because the core pack root may live outside
    // the cwd.
    const secretScanFiles = snapshot
      ? snapshot.files.map(file => ({
          path: file.path,
          absolutePath: join(validationRoot, file.path),
        }))
      : input.scope
        ? await Promise.all(
            (
              await listCurrentMatOSAssetHistoryFiles({
                cwd,
                scope: input.scope,
                ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
              })
            ).map(path => ({
              path,
              absolutePath: resolveMatOSAssetHistoryRecordPath({
                cwd,
                scope: input.scope as MatOSAssetHistoryScope,
                ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
                path,
              }).absolutePath,
            })),
          )
        : []
    const secretFindings = await secretFindingsForFiles(secretScanFiles)
    return {
      ok: combinedAssetValidationOk && secretFindings.length === 0,
      gateProfile,
      assetValidation: {
        ok: combinedAssetValidationOk,
        errors: combinedErrors,
      },
      secretScan: {
        ok: secretFindings.length === 0,
        findings: secretFindings,
      },
      workflowValidation: smoke?.workflowValidation ?? [],
      ...(smoke ? { smoke: smoke.summary } : {}),
    }
  } finally {
    if (snapshot) {
      await rm(validationRoot, { recursive: true, force: true })
    }
  }
}
