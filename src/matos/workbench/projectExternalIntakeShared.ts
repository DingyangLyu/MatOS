import { lstat } from 'node:fs/promises'
import { join,relative,resolve,sep } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchExternalIntakeImportApplyResult,
MatOSWorkbenchExternalIntakeImportPreview,
MatOSWorkbenchExternalIntakeItem,
MatOSWorkbenchResource,
MatOSWorkbenchResourceType,
MatOSWorkbenchSearchRanking
} from './types.js'

import { isSharedGlobalMarketplaceResource } from './projectMarketplaceShared.js'
import { recordValue,searchRankingForFields,stringValue } from './projectSearchUtils.js'
export function externalMetadata(resource: MatOSWorkbenchResource): Record<string, unknown> {
  return recordValue(recordValue(resource.metadata).external)
}

export function externalRepository(resource: MatOSWorkbenchResource): string | undefined {
  const metadata = externalMetadata(resource)
  return stringValue(metadata.repository) ?? stringValue(metadata.repositoryUrl)
}

export function externalSourceUrl(resource: MatOSWorkbenchResource): string | undefined {
  const metadata = externalMetadata(resource)
  return stringValue(metadata.sourceUrl) ??
    stringValue(metadata.url) ??
    stringValue(metadata.homepage) ??
    externalRepository(resource)
}

export function externalKind(resource: MatOSWorkbenchResource): string {
  const metadata = externalMetadata(resource)
  return stringValue(metadata.kind) ??
    stringValue(metadata.classification) ??
    stringValue(metadata.category) ??
    stringValue(recordValue(resource.metadata).originalType) ??
    'external-resource'
}

export function isExternalIntakeResource(resource: MatOSWorkbenchResource): boolean {
  const originalType = stringValue(recordValue(resource.metadata).originalType)
  const tags = new Set((resource.tags ?? []).map(tag => tag.toLowerCase()))
  return resource.ref.startsWith('external-') ||
    originalType?.startsWith('external-') === true ||
    tags.has('external-ref') ||
    Boolean(externalRepository(resource) || externalSourceUrl(resource))
}

export function externalApproval(resource: MatOSWorkbenchResource): MatOSWorkbenchExternalIntakeItem['approval'] {
  const metadata = externalMetadata(resource)
  const rawApproval = metadata.approval
  const approvalRecord = recordValue(rawApproval)
  const rawState = stringValue(approvalRecord.state) ??
    stringValue(rawApproval) ??
    (metadata.approved === true ? 'approved' : undefined)
  const state = rawState === 'approved' || rawState === 'registered' || rawState === 'draft'
    ? rawState
    : resource.lifecycle === 'draft'
      ? 'draft'
      : resource.lifecycle === 'enabled'
        ? 'registered'
        : 'unknown'
  return {
    state,
    ...(stringValue(approvalRecord.reason) ? { reason: stringValue(approvalRecord.reason) } : {}),
  }
}

export function externalIntakeId(resource: MatOSWorkbenchResource): string {
  const metadata = externalMetadata(resource)
  return stringValue(metadata.intakeId) ??
    stringValue(recordValue(metadata.intake).id) ??
    resource.ref
}

export function externalIntakeImportAction(
  resource: MatOSWorkbenchResource,
  approval: MatOSWorkbenchExternalIntakeItem['approval'],
): MatOSWorkbenchAction {
  const approved = approval.state === 'approved' || approval.state === 'registered'
  const visible = isSharedGlobalMarketplaceResource(resource)
  const enabled = approved && visible
  const reason = enabled
    ? undefined
    : !visible
      ? 'External intake import is available only for shared/global/core/public MatOS intake records.'
      : 'External intake import requires approved or registered intake state.'
  return {
    key: 'import',
    label: 'Import Plan',
    enabled,
    maturity: 'controlled-mutation',
    ...(reason ? { reason } : {}),
    command: {
      argv: ['workbench', 'search', 'intake-import', resource.ref, '--json'],
      command: `matos workbench search intake-import ${JSON.stringify(resource.ref)} --json`,
    },
  }
}

export function externalIntakeMaterializeAction(
  resource: MatOSWorkbenchResource,
  approval: MatOSWorkbenchExternalIntakeItem['approval'],
): MatOSWorkbenchAction {
  const approved = approval.state === 'approved' || approval.state === 'registered'
  const visible = isSharedGlobalMarketplaceResource(resource)
  const enabled = approved && visible
  const reason = enabled
    ? undefined
    : !visible
      ? 'External intake materialization is available only for shared/global/core/public MatOS intake records.'
      : 'External intake materialization requires approved or registered intake state.'
  return {
    key: 'install',
    label: 'Materialize Source',
    enabled,
    maturity: 'controlled-mutation',
    ...(reason ? { reason } : {}),
    command: {
      argv: ['workbench', 'search', 'intake-materialize', resource.ref, '--json'],
      command: `matos workbench search intake-materialize ${JSON.stringify(resource.ref)} --json`,
    },
  }
}

export function externalIntakeFromResource(resource: MatOSWorkbenchResource): MatOSWorkbenchExternalIntakeItem {
  const repository = externalRepository(resource)
  const sourceUrl = externalSourceUrl(resource)
  const approval = externalApproval(resource)
  return {
    id: `intake:${resource.ref}`,
    intakeId: externalIntakeId(resource),
    resourceRef: resource.ref,
    title: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    kind: externalKind(resource),
    ...(repository ? { repository } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(resource.status ? { status: resource.status } : {}),
    tags: resource.tags ?? [],
    source: 'matos-asset-registry',
    approval,
    actions: [
      ...resource.actions,
      externalIntakeImportAction(resource, approval),
      externalIntakeMaterializeAction(resource, approval),
    ],
    matos: resource,
  }
}

export function externalIntakeMatchesQuery(intake: MatOSWorkbenchExternalIntakeItem, query: string): boolean {
  if (!query) {
    return true
  }
  const needle = query.toLowerCase()
  return [
    intake.intakeId,
    intake.resourceRef,
    intake.title,
    intake.description,
    intake.kind,
    intake.repository,
    intake.sourceUrl,
    intake.status,
    intake.approval.state,
    ...intake.tags,
  ].some(value => stringValue(value)?.toLowerCase().includes(needle))
}

export function externalIntakeSearchScore(intake: MatOSWorkbenchExternalIntakeItem, query: string): number {
  return externalIntakeSearchRanking(intake, query).score
}

export function externalIntakeSearchRanking(
  intake: MatOSWorkbenchExternalIntakeItem,
  query: string,
  rank = 0,
): MatOSWorkbenchSearchRanking {
  return searchRankingForFields({
    query,
    rank,
    fields: [
      { field: 'intakeId', value: intake.intakeId, exact: 1000, prefix: 850, contains: 650 },
      { field: 'resourceRef', value: intake.resourceRef, exact: 1000, prefix: 850, contains: 650 },
      { field: 'title', value: intake.title, exact: 900, prefix: 700, contains: 500 },
      { field: 'repository', value: intake.repository, exact: 900, prefix: 875, contains: 850 },
      { field: 'sourceUrl', value: intake.sourceUrl, exact: 850, prefix: 825, contains: 800 },
      { field: 'tags', value: intake.tags.join(' '), exact: 750, prefix: 600, contains: 450 },
      { field: 'kind', value: intake.kind, exact: 700, prefix: 450, contains: 300 },
      { field: 'description', value: intake.description, exact: 250, prefix: 225, contains: 200 },
    ],
  })
}

export const EXTERNAL_INTAKE_IMPORT_CANDIDATE_TYPES: MatOSWorkbenchResourceType[] = [
  'knowledge',
  'tool',
  'workflow',
  'data',
  'skill',
  'plugin',
  'mcp',
  'role',
  'benchmark',
  'evaluation',
]

export function slugSegment(value: string | undefined, fallback: string): string {
  const slug = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/^[a-z0-9-]+:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

export function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

export function workspaceRelative(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path)).replace(/\\/g, '/')
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`External intake import path is outside the MatOS workspace: ${path}`)
  }
  return rel
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export async function assertNoSymlinkPathComponent(input: {
  cwd: string
  absolutePath: string
}): Promise<void> {
  const root = resolve(input.cwd)
  const target = resolve(input.absolutePath)
  if (!isWithin(target, root)) {
    throw new Error(`External intake import target is outside the workspace: ${target}`)
  }
  const rel = relative(root, target)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink()) {
      throw new Error(
        `Refusing external intake import through symlink path: ${workspaceRelative(input.cwd, current)}`,
      )
    }
    if (!info) {
      return
    }
  }
}

export function snapshotSummary(
  snapshot: NonNullable<MatOSWorkbenchExternalIntakeImportApplyResult['snapshots']['after']>,
) {
  return {
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    files: snapshot.files,
    assetRefs: snapshot.assetRefs,
  }
}

export function importedAssetManifest(input: {
  preview: MatOSWorkbenchExternalIntakeImportPreview
  now: string
}): Record<string, unknown> {
  const asset = input.preview.plan.proposedAssets[0]
  const source = input.preview.plan.source
  return {
    id: asset.id,
    type: asset.type,
    name: input.preview.intake.title || asset.id,
    version: asset.version,
    description:
      input.preview.intake.description ||
      `Imported MatOS asset skeleton for ${input.preview.intake.resourceRef}.`,
    entry: asset.entryRelativePath ? asset.entryRelativePath.split('/').pop() : 'README.md',
    tags: [
      'external-intake',
      'imported',
      input.preview.intake.kind,
      asset.type,
    ].filter(Boolean),
    metadata: {
      sourceFormat: 'matos-external-intake-import',
      importedAt: input.now,
      intakeRef: input.preview.intake.resourceRef,
      approvalState: input.preview.intake.approval.state,
      ...(source.repository ? { repository: source.repository } : {}),
      ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
      externalKind: input.preview.intake.kind,
      canonicalSource: source.repository || source.sourceUrl,
      provenance: input.preview.plan.provenance,
    },
  }
}

export function importedAssetReadme(input: {
  preview: MatOSWorkbenchExternalIntakeImportPreview
  now: string
}): string {
  const asset = input.preview.plan.proposedAssets[0]
  const source = input.preview.plan.source
  const lines = [
    `# ${input.preview.intake.title || asset.id}`,
    '',
    input.preview.intake.description || 'Imported external repository/source intake asset.',
    '',
    '## MatOS Import',
    '',
    `- Imported at: ${input.now}`,
    `- Source intake: ${input.preview.intake.resourceRef}`,
    `- Target asset: ${asset.ref}`,
    `- Target type: ${asset.type}`,
    `- Approval state: ${input.preview.intake.approval.state}`,
    ...(source.repository ? [`- Repository: ${source.repository}`] : []),
    ...(source.sourceUrl ? [`- Source URL: ${source.sourceUrl}`] : []),
    '',
    'This file is a MatOS-controlled import skeleton. Heavy clone, indexing, RAG,',
    'benchmark, or toolchain materialization should be performed by later native',
    'MatOS intake/indexing workflows.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function validateExternalIntakeImportedAsset(input: {
  cwd: string
  targetRef: string
}) {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const asset = registry.resolve(input.targetRef)
  if (!asset) {
    throw new Error(`MatOS imported asset not found after external intake import: ${input.targetRef}`)
  }
  const assetValidation = await validateMatOSAssets([asset], {
    includeDisabled: true,
    includeDrafts: true,
  })
  return {
    ok: assetValidation.ok,
    gateProfile: 'smoke' as const,
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

export function selectedExternalIntakeImportType(requested: string | undefined): {
  requestedType?: string
  selectedType: MatOSWorkbenchResourceType
  issues: MatOSWorkbenchExternalIntakeImportPreview['validation']['issues']
} {
  const requestedType = requested?.trim()
  if (
    requestedType &&
    (EXTERNAL_INTAKE_IMPORT_CANDIDATE_TYPES as readonly string[]).includes(requestedType)
  ) {
    return {
      requestedType,
      selectedType: requestedType as MatOSWorkbenchResourceType,
      issues: [],
    }
  }
  if (requestedType) {
    return {
      requestedType,
      selectedType: 'knowledge',
      issues: [
        {
          code: 'unsupported_target_type',
          severity: 'warning',
          message: `Unsupported external intake target type "${requestedType}" was mapped to knowledge for preview.`,
        },
      ],
    }
  }
  return {
    selectedType: 'knowledge',
    issues: [],
  }
}
