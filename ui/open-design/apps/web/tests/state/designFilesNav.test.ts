// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultDesignFilesNavState,
  loadDesignFilesNavState,
  saveDesignFilesNavState,
} from '../../src/state/designFilesNav';

describe('designFilesNav cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns defaults when nothing was saved', () => {
    expect(loadDesignFilesNavState('p1')).toEqual({
      currentDir: '',
      expandedDirs: [],
      preview: null,
    });
  });

  it('round-trips a saved state per project', () => {
    saveDesignFilesNavState('p1', {
      currentDir: 'assets/icons',
      expandedDirs: ['assets', 'assets/icons'],
      preview: 'assets/icons/star.svg',
    });
    saveDesignFilesNavState('p2', {
      currentDir: '',
      expandedDirs: ['docs'],
      preview: null,
    });

    expect(loadDesignFilesNavState('p1')).toEqual({
      currentDir: 'assets/icons',
      expandedDirs: ['assets', 'assets/icons'],
      preview: 'assets/icons/star.svg',
    });
    expect(loadDesignFilesNavState('p2')).toEqual({
      currentDir: '',
      expandedDirs: ['docs'],
      preview: null,
    });
  });

  it('tolerates corrupt or foreign payloads', () => {
    window.localStorage.setItem('open-design:design-files-nav:v1:p1', 'not json{');
    expect(loadDesignFilesNavState('p1')).toEqual(createDefaultDesignFilesNavState());

    window.localStorage.setItem(
      'open-design:design-files-nav:v1:p1',
      JSON.stringify({ currentDir: 7, expandedDirs: 'nope' }),
    );
    expect(loadDesignFilesNavState('p1')).toEqual(createDefaultDesignFilesNavState());

    window.localStorage.setItem(
      'open-design:design-files-nav:v1:p1',
      JSON.stringify({ currentDir: 'a', expandedDirs: ['a', 5, null, 'a/b'], preview: 42 }),
    );
    expect(loadDesignFilesNavState('p1')).toEqual({
      currentDir: 'a',
      expandedDirs: ['a', 'a/b'],
      preview: null,
    });
  });

  it('caps the persisted expanded-dir list', () => {
    saveDesignFilesNavState('p1', {
      currentDir: '',
      expandedDirs: Array.from({ length: 500 }, (_, i) => `dir-${i}`),
      preview: null,
    });
    expect(loadDesignFilesNavState('p1').expandedDirs).toHaveLength(200);
  });
});
