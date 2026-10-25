import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { hasMatOSSecretLookingContent } from '../assets/secretScan.js'
import {
  createMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  withMatOSAssetHistoryLock,
} from '../assets/history/index.js'
import type { MatOSAsset, MatOSAssetValidationError } from '../assets/types.js'
import { matOSToolReferenceToAssetId } from '../tools/toolNames.js'
import { getMatOSDir } from '../project.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'
import {
  readMatOSUserTestLogEpisode,
  type MatOSUserTestLogEpisode,
} from './userTestLogIntake.js'
import {
  readMatOSWorkflowReplayCandidate,
  replayCandidateIdForRun,
} from './replayCandidates.js'

/**
 * Failure2Asset proposal drafting.
 *
 * Turns one teaching episode into deterministic, reviewable
 * evolution proposals plus (in a later stage) a draft asset pack:
 *
 *   .matos/evolution/proposals/<proposal-id>/proposal.json
 *   .matos/assets/packs/<evolution-pack-id>/...
 *
 * Generation is deterministic and LLM-free. Episodes already carry redacted
 * excerpts only, and every generated file passes the MatOS secret scan before
 * it is snapshotted, so failure evidence never leaks secrets into assets.
 */

export const MATOS_EVOLUTION_PROPOSAL_GENERATOR = {
  id: 'matos-failure2asset-proposals',
  version: 1,
  deterministic: true as const,
}

const PROPOSAL_ASSET_VERSION = '0.1.0'
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SECRET_SCAN_MAX_BYTES = 1024 * 1024
const RUNBOOK_ENTRY = 'KNOWLEDGE.md'

export type MatOSEvolutionProposalAction =
  | 'patch-asset'
  | 'create-knowledge-runbook'
  | 'create-tool-preflight'
  | 'patch-workflow-recovery'
  | 'create-benchmark'
  | 'core-runtime-fix'

export type MatOSEvolutionProposalGateStatus =
  | 'pending'
  | 'generated'
  | 'drafted'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'rolled-back'

export type MatOSEvolutionProposalPlannedAsset = {
  type: 'knowledge' | 'tool'
  id: string
  ref: string
  version: string
  role: 'runbook' | 'preflight-tool'
  entry: string
}

export type MatOSEvolutionProposalBenchmarkPlan = {
  kind: 'workflow-run' | 'tool-call' | 'artifact-check'
  subjectRef: string
  replayCandidateId?: string
  reason: string
}

export type MatOSEvolutionProposal = {
  schemaVersion: 1
  proposalId: string
  episodeId: string
  intakeId?: string
  createdAt: string
  updatedAt: string
  status: 'draft'
  scopeRef?: string
  episodeKind: MatOSUserTestLogEpisode['kind']
  action: MatOSEvolutionProposalAction
  title: string
  summary: string
  diagnosis: {
    observedFailure?: string
    userIntent?: string
    laterFixed?: boolean
    suspectedRefs: string[]
    resolvedAssetRefs: Array<{
      ref: string
      canonicalKey: string
      type: string
      manifestPath: string
    }>
  }
  plannedAssets: MatOSEvolutionProposalPlannedAsset[]
  benchmarkPlan: MatOSEvolutionProposalBenchmarkPlan
  targetPack: {
    packId: string
    relativePath: string
  }
  evidenceRefs: MatOSUserTestLogEpisode['evidenceRefs']
  gates: {
    draftAssets: {
      status: MatOSEvolutionProposalGateStatus
      packPath?: string
      assetRefs?: string[]
      at?: string
      reason?: string
    }
    benchmark: {
      status: MatOSEvolutionProposalGateStatus
      caseId?: string
      casePath?: string
      at?: string
      reason?: string
    }
    validation: {
      status: MatOSEvolutionProposalGateStatus
      ok?: boolean
      resultId?: string
      resultPath?: string
      at?: string
      reason?: string
    }
    promotion: {
      status: 'blocked'
      reason: string
    }
  }
  provenance: {
    episodeRef: string
    intakeRef?: string
    generator: typeof MATOS_EVOLUTION_PROPOSAL_GENERATOR
  }
  privacy: { redacted: true; scopeRef?: string }
  path?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function proposalsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'proposals')
}

function proposalDir(cwd: string, proposalId: string): string {
  const safe = assertSafeEvolutionRecordId(proposalId, 'evolution proposal id')
  return assertPathStaysUnderRoot(
    proposalsDir(cwd),
    join(proposalsDir(cwd), safe),
  )
}

export function matOSEvolutionProposalPath(
  cwd: string,
  proposalId: string,
): string {
  return join(proposalDir(cwd, proposalId), 'proposal.json')
}

export function matOSEvolutionProposalBenchmarkDir(
  cwd: string,
  proposalId: string,
): string {
  return join(proposalDir(cwd, proposalId), 'benchmark')
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function refWithoutVersion(ref: string): string {
  return ref.replace(/@[^@]+$/, '')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * Proposal ids reuse the episode identity so one episode maps to a stable,
 * discoverable proposal family: `proposal-<episode-suffix>-p<n>`.
 */
export function proposalIdForEpisode(episodeId: string, index: number): string {
  const base = slugify(episodeId.replace(/^episode-/, ''), shortHash(episodeId))
  return `proposal-${base}-p${index}`
}

export function evolutionPackIdForProposal(proposalId: string): string {
  const base = slugify(proposalId.replace(/^proposal-/, ''), shortHash(proposalId))
  const packId = `evolution-${base}`.slice(0, 64).replace(/-+$/, '')
  if (!PACK_ID_PATTERN.test(packId)) {
    return `evolution-${shortHash(proposalId)}`
  }
  return packId
}

type SuspectedToolTarget = {
  toolName: string
  assetRef?: string
  asset?: MatOSAsset
}

function resolveSuspectedTool(
  registry: ReturnType<typeof buildMatOSAssetRegistry>,
  suspectedRef: string,
): SuspectedToolTarget {
  const toolName = suspectedRef.replace(/^tool:/, '')
  const candidates = [
    suspectedRef,
    `tool:${matOSToolReferenceToAssetId(toolName)}`,
    `tool:${slugify(toolName, toolName)}`,
  ]
  for (const candidate of candidates) {
    const asset = registry.resolve(candidate)
    if (asset && asset.type === 'tool') {
      return { toolName, assetRef: asset.canonicalKey, asset }
    }
  }
  return { toolName }
}

function resolvedAssetSummary(asset: MatOSAsset): {
  ref: string
  canonicalKey: string
  type: string
  manifestPath: string
} {
  return {
    ref: refWithoutVersion(asset.canonicalKey),
    canonicalKey: asset.canonicalKey,
    type: asset.type,
    manifestPath: asset.manifestPath,
  }
}

export type GenerateMatOSEvolutionProposalsInput = {
  cwd: string
  episodeId: string
}

export type GenerateMatOSEvolutionProposalsResult = {
  episode: MatOSUserTestLogEpisode
  proposals: MatOSEvolutionProposal[]
  proposalPaths: string[]
}

/**
 * Deterministic episode -> proposal derivation:
 *
 * - workflow-failure  -> patch-workflow-recovery (workflow asset resolves) or
 *                        create-knowledge-runbook; workflow-run replay
 *                        benchmark, reusing an existing replay candidate when
 *                        the failed run already produced one.
 * - tool-failure      -> create-tool-preflight when the failing tool maps to a
 *                        tool asset (tool-call benchmark over the generated
 *                        preflight); otherwise a knowledge runbook with an
 *                        artifact-check benchmark.
 * - session-failure / user-feedback -> knowledge runbook with an
 *                        artifact-check benchmark over the generated runbook.
 */
export async function generateMatOSEvolutionProposals(
  input: GenerateMatOSEvolutionProposalsInput,
): Promise<GenerateMatOSEvolutionProposalsResult> {
  const episode = await readMatOSUserTestLogEpisode(input.cwd, input.episodeId)
  if (!episode) {
    throw new Error(`MatOS evolution episode not found: ${input.episodeId}`)
  }
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  const createdAt = nowIso()
  const proposals: MatOSEvolutionProposal[] = []

  type ProposalBase = {
    schemaVersion: 1
    proposalId: string
    episodeId: string
    intakeId?: string
    createdAt: string
    updatedAt: string
    status: 'draft'
    scopeRef?: string
    episodeKind: MatOSUserTestLogEpisode['kind']
    evidenceRefs: MatOSUserTestLogEpisode['evidenceRefs']
    privacy: MatOSUserTestLogEpisode['privacy']
  }
  const base = (index: number): ProposalBase => ({
    schemaVersion: 1,
    proposalId: proposalIdForEpisode(episode.episodeId, index),
    episodeId: episode.episodeId,
    ...(episode.intakeId ? { intakeId: episode.intakeId } : {}),
    createdAt,
    updatedAt: createdAt,
    status: 'draft',
    ...(episode.scopeRef ? { scopeRef: episode.scopeRef } : {}),
    episodeKind: episode.kind,
    evidenceRefs: episode.evidenceRefs,
    privacy: episode.privacy,
  })

  const gates = (): MatOSEvolutionProposal['gates'] => ({
    draftAssets: { status: 'pending' },
    benchmark: { status: 'pending' },
    validation: { status: 'pending' },
    promotion: {
      status: 'blocked',
      reason:
        'Draft-first: explicit review and promotion are required before this proposal leaves draft scope.',
    },
  })

  const provenance = (): MatOSEvolutionProposal['provenance'] => ({
    episodeRef: `evolution-episode:${episode.episodeId}`,
    ...(episode.intakeId
      ? { intakeRef: `evolution-intake:${episode.intakeId}` }
      : {}),
    generator: MATOS_EVOLUTION_PROPOSAL_GENERATOR,
  })

  const diagnosis = (
    resolvedAssets: MatOSAsset[],
  ): MatOSEvolutionProposal['diagnosis'] => ({
    ...(episode.observedFailure
      ? { observedFailure: episode.observedFailure }
      : {}),
    ...(episode.userIntent ? { userIntent: episode.userIntent } : {}),
    ...(episode.laterFixed !== undefined
      ? { laterFixed: episode.laterFixed }
      : {}),
    suspectedRefs: episode.suspectedRefs,
    resolvedAssetRefs: resolvedAssets.map(resolvedAssetSummary),
  })

  const runbookSlugSource =
    episode.suspectedRefs[0] ?? episode.kind
  const runbookSlug = slugify(
    refWithoutVersion(runbookSlugSource).replace(/^[a-z-]+:/, ''),
    episode.kind,
  ).slice(0, 40).replace(/-+$/, '') || episode.kind
  const episodeHash = shortHash(episode.episodeId)

  const runbookAsset = (): MatOSEvolutionProposalPlannedAsset => ({
    type: 'knowledge',
    id: `runbook-${runbookSlug}-${episodeHash}`,
    ref: `knowledge:runbook-${runbookSlug}-${episodeHash}@${PROPOSAL_ASSET_VERSION}`,
    version: PROPOSAL_ASSET_VERSION,
    role: 'runbook',
    entry: RUNBOOK_ENTRY,
  })

  if (episode.kind === 'workflow-failure') {
    const suspectedWorkflowRef = episode.suspectedRefs[0] ?? ''
    const workflowAsset = suspectedWorkflowRef
      ? registry.resolve(suspectedWorkflowRef)
      : undefined
    const runId = episode.evidenceRefs.workflowRunIds?.[0]
    const replayCandidate = runId
      ? await readMatOSWorkflowReplayCandidate(
          input.cwd,
          replayCandidateIdForRun(runId),
        ).catch(() => undefined)
      : undefined
    const proposal: MatOSEvolutionProposal = {
      ...base(proposals.length),
      action: workflowAsset ? 'patch-workflow-recovery' : 'create-knowledge-runbook',
      title: `Repair workflow failure: ${suspectedWorkflowRef || 'unknown workflow'}`,
      summary:
        `${episode.summary} Draft a recovery runbook` +
        `${workflowAsset ? ' and a recovery patch plan for the existing workflow asset' : ''},` +
        ' plus a replayable workflow-run regression benchmark.',
      diagnosis: diagnosis(workflowAsset ? [workflowAsset] : []),
      plannedAssets: [runbookAsset()],
      benchmarkPlan: {
        kind: 'workflow-run',
        subjectRef:
          episode.benchmarkCandidate?.ref ?? suspectedWorkflowRef ?? 'unknown',
        ...(replayCandidate
          ? { replayCandidateId: replayCandidate.candidateId }
          : {}),
        reason: replayCandidate
          ? 'Replays the recorded failed run parameters from the existing replay candidate.'
          : 'Replays the failed workflow ref with empty parameters; review before running.',
      },
      targetPack: { packId: '', relativePath: '' },
      gates: gates(),
      provenance: provenance(),
    }
    proposal.targetPack = packTargetFor(proposal.proposalId)
    proposals.push(proposal)
  } else if (episode.kind === 'tool-failure') {
    const suspected = episode.suspectedRefs[0] ?? 'tool:unknown'
    const target = resolveSuspectedTool(registry, suspected)
    if (target.asset) {
      const preflightId = `preflight-${slugify(target.asset.id, 'tool')}-${episodeHash}`
      const proposal: MatOSEvolutionProposal = {
        ...base(proposals.length),
        action: 'create-tool-preflight',
        title: `Add preflight for failing tool: ${target.asset.canonicalKey}`,
        summary:
          `${episode.summary} Draft an executable preflight tool asset that verifies the` +
          ' failing tool asset contract (manifest, entry, schema, interpreter) plus a runbook,' +
          ' and a tool-call regression benchmark over the preflight.',
        diagnosis: diagnosis([target.asset]),
        plannedAssets: [
          runbookAsset(),
          {
            type: 'tool',
            id: preflightId,
            ref: `tool:${preflightId}@${PROPOSAL_ASSET_VERSION}`,
            version: PROPOSAL_ASSET_VERSION,
            role: 'preflight-tool',
            entry: './tool.py',
          },
        ],
        benchmarkPlan: {
          kind: 'tool-call',
          subjectRef: `tool:${preflightId}@${PROPOSAL_ASSET_VERSION}`,
          reason:
            'Runs the generated preflight tool for real and asserts the failing tool asset contract holds.',
        },
        targetPack: { packId: '', relativePath: '' },
        gates: gates(),
        provenance: provenance(),
      }
      proposal.targetPack = packTargetFor(proposal.proposalId)
      proposals.push(proposal)
    } else {
      const proposal: MatOSEvolutionProposal = {
        ...base(proposals.length),
        action: 'create-knowledge-runbook',
        title: `Draft runbook for failing tool: ${target.toolName}`,
        summary:
          `${episode.summary} The failing tool is not a MatOS tool asset, so draft a` +
          ' troubleshooting runbook plus an artifact-check benchmark over the runbook.',
        diagnosis: diagnosis([]),
        plannedAssets: [runbookAsset()],
        benchmarkPlan: {
          kind: 'artifact-check',
          subjectRef: runbookAsset().ref,
          reason:
            'Deterministic artifact-check: the generated runbook must persist the episode provenance.',
        },
        targetPack: { packId: '', relativePath: '' },
        gates: gates(),
        provenance: provenance(),
      }
      proposal.targetPack = packTargetFor(proposal.proposalId)
      proposals.push(proposal)
    }
  } else {
    const roleRef = episode.suspectedRefs.find(ref => ref.startsWith('role:'))
    const roleAsset = roleRef ? registry.resolve(roleRef) : undefined
    const proposal: MatOSEvolutionProposal = {
      ...base(proposals.length),
      action: 'create-knowledge-runbook',
      title:
        episode.kind === 'session-failure'
          ? `Draft runbook for failed session${roleRef ? ` (${roleRef})` : ''}`
          : `Draft runbook from user feedback: ${episode.summary.slice(0, 80)}`,
      summary:
        `${episode.summary} Draft a troubleshooting runbook capturing the redacted evidence` +
        ' plus an artifact-check benchmark over the runbook.',
      diagnosis: diagnosis(roleAsset ? [roleAsset] : []),
      plannedAssets: [runbookAsset()],
      benchmarkPlan: {
        kind: 'artifact-check',
        subjectRef: runbookAsset().ref,
        reason:
          'Deterministic artifact-check: the generated runbook must persist the episode provenance.',
      },
      targetPack: { packId: '', relativePath: '' },
      gates: gates(),
      provenance: provenance(),
    }
    proposal.targetPack = packTargetFor(proposal.proposalId)
    proposals.push(proposal)
  }

  const proposalPaths: string[] = []
  for (const proposal of proposals) {
    const path = matOSEvolutionProposalPath(input.cwd, proposal.proposalId)
    await writeJson(path, proposal)
    proposalPaths.push(path)
    proposal.path = path
  }
  return { episode, proposals, proposalPaths }
}

function packTargetFor(proposalId: string): MatOSEvolutionProposal['targetPack'] {
  const packId = evolutionPackIdForProposal(proposalId)
  return {
    packId,
    relativePath: `.matos/assets/packs/${packId}`,
  }
}

export async function readMatOSEvolutionProposal(
  cwd: string,
  proposalId: string,
): Promise<MatOSEvolutionProposal | undefined> {
  const path = matOSEvolutionProposalPath(cwd, proposalId)
  if (!(await pathExists(path))) {
    return undefined
  }
  const proposal = await readJson<MatOSEvolutionProposal>(path)
  return proposal.schemaVersion === 1 ? { ...proposal, path } : undefined
}

export async function listMatOSEvolutionProposals(
  cwd: string,
): Promise<MatOSEvolutionProposal[]> {
  const dir = proposalsDir(cwd)
  if (!(await pathExists(dir))) {
    return []
  }
  const proposals: MatOSEvolutionProposal[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const proposal = await readMatOSEvolutionProposal(cwd, entry.name).catch(
      () => undefined,
    )
    if (proposal) {
      proposals.push(proposal)
    }
  }
  return proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function updateMatOSEvolutionProposalGates(
  cwd: string,
  proposalId: string,
  patch: Partial<MatOSEvolutionProposal['gates']>,
): Promise<MatOSEvolutionProposal> {
  const proposal = await readMatOSEvolutionProposal(cwd, proposalId)
  if (!proposal) {
    throw new Error(`MatOS evolution proposal not found: ${proposalId}`)
  }
  const updated: MatOSEvolutionProposal = {
    ...proposal,
    gates: { ...proposal.gates, ...patch },
    updatedAt: nowIso(),
  }
  delete updated.path
  const path = matOSEvolutionProposalPath(cwd, proposalId)
  await writeJson(path, updated)
  return { ...updated, path }
}

// ---------------------------------------------------------------------------
// Draft asset pack generation (proposal -> .matos/assets/packs/<pack-id>)
// ---------------------------------------------------------------------------

export type MatOSEvolutionDraftAssetsResult = {
  proposalId: string
  applied: boolean
  status: 'applied' | 'rolled-back'
  reason?: string
  targetPackPath: string
  writtenPaths: string[]
  assetRefs: string[]
  snapshots: {
    before: string
    after?: string
    rollback?: string
  }
  validation: {
    ok: boolean
    gateProfile: 'evolution-draft-pack'
    assetValidation: { ok: boolean; errors: MatOSAssetValidationError[] }
    resolvedAssetRefs: string[]
    missingAssetRefs: string[]
    secretScan: { ok: boolean; findings: Array<{ path: string; reason: string }> }
  }
  proposal: MatOSEvolutionProposal
}

function runbookEntryText(input: {
  proposal: MatOSEvolutionProposal
  now: string
}): string {
  const { proposal } = input
  const evidence = proposal.evidenceRefs
  const lines = [
    `# ${proposal.title}`,
    '',
    proposal.summary,
    '',
    '## Failure evidence (redacted)',
    '',
    `- Episode: ${proposal.episodeId} (${proposal.episodeKind})`,
    ...(proposal.intakeId ? [`- Intake: ${proposal.intakeId}`] : []),
    ...(proposal.diagnosis.userIntent
      ? [`- User intent: ${proposal.diagnosis.userIntent}`]
      : []),
    ...(proposal.diagnosis.observedFailure
      ? [`- Observed failure: ${proposal.diagnosis.observedFailure}`]
      : []),
    ...(proposal.diagnosis.laterFixed !== undefined
      ? [`- Later fixed inside the window: ${proposal.diagnosis.laterFixed}`]
      : []),
    `- Suspected refs: ${proposal.diagnosis.suspectedRefs.join(', ') || 'none'}`,
    ...(evidence.workflowRunIds?.length
      ? [`- Workflow runs: ${evidence.workflowRunIds.join(', ')}`]
      : []),
    ...(evidence.sessionIds?.length
      ? [`- Sessions: ${evidence.sessionIds.join(', ')}`]
      : []),
    ...(evidence.traceIds?.length
      ? [`- Traces: ${evidence.traceIds.join(', ')}`]
      : []),
    ...(evidence.feedbackIds?.length
      ? [`- Feedback reports: ${evidence.feedbackIds.join(', ')}`]
      : []),
    '',
    '## Triage checklist',
    '',
    ...(proposal.episodeKind === 'workflow-failure'
      ? [
          '1. Inspect the failed run: `matos workflow inspect <run-id> --json`.',
          '2. Reproduce with the drafted workflow-run benchmark before changing assets.',
          '3. Prefer adding a preflight/validate/recovery node over editing tool code.',
          '4. Re-run the benchmark after the fix; it must pass before promotion.',
        ]
      : proposal.episodeKind === 'tool-failure'
        ? [
            '1. Run the drafted preflight tool (or re-run the failing tool with minimal input).',
            '2. Check the tool asset contract: manifest, entry, input schema, interpreter.',
            '3. Fix schema/prompt/preflight in the tool asset rather than core runtime code.',
            '4. Re-run the drafted benchmark after the fix; it must pass before promotion.',
          ]
        : [
            '1. Read the redacted evidence above and the linked session/trace records.',
            '2. Decide whether the fix belongs in a role, skill, tool, MCP, or knowledge asset.',
            '3. Apply the smallest asset change that prevents the failure from recurring.',
            '4. Keep this runbook updated with the final resolution.',
          ]),
    '',
    '## Provenance',
    '',
    `- Proposal: ${proposal.proposalId}`,
    `- Generator: ${MATOS_EVOLUTION_PROPOSAL_GENERATOR.id} v${MATOS_EVOLUTION_PROPOSAL_GENERATOR.version} (deterministic)`,
    `- Drafted at: ${input.now}`,
    '- Privacy: redacted evidence only; raw transcripts stay in their original stores.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

function preflightToolScript(input: {
  targetManifestRelPathFromToolDir: string
  targetRef: string
}): string {
  return `#!/usr/bin/env python3
"""MatOS generated preflight for ${input.targetRef}.

Deterministically verifies the failing tool asset's execution contract before
agents call it again: manifest parses, executor entry exists, input schema
parses, and the executor runtime interpreter is resolvable.

Contract (MatOS asset tool runner):
  stdin : {"input": {"manifestPath"?: str}}
  stdout: one JSON object {"ok": bool, "target": str, "checks": [...]}
"""
import json
import os
import sys
from shutil import which

DEFAULT_TARGET = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 ${JSON.stringify(input.targetManifestRelPathFromToolDir)})
)


def read_input() -> dict:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def main() -> int:
    data = read_input()
    manifest_path = str(data.get("manifestPath") or DEFAULT_TARGET)
    checks = []

    def check(key: str, ok: bool, message: str) -> bool:
        checks.append({"key": key, "ok": bool(ok), "message": message})
        return bool(ok)

    ok = check("manifest-exists", os.path.isfile(manifest_path),
               f"tool asset manifest exists: {manifest_path}")
    manifest = {}
    if ok:
        try:
            with open(manifest_path, "r", encoding="utf8") as handle:
                manifest = json.load(handle)
            check("manifest-parses", True, "manifest is valid JSON")
        except Exception as exc:  # noqa: BLE001 - report, never crash
            ok = check("manifest-parses", False, f"manifest parse failed: {exc}")
    tool_dir = os.path.dirname(manifest_path)
    metadata = manifest.get("metadata") or {}
    executor = metadata.get("executor") or {}
    entry = executor.get("entry") or manifest.get("entry")
    if entry:
        entry_path = os.path.normpath(os.path.join(tool_dir, str(entry)))
        ok = check("entry-exists", os.path.isfile(entry_path),
                   f"executor entry exists: {entry_path}") and ok
    else:
        ok = check("entry-declared", False,
                   "manifest declares no executor entry") and ok
    schema_rel = metadata.get("inputSchemaPath")
    if schema_rel:
        schema_path = os.path.normpath(os.path.join(tool_dir, str(schema_rel)))
        exists = os.path.isfile(schema_path)
        parsed = False
        if exists:
            try:
                with open(schema_path, "r", encoding="utf8") as handle:
                    json.load(handle)
                parsed = True
            except Exception:  # noqa: BLE001
                parsed = False
        ok = check("input-schema", exists and parsed,
                   f"input schema exists and parses: {schema_path}") and ok
    runtime = str(executor.get("runtime") or "python3")
    ok = check("runtime-available", which(runtime) is not None,
               f"executor runtime resolvable on PATH: {runtime}") and ok

    print(json.dumps({
        "ok": bool(ok),
        "target": ${JSON.stringify(input.targetRef)},
        "manifestPath": manifest_path,
        "checks": checks,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`
}

const PREFLIGHT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    manifestPath: {
      type: 'string',
      description:
        'Optional override for the target tool asset manifest path. Defaults to the manifest recorded when this preflight was drafted.',
    },
  },
  additionalProperties: false,
}

function preflightPrompt(targetRef: string): string {
  return [
    `Run this preflight before calling ${targetRef} again after a failure.`,
    'It verifies the tool asset manifest, executor entry, input schema, and runtime',
    'interpreter, and returns machine-readable JSON:',
    '`{"ok": bool, "target": str, "checks": [{"key", "ok", "message"}]}`.',
    'If `ok` is false, fix the reported contract issue in the tool asset before retrying.',
    '',
  ].join('\n')
}

function draftAssetManifestFor(input: {
  proposal: MatOSEvolutionProposal
  planned: MatOSEvolutionProposalPlannedAsset
  now: string
  extraMetadata?: Record<string, unknown>
  dependencies?: string[]
}): Record<string, unknown> {
  const { proposal, planned } = input
  return {
    schemaVersion: 1,
    id: planned.id,
    type: planned.type,
    name:
      planned.role === 'runbook'
        ? `Runbook: ${proposal.title}`
        : `Preflight: ${proposal.title}`,
    version: planned.version,
    description:
      planned.role === 'runbook'
        ? `Failure2Asset runbook drafted from evolution episode ${proposal.episodeId}.`
        : `Failure2Asset executable preflight drafted from evolution episode ${proposal.episodeId}.`,
    entry: planned.entry,
    tags: [
      'evolution',
      'failure2asset',
      'draft',
      proposal.episodeKind,
      planned.role,
    ],
    ...(input.dependencies && input.dependencies.length > 0
      ? { dependencies: input.dependencies }
      : {}),
    lifecycle: {
      status: 'draft',
      reason: 'Failure2Asset draft pending review before activation.',
      origin: 'matos-failure2asset',
    },
    metadata: {
      sourceFormat: 'matos-failure2asset-draft',
      draftedAt: input.now,
      proposal: {
        proposalId: proposal.proposalId,
        episodeId: proposal.episodeId,
        ...(proposal.intakeId ? { intakeId: proposal.intakeId } : {}),
        action: proposal.action,
        episodeKind: proposal.episodeKind,
      },
      provenance: proposal.provenance,
      ...(input.extraMetadata ?? {}),
    },
  }
}

async function validateEvolutionDraftPack(input: {
  cwd: string
  assetRefs: string[]
  writtenPaths: string[]
}): Promise<MatOSEvolutionDraftAssetsResult['validation']> {
  const assets = await loadMatOSAssets(input.cwd)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const resolvedAssetRefs: string[] = []
  const missingAssetRefs: string[] = []
  const packAssets: MatOSAsset[] = []
  for (const ref of input.assetRefs) {
    const asset = registry.resolve(ref)
    if (asset) {
      resolvedAssetRefs.push(ref)
      packAssets.push(asset)
    } else {
      missingAssetRefs.push(ref)
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
      // missing files surface through missingAssetRefs / asset validation
    }
  }
  return {
    ok:
      assetValidation.ok && missingAssetRefs.length === 0 && findings.length === 0,
    gateProfile: 'evolution-draft-pack',
    assetValidation: { ok: assetValidation.ok, errors: assetValidation.errors },
    resolvedAssetRefs,
    missingAssetRefs,
    secretScan: { ok: findings.length === 0, findings },
  }
}

/**
 * Generates the draft asset pack for a proposal with the same controlled-write
 * guarantees as the external-intake draft packs: asset-history before/after
 * snapshots, draft-lifecycle validation, secret scan, and rollback on failure.
 */
export async function generateMatOSEvolutionDraftAssets(input: {
  cwd: string
  proposalId: string
}): Promise<MatOSEvolutionDraftAssetsResult> {
  const proposal = await readMatOSEvolutionProposal(input.cwd, input.proposalId)
  if (!proposal) {
    throw new Error(`MatOS evolution proposal not found: ${input.proposalId}`)
  }
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'evolution-proposal-draft-assets',
  }, async () => {
    const now = nowIso()
    const packRelativePath = proposal.targetPack.relativePath
    const targetPackPath = resolve(input.cwd, packRelativePath)
    const allowedRoot = resolve(input.cwd, '.matos', 'assets', 'packs')
    assertPathStaysUnderRoot(allowedRoot, targetPackPath)
    if (await pathExists(targetPackPath)) {
      throw new Error(
        `Evolution draft pack target already exists: ${packRelativePath}`,
      )
    }

    const files: Array<{ relativePath: string; content: string }> = []
    const packManifest = {
      schemaVersion: 1,
      id: proposal.targetPack.packId,
      name: `Failure2Asset Draft: ${proposal.title}`,
      version: PROPOSAL_ASSET_VERSION,
      description: `Draft MatOS asset pack generated from evolution proposal ${proposal.proposalId}.`,
      metadata: {
        sourceFormat: 'matos-failure2asset-draft-pack',
        draftedAt: now,
        proposal: {
          proposalId: proposal.proposalId,
          episodeId: proposal.episodeId,
          ...(proposal.intakeId ? { intakeId: proposal.intakeId } : {}),
          action: proposal.action,
          episodeKind: proposal.episodeKind,
        },
        provenance: proposal.provenance,
      },
    }
    files.push({
      relativePath: `${packRelativePath}/matos.pack.json`,
      content: `${JSON.stringify(packManifest, null, 2)}\n`,
    })

    const assetRefs: string[] = []
    const runbook = proposal.plannedAssets.find(item => item.role === 'runbook')
    const preflight = proposal.plannedAssets.find(
      item => item.role === 'preflight-tool',
    )
    if (runbook) {
      const dir = `${packRelativePath}/knowledge/${runbook.id}`
      files.push({
        relativePath: `${dir}/asset.json`,
        content: `${JSON.stringify(draftAssetManifestFor({
          proposal,
          planned: runbook,
          now,
          dependencies: preflight ? [preflight.ref] : [],
        }), null, 2)}\n`,
      })
      files.push({
        relativePath: `${dir}/${RUNBOOK_ENTRY}`,
        content: runbookEntryText({ proposal, now }),
      })
      assetRefs.push(runbook.ref)
    }
    if (preflight) {
      const targetAsset = proposal.diagnosis.resolvedAssetRefs[0]
      if (!targetAsset) {
        throw new Error(
          `Evolution proposal ${proposal.proposalId} plans a preflight tool but resolved no target tool asset.`,
        )
      }
      const dir = `${packRelativePath}/tool/${preflight.id}`
      const toolDirAbsolute = resolve(input.cwd, dir)
      const targetManifestRelPathFromToolDir = relative(
        toolDirAbsolute,
        targetAsset.manifestPath,
      )
      files.push({
        relativePath: `${dir}/asset.json`,
        content: `${JSON.stringify(draftAssetManifestFor({
          proposal,
          planned: preflight,
          now,
          extraMetadata: {
            kind: 'external-tool',
            binding: `mcp__matos_asset__${preflight.id.replace(/[^a-zA-Z0-9_]+/g, '_')}`,
            promptPath: 'prompt.md',
            inputSchemaPath: 'input.schema.json',
            isReadOnly: true,
            isDestructive: false,
            executor: {
              type: 'matos-python',
              runtime: 'python3',
              entry: './tool.py',
              timeoutMs: 30000,
            },
            preflightTarget: {
              ref: targetAsset.canonicalKey,
              manifestPath: targetAsset.manifestPath,
            },
          },
        }), null, 2)}\n`,
      })
      files.push({
        relativePath: `${dir}/tool.py`,
        content: preflightToolScript({
          targetManifestRelPathFromToolDir,
          targetRef: targetAsset.canonicalKey,
        }),
      })
      files.push({
        relativePath: `${dir}/input.schema.json`,
        content: `${JSON.stringify(PREFLIGHT_INPUT_SCHEMA, null, 2)}\n`,
      })
      files.push({
        relativePath: `${dir}/prompt.md`,
        content: preflightPrompt(targetAsset.canonicalKey),
      })
      assetRefs.push(preflight.ref)
    }

    const writtenPaths = files.map(file => file.relativePath)
    const beforeSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      kind: 'manual',
      scope: 'project',
      message: `failure2asset draft before ${proposal.targetPack.packId}`,
      paths: writtenPaths,
      assetRefs,
      provenance: {
        source: 'matos-failure2asset',
        operation: 'evolve.draft-assets',
        proposalId: proposal.proposalId,
        episodeId: proposal.episodeId,
      },
    })

    const rolledBack = async (input2: {
      validation: MatOSEvolutionDraftAssetsResult['validation']
      reason: string
      after?: string
      rollback?: string
    }): Promise<MatOSEvolutionDraftAssetsResult> => {
      const updated = await updateMatOSEvolutionProposalGates(
        input.cwd,
        proposal.proposalId,
        {
          draftAssets: {
            status: 'rolled-back',
            reason: input2.reason,
            at: nowIso(),
          },
        },
      )
      return {
        proposalId: proposal.proposalId,
        applied: false,
        status: 'rolled-back',
        reason: input2.reason,
        targetPackPath: packRelativePath,
        writtenPaths,
        assetRefs,
        snapshots: {
          before: beforeSnapshot.snapshotId,
          ...(input2.after ? { after: input2.after } : {}),
          ...(input2.rollback ? { rollback: input2.rollback } : {}),
        },
        validation: input2.validation,
        proposal: updated,
      }
    }

    try {
      for (const file of files) {
        const absolutePath = resolve(input.cwd, file.relativePath)
        await mkdir(dirname(absolutePath), { recursive: true })
        await writeFile(absolutePath, file.content, 'utf8')
      }

      const validation = await validateEvolutionDraftPack({
        cwd: input.cwd,
        assetRefs,
        writtenPaths,
      })
      if (!validation.secretScan.ok) {
        // Secret-looking content must never enter asset-history snapshots;
        // remove the pack directly (preview guaranteed the dir was new).
        await rm(targetPackPath, { recursive: true, force: true })
        return rolledBack({
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
        message: `failure2asset draft after ${proposal.targetPack.packId}`,
        paths: writtenPaths,
        assetRefs,
        provenance: {
          source: 'matos-failure2asset',
          operation: 'evolve.draft-assets',
          proposalId: proposal.proposalId,
          episodeId: proposal.episodeId,
          beforeSnapshot: beforeSnapshot.snapshotId,
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
          message: `failure2asset draft rollback ${proposal.targetPack.packId}`,
          paths: writtenPaths,
          assetRefs,
          provenance: {
            source: 'matos-failure2asset',
            operation: 'evolve.draft-assets.rollback',
            proposalId: proposal.proposalId,
            beforeSnapshot: beforeSnapshot.snapshotId,
            afterSnapshot: afterSnapshot.snapshotId,
            reason: 'post-write draft pack validation failed',
          },
        })
        return rolledBack({
          validation,
          reason:
            'Post-write draft pack validation failed; MatOS restored the before snapshot.',
          after: afterSnapshot.snapshotId,
          rollback: rollbackSnapshot.snapshotId,
        })
      }

      const updated = await updateMatOSEvolutionProposalGates(
        input.cwd,
        proposal.proposalId,
        {
          draftAssets: {
            status: 'generated',
            packPath: packRelativePath,
            assetRefs,
            at: nowIso(),
          },
        },
      )
      return {
        proposalId: proposal.proposalId,
        applied: true,
        status: 'applied',
        targetPackPath: packRelativePath,
        writtenPaths,
        assetRefs,
        snapshots: {
          before: beforeSnapshot.snapshotId,
          after: afterSnapshot.snapshotId,
        },
        validation,
        proposal: updated,
      }
    } catch (error) {
      await rm(targetPackPath, { recursive: true, force: true })
      throw error
    }
  })
}
