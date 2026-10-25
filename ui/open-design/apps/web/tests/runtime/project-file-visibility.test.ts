import { describe, expect, it } from 'vitest';

import {
  isInternalMatOSProjectPath,
  isUserVisibleProjectFilePath,
} from '../../src/runtime/project-file-visibility';

describe('project file visibility', () => {
  it('hides MatOS sessions, evolution monitor records, and runtime state', () => {
    for (const path of [
      '.matos/sessions/session.jsonl',
      './.matos/evolution/monitor/sessions/id/records.jsonl',
      '.matos/evolution/monitor/claims/id',
      '/workspace/project/.matos/runtime/cache.json',
      'C:\\project\\.matos\\sessions\\session.jsonl',
    ]) {
      expect(isInternalMatOSProjectPath(path)).toBe(true);
      expect(isUserVisibleProjectFilePath(path)).toBe(false);
    }
  });

  it('preserves user-authored MatOS assets and ordinary project files', () => {
    for (const path of [
      '.matos/assets/packs/project/asset.json',
      '/workspace/project/.matos/assets/README.md',
      'results/energy.out',
      'runtime/user-script.py',
    ]) {
      expect(isInternalMatOSProjectPath(path)).toBe(false);
      expect(isUserVisibleProjectFilePath(path)).toBe(true);
    }
  });
});
