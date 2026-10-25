/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Publish a small document payload (scene JSON, config, notes) as a
// versioned project-local `data` asset. This is the document-payload
// counterpart to `registerDataAsset` (reference-only provenance manifests):
// the entry file is written next to the manifest inside the workspace-local
// pack under `.matos/assets/packs/<pack>/data/<id>/`, so UIs and agents can
// persist artifacts like virtual-lab scenes the same way workflow drafts are
// published into workflow assets. The whole-registry validation gate runs
// after the write and rolls the change back (restoring any overwritten
// version) when the new asset breaks the registry.

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getMatOSAssetsDir, getMatOSDir } from '../project.js'
import { bestEffort } from '../support/bestEffort.js'
import { loadMatOSAssets } from './loadAssets.js'
import { validateMatOSAssets } from './validateAssets.js'
import type { MatOSAssetValidationError } from './types.js'

export const MATOS_PUBLISH_DATA_DEFAULT_PACK_ID = 'published-data'
export const MATOS_PUBLISH_DATA_MAX_ENTRY_BYTES = 2 * 1024 * 1024
const DEFAULT_ENTRY_NAME = 'data.json'
const DEFAULT_VERSION = '0.1.0'
// Reserved names the entry file must never shadow: the asset manifest
// (either accepted spelling) and the pack manifest.
const RESERVED_ENTRY_NAMES = new Set([
  'asset.json',
  'matos.asset.json',
  'matos.pack.json',
])

export type PublishMatOSDataAssetInput = {
  cwd: string
  id: string
  name: string
  /** Raw entry payload; the caller owns reading files/stdin. */
  entryContent: string
  /** Entry file name inside the asset dir; defaults to `data.json`. */
  entryName?: string
  packId?: string
  version?: string
  description?: string
  tags?: string[]
  overwrite?: boolean
}

export type PublishMatOSDataAssetResult =
  | {
      ok: true
      ref: string
      id: string
      packId: string
      version: string
      entryName: string
      entryBytes: number
      /** Workspace-relative manifest/entry paths (safe for `--json` output). */
      manifestPath: string
      entryPath: string
      overwritten: boolean
      validation: { ok: boolean; errorCount: number }
    }
  | {
      ok: false
      code:
        | 'invalid_input'
        | 'duplicate_asset'
        | 'validation_failed'
      message: string
      rolledBack?: boolean
      errors?: MatOSAssetValidationError[]
    }

function slugOk(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value)
}

function versionOk(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value) && value.length <= 64
}

function entryNameOk(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value.length <= 128 &&
    !RESERVED_ENTRY_NAMES.has(value)
  )
}

function invalidInput(message: string): PublishMatOSDataAssetResult {
  return { ok: false, code: 'invalid_input', message }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function publishMatOSDataAsset(
  input: PublishMatOSDataAssetInput,
): Promise<PublishMatOSDataAssetResult> {
  const id = input.id.trim()
  const name = input.name.trim()
  const packId = input.packId?.trim() || MATOS_PUBLISH_DATA_DEFAULT_PACK_ID
  const version = input.version?.trim() || DEFAULT_VERSION
  const entryName = input.entryName?.trim() || DEFAULT_ENTRY_NAME
  const overwrite = input.overwrite === true

  if (!id || !slugOk(id)) {
    return invalidInput(
      'publish-data: --id must be a lowercase slug (a-z, 0-9, ".", "_", "-")',
    )
  }
  if (!name) {
    return invalidInput('publish-data: --name is required')
  }
  if (!slugOk(packId)) {
    return invalidInput(
      'publish-data: --pack must be a lowercase slug (a-z, 0-9, ".", "_", "-")',
    )
  }
  if (!versionOk(version)) {
    return invalidInput(
      'publish-data: --version must be a plain version string like 0.1.0',
    )
  }
  // A safe entry name is a single flat file name: no path separators, no
  // leading dot, and never one of the manifest file names. This is the path
  // traversal gate — the entry can only land inside the target asset dir.
  if (!entryNameOk(entryName)) {
    return invalidInput(
      'publish-data: --entry-name must be a plain file name inside the asset dir ' +
        '(letters/digits first, then letters, digits, ".", "_", "-"; ' +
        'asset.json and matos.pack.json are reserved)',
    )
  }

  const entryBytes = Buffer.byteLength(input.entryContent, 'utf8')
  if (entryBytes === 0) {
    return invalidInput('publish-data: entry payload is empty')
  }
  if (entryBytes > MATOS_PUBLISH_DATA_MAX_ENTRY_BYTES) {
    return invalidInput(
      `publish-data: entry payload is ${entryBytes} bytes, exceeding the ` +
        `${MATOS_PUBLISH_DATA_MAX_ENTRY_BYTES}-byte cap; store large payloads ` +
        'at a mounted path and use `matos assets register-data` instead',
    )
  }
  if (entryName.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(input.entryContent)
    } catch (error) {
      return invalidInput(
        `publish-data: entry payload is not valid JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  const packRoot = join(getMatOSAssetsDir(input.cwd), 'packs', packId)
  const assetDir = join(packRoot, 'data', id)
  const canonicalKey = `data:${id}@${version}`

  // Refuse to shadow an existing registry entry (same id@version anywhere,
  // or any prior version already living in the target dir) unless asked.
  const existingAssets = await loadMatOSAssets(input.cwd)
  const existingSameKey = existingAssets.find(
    asset => asset.canonicalKey === canonicalKey,
  )
  if (existingSameKey && !overwrite) {
    return {
      ok: false,
      code: 'duplicate_asset',
      message: `publish-data: ${canonicalKey} already exists (${existingSameKey.manifestPath}); pass --overwrite to replace the project-local copy`,
    }
  }
  if (
    existingSameKey &&
    overwrite &&
    !existingSameKey.manifestPath.startsWith(assetDir)
  ) {
    return {
      ok: false,
      code: 'duplicate_asset',
      message: `publish-data: --overwrite only replaces the project-local copy under .matos/assets/packs/${packId}/data/${id}; ${canonicalKey} lives at ${existingSameKey.manifestPath}`,
    }
  }
  const assetDirExists = await pathExists(assetDir)
  if (assetDirExists && !overwrite) {
    return {
      ok: false,
      code: 'duplicate_asset',
      message: `publish-data: data asset dir already exists for id "${id}" in pack "${packId}"; pass --overwrite to replace it (version bumps replace the same asset dir)`,
    }
  }

  // Snapshot the previous asset dir so a failed validation restores it
  // instead of deleting the previously good version. The backup lives under
  // `.matos/tmp` (never below an asset root) so the registry cannot discover
  // it as a duplicate while validation runs.
  let backupPath: string | undefined
  if (assetDirExists) {
    const tmpDir = join(getMatOSDir(input.cwd), 'tmp')
    await mkdir(tmpDir, { recursive: true })
    backupPath = join(
      tmpDir,
      `publish-data-backup-${packId}-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    await rename(assetDir, backupPath)
  }

  const packManifestPath = join(packRoot, 'matos.pack.json')
  const packManifestExisted = await pathExists(packManifestPath)
  let createdPackManifest = false

  const rollback = async (): Promise<void> => {
    await rm(assetDir, { recursive: true, force: true })
    if (backupPath) {
      await rename(backupPath, assetDir).catch(() => undefined)
    }
    if (createdPackManifest) {
      await rm(packManifestPath, { force: true }).catch(() => undefined)
    }
  }

  try {
    await mkdir(assetDir, { recursive: true })
    if (!packManifestExisted) {
      // Minimal pack manifest. The `matos-registered-data-pack` sourceFormat
      // is the existing project-local marker consumed by the asset loader
      // (`isProjectLocalPack`), keeping these assets in the same
      // "daemon's own workspace data" class as register-data output and
      // Data Center pins; publish-data intentionally reuses it instead of
      // introducing a parallel marker.
      await writeFile(
        packManifestPath,
        `${JSON.stringify(
          {
            id: packId,
            name: 'Published Data Assets',
            version: '0.1.0',
            description:
              'Project-local data documents published through `matos assets publish-data`.',
            metadata: {
              sourceFormat: 'matos-registered-data-pack',
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      createdPackManifest = true
    }

    await writeFile(join(assetDir, entryName), input.entryContent, 'utf8')

    const manifest = {
      schemaVersion: 1,
      id,
      type: 'data',
      name,
      version,
      description:
        input.description?.trim() ||
        `Published data document ${name}; payload stored as ${entryName} next to this manifest.`,
      entry: entryName,
      tags: [
        ...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean)),
      ],
      permissions: {
        workspace: 'read-only',
        network: 'disabled',
        secrets: [],
      },
      metadata: {
        kind: 'published-document',
        sourceFormat: 'cmatos-native-data',
        publishedBy: 'cli',
        publishedAt: new Date().toISOString(),
        entryBytes,
        ...(entryName.toLowerCase().endsWith('.json')
          ? { entryFormat: 'json' }
          : {}),
      },
    }
    const manifestPath = join(assetDir, 'asset.json')
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )

    // Same honesty gate as register-data: validate the whole registry and
    // roll the write back when the new asset itself is broken or collides.
    const validation = await validateMatOSAssets(
      await loadMatOSAssets(input.cwd),
    )
    const ownErrors = validation.errors.filter(
      error =>
        error.manifestPath === manifestPath ||
        error.assetKey === canonicalKey ||
        error.assetId === id,
    )
    if (ownErrors.length > 0) {
      await rollback()
      return {
        ok: false,
        code: 'validation_failed',
        message: 'publish-data: validation failed; the published asset was rolled back',
        rolledBack: true,
        errors: ownErrors,
      }
    }

    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true })
    }

    return {
      ok: true,
      ref: canonicalKey,
      id,
      packId,
      version,
      entryName,
      entryBytes,
      manifestPath: relative(input.cwd, manifestPath),
      entryPath: relative(input.cwd, join(assetDir, entryName)),
      overwritten: assetDirExists,
      validation: { ok: validation.ok, errorCount: validation.errors.length },
    }
  } catch (error) {
    // A failed rollback leaves the published pack half-written; keep the
    // original error as the thrown failure but record the swallowed rollback.
    await bestEffort('publish-data-asset-rollback', () => rollback())
    throw error
  }
}
