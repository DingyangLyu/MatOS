// Characterization test for renderMetadataBlock (internal to system.ts).
// composeSystemPrompt pushes the metadata block as its final part and gates
// every later part behind `!isAskMode`, so composing in 'chat' (ask) mode and slicing
// from the "## Project metadata" marker yields exactly the metadata block.
// These snapshots pin the block across kinds/flags so the decomposition of
// renderMetadataBlock into per-concern helpers is provably behavior-preserving.

import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';
import type { ProjectMetadata, ProjectTemplate } from '../src/api/projects.js';

function metadataBlock(metadata: ProjectMetadata, template?: ProjectTemplate): string {
  const out = composeSystemPrompt({ metadata, template, sessionMode: 'chat' });
  const idx = out.indexOf('\n\n## Project metadata');
  return idx === -1 ? '' : out.slice(idx);
}

describe('renderMetadataBlock (characterization via composeSystemPrompt chat-mode)', () => {
  it('prototype with platform, cross-platform targets, and flags', () => {
    const block = metadataBlock({
      kind: 'prototype',
      platform: 'responsive',
      platformTargets: ['responsive', 'mobile-ios'],
      includeLandingPage: true,
      includeOsWidgets: true,
      fidelity: 'high-fidelity',
    } as ProjectMetadata);
    expect(block).toMatchSnapshot();
  });

  it('prototype with unknown platform and no fidelity (asks)', () => {
    const block = metadataBlock({ kind: 'prototype' } as ProjectMetadata);
    expect(block).toMatchSnapshot();
  });

  it('deck with slideCount and speakerNotes', () => {
    const block = metadataBlock({
      kind: 'deck',
      slideCount: '12',
      speakerNotes: true,
    } as ProjectMetadata);
    expect(block).toMatchSnapshot();
  });

  it('template kind with template reference files', () => {
    const template: ProjectTemplate = {
      id: 't1',
      name: 'Neon Dashboard',
      description: 'a dark neon dashboard',
      createdAt: 0,
      files: [{ name: 'index.html', content: '<html><body>hi</body></html>' }],
    };
    const block = metadataBlock(
      { kind: 'template', animations: true, templateLabel: 'Neon' } as ProjectMetadata,
      template,
    );
    expect(block).toMatchSnapshot();
  });


});
