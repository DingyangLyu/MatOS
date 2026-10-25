import { describe, expect, it } from 'vitest';
import { projectAssetSelectionRefs } from '../../src/runtime/matos-project-assets';

describe('project asset selection identity', () => {
  it('saves logical identities on initial selection and repeated saves after an upgrade', () => {
    expect(projectAssetSelectionRefs(['skill:procedure@0.1.0', 'skill:procedure@0.1.1', 'data:bundle']))
      .toEqual(['skill:procedure', 'data:bundle']);
    expect(projectAssetSelectionRefs(projectAssetSelectionRefs(['tool:query@1.0.0']))).toEqual(['tool:query']);
    expect(projectAssetSelectionRefs(['tool:query@1.0.0'], 'pinned')).toEqual(['tool:query@1.0.0']);
  });
});
