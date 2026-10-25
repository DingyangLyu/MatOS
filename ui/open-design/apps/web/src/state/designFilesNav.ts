// Per-project memory for the file-manager (Design Files) panel: which folder
// the list view was browsing, which tree directories were expanded, and which
// row was last selected for preview. The panel unmounts every time the user
// switches workspace tabs (and the whole project view unmounts when they go
// Home), so without this cache the user loses their place on every jump.
//
// localStorage-only by design: unlike open tabs (which sync to the daemon so
// another browser restores them), file-manager navigation is an ephemeral,
// same-browser convenience — mirroring the tabs cache pattern in projects.ts
// without the daemon round-trip.
import type { DesignFilesNavState } from '../components/DesignFilesPanel';

const DESIGN_FILES_NAV_CACHE_PREFIX = 'open-design:design-files-nav:v1:';
// Bounds the persisted payload for projects with huge trees; oldest entries
// beyond the cap are simply forgotten (stale paths are harmless — they just
// never match a rendered directory).
const MAX_EXPANDED_DIRS = 200;

function cacheKey(projectId: string): string {
  return `${DESIGN_FILES_NAV_CACHE_PREFIX}${projectId}`;
}

export function createDefaultDesignFilesNavState(): DesignFilesNavState {
  return { currentDir: '', expandedDirs: [], preview: null };
}

function normalizeNavState(value: unknown): DesignFilesNavState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.currentDir !== 'string') return null;
  const expandedDirs = Array.isArray(record.expandedDirs)
    ? record.expandedDirs
        .filter((dir): dir is string => typeof dir === 'string')
        .slice(0, MAX_EXPANDED_DIRS)
    : [];
  return {
    currentDir: record.currentDir,
    expandedDirs,
    preview: typeof record.preview === 'string' ? record.preview : null,
  };
}

export function loadDesignFilesNavState(projectId: string): DesignFilesNavState {
  if (typeof window === 'undefined') return createDefaultDesignFilesNavState();
  try {
    const raw = window.localStorage.getItem(cacheKey(projectId));
    return normalizeNavState(JSON.parse(raw ?? 'null')) ?? createDefaultDesignFilesNavState();
  } catch {
    return createDefaultDesignFilesNavState();
  }
}

export function saveDesignFilesNavState(projectId: string, state: DesignFilesNavState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      cacheKey(projectId),
      JSON.stringify({
        currentDir: state.currentDir,
        expandedDirs: state.expandedDirs.slice(0, MAX_EXPANDED_DIRS),
        preview: state.preview,
      }),
    );
  } catch {
    // Best-effort: the panel still works without memory when storage is
    // full or unavailable.
  }
}
