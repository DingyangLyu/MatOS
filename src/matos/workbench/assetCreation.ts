import { createHash } from 'node:crypto'
import { lstat,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { dirname,relative,resolve,sep } from 'node:path'
import {
createMatOSAssetHistorySnapshot,
restoreMatOSAssetHistorySnapshot,
withMatOSAssetHistoryLock,
} from '../assets/history/index.js'
import type { MatOSAssetHistorySnapshotRecord } from '../assets/history/types.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import {
hasMatOSSecretLookingContent,
isMatOSSecretLookingFileName,
} from '../assets/secretScan.js'
import type { MatOSAssetValidationError } from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { showMatOSWorkbenchResource } from './resources.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchResourceType,
MatOSWorkbenchWriteTransactionPreview,
} from './types.js'
import { previewMatOSWorkbenchWriteTransaction } from './writeTransactions.js'

type CreateAssetType = 'knowledge' | 'tool' | 'skill' | 'role' | 'workflow' | 'mcp' | 'data'

type AssetCreateIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
}

type SnapshotSummary = Pick<
  MatOSAssetHistorySnapshotRecord,
  'snapshotId' | 'commit' | 'files' | 'assetRefs'
>

export type MatOSWorkbenchAssetCreatePlan = {
  operation: 'asset-create'
  targetPack: {
    packId: string
    relativePath: string
    manifestRelativePath: string
  }
  proposedAsset: {
    type: CreateAssetType
    id: string
    ref: string
    version: string
    name: string
    description: string
    manifestRelativePath: string
    entryRelativePath: string
  }
  provenance: {
    source: 'matos-typed-asset-library'
    requestedType: CreateAssetType
    requestedName: string
  }
}

export type MatOSWorkbenchAssetCreatePreview = {
  mode: 'asset-create-preview'
  source: 'matos-asset-registry'
  targetRef: string
  targetType: CreateAssetType
  plan: MatOSWorkbenchAssetCreatePlan
  validation: {
    ok: boolean
    issues: AssetCreateIssue[]
  }
  write: {
    enabled: false
    reason: string
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
}

export type MatOSWorkbenchAssetCreateValidation = {
  ok: boolean
  gateProfile: 'asset-create'
  assetValidation: {
    ok: boolean
    errors: MatOSAssetValidationError[]
  }
  resolvedAssetRefs: string[]
  missingAssetRefs: string[]
  secretScan: {
    ok: boolean
    findings: Array<{ path: string; reason: string }>
  }
}

export type MatOSWorkbenchAssetCreateApplyResult = {
  mode: 'asset-create-controlled-write'
  source: 'matos-asset-registry'
  applied: boolean
  readonly: false
  preview: MatOSWorkbenchAssetCreatePreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  plan: MatOSWorkbenchAssetCreatePlan
  targetRef: string
  targetPackPath: string
  writtenPaths: string[]
  snapshots: {
    before: SnapshotSummary
    after?: SnapshotSummary
    rollback?: SnapshotSummary
  }
  validation: MatOSWorkbenchAssetCreateValidation
  after?: unknown
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'resources.create'
    reason?: string
  }
}

const CREATE_TYPES = new Set<CreateAssetType>([
  'knowledge',
  'tool',
  'skill',
  'role',
  'workflow',
  'mcp',
  'data',
])

const ENTRY_FILE_BY_TYPE: Record<CreateAssetType, string> = {
  knowledge: 'README.md',
  tool: 'TOOL.md',
  skill: 'SKILL.md',
  role: 'ROLE.md',
  workflow: 'workflow.yaml',
  mcp: 'mcp.json',
  data: 'DATA.md',
}

const TYPE_TAGS: Record<CreateAssetType, string[]> = {
  knowledge: ['knowledge', 'user-created'],
  tool: ['tool', 'user-created'],
  skill: ['skill', 'user-created'],
  role: ['role', 'user-created'],
  workflow: ['workflow', 'user-created'],
  mcp: ['mcp', 'user-created'],
  data: ['data', 'user-created'],
}

const DEFAULT_VERSION = '0.1.0'
const SECRET_SCAN_MAX_BYTES = 1024 * 1024
const VALID_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function stableJson(value: unknown): string {
  return JSON.stringify(sortForHash(value))
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForHash)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForHash(item)]),
  )
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function normalizeType(value: unknown): CreateAssetType | undefined {
  const type = stringValue(value)
  return type && CREATE_TYPES.has(type as CreateAssetType)
    ? (type as CreateAssetType)
    : undefined
}

function slugSegment(value: string | undefined, fallback: string): string {
  const slug = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/^[a-z0-9-]+:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || fallback
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
    throw new Error(`MatOS asset create path is outside the workspace: ${path}`)
  }
  return rel
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function assertNoSymlinkPathComponent(input: {
  cwd: string
  absolutePath: string
}): Promise<void> {
  const root = resolve(input.cwd)
  const target = resolve(input.absolutePath)
  if (!isWithin(target, root)) {
    throw new Error(`MatOS asset create target is outside the workspace: ${target}`)
  }
  const rel = relative(root, target)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink()) {
      throw new Error(
        `Refusing MatOS asset create through symlink path: ${workspaceRelative(input.cwd, current)}`,
      )
    }
    if (!info) {
      return
    }
  }
}

function snapshotSummary(snapshot: MatOSAssetHistorySnapshotRecord): SnapshotSummary {
  return {
    snapshotId: snapshot.snapshotId,
    commit: snapshot.commit,
    files: snapshot.files,
    assetRefs: snapshot.assetRefs,
  }
}

function createMarkdownEntry(input: {
  type: Exclude<CreateAssetType, 'workflow' | 'mcp'>
  name: string
  description: string
  targetRef: string
  now: string
}): string {
  const labels: Record<Exclude<CreateAssetType, 'workflow' | 'mcp'>, string> = {
    knowledge: 'Knowledge',
    tool: 'Tool',
    skill: 'Skill',
    role: 'Role',
    data: 'Data',
  }
  const lines = [
    `# ${input.name}`,
    '',
    input.description,
    '',
    `## MatOS ${labels[input.type]} Asset`,
    '',
    `- Asset ref: ${input.targetRef}`,
    `- Created at: ${input.now}`,
    '- Source: MatOS typed asset library',
    '',
  ]
  if (input.type === 'role') {
    lines.push(
      '## Role Instructions',
      '',
      'Describe the agent behavior, mounted tools, skills, knowledge, and runtime expectations here.',
      '',
    )
  } else if (input.type === 'tool') {
    lines.push(
      '## Tool Contract',
      '',
      'Describe the tool purpose, inputs, outputs, safety checks, and failure handling here.',
      '',
    )
  } else if (input.type === 'skill') {
    lines.push(
      '## Skill Procedure',
      '',
      'Describe the reusable procedure, constraints, verification steps, and examples here.',
      '',
    )
  } else if (input.type === 'data') {
    lines.push(
      '## Data Notes',
      '',
      'Describe the dataset, schema, provenance, update policy, and example rows here.',
      '',
    )
  } else {
    lines.push(
      '## Knowledge Notes',
      '',
      'Add curated facts, references, runbook guidance, examples, and provenance here.',
      '',
    )
  }
  return `${lines.join('\n')}\n`
}

function createWorkflowEntry(input: {
  name: string
  description: string
  targetRef: string
  now: string
}): string {
  const safeName = JSON.stringify(input.name)
  const safeDescription = JSON.stringify(input.description)
  const safeTargetRef = JSON.stringify(input.targetRef)
  const safeNow = JSON.stringify(input.now)
  return [
    'schemaVersion: 1',
    `name: ${safeName}`,
    `description: ${safeDescription}`,
    'policy:',
    '  approvalMode: bypass',
    '  defaultRisk: low',
    'nodes:',
    '  start:',
    '    type: exec',
    '    command: "printf workflow-ready"',
    'outputs:',
    '  result:',
    '    value: "{{ nodes.start.outputs.stdout }}"',
    'metadata:',
    `  matosAssetRef: ${safeTargetRef}`,
    `  createdAt: ${safeNow}`,
    '  source: "matos-typed-asset-library"',
    '',
  ].join('\n')
}

function createMcpEntry(input: {
  name: string
  description: string
  targetRef: string
  now: string
}): string {
  return `${JSON.stringify({
    mcpServers: {
      [slugSegment(input.name, 'matos-mcp').replace(/-/g, '_')]: {
        command: '',
        args: [],
        env: {},
        description: input.description,
        matos: {
          assetRef: input.targetRef,
          createdAt: input.now,
          source: 'matos-typed-asset-library',
        },
      },
    },
  }, null, 2)}\n`
}

function assetEntryContent(input: {
  type: CreateAssetType
  name: string
  description: string
  targetRef: string
  now: string
}): string {
  if (input.type === 'workflow') {
    return createWorkflowEntry(input)
  }
  if (input.type === 'mcp') {
    return createMcpEntry(input)
  }
  return createMarkdownEntry({
    type: input.type,
    name: input.name,
    description: input.description,
    targetRef: input.targetRef,
    now: input.now,
  })
}

function packManifest(input: {
  packId: string
  name: string
  type: CreateAssetType
  targetRef: string
  now: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: input.packId,
    name: `${input.name} Pack`,
    version: DEFAULT_VERSION,
    description: `Project-local MatOS ${input.type} asset pack created from the typed asset library.`,
    metadata: {
      sourceFormat: 'matos-typed-asset-library-pack',
      createdAt: input.now,
      targetRef: input.targetRef,
      targetType: input.type,
    },
  }
}

function assetManifest(input: {
  type: CreateAssetType
  id: string
  name: string
  version: string
  description: string
  entry: string
  targetRef: string
  now: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: input.id,
    type: input.type,
    name: input.name,
    version: input.version,
    description: input.description,
    entry: input.entry,
    tags: TYPE_TAGS[input.type],
    ...(input.type === 'workflow'
      ? {
          runtime: {
            workflow: {
              kind: 'executable',
            },
          },
        }
      : {}),
    ...(input.type === 'role'
      ? {
          runtime: {
            permissionMode: 'bypassPermissions',
          },
        }
      : {}),
    lifecycle: {
      status: 'enabled',
      origin: 'matos-typed-asset-library',
      updatedAt: input.now,
    },
    metadata: {
      sourceFormat: 'matos-typed-asset-library',
      createdAt: input.now,
      createdBy: 'matos-workbench',
      targetRef: input.targetRef,
      ...(input.type === 'data'
        ? {
            fields: [],
            records: [],
          }
        : {}),
    },
  }
}

async function validateCreatedAsset(input: {
  cwd: string
  plan: MatOSWorkbenchAssetCreatePlan
  writtenPaths: string[]
}): Promise<MatOSWorkbenchAssetCreateValidation> {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets, {
    includeDisabled: true,
  })
  const target = registry.resolve(input.plan.proposedAsset.ref)
  const assetValidation = await validateMatOSAssets(
    target ? [target] : [],
    {
      includeDisabled: true,
      includeDrafts: true,
    },
  )
  const findings: Array<{ path: string; reason: string }> = []
  for (const writtenPath of input.writtenPaths) {
    if (isMatOSSecretLookingFileName(writtenPath)) {
      findings.push({
        path: writtenPath,
        reason: 'Generated asset file has a secret-looking name.',
      })
      continue
    }
    const absolutePath = resolve(input.cwd, writtenPath)
    try {
      const info = await lstat(absolutePath)
      if (!info.isFile() || info.size > SECRET_SCAN_MAX_BYTES) {
        continue
      }
      if (hasMatOSSecretLookingContent(await readFile(absolutePath, 'utf8'))) {
        findings.push({
          path: writtenPath,
          reason: 'Generated asset file contains secret-looking content.',
        })
      }
    } catch {
      // Missing files are reported through the target resolution gate.
    }
  }
  const missingAssetRefs = target ? [] : [input.plan.proposedAsset.ref]
  return {
    ok: Boolean(target) && assetValidation.ok && findings.length === 0,
    gateProfile: 'asset-create',
    assetValidation: {
      ok: assetValidation.ok,
      errors: assetValidation.errors,
    },
    resolvedAssetRefs: target ? [input.plan.proposedAsset.ref] : [],
    missingAssetRefs,
    secretScan: {
      ok: findings.length === 0,
      findings,
    },
  }
}

export async function previewMatOSWorkbenchAssetCreate(
  input: MatOSWorkbenchContext & {
    type?: string
    name?: string
    description?: string
    id?: string
    version?: string
    packId?: string
  },
): Promise<MatOSWorkbenchAssetCreatePreview> {
  const issues: AssetCreateIssue[] = []
  const type = normalizeType(input.type)
  if (!type) {
    issues.push({
      code: 'unsupported_asset_type',
      severity: 'error',
      message:
        'Typed asset creation supports knowledge, data, tool, skill, role, workflow, and MCP assets.',
    })
  }
  const requestedName = stringValue(input.name)
  if (!requestedName) {
    issues.push({
      code: 'missing_asset_name',
      severity: 'error',
      message: 'Typed asset creation requires --name.',
    })
  }
  const assetType = type ?? 'knowledge'
  const name = requestedName ?? 'Untitled Asset'
  const id = slugSegment(input.id ?? name, `${assetType}-asset`)
  if (!VALID_ID_PATTERN.test(id)) {
    issues.push({
      code: 'invalid_asset_id',
      severity: 'error',
      message:
        'Typed asset creation id must be lowercase alphanumeric/hyphen (max 64 chars), starting with a letter or digit.',
    })
  }
  const version = stringValue(input.version) ?? DEFAULT_VERSION
  const description =
    stringValue(input.description) ??
    `Project-local ${assetType} asset created from the MatOS typed asset library.`
  const packId = slugSegment(input.packId ?? `${assetType}-${id}`, `${assetType}-asset`)
  if (!VALID_ID_PATTERN.test(packId)) {
    issues.push({
      code: 'invalid_pack_id',
      severity: 'error',
      message:
        'Typed asset creation pack id must be lowercase alphanumeric/hyphen (max 64 chars), starting with a letter or digit.',
    })
  }
  const targetRef = `${assetType}:${id}@${version}`
  const targetPackRelativePath = `.matos/assets/packs/${packId}`
  const entryFile = ENTRY_FILE_BY_TYPE[assetType]
  const plan: MatOSWorkbenchAssetCreatePlan = {
    operation: 'asset-create',
    targetPack: {
      packId,
      relativePath: targetPackRelativePath,
      manifestRelativePath: `${targetPackRelativePath}/matos.pack.json`,
    },
    proposedAsset: {
      type: assetType,
      id,
      ref: targetRef,
      version,
      name,
      description,
      manifestRelativePath: `${targetPackRelativePath}/${assetType}/${id}/asset.json`,
      entryRelativePath: `${targetPackRelativePath}/${assetType}/${id}/${entryFile}`,
    },
    provenance: {
      source: 'matos-typed-asset-library',
      requestedType: assetType,
      requestedName: name,
    },
  }

  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  const existingAsset = registry.resolve(targetRef)
  if (existingAsset) {
    issues.push({
      code: 'target_asset_already_exists',
      severity: 'error',
      message: `Typed asset creation target already exists: ${existingAsset.canonicalKey} (${existingAsset.manifestPath}).`,
    })
  }
  if (await pathExists(resolve(input.cwd, targetPackRelativePath))) {
    issues.push({
      code: 'target_pack_already_exists',
      severity: 'error',
      message: `Typed asset creation target pack already exists: ${targetPackRelativePath}`,
    })
  }
  if (hasMatOSSecretLookingContent([name, description, targetRef].join('\n'))) {
    issues.push({
      code: 'secret_like_create_input',
      severity: 'error',
      message: 'Typed asset creation input contains secret-looking content.',
    })
  }

  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const warningCount = issues.filter(issue => issue.severity === 'warning').length
  const validationOk = errorCount === 0
  const transaction = previewMatOSWorkbenchWriteTransaction({
    source: 'coze-resource-ui',
    requestedMutation: 'asset-create',
    targetRef,
    targetType: assetType as MatOSWorkbenchResourceType,
    scopeRef: input.scopeRef,
    patch: plan,
    validationOk,
    errorCount,
    warningCount,
    validationEvidence: {
      issues,
      plan,
    },
    deterministicSmoke: {
      ok: validationOk,
      summary: validationOk
        ? 'Typed asset create preview resolved a project-local pack, asset manifest path, entry path, and canonical asset ref.'
        : 'Typed asset create preview is blocked before writer execution.',
      evidence: {
        targetPack: plan.targetPack,
        proposedAsset: plan.proposedAsset,
      },
    },
    confirmationFingerprint: sha256({
      requestedMutation: 'asset-create',
      plan,
      validationOk,
      errorCount,
      warningCount,
    }),
  })

  return {
    mode: 'asset-create-preview',
    source: 'matos-asset-registry',
    targetRef,
    targetType: assetType,
    plan,
    validation: {
      ok: validationOk,
      issues,
    },
    write: {
      enabled: false,
      reason:
        'Typed asset creation is a native MatOS controlled-write preview; applying it creates a project-local asset pack with history snapshots, validation, rollback, and audit evidence.',
    },
    transaction,
  }
}

export async function applyMatOSWorkbenchAssetCreate(
  input: MatOSWorkbenchContext & {
    type?: string
    name?: string
    description?: string
    id?: string
    version?: string
    packId?: string
    fingerprint: string
    reason?: string
  },
): Promise<MatOSWorkbenchAssetCreateApplyResult> {
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'workbench-resource-create',
  }, async () => {
    const preview = await previewMatOSWorkbenchAssetCreate(input)
    if (!preview.validation.ok) {
      throw new Error('Typed asset creation apply is blocked because preview validation failed.')
    }
    if (input.fingerprint !== preview.transaction.confirmationFingerprint) {
      throw new Error(
        'Typed asset creation confirmation fingerprint does not match the current MatOS create transaction.',
      )
    }
    const plan = preview.plan
    const targetPackPath = resolve(input.cwd, plan.targetPack.relativePath)
    const packManifestPath = resolve(input.cwd, plan.targetPack.manifestRelativePath)
    const assetManifestPath = resolve(input.cwd, plan.proposedAsset.manifestRelativePath)
    const entryPath = resolve(input.cwd, plan.proposedAsset.entryRelativePath)
    const allowedRoot = resolve(input.cwd, '.matos', 'assets', 'packs')
    if (!isWithin(targetPackPath, allowedRoot)) {
      throw new Error(
        `Typed asset creation target must be below .matos/assets/packs: ${workspaceRelative(input.cwd, targetPackPath)}`,
      )
    }
    await assertNoSymlinkPathComponent({ cwd: input.cwd, absolutePath: targetPackPath })
    if (await pathExists(targetPackPath)) {
      throw new Error(
        `Typed asset creation target pack already exists: ${workspaceRelative(input.cwd, targetPackPath)}`,
      )
    }

    const writtenPaths = [
      workspaceRelative(input.cwd, packManifestPath),
      workspaceRelative(input.cwd, assetManifestPath),
      workspaceRelative(input.cwd, entryPath),
    ]
    const beforeSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      message: `asset create before ${plan.proposedAsset.ref}`,
      paths: writtenPaths,
      assetRefs: [plan.proposedAsset.ref],
      provenance: {
        source: 'matos-workbench',
        operation: 'resources.create',
        targetRef: plan.proposedAsset.ref,
        confirmationFingerprint: preview.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })
    const rolledBackResult = (rollback: {
      validation: MatOSWorkbenchAssetCreateValidation
      reason: string
      after?: SnapshotSummary
      rollback?: SnapshotSummary
    }): MatOSWorkbenchAssetCreateApplyResult => ({
      mode: 'asset-create-controlled-write',
      source: 'matos-asset-registry',
      applied: false,
      readonly: false,
      preview,
      transaction: preview.transaction,
      plan,
      targetRef: plan.proposedAsset.ref,
      targetPackPath: workspaceRelative(input.cwd, targetPackPath),
      writtenPaths,
      snapshots: {
        before: snapshotSummary(beforeSnapshot),
        ...(rollback.after ? { after: rollback.after } : {}),
        ...(rollback.rollback ? { rollback: rollback.rollback } : {}),
      },
      validation: rollback.validation,
      write: {
        enabled: true,
        status: 'rolled-back',
        reason: rollback.reason,
      },
      audit: {
        target: 'matos-asset-history',
        operation: 'resources.create',
        reason: input.reason,
      },
    })

    try {
      const now = new Date().toISOString()
      const proposed = plan.proposedAsset
      const entryFile = ENTRY_FILE_BY_TYPE[proposed.type]
      await mkdir(dirname(packManifestPath), { recursive: true })
      await mkdir(dirname(assetManifestPath), { recursive: true })
      await writeFile(
        packManifestPath,
        `${JSON.stringify(packManifest({
          packId: plan.targetPack.packId,
          name: proposed.name,
          type: proposed.type,
          targetRef: proposed.ref,
          now,
        }), null, 2)}\n`,
        'utf8',
      )
      await writeFile(
        assetManifestPath,
        `${JSON.stringify(assetManifest({
          type: proposed.type,
          id: proposed.id,
          name: proposed.name,
          version: proposed.version,
          description: proposed.description,
          entry: entryFile,
          targetRef: proposed.ref,
          now,
        }), null, 2)}\n`,
        'utf8',
      )
      await writeFile(
        entryPath,
        assetEntryContent({
          type: proposed.type,
          name: proposed.name,
          description: proposed.description,
          targetRef: proposed.ref,
          now,
        }),
        'utf8',
      )

      const validation = await validateCreatedAsset({
        cwd: input.cwd,
        plan,
        writtenPaths,
      })
      if (!validation.secretScan.ok) {
        await rm(targetPackPath, { recursive: true, force: true })
        return rolledBackResult({
          validation,
          reason:
            'Generated asset content tripped the MatOS secret scan; the pack was removed without snapshotting generated content.',
        })
      }
      const afterSnapshot = await createMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        kind: 'manual',
        scope: 'project',
        parentCommit: beforeSnapshot.commit,
        message: `asset create after ${proposed.ref}`,
        paths: writtenPaths,
        assetRefs: [proposed.ref],
        provenance: {
          source: 'matos-workbench',
          operation: 'resources.create',
          targetRef: proposed.ref,
          beforeSnapshot: beforeSnapshot.snapshotId,
          confirmationFingerprint: preview.transaction.confirmationFingerprint,
          reason: input.reason,
        },
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
          message: `asset create rollback ${proposed.ref}`,
          paths: writtenPaths,
          assetRefs: [proposed.ref],
          provenance: {
            source: 'matos-workbench',
            operation: 'resources.create.rollback',
            targetRef: proposed.ref,
            beforeSnapshot: beforeSnapshot.snapshotId,
            afterSnapshot: afterSnapshot.snapshotId,
            confirmationFingerprint: preview.transaction.confirmationFingerprint,
            reason: 'post-write asset validation failed',
          },
        })
        return rolledBackResult({
          validation,
          reason: 'Post-write asset validation failed; MatOS restored the before snapshot.',
          after: snapshotSummary(afterSnapshot),
          rollback: snapshotSummary(rollbackSnapshot),
        })
      }
      const after = await showMatOSWorkbenchResource({
        ...input,
        ref: proposed.ref,
        includeDisabled: true,
        includeGraph: true,
      })
      return {
        mode: 'asset-create-controlled-write',
        source: 'matos-asset-registry',
        applied: true,
        readonly: false,
        preview,
        transaction: preview.transaction,
        plan,
        targetRef: proposed.ref,
        targetPackPath: workspaceRelative(input.cwd, targetPackPath),
        writtenPaths,
        snapshots: {
          before: snapshotSummary(beforeSnapshot),
          after: snapshotSummary(afterSnapshot),
        },
        validation,
        after,
        write: {
          enabled: true,
          status: 'applied',
        },
        audit: {
          target: 'matos-asset-history',
          operation: 'resources.create',
          reason: input.reason,
        },
      }
    } catch (error) {
      await rm(targetPackPath, { recursive: true, force: true })
      throw error
    }
  })
}
