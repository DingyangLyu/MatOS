import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatOSAssetProject } from '../src/matos-asset-projects';
import { createProject } from '../src/state/projects';
import { writeProjectTextFileDetailed } from '../src/providers/registry';
import { navigate } from '../src/router';
import type { useT } from '../src/i18n';

vi.mock('../src/state/projects', () => ({ createProject: vi.fn() }));
vi.mock('../src/providers/registry', () => ({
  writeProjectTextFile: vi.fn(),
  writeProjectTextFileDetailed: vi.fn(),
}));
vi.mock('../src/router', () => ({ navigate: vi.fn() }));

const t = ((key: string) => key) as ReturnType<typeof useT>;

describe('workflow draft project handoff', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createProject).mockResolvedValue({
      project: {
        id: 'draft-project',
        name: 'Workflow',
        createdAt: 1,
        updatedAt: 1,
        skillId: null,
      },
      conversationId: 'native-conversation',
    });
  });

  it('opens the seeded file in the original project conversation', async () => {
    vi.mocked(writeProjectTextFileDetailed).mockResolvedValue({
      ok: true,
      file: {
        name: 'workflow.json',
        kind: 'workflow',
        mime: 'application/json',
        size: 1,
        mtime: 1,
      },
    });
    await createMatOSAssetProject('workflow', t);
    expect(writeProjectTextFileDetailed).toHaveBeenCalledWith(
      'draft-project',
      'workflow.json',
      expect.any(String),
      { expectedEtag: null },
    );
    expect(navigate).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'draft-project',
      conversationId: 'native-conversation',
      fileName: 'workflow.json',
    });
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPrompt: 'createMenu.prompt.workflow',
      }),
    );
  });

  it.each([409, 500])(
    'does not open a missing or overwritten draft after HTTP %d',
    async (status) => {
      vi.mocked(writeProjectTextFileDetailed).mockResolvedValue({
        ok: false,
        status,
        message: 'Seed write failed',
      });
      await expect(createMatOSAssetProject('workflow', t)).rejects.toThrow('Seed write failed');
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});
