import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocationProjectDir,
  ENV_PROJECT_LOCATION_ID,
  envDefaultProjectLocation,
  projectDirectoryName,
} from '../src/project-locations.js';

// MatOS lab deployments export OD_DEFAULT_PROJECT_LOCATION so "new project"
// folders land inside the user's workspace tree instead of the hidden managed
// store. The env location is merged into project-location reads but never
// persisted — these specs pin resolution, on-demand creation, naming, and the
// silent-null failure modes (unset / relative / unreachable root).

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'od-env-loc-'));
  saved.location = process.env.OD_DEFAULT_PROJECT_LOCATION;
  saved.name = process.env.OD_DEFAULT_PROJECT_LOCATION_NAME;
  delete process.env.OD_DEFAULT_PROJECT_LOCATION;
  delete process.env.OD_DEFAULT_PROJECT_LOCATION_NAME;
});

afterEach(async () => {
  if (saved.location === undefined) delete process.env.OD_DEFAULT_PROJECT_LOCATION;
  else process.env.OD_DEFAULT_PROJECT_LOCATION = saved.location;
  if (saved.name === undefined) delete process.env.OD_DEFAULT_PROJECT_LOCATION_NAME;
  else process.env.OD_DEFAULT_PROJECT_LOCATION_NAME = saved.name;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('envDefaultProjectLocation', () => {
  it('returns null when the env var is unset or blank', async () => {
    expect(await envDefaultProjectLocation()).toBeNull();
    process.env.OD_DEFAULT_PROJECT_LOCATION = '   ';
    expect(await envDefaultProjectLocation()).toBeNull();
  });

  it('resolves the env root, creating it on demand', async () => {
    const target = path.join(tmpRoot, 'workspace', 'projects');
    expect(existsSync(target)).toBe(false);
    process.env.OD_DEFAULT_PROJECT_LOCATION = target;

    const loc = await envDefaultProjectLocation();
    expect(loc).not.toBeNull();
    expect(loc?.id).toBe(ENV_PROJECT_LOCATION_ID);
    expect(loc?.name).toBe('Workspace');
    expect(existsSync(target)).toBe(true);
    // tmpdir may itself be a symlink (macOS /var → /private/var), so compare
    // against the canonicalized path rather than the raw env value.
    expect(loc?.path).toBe(await realpath(target));
    // Env-owned locations must not masquerade as the built-in managed store.
    expect(loc?.builtIn).toBeUndefined();
  });

  it('honors OD_DEFAULT_PROJECT_LOCATION_NAME', async () => {
    process.env.OD_DEFAULT_PROJECT_LOCATION = path.join(tmpRoot, 'p');
    process.env.OD_DEFAULT_PROJECT_LOCATION_NAME = '工作区';
    const loc = await envDefaultProjectLocation();
    expect(loc?.name).toBe('工作区');
  });

  it('returns null instead of throwing for an unusable root', async () => {
    // Relative paths are rejected by ensureProjectLocation; the env loader
    // must swallow that so a bad deploy value degrades to managed-only.
    process.env.OD_DEFAULT_PROJECT_LOCATION = 'relative/projects';
    expect(await envDefaultProjectLocation()).toBeNull();
  });
});

describe('human-readable project directories', () => {
  it('preserves Unicode project names and removes path syntax', () => {
    expect(projectDirectoryName('  铜的熔点 / MACE  ', 'opaque-id')).toBe('铜的熔点-MACE');
    expect(projectDirectoryName('../..', 'abc-123')).toBe('project-abc-123');
  });

  it('creates collision-safe folders under the configured workspace root', async () => {
    const root = path.join(tmpRoot, 'workspace-projects');
    process.env.OD_DEFAULT_PROJECT_LOCATION = root;
    const location = await envDefaultProjectLocation();
    expect(location).not.toBeNull();
    const first = await createLocationProjectDir(location!, 'opaque-1', '铜的熔点');
    const second = await createLocationProjectDir(location!, 'opaque-2', '铜的熔点');
    expect(path.basename(first)).toBe('铜的熔点');
    expect(path.basename(second)).toBe('铜的熔点-2');
  });
});
