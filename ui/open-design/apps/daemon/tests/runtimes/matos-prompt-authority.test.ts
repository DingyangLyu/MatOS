// Regression pin for the MatOS prompt-authority boundary (repo AGENTS.md):
// native MatOS role composition is the sole prompt authority. Open Design is
// UI + transport only, so no OD-origin prompt layer may reach a MatOS run
// through EITHER seam:
//   1. argv — matosAgentDef.buildArgs must never emit a prompt-carrying flag
//      (the role graph composes prompts inside the matos CLI);
//   2. routing — usesNativeMatOSPromptAuthority must classify every MatOS
//      agent id so startChatRunCore drops the OD system prompt, critique
//      passes, and hidden title/context tasks.
// The stdin transport seam is pinned separately in
// matos-native-prompt-policy.test.ts. If this test fails, an OD prompt layer
// is about to leak into MatOS chat — fix the leak, do not widen the list.

import { describe, expect, it } from 'vitest';

import { matosAgentDef } from '../../src/runtimes/defs/matos.js';
import {
  usesNativeMatOSProductMode,
  usesNativeMatOSPromptAuthority,
  usesOpenDesignCatalogs,
  usesOpenDesignRunPreparation,
} from '../../src/runtimes/matos-native-policy.js';

// Every claude-argv flag whose value would inject instruction text or an
// instruction-bearing bundle into the agent loop from outside MatOS.
const PROMPT_CARRYING_FLAGS = [
  '--system-prompt',
  '--append-system-prompt',
  '--agents',
  '--agent',
  '--plugin-dir',
  '--mcp-config',
  '--settings',
];

const DISTINCTIVE_PROMPT =
  'OD-PROMPT-SENTINEL: identity charter, critique pass';

function buildLoadedArgs(): string[] {
  return matosAgentDef.buildArgs(
    DISTINCTIVE_PROMPT,
    ['/workspace/group/shared/reference.png'],
    ['/workspace/group/shared'],
    { model: 'role:academic', reasoning: 'high' },
    {
      providerModel: 'deepseek-v4-pro',
      sessionMode: 'design',
      resumeSessionId: 'a1b2c3d4-1111-4111-8111-000000000001',
    },
  );
}

describe('MatOS prompt authority', () => {
  it('buildArgs never emits a prompt-carrying flag, in any configuration', () => {
    const configurations = [
      buildLoadedArgs(),
      matosAgentDef.buildArgs(DISTINCTIVE_PROMPT, [], [], {}, {}),
      matosAgentDef.buildArgs(
        DISTINCTIVE_PROMPT,
        [],
        [],
        { model: 'default' },
        { sessionMode: 'chat', newSessionId: 'a1b2c3d4-2222-4222-8222-000000000002' },
      ),
    ];
    for (const args of configurations) {
      for (const flag of PROMPT_CARRYING_FLAGS) {
        expect(args, `argv must not carry ${flag}`).not.toContain(flag);
      }
    }
  });

  it('keeps the prompt text out of argv entirely (stdin is the only prompt path)', () => {
    const args = buildLoadedArgs();
    for (const arg of args) {
      expect(arg).not.toContain('OD-PROMPT-SENTINEL');
    }
  });

  it('argv values stay limited to routing/config tokens, never sentence-like text', () => {
    // A prompt layer smuggled through any future flag would show up as a
    // multi-word value. Every legitimate buildArgs value today is a single
    // token (role ref, model id, path, uuid, mode, effort level).
    for (const arg of buildLoadedArgs()) {
      expect(arg, `argv token looks like injected prose: ${JSON.stringify(arg)}`).not.toMatch(/\s/);
    }
  });

  it('classifies every MatOS agent id as native prompt authority', () => {
    expect(usesNativeMatOSPromptAuthority('matos')).toBe(true);
    expect(usesNativeMatOSPromptAuthority('MatOS')).toBe(true);
    expect(usesNativeMatOSPromptAuthority(' matos ')).toBe(true);
    expect(usesNativeMatOSPromptAuthority('matos-lab')).toBe(true);
  });

  it('never claims authority for non-MatOS agents (OD composition must keep working there)', () => {
    for (const id of ['other-agent', 'custom-agent', '', null, undefined]) {
      expect(usesNativeMatOSPromptAuthority(id)).toBe(false);
    }
  });

  it('skips Open Design run preparation for every native MatOS agent', () => {
    for (const id of ['matos', 'MatOS', ' matos ', 'matos-lab']) {
      expect(usesOpenDesignRunPreparation(id)).toBe(false);
    }
    for (const id of ['other-agent', 'custom-agent']) {
      expect(usesOpenDesignRunPreparation(id)).toBe(true);
    }
  });

  it('disables upstream catalogues only in MatOS product mode', () => {
    expect(usesNativeMatOSProductMode({ MATOS_OPEN_DESIGN_ENABLED: '1' })).toBe(true);
    expect(usesNativeMatOSProductMode({ MATOS_OPEN_DESIGN_ENABLED: '0' })).toBe(false);
    expect(usesOpenDesignCatalogs({ MATOS_OPEN_DESIGN_ENABLED: '1' })).toBe(false);
    expect(usesOpenDesignCatalogs({ MATOS_OPEN_DESIGN_ENABLED: '0' })).toBe(true);
    expect(usesOpenDesignCatalogs({})).toBe(true);
  });

});
