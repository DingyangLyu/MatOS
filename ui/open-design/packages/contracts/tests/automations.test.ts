import { describe, expect, it } from 'vitest';

import {
  exampleAutomationContentPacket,
  exampleAutomationEvolutionProposal,
  exampleAutomationSourceIngestionResponse,
  exampleAutomationTemplate,
} from '../src/examples';

describe('automation self-evolution contracts', () => {
  it('represents one source packet flowing into a skill proposal', () => {
    expect(exampleAutomationTemplate.outputSinks).toEqual(['skill']);
    expect(exampleAutomationContentPacket.candidateSinks).toEqual(['skill']);
    expect(exampleAutomationEvolutionProposal.sourcePacketIds).toContain(exampleAutomationContentPacket.id);
  });

  it('keeps review and compression explicit before a proposal can be applied', () => {
    expect(exampleAutomationTemplate.reviewPolicy).toBe('always');
    expect(exampleAutomationTemplate.tokenCompression).toBe('balanced');
    expect(exampleAutomationEvolutionProposal.status).toBe('pending-review');
    expect(exampleAutomationEvolutionProposal.compressionReport).toMatchObject({
      mode: 'balanced',
      status: 'applied',
      preservedSourcePacketId: exampleAutomationContentPacket.id,
    });
  });

  it('models fast ingestion as packet plus generated proposals', () => {
    expect(exampleAutomationSourceIngestionResponse.packet.id).toBe(
      exampleAutomationContentPacket.id,
    );
    expect(exampleAutomationSourceIngestionResponse.proposals[0]?.sourcePacketIds).toContain(
      exampleAutomationContentPacket.id,
    );
  });
});
