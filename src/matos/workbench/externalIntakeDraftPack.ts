import { createHash } from 'node:crypto'
import { lstat,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { dirname,join,relative,resolve,sep } from 'node:path'
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
import {
acquireMatOSExternalIntakeSource,
type MatOSExternalIntakeAcquisition,
} from './externalIntakeAcquire.js'
import {
draftMatOSIntakeBenchmarkCase,
type MatOSIntakeBenchmarkDraft,
} from './externalIntakeBenchmark.js'
import {
classifyMatOSExternalIntakeSource,
fingerprintMatOSExternalIntakeSource,
type MatOSExternalIntakeClassification,
type MatOSExternalIntakeClassificationIssue,
type MatOSExternalIntakeProposal,
type MatOSExternalIntakeSignal,
} from './externalIntakeClassification.js'
import {
externalIntakeExecutableManifestExtras,
planMatOSExternalIntakeExecutableAssets,
renderExternalIntakeExecutableFiles,
type MatOSExternalIntakeExecutablePlan,
type MatOSExternalIntakeExecutablePlannedAsset,
type MatOSExternalIntakeRenderContext,
} from './externalIntakeExecutableEntries.js'
import {
refineMatOSExternalIntakeWithLlm,
type MatOSExternalIntakeLlmAssist,
} from './externalIntakeLlmAssist.js'
import {
extractMatOSExternalIntakePaperText,
summarizeMatOSExternalIntakePaperWithLlm,
type MatOSExternalIntakePaperExtraction,
type MatOSExternalIntakePaperSummary,
} from './externalIntakePaperExtract.js'
import type { MatOSWorkbenchContext,MatOSWorkbenchWriteTransactionPreview } from './types.js'
import { previewMatOSWorkbenchWriteTransaction } from './writeTransactions.js'

/**
 * repo2asset / paper2asset V1 draft-pack layer.
 *
 * Takes a deterministic external-intake classification (local repository
 * directory or paper/document file) and drafts a self-contained MatOS asset
 * pack under `.matos/assets/packs/<pack-id>/`. Generated entry files
 * reference the external source by path + content fingerprint instead of
 * copying corpora, and every asset records intake provenance.
 */

const DRAFT_PACK_VERSION = '0.1.0'
const DRAFT_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENTRY_FILE_NAME = 'REFERENCE.md'
const ENTRY_EVIDENCE_LIMIT = 8
const SECRET_SCAN_MAX_BYTES = 1024 * 1024

type DraftPackIssue = MatOSExternalIntakeClassificationIssue

type SnapshotSummary = Pick<
  MatOSAssetHistorySnapshotRecord,
  'snapshotId' | 'commit' | 'files' | 'assetRefs'
>

export type MatOSWorkbenchExternalIntakeSourceDescriptor = {
  intakeId: string
  intakeRef: string
  sourcePath: string
  sourceKind: MatOSExternalIntakeClassification['source']['kind']
  fingerprint?: string
  fileCount: number
  scannedFileCount: number
  truncated: boolean
  /** Remote/archive acquisition provenance when the source was staged. */
  acquisition?: {
    source: string
    sourceKind: MatOSExternalIntakeAcquisition['sourceKind']
    stagedRelativePath?: string
    url?: string
    gitRemote?: string
    gitCommit?: string
    archiveName?: string
    archiveSha256?: string
    downloadSha256?: string
    downloadBytes?: number
  }
}

export type MatOSWorkbenchExternalIntakeClassifyResult = {
  mode: 'external-intake-classify'
  source: 'matos-external-intake-classifier'
  intake: MatOSWorkbenchExternalIntakeSourceDescriptor
  classification: MatOSExternalIntakeClassification
  validation: MatOSExternalIntakeClassification['validation']
  llmAssist?: MatOSExternalIntakeLlmAssist
  next: {
    draft: {
      argv: string[]
      command: string
    }
  }
}

export type MatOSWorkbenchExternalIntakeDraftPackPlan = {
  operation: 'external-intake-draft-pack'
  intake: MatOSWorkbenchExternalIntakeSourceDescriptor
  targetPack: {
    packId: string
    relativePath: string
    manifestRelativePath: string
  }
  proposedAssets: Array<{
    type: MatOSExternalIntakeProposal['type']
    id: string
    ref: string
    version: string
    primary: boolean
    score: number
    confidence: number
    manifestRelativePath: string
    entryRelativePath: string
    /** Executable-mode extensions (absent in reference mode). */
    role?: MatOSExternalIntakeExecutablePlannedAsset['role']
    entryFile?: string
    files?: string[]
    executable?: boolean
  }>
  /** Present when the pack was planned in executable mode. */
  executable?: {
    planner: MatOSExternalIntakeExecutablePlan['planner']
    toolWrapper?: MatOSExternalIntakeExecutablePlan['toolWrapper']
    readmeDigest?: string
    paper?: {
      extraction: MatOSExternalIntakePaperExtraction
      summary?: MatOSExternalIntakePaperSummary
    }
    llmAssist?: MatOSExternalIntakeLlmAssist
    notes: string[]
  }
  provenance: {
    classifier: MatOSExternalIntakeClassification['classifier']
    intakeRef: string
    sourcePath: string
    sourceFingerprint?: string
  }
}

export type MatOSWorkbenchExternalIntakeDraftPackPreview = {
  mode: 'external-intake-draft-pack-preview'
  source: 'matos-external-intake-classifier'
  classification: MatOSExternalIntakeClassification
  plan: MatOSWorkbenchExternalIntakeDraftPackPlan
  validation: {
    ok: boolean
    issues: DraftPackIssue[]
  }
  write: {
    enabled: false
    reason: string
  }
  benchmark?: MatOSIntakeBenchmarkDraft
  transaction: MatOSWorkbenchWriteTransactionPreview
}

export type MatOSWorkbenchExternalIntakeDraftPackValidation = {
  ok: boolean
  gateProfile: 'draft-pack'
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

export type MatOSWorkbenchExternalIntakeDraftPackApplyResult = {
  mode: 'external-intake-draft-pack-controlled-write'
  source: 'matos-external-intake-classifier'
  applied: boolean
  readonly: false
  preview: MatOSWorkbenchExternalIntakeDraftPackPreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  plan: MatOSWorkbenchExternalIntakeDraftPackPlan
  targetPackPath: string
  writtenPaths: string[]
  snapshots: {
    before: SnapshotSummary
    after?: SnapshotSummary
    rollback?: SnapshotSummary
  }
  validation: MatOSWorkbenchExternalIntakeDraftPackValidation
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'search.intake-draft'
    reason?: string
  }
}

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/**
 * Fingerprint view of the executable plan with volatile cache markers
 * removed: the LLM assist / paper summary content is deterministic across
 * preview and apply (cached by prompt), but `cacheHit` flips from false to
 * true on the second call and must not break fingerprint confirmation.
 */
function stableExecutablePlanView(
  executable: NonNullable<MatOSWorkbenchExternalIntakeDraftPackPlan['executable']>,
): Record<string, unknown> {
  const stripCacheHit = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    const { cacheHit: _cacheHit, ...rest } = value as Record<string, unknown>
    return rest
  }
  return {
    ...executable,
    ...(executable.llmAssist
      ? { llmAssist: stripCacheHit(executable.llmAssist) }
      : {}),
    ...(executable.paper
      ? {
          paper: {
            extraction: executable.paper.extraction,
            ...(executable.paper.summary
              ? { summary: stripCacheHit(executable.paper.summary) }
              : {}),
          },
        }
      : {}),
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
    throw new Error(`External intake draft path is outside the MatOS workspace: ${path}`)
  }
  return rel
}

function displaySourcePath(cwd: string, absolutePath: string): string {
  return isWithin(absolutePath, cwd)
    ? workspaceRelative(cwd, absolutePath)
    : absolutePath
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
    throw new Error(`External intake draft target is outside the workspace: ${target}`)
  }
  const rel = relative(root, target)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink()) {
      throw new Error(
        `Refusing external intake draft through symlink path: ${workspaceRelative(input.cwd, current)}`,
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

function safeEvidence(paths: string[]): string[] {
  return paths
    .filter(path => !isMatOSSecretLookingFileName(path))
    .slice(0, ENTRY_EVIDENCE_LIMIT)
}

async function describeIntakeSource(input: {
  cwd: string
  classification: MatOSExternalIntakeClassification
  acquisition?: MatOSExternalIntakeAcquisition
}): Promise<MatOSWorkbenchExternalIntakeSourceDescriptor> {
  const { classification, acquisition } = input
  let fingerprint = classification.source.fingerprint
  if (!fingerprint && classification.source.exists && classification.files.length > 0) {
    fingerprint = (
      await fingerprintMatOSExternalIntakeSource({
        rootPath: classification.source.path,
        files: classification.files,
      })
    ).fingerprint
  }
  const provenance = acquisition?.provenance
  const acquisitionDescriptor =
    acquisition && acquisition.staged
      ? {
          source: acquisition.source,
          sourceKind: acquisition.sourceKind,
          ...(acquisition.stagedRelativePath
            ? { stagedRelativePath: acquisition.stagedRelativePath }
            : {}),
          ...(provenance?.url ? { url: provenance.url } : {}),
          ...(provenance?.gitRemote ? { gitRemote: provenance.gitRemote } : {}),
          ...(provenance?.gitCommit ? { gitCommit: provenance.gitCommit } : {}),
          ...(provenance?.archiveName ? { archiveName: provenance.archiveName } : {}),
          ...(provenance?.archiveSha256 ? { archiveSha256: provenance.archiveSha256 } : {}),
          ...(provenance?.downloadSha256 ? { downloadSha256: provenance.downloadSha256 } : {}),
          ...(provenance?.downloadBytes !== undefined
            ? { downloadBytes: provenance.downloadBytes }
            : {}),
        }
      : undefined
  return {
    intakeId: `intake-${classification.source.slug}`,
    intakeRef: `external-intake:${classification.source.slug}`,
    sourcePath: displaySourcePath(input.cwd, classification.source.path),
    sourceKind: classification.source.kind,
    ...(fingerprint ? { fingerprint } : {}),
    fileCount: classification.source.fileCount,
    scannedFileCount: classification.source.scannedFileCount,
    truncated: classification.source.truncated,
    ...(acquisitionDescriptor ? { acquisition: acquisitionDescriptor } : {}),
  }
}

export async function classifyMatOSWorkbenchExternalIntakeSource(
  input: MatOSWorkbenchContext & {
    path: string
    llmAssist?: boolean
    llmAssistModel?: string
  },
): Promise<MatOSWorkbenchExternalIntakeClassifyResult> {
  const acquisition = await acquireMatOSExternalIntakeSource({
    cwd: input.cwd,
    source: input.path,
  })
  const classification = await classifyMatOSExternalIntakeSource({
    cwd: input.cwd,
    path: acquisition.localPath,
  })
  classification.validation.issues.unshift(...acquisition.issues)
  if (acquisition.issues.some(issue => issue.severity === 'error')) {
    classification.validation.ok = false
  }
  const intake = await describeIntakeSource({ cwd: input.cwd, classification, acquisition })
  // Remote/archive sources keep the ORIGINAL source string in follow-up
  // commands; acquisition staging is idempotent, so draft/apply re-resolve to
  // the same staged content and the confirmation fingerprint stays stable.
  const draftSource = acquisition.staged ? acquisition.source : intake.sourcePath
  const draftArgv = ['workbench', 'search', 'intake-draft', draftSource, '--json']
  const llmAssist = input.llmAssist
    ? await refineMatOSExternalIntakeWithLlm({
        cwd: input.cwd,
        classification,
        fingerprint: intake.fingerprint,
        model: input.llmAssistModel,
      })
    : undefined
  return {
    mode: 'external-intake-classify',
    source: 'matos-external-intake-classifier',
    intake,
    classification,
    validation: classification.validation,
    ...(llmAssist ? { llmAssist } : {}),
    next: {
      draft: {
        argv: draftArgv,
        command: `matos workbench search intake-draft ${JSON.stringify(draftSource)} --json`,
      },
    },
  }
}

function signalsForType(
  classification: MatOSExternalIntakeClassification,
  type: MatOSExternalIntakeProposal['type'],
): MatOSExternalIntakeSignal[] {
  return classification.signals.filter(signal => signal.assetType === type)
}

function assetDescription(input: {
  classification: MatOSExternalIntakeClassification
  proposal: MatOSExternalIntakeProposal
}): string {
  const topSignal = signalsForType(input.classification, input.proposal.type)[0]
  const base = `Draft ${input.proposal.type} asset classified from external ${input.classification.source.kind} "${input.classification.source.name}" by deterministic file heuristics.`
  return topSignal ? `${base} ${topSignal.summary}` : base
}

function draftAssetManifest(input: {
  classification: MatOSExternalIntakeClassification
  proposal: MatOSExternalIntakeProposal
  intake: MatOSWorkbenchExternalIntakeSourceDescriptor
  bundleRefs: string[]
  now: string
}): Record<string, unknown> {
  const { classification, proposal, intake } = input
  const dependencies = proposal.primary
    ? input.bundleRefs.filter(ref => ref !== proposal.ref)
    : []
  return {
    schemaVersion: 1,
    id: proposal.id,
    type: proposal.type,
    name: `${classification.source.name} (${proposal.type} intake draft)`,
    version: proposal.version,
    description: assetDescription({ classification, proposal }),
    entry: ENTRY_FILE_NAME,
    tags: [
      'external-intake',
      'draft',
      classification.source.kind === 'repository' ? 'repo2asset' : 'paper2asset',
      proposal.type,
    ],
    ...(dependencies.length > 0 ? { dependencies } : {}),
    lifecycle: {
      status: 'draft',
      reason: 'External intake draft pending review before activation.',
      origin: 'matos-external-intake-draft',
    },
    metadata: {
      sourceFormat: 'matos-external-intake-draft',
      draftedAt: input.now,
      intake: {
        intakeId: intake.intakeId,
        intakeRef: intake.intakeRef,
        sourcePath: intake.sourcePath,
        sourceKind: intake.sourceKind,
        ...(intake.fingerprint ? { sourceFingerprint: intake.fingerprint } : {}),
        ...(intake.acquisition ? { acquisition: intake.acquisition } : {}),
        fileCount: intake.fileCount,
        scannedFileCount: intake.scannedFileCount,
        truncated: intake.truncated,
        classifier: {
          id: classification.classifier.id,
          version: classification.classifier.version,
          deterministic: classification.classifier.deterministic,
        },
      },
      proposal: {
        primary: proposal.primary,
        score: proposal.score,
        confidence: proposal.confidence,
        reasons: proposal.reasons,
        evidence: safeEvidence(proposal.evidence),
      },
    },
  }
}

function draftAssetEntry(input: {
  classification: MatOSExternalIntakeClassification
  proposal: MatOSExternalIntakeProposal
  intake: MatOSWorkbenchExternalIntakeSourceDescriptor
  now: string
}): string {
  const { classification, proposal, intake } = input
  const typeSignals = signalsForType(classification, proposal.type)
  const lines = [
    `# ${classification.source.name} (${proposal.type} intake draft)`,
    '',
    assetDescription({ classification, proposal }),
    '',
    '## Source reference',
    '',
    `- Source path: ${intake.sourcePath}`,
    `- Source kind: ${intake.sourceKind}`,
    ...(intake.acquisition
      ? [
          `- Acquired from: ${intake.acquisition.url ?? intake.acquisition.gitRemote ?? intake.acquisition.source} (${intake.acquisition.sourceKind})`,
          ...(intake.acquisition.gitCommit ? [`- Git commit: ${intake.acquisition.gitCommit}`] : []),
          ...(intake.acquisition.archiveSha256
            ? [`- Archive sha256: ${intake.acquisition.archiveSha256}`]
            : []),
          ...(intake.acquisition.downloadSha256
            ? [`- Download sha256: ${intake.acquisition.downloadSha256}`]
            : []),
        ]
      : []),
    ...(intake.fingerprint ? [`- Source fingerprint: ${intake.fingerprint}`] : []),
    `- Files scanned: ${intake.scannedFileCount} (truncated: ${intake.truncated})`,
    `- Classifier: ${classification.classifier.id} v${classification.classifier.version} (deterministic)`,
    `- Intake ref: ${intake.intakeRef}`,
    `- Drafted at: ${input.now}`,
    '',
    '## Classification evidence',
    '',
    ...(typeSignals.length > 0
      ? typeSignals.flatMap(signal => [
          `- ${signal.code} (weight ${signal.weight}): ${signal.summary}`,
          ...safeEvidence(signal.evidence).map(path => `  - ${path}`),
        ])
      : proposal.reasons.map(reason => `- ${reason}`)),
    '',
    '## Reference policy',
    '',
    'This draft references the external source by path and content fingerprint',
    'instead of copying the corpus into the MatOS asset pack. Later native',
    'MatOS intake, indexing, or binding workflows may materialize the source',
    'through controlled paths before this asset is promoted out of draft.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

function draftPackManifest(input: {
  classification: MatOSExternalIntakeClassification
  intake: MatOSWorkbenchExternalIntakeSourceDescriptor
  packId: string
  now: string
}): Record<string, unknown> {
  const { classification, intake } = input
  return {
    schemaVersion: 1,
    id: input.packId,
    name: `External Intake Draft: ${classification.source.name}`,
    version: DRAFT_PACK_VERSION,
    description: `Draft MatOS asset pack classified from external ${classification.source.kind} "${classification.source.name}".`,
    metadata: {
      sourceFormat: 'matos-external-intake-draft-pack',
      draftedAt: input.now,
      intake: {
        intakeId: intake.intakeId,
        intakeRef: intake.intakeRef,
        sourcePath: intake.sourcePath,
        sourceKind: intake.sourceKind,
        ...(intake.fingerprint ? { sourceFingerprint: intake.fingerprint } : {}),
        ...(intake.acquisition ? { acquisition: intake.acquisition } : {}),
        fileCount: intake.fileCount,
        scannedFileCount: intake.scannedFileCount,
        truncated: intake.truncated,
        classifier: classification.classifier,
        primaryType: classification.primaryType,
      },
    },
  }
}

/**
 * Executable-mode writer: renders manifests plus real entry files (tool.py
 * wrappers, KNOWLEDGE.md summaries, SKILL.md guides, workflow.yaml,
 * benchmark case.json) purely from the previewed plan, so apply writes
 * exactly what the confirmation fingerprint covered.
 */
async function writeExecutableIntakeDraftAssets(input: {
  cwd: string
  classification: MatOSExternalIntakeClassification
  plan: MatOSWorkbenchExternalIntakeDraftPackPlan
  now: string
}): Promise<void> {
  const { plan, classification } = input
  if (!plan.executable) {
    throw new Error('writeExecutableIntakeDraftAssets requires an executable plan.')
  }
  const plannedAssets: MatOSExternalIntakeExecutablePlannedAsset[] =
    plan.proposedAssets.map(asset => {
      if (!asset.role || !asset.entryFile || !asset.files) {
        throw new Error(
          `Executable intake plan entry is missing render metadata: ${asset.ref}`,
        )
      }
      return {
        type: asset.type,
        id: asset.id,
        ref: asset.ref,
        version: asset.version,
        primary: asset.primary,
        score: asset.score,
        confidence: asset.confidence,
        manifestRelativePath: asset.manifestRelativePath,
        entryRelativePath: asset.entryRelativePath,
        role: asset.role,
        entryFile: asset.entryFile,
        files: asset.files,
        executable: asset.executable === true,
      }
    })
  const executablePlan: MatOSExternalIntakeExecutablePlan = {
    mode: 'executable',
    planner: plan.executable.planner,
    proposedAssets: plannedAssets,
    ...(plan.executable.toolWrapper
      ? { toolWrapper: plan.executable.toolWrapper }
      : {}),
    ...(plan.executable.readmeDigest
      ? { readmeDigest: plan.executable.readmeDigest }
      : {}),
    ...(plan.executable.paper ? { paper: plan.executable.paper } : {}),
    ...(plan.executable.llmAssist ? { llmAssist: plan.executable.llmAssist } : {}),
    notes: plan.executable.notes,
  }
  const renderContext: MatOSExternalIntakeRenderContext = {
    cwd: input.cwd,
    classification,
    plan: executablePlan,
    intake: plan.intake,
    now: input.now,
  }
  const classifiedRefs = plannedAssets
    .filter(asset => asset.role === 'classified')
    .map(asset => asset.ref)
  const knowledgeRef = plannedAssets.find(
    asset => asset.role === 'classified' && asset.type === 'knowledge',
  )?.ref

  for (const planned of plannedAssets) {
    const classifiedProposal = classification.proposals.find(
      proposal => proposal.ref === planned.ref,
    )
    const proposal: MatOSExternalIntakeProposal =
      classifiedProposal ?? {
        type: planned.type,
        id: planned.id,
        ref: planned.ref,
        version: planned.version,
        primary: false,
        score: 0,
        confidence: 0,
        reasons: [planned.role],
        evidence: [],
      }
    const extras = externalIntakeExecutableManifestExtras(renderContext, planned)
    const manifest = draftAssetManifest({
      classification,
      proposal,
      intake: plan.intake,
      bundleRefs: classifiedRefs,
      now: input.now,
    })
    manifest.entry = extras.entry
    const baseTags = Array.isArray(manifest.tags) ? (manifest.tags as string[]) : []
    manifest.tags = [...new Set([...baseTags, ...extras.tags])]
    if (extras.runtime) {
      manifest.runtime = extras.runtime
    }
    if (
      planned.role === 'derived-skill-protocol' &&
      knowledgeRef &&
      knowledgeRef !== planned.ref
    ) {
      manifest.dependencies = [knowledgeRef]
    }
    manifest.metadata = {
      ...(manifest.metadata as Record<string, unknown>),
      ...extras.metadata,
    }
    const assetDirAbsolute = resolve(
      input.cwd,
      planned.manifestRelativePath.replace(/\/asset\.json$/, ''),
    )
    await mkdir(assetDirAbsolute, { recursive: true })
    await writeFile(
      join(assetDirAbsolute, 'asset.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    const referenceEntry = draftAssetEntry({
      classification,
      proposal,
      intake: plan.intake,
      now: input.now,
    })
    for (const file of renderExternalIntakeExecutableFiles(
      renderContext,
      planned,
      referenceEntry,
    )) {
      await writeFile(join(assetDirAbsolute, file.fileName), file.content, 'utf8')
    }
  }
}

export async function previewMatOSWorkbenchExternalIntakeDraftPack(
  input: MatOSWorkbenchContext & {
    path: string
    packId?: string
    withBenchmark?: boolean
    executable?: boolean
    llmAssist?: boolean
    llmAssistModel?: string
  },
): Promise<MatOSWorkbenchExternalIntakeDraftPackPreview> {
  const acquisition = await acquireMatOSExternalIntakeSource({
    cwd: input.cwd,
    source: input.path,
  })
  const classification = await classifyMatOSExternalIntakeSource({
    cwd: input.cwd,
    path: acquisition.localPath,
  })
  if (acquisition.issues.some(issue => issue.severity === 'error')) {
    classification.validation.ok = false
  }
  const intake = await describeIntakeSource({ cwd: input.cwd, classification, acquisition })
  const issues: DraftPackIssue[] = [...acquisition.issues, ...classification.validation.issues]

  const requestedPackId = input.packId?.trim()
  if (requestedPackId && !DRAFT_PACK_ID_PATTERN.test(requestedPackId)) {
    issues.push({
      code: 'invalid_pack_id',
      severity: 'error',
      message:
        'External intake draft --pack-id must be lowercase alphanumeric/hyphen (max 64 chars), starting with a letter or digit.',
    })
  }
  const packId =
    requestedPackId && DRAFT_PACK_ID_PATTERN.test(requestedPackId)
      ? requestedPackId
      : intake.intakeId
  const targetPackRelativePath = `.matos/assets/packs/${packId}`

  // Executable mode (repo2asset/paper2asset last mile): optional LLM assist,
  // paper text extraction + summary, entrypoint detection, and derived
  // skill/benchmark assets. All heavy inputs are cached or deterministic so
  // preview and apply plan identically under the confirmation fingerprint.
  let executablePlan: MatOSExternalIntakeExecutablePlan | undefined
  if (input.executable && classification.validation.ok) {
    const llmAssist = input.llmAssist
      ? await refineMatOSExternalIntakeWithLlm({
          cwd: input.cwd,
          classification,
          fingerprint: intake.fingerprint,
          model: input.llmAssistModel,
        })
      : undefined
    let paperExtraction: MatOSExternalIntakePaperExtraction | undefined
    let paperSummary: MatOSExternalIntakePaperSummary | undefined
    if (classification.source.kind !== 'repository') {
      const extracted = await extractMatOSExternalIntakePaperText({
        cwd: input.cwd,
        classification,
      })
      paperExtraction = extracted.extraction
      if (input.llmAssist && extracted.extraction.ok && extracted.text) {
        paperSummary = await summarizeMatOSExternalIntakePaperWithLlm({
          cwd: input.cwd,
          classification,
          extraction: extracted.extraction,
          text: extracted.text,
          model: input.llmAssistModel,
        })
      }
    }
    executablePlan = await planMatOSExternalIntakeExecutableAssets({
      classification,
      targetPackRelativePath,
      ...(llmAssist ? { llmAssist } : {}),
      ...(paperExtraction ? { paperExtraction } : {}),
      ...(paperSummary ? { paperSummary } : {}),
      ...(input.withBenchmark ? { withBenchmark: true } : {}),
    })
  }

  const proposedAssets: MatOSWorkbenchExternalIntakeDraftPackPlan['proposedAssets'] =
    executablePlan
      ? executablePlan.proposedAssets.map(planned => ({ ...planned }))
      : classification.proposals.map(proposal => ({
          type: proposal.type,
          id: proposal.id,
          ref: proposal.ref,
          version: proposal.version,
          primary: proposal.primary,
          score: proposal.score,
          confidence: proposal.confidence,
          manifestRelativePath: `${targetPackRelativePath}/${proposal.type}/${proposal.id}/asset.json`,
          entryRelativePath: `${targetPackRelativePath}/${proposal.type}/${proposal.id}/${ENTRY_FILE_NAME}`,
        }))
  if (classification.validation.ok && proposedAssets.length === 0) {
    issues.push({
      code: 'no_draftable_proposals',
      severity: 'error',
      message: 'External intake classification produced no draftable asset proposals.',
    })
  }
  if (await pathExists(resolve(input.cwd, targetPackRelativePath))) {
    issues.push({
      code: 'target_pack_already_exists',
      severity: 'error',
      message: `External intake draft target pack already exists: ${targetPackRelativePath}`,
    })
  }
  if (classification.source.exists && proposedAssets.length > 0) {
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
      includeDisabled: true,
    })
    for (const proposed of proposedAssets) {
      const existing = registry.resolve(proposed.ref)
      if (existing) {
        issues.push({
          code: 'target_asset_already_exists',
          severity: 'error',
          message: `External intake draft target already exists: ${existing.canonicalKey} (${existing.manifestPath}).`,
        })
      }
    }
  }

  const plan: MatOSWorkbenchExternalIntakeDraftPackPlan = {
    operation: 'external-intake-draft-pack',
    intake,
    targetPack: {
      packId,
      relativePath: targetPackRelativePath,
      manifestRelativePath: `${targetPackRelativePath}/matos.pack.json`,
    },
    proposedAssets,
    ...(executablePlan
      ? {
          executable: {
            planner: executablePlan.planner,
            ...(executablePlan.toolWrapper
              ? { toolWrapper: executablePlan.toolWrapper }
              : {}),
            ...(executablePlan.readmeDigest
              ? { readmeDigest: executablePlan.readmeDigest }
              : {}),
            ...(executablePlan.paper ? { paper: executablePlan.paper } : {}),
            ...(executablePlan.llmAssist
              ? { llmAssist: executablePlan.llmAssist }
              : {}),
            notes: executablePlan.notes,
          },
        }
      : {}),
    provenance: {
      classifier: classification.classifier,
      intakeRef: intake.intakeRef,
      sourcePath: intake.sourcePath,
      ...(intake.fingerprint ? { sourceFingerprint: intake.fingerprint } : {}),
    },
  }
  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const warningCount = issues.filter(issue => issue.severity === 'warning').length
  const validationOk = errorCount === 0
  const primaryAsset = proposedAssets.find(asset => asset.primary)
  const transaction = previewMatOSWorkbenchWriteTransaction({
    source: 'coze-resource-ui',
    requestedMutation: 'external-intake-draft-pack',
    ...(primaryAsset ? { targetRef: primaryAsset.ref, targetType: primaryAsset.type } : {}),
    scopeRef: input.scopeRef,
    patch: plan,
    validationOk,
    errorCount,
    warningCount,
    validationEvidence: {
      issues,
      plan,
      classification: {
        primaryType: classification.primaryType,
        proposals: classification.proposals.map(proposal => proposal.ref),
        signals: classification.signals.map(signal => signal.code),
      },
    },
    deterministicSmoke: {
      ok: validationOk,
      summary: validationOk
        ? 'External intake draft preview classified the source deterministically and resolved a canonical target pack, asset refs, and provenance fingerprint.'
        : 'External intake draft preview is blocked before pack generation.',
      evidence: {
        sourceKind: intake.sourceKind,
        primaryType: classification.primaryType,
        proposedAssetCount: proposedAssets.length,
        targetPack: plan.targetPack,
      },
    },
    confirmationFingerprint: sha256Text(JSON.stringify({
      requestedMutation: 'external-intake-draft-pack',
      intake,
      targetPack: plan.targetPack,
      proposedAssets,
      ...(plan.executable
        ? { executable: stableExecutablePlanView(plan.executable) }
        : {}),
      validationOk,
      errorCount,
      warningCount,
    })),
  })
  const benchmark =
    input.withBenchmark && validationOk
      ? draftMatOSIntakeBenchmarkCase(plan)
      : undefined
  return {
    mode: 'external-intake-draft-pack-preview',
    source: 'matos-external-intake-classifier',
    classification,
    plan,
    validation: {
      ok: validationOk,
      issues,
    },
    write: {
      enabled: false,
      reason:
        'External intake draft is a native MatOS controlled-write preview; applying it generates a draft asset pack with history snapshots, asset validation, secret scan, rollback, and audit evidence.',
    },
    ...(benchmark ? { benchmark } : {}),
    transaction,
  }
}

async function validateExternalIntakeDraftPackAssets(input: {
  cwd: string
  plan: MatOSWorkbenchExternalIntakeDraftPackPlan
  writtenPaths: string[]
}): Promise<MatOSWorkbenchExternalIntakeDraftPackValidation> {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const resolvedAssetRefs: string[] = []
  const missingAssetRefs: string[] = []
  const packAssets = []
  for (const proposed of input.plan.proposedAssets) {
    const asset = registry.resolve(proposed.ref)
    if (asset) {
      resolvedAssetRefs.push(proposed.ref)
      packAssets.push(asset)
    } else {
      missingAssetRefs.push(proposed.ref)
    }
  }
  const assetValidation = await validateMatOSAssets(packAssets, {
    includeDisabled: true,
    includeDrafts: true,
  })
  const findings: Array<{ path: string; reason: string }> = []
  for (const writtenPath of input.writtenPaths) {
    const absolutePath = resolve(input.cwd, writtenPath)
    try {
      const info = await lstat(absolutePath)
      if (!info.isFile() || info.size > SECRET_SCAN_MAX_BYTES) {
        continue
      }
      if (hasMatOSSecretLookingContent(await readFile(absolutePath, 'utf8'))) {
        findings.push({
          path: writtenPath,
          reason: 'Generated draft file contains secret-looking content.',
        })
      }
    } catch {
      // missing files are reported through missingAssetRefs / asset validation
    }
  }
  return {
    ok: assetValidation.ok && missingAssetRefs.length === 0 && findings.length === 0,
    gateProfile: 'draft-pack',
    assetValidation: {
      ok: assetValidation.ok,
      errors: assetValidation.errors,
    },
    resolvedAssetRefs,
    missingAssetRefs,
    secretScan: {
      ok: findings.length === 0,
      findings,
    },
  }
}

export async function applyMatOSWorkbenchExternalIntakeDraftPack(
  input: MatOSWorkbenchContext & {
    path: string
    packId?: string
    fingerprint: string
    reason?: string
    withBenchmark?: boolean
    executable?: boolean
    llmAssist?: boolean
    llmAssistModel?: string
  },
): Promise<MatOSWorkbenchExternalIntakeDraftPackApplyResult> {
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'workbench-search-intake-draft',
  }, async () => {
    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack(input)
    if (!preview.validation.ok) {
      throw new Error('External intake draft apply is blocked because preview validation failed.')
    }
    if (input.fingerprint !== preview.transaction.confirmationFingerprint) {
      throw new Error(
        'External intake draft confirmation fingerprint does not match the current MatOS draft transaction.',
      )
    }
    const plan = preview.plan
    const targetPackPath = resolve(input.cwd, plan.targetPack.relativePath)
    const allowedRoot = resolve(input.cwd, '.matos', 'assets', 'packs')
    if (!isWithin(targetPackPath, allowedRoot)) {
      throw new Error(
        `External intake draft target must be below .matos/assets/packs: ${workspaceRelative(input.cwd, targetPackPath)}`,
      )
    }
    await assertNoSymlinkPathComponent({ cwd: input.cwd, absolutePath: targetPackPath })
    if (await pathExists(targetPackPath)) {
      throw new Error(
        `External intake draft target pack already exists: ${workspaceRelative(input.cwd, targetPackPath)}`,
      )
    }

    const writtenPaths = [
      plan.targetPack.manifestRelativePath,
      ...plan.proposedAssets.flatMap(asset => {
        const assetDir = asset.manifestRelativePath.replace(/\/asset\.json$/, '')
        const entryFiles =
          plan.executable && asset.files
            ? asset.files.map(file => `${assetDir}/${file}`)
            : [asset.entryRelativePath]
        return [asset.manifestRelativePath, ...entryFiles]
      }),
    ]
    const assetRefs = plan.proposedAssets.map(asset => asset.ref)
    const beforeSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      message: `external intake draft before ${plan.targetPack.packId}`,
      paths: writtenPaths,
      assetRefs,
      provenance: {
        source: 'matos-workbench',
        operation: 'search.intake-draft',
        intakeRef: plan.intake.intakeRef,
        sourcePath: plan.intake.sourcePath,
        ...(plan.intake.fingerprint ? { sourceFingerprint: plan.intake.fingerprint } : {}),
        confirmationFingerprint: preview.transaction.confirmationFingerprint,
        reason: input.reason,
      },
    })

    const rolledBackResult = (input2: {
      validation: MatOSWorkbenchExternalIntakeDraftPackValidation
      reason: string
      after?: SnapshotSummary
      rollback?: SnapshotSummary
    }): MatOSWorkbenchExternalIntakeDraftPackApplyResult => ({
      mode: 'external-intake-draft-pack-controlled-write',
      source: 'matos-external-intake-classifier',
      applied: false,
      readonly: false,
      preview,
      transaction: preview.transaction,
      plan,
      targetPackPath: workspaceRelative(input.cwd, targetPackPath),
      writtenPaths,
      snapshots: {
        before: snapshotSummary(beforeSnapshot),
        ...(input2.after ? { after: input2.after } : {}),
        ...(input2.rollback ? { rollback: input2.rollback } : {}),
      },
      validation: input2.validation,
      write: {
        enabled: true,
        status: 'rolled-back',
        reason: input2.reason,
      },
      audit: {
        target: 'matos-asset-history',
        operation: 'search.intake-draft',
        reason: input.reason,
      },
    })

    try {
      const now = new Date().toISOString()
      const packManifestPath = resolve(input.cwd, plan.targetPack.manifestRelativePath)
      await mkdir(dirname(packManifestPath), { recursive: true })
      await writeFile(
        packManifestPath,
        `${JSON.stringify(draftPackManifest({
          classification: preview.classification,
          intake: plan.intake,
          packId: plan.targetPack.packId,
          now,
        }), null, 2)}\n`,
        'utf8',
      )
      if (plan.executable) {
        await writeExecutableIntakeDraftAssets({
          cwd: input.cwd,
          classification: preview.classification,
          plan,
          now,
        })
      } else {
        const bundleRefs = preview.classification.proposals.map(proposal => proposal.ref)
        for (const proposal of preview.classification.proposals) {
          const proposed = plan.proposedAssets.find(asset => asset.ref === proposal.ref)
          if (!proposed) {
            continue
          }
          const manifestPath = resolve(input.cwd, proposed.manifestRelativePath)
          const entryPath = resolve(input.cwd, proposed.entryRelativePath)
          await mkdir(dirname(manifestPath), { recursive: true })
          await writeFile(
            manifestPath,
            `${JSON.stringify(draftAssetManifest({
              classification: preview.classification,
              proposal,
              intake: plan.intake,
              bundleRefs,
              now,
            }), null, 2)}\n`,
            'utf8',
          )
          await writeFile(
            entryPath,
            draftAssetEntry({
              classification: preview.classification,
              proposal,
              intake: plan.intake,
              now,
            }),
            'utf8',
          )
        }
      }

      const validation = await validateExternalIntakeDraftPackAssets({
        cwd: input.cwd,
        plan,
        writtenPaths,
      })
      if (!validation.secretScan.ok) {
        // Secret-looking generated content must never enter asset-history
        // snapshots (the snapshot layer refuses it), so remove the freshly
        // created pack directly; preview guaranteed the path did not exist.
        await rm(targetPackPath, { recursive: true, force: true })
        return rolledBackResult({
          validation,
          reason:
            'Generated draft pack content tripped the MatOS secret scan; the pack was removed without snapshotting its content.',
        })
      }

      const afterSnapshot = await createMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        kind: 'manual',
        scope: 'project',
        parentCommit: beforeSnapshot.commit,
        message: `external intake draft after ${plan.targetPack.packId}`,
        paths: writtenPaths,
        assetRefs,
        provenance: {
          source: 'matos-workbench',
          operation: 'search.intake-draft',
          intakeRef: plan.intake.intakeRef,
          sourcePath: plan.intake.sourcePath,
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
          message: `external intake draft rollback ${plan.targetPack.packId}`,
          paths: writtenPaths,
          assetRefs,
          provenance: {
            source: 'matos-workbench',
            operation: 'search.intake-draft.rollback',
            intakeRef: plan.intake.intakeRef,
            beforeSnapshot: beforeSnapshot.snapshotId,
            afterSnapshot: afterSnapshot.snapshotId,
            confirmationFingerprint: preview.transaction.confirmationFingerprint,
            reason: 'post-write draft pack validation failed',
          },
        })
        return rolledBackResult({
          validation,
          reason: 'Post-write draft pack validation failed; MatOS restored the before snapshot.',
          after: snapshotSummary(afterSnapshot),
          rollback: snapshotSummary(rollbackSnapshot),
        })
      }

      return {
        mode: 'external-intake-draft-pack-controlled-write',
        source: 'matos-external-intake-classifier',
        applied: true,
        readonly: false,
        preview,
        transaction: preview.transaction,
        plan,
        targetPackPath: workspaceRelative(input.cwd, targetPackPath),
        writtenPaths,
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
          operation: 'search.intake-draft',
          reason: input.reason,
        },
      }
    } catch (error) {
      // The pack directory was created by this apply (preview guarantees it
      // did not exist), so removing it restores the before-state exactly.
      await rm(targetPackPath, { recursive: true, force: true })
      throw error
    }
  })
}
