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

import { lstat,readFile,writeFile } from 'node:fs/promises'
import { join,relative,resolve,sep } from 'node:path'
import {
createMatOSAssetHistorySnapshot,
restoreMatOSAssetHistorySnapshot,
withMatOSAssetHistoryLock,
} from '../assets/history/index.js'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/types.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import {
MATOS_ASSET_MOUNT_GROUPS,
type MatOSAsset,
type MatOSAssetMountGroup,
} from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { buildLegacyRoleDraftPatch } from './roleDraftPayload.js'
import { showMatOSWorkbenchRole } from './roles.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchRoleDraftApplyResult,
MatOSWorkbenchRoleDraftIssue,
MatOSWorkbenchRoleDraftPreview,
} from './types.js'
import {
asArray,
firstString,
isRecord,
optionalString as stringValue,
} from './workbenchValues.js'
import { previewMatOSWorkbenchWriteTransaction } from './writeTransactions.js'

function changedFieldCount(patch: MatOSWorkbenchRoleDraftPreview['patch']): number {
  let count = 0
  for (const value of Object.values(patch.asset ?? {})) {
    if (value !== undefined) {
      count += 1
    }
  }
  for (const value of Object.values(patch.selectedAgent ?? {})) {
    if (value !== undefined) {
      count += 1
    }
  }
  count += Object.values(patch.mounts).reduce((total, refs) => total + Math.max(1, refs.length), 0)
  if (patch.workflowMounts !== undefined) {
    count += Math.max(1, patch.workflowMounts.length)
  }
  return count
}

function sameDraftValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null)
}

function roleDraftPreviewValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => String(item)).join(', ')}]`
  }
  if (value === undefined || value === null || value === '') {
    return '(empty)'
  }
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function beforeMountRefs(
  before: MatOSWorkbenchRoleDraftPreview['before'] | undefined,
  group: string,
): string[] {
  return asArray(before?.detail?.attachmentGroups?.[group])
    .map(item => isRecord(item) ? firstString(item.resolvedRef, item.ref) : undefined)
    .filter((item): item is string => Boolean(item))
    .sort()
}

function buildRoleDraftDiff(input: {
  before?: MatOSWorkbenchRoleDraftPreview['before']
  patch: MatOSWorkbenchRoleDraftPreview['patch']
}): NonNullable<MatOSWorkbenchRoleDraftPreview['diff']> | undefined {
  const changes: NonNullable<MatOSWorkbenchRoleDraftPreview['diff']>['fieldChanges'] = []
  const add = (change: Omit<NonNullable<MatOSWorkbenchRoleDraftPreview['diff']>['fieldChanges'][number], 'changed'>): void => {
    changes.push({
      ...change,
      changed: !sameDraftValue(change.before, change.after),
    })
  }
  if (input.patch.asset?.name !== undefined) {
    add({
      path: 'asset.name',
      label: 'Role name',
      kind: 'asset',
      before: input.before?.resource.name,
      after: input.patch.asset.name,
    })
  }
  if (input.patch.asset?.description !== undefined) {
    add({
      path: 'asset.description',
      label: 'Role description',
      kind: 'asset',
      before: input.before?.resource.description,
      after: input.patch.asset.description,
    })
  }
  if (input.patch.selectedAgent?.prompt !== undefined) {
    add({
      path: 'selectedAgent.prompt',
      label: 'Agent prompt',
      kind: 'selected-agent',
      before: input.before?.detail?.selectedAgent?.prompt,
      after: input.patch.selectedAgent.prompt,
    })
  }
  if (input.patch.selectedAgent?.model !== undefined) {
    add({
      path: 'selectedAgent.model',
      label: 'Model',
      kind: 'selected-agent',
      before: input.before?.detail?.selectedAgent?.model,
      after: input.patch.selectedAgent.model,
    })
  }
  if (input.patch.selectedAgent?.permissionMode !== undefined) {
    add({
      path: 'selectedAgent.permissionMode',
      label: 'Permission mode',
      kind: 'selected-agent',
      before: input.before?.detail?.selectedAgent?.permissionMode,
      after: input.patch.selectedAgent.permissionMode,
    })
  }
  for (const [group, refs] of Object.entries(input.patch.mounts)) {
    add({
      path: `mounts.${group}`,
      label: `${group} attachments`,
      kind: 'mounts',
      before: beforeMountRefs(input.before, group),
      after: [...refs].sort(),
    })
  }
  if (input.patch.workflowMounts !== undefined) {
    add({
      path: 'metadata.workflowMounts',
      label: 'Workflow runtime mounts',
      kind: 'mounts',
      before: input.before?.resource.metadata?.workflowMounts,
      after: input.patch.workflowMounts,
    })
  }
  if (!changes.length) {
    return undefined
  }
  const changed = changes.filter(change => change.changed)
  return {
    source: 'matos-role-draft',
    fieldChanges: changes,
    promptChanged: changes.some(change => change.path === 'selectedAgent.prompt' && change.changed),
    attachmentChangeCount: changed.filter(change => change.kind === 'mounts').length,
    preview: changed.slice(0, 8).map(change =>
      `${change.label}: ${roleDraftPreviewValue(change.before)} -> ${roleDraftPreviewValue(change.after)}`,
    ),
  }
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

function workspaceRelative(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path)).replace(/\\/g, '/')
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Role draft write path is outside the MatOS workspace: ${path}`)
  }
  return rel
}

async function assertWritableFilePath(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (info?.isSymbolicLink()) {
    throw new Error(`Refusing to write role draft through symlink path: ${path}`)
  }
}

function assertProjectRoleWriteTarget(cwd: string, asset: MatOSAsset): void {
  if (asset.source !== 'project') {
    throw new Error(
      `Role draft writes are only enabled for project-local role assets; ${asset.canonicalKey} comes from ${asset.source}.`,
    )
  }
  const projectAssetRoot = join(resolve(cwd), '.matos', 'assets')
  if (!isWithin(asset.manifestPath, projectAssetRoot)) {
    throw new Error(
      `Role draft writes are only enabled below .matos/assets; refusing ${workspaceRelative(cwd, asset.manifestPath)}.`,
    )
  }
}

function snapshotSummary(
  snapshot: NonNullable<MatOSWorkbenchRoleDraftApplyResult['snapshots']['after']>,
) {
  return {
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    files: snapshot.files,
    assetRefs: snapshot.assetRefs,
  }
}

async function resolveRoleAsset(input: MatOSWorkbenchContext & { ref: string }): Promise<MatOSAsset> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const asset = registry.resolve(input.ref)
  if (!asset || asset.type !== 'role') {
    throw new Error(`MatOS role asset not found: ${input.ref}`)
  }
  return asset
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function collectAssetRefs(asset: MatOSAsset): string[] {
  const refs = new Set<string>()
  for (const ref of asset.dependencies) {
    refs.add(ref)
  }
  for (const refsForGroup of Object.values(asset.mounts)) {
    for (const ref of refsForGroup ?? []) {
      refs.add(ref)
    }
  }
  if (typeof asset.runtime.profile === 'string' && asset.runtime.profile.trim()) {
    refs.add(asset.runtime.profile.trim())
  }
  return [...refs].sort()
}

async function validateRoleDraftCurrentGraph(input: {
  cwd: string
  roleRef: string
}): Promise<MatOSAssetHistoryValidationResult> {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets)
  const root = registry.resolve(input.roleRef)
  if (!root || root.type !== 'role') {
    throw new Error(`MatOS role asset not found after role draft write: ${input.roleRef}`)
  }
  const selected = new Map<string, MatOSAsset>()
  const visit = (asset: MatOSAsset): void => {
    if (selected.has(asset.canonicalKey)) {
      return
    }
    selected.set(asset.canonicalKey, asset)
    for (const ref of collectAssetRefs(asset)) {
      const resolved = registry.resolve(ref)
      if (resolved) {
        visit(resolved)
      }
    }
  }
  visit(root)
  const assetValidation = await validateMatOSAssets([...selected.values()])
  return {
    ok: assetValidation.ok,
    gateProfile: 'smoke',
    assetValidation: {
      ok: assetValidation.ok,
      errors: assetValidation.errors,
    },
    secretScan: {
      ok: true,
      findings: [],
    },
    workflowValidation: [],
  }
}

function roleDraftTouchedPaths(input: {
  cwd: string
  asset: MatOSAsset
  patch: MatOSWorkbenchRoleDraftPreview['patch']
}): string[] {
  const paths = [workspaceRelative(input.cwd, input.asset.manifestPath)]
  if (input.patch.selectedAgent?.prompt !== undefined) {
    if (!input.asset.entryAbsolutePath) {
      throw new Error(`Role ${input.asset.canonicalKey} has no entry file for prompt edits.`)
    }
    if (!isWithin(input.asset.entryAbsolutePath, input.asset.manifestDir)) {
      throw new Error(
        `Role prompt entry is outside the asset directory: ${workspaceRelative(
          input.cwd,
          input.asset.entryAbsolutePath,
        )}`,
      )
    }
    paths.push(workspaceRelative(input.cwd, input.asset.entryAbsolutePath))
  }
  return [...new Set(paths)].sort()
}

async function writeRoleDraftPatch(input: {
  asset: MatOSAsset
  patch: MatOSWorkbenchRoleDraftPreview['patch']
}): Promise<void> {
  await assertWritableFilePath(input.asset.manifestPath)
  const manifest = mutableRecord(JSON.parse(await readFile(input.asset.manifestPath, 'utf8')))
  if (input.patch.asset?.name !== undefined) {
    manifest.name = input.patch.asset.name
  }
  if (input.patch.asset?.description !== undefined) {
    manifest.description = input.patch.asset.description
  }
  if (
    input.patch.selectedAgent?.model !== undefined ||
    input.patch.selectedAgent?.permissionMode !== undefined
  ) {
    const runtime = mutableRecord(manifest.runtime)
    if (input.patch.selectedAgent.model !== undefined) {
      runtime.model = input.patch.selectedAgent.model
    }
    if (input.patch.selectedAgent.permissionMode !== undefined) {
      runtime.permissionMode = input.patch.selectedAgent.permissionMode
    }
    manifest.runtime = runtime
  }
  const mountGroups = Object.keys(input.patch.mounts).filter(group =>
    (MATOS_ASSET_MOUNT_GROUPS as readonly string[]).includes(group),
  ) as MatOSAssetMountGroup[]
  if (mountGroups.length > 0) {
    const previousMountRefs = new Set<string>()
    for (const refs of Object.values(mutableRecord(manifest.mounts))) {
      for (const ref of asArray(refs)) {
        const normalized = stringValue(ref)
        if (normalized) {
          previousMountRefs.add(normalized)
        }
      }
    }
    const mounts = mutableRecord(manifest.mounts)
    for (const group of mountGroups) {
      mounts[group] = [...input.patch.mounts[group]]
    }
    manifest.mounts = mounts
    const dependencyRefs = new Set<string>()
    for (const ref of asArray(manifest.dependencies)) {
      const normalized = stringValue(ref)
      if (normalized && !previousMountRefs.has(normalized)) {
        dependencyRefs.add(normalized)
      }
    }
    for (const refs of Object.values(mounts)) {
      for (const ref of asArray(refs)) {
        const normalized = stringValue(ref)
        if (normalized) {
          dependencyRefs.add(normalized)
        }
      }
    }
    manifest.dependencies = [...dependencyRefs].sort()
  }
  if (input.patch.workflowMounts !== undefined) {
    const metadata = mutableRecord(manifest.metadata)
    metadata.workflowMounts = input.patch.workflowMounts
    manifest.metadata = metadata
  }
  await writeFile(input.asset.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  if (input.patch.selectedAgent?.prompt !== undefined) {
    if (!input.asset.entryAbsolutePath) {
      throw new Error(`Role ${input.asset.canonicalKey} has no entry file for prompt edits.`)
    }
    await assertWritableFilePath(input.asset.entryAbsolutePath)
    await writeFile(
      input.asset.entryAbsolutePath,
      `${input.patch.selectedAgent.prompt.trimEnd()}\n`,
      'utf8',
    )
  }
}

export async function previewMatOSWorkbenchRoleDraft(
  input: MatOSWorkbenchContext & {
    ref?: string
    mutation?: string
    request?: unknown
  },
): Promise<MatOSWorkbenchRoleDraftPreview> {
  const request = isRecord(input.request) ? input.request : {}
  const issues: MatOSWorkbenchRoleDraftIssue[] = []
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const roleRef = input.ref
  const before = roleRef
    ? await showMatOSWorkbenchRole({
        ...input,
        ref: roleRef,
        includeComposition: true,
      }).catch(() => undefined)
    : undefined
  const patch = buildLegacyRoleDraftPatch({ request, before })
  if (patch.selectedAgent?.prompt !== undefined && !patch.selectedAgent.prompt.trim()) {
    issues.push({
      severity: 'error',
      code: 'empty_prompt',
      message: 'Role prompt cannot be empty.',
      path: 'prompt_info.prompt',
    })
  }
  const attachmentRefs = Object.values(patch.mounts).flat()
  for (const ref of attachmentRefs) {
    if (!registry.resolve(ref)) {
      issues.push({
        severity: 'warning',
        code: 'missing_attachment',
        message: `Attached MatOS asset is not currently resolvable: ${ref}`,
        ref,
      })
    }
  }
  if (changedFieldCount(patch) === 0) {
    issues.push({
      severity: 'warning',
      code: 'empty_role_patch',
      message: 'No MatOS role fields were detected in the Coze Agent IDE mutation payload.',
    })
  }
  const validationErrors = issues.filter(issue => issue.severity === 'error')
  const warningCount = issues.filter(issue => issue.severity === 'warning').length
  const missingAttachmentCount = issues.filter(issue => issue.code === 'missing_attachment').length
  const summary = {
    changedFieldCount: changedFieldCount(patch),
    attachmentCount: attachmentRefs.length,
    missingAttachmentCount,
    warningCount,
    errorCount: validationErrors.length,
  }
  const diff = buildRoleDraftDiff({ before, patch })
  const transaction = previewMatOSWorkbenchWriteTransaction({
    source: 'coze-agent-ide',
    requestedMutation: input.mutation ?? 'preview',
    ...(roleRef ? { targetRef: roleRef } : {}),
    targetType: 'role',
    scopeRef: input.scopeRef,
    patch,
    validationOk: validationErrors.length === 0,
    errorCount: validationErrors.length,
    warningCount,
    validationEvidence: {
      issues,
      summary,
      diff,
    },
    deterministicSmoke: {
      ok: validationErrors.length === 0,
      summary:
        validationErrors.length === 0
          ? `Role draft parsed ${summary.changedFieldCount} changed field(s) and ${summary.attachmentCount} attachment ref(s).`
          : 'Role draft has validation errors; persistent write must remain blocked.',
      evidence: {
        attachmentRefs,
      },
    },
  })
  return {
    ...(roleRef ? { roleRef } : {}),
    mutation: input.mutation ?? 'preview',
    source: 'coze-agent-ide',
    mode: 'draft-preview',
    patch,
    ...(diff ? { diff } : {}),
    validation: {
      ok: validationErrors.length === 0,
      errors: validationErrors,
    },
    issues,
    summary,
    write: {
      enabled: false,
      reason:
        validationErrors.length === 0
          ? 'Coze Agent IDE role mutation preview is ready for an explicit MatOS apply request with the current confirmation fingerprint.'
          : 'Coze Agent IDE role mutation apply is blocked until role draft validation errors are fixed.',
      nextAction: {
        key: validationErrors.length === 0 ? 'validate' : 'edit',
        label: validationErrors.length === 0 ? 'Validate role draft' : 'Fix role draft',
        enabled: true,
        maturity: 'route-only',
        command: {
          argv: roleRef
            ? ['matos', 'workbench', 'roles', 'show', roleRef, '--json']
            : ['matos', 'workbench', 'roles', 'draft', '--json'],
          command: roleRef
            ? `matos workbench roles show ${roleRef} --json`
            : 'matos workbench roles draft --json',
        },
      },
    },
    transaction,
    ...(before ? { before } : {}),
    raw: { request },
  }
}

export async function applyMatOSWorkbenchRoleDraft(
  input: MatOSWorkbenchContext & {
    ref: string
    mutation?: string
    request?: unknown
    fingerprint: string
    reason?: string
  },
): Promise<MatOSWorkbenchRoleDraftApplyResult> {
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'workbench-roles-apply-draft',
  }, async () => {
    const draft = await previewMatOSWorkbenchRoleDraft({
      ...input,
      mutation: input.mutation ?? 'apply-draft',
    })
    if (!draft.roleRef) {
      throw new Error('Role draft apply requires a resolved MatOS role ref.')
    }
    if (!draft.validation.ok) {
      throw new Error('Role draft apply is blocked because draft validation failed.')
    }
    if (draft.summary.changedFieldCount <= 0) {
      throw new Error('Role draft apply is blocked because the Coze mutation produced no writable role changes.')
    }
    if (input.fingerprint !== draft.transaction.confirmationFingerprint) {
      throw new Error(
        'Role draft apply confirmation fingerprint does not match the current MatOS draft transaction.',
      )
    }

    const asset = await resolveRoleAsset({ ...input, ref: draft.roleRef })
    assertProjectRoleWriteTarget(input.cwd, asset)
    const touchedPaths = roleDraftTouchedPaths({
      cwd: input.cwd,
      asset,
      patch: draft.patch,
    })
    const beforeSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      message: `workbench role draft before ${draft.roleRef}`,
      paths: touchedPaths,
      assetRefs: [draft.roleRef],
      provenance: {
        source: 'matos-workbench',
        operation: 'roles.apply-draft',
        mutation: draft.mutation,
        confirmationFingerprint: draft.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })

    await writeRoleDraftPatch({
      asset,
      patch: draft.patch,
    })

    const afterSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      parentCommit: beforeSnapshot.commit,
      message: `workbench role draft after ${draft.roleRef}`,
      paths: touchedPaths,
      assetRefs: [draft.roleRef],
      provenance: {
        source: 'matos-workbench',
        operation: 'roles.apply-draft',
        mutation: draft.mutation,
        beforeSnapshot: beforeSnapshot.snapshotId,
        confirmationFingerprint: draft.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })
    const validation = await validateRoleDraftCurrentGraph({
      cwd: input.cwd,
      roleRef: draft.roleRef,
    })
    if (!validation.ok) {
      await restoreMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: beforeSnapshot.snapshotId,
        compareSnapshotId: afterSnapshot.snapshotId,
        removeCreatedFiles: true,
      })
      const rollbackSnapshot = await createMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        kind: 'direct-editor-rollback',
        scope: 'project',
        parentCommit: afterSnapshot.commit,
        message: `workbench role draft rollback ${draft.roleRef}`,
        paths: touchedPaths,
        assetRefs: [draft.roleRef],
        provenance: {
          source: 'matos-workbench',
          operation: 'roles.apply-draft.rollback',
          beforeSnapshot: beforeSnapshot.snapshotId,
          afterSnapshot: afterSnapshot.snapshotId,
          confirmationFingerprint: draft.transaction.confirmationFingerprint,
          reason: 'post-write validation failed',
        },
      })
      return {
        roleRef: draft.roleRef,
        mutation: draft.mutation,
        source: 'coze-agent-ide',
        mode: 'controlled-write',
        applied: false,
        readonly: false,
        draft,
        transaction: draft.transaction,
        before: draft.before ?? (await showMatOSWorkbenchRole({
          ...input,
          ref: draft.roleRef,
          includeComposition: true,
        })),
        snapshots: {
          before: snapshotSummary(beforeSnapshot),
          after: snapshotSummary(afterSnapshot),
          rollback: snapshotSummary(rollbackSnapshot),
        },
        validation,
        write: {
          enabled: true,
          status: 'rolled-back',
          reason: 'Post-write validation failed; MatOS restored the before snapshot.',
        },
        audit: {
          target: 'matos-asset-history',
          operation: 'roles.apply-draft',
          reason: input.reason,
        },
      }
    }

    const after = await showMatOSWorkbenchRole({
      ...input,
      ref: draft.roleRef,
      includeComposition: true,
    })
    return {
      roleRef: draft.roleRef,
      mutation: draft.mutation,
      source: 'coze-agent-ide',
      mode: 'controlled-write',
      applied: true,
      readonly: false,
      draft,
      transaction: draft.transaction,
      before: draft.before ?? after,
      after,
      snapshots: {
        before: snapshotSummary(beforeSnapshot),
        after: snapshotSummary(afterSnapshot),
      },
      validation,
      write: {
        enabled: true,
        status: 'applied',
      },
      audit: {
        target: 'matos-asset-history',
        operation: 'roles.apply-draft',
        reason: input.reason,
      },
    }
  })
}
