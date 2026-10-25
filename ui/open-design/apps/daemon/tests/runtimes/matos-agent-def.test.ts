import { isHiddenMatOSRoleId } from '../../src/runtimes/defs/matos.js';
import { describe, expect, it } from 'vitest';
import {
  matosAgentDef,
  matosEffortForRun,
  matosPermissionModeForRun,
  parseMatOSRoleList,
} from '../../src/runtimes/defs/matos.js';

function optionValue(args: string[], option: string): string | undefined {
  const idx = args.indexOf(option);
  return idx === -1 ? undefined : args[idx + 1];
}

describe('matos agent def', () => {
  it('declares the claude-compatible streaming contract', () => {
    expect(matosAgentDef.streamFormat).toBe('claude-stream-json');
    expect(matosAgentDef.promptViaStdin).toBe(true);
    expect(matosAgentDef.promptInputFormat).toBe('stream-json');
    expect(matosAgentDef.supportsImagePaths).toBe(true);
    expect(matosAgentDef.resumesSessionViaCli).toBe(true);
    expect(matosAgentDef.externalMcpInjection).toBe('claude-mcp-json');
    expect(matosAgentDef.versionProbeTimeoutMs).toBeLessThanOrEqual(1_000);
    expect('listModels' in matosAgentDef).toBe(false);
  });

  it('exposes the MatOS effort levels as reasoning options', () => {
    const ids = (matosAgentDef.reasoningOptions ?? []).map((option) => option.id);
    expect(ids).toEqual(['default', 'low', 'medium', 'high', 'max']);
  });

  it('maps the picked role ref onto --role, not --model', () => {
    const args = matosAgentDef.buildArgs('prompt', [], [], { model: 'role:academic' }, {});
    expect(args.slice(0, 2)).toEqual(['--role', 'role:academic']);
    expect(args).not.toContain('--model');
    expect(args).toContain('-p');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('bypassPermissions');
  });

  it('omits --role for the default sentinel so MatOS env decides', () => {
    const args = matosAgentDef.buildArgs('prompt', [], [], { model: 'default' }, {});
    expect(args).not.toContain('--role');
  });

  it('forwards the provider-model override as --model, independent of the role', () => {
    const args = matosAgentDef.buildArgs(
      'prompt',
      [],
      [],
      { model: 'role:compute' },
      { providerModel: 'deepseek-v4-pro' },
    );
    expect(optionValue(args, '--role')).toBe('role:compute');
    expect(optionValue(args, '--model')).toBe('deepseek-v4-pro');

    // No override → no --model flag (deployment default applies).
    const bare = matosAgentDef.buildArgs('prompt', [], [], { model: 'role:compute' }, {});
    expect(bare).not.toContain('--model');
  });

  it('forwards project-selected native assets as repeatable --asset flags', () => {
    const args = matosAgentDef.buildArgs(
      'prompt',
      [],
      [],
      { model: 'role:compute' },
      { assetRefs: ['knowledge:shared-runbook', 'tool:project-helper'] },
    );
    expect(args.filter((value) => value === '--asset')).toHaveLength(2);
    expect(optionValue(args, '--asset')).toBe('knowledge:shared-runbook');
    expect(args).toContain('tool:project-helper');
  });

  it('passes the user global rules file to the native host', () => {
    const args = matosAgentDef.buildArgs(
      'prompt',
      [],
      [],
      { model: 'role:compute' },
      { appendSystemPromptFile: '/data/native-run-prompts/run-1.md' },
    );
    expect(optionValue(args, '--append-system-prompt-file')).toBe('/data/native-run-prompts/run-1.md');

    const bare = matosAgentDef.buildArgs('prompt', [], [], { model: 'role:compute' }, {});
    expect(bare).not.toContain('--append-system-prompt-file');
  });

  it('does not reintroduce obsolete version pins from old browsers or cached project metadata', () => {
    const args = matosAgentDef.buildArgs('prompt', [], [], {}, {
      assetRefs: ['skill:procedure@0.1.0', 'skill:procedure@0.1.1', 'data:bundle@1.0.0'],
    });
    expect(args.filter((value) => value === '--asset')).toHaveLength(2);
    expect(args).toContain('skill:procedure');
    expect(args).toContain('data:bundle');
    expect(args).not.toContain('skill:procedure@0.1.0');
  });

  it('binds execution tiers: chat/plan run read-only with a lower effort default', () => {
    const chat = matosAgentDef.buildArgs('prompt', [], [], {}, { sessionMode: 'chat' });
    expect(optionValue(chat, '--permission-mode')).toBe('plan');
    expect(optionValue(chat, '--effort')).toBe('low');

    const plan = matosAgentDef.buildArgs('prompt', [], [], {}, { sessionMode: 'plan' });
    expect(optionValue(plan, '--permission-mode')).toBe('plan');
    expect(optionValue(plan, '--effort')).toBe('medium');

    // design (执行) keeps the product default: bypass + env effort (max).
    const design = matosAgentDef.buildArgs('prompt', [], [], {}, { sessionMode: 'design' });
    expect(optionValue(design, '--permission-mode')).toBe('bypassPermissions');
    expect(design).not.toContain('--effort');

    // Missing sessionMode (older callers) behaves like design.
    const bare = matosAgentDef.buildArgs('prompt', [], [], {}, {});
    expect(optionValue(bare, '--permission-mode')).toBe('bypassPermissions');
    expect(bare).not.toContain('--effort');
  });

  it('lets an explicit reasoning pick override the tier effort default', () => {
    const args = matosAgentDef.buildArgs(
      'prompt',
      [],
      [],
      { reasoning: 'high' },
      { sessionMode: 'chat' },
    );
    expect(optionValue(args, '--effort')).toBe('high');
    // Permission stays tier-bound even with an explicit effort pick.
    expect(optionValue(args, '--permission-mode')).toBe('plan');

    // The synthetic 'default' reasoning id falls back to the tier default.
    const viaDefault = matosAgentDef.buildArgs(
      'prompt',
      [],
      [],
      { reasoning: 'default' },
      { sessionMode: 'plan' },
    );
    expect(optionValue(viaDefault, '--effort')).toBe('medium');
  });

  it('exports the tier mapping helpers with design/unknown falling through', () => {
    expect(matosEffortForRun(null, 'chat')).toBe('low');
    expect(matosEffortForRun(undefined, 'plan')).toBe('medium');
    expect(matosEffortForRun(null, 'design')).toBeNull();
    expect(matosEffortForRun('max', 'chat')).toBe('max');
    expect(matosEffortForRun('bogus', 'chat')).toBe('low');
    expect(matosPermissionModeForRun('chat')).toBe('plan');
    expect(matosPermissionModeForRun('plan')).toBe('plan');
    expect(matosPermissionModeForRun('design')).toBe('bypassPermissions');
    expect(matosPermissionModeForRun(undefined)).toBe('bypassPermissions');
  });

  it('emits --session-id on a create turn and --resume on a resume turn', () => {
    const create = matosAgentDef.buildArgs('prompt', [], [], {}, {
      newSessionId: '11111111-1111-4111-8111-111111111111',
      resumeSessionId: null,
    });
    expect(create[create.indexOf('--session-id') + 1]).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(create).not.toContain('--resume');

    const resume = matosAgentDef.buildArgs('prompt', [], [], {}, {
      newSessionId: '22222222-2222-4222-8222-222222222222',
      resumeSessionId: 'stored-session-abc',
    });
    expect(resume[resume.indexOf('--resume') + 1]).toBe('stored-session-abc');
    expect(resume).not.toContain('--session-id');
  });

  it('forwards extra allowed dirs via --add-dir', () => {
    const args = matosAgentDef.buildArgs('prompt', [], ['/a', '/b'], {}, {});
    const idx = args.indexOf('--add-dir');
    expect(idx).toBeGreaterThan(-1);
    expect(args.slice(idx + 1, idx + 3)).toEqual(['/a', '/b']);
  });
});

describe('parseMatOSRoleList', () => {
  it('parses workbench roles list --json into canonical role refs', () => {
    const stdout = JSON.stringify({
      resources: [
        { id: 'compute', ref: 'role:compute@1.0.0', name: 'Compute', status: 'enabled' },
        { id: 'academic', ref: 'role:academic@1.0.0', name: 'Academic Research', status: 'enabled' },
      ],
    });
    const models = parseMatOSRoleList(stdout);
    expect(models).not.toBeNull();
    expect(models![0]).toEqual({ id: 'default', label: 'Default role (MatOS env)' });
    expect(models).toContainEqual({ id: 'role:compute@1.0.0', label: 'Compute' });
    expect(models).toContainEqual({ id: 'role:academic@1.0.0', label: 'Academic Research' });
  });

  it('hides internal self-evolution and admin roles', () => {
    const stdout = JSON.stringify({
      resources: [
        { id: 'compute', name: 'Compute', status: 'enabled' },
        { id: 'self-evolution-worker', name: 'Self Evolution Worker', status: 'enabled' },
        { id: 'semantic-acceptance-judge', name: 'Judge', status: 'enabled' },
        { id: 'admin-main-compute-vasp-preflight', name: 'Admin Preflight', status: 'enabled' },
        { id: 'disabled-role', name: 'Disabled', status: 'disabled' },
      ],
    });
    const models = parseMatOSRoleList(stdout);
    const ids = (models ?? []).map((m) => m.id);
    expect(ids).toContain('role:compute');
    expect(ids).not.toContain('role:self-evolution-worker');
    expect(ids).not.toContain('role:semantic-acceptance-judge');
    expect(ids).not.toContain('role:admin-main-compute-vasp-preflight');
    expect(ids).not.toContain('role:disabled-role');
  });

  it('returns null for non-JSON or empty listings', () => {
    expect(parseMatOSRoleList('not json')).toBeNull();
    expect(parseMatOSRoleList(JSON.stringify({ resources: [] }))).toBeNull();
  });
});


describe('MatOS role catalog authority', () => {
  it('does not advertise installed roles or version pins before the native catalog responds', () => {
    expect(matosAgentDef.fallbackModels).toEqual([
      { id: 'default', label: 'Default role (MatOS env)' },
    ]);
  });
});


it('keeps internal evolution roles hidden for bare, qualified and versioned references', () => {
  for (const id of ['user-feedback-critic', 'direct-asset-editor', 'self-evolution-worker', 'turn-feedback-classifier', 'semantic-acceptance-judge']) {
    for (const ref of [id, id + '@2.0.0', 'role:' + id, 'role:' + id + '@2.0.0']) {
      expect(isHiddenMatOSRoleId(ref)).toBe(true);
    }
  }
  expect(isHiddenMatOSRoleId('role:compute@2.0.0')).toBe(false);
});
