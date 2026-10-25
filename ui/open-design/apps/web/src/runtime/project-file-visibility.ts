/**
 * Generic project/chat surfaces expose user-authored MatOS assets, but not
 * MatOS runtime authority, session traces, or hidden self-evolution records.
 */
export function normalizeProjectFilePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

export function isInternalMatOSProjectPath(value: string): boolean {
  const normalized = normalizeProjectFilePath(value).toLowerCase();
  if (!normalized) return false;

  const segments = normalized.split('/').filter(Boolean);
  const matosIndex = segments.lastIndexOf('.matos');
  if (matosIndex < 0) return false;

  // `.matos/assets/**` is an intentional, user-authored project asset surface.
  // Everything else below a project-root `.matos` directory is internal.
  return segments[matosIndex + 1] !== 'assets';
}

export function isUserVisibleProjectFilePath(value: string): boolean {
  return !isInternalMatOSProjectPath(value);
}
