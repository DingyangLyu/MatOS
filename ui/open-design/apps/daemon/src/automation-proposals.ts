import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AutomationEvolutionProposal,
  AutomationProposalStatus,
  CreateAutomationEvolutionProposalRequest,
} from '@open-design/contracts';

import { upsertUserAutomationTemplate } from './automation-templates.js';
import { execMatOS, execMatOSJsonReport } from './services/matos-cli.js';

const STORE_DIR = 'automation-proposals';
const STORE_FILE = 'proposals.json';
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VALID_STATUSES = new Set<AutomationProposalStatus>([
  'draft',
  'pending-review',
  'applied',
  'rejected',
  'superseded',
  'failed',
]);

function storePath(dataDir: string): string {
  return path.join(dataDir, STORE_DIR, STORE_FILE);
}

async function writeProposals(dataDir: string, proposals: AutomationEvolutionProposal[]): Promise<void> {
  const file = storePath(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ proposals }, null, 2));
}

export async function listAutomationProposals(
  dataDir: string,
  opts: { status?: AutomationProposalStatus | 'all' } = {},
): Promise<AutomationEvolutionProposal[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(storePath(dataDir), 'utf8'));
  } catch {
    return [];
  }
  const proposals = Array.isArray((parsed as { proposals?: unknown }).proposals)
    ? ((parsed as { proposals: AutomationEvolutionProposal[] }).proposals)
    : [];
  const filtered =
    opts.status && opts.status !== 'all'
      ? proposals.filter((proposal) => proposal.status === opts.status)
      : proposals;
  return filtered.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getAutomationProposal(
  dataDir: string,
  id: string,
): Promise<AutomationEvolutionProposal | null> {
  const proposals = await listAutomationProposals(dataDir, { status: 'all' });
  return proposals.find((proposal) => proposal.id === id) ?? null;
}

export async function createAutomationProposal(
  dataDir: string,
  input: CreateAutomationEvolutionProposalRequest & {
    id?: string;
    status?: AutomationProposalStatus;
  },
): Promise<AutomationEvolutionProposal> {
  const now = new Date().toISOString();
  if (!input || typeof input !== 'object') throw new Error('proposal body is required');
  if (typeof input.title !== 'string' || !input.title.trim()) {
    throw new Error('proposal title is required');
  }
  if (typeof input.summary !== 'string' || !input.summary.trim()) {
    throw new Error('proposal summary is required');
  }
  if (!input.patch || typeof input.patch !== 'object') {
    throw new Error('proposal patch is required');
  }
  const status =
    input.status && VALID_STATUSES.has(input.status)
      ? input.status
      : 'pending-review';
  const proposal: AutomationEvolutionProposal = {
    id:
      typeof input.id === 'string' && input.id.trim()
        ? input.id.trim()
        : `proposal_${randomUUID()}`,
    title: input.title.trim(),
    summary: input.summary.trim(),
    targetKind: input.targetKind,
    action: input.action,
    status,
    reviewPolicy: input.reviewPolicy ?? 'always',
    createdAt: now,
    updatedAt: now,
    sourcePacketIds: Array.isArray(input.sourcePacketIds)
      ? input.sourcePacketIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
    ...(typeof input.automationRunId === 'string' ? { automationRunId: input.automationRunId } : {}),
    ...(typeof input.targetRef === 'string' ? { targetRef: input.targetRef } : {}),
    patch: input.patch,
    ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
    ...(input.compressionReport ? { compressionReport: input.compressionReport } : {}),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  const proposals = await listAutomationProposals(dataDir, { status: 'all' });
  const next = proposals.filter((existing) => existing.id !== proposal.id);
  next.push(proposal);
  await writeProposals(dataDir, next);
  return proposal;
}

function assertReviewable(proposal: AutomationEvolutionProposal): void {
  if (proposal.status === 'pending-review' || proposal.status === 'draft') return;
  throw new Error(`proposal ${proposal.id} is ${proposal.status}, not reviewable`);
}

function parseJsonPatchAfter(proposal: AutomationEvolutionProposal): Record<string, unknown> {
  if (proposal.patch.format !== 'json') return {};
  const after = proposal.patch.after;
  if (typeof after !== 'string' || !after.trim()) return {};
  try {
    const parsed = JSON.parse(after);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('proposal patch.after is not valid JSON');
  }
}

function slugifyTarget(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return SAFE_SLUG.test(cleaned) ? cleaned : `evolved-${Date.now().toString(36)}`;
}

function metadataRecord(proposal: AutomationEvolutionProposal): Record<string, unknown> {
  return proposal.metadata && typeof proposal.metadata === 'object' && !Array.isArray(proposal.metadata)
    ? proposal.metadata as Record<string, unknown>
    : {};
}

function targetSlugFor(proposal: AutomationEvolutionProposal): string {
  // `skill:<id>` is the MatOS asset ref; `skills/<id>/SKILL.md` is kept for
  // proposals recorded before skills became MatOS assets.
  const ref = typeof proposal.targetRef === 'string' ? proposal.targetRef : '';
  const fromRef = /^skill:([^@/]+)(?:@[^/]+)?$/.exec(ref)?.[1] ?? /^skills\/([^/]+)\/SKILL\.md$/.exec(ref)?.[1];
  if (fromRef && SAFE_SLUG.test(fromRef)) return fromRef;
  const metadata = metadataRecord(proposal);
  if (typeof metadata.slug === 'string' && SAFE_SLUG.test(metadata.slug)) return metadata.slug;
  return slugifyTarget(proposal.title);
}

function proposalAfterMarkdown(proposal: AutomationEvolutionProposal): string {
  if (typeof proposal.patch.after !== 'string' || !proposal.patch.after.trim()) {
    throw new Error('proposal patch.after markdown is required');
  }
  return proposal.patch.after.trimEnd() + '\n';
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const block = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1];
  const line = block?.split('\n').find((entry) => entry.startsWith(`${key}:`));
  const raw = line?.slice(key.length + 1).trim() ?? '';
  const value = /^"(.*)"$/.test(raw) ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
  return value || undefined;
}

type MatOSAssetEditResult = {
  ok?: boolean;
  action?: string;
  assetRef?: string;
  error?: string;
  asset?: { sourceScopeRef?: string };
};

// Skills become MatOS skill assets in the current user scope, written through
// the native accepted-ref governance so MatOS runs can discover and use them.
async function applySkillProposal(proposal: AutomationEvolutionProposal) {
  const slug = targetSlugFor(proposal);
  const ref = `skill:${slug}`;
  if (proposal.action === 'delete') {
    await execMatOS(['assets', 'disable', ref, '--reason', `Automation proposal ${proposal.id}`]);
    return { skillRef: ref, action: 'delete' };
  }
  const markdown = proposalAfterMarkdown(proposal);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'matos-skill-proposal-'));
  try {
    const file = path.join(dir, 'SKILL.md');
    await fsp.writeFile(file, markdown, 'utf8');
    const result = (await execMatOSJsonReport([
      'assets', 'edit',
      '--type', 'skill',
      '--id', slug,
      '--name', frontmatterValue(markdown, 'name') ?? proposal.title.replace(/^Skill:\s*/, ''),
      '--description', frontmatterValue(markdown, 'description') ?? proposal.summary,
      '--content-file', file,
      '--action', 'upsert',
      '--reason', `Automation proposal ${proposal.id}`,
      '--json',
    ])) as MatOSAssetEditResult;
    if (result.ok !== true) {
      throw new Error(result.error || `MatOS could not write ${ref}`);
    }
    return {
      skillRef: result.assetRef ?? ref,
      action: result.action ?? proposal.action,
      ...(result.asset?.sourceScopeRef ? { scopeRef: result.asset.sourceScopeRef } : {}),
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function applyAutomationTemplateProposal(
  dataDir: string,
  proposal: AutomationEvolutionProposal,
) {
  if (proposal.action === 'delete') {
    throw new Error('automation-template delete proposals are not supported yet');
  }
  const patch = parseJsonPatchAfter(proposal);
  const template = await upsertUserAutomationTemplate(dataDir, patch);
  return {
    automationTemplateId: template.id,
    action: proposal.action,
    path: `automation-templates/${template.id}.json`,
  };
}

async function updateProposalStatus(
  dataDir: string,
  id: string,
  status: AutomationProposalStatus,
  metadataPatch: Record<string, unknown> = {},
): Promise<AutomationEvolutionProposal> {
  const proposals = await listAutomationProposals(dataDir, { status: 'all' });
  const index = proposals.findIndex((proposal) => proposal.id === id);
  if (index < 0) throw new Error('automation proposal not found');
  const current = proposals[index]!;
  const next: AutomationEvolutionProposal = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
  };
  if (Object.keys(metadataPatch).length > 0) {
    const currentMetadata =
      current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
        ? current.metadata as Record<string, unknown>
        : {};
    next.metadata = {
      ...currentMetadata,
      ...metadataPatch,
    } as NonNullable<AutomationEvolutionProposal['metadata']>;
  } else if (current.metadata !== undefined) {
    next.metadata = current.metadata as NonNullable<AutomationEvolutionProposal['metadata']>;
  }
  proposals[index] = next;
  await writeProposals(dataDir, proposals);
  return next;
}

export async function applyAutomationProposal(dataDir: string, id: string) {
  const proposal = await getAutomationProposal(dataDir, id);
  if (!proposal) throw new Error('automation proposal not found');
  assertReviewable(proposal);
  let result;
  if (proposal.targetKind === 'skill') {
    result = await applySkillProposal(proposal);
  } else if (proposal.targetKind === 'automation-template') {
    result = await applyAutomationTemplateProposal(dataDir, proposal);
  } else {
    throw new Error(`proposal target ${proposal.targetKind} needs a specialized applier`);
  }
  const next = await updateProposalStatus(dataDir, id, 'applied', { appliedResult: result });
  return { proposal: next, result };
}

export async function rejectAutomationProposal(
  dataDir: string,
  id: string,
  reason?: string,
) {
  const proposal = await getAutomationProposal(dataDir, id);
  if (!proposal) throw new Error('automation proposal not found');
  assertReviewable(proposal);
  return updateProposalStatus(
    dataDir,
    id,
    'rejected',
    typeof reason === 'string' && reason.trim() ? { rejectedReason: reason.trim() } : {},
  );
}
