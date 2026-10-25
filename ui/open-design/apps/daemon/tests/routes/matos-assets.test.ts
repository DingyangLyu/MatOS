import { describe, expect, it } from 'vitest';
import {
  MATOS_BRIDGE_ASSET_TYPES,
  MATOS_BRIDGE_DEFAULT_ASSET_TYPES,
  MATOS_BRIDGE_STAGED_ASSET_TYPES,
  buildRoleRuntimeSetArgs,
  expandWorkspacePath,
  isEditableAssetFileName,
  isMatOSBridgeAssetRef,
  indexAcceptedAssetEvolutionRuns,
  matosAssetBridgeCliEnv,
  matosAssetBridgeEditCliEnv,
  matosAssetBridgeReadCliEnv,
  mergeProjectAndCurrentScopeAssets,
  normalizeAssetRecord,
  normalizeRoleRuntimeSettings,
} from '../../src/routes/matos-assets.js';

describe('matos assets bridge helpers', () => {
  it('expands the CLI <workspace> redaction against the bridge cwd', () => {
    expect(expandWorkspacePath('<workspace>/.matos/source-cache/x', '/repo')).toBe(
      '/repo/.matos/source-cache/x',
    );
    expect(expandWorkspacePath('/abs/path', '/repo')).toBe('/abs/path');
    expect(expandWorkspacePath(undefined, '/repo')).toBeUndefined();
  });

  it('unredacts asset source paths only inside the scoped daemon bridge', () => {
    const env = matosAssetBridgeCliEnv({
      MATOS_SCOPE_REF: 'user:alice',
      MATOS_HIDE_INTERNAL_ASSET_SOURCE: '1',
    });
    expect(env.MATOS_SCOPE_REF).toBe('user:alice');
    expect(env.MATOS_HIDE_INTERNAL_ASSET_SOURCE).toBe('0');
  });

  it('preserves dirty accepted checkouts only for the editor validation child', () => {
    const env = matosAssetBridgeEditCliEnv({
      MATOS_SCOPE_REF: 'user:alice',
    });
    expect(env.MATOS_HIDE_INTERNAL_ASSET_SOURCE).toBe('0');
    expect(env.MATOS_ASSET_SOURCE_PRESERVE_DIRTY).toBe('1');
    expect(
      matosAssetBridgeCliEnv({ MATOS_SCOPE_REF: 'user:alice' })
        .MATOS_ASSET_SOURCE_PRESERVE_DIRTY,
    ).toBeUndefined();
    expect(
      matosAssetBridgeReadCliEnv(true, { MATOS_SCOPE_REF: 'user:alice' })
        .MATOS_ASSET_SOURCE_PRESERVE_DIRTY,
    ).toBe('1');
    expect(
      matosAssetBridgeReadCliEnv(false, { MATOS_SCOPE_REF: 'user:alice' })
        .MATOS_ASSET_SOURCE_PRESERVE_DIRTY,
    ).toBeUndefined();
  });

  it('normalizes registry records with git provenance', () => {
    const summary = normalizeAssetRecord({
      id: 'academic',
      type: 'skill',
      name: 'Academic',
      version: '1.0.0',
      description: 'desc',
      tags: ['a', 1, 'b'],
      packId: 'matos-core',
      entry: 'SKILL.md',
      dependencies: ['tool:web-read', 42],
      lifecycle: { status: 'enabled' },
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-core-assets',
          scope: 'core',
          gitea: { webUrl: 'http://127.0.0.1:3001/matos-core/assets' },
        },
      },
    });
    expect(summary).toEqual({
      ref: 'skill:academic',
      canonicalKey: null,
      id: 'academic',
      type: 'skill',
      source: null,
      name: 'Academic',
      version: '1.0.0',
      description: 'desc',
      tags: ['a', 'b'],
      packId: 'matos-core',
      entry: 'SKILL.md',
      status: 'enabled',
      dependencies: ['tool:web-read'],
      runtime: null,
      git: {
        sourceId: 'matos-core-assets',
        scope: 'core',
        webUrl: 'http://127.0.0.1:3001/matos-core/assets',
      },
      boundary: {
        visibility: 'public',
        owner: 'matos',
        editable: false,
        sharedCopy: false,
        selfEvolved: false,
        evolutionRuns: 0,
        latestEvolutionAt: null,
      },
    });
    expect(normalizeAssetRecord({ type: 'skill' })).toBeNull();
    expect(normalizeAssetRecord('nope')).toBeNull();
  });

  it('projects private, shared-copy, project, and accepted self-evolution boundaries', () => {
    const evolution = indexAcceptedAssetEvolutionRuns([
      {
        runId: 'accepted-1',
        status: 'accepted',
        updatedAt: '2026-08-20T12:00:00.000Z',
        updatedAssets: ['skill:my-helper@1.0.0'],
      },
      {
        runId: 'accepted-merge',
        status: 'accepted_merged',
        updatedAt: '2026-08-21T12:00:00.000Z',
        createdAssets: ['skill:my-helper@1.0.0'],
      },
      {
        runId: 'rolled-back',
        status: 'rolled_back',
        updatedAssets: ['skill:my-helper@1.0.0'],
      },
    ]);
    const personal = normalizeAssetRecord({
      canonicalKey: 'skill:my-helper@1.0.0',
      id: 'my-helper',
      type: 'skill',
      // Real Gitea user assets currently arrive through the registry's
      // project source adapter. Provenance must still keep them private.
      source: 'project',
      tags: ['forked', 'project-share'],
      metadata: {
        sourceProvenance: {
          sourceId: 'matos-user-assets-alice',
          scope: 'user',
          scopeRef: 'user:alice',
        },
      },
    }, { scopeRef: 'user:alice', evolution });
    expect(personal?.boundary).toEqual({
      visibility: 'private',
      owner: 'current-scope',
      editable: true,
      sharedCopy: true,
      selfEvolved: true,
      evolutionRuns: 2,
      latestEvolutionAt: '2026-08-21T12:00:00.000Z',
    });

    expect(normalizeAssetRecord({
      id: 'project-data',
      type: 'data',
      source: 'project',
    }, { scopeRef: 'user:alice', evolution })?.boundary).toMatchObject({
      visibility: 'collaborative',
      owner: 'project',
      sharedCopy: false,
      selfEvolved: false,
    });
  });

  it('merges current-user private assets into a project listing without leaking foreign rows', () => {
    const record = (
      id: string,
      options: {
        source?: string;
        scope?: string;
        scopeRef?: string;
      } = {},
    ) => normalizeAssetRecord({
      canonicalKey: `skill:${id}@1.0.0`,
      id,
      type: 'skill',
      source: options.source,
      metadata: options.scope ? {
        sourceProvenance: {
          sourceId: `${options.scope}-assets`,
          scope: options.scope,
          scopeRef: options.scopeRef,
        },
      } : {},
    }, { scopeRef: 'user:alice' })!;

    const projectLocal = record('project-local', { source: 'project' });
    const publicCollision = record('owned-overlay', {
      scope: 'core',
      scopeRef: 'core:matos',
    });
    const owned = record('owned-overlay', {
      scope: 'user',
      scopeRef: 'user:alice',
    });
    const ownedOnly = record('owned-only', {
      scope: 'user',
      scopeRef: 'user:alice',
    });
    const foreign = record('foreign', {
      scope: 'user',
      scopeRef: 'user:bob',
    });

    const merged = mergeProjectAndCurrentScopeAssets(
      [projectLocal, publicCollision],
      [owned, ownedOnly, foreign],
    );
    expect(merged.map((asset) => asset.ref).sort()).toEqual([
      'skill:owned-only',
      'skill:owned-overlay',
      'skill:project-local',
    ]);
    expect(
      merged.find((asset) => asset.ref === 'skill:owned-overlay')?.boundary.owner,
    ).toBe('current-scope');
  });

  it('gates editable file names to entry/manifest text files', () => {
    expect(isEditableAssetFileName('SKILL.md')).toBe(true);
    expect(isEditableAssetFileName('asset.json')).toBe(true);
    expect(isEditableAssetFileName('workflow.yaml')).toBe(true);
    expect(isEditableAssetFileName('notes.md')).toBe(true);
    expect(isEditableAssetFileName('../escape.md')).toBe(false);
    expect(isEditableAssetFileName('dir/inner.md')).toBe(false);
    expect(isEditableAssetFileName('model.bin')).toBe(false);
    expect(isEditableAssetFileName('script.py')).toBe(false);
  });

  it('lists data assets as a first-class bridge type', () => {
    expect(MATOS_BRIDGE_ASSET_TYPES).toContain('data');
    expect(isEditableAssetFileName('DATA.md')).toBe(true);
    const summary = normalizeAssetRecord({
      id: 'mlip-mace-mp-medium-0b3',
      type: 'data',
      name: 'MACE-MP medium',
      entry: 'DATA.md',
    });
    expect(summary?.ref).toBe('data:mlip-mace-mp-medium-0b3');
    expect(summary?.type).toBe('data');
  });

  it('bridges every product asset type, keeping provenance types internal', () => {
    // Lab-flavored and evaluation families are product assets: benchmarks,
    // suites, evaluations, and runtimes must reach the web catalog.
    for (const type of [
      'knowledge',
      'data',
      'tool',
      'mcp',
      'skill',
      'role',
      'workflow',
      'benchmark',
      'benchmark-suite',
      'evaluation',
      'runtime',
    ]) {
      expect(MATOS_BRIDGE_ASSET_TYPES).toContain(type);
    }
    // Self-evolution provenance stays out of the product bridge.
    expect(MATOS_BRIDGE_ASSET_TYPES).not.toContain('experience');
    expect(MATOS_BRIDGE_ASSET_TYPES).not.toContain('evolution-proposal');

    const benchmark = normalizeAssetRecord({
      id: 'matbench-perovskites',
      type: 'benchmark',
      name: 'Matbench perovskites',
    });
    expect(benchmark?.ref).toBe('benchmark:matbench-perovskites');
    const runtime = normalizeAssetRecord({
      id: 'matos-openvscode-stable',
      type: 'runtime',
      name: 'OpenVSCode stable',
    });
    expect(runtime?.ref).toBe('runtime:matos-openvscode-stable');
  });

  it('stages benchmark/evaluation and runtime families out of the default listing', () => {
    // Product decision: these families are not released to end users yet.
    // The default catalog (Assets workbench, Home gallery, relationship map)
    // must skip them, while explicit `?types=` requests can still reach them.
    for (const staged of ['benchmark', 'benchmark-suite', 'evaluation', 'runtime']) {
      expect(MATOS_BRIDGE_STAGED_ASSET_TYPES).toContain(staged);
      expect(MATOS_BRIDGE_DEFAULT_ASSET_TYPES).not.toContain(staged);
      // Staged families stay bridgeable, just not listed by default.
      expect(MATOS_BRIDGE_ASSET_TYPES).toContain(staged);
    }
    for (const released of ['knowledge', 'data', 'tool', 'mcp', 'skill', 'role', 'workflow']) {
      expect(MATOS_BRIDGE_DEFAULT_ASSET_TYPES).toContain(released);
    }
  });

  it('accepts namespaced asset refs without allowing traversal', () => {
    expect(isMatOSBridgeAssetRef('skill:2d-materials/band-edges')).toBe(true);
    expect(isMatOSBridgeAssetRef('knowledge:org/sub.topic-v1@0.2.0')).toBe(true);
    expect(isMatOSBridgeAssetRef('skill:../escape')).toBe(false);
    expect(isMatOSBridgeAssetRef('skill:bad//segment')).toBe(false);
    expect(isMatOSBridgeAssetRef('skill:/absolute')).toBe(false);
  });

  it('surfaces role runtime overrides on role rows only', () => {
    const role = normalizeAssetRecord({
      id: 'compute',
      type: 'role',
      name: 'Compute',
      runtime: { model: 'deepseek-v4-flash', effort: 'high', maxTurns: 5 },
    });
    expect(role?.runtime).toEqual({
      model: 'deepseek-v4-flash',
      effort: 'high',
      permissionMode: null,
      maxTurns: 5,
    });

    // Non-role assets never carry runtime; empty runtime maps to null.
    const skill = normalizeAssetRecord({
      id: 'academic',
      type: 'skill',
      runtime: { model: 'x' },
    });
    expect(skill?.runtime).toBeNull();
    expect(normalizeRoleRuntimeSettings({})).toBeNull();
    expect(normalizeRoleRuntimeSettings({ model: '', maxTurns: -1 })).toBeNull();
    // Numeric efforts (SDK integer levels) round-trip as strings.
    expect(normalizeRoleRuntimeSettings({ effort: 3 })?.effort).toBe('3');
  });

  it('builds validated roles runtime set argv with null clearing overrides', () => {
    expect(
      buildRoleRuntimeSetArgs('role:compute', {
        model: 'deepseek-v4-flash',
        effort: 'high',
        permissionMode: 'plan',
        maxTurns: 12,
      }),
    ).toEqual({
      args: [
        'roles', 'runtime', 'set', 'role:compute',
        '--model', 'deepseek-v4-flash',
        '--effort', 'high',
        '--permission-mode', 'plan',
        '--max-turns', '12',
        '--json',
      ],
      error: null,
    });

    // null clears via the CLI sentinels ('' / 0); untouched fields are omitted.
    expect(
      buildRoleRuntimeSetArgs('role:compute', { effort: null, maxTurns: null }),
    ).toEqual({
      args: [
        'roles', 'runtime', 'set', 'role:compute',
        '--effort', '',
        '--max-turns', '0',
        '--json',
      ],
      error: null,
    });

    expect(buildRoleRuntimeSetArgs('role:compute', {})).toEqual({ args: null, error: null });
    expect(buildRoleRuntimeSetArgs('role:compute', { effort: 'ultra' }).error).toMatch(/effort/);
    expect(
      buildRoleRuntimeSetArgs('role:compute', { permissionMode: 'dontAsk' }).error,
    ).toMatch(/permissionMode/);
    expect(buildRoleRuntimeSetArgs('role:compute', { maxTurns: 0 }).error).toMatch(/maxTurns/);
    expect(
      buildRoleRuntimeSetArgs('role:compute', { model: 'bad model\nnewline' }).error,
    ).toMatch(/model/);
    // Provider models with bracket suffixes stay accepted (deepseek-v4-pro[1m]).
    expect(
      buildRoleRuntimeSetArgs('role:compute', { model: 'deepseek-v4-pro[1m]' }).error,
    ).toBeNull();
  });
});
