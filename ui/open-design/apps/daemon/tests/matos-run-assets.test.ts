import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matOSRunAdditionalAssetRefs } from '../src/services/matos-run-assets.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('native project selection authority at run time', () => {
  it('does not replay stale browser versions or deleted cached attachments as CLI pins', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-run-assets-'));
    roots.push(cwd);
    await mkdir(join(cwd, '.matos'));
    await writeFile(join(cwd, '.matos/project.json'), JSON.stringify({
      id: 'project', assetRefs: ['skill:procedure'], team: [], conversations: [],
    }));
    const refs = await matOSRunAdditionalAssetRefs({
      cwd, projectId: 'project', persistedRefs: ['skill:procedure@0.1.0', 'tool:removed@1.0.0'],
      requestedRefs: ['skill:procedure@0.1.0', 'tool:removed@1.0.0'],
      additionalAssetRefs: ['data:turn-only'],
    });
    expect(refs).toEqual(['data:turn-only']);
    const nested = join(cwd, 'calculations', 'case-1');
    await mkdir(nested, { recursive: true });
    expect(await matOSRunAdditionalAssetRefs({ cwd: nested, projectId: 'project', requestedRefs: ['skill:procedure@0.1.0'] })).toEqual([]);
    await expect(matOSRunAdditionalAssetRefs({ cwd, projectId: 'other', requestedRefs: [] }))
      .rejects.toThrow('identity mismatch');
    await writeFile(join(cwd, '.matos/project.json'), '{');
    await expect(matOSRunAdditionalAssetRefs({ cwd, projectId: 'project', requestedRefs: [] })).rejects.toThrow();
  });
  it('ignores removed project assets replayed by an old browser even after SQLite catches up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-run-assets-'));
    roots.push(cwd);
    await mkdir(join(cwd, '.matos'));
    await writeFile(join(cwd, '.matos/project.json'), JSON.stringify({ id: 'project', assetRefs: [], team: [], conversations: [] }));
    expect(await matOSRunAdditionalAssetRefs({ cwd, projectId: 'project', persistedRefs: [], requestedRefs: ['skill:removed@0.1.0'] })).toEqual([]);
    expect(await matOSRunAdditionalAssetRefs({ cwd, projectId: 'project', requestedRefs: [], additionalAssetRefs: ['data:explicit'] })).toEqual(['data:explicit']);
  });
  it('keeps run-only selections when there is no native project authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-run-assets-'));
    roots.push(cwd);
    expect(await matOSRunAdditionalAssetRefs({ cwd, projectId: 'project', requestedRefs: ['data:turn-only'] }))
      .toEqual(['data:turn-only']);
  });
});
