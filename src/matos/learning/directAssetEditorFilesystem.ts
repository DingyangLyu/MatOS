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

import { constants, type Dirent } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  assertNoSymlinkPathComponent,
  isWithinMatOSAssetHistoryPath,
  matOSAssetHistoryAllowedRoots,
  matOSAssetHistoryLogicalPath,
  MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX,
  shouldIgnoreMatOSAssetHistoryPath,
} from '../assets/history/policy.js'
import { isMatOSAssetHistoryResidueRemovalError } from '../assets/history/restore.js'
import { getMatOSDir, getMatOSBundledAssetRootCandidates, resolveMatOSEditableCoreAssetPackRoot } from '../project.js'
import { loadMatOSAssetsFromRoot } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry, getMatOSAssetSubgraph } from '../assets/registry.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'

export type GuardedPathEntry =
  | { kind: 'file'; content: Buffer }
  | { kind: 'symlink'; target: string }
  | { kind: 'dir' }

export type DirectEditorImportBackup =
  | { absolutePath: string; existed: false }
  | { absolutePath: string; existed: true; entry: GuardedPathEntry }

export type ProtectedCoreFileSnapshot = Map<string, GuardedPathEntry>
export type DirectEditorWorkspaceGuardSnapshot = Map<string, GuardedPathEntry>
export type DirectEditorIsolationWorkspace = {
  cwd: string
  cleanup: () => Promise<void>
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

// Resolved location of the editable core pack. In the dev repo, harnesses, and
// isolation workspaces this is the cwd-relative pack; in installed deployments
// it resolves through MATOS_EDITABLE_CORE_ASSET_ROOT / MATOS_BUNDLED_ASSET_ROOT
// so direct editing can locate core assets from a workspace cwd.
export function coreEditableRoot(cwd: string): string {
  return resolveMatOSEditableCoreAssetPackRoot(cwd)
}

// The isolation workspace always uses the literal cwd-relative layout so the
// hidden role edits logical `matos-assets/packs/matos-core/...` paths.
function isolationCoreEditableRoot(isolatedCwd: string): string {
  return join(isolatedCwd, 'matos-assets', 'packs', 'matos-core')
}

function guardKeyAbsolutePath(cwd: string, key: string): string {
  if (
    key === MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX ||
    key.startsWith(`${MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX}/`)
  ) {
    const coreRoot = resolve(coreEditableRoot(cwd))
    const rest = key.slice(MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX.length + 1)
    return rest ? join(coreRoot, rest) : coreRoot
  }
  return join(cwd, key)
}

export function guardKeyForPath(
  cwd: string,
  path: string,
  scope: MatOSDirectAssetEditorScope = 'core',
  scopeRef?: string,
): string {
  return (
    matOSAssetHistoryLogicalPath({
      cwd,
      scope,
      ...(scopeRef ? { scopeRef } : {}),
      absolutePath: path,
    }) ?? relative(cwd, path).replace(/\\/g, '/')
  )
}

export function editableRoots(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): string[] {
  return matOSAssetHistoryAllowedRoots(cwd, scope, scopeRef)
}

export function promptEditableRoots(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): string[] {
  return scope === 'core'
    ? [coreEditableRoot(cwd)]
    : editableRoots(cwd, scope, scopeRef)
}

function isMissingPathError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function lstatOrMissing(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function readdirNamesOrMissing(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function readdirDirentsOrMissing(
  path: string,
): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = resolve(path)
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new Error(`No existing ancestor for direct-editor writable root: ${path}`)
      }
      current = parent
    }
  }
}

async function assertWritableDirectoryRoot(root: string): Promise<void> {
  const absoluteRoot = resolve(root)
  const info = await lstat(absoluteRoot).catch(error => {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  })
  if (!info) {
    const ancestor = await nearestExistingAncestor(dirname(absoluteRoot))
    await access(ancestor, constants.W_OK | constants.X_OK)
    return
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Direct-editor writable root is a symlink: ${absoluteRoot}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`Direct-editor writable root is not a directory: ${absoluteRoot}`)
  }
  await access(absoluteRoot, constants.R_OK | constants.W_OK | constants.X_OK)
}

export async function assertDirectEditorWritableRoots(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
}): Promise<void> {
  const assetRoots = matOSAssetHistoryAllowedRoots(
    input.cwd,
    input.scope,
    input.scopeRef,
  )
  if (assetRoots.length === 0) {
    throw new Error(
      `Direct-editor writable asset roots are not usable: no ${input.scope} asset source is configured${input.scopeRef ? ` for ${input.scopeRef}` : ''}`,
    )
  }
  const roots = directEditorWritableRoots(
    input.cwd,
    input.scope,
    input.scopeRef,
  )
  for (const root of roots) {
    try {
      await assertWritableDirectoryRoot(root)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Direct-editor writable root is not usable before editing: ${root}: ${reason}`,
        { cause: error },
      )
    }
  }
}

export function startsWithAny(path: string, roots: string[]): boolean {
  return roots.some(root => path === root || path.startsWith(`${root}/`))
}

export function entriesEqual(
  a: GuardedPathEntry,
  b: GuardedPathEntry,
): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'dir') {
    return b.kind === 'dir'
  }
  if (a.kind === 'file') {
    return b.kind === 'file' && a.content.equals(b.content)
  }
  return b.kind === 'symlink' && a.target === b.target
}

export function optionalEntriesEqual(
  a: GuardedPathEntry | undefined,
  b: GuardedPathEntry | undefined,
): boolean {
  if (!a || !b) {
    return a === b
  }
  return entriesEqual(a, b)
}

export async function captureGuardedPathEntry(
  path: string,
): Promise<GuardedPathEntry | undefined> {
  const info = await lstatOrMissing(path)
  if (!info) {
    return undefined
  }
  if (info.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(path) }
  }
  if (info.isFile()) {
    return { kind: 'file', content: await readFile(path) }
  }
  return undefined
}

export async function captureImportPathEntry(
  path: string,
): Promise<GuardedPathEntry | undefined> {
  const info = await lstatOrMissing(path)
  if (!info) {
    return undefined
  }
  if (info.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(path) }
  }
  if (info.isFile()) {
    return { kind: 'file', content: await readFile(path) }
  }
  if (info.isDirectory()) {
    return { kind: 'dir' }
  }
  return undefined
}

export async function backupImportPath(input: {
  absolutePath: string
  backups: Map<string, DirectEditorImportBackup>
}): Promise<void> {
  if (input.backups.has(input.absolutePath)) {
    return
  }
  const entry = await captureImportPathEntry(input.absolutePath)
  input.backups.set(
    input.absolutePath,
    entry
      ? { absolutePath: input.absolutePath, existed: true, entry }
      : { absolutePath: input.absolutePath, existed: false },
  )
}

async function restoreGuardedPathEntry(
  cwd: string,
  path: string,
  entry: GuardedPathEntry | undefined,
): Promise<void> {
  const absolutePath = guardKeyAbsolutePath(cwd, path)
  await assertNoSymlinkPathComponent({
    cwd,
    absolutePath,
    includeTarget: false,
    baseRoots: [coreEditableRoot(cwd)],
  })
  if (!entry) {
    await rm(absolutePath, { force: true, recursive: true })
    await pruneEmptyDirectoriesToBase(cwd, dirname(absolutePath))
    return
  }
  await rm(absolutePath, { force: true, recursive: true })
  await mkdir(dirname(absolutePath), { recursive: true })
  if (entry.kind === 'file') {
    await writeFile(absolutePath, entry.content)
    return
  }
  if (entry.kind === 'dir') {
    await mkdir(absolutePath, { recursive: true })
    return
  }
  await symlink(entry.target, absolutePath)
}

export async function pruneEmptyDirectoriesToBase(
  cwd: string,
  startDir: string,
): Promise<void> {
  const bases = [resolve(cwd), resolve(coreEditableRoot(cwd))]
  let current = resolve(startDir)
  while (
    bases.some(
      base => current !== base && isWithinMatOSAssetHistoryPath(current, base),
    )
  ) {
    const entries = await readdirNamesOrMissing(current)
    if (!entries || entries.length > 0) {
      return
    }
    await rmdir(current).catch(() => undefined)
    current = dirname(current)
  }
}

function isProtectedCoreFile(
  cwd: string,
  path: string,
  hiddenAssetDirs: string[],
): boolean {
  const absolutePath = resolve(path)
  if (
    hiddenAssetDirs.some(dir =>
      isWithinMatOSAssetHistoryPath(absolutePath, dir),
    )
  ) {
    return true
  }
  const coreRoot = resolve(coreEditableRoot(cwd))
  if (!isWithinMatOSAssetHistoryPath(absolutePath, coreRoot)) {
    return false
  }
  return !matOSAssetHistoryAllowedRoots(cwd, 'core').some(root =>
    isWithinMatOSAssetHistoryPath(absolutePath, root),
  )
}

async function listHiddenCoreAssetDirs(cwd: string): Promise<string[]> {
  return listHiddenAssetDirs(cwd, 'core')
}

export async function listHiddenAssetDirs(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): Promise<string[]> {
  const hiddenDirs: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdirDirentsOrMissing(dir)
    if (!entries) {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (!entry.isDirectory()) {
        continue
      }
      const manifestPath = join(path, 'asset.json')
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          metadata?: { hidden?: unknown }
        }
        if (manifest.metadata?.hidden === true) {
          hiddenDirs.push(resolve(path))
        }
      } catch {
        // Not every directory is an asset directory.
      }
      await visit(path)
    }
  }
  for (const root of matOSAssetHistoryAllowedRoots(cwd, scope, scopeRef)) {
    await visit(root)
  }
  return hiddenDirs
}

async function listProtectedCoreFiles(
  cwd: string,
  dir: string,
  hiddenAssetDirs: string[],
): Promise<string[]> {
  const entries = await readdirDirentsOrMissing(dir)
  if (!entries) {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    const info = await lstatOrMissing(path)
    if (!info) {
      continue
    }
    if (info.isDirectory()) {
      files.push(...(await listProtectedCoreFiles(cwd, path, hiddenAssetDirs)))
      continue
    }
    if (
      (info.isFile() || info.isSymbolicLink()) &&
      isProtectedCoreFile(cwd, path, hiddenAssetDirs)
    ) {
      files.push(path)
    }
  }
  return files
}

export async function captureProtectedCoreFiles(
  cwd: string,
): Promise<ProtectedCoreFileSnapshot> {
  const snapshot: ProtectedCoreFileSnapshot = new Map()
  const hiddenAssetDirs = await listHiddenCoreAssetDirs(cwd)
  for (const path of await listProtectedCoreFiles(cwd, coreEditableRoot(cwd), hiddenAssetDirs)) {
    const entry = await captureGuardedPathEntry(path)
    if (entry) {
      snapshot.set(guardKeyForPath(cwd, path, 'core'), entry)
    }
  }
  return snapshot
}

export async function restoreProtectedCoreFileChanges(input: {
  cwd: string
  before: ProtectedCoreFileSnapshot
}): Promise<string[]> {
  const changed = new Set<string>()
  const after = await captureProtectedCoreFiles(input.cwd)
  for (const [path, entry] of after) {
    const beforeEntry = input.before.get(path)
    if (!beforeEntry) {
      await restoreGuardedPathEntry(input.cwd, path, undefined)
      changed.add(path)
    } else if (!entriesEqual(beforeEntry, entry)) {
      await restoreGuardedPathEntry(input.cwd, path, beforeEntry)
      changed.add(path)
    }
  }
  for (const [path, entry] of input.before) {
    const afterEntry = after.get(path)
    if (!afterEntry) {
      await restoreGuardedPathEntry(input.cwd, path, entry)
      changed.add(path)
    }
  }
  return [...changed].sort((a, b) => a.localeCompare(b))
}

const DIRECT_EDITOR_WORKSPACE_GUARD_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
])

const DIRECT_EDITOR_WORKSPACE_GUARD_RUNTIME_PREFIXES = [
  '.matos/sessions/',
  '.matos/evolution/monitor/',
  // Role composition itself can emit algorithm-selection telemetry before the
  // hidden child env (MATOS_ALGO_TELEMETRY=0) is applied.  This ledger is
  // runtime audit state, not an editor-authored workspace edit.  It remains in
  // the disposable isolation cwd and is never imported into the real project.
  '.matos/algorithms/',
  // Loading assets inside the isolation cwd materializes configured git
  // sources (fetch/checkout refresh under .matos/source-cache) and may
  // normalize .matos/matos.json back to disk. Both are runtime-managed state,
  // not editor-authored edits; treating them as stray writes rolled back
  // judge-accepted runs ("files modified outside direct-editor
  // writable scope: .matos/matos.json, .matos/source-cache/..."). Editor
  // writes into allowed source roots are unaffected: writable roots are
  // checked before this list in the guard visit.
  '.matos/source-cache/',
  '.matos/matos.json/',
]

function isDirectEditorWorkspaceGuardRuntimePath(cwd: string, path: string): boolean {
  const rel = relative(cwd, path).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) {
    return false
  }
  const normalized = rel.endsWith('/') ? rel : `${rel}/`
  return DIRECT_EDITOR_WORKSPACE_GUARD_RUNTIME_PREFIXES.some(prefix =>
    normalized.startsWith(prefix),
  )
}

function directEditorInternalWritableRoots(cwd: string): string[] {
  const matosDir = getMatOSDir(cwd)
  return [
    join(matosDir, 'evolution', 'direct-editor'),
    join(matosDir, 'evolution', 'prompts'),
    join(matosDir, 'evolution', 'role-run-cache'),
    join(matosDir, 'runtime', 'asset-runtime'),
    join(matosDir, 'runtime', 'cli-args'),
    join(matosDir, 'asset-history'),
    join(matosDir, 'asset-history.git'),
    join(matosDir, 'locks'),
    join(matosDir, 'tmp', 'asset-history'),
  ].map(root => resolve(root))
}

function directEditorWritableRoots(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): string[] {
  return unique([
    ...matOSAssetHistoryAllowedRoots(cwd, scope, scopeRef),
    ...directEditorInternalWritableRoots(cwd),
  ].map(root => resolve(root)))
}

function directEditorScopedAllowedTools(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): string[] {
  const root = resolve(cwd)
  const writeRoots = directEditorWritableRoots(root, scope, scopeRef)
  const permissionPattern = (path: string): string => {
    const resolved = resolve(path)
    return resolved.startsWith('/') ? `/${resolved}` : resolved
  }
  const readRoot = permissionPattern(root)
  return unique([
    `Read(${readRoot}/**)`,
    `Glob(${readRoot}/**)`,
    `Grep(${readRoot}/**)`,
    ...writeRoots.flatMap(writeRoot => [
      `Write(${permissionPattern(writeRoot)}/**)`,
      `Edit(${permissionPattern(writeRoot)}/**)`,
      `NotebookEdit(${permissionPattern(writeRoot)}/**)`,
    ]),
  ])
}

export function directEditorScopedPermissionArgs(
  cwd: string,
  scope: MatOSDirectAssetEditorScope,
  scopeRef?: string,
): string[] {
  return [
    '--permission-mode',
    'dontAsk',
    '--allowed-tools',
    directEditorScopedAllowedTools(cwd, scope, scopeRef).join(','),
  ]
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  return roots.some(root => isWithinMatOSAssetHistoryPath(path, root))
}

export async function captureDirectEditorWorkspaceGuard(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
}): Promise<DirectEditorWorkspaceGuardSnapshot> {
  const cwd = resolve(input.cwd)
  const writableRoots = directEditorWritableRoots(
    cwd,
    input.scope,
    input.scopeRef,
  )
  const snapshot: DirectEditorWorkspaceGuardSnapshot = new Map()

  async function visit(path: string): Promise<void> {
    if (path !== cwd && isInsideAnyRoot(path, writableRoots)) {
      return
    }
    if (path !== cwd && isDirectEditorWorkspaceGuardRuntimePath(cwd, path)) {
      return
    }
    const info = await lstatOrMissing(path)
    if (!info) {
      return
    }
    if (info.isDirectory()) {
      if (path !== cwd && DIRECT_EDITOR_WORKSPACE_GUARD_SKIP_DIRS.has(basename(path))) {
        return
      }
      const entries = await readdirNamesOrMissing(path) ?? []
      for (const entry of entries) {
        await visit(join(path, entry))
      }
      return
    }
    const entry = await captureGuardedPathEntry(path)
    if (entry) {
      snapshot.set(relative(cwd, path).replace(/\\/g, '/'), entry)
    }
  }

  await visit(cwd)
  return snapshot
}

export async function restoreDirectEditorWorkspaceGuardChanges(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  before: DirectEditorWorkspaceGuardSnapshot
}): Promise<string[]> {
  const after = await captureDirectEditorWorkspaceGuard({
    cwd: input.cwd,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
  })
  const changed = new Set<string>()
  for (const [path, afterEntry] of after) {
    const beforeEntry = input.before.get(path)
    if (!beforeEntry) {
      await restoreGuardedPathEntry(input.cwd, path, undefined)
      changed.add(path)
    } else if (!entriesEqual(beforeEntry, afterEntry)) {
      await restoreGuardedPathEntry(input.cwd, path, beforeEntry)
      changed.add(path)
    }
  }
  for (const [path, beforeEntry] of input.before) {
    if (!after.has(path)) {
      await restoreGuardedPathEntry(input.cwd, path, beforeEntry)
      changed.add(path)
    }
  }
  return [...changed].sort((a, b) => a.localeCompare(b))
}

export async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstatOrMissing(path))
}

export async function copyIfExists(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) {
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
    filter: sourcePath => !shouldIgnoreMatOSAssetHistoryPath(sourcePath),
  })
}

export async function replaceDirectoryContents(input: {
  source: string
  target: string
}): Promise<void> {
  if (!(await pathExists(input.source))) {
    return
  }
  await mkdir(input.target, { recursive: true })
  const targetEntries = await readdirDirentsOrMissing(input.target) ?? []
  for (const entry of targetEntries) {
    if (entry.name === '.git') {
      continue
    }
    await rm(join(input.target, entry.name), { recursive: true, force: true })
  }
  const sourceEntries = await readdirDirentsOrMissing(input.source) ?? []
  for (const entry of sourceEntries) {
    if (entry.name === '.git') {
      continue
    }
    await cp(join(input.source, entry.name), join(input.target, entry.name), {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
    })
  }
}

function cwdLocalCoreEditableRoot(cwd: string): string {
  return join(resolve(cwd), 'matos-assets', 'packs', 'matos-core')
}

function coreEditableRootIsOutsideCwd(cwd: string): boolean {
  const coreRoot = resolve(coreEditableRoot(cwd))
  const resolvedCwd = resolve(cwd)
  if (coreRoot === resolvedCwd) {
    return false
  }
  const rel = relative(resolvedCwd, coreRoot)
  return rel.startsWith('..') || isAbsolute(rel)
}

function optionalEnvString(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function ensureCwdLocalCoreEditablePack(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (optionalEnvString(env, 'MATOS_EDITABLE_CORE_ASSET_ROOT')) {
    return
  }
  const localRoot = cwdLocalCoreEditableRoot(cwd)
  if (await pathExists(localRoot)) {
    return
  }
  if (!coreEditableRootIsOutsideCwd(cwd)) {
    return
  }
  const sourceRoot = coreEditableRoot(cwd)
  if (!(await pathExists(sourceRoot))) {
    return
  }
  await copyIfExists(sourceRoot, localRoot)
}

function isolationLocalSourcePath(input: {
  cwd: string
  logicalRoot: string
}): string {
  return relative(
    join(input.cwd, '.matos'),
    join(input.cwd, input.logicalRoot),
  ).replace(/\\/g, '/')
}

async function writeIsolationProjectConfig(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  scopedLogicalRoots: string[]
}): Promise<void> {
  const assetSources =
    input.scope === 'core'
      ? []
      : input.scopedLogicalRoots.map((logicalRoot, index) => ({
          type: 'local',
          id: `direct-editor-${input.scope}-${index + 1}`,
          path: isolationLocalSourcePath({ cwd: input.cwd, logicalRoot }),
          scope: input.scope,
          ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
          refresh: 'manual',
        }))
  await mkdir(join(input.cwd, '.matos'), { recursive: true })
  await writeFile(
    join(input.cwd, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: ['../matos-assets', 'assets'],
        ...(assetSources.length > 0 ? { assetSources } : {}),
        includeDefaultAssetRoots: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function rewriteIsolatedDirectEditorManifest(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  env?: Record<string, string | undefined>
}): Promise<void> {
  const registry = buildMatOSAssetRegistry(
    await loadMatOSAssetsFromRoot(join(input.cwd, 'matos-assets')),
  )
  const editor = registry.resolve('role:direct-asset-editor')
  if (!editor) throw new Error('Isolated direct-asset-editor role is missing')
  const manifestPath = editor.manifestPath
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const mounts = metadataObject(raw.mounts)
  const runtime = metadataObject(raw.runtime)
  const dependencies = stringArray(raw.dependencies)
  const toolMounts = stringArray(mounts.tools)
  const extraDisallowedTools =
    optionalEnvString(
      input.env ?? process.env,
      'MATOS_DIRECT_EDITOR_EXTRA_DISALLOWED_TOOLS',
    )
      ?.split(/[;,\n]/u)
      .map(value => value.trim())
      .filter(Boolean) ?? []
  const scopedTools = directEditorScopedAllowedTools(
    input.cwd,
    input.scope,
    input.scopeRef,
  )
  const rewritten = {
    ...raw,
    dependencies,
    mounts: {
      ...mounts,
      tools: toolMounts,
    },
    runtime: {
      ...runtime,
      permissionMode: 'dontAsk',
      allowedTools: scopedTools,
      disallowedTools: unique([
        ...stringArray(runtime.disallowedTools),
        'Bash',
        'PowerShell',
        ...extraDisallowedTools,
      ]),
    },
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(rewritten, null, 2)}\n`,
    'utf8',
  )
}

// Public packs need not be named matos-core. Copy only the editor's declared
// runtime closure from the configured bundle; never pull in the internal library.
async function ensureIsolatedEditorRuntime(
  isolatedCwd: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const targetRoot = join(isolatedCwd, 'matos-assets')
  const existing = buildMatOSAssetRegistry(await loadMatOSAssetsFromRoot(targetRoot))
  if (existing.resolve('role:direct-asset-editor')) return
  for (const root of getMatOSBundledAssetRootCandidates(env)) {
    const registry = buildMatOSAssetRegistry(await loadMatOSAssetsFromRoot(root))
    if (!registry.resolve('role:direct-asset-editor')) continue
    for (const asset of getMatOSAssetSubgraph(registry, 'role:direct-asset-editor')) {
      const path = relative(root, asset.manifestDir)
      if (isAbsolute(path) || path === '..' || path.startsWith('../')) {
        throw new Error('Editor runtime asset escapes its configured bundle')
      }
      await copyIfExists(asset.manifestDir, join(targetRoot, path))
    }
    return
  }
  throw new Error('Configured bundle is missing role:direct-asset-editor')
}

export async function createDirectEditorIsolationWorkspace(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  runId: string
  env?: Record<string, string | undefined>
}): Promise<DirectEditorIsolationWorkspace> {
  const isolatedCwd = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: `${input.runId}-`,
  })
  const scopedRootMappings = editableRoots(
    input.cwd,
    input.scope,
    input.scopeRef,
  ).map(root => ({
    realRoot: root,
    logicalRoot: guardKeyForPath(
      input.cwd,
      root,
      input.scope,
      input.scopeRef,
    ),
  }))
  await writeIsolationProjectConfig({
    cwd: isolatedCwd,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    scopedLogicalRoots: scopedRootMappings.map(mapping => mapping.logicalRoot),
  })
  await copyIfExists(
    coreEditableRoot(input.cwd),
    isolationCoreEditableRoot(isolatedCwd),
  )
  for (const mapping of scopedRootMappings) {
    await copyIfExists(mapping.realRoot, join(isolatedCwd, mapping.logicalRoot))
  }
  await ensureIsolatedEditorRuntime(isolatedCwd, input.env ?? process.env)
  await rewriteIsolatedDirectEditorManifest({
    cwd: isolatedCwd,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...(input.env ? { env: input.env } : {}),
  })
  return {
    cwd: isolatedCwd,
    cleanup: async () => {
      await rm(isolatedCwd, { recursive: true, force: true })
    },
  }
}

export async function listImportableAssetEntries(input: {
  root: string
  skipDirs: string[]
}): Promise<Map<string, GuardedPathEntry>> {
  const entries = new Map<string, GuardedPathEntry>()
  const root = resolve(input.root)

  async function visit(path: string): Promise<void> {
    const absolutePath = resolve(path)
    if (shouldIgnoreMatOSAssetHistoryPath(absolutePath)) {
      return
    }
    if (
      absolutePath !== root &&
      input.skipDirs.some(dir => isWithinMatOSAssetHistoryPath(absolutePath, dir))
    ) {
      return
    }
    const info = await lstatOrMissing(absolutePath)
    if (!info) {
      return
    }
    const rel = relative(root, absolutePath).replace(/\\/g, '/')
    if (info.isSymbolicLink()) {
      if (rel) {
        entries.set(rel, { kind: 'symlink', target: await readlink(absolutePath) })
      }
      return
    }
    if (info.isFile()) {
      if (rel) {
        entries.set(rel, { kind: 'file', content: await readFile(absolutePath) })
      }
      return
    }
    if (!info.isDirectory()) {
      return
    }
    if (rel) {
      entries.set(rel, { kind: 'dir' })
    }
    const children = await readdirNamesOrMissing(absolutePath) ?? []
    for (const child of children) {
      await visit(join(absolutePath, child))
    }
  }

  await visit(root)
  return entries
}

export async function writeImportedAssetEntry(input: {
  cwd: string
  path: string
  entry: GuardedPathEntry
}): Promise<void> {
  await assertNoSymlinkPathComponent({
    cwd: input.cwd,
    absolutePath: input.path,
    includeTarget: false,
    baseRoots: [coreEditableRoot(input.cwd)],
  })
  if (input.entry.kind === 'dir') {
    const info = await lstatOrMissing(input.path)
    if (info && !info.isDirectory()) {
      await rm(input.path, { recursive: true, force: true })
    }
    await mkdir(input.path, { recursive: true })
    return
  }
  await rm(input.path, { recursive: true, force: true })
  await mkdir(dirname(input.path), { recursive: true })
  if (input.entry.kind === 'file') {
    await writeFile(input.path, input.entry.content)
    return
  }
  await symlink(input.entry.target, input.path)
}

export async function restoreDirectEditorImportBackups(input: {
  cwd: string
  backups: DirectEditorImportBackup[]
}): Promise<{ skippedRemovals: string[] }> {
  const skippedRemovals: string[] = []
  for (const backup of [...input.backups].reverse()) {
    if (!backup.existed) {
      await assertNoSymlinkPathComponent({
        cwd: input.cwd,
        absolutePath: backup.absolutePath,
        includeTarget: false,
        baseRoots: [coreEditableRoot(input.cwd)],
      })
      try {
        await rm(backup.absolutePath, { recursive: true, force: true })
      } catch (error) {
        // Cross-UID residue that cannot be unlinked from inside the container
        // must not fail the whole backup restore: restoring pre-import file
        // content is the critical guarantee, and a leftover created file is
        // recorded for the next host-side ownership repair instead.
        if (isMatOSAssetHistoryResidueRemovalError(error)) {
          skippedRemovals.push(backup.absolutePath)
          continue
        }
        throw error
      }
      continue
    }
    await writeImportedAssetEntry({
      cwd: input.cwd,
      path: backup.absolutePath,
      entry: backup.entry,
    })
  }
  return { skippedRemovals }
}
