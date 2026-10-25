import { describe, expect, it } from 'vitest';

import {
  composeNativeMatOSUserInput,
  normalizeCommentAttachments,
} from '../../src/runtimes/chat-prompt-inputs.js';

const FORBIDDEN_OPEN_DESIGN_PROMPT_MARKERS = [
  '# Instructions',
  '# User request',
  'OD core directives',
  'MatOS core directives',
  'Runtime tool environment',
  'question-form',
  'TodoWrite',
  '<od-title>',
  'Identity and workflow charter',
  'Active stage',
];

describe('native MatOS user-input transport', () => {
  it('forwards a new conversation without any Open Design prompt policy', () => {
    const input = composeNativeMatOSUserInput({
      transcript: '## user\nRun a silicon band-structure calculation.',
      currentPrompt: 'Run a silicon band-structure calculation.',
      attachments: ['POSCAR'],
      imagePaths: ['/workspace/group/shared/reference.png'],
    });

    expect(input).toContain('Run a silicon band-structure calculation.');
    expect(input).toContain('@POSCAR');
    expect(input).toContain('@/workspace/group/shared/reference.png');
    for (const marker of FORBIDDEN_OPEN_DESIGN_PROMPT_MARKERS) {
      expect(input).not.toContain(marker);
    }
  });

  it('sends only the latest user turn on native-session resume', () => {
    const input = composeNativeMatOSUserInput({
      transcript: '## user\nold request\n\n## assistant\nold answer',
      currentPrompt: 'Continue from the converged structure.',
      isResuming: true,
    });

    expect(input).toBe('Continue from the converged structure.');
    expect(input).not.toContain('old request');
    expect(input).not.toContain('old answer');
  });

  it('serializes explicit preview annotations as user context without OD directives', () => {
    const comments = normalizeCommentAttachments([
      {
        elementId: 'plot-1',
        filePath: 'report.html',
        selector: '#band-plot',
        comment: 'Label the Fermi level clearly.',
      },
    ]);
    const input = composeNativeMatOSUserInput({
      currentPrompt: 'Apply my annotation.',
      isResuming: true,
      commentAttachments: comments,
    });

    expect(input).toContain('Label the Fermi level clearly.');
    expect(input).toContain('report.html');
    expect(input).not.toContain('Hard scope:');
    for (const marker of FORBIDDEN_OPEN_DESIGN_PROMPT_MARKERS) {
      expect(input).not.toContain(marker);
    }
  });

  it('does not invent placeholder instructions for an annotation-only turn', () => {
    const comments = normalizeCommentAttachments([
      {
        filePath: 'report.html',
        elementId: 'plot-legend',
        selector: '#plot-legend',
        comment: 'Keep the legend outside the plot.',
      },
    ]);
    const input = composeNativeMatOSUserInput({ commentAttachments: comments });

    expect(input).toContain('Keep the legend outside the plot.');
    expect(input).not.toContain('No extra typed instruction');
  });
});
