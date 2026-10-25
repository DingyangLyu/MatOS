import { describe, expect, it } from 'vitest';

import {
  isSharedWithMeProject,
  sharedWithMeProjectLabel,
  STATUS_LABEL_KEYS,
  STATUS_ORDER,
} from '../../src/components/DesignsTab';

describe('DesignsTab status metadata', () => {
  it('places awaiting_input between running and succeeded', () => {
    expect(STATUS_ORDER).toEqual([
      'not_started',
      'running',
      'awaiting_input',
      'succeeded',
      'failed',
      'canceled',
    ]);
  });

  it('maps awaiting_input to the i18n label key', () => {
    expect(STATUS_LABEL_KEYS.awaiting_input).toBe('designs.status.awaitingInput');
  });

  it('uses the daemon shared-workspaces location as the ownership boundary', () => {
    expect(isSharedWithMeProject({
      metadata: {
        kind: 'other',
        projectLocationId: 'shared-workspaces',
        importedFrom: 'project-location',
      },
    })).toBe(true);
    expect(isSharedWithMeProject({
      metadata: {
        kind: 'other',
        projectLocationId: 'workspace-projects',
        importedFrom: 'project-location',
      },
    })).toBe(false);
  });

  it('localizes the shared boundary label for both Chinese scripts', () => {
    expect(sharedWithMeProjectLabel('zh-CN')).toBe('导入项目');
    expect(sharedWithMeProjectLabel('zh-TW')).toBe('匯入專案');
    expect(sharedWithMeProjectLabel('en')).toBe('Imported project');
  });
});
