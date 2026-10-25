import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getAutomationTemplate,
  listAllAutomationTemplates,
  listAutomationTemplates,
  upsertUserAutomationTemplate,
} from '../src/automation-templates.js';

describe('automation templates catalog', () => {
  it('exposes the self-evolution skill template', () => {
    const templates = listAutomationTemplates();
    const ids = templates.map((template) => template.id);

    expect(ids).toEqual(['crystallize-run-into-skill']);
    expect(ids).not.toContain('extract-design-system');
    expect(ids).not.toContain('promote-artifact-style');
    expect(templates.some((template) => template.outputSinks.includes('skill'))).toBe(true);
  });

  it('fetches one template by id', () => {
    expect(getAutomationTemplate('crystallize-run-into-skill')).toMatchObject({
      id: 'crystallize-run-into-skill',
      outputSinks: ['skill'],
      reviewPolicy: 'always',
      tokenCompression: 'balanced',
    });
    expect(getAutomationTemplate('missing')).toBeNull();
  });

  it('includes reviewed user templates after proposal apply', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-automation-templates-'));
    try {
      await upsertUserAutomationTemplate(dataDir, {
        id: 'reviewed-context-digest',
        title: 'Reviewed context digest',
        description: 'A reviewed automation template persisted under runtime data.',
        purpose: 'Let accepted automation patterns become reusable templates.',
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
      });

      await expect(listAllAutomationTemplates(dataDir)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'reviewed-context-digest' })]),
      );
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });
});
