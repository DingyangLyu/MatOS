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

import type { Stats } from 'node:fs'
import { chmod, chown, lchown, lstat, mkdir, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getMatOSDir } from '../project.js'
import { envValue, type MatOSEnv } from './runtimeEnv.js'

export type MatOSRuntimeScopeKind = 'user'

export type MatOSRuntimeScope = {
  ref: string
  kind: MatOSRuntimeScopeKind
  id: string
  rootDir: string
  homeDir: string
  workspaceDir: string
  sharedWorkspaceDir: string
  workspacesDir: string
  logsDir: string
  assetsDir: string
  sessionsDir: string
  workflowsDir: string
  workflowRunsDir: string
  cachesDir: string
  tmpDir: string
  homeCacheDir: string
  homeLocalDir: string
  homeBunDir: string
  homeNpmDir: string
  ipcDir: string
  containerStateDir: string
}

export type MatOSRuntimeScopeWritableTreeOwner = {
  uid: number
  gid: number
}

export type MatOSWorkspaceOwnershipReport = {
  ok: boolean
  mode: 'audit' | 'repair'
  expectedOwner: MatOSRuntimeScopeWritableTreeOwner
  scannedEntries: number
  mismatchedEntries: number
  projectOutputMismatchedEntries?: number
  repairedEntries: number
  vanishedEntries: number
  samplePaths: string[]
  durationMs: number
  postRepairAudit?: {
    scannedEntries: number
    mismatchedEntries: number
    projectOutputMismatchedEntries?: number
    vanishedEntries: number
    samplePaths: string[]
    durationMs: number
  }
}

export type MatOSRuntimeScopeWritableRepairResult = {
  workspaceOwnership?: MatOSWorkspaceOwnershipReport
}

function sanitizeScopeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

type RepairWritableTreeFsOps = {
  lstat(path: string): Promise<Stats>
  lchown(path: string, uid: number, gid: number): Promise<void>
  chown(path: string, uid: number, gid: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  readdir(path: string): Promise<string[]>
}

type RepairOwnershipTreeFsOps = Pick<
  RepairWritableTreeFsOps,
  'lstat' | 'lchown' | 'chown' | 'readdir'
>

const defaultRepairWritableTreeFsOps: RepairWritableTreeFsOps = {
  lstat,
  lchown,
  chown,
  chmod,
  readdir,
}

const defaultRepairOwnershipTreeFsOps: RepairOwnershipTreeFsOps = {
  lstat,
  lchown,
  chown,
  readdir,
}

export async function repairWritableTree(
  path: string,
  owner?: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairWritableTreeFsOps = defaultRepairWritableTreeFsOps,
): Promise<void> {
  let stats: Stats
  try {
    stats = await fsOps.lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }

  if (owner) {
    if (stats.isSymbolicLink()) {
      try {
        await fsOps.lchown(path, owner.uid, owner.gid)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        throw error
      }
    } else {
      try {
        await fsOps.chown(path, owner.uid, owner.gid)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        throw error
      }
    }
  }

  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    try {
      await fsOps.chmod(path, 0o700)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    let entries
    try {
      entries = await fsOps.readdir(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    await Promise.all(
      entries.map(entry => repairWritableTree(join(path, entry), owner, fsOps)),
    )
    try {
      await fsOps.chmod(path, 0o700)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    return
  }

  if (!stats.isSymbolicLink()) {
    try {
      await fsOps.chmod(path, 0o600)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
  }
}

const OWNERSHIP_REPAIR_BATCH_SIZE = 64
const OWNERSHIP_REPORT_SAMPLE_LIMIT = 10
const OWNERSHIP_AUDIT_RECHECK_LIMIT = 10_000
const OWNERSHIP_AUDIT_RECHECK_DELAYS_MS = [25]
const SOURCE_CACHE_OWNERSHIP_AUDIT_RECHECK_DELAYS_MS = [
  25,
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
]

type OwnershipScanMode = MatOSWorkspaceOwnershipReport['mode']

type OwnershipScanEntry = {
  path: string
  displayPath: string
}

type OwnershipScanState = {
  mode: OwnershipScanMode
  scannedEntries: number
  mismatchedEntries: number
  projectOutputMismatchedEntries: number
  repairedEntries: number
  vanishedEntries: number
  samplePaths: string[]
  auditCandidates: OwnershipScanEntry[]
}

function recordOwnershipMismatch(
  state: OwnershipScanState,
  entry: OwnershipScanEntry,
): void {
  state.mismatchedEntries += 1
  if (entry.displayPath.startsWith('shared/projects/')) {
    state.projectOutputMismatchedEntries += 1
  }
  if (state.samplePaths.length < OWNERSHIP_REPORT_SAMPLE_LIMIT) {
    state.samplePaths.push(entry.displayPath)
  }
  if (
    state.mode === 'audit' &&
    state.auditCandidates.length < OWNERSHIP_AUDIT_RECHECK_LIMIT
  ) {
    state.auditCandidates.push(entry)
  }
}

function ownershipDisplayPath(parent: string, child: string): string {
  const safeChild = child.replace(/[\u0000-\u001f\u007f]/g, '?')
  const value = `${parent}/${safeChild}`
  return value.length > 512 ? `${value.slice(0, 509)}...` : value
}

async function scanOwnershipEntry(
  entry: OwnershipScanEntry,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  state: OwnershipScanState,
  fsOps: RepairOwnershipTreeFsOps,
): Promise<OwnershipScanEntry[]> {
  let stats: Stats
  try {
    stats = await fsOps.lstat(entry.path)
  } catch (error) {
    if (isMissingPathError(error)) {
      state.vanishedEntries += 1
      return []
    }
    throw error
  }

  state.scannedEntries += 1
  const mismatched = stats.uid !== owner.uid || stats.gid !== owner.gid
  if (stats.isSymbolicLink()) {
    if (!mismatched) {
      return []
    }
    if (state.mode === 'audit') {
      recordOwnershipMismatch(state, entry)
      return []
    }
    try {
      await fsOps.lchown(entry.path, owner.uid, owner.gid)
    } catch (error) {
      if (isMissingPathError(error)) {
        state.vanishedEntries += 1
        return []
      }
      throw error
    }
    recordOwnershipMismatch(state, entry)
    state.repairedEntries += 1
    return []
  }

  if (mismatched && state.mode === 'audit') {
    recordOwnershipMismatch(state, entry)
  } else if (mismatched) {
    try {
      await fsOps.chown(entry.path, owner.uid, owner.gid)
    } catch (error) {
      if (isMissingPathError(error)) {
        state.vanishedEntries += 1
        return []
      }
      throw error
    }
    recordOwnershipMismatch(state, entry)
    state.repairedEntries += 1
  }

  if (!stats.isDirectory()) {
    return []
  }

  try {
    return (await fsOps.readdir(entry.path)).map(child => ({
      path: join(entry.path, child),
      displayPath: ownershipDisplayPath(entry.displayPath, child),
    }))
  } catch (error) {
    if (isMissingPathError(error)) {
      state.vanishedEntries += 1
      return []
    }
    throw error
  }
}

async function scanOwnershipTree(
  root: OwnershipScanEntry,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  state: OwnershipScanState,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const batch = pending.splice(0, OWNERSHIP_REPAIR_BATCH_SIZE)
    const children = await Promise.all(
      batch.map(entry => scanOwnershipEntry(entry, owner, state, fsOps)),
    )
    pending.push(...children.flat())
  }
}

async function scanMatOSRuntimeOwnershipTree(
  path: string,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  mode: OwnershipScanMode,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<MatOSWorkspaceOwnershipReport> {
  const startedAt = Date.now()
  const state: OwnershipScanState = {
    mode,
    scannedEntries: 0,
    mismatchedEntries: 0,
    projectOutputMismatchedEntries: 0,
    repairedEntries: 0,
    vanishedEntries: 0,
    samplePaths: [],
    auditCandidates: [],
  }
  await scanOwnershipTree(
    { path: resolve(path), displayPath: 'project' },
    owner,
    state,
    fsOps,
  )
  await recheckAuditCandidates(state, owner, fsOps)
  return {
    ok:
      state.mismatchedEntries === 0 ||
      (mode === 'repair' &&
        state.repairedEntries === state.mismatchedEntries),
    mode,
    expectedOwner: owner,
    scannedEntries: state.scannedEntries,
    mismatchedEntries: state.mismatchedEntries,
    repairedEntries: state.repairedEntries,
    vanishedEntries: state.vanishedEntries,
    samplePaths: state.samplePaths,
    durationMs: Date.now() - startedAt,
  }
}

// Repair one already-authorized project tree without scanning the owner's
// whole workspace. This preserves file modes and never follows symlinks; it
// only aligns ownership with the container-mapped workspace user so a
// read-write bindfs grant is actually writable by every project member.
export async function repairMatOSRuntimeOwnershipTree(
  path: string,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<MatOSWorkspaceOwnershipReport> {
  const repair = await scanMatOSRuntimeOwnershipTree(
    path,
    owner,
    'repair',
    fsOps,
  )
  if (repair.mismatchedEntries === 0) {
    return repair
  }
  const verification = await scanMatOSRuntimeOwnershipTree(
    path,
    owner,
    'audit',
    fsOps,
  )
  return {
    ...repair,
    ok: verification.mismatchedEntries === 0,
    postRepairAudit: {
      scannedEntries: verification.scannedEntries,
      mismatchedEntries: verification.mismatchedEntries,
      vanishedEntries: verification.vanishedEntries,
      samplePaths: verification.samplePaths,
      durationMs: verification.durationMs,
    },
  }
}

function workspaceOwnershipRoots(
  scope: MatOSRuntimeScope,
): OwnershipScanEntry[] {
  const roots = [
    { path: resolve(scope.sharedWorkspaceDir), displayPath: 'shared' },
    { path: resolve(scope.workspacesDir), displayPath: 'workspaces' },
  ]
  return roots.filter(
    (entry, index) => roots.findIndex(item => item.path === entry.path) === index,
  )
}

async function recheckAuditCandidates(
  state: OwnershipScanState,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairOwnershipTreeFsOps,
): Promise<void> {
  if (
    state.mode !== 'audit' ||
    state.mismatchedEntries === 0 ||
    state.auditCandidates.length !== state.mismatchedEntries
  ) {
    return
  }

  const delays = state.auditCandidates.some(entry =>
    entry.displayPath.startsWith('shared/.matos/source-cache/git/'),
  )
    ? SOURCE_CACHE_OWNERSHIP_AUDIT_RECHECK_DELAYS_MS
    : OWNERSHIP_AUDIT_RECHECK_DELAYS_MS
  for (const delayMs of delays) {
    await delay(delayMs)
    const persistent: OwnershipScanEntry[] = []
    for (
      let index = 0;
      index < state.auditCandidates.length;
      index += OWNERSHIP_REPAIR_BATCH_SIZE
    ) {
      const batch = state.auditCandidates.slice(
        index,
        index + OWNERSHIP_REPAIR_BATCH_SIZE,
      )
      const results = await Promise.all(
        batch.map(async entry => {
          try {
            const stats = await fsOps.lstat(entry.path)
            return stats.uid !== owner.uid || stats.gid !== owner.gid
              ? entry
              : undefined
          } catch (error) {
            if (isMissingPathError(error)) {
              state.vanishedEntries += 1
              return undefined
            }
            throw error
          }
        }),
      )
      persistent.push(
        ...results.filter(
          (entry): entry is OwnershipScanEntry => Boolean(entry),
        ),
      )
    }
    state.mismatchedEntries = persistent.length
    state.projectOutputMismatchedEntries = persistent.filter(entry =>
      entry.displayPath.startsWith('shared/projects/'),
    ).length
    state.samplePaths = persistent
      .slice(0, OWNERSHIP_REPORT_SAMPLE_LIMIT)
      .map(entry => entry.displayPath)
    state.auditCandidates = persistent
    if (persistent.length === 0) {
      break
    }
  }
}

async function scanMatOSRuntimeScopeWorkspaceOwnership(
  scope: MatOSRuntimeScope,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  mode: OwnershipScanMode,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<MatOSWorkspaceOwnershipReport> {
  const startedAt = Date.now()
  const state: OwnershipScanState = {
    mode,
    scannedEntries: 0,
    mismatchedEntries: 0,
    projectOutputMismatchedEntries: 0,
    repairedEntries: 0,
    vanishedEntries: 0,
    samplePaths: [],
    auditCandidates: [],
  }
  await Promise.all(
    workspaceOwnershipRoots(scope).map(root =>
      scanOwnershipTree(root, owner, state, fsOps),
    ),
  )
  await recheckAuditCandidates(state, owner, fsOps)
  return {
    ok:
      state.mismatchedEntries === 0 ||
      (mode === 'repair' &&
        state.repairedEntries === state.mismatchedEntries),
    mode,
    expectedOwner: owner,
    scannedEntries: state.scannedEntries,
    mismatchedEntries: state.mismatchedEntries,
    projectOutputMismatchedEntries: state.projectOutputMismatchedEntries,
    repairedEntries: state.repairedEntries,
    vanishedEntries: state.vanishedEntries,
    samplePaths: state.samplePaths,
    durationMs: Date.now() - startedAt,
  }
}

export async function auditMatOSRuntimeScopeWorkspaceOwnership(
  scope: MatOSRuntimeScope,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<MatOSWorkspaceOwnershipReport> {
  return scanMatOSRuntimeScopeWorkspaceOwnership(scope, owner, 'audit', fsOps)
}

export async function repairMatOSRuntimeScopeWorkspaceOwnership(
  scope: MatOSRuntimeScope,
  owner: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairOwnershipTreeFsOps = defaultRepairOwnershipTreeFsOps,
): Promise<MatOSWorkspaceOwnershipReport> {
  const repair = await scanMatOSRuntimeScopeWorkspaceOwnership(
    scope,
    owner,
    'repair',
    fsOps,
  )
  if (repair.mismatchedEntries === 0) {
    return repair
  }

  const verification = await scanMatOSRuntimeScopeWorkspaceOwnership(
    scope,
    owner,
    'audit',
    fsOps,
  )
  const report: MatOSWorkspaceOwnershipReport = {
    ...repair,
    ok: verification.mismatchedEntries === 0,
    postRepairAudit: {
      scannedEntries: verification.scannedEntries,
      mismatchedEntries: verification.mismatchedEntries,
      projectOutputMismatchedEntries:
        verification.projectOutputMismatchedEntries,
      vanishedEntries: verification.vanishedEntries,
      samplePaths: verification.samplePaths,
      durationMs: verification.durationMs,
    },
  }
  if (report.mismatchedEntries > 0) {
    console.warn(
      `[matos] workspace ownership repaired scope=${scope.ref} ` +
        `owner=${owner.uid}:${owner.gid} scanned=${report.scannedEntries} ` +
        `mismatched=${report.mismatchedEntries} repaired=${report.repairedEntries} ` +
        `remaining=${report.postRepairAudit?.mismatchedEntries ?? 0} ` +
        `durationMs=${report.durationMs}`,
    )
  }
  return report
}

async function repairReadableWritableTree(
  path: string,
  owner?: MatOSRuntimeScopeWritableTreeOwner,
  fsOps: RepairWritableTreeFsOps = defaultRepairWritableTreeFsOps,
): Promise<void> {
  let stats: Stats
  try {
    stats = await fsOps.lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }

  if (owner) {
    if (stats.isSymbolicLink()) {
      try {
        await fsOps.lchown(path, owner.uid, owner.gid)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        throw error
      }
    } else {
      try {
        await fsOps.chown(path, owner.uid, owner.gid)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        throw error
      }
    }
  }

  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    try {
      await fsOps.chmod(path, 0o755)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    let entries
    try {
      entries = await fsOps.readdir(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    await Promise.all(
      entries.map(entry =>
        repairReadableWritableTree(join(path, entry), owner, fsOps),
      ),
    )
    try {
      await fsOps.chmod(path, 0o755)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    return
  }

  if (!stats.isSymbolicLink()) {
    try {
      await fsOps.chmod(path, 0o644)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
  }
}

async function repairSourceCacheGitMetadataTree(
  path: string,
  fsOps: RepairWritableTreeFsOps = defaultRepairWritableTreeFsOps,
): Promise<void> {
  let stats: Stats
  try {
    stats = await fsOps.lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }

  if (stats.isSymbolicLink()) {
    return
  }

  if (stats.isDirectory()) {
    try {
      await fsOps.chmod(path, 0o777)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    let entries
    try {
      entries = await fsOps.readdir(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    await Promise.all(
      entries.map(entry =>
        repairSourceCacheGitMetadataTree(join(path, entry), fsOps),
      ),
    )
    try {
      await fsOps.chmod(path, 0o777)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    return
  }

  try {
    await fsOps.chmod(path, 0o666)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }
}

async function repairSourceCacheGitMetadata(
  sourceCacheDir: string,
  fsOps: RepairWritableTreeFsOps = defaultRepairWritableTreeFsOps,
): Promise<void> {
  let entries
  try {
    entries = await fsOps.readdir(sourceCacheDir)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }

  await Promise.all(
    entries.map(async entry => {
      const path = join(sourceCacheDir, entry)
      let stats: Stats
      try {
        stats = await fsOps.lstat(path)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        throw error
      }
      if (stats.isSymbolicLink()) {
        return
      }
      if (entry === '.git' || entry === '.locks') {
        await repairSourceCacheGitMetadataTree(path, fsOps)
        return
      }
      if (stats.isDirectory()) {
        await repairSourceCacheGitMetadata(path, fsOps)
      }
    }),
  )
}

function enforceWorkspaceOwnershipConvergence(
  scopeRef: string,
  report: MatOSWorkspaceOwnershipReport | undefined,
  required: boolean,
): void {
  if (!report || report.ok) {
    return
  }
  const remaining = report.postRepairAudit?.mismatchedEntries ?? 'unknown'
  if (required) {
    const error = new Error(
      `Workspace ownership repair did not converge for ${scopeRef}: ` +
        `${remaining} entries remain mismatched.`,
    ) as Error & { code?: string }
    error.code = 'WORKSPACE_OWNERSHIP_REPAIR_INCOMPLETE'
    throw error
  }
  console.warn(
    `[matos] workspace ownership remains non-converged for ${scopeRef}; ` +
      `${remaining} entries remain mismatched after repair. ` +
      'Continuing workspace startup; runtime doctor will retain the ownership finding.',
  )
}

export const __scopeTestHooks = {
  repairWritableTree,
  repairMatOSRuntimeOwnershipTree,
  auditMatOSRuntimeScopeWorkspaceOwnership,
  repairMatOSRuntimeScopeWorkspaceOwnership,
  repairReadableWritableTree,
  repairSourceCacheGitMetadata,
  enforceWorkspaceOwnershipConvergence,
}

function resolveEnvPath(cwd: string, value: string | undefined): string | undefined {
  return value ? resolve(cwd, value) : undefined
}

function isWithinOrEqual(path: string, root: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

export async function repairMatOSRuntimeScopeWritableTrees(
  scope: MatOSRuntimeScope,
  owner?: MatOSRuntimeScopeWritableTreeOwner,
  options: {
    repairWorkspaceOwnership?: boolean
    requireWorkspaceOwnershipConvergence?: boolean
  } = {},
): Promise<MatOSRuntimeScopeWritableRepairResult> {
  const matOSWorkspaceDir = join(scope.sharedWorkspaceDir, '.matos')
  const sourceCacheDir = join(matOSWorkspaceDir, 'source-cache')
  await Promise.all([
    repairWritableTree(scope.homeDir, owner),
    repairWritableTree(matOSWorkspaceDir, owner),
  ])
  const workspaceOwnership = owner && options.repairWorkspaceOwnership
    ? await repairMatOSRuntimeScopeWorkspaceOwnership(scope, owner)
    : undefined
  enforceWorkspaceOwnershipConvergence(
    scope.ref,
    workspaceOwnership,
    options.requireWorkspaceOwnershipConvergence !== false,
  )
  await repairReadableWritableTree(sourceCacheDir, owner)
  await repairSourceCacheGitMetadata(sourceCacheDir)
  return workspaceOwnership ? { workspaceOwnership } : {}
}

export function resolveMatOSRuntimeScope(
  cwd: string,
  options: { scopeRef?: string; runtimeDataDir?: string; env?: MatOSEnv } = {},
): MatOSRuntimeScope {
  const env = options.env ?? process.env
  const requestedRef = options.scopeRef ?? 'user:local'
  if (env.MATOS_STANDALONE === '1' && requestedRef !== 'user:local' && !requestedRef.startsWith('project:')) {
    throw new Error('The single-user edition has one runtime identity: user:local')
  }
  // A standalone installation has one user runtime. Project scopes still
  // identify assets and traces; they do not create provider/runtime identities.
  const ref = env.MATOS_STANDALONE === '1' && /^project:/.test(requestedRef)
    ? 'user:local' : requestedRef
  const [kind, rawId] = ref.includes(':') ? ref.split(':', 2) : ['user', ref]
  if (kind !== 'user') {
    throw new Error(`Unsupported MatOS runtime scope kind: ${kind}`)
  }

  const id = sanitizeScopeId(rawId || 'local') || 'local'
  const configuredRuntimeDataDir = envValue(env, 'MATOS_RUNTIME_DATA_DIR')
  const internalStateDir = resolveEnvPath(
    cwd,
    envValue(env, 'MATOS_INTERNAL_STATE_DIR'),
  )
  const runtimeDataDir = options.runtimeDataDir
    ? resolve(cwd, options.runtimeDataDir)
    : configuredRuntimeDataDir
      ? resolve(cwd, configuredRuntimeDataDir)
      : internalStateDir
        ? join(internalStateDir, 'runtime')
        : join(getMatOSDir(cwd), 'runtime')
  const rootDir = join(runtimeDataDir, 'scopes', 'users', id)
  const configuredWorkspaceDir = resolveEnvPath(
    cwd,
    envValue(env, 'MATOS_WORKSPACE_DIR'),
  )
  const configuredWorkflowRunsDir = resolveEnvPath(
    cwd,
    envValue(env, 'MATOS_WORKFLOW_RUNS_DIR'),
  )
  const configuredSessionsDir = resolveEnvPath(
    cwd,
    envValue(env, 'MATOS_SESSION_DIR'),
  )
  const configuredCachesDir = resolveEnvPath(
    cwd,
    envValue(env, 'MATOS_CACHE_DIR'),
  )
  const useContainerVisibleEnv = Boolean(
    internalStateDir ||
      configuredWorkspaceDir ||
      configuredWorkflowRunsDir ||
      configuredSessionsDir ||
      configuredCachesDir,
  )
  const configuredTmpEnvValue =
    envValue(env, 'MATOS_TMP_DIR') ??
    (useContainerVisibleEnv
      ? envValue(env, 'TMPDIR') ??
        envValue(env, 'TMP') ??
        envValue(env, 'TEMP')
      : undefined)
  const configuredTmpDir = resolveEnvPath(
    cwd,
    configuredTmpEnvValue,
  )
  const configuredAgentHomeDir = envValue(env, 'MATOS_AGENT_HOME')
  const configuredHomeDir =
    resolveEnvPath(cwd, configuredAgentHomeDir) ??
    (configuredWorkspaceDir && envValue(env, 'HOME')
      ? join(resolve(cwd, envValue(env, 'HOME')!), '.matos')
      : undefined)
  const workspaceDir = configuredWorkspaceDir
    ? dirname(configuredWorkspaceDir)
    : join(rootDir, 'workspace-state')
  const sharedWorkspaceDir = configuredWorkspaceDir ?? join(workspaceDir, 'shared')
  const workflowsDir = configuredWorkflowRunsDir
    ? dirname(configuredWorkflowRunsDir)
    : join(rootDir, 'workflows')
  const cachesDir = configuredCachesDir ?? join(rootDir, 'workspace-cache')
  const homeStateDir = join(rootDir, 'home-state')

  return {
    ref: `user:${id}`,
    kind,
    id,
    rootDir,
    homeDir: configuredHomeDir ?? join(rootDir, 'home'),
    workspaceDir,
    sharedWorkspaceDir,
    workspacesDir: join(workspaceDir, 'workspaces'),
    logsDir: join(workspaceDir, 'logs'),
    assetsDir: join(rootDir, 'assets'),
    sessionsDir: configuredSessionsDir ?? join(rootDir, 'sessions'),
    workflowsDir,
    workflowRunsDir: configuredWorkflowRunsDir ?? join(workflowsDir, 'runs'),
    cachesDir,
    tmpDir: configuredTmpDir ?? join(rootDir, 'tmp'),
    homeCacheDir: join(homeStateDir, 'cache'),
    homeLocalDir: join(homeStateDir, 'local'),
    homeBunDir: join(homeStateDir, 'bun'),
    homeNpmDir: join(homeStateDir, 'npm'),
    ipcDir: join(rootDir, 'ipc'),
    containerStateDir: join(rootDir, 'containers'),
  }
}

export async function materializeMatOSRuntimeScope(
  scope: MatOSRuntimeScope,
): Promise<void> {
  const cachedAgentTmpDir = join(scope.cachesDir, 'agent-tmp')
  const cacheScratchDirs = [
    join(scope.cachesDir, 'tmp'),
    ...(isWithinOrEqual(scope.tmpDir, cachedAgentTmpDir)
      ? [cachedAgentTmpDir]
      : []),
  ]
  const dirs = [
    scope.rootDir,
    scope.homeDir,
    scope.workspaceDir,
    scope.sharedWorkspaceDir,
    scope.workspacesDir,
    scope.logsDir,
    scope.assetsDir,
    join(scope.assetsDir, 'private'),
    join(scope.assetsDir, 'generated'),
    join(scope.assetsDir, 'installed'),
    scope.sessionsDir,
    scope.workflowsDir,
    join(scope.workflowsDir, 'drafts'),
    scope.workflowRunsDir,
    scope.cachesDir,
    ...cacheScratchDirs,
    scope.tmpDir,
    scope.homeCacheDir,
    scope.homeLocalDir,
    scope.homeBunDir,
    scope.homeNpmDir,
    scope.ipcDir,
    scope.containerStateDir,
  ]

  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })))
  await Promise.all(
    dirs
      .filter(dir => isWithinOrEqual(dir, scope.rootDir))
      .map(dir => chmod(dir, 0o700)),
  )
}
