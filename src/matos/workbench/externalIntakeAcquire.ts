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

// External intake acquisition: turn any supported import source — a local
// directory or file, a zip/tar archive, a git repository URL, or a plain
// http(s) download — into a local directory/file that the existing intake
// classification, draft-pack, secret-scan, and validation pipeline can
// consume unchanged.
//
// Remote and archive sources are staged below `.matos/intake/sources/<id>`
// keyed by a digest of the source string, with an `.acquire.json` provenance
// record beside the payload. Staging is idempotent: preview and apply resolve
// the same source to the same staged path so intake confirmation
// fingerprints stay stable, and a later identical import reuses the stage
// instead of re-downloading.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir,readFile,readdir,rename,rm,stat,writeFile } from 'node:fs/promises'
import { basename,isAbsolute,join,resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const INTAKE_SOURCES_RELATIVE_ROOT = '.matos/intake/sources'
const ACQUIRE_RECORD_FILE = '.acquire.json'
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const GIT_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
])

export type MatOSExternalIntakeAcquisitionIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export type MatOSExternalIntakeAcquisition = {
  mode: 'external-intake-acquire'
  source: string
  sourceKind: 'local' | 'archive' | 'git' | 'download'
  /** Local path the intake classifier should scan (dir or paper file). */
  localPath: string
  staged: boolean
  stagedRelativePath?: string
  reused: boolean
  provenance: {
    acquiredAt: string
    url?: string
    gitRemote?: string
    gitCommit?: string
    archiveName?: string
    archiveSha256?: string
    downloadSha256?: string
    downloadBytes?: number
  }
  issues: MatOSExternalIntakeAcquisitionIssue[]
}

function sha12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function slugName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.(zip|tar|tgz|gz|bz2|xz|git)$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'source'
}

function archiveKind(name: string): 'zip' | 'tar' | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) {
    return 'zip'
  }
  if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(lower)) {
    return 'tar'
  }
  return undefined
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** Git sources: explicit .git suffixes, git hosting domains, or git+ prefix. */
function gitRemoteFor(value: string): string | undefined {
  if (value.startsWith('git@') || value.startsWith('git+')) {
    return value.replace(/^git\+/, '')
  }
  if (!isHttpUrl(value)) {
    return undefined
  }
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.pathname.endsWith('.git')) {
      return value
    }
    if (!GIT_HOSTS.has(host)) {
      return undefined
    }
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return undefined
    }
    // Normalize deep links (tree/blob/releases pages) to the repository root.
    const repo = segments[1].replace(/\.git$/, '')
    return `${url.origin}/${segments[0]}/${repo}.git`
  } catch {
    return undefined
  }
}

function maxDownloadBytes(): number {
  const parsed = Number(process.env.MATOS_INTAKE_MAX_DOWNLOAD_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_DOWNLOAD_BYTES
}

async function pathKind(path: string): Promise<'directory' | 'file' | 'missing'> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) {
      return 'directory'
    }
    if (info.isFile()) {
      return 'file'
    }
    return 'missing'
  } catch {
    return 'missing'
  }
}

async function listArchiveEntries(kind: 'zip' | 'tar', archivePath: string): Promise<string[]> {
  const command =
    kind === 'zip'
      ? await execFileAsync('unzip', ['-Z1', archivePath], { maxBuffer: 32 * 1024 * 1024 })
      : await execFileAsync('tar', ['-tf', archivePath], { maxBuffer: 32 * 1024 * 1024 })
  return command.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

function unsafeArchiveEntry(entry: string): boolean {
  if (entry.startsWith('/') || entry.startsWith('\\')) {
    return true
  }
  return entry
    .split('/')
    .some(segment => segment === '..')
}

async function extractArchive(
  kind: 'zip' | 'tar',
  archivePath: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  if (kind === 'zip') {
    await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', targetDir], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return
  }
  await execFileAsync('tar', ['-xf', archivePath, '-C', targetDir], {
    maxBuffer: 32 * 1024 * 1024,
  })
}

/** When an archive/clone holds exactly one top-level directory, scan that. */
async function collapseSingleDirectory(root: string): Promise<string> {
  try {
    const entries = (await readdir(root, { withFileTypes: true })).filter(
      entry => !entry.name.startsWith('.'),
    )
    if (entries.length === 1 && entries[0].isDirectory()) {
      return join(root, entries[0].name)
    }
  } catch {
    // Fall through to the root itself.
  }
  return root
}

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const payload = await readFile(path)
  return {
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.byteLength,
  }
}

type AcquireRecord = {
  source: string
  sourceKind: MatOSExternalIntakeAcquisition['sourceKind']
  localPath: string
  provenance: MatOSExternalIntakeAcquisition['provenance']
}

async function readAcquireRecord(stageDir: string): Promise<AcquireRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(stageDir, ACQUIRE_RECORD_FILE), 'utf8')) as AcquireRecord
    return raw && typeof raw === 'object' ? raw : undefined
  } catch {
    return undefined
  }
}

async function writeAcquireRecord(stageDir: string, record: AcquireRecord): Promise<void> {
  await writeFile(
    join(stageDir, ACQUIRE_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  )
}

export async function acquireMatOSExternalIntakeSource(input: {
  cwd: string
  source: string
  refresh?: boolean
}): Promise<MatOSExternalIntakeAcquisition> {
  const source = input.source.trim()
  const issues: MatOSExternalIntakeAcquisitionIssue[] = []
  const now = new Date().toISOString()

  const failed = (
    sourceKind: MatOSExternalIntakeAcquisition['sourceKind'],
    issue: MatOSExternalIntakeAcquisitionIssue,
  ): MatOSExternalIntakeAcquisition => ({
    mode: 'external-intake-acquire',
    source,
    sourceKind,
    localPath: resolve(input.cwd, source),
    staged: false,
    reused: false,
    provenance: { acquiredAt: now },
    issues: [...issues, issue],
  })

  const gitRemote = gitRemoteFor(source)
  const remote = gitRemote !== undefined || isHttpUrl(source)

  // Local directories, paper files, and local archives.
  if (!remote) {
    const localPath = isAbsolute(source) ? source : resolve(input.cwd, source)
    const kind = await pathKind(localPath)
    if (kind === 'missing') {
      // Let the classifier report the canonical source_missing issue so
      // behavior for plain local paths stays byte-identical.
      return {
        mode: 'external-intake-acquire',
        source,
        sourceKind: 'local',
        localPath,
        staged: false,
        reused: false,
        provenance: { acquiredAt: now },
        issues,
      }
    }
    const archive = kind === 'file' ? archiveKind(localPath) : undefined
    if (!archive) {
      return {
        mode: 'external-intake-acquire',
        source,
        sourceKind: 'local',
        localPath,
        staged: false,
        reused: false,
        provenance: { acquiredAt: now },
        issues,
      }
    }
    const { sha256 } = await sha256File(localPath)
    const sourceSlug = slugName(basename(localPath))
    const stageId = `${sourceSlug}-${sha256.slice(0, 12)}`
    const stageDir = resolve(input.cwd, INTAKE_SOURCES_RELATIVE_ROOT, stageId)
    // The classifier derives the intake id from the scanned directory's
    // basename, so the unpack root carries the archive's slug, not a generic
    // "unpacked" name. Single-top-level-dir archives collapse further into
    // that directory.
    const unpackedDir = join(stageDir, sourceSlug)
    const existing = input.refresh ? undefined : await readAcquireRecord(stageDir)
    if (existing && (await pathKind(existing.localPath)) !== 'missing') {
      return {
        mode: 'external-intake-acquire',
        source,
        sourceKind: 'archive',
        localPath: existing.localPath,
        staged: true,
        stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
        reused: true,
        provenance: existing.provenance,
        issues,
      }
    }
    try {
      const entries = await listArchiveEntries(archive, localPath)
      const unsafe = entries.filter(unsafeArchiveEntry)
      if (unsafe.length > 0) {
        return failed('archive', {
          code: 'archive_unsafe_entries',
          severity: 'error',
          message: `Archive contains unsafe paths (absolute or ..): ${unsafe.slice(0, 3).join(', ')}`,
        })
      }
      await rm(unpackedDir, { recursive: true, force: true })
      await extractArchive(archive, localPath, unpackedDir)
    } catch (error) {
      return failed('archive', {
        code: 'archive_extract_failed',
        severity: 'error',
        message: `Archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    const scanRoot = await collapseSingleDirectory(unpackedDir)
    const provenance = {
      acquiredAt: now,
      archiveName: basename(localPath),
      archiveSha256: sha256,
    }
    await writeAcquireRecord(stageDir, {
      source,
      sourceKind: 'archive',
      localPath: scanRoot,
      provenance,
    })
    return {
      mode: 'external-intake-acquire',
      source,
      sourceKind: 'archive',
      localPath: scanRoot,
      staged: true,
      stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
      reused: false,
      provenance,
      issues,
    }
  }

  // Git repositories.
  if (gitRemote !== undefined) {
    const repoSlug = slugName(basename(gitRemote))
    const stageId = `${repoSlug}-${sha12(gitRemote)}`
    const stageDir = resolve(input.cwd, INTAKE_SOURCES_RELATIVE_ROOT, stageId)
    const checkoutDir = join(stageDir, repoSlug)
    const existing = input.refresh ? undefined : await readAcquireRecord(stageDir)
    if (existing && (await pathKind(existing.localPath)) !== 'missing') {
      return {
        mode: 'external-intake-acquire',
        source,
        sourceKind: 'git',
        localPath: existing.localPath,
        staged: true,
        stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
        reused: true,
        provenance: existing.provenance,
        issues,
      }
    }
    try {
      await rm(checkoutDir, { recursive: true, force: true })
      await mkdir(stageDir, { recursive: true })
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--single-branch', gitRemote, checkoutDir],
        {
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          timeout: 300_000,
        },
      )
    } catch (error) {
      return failed('git', {
        code: 'git_clone_failed',
        severity: 'error',
        message: `git clone failed for ${gitRemote}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    let gitCommit: string | undefined
    try {
      gitCommit = (
        await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD'])
      ).stdout.trim()
    } catch {
      gitCommit = undefined
    }
    const provenance = {
      acquiredAt: now,
      url: source,
      gitRemote,
      ...(gitCommit ? { gitCommit } : {}),
    }
    await writeAcquireRecord(stageDir, {
      source,
      sourceKind: 'git',
      localPath: checkoutDir,
      provenance,
    })
    return {
      mode: 'external-intake-acquire',
      source,
      sourceKind: 'git',
      localPath: checkoutDir,
      staged: true,
      stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
      reused: false,
      provenance,
      issues,
    }
  }

  // Plain http(s) downloads: archives unpack, other payloads (pdf/md/single
  // data file) feed the classifier directly.
  const stageId = `${slugName(basename(new URL(source).pathname) || 'download')}-${sha12(source)}`
  const stageDir = resolve(input.cwd, INTAKE_SOURCES_RELATIVE_ROOT, stageId)
  const existing = input.refresh ? undefined : await readAcquireRecord(stageDir)
  if (existing && (await pathKind(existing.localPath)) !== 'missing') {
    return {
      mode: 'external-intake-acquire',
      source,
      sourceKind: 'download',
      localPath: existing.localPath,
      staged: true,
      stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
      reused: true,
      provenance: existing.provenance,
      issues,
    }
  }
  let downloadPath: string
  let downloadSha256: string
  let downloadBytes: number
  try {
    const response = await fetch(source, { redirect: 'follow' })
    if (!response.ok) {
      return failed('download', {
        code: 'download_failed',
        severity: 'error',
        message: `Download failed with HTTP ${response.status}: ${source}`,
      })
    }
    const limit = maxDownloadBytes()
    // Enforce the size limit BEFORE buffering the whole body into memory.
    // A well-behaved server advertises Content-Length, so reject oversized
    // downloads up front; otherwise stream with a running cap and abort the
    // moment the payload exceeds the limit so a malicious/huge intake URL
    // cannot OOM the workspace daemon.
    const tooLarge = (observed: number) =>
      failed('download', {
        code: 'download_too_large',
        severity: 'error',
        message: `Download exceeds the intake limit (${observed} > ${limit} bytes); mount it locally instead.`,
      })
    const declaredLength = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel().catch(() => {})
      return tooLarge(declaredLength)
    }
    let payload: Buffer
    if (response.body) {
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        if (value?.byteLength) {
          total += value.byteLength
          if (total > limit) {
            await reader.cancel().catch(() => {})
            return tooLarge(total)
          }
          chunks.push(Buffer.from(value))
        }
      }
      payload = Buffer.concat(chunks)
    } else {
      payload = Buffer.from(await response.arrayBuffer())
      if (payload.byteLength > limit) {
        return tooLarge(payload.byteLength)
      }
    }
    const fileName = basename(new URL(source).pathname) || 'download'
    await mkdir(join(stageDir, 'download'), { recursive: true })
    downloadPath = join(stageDir, 'download', fileName)
    const partialPath = `${downloadPath}.partial`
    await writeFile(partialPath, payload)
    await rename(partialPath, downloadPath)
    downloadSha256 = createHash('sha256').update(payload).digest('hex')
    downloadBytes = payload.byteLength
  } catch (error) {
    return failed('download', {
      code: 'download_failed',
      severity: 'error',
      message: `Download failed for ${source}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  let localPath = downloadPath
  const archive = archiveKind(downloadPath)
  if (archive) {
    const unpackedDir = join(stageDir, slugName(basename(downloadPath)))
    try {
      const entries = await listArchiveEntries(archive, downloadPath)
      const unsafe = entries.filter(unsafeArchiveEntry)
      if (unsafe.length > 0) {
        return failed('download', {
          code: 'archive_unsafe_entries',
          severity: 'error',
          message: `Downloaded archive contains unsafe paths: ${unsafe.slice(0, 3).join(', ')}`,
        })
      }
      await rm(unpackedDir, { recursive: true, force: true })
      await extractArchive(archive, downloadPath, unpackedDir)
      localPath = await collapseSingleDirectory(unpackedDir)
    } catch (error) {
      return failed('download', {
        code: 'archive_extract_failed',
        severity: 'error',
        message: `Downloaded archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  const provenance = {
    acquiredAt: now,
    url: source,
    downloadSha256,
    downloadBytes,
  }
  await writeAcquireRecord(stageDir, {
    source,
    sourceKind: 'download',
    localPath,
    provenance,
  })
  return {
    mode: 'external-intake-acquire',
    source,
    sourceKind: 'download',
    localPath,
    staged: true,
    stagedRelativePath: `${INTAKE_SOURCES_RELATIVE_ROOT}/${stageId}`,
    reused: false,
    provenance,
    issues,
  }
}
