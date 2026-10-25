import { describe, expect, it } from 'vitest';

import { filterImplicitProducedFiles } from '../src/produced-files';
import type { ProjectFile } from '../src/types';

function file(name: string): ProjectFile {
  return {
    name,
    path: name,
    size: 1,
    mtime: 1,
    kind: 'text',
    mime: 'text/plain',
  };
}

describe('produced-file visibility', () => {
  it('removes MatOS runtime/session/evolution records from assistant output', () => {
    const visible = filterImplicitProducedFiles([
      file('.matos/sessions/session-id.jsonl'),
      file('.matos/evolution/monitor/sessions/session-id/records.jsonl'),
      file('.matos/evolution/monitor/claims/session-id'),
      file('.matos/runtime/cache.json'),
      file('.matos/assets/packs/project/asset.json'),
      file('results/report.md'),
    ]);

    expect(visible.map((entry) => entry.name)).toEqual([
      '.matos/assets/packs/project/asset.json',
      'results/report.md',
    ]);
  });
});
