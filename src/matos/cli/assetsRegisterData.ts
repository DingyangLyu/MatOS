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

// `matos assets register-data` — one-command registration of a reference-only
// `data` asset with real source provenance.
//
// The heavyweight paths already exist: `matos assets factory repo2asset|
// paper2asset` classifies whole external repositories/papers, the Data Center
// pin flow turns catalog rows into project assets, and generator scripts
// build whole packs (material-bench units). What was missing is the everyday
// case: "I have a dataset at this path / behind this DOI or URL — register it
// so MatOS can manage and reference it." This command writes one manifest
// into a project-local pack, verifies the referenced payload path when given,
// validates the whole registry, and rolls the new asset back when validation
// fails. Payloads stay where they are (TOS, mounted knowledge roots, project
// files); only reference metadata enters the registry.

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import {
  writeJson,
  type MatOSAssetsIO,
  type ParsedArgs,
} from './assetsCliShared.js'

const DEFAULT_PACK_ID = 'registered-data'
const USAGE =
  'Usage: matos assets register-data --id <id> --name <name> ' +
  '[--url <source-url>]... [--doi <doi>] [--path <container-or-project-path>] ' +
  '[--description <text>] [--domain <label>] [--tag <tag>]... ' +
  '[--pack <pack-id>] [--version <semver>] [--tos-archive <bucket/prefix>] ' +
  '[--require-path] [--replace] [--json]\n'

function slugOk(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value)
}

function humanSize(size: number): string {
  let value = size
  for (const unit of ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']) {
    if (Math.abs(value) < 1024 || unit === 'PiB') {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(3)} ${unit}`
    }
    value /= 1024
  }
  return `${size} B`
}

async function payloadProbe(
  cwd: string,
  rawPath: string,
): Promise<{ exists: boolean; kind?: 'file' | 'directory'; sizeBytes?: number }> {
  const candidates = rawPath.startsWith('/')
    ? [rawPath]
    : [resolve(cwd, rawPath)]
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) {
        return { exists: true, kind: 'file', sizeBytes: info.size }
      }
      if (info.isDirectory()) {
        return { exists: true, kind: 'directory' }
      }
    } catch {
      // Fall through to the next candidate.
    }
  }
  return { exists: false }
}

function canonicalDoiUrl(doi: string): string {
  return `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}`
}

export async function registerDataAsset(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const id = options.id?.trim()
  const name = options.name?.trim()
  const version = options.version?.trim() || '1.0.0'
  const packId = options.pack?.trim() || DEFAULT_PACK_ID
  const doi = options.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  const urls = [...new Set((options.urls ?? []).map(url => url.trim()).filter(Boolean))]
  const payloadPath = options.path?.trim()

  if (!id || !name) {
    io.stderr(USAGE)
    return 1
  }
  if (!slugOk(id)) {
    io.stderr('register-data: --id must be a lowercase slug (a-z, 0-9, ".", "_", "-")\n')
    return 1
  }
  if (!slugOk(packId)) {
    io.stderr('register-data: --pack must be a lowercase slug (a-z, 0-9, ".", "_", "-")\n')
    return 1
  }
  if (!doi && urls.length === 0 && !payloadPath) {
    io.stderr(
      'register-data: provide at least one source of truth: --url, --doi, or --path\n',
    )
    return 1
  }

  // Refuse to silently shadow an existing registry entry unless asked.
  const existingAssets = await loadMatOSAssets(io.cwd)
  const canonicalKey = `data:${id}@${version}`
  const existing = existingAssets.find(asset => asset.canonicalKey === canonicalKey)
  const packRoot = join(io.cwd, '.matos', 'assets', 'packs', packId)
  const assetDir = join(packRoot, 'data', id)
  if (existing && !options.replace) {
    io.stderr(
      `register-data: ${canonicalKey} already exists (${existing.manifestPath}); use --replace to overwrite the project-local copy\n`,
    )
    return 1
  }
  if (existing && options.replace && !existing.manifestPath.startsWith(packRoot)) {
    io.stderr(
      `register-data: --replace only overwrites project-local assets under .matos/assets/packs/${packId}; ${canonicalKey} lives at ${existing.manifestPath}\n`,
    )
    return 1
  }

  const warnings: string[] = []
  let payload: Awaited<ReturnType<typeof payloadProbe>> | undefined
  if (payloadPath) {
    payload = await payloadProbe(io.cwd, payloadPath)
    if (!payload.exists) {
      if (options.requirePath) {
        io.stderr(`register-data: --require-path set but path is not readable: ${payloadPath}\n`)
        return 1
      }
      warnings.push(`payload path is not readable from this runtime: ${payloadPath}`)
    }
  }

  if (doi) {
    const doiUrl = canonicalDoiUrl(doi)
    if (!urls.includes(doiUrl)) {
      urls.push(doiUrl)
    }
  }

  const payloadStatus = payload?.exists
    ? 'verified'
    : payloadPath
      ? 'missing'
      : 'reference-only'
  const tags = [
    'dataset',
    'registered',
    ...(options.tags ?? []).map(tag => tag.trim()).filter(Boolean),
  ]
  const description =
    options.description?.trim() ||
    `Registered dataset reference ${name}; payload stays at its source location.`

  const metadata: Record<string, unknown> = {
    kind: 'registered-dataset',
    sourceFormat: 'matos-registered-data',
    payloadPolicy: 'reference-only',
    payloadStatus,
    registeredBy: 'matos assets register-data',
    registeredAt: new Date().toISOString(),
    runnable: false,
  }
  if (urls.length > 0) {
    metadata.sourceUrl = urls[0]
    metadata.sourceUrls = urls.slice(0, 20)
  }
  if (doi) {
    metadata.doi = doi
  }
  if (payloadPath) {
    metadata.path = payloadPath
    if (payload?.exists) {
      metadata.payloadKind = 'data'
      metadata.payloadPaths = [payloadPath]
    }
    if (payload?.sizeBytes !== undefined) {
      metadata.sizeBytes = payload.sizeBytes
      metadata.sizeHuman = humanSize(payload.sizeBytes)
    }
  }
  if (options.domain?.trim()) {
    metadata.domain = options.domain.trim()
  }
  if (options.tosArchive?.trim()) {
    metadata.tosArchive = options.tosArchive.trim()
    metadata.storagePolicy = 'payload-stays-in-tos'
  }

  const manifest = {
    schemaVersion: 1,
    id,
    type: 'data',
    name,
    version,
    description,
    tags: [...new Set(tags)],
    permissions: {
      workspace: 'read-only',
      network: 'disabled',
      secrets: [],
    },
    metadata,
  }

  await mkdir(assetDir, { recursive: true })
  await writeFile(
    join(packRoot, 'matos.pack.json'),
    `${JSON.stringify(
      {
        id: packId,
        name: 'Registered Data Assets',
        version: '0.1.0',
        description:
          'Project-local reference data assets registered through `matos assets register-data`.',
        metadata: {
          // Marks the pack as project-local so the assets load path reports
          // source: 'project' (same class as Data Center pins) and scoped
          // UIs treat these manifests as the daemon's own workspace data.
          sourceFormat: 'matos-registered-data-pack',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const manifestPath = join(assetDir, 'asset.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // The whole-registry validation gate keeps register-data honest: duplicate
  // canonical keys, broken manifests, or dangling references roll the new
  // asset directory back instead of leaving a broken registry behind.
  const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
  const ownErrors = validation.errors.filter(
    error =>
      error.manifestPath === manifestPath ||
      error.assetKey === canonicalKey ||
      error.assetId === id,
  )
  if (ownErrors.length > 0) {
    await rm(assetDir, { recursive: true, force: true })
    if (options.json) {
      writeJson(io, {
        ok: false,
        rolledBack: true,
        errors: ownErrors,
      })
    } else {
      for (const error of ownErrors) {
        io.stderr(`${error.code}: ${error.message}\n`)
      }
      io.stderr('register-data: validation failed; the new asset was rolled back\n')
    }
    return 1
  }

  const ref = `data:${id}@${version}`
  const result = {
    ok: true,
    ref,
    id,
    packId,
    manifestPath: join('.matos', 'assets', 'packs', packId, 'data', id, 'asset.json'),
    payloadStatus,
    ...(urls.length > 0 ? { sourceUrl: urls[0] } : {}),
    ...(doi ? { doi } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    validation: { ok: validation.ok, errorCount: validation.errors.length },
  }
  if (options.json) {
    writeJson(io, result)
  } else {
    io.stdout(`registered ${ref} (${result.manifestPath})\n`)
    for (const warning of warnings) {
      io.stdout(`warning: ${warning}\n`)
    }
  }
  return 0
}
