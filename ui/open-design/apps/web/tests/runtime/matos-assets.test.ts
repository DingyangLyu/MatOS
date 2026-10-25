import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assetBoundaryOf,
  clearMatOSAssetsCache,
  fetchMatOSAssets,
  matchesMatOSAssetBoundary,
  type MatOSAssetSummary,
} from '../../src/runtime/matos-assets';

const LISTING: { assets: MatOSAssetSummary[] } = {
  assets: [
    {
      ref: 'skill:academic',
      id: 'academic',
      type: 'skill',
      source: null,
      name: 'Academic',
      version: '1.0.0',
      description: null,
      tags: [],
      packId: 'matos-core',
      entry: 'SKILL.md',
      status: 'enabled',
      dependencies: [],
      runtime: null,
      git: { sourceId: null, scope: 'core', webUrl: null },
    },
  ],
};

afterEach(() => {
  clearMatOSAssetsCache();
  vi.restoreAllMocks();
});

describe('MatOS asset browser cache', () => {
  it('uses the server boundary and safely derives a boundary for stale cached rows', () => {
    const listedAsset = LISTING.assets[0]!;
    expect(assetBoundaryOf({
      ...listedAsset,
      boundary: {
        visibility: 'private',
        owner: 'current-scope',
        editable: true,
        sharedCopy: true,
        selfEvolved: true,
        evolutionRuns: 2,
        latestEvolutionAt: '2026-08-21T12:00:00.000Z',
      },
    })).toMatchObject({ visibility: 'private', sharedCopy: true, selfEvolved: true });

    expect(assetBoundaryOf(listedAsset)).toMatchObject({
      visibility: 'public',
      owner: 'matos',
      sharedCopy: false,
      selfEvolved: false,
    });

    expect(assetBoundaryOf({
      ...listedAsset,
      source: 'project',
      git: { sourceId: 'mine', scope: 'user', webUrl: null },
    })).toMatchObject({
      visibility: 'private',
      owner: 'current-scope',
      editable: true,
    });
  });

  it('keeps private, shared-copy, public, and project filters distinct', () => {
    const listedAsset = LISTING.assets[0]!;
    const withBoundary = (boundary: NonNullable<MatOSAssetSummary['boundary']>) => ({
      ...listedAsset,
      boundary,
    });
    const privateAsset = withBoundary({
      visibility: 'private',
      owner: 'current-scope',
      editable: true,
      sharedCopy: false,
      selfEvolved: false,
      evolutionRuns: 0,
      latestEvolutionAt: null,
    });
    const sharedCopy = withBoundary({
      ...privateAsset.boundary,
      sharedCopy: true,
    });
    const publicAsset = withBoundary({
      ...privateAsset.boundary,
      visibility: 'public',
      owner: 'matos',
      editable: false,
    });
    const projectAsset = withBoundary({
      ...privateAsset.boundary,
      visibility: 'collaborative',
      owner: 'project',
    });

    expect(matchesMatOSAssetBoundary(privateAsset, 'mine')).toBe(true);
    expect(matchesMatOSAssetBoundary(privateAsset, 'shared')).toBe(false);
    expect(matchesMatOSAssetBoundary(sharedCopy, 'mine')).toBe(false);
    expect(matchesMatOSAssetBoundary(sharedCopy, 'shared')).toBe(true);
    expect(matchesMatOSAssetBoundary(publicAsset, 'public')).toBe(true);
    expect(matchesMatOSAssetBoundary(publicAsset, 'mine')).toBe(false);
    expect(matchesMatOSAssetBoundary(projectAsset, 'project')).toBe(true);
    expect(matchesMatOSAssetBoundary(projectAsset, 'mine')).toBe(false);
  });

  it('reuses the listing for ordinary navigation', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify(LISTING), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchMatOSAssets();
    await fetchMatOSAssets();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/matos/assets');
  });

  it('coalesces concurrent cold loads', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL) => new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchMatOSAssets();
    const second = fetchMatOSAssets();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(new Response(JSON.stringify(LISTING), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('uses the forced endpoint after an asset mutation', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify(LISTING), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchMatOSAssets();
    await fetchMatOSAssets({ refresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/matos/assets?refresh=1');
  });
});
