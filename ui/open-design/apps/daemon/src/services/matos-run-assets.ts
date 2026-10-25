import { readMatOSProjectAuthority } from './matos-project-authority.js';
import { dirname, resolve } from 'node:path';

/** Project attachments are loaded by native MatOS from project.json, never by
 * replaying a browser/SQLite snapshot as explicit --asset overrides. Keep only
 * additional per-turn selections here. A corrupt or mismatched authority fails
 * closed instead of substituting cached metadata.
 */
export async function matOSRunAdditionalAssetRefs(input: {
  cwd: string;
  projectId?: string;
  persistedRefs?: unknown;
  requestedRefs: readonly string[];
  additionalAssetRefs?: readonly string[];
}): Promise<string[]> {
  const additional = [...new Set(input.additionalAssetRefs ?? [])];
  if (!input.projectId) return [...new Set([...input.requestedRefs, ...additional])];
  let root = resolve(input.cwd);
  let authority = await readMatOSProjectAuthority(root, input.projectId);
  while (!authority && dirname(root) !== root) {
    root = dirname(root);
    authority = await readMatOSProjectAuthority(root, input.projectId);
  }
  if (!authority) return [...new Set([...input.requestedRefs, ...additional])];
  // Legacy assetRefs is a browser projection of project attachments. Its
  // absence from *current* metadata does not make it a new per-turn selection.
  return additional;
}
