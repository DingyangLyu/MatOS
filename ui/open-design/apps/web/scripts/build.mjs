import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const configuredVersion = process.env.OD_WEB_ASSET_VERSION?.trim();
const assetVersion = configuredVersion
  || `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

if (!/^[a-zA-Z0-9._-]+$/.test(assetVersion)) {
  throw new Error(
    'OD_WEB_ASSET_VERSION may contain only letters, digits, dots, underscores, and hyphens.',
  );
}

console.log(`[open-design/web] static asset version: ${assetVersion}`);
const result = spawnSync('next', ['build'], {
  env: {
    ...process.env,
    OD_WEB_ASSET_VERSION: assetVersion,
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
