import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { realpathSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  authorizeMatOSAssetRead,
  authorizeMatOSAssetMutation,
} from '../src/routes/matos-assets.js';
import { matosCliEnv } from '../src/services/matos-cli.js';

function assetRecord(scope: string, scopeRef: string, sourceId = 'scoped-assets') {
  return {
    metadata: {
      sourceProvenance: { sourceId, scope, scopeRef },
    },
  };
}

describe('MatOS Open Design asset authorization', () => {
  it('pins project workflow reads without moving the shared run store', () => {
    const env = { MATOS_ASSETS_CWD: '/workspace/group/shared', MATOS_WORKFLOW_RUNS_DIR: '/workspace/workflows/runs' };
    const child = matosCliEnv(env, '/workspace/group/shared/projects/a');
    expect(child.MATOS_WORKFLOW_PROJECT_CWD).toBe('/workspace/group/shared/projects/a');
    expect(child.MATOS_WORKFLOW_RUNS_DIR).toBe('/workspace/workflows/runs');
    expect(matosCliEnv({ ...child }, '/workspace/group/shared').MATOS_WORKFLOW_PROJECT_CWD).toBeUndefined();
  });
  it.each([undefined, '   '])('keeps project isolation with a fallback workspace root (%s)', (assetRoot) => {
    const root = realpathSync(process.cwd());
    const project = path.join(root, 'projects', 'review');
    const child = matosCliEnv({ MATOS_ASSETS_CWD: assetRoot, MATOS_WORKFLOW_RUNS_DIR: '/workspace/workflows/runs' }, project);
    expect(child.MATOS_WORKFLOW_PROJECT_CWD).toBe(project);
    expect(child.MATOS_WORKFLOW_RUNS_DIR).toBe('/workspace/workflows/runs');
    expect(matosCliEnv(child, root).MATOS_WORKFLOW_PROJECT_CWD).toBeUndefined();
  });
  it('allows only the exact scoped owner', () => {
    expect(
      authorizeMatOSAssetMutation(
        assetRecord('user', 'user:alice'),
        'user:alice',
      ),
    ).toEqual({ ok: true, sourceId: 'scoped-assets' });
    expect(
      authorizeMatOSAssetMutation(
        assetRecord('user', 'user:bob'),
        'user:alice',
      ),
    ).toMatchObject({ ok: false });
    expect(
      authorizeMatOSAssetMutation(
        assetRecord('core', 'core:matos'),
        'user:alice',
      ),
    ).toMatchObject({ ok: false });
  });

  it('reads published assets and only the current private scope', () => {
    expect(authorizeMatOSAssetRead(assetRecord('core', 'core:matos'), 'user:alice')).toEqual({ ok: true });
    expect(authorizeMatOSAssetRead(assetRecord('user', 'user:alice'), 'user:alice')).toEqual({ ok: true });
    expect(authorizeMatOSAssetRead(assetRecord('user', 'user:bob'), 'user:alice')).toMatchObject({ ok: false });
    expect(authorizeMatOSAssetRead(assetRecord('project', 'project:secret'), 'user:alice')).toMatchObject({ ok: false });
  });

  it('reads project-local workspace assets (pins, registered data) without provenance', () => {
    expect(
      authorizeMatOSAssetRead({ source: 'project', metadata: {} }, 'user:alice'),
    ).toEqual({ ok: true });
    // Without the project marker, provenance-less records stay unreadable.
    expect(authorizeMatOSAssetRead({ metadata: {} }, 'user:alice')).toMatchObject({ ok: false });
  });

  it('never lets a project-adapter marker override explicit foreign provenance', () => {
    const foreign = { source: 'project', ...assetRecord('user', 'user:bob') };
    expect(authorizeMatOSAssetRead(foreign, 'user:alice')).toMatchObject({ ok: false });
    expect(authorizeMatOSAssetRead({ source: 'project', ...assetRecord('core', 'core:matos') }, 'user:alice')).toEqual({ ok: true });
  });

  it('strips operator credentials from scoped CLI children', () => {
    const child = matosCliEnv({
      MATOS_SCOPE_ID: 'user:alice',
      MATOS_GATEWAY_GITEA_TOKEN: 'operator-token',
      MATOS_GATEWAY_GITEA_TOKEN_FILE: '/operator/token',
      MATOS_GITEA_TOKEN: 'also-operator',
      MATOS_GITEA_OPERATOR_ENV_FILE: '/operator/env',
      MATOS_GITEA_TOKEN_FILE: '/workspace/ipc/matos-gitea.token',
    });
    expect(child.MATOS_GATEWAY_GITEA_TOKEN).toBeUndefined();
    expect(child.MATOS_GATEWAY_GITEA_TOKEN_FILE).toBeUndefined();
    expect(child.MATOS_GITEA_TOKEN).toBeUndefined();
    expect(child.MATOS_GITEA_OPERATOR_ENV_FILE).toBeUndefined();
    expect(child.MATOS_GITEA_TOKEN_FILE).toBe('/workspace/ipc/matos-gitea.token');
    expect(child.MATOS_GITEA_DISABLE_OPERATOR_ENV).toBe('1');

    const untrustedFile = matosCliEnv({
      MATOS_SCOPE_ID: 'user:alice',
      MATOS_GITEA_TOKEN_FILE: '/operator/token',
    });
    expect(untrustedFile.MATOS_GITEA_TOKEN_FILE).toBeUndefined();
  });

});


it('reads installed public packs without granting writes or escaping through symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'matos-bundle-read-'));
  const bundle = path.join(root, 'bundle'), outside = path.join(root, 'private');
  mkdirSync(bundle); mkdirSync(outside); mkdirSync(path.join(bundle, 'pack'));
  symlinkSync(outside, path.join(bundle, 'escape'));
  try {
    const record = { source: 'pack', absolutePath: path.join(bundle, 'pack'), metadata: {} };
    expect(authorizeMatOSAssetRead(record, 'user:local', bundle)).toEqual({ ok: true });
    expect(authorizeMatOSAssetMutation(record, 'user:local')).toMatchObject({ ok: false });
    expect(authorizeMatOSAssetRead({ ...record, absolutePath: path.join(bundle, 'escape') }, 'user:local', bundle)).toMatchObject({ ok: false });
    expect(authorizeMatOSAssetRead({ ...record, ...assetRecord('user', 'user:bob') }, 'user:local', bundle)).toMatchObject({ ok: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
