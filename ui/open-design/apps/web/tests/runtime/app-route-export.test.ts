import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as spaShellRoute from '../../app/[[...slug]]/page';

const WEB_ROOT = dirname(fileURLToPath(new URL('../../..', import.meta.url)));

async function loadNextConfig() {
  vi.resetModules();
  // Static exports refuse to build without a versioned asset prefix; the
  // package build script provides it, so tests must simulate that entrypoint.
  process.env.OD_WEB_ASSET_VERSION = 'vitest-asset-version';
  return (await import('../../next.config')).default;
}

afterEach(() => {
  delete process.env.OD_WEB_DIST_DIR;
  delete process.env.OD_WEB_ASSET_VERSION;
  vi.resetModules();
});

describe('SPA shell export route', () => {
  it('stays compatible with static export builds', async () => {
    const nextConfig = await loadNextConfig();
    expect(nextConfig.output).toBe('export');
    expect(nextConfig.assetPrefix).toBe('/__matos_web/vitest-asset-version');
    expect(nextConfig.distDir).toBeUndefined();
    expect('dynamicParams' in spaShellRoute).toBe(false);
    expect(spaShellRoute.generateStaticParams()).toEqual([{ slug: [] }]);
  });

  it('keeps an explicit dist dir override even when static export is selected', async () => {
    const configuredDistDir = resolve(WEB_ROOT, '.tmp', 'vitest-next');
    process.env.OD_WEB_DIST_DIR = configuredDistDir;

    const nextConfig = await loadNextConfig();

    expect(nextConfig.output).toBe('export');
    expect(nextConfig.distDir).toContain('vitest-next');
  });

  it('treats an empty dist dir override as unset for static export builds', async () => {
    process.env.OD_WEB_DIST_DIR = '';

    const nextConfig = await loadNextConfig();

    expect(nextConfig.output).toBe('export');
    expect(nextConfig.distDir).toBeUndefined();
  });
});
