import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { matOSGiteaScopeIdFromScopeRef } from '../assets/giteaGovernance.js'
import {
  syncGeneratedScopedAssetsToGitea,
  type MatOSGeneratedScopedAssetSyncResult,
} from '../learning/generatedScopedAssetSync.js'
import { getMatOSDir } from '../project.js'

// External intake writes a draft pack into the workspace's own asset tree.
// Sessions only see assets that come through a scoped accepted-ref source,
// so adopting a draft moves its assets into that source: each asset is
// staged under the scope's generated root as an enabled asset and published
// through the same governed sync asset_edit uses (commit, validation,
// accepted-ref push, rollback on failure).

const INTAKE_DRAFT_ORIGIN = 'matos-external-intake-draft'
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i

type AdoptScope = 'user' | 'team' | 'project'

const GENERATED_SCOPE_DIRS: Record<AdoptScope, string> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

export type MatOSExternalIntakeAdoptResult = {
  ok: boolean
  packId: string
  scopeRef?: string
  adoptedRefs: string[]
  error?: string
  gitea?: MatOSGeneratedScopedAssetSyncResult
}

function scopeFromRef(scopeRef: string | undefined): { scope: AdoptScope; scopeRef: string } | undefined {
  const normalized = scopeRef?.trim()
  if (!normalized) return undefined
  for (const scope of ['user', 'team', 'project'] as const) {
    if (normalized.startsWith(`${scope}:`) && normalized.slice(scope.length + 1).trim()) {
      return { scope, scopeRef: normalized }
    }
  }
  return undefined
}

async function findManifests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) paths.push(...(await findManifests(full)))
    else if (entry.isFile() && entry.name === 'asset.json') paths.push(full)
  }
  return paths
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// "notes.md (knowledge intake draft)" -> "notes.md"
function adoptedName(name: unknown): unknown {
  return typeof name === 'string' ? name.replace(/\s*\([a-z-]* ?intake draft\)\s*$/i, '') || name : name
}

export function adoptedIntakeManifest(
  manifest: Record<string, unknown>,
  input: { packId: string; now: string },
): Record<string, unknown> {
  return {
    ...manifest,
    name: adoptedName(manifest.name),
    ...(Array.isArray(manifest.tags)
      ? { tags: manifest.tags.filter(tag => tag !== 'draft') }
      : {}),
    lifecycle: {
      status: 'enabled',
      reason: 'Adopted from an external intake draft.',
      origin: 'matos-external-intake',
      updatedAt: input.now,
    },
    metadata: {
      ...objectRecord(manifest.metadata),
      adoptedFromIntakePack: input.packId,
      adoptedAt: input.now,
    },
  }
}

export async function adoptMatOSExternalIntakeDraftPack(input: {
  cwd: string
  packId: string
  scopeRef?: string
  env?: Record<string, string | undefined>
}): Promise<MatOSExternalIntakeAdoptResult> {
  const env = input.env ?? process.env
  const packId = input.packId.trim()
  if (!PACK_ID_PATTERN.test(packId)) {
    return { ok: false, packId, adoptedRefs: [], error: `Invalid intake draft pack id: ${packId}` }
  }
  const scoped = scopeFromRef(input.scopeRef ?? env.MATOS_SCOPE_REF)
  if (!scoped) {
    return {
      ok: false,
      packId,
      adoptedRefs: [],
      error: 'Adopting an intake draft needs a user, team or project scope (MATOS_SCOPE_REF or --scope).',
    }
  }
  const packDir = join(getMatOSDir(input.cwd), 'assets', 'packs', packId)
  const drafts: Array<{ dir: string; manifest: Record<string, unknown> }> = []
  const manifestPaths = await findManifests(packDir)
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = objectRecord(JSON.parse(await readFile(manifestPath, 'utf8')))
      if (objectRecord(manifest.lifecycle).origin === INTAKE_DRAFT_ORIGIN) {
        drafts.push({ dir: dirname(manifestPath), manifest })
      }
    } catch {
      // A broken manifest is not an intake draft this command owns.
    }
  }
  if (drafts.length === 0) {
    return {
      ...scoped,
      ok: false,
      packId,
      adoptedRefs: [],
      error: `No external intake drafts found in pack ${packId}`,
    }
  }

  const stagingRoot = join(
    getMatOSDir(input.cwd),
    'assets',
    'generated',
    'scopes',
    GENERATED_SCOPE_DIRS[scoped.scope],
    matOSGiteaScopeIdFromScopeRef(scoped.scopeRef),
  )
  const now = new Date().toISOString()
  const stagedDirs: string[] = []
  const adoptedRefs: string[] = []
  for (const draft of drafts) {
    const type = String(draft.manifest.type ?? '')
    const id = String(draft.manifest.id ?? '')
    if (!/^[a-z][a-z0-9-]*$/.test(type) || !ASSET_ID_PATTERN.test(id)) {
      return { ...scoped, ok: false, packId, adoptedRefs: [], error: `Draft ${type}:${id} has an unsafe type or id` }
    }
    const staged = join(stagingRoot, type, id)
    await rm(staged, { recursive: true, force: true })
    await cp(draft.dir, staged, { recursive: true })
    await writeFile(
      join(staged, 'asset.json'),
      `${JSON.stringify(adoptedIntakeManifest(draft.manifest, { packId, now }), null, 2)}\n`,
      'utf8',
    )
    stagedDirs.push(staged)
    adoptedRefs.push(`${type}:${id}@${String(draft.manifest.version ?? '0.1.0')}`)
  }

  const gitea = await syncGeneratedScopedAssetsToGitea({
    cwd: input.cwd,
    scope: scoped.scope,
    scopeRef: scoped.scopeRef,
    runId: `intake-adopt-${packId}-${Date.now()}`,
    summary: `Adopt external intake draft pack ${packId}`,
    env,
    parkRuntimeAssetsAsDraft: false,
    generatedAssetDirs: stagedDirs,
  })
  if (!gitea.ok) {
    await Promise.all(stagedDirs.map(dir => rm(dir, { recursive: true, force: true })))
    return {
      ...scoped,
      ok: false,
      packId,
      adoptedRefs: [],
      gitea,
      error:
        gitea.sourceCommitErrors?.map(error => `${error.sourceId}: ${error.error}`).join('; ') ||
        gitea.skippedAssets.map(asset => asset.reason).join('; ') ||
        'Scoped asset sync failed.',
    }
  }
  // The adopted copies now live in the scoped source; drop the drafts so the
  // workspace does not list the same type:id twice.
  if (drafts.length === manifestPaths.length) {
    await rm(packDir, { recursive: true, force: true })
  } else {
    await Promise.all(drafts.map(draft => rm(draft.dir, { recursive: true, force: true })))
  }
  return { ...scoped, ok: true, packId, adoptedRefs, gitea }
}
