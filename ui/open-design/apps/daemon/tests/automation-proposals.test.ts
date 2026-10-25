import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyAutomationProposal,
  createAutomationProposal,
  listAutomationProposals,
  rejectAutomationProposal,
} from '../src/automation-proposals.js';
import { listAllAutomationTemplates } from '../src/automation-templates.js';
import { execMatOS, execMatOSJsonReport } from '../src/services/matos-cli.js';

vi.mock('../src/services/matos-cli.js', () => ({
  execMatOS: vi.fn(async () => ({ stdout: '', stderr: '' })),
  execMatOSJsonReport: vi.fn(),
}));

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-automation-proposals-'));
});

afterEach(async () => {
  vi.mocked(execMatOS).mockClear();
  vi.mocked(execMatOSJsonReport).mockReset();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function skillProposal(id: string, targetRef: string, action: 'create' | 'delete' = 'create') {
  return createAutomationProposal(dataDir, {
    id,
    title: 'Skill: Reusable Flow',
    summary: 'Draft a reusable MatOS skill asset.',
    targetKind: 'skill',
    action,
    targetRef,
    patch: {
      format: 'markdown',
      after: [
        '---',
        'name: "Reusable \\"Flow\\""',
        'description: "Captured workflow"',
        '---',
        '',
        '# Reusable Flow',
      ].join('\n'),
    },
  });
}

describe('automation evolution proposals', () => {
  it('rejects a pending proposal without applying it', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-reject-1',
      title: 'Unwanted skill',
      summary: 'This should stay review-only.',
      targetKind: 'skill',
      action: 'create',
      targetRef: 'skill:unwanted',
      patch: {
        format: 'markdown',
        after: '- Avoid applying this proposal.',
      },
    });

    const rejected = await rejectAutomationProposal(dataDir, proposal.id, 'not durable');

    expect(rejected.status).toBe('rejected');
    expect(rejected.metadata).toMatchObject({ rejectedReason: 'not durable' });
    expect(await listAutomationProposals(dataDir, { status: 'pending-review' })).toEqual([]);
  });

  it('applies skill proposals as user-scope MatOS skill assets', async () => {
    let written = '';
    vi.mocked(execMatOSJsonReport).mockImplementation(async (args) => {
      written = await fsp.readFile(args[args.indexOf('--content-file') + 1]!, 'utf8');
      return {
        ok: true,
        action: 'create',
        assetRef: 'skill:reusable-flow@0.1.0',
        asset: { sourceScopeRef: 'user:local' },
      };
    });
    const proposal = await skillProposal('proposal-skill-1', 'skill:reusable-flow');

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    const args = vi.mocked(execMatOSJsonReport).mock.calls[0]![0];
    expect(args.slice(0, 8)).toEqual([
      'assets', 'edit', '--type', 'skill', '--id', 'reusable-flow', '--name', 'Reusable "Flow"',
    ]);
    expect(args).toEqual(expect.arrayContaining(['--description', 'Captured workflow', '--action', 'upsert', '--json']));
    expect(written).toContain('# Reusable Flow');
    await expect(fsp.stat(path.dirname(args[args.indexOf('--content-file') + 1]!))).rejects.toThrow();
    expect(applied.proposal.status).toBe('applied');
    expect(applied.result).toEqual({
      skillRef: 'skill:reusable-flow@0.1.0',
      action: 'create',
      scopeRef: 'user:local',
    });
  });

  it('keeps the proposal reviewable when MatOS refuses the skill write', async () => {
    vi.mocked(execMatOSJsonReport).mockResolvedValue({
      ok: false,
      error: 'Refusing to update skill:reusable-flow@0.1.0 through scoped asset_edit',
    });
    const proposal = await skillProposal('proposal-skill-refused', 'skill:reusable-flow');

    await expect(applyAutomationProposal(dataDir, proposal.id)).rejects.toThrow('Refusing to update');
    expect(await listAutomationProposals(dataDir, { status: 'pending-review' })).toEqual([
      expect.objectContaining({ id: 'proposal-skill-refused' }),
    ]);
  });

  it('reads legacy SKILL.md refs and disables the asset for delete proposals', async () => {
    const proposal = await skillProposal('proposal-skill-delete', 'skills/legacy-flow/SKILL.md', 'delete');

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(vi.mocked(execMatOS)).toHaveBeenCalledWith([
      'assets', 'disable', 'skill:legacy-flow', '--reason', 'Automation proposal proposal-skill-delete',
    ]);
    expect(applied.result).toEqual({ skillRef: 'skill:legacy-flow', action: 'delete' });
    expect(vi.mocked(execMatOSJsonReport)).not.toHaveBeenCalled();
  });

  it('applies automation-template proposals into the user template store', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-template-1',
      title: 'Draft automation template',
      summary: 'Create a user automation template.',
      targetKind: 'automation-template',
      action: 'create',
      patch: {
        format: 'json',
        after: JSON.stringify({
          id: 'daily-context',
          title: 'Daily context digest',
          description: 'Turn one trusted source into context proposals every day.',
          purpose: 'Self-evolve project context from recurring source material.',
          triggerKinds: ['schedule'],
          sourceKinds: ['repo'],
          stages: [
            { id: 'ingest', kind: 'ingest', title: 'Capture source' },
            { id: 'propose', kind: 'propose', title: 'Create proposals' },
          ],
          outputSinks: ['artifact', 'automation-template'],
          reviewPolicy: 'always',
          tokenCompression: 'balanced',
          tags: ['self-evolution'],
        }),
      },
    });

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(applied.result).toMatchObject({
      automationTemplateId: 'daily-context',
      path: 'automation-templates/daily-context.json',
    });
    await expect(listAllAutomationTemplates(dataDir)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'daily-context' })]),
    );
  });

  it('guards built-in automation templates from proposal overwrite', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-template-built-in-1',
      title: 'Overwrite built-in template',
      summary: 'This should remain protected.',
      targetKind: 'automation-template',
      action: 'update',
      patch: {
        format: 'json',
        after: JSON.stringify({
          id: 'crystallize-run-into-skill',
          title: 'Changed',
          description: 'Changed',
          purpose: 'Changed',
          triggerKinds: ['manual'],
          sourceKinds: ['chat'],
          stages: [{ id: 'propose', kind: 'propose', title: 'Propose' }],
          outputSinks: ['skill'],
          reviewPolicy: 'always',
          tokenCompression: 'off',
        }),
      },
    });

    await expect(applyAutomationProposal(dataDir, proposal.id)).rejects.toThrow(
      'cannot overwrite built-in automation template',
    );
  });
});
