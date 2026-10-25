import { describe, expect, it, vi } from 'vitest';
import { buildLauncherActions, type LauncherContext } from '../../src/components/workspace/tab-launcher';

function baseContext(overrides: Partial<LauncherContext> = {}): LauncherContext {
  return {
    projectId: 'proj-1',
    openTab: () => {},
    ...overrides,
  };
}

describe('buildLauncherActions', () => {
  it('registers the materials viewer action when the callback is provided', () => {
    const createMaterialsViewer = vi.fn();
    const actions = buildLauncherActions(baseContext({ createMaterialsViewer }));
    const materials = actions.find((action) => action.id === 'new-materials-viewer');
    expect(materials).toBeDefined();
    expect(materials?.iconName).toBe('atom');
    expect(materials?.labelKey).toBe('workspace.newMaterialsViewer');
    expect(materials?.descriptionKey).toBe('workspace.newMaterialsViewerDescription');

    materials?.run(baseContext({ createMaterialsViewer }));
    expect(createMaterialsViewer).toHaveBeenCalledTimes(1);
  });

  it('omits the materials viewer action when no callback is wired', () => {
    const actions = buildLauncherActions(baseContext());
    expect(actions.some((action) => action.id === 'new-materials-viewer')).toBe(false);
  });
});
