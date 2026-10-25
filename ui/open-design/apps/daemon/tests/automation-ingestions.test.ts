import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAutomationSourcePacket,
  ingestAutomationSource,
  listAutomationSourcePackets,
} from '../src/automation-ingestions.js';
import {
  applyAutomationProposal,
  listAutomationProposals,
} from '../src/automation-proposals.js';
import { execMatOSJsonReport } from '../src/services/matos-cli.js';

vi.mock('../src/services/matos-cli.js', () => ({
  execMatOS: vi.fn(),
  execMatOSJsonReport: vi.fn(),
}));

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-automation-ingestions-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('automation source ingestion', () => {
  it('persists a repo source packet and creates an applyable skill proposal', async () => {
    const result = await ingestAutomationSource(dataDir, {
      sourceKind: 'repo',
      sourceRef: 'slack://C123/1710000000.000',
      title: 'Research review decision',
      bodyMarkdown: 'Decision: keep skill extraction behind human review.',
      tokenCompression: 'off',
    });

    expect(result.packet).toMatchObject({
      sourceKind: 'repo',
      title: 'Research review decision',
      sourceRef: 'slack://C123/1710000000.000',
      candidateSinks: ['skill'],
    });
    expect(result.compressionReport).toMatchObject({
      mode: 'off',
      status: 'skipped',
      preservedSourcePacketId: result.packet.id,
    });
    expect(await getAutomationSourcePacket(dataDir, result.packet.id)).toMatchObject({
      id: result.packet.id,
    });

    const proposals = await listAutomationProposals(dataDir, { status: 'pending-review' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      targetKind: 'skill',
      targetRef: expect.stringMatching(/^skill:[a-z0-9-]+$/),
      sourcePacketIds: [result.packet.id],
      compressionReport: {
        preservedSourcePacketId: result.packet.id,
      },
    });

    let written = '';
    vi.mocked(execMatOSJsonReport).mockImplementation(async (args) => {
      written = await fsp.readFile(args[args.indexOf('--content-file') + 1]!, 'utf8');
      return { ok: true, action: 'create', assetRef: `${proposals[0]!.targetRef}@0.1.0` };
    });
    const applied = await applyAutomationProposal(dataDir, proposals[0]!.id);
    expect(applied.result).toMatchObject({ skillRef: `${proposals[0]!.targetRef}@0.1.0` });
    expect(written).toContain('keep skill extraction behind human review');
  });

  it('uses the skill template to draft skill proposals with compression evidence', async () => {
    const longBody = `# Research notes\n\n${'Primary workflow step. '.repeat(400)}`;
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'crystallize-run-into-skill',
      sourceKind: 'repo',
      sourceRef: 'https://github.com/acme/research',
      title: 'Acme research notes',
      bodyMarkdown: longBody,
      tokenCompression: 'aggressive',
    });

    expect(result.compressionReport.status).toBe('applied');
    expect(result.compressionReport.afterTokens).toBeLessThan(
      result.compressionReport.beforeTokens,
    );
    expect(result.proposals.map((proposal) => proposal.targetKind).sort()).toEqual([
      'skill',
    ]);
    expect(result.proposals.find((proposal) => proposal.targetKind === 'skill')?.patch.after)
      .toContain('Acme research notes skill');

    const packets = await listAutomationSourcePackets(dataDir);
    expect(packets.map((packet) => packet.id)).toContain(result.packet.id);
  });
});
