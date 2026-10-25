import { describe, expect, it } from 'vitest';
import { projectImageCover, projectImageCovers } from '../../src/utils/projectImageCover';
import type { Project, ProjectFile } from '../../src/types';
const project: Project = { id: 'p', name: 'Project', createdAt: 1, updatedAt: 1, skillId: null };
const file = (name: string, mtime = 1): ProjectFile => ({ name, mtime, kind: 'image', size: 1, mime: 'image/png' });
describe('real project image selection', () => {
  it('prefers the explicit image and otherwise the latest actual image, deterministically', () => {
    const files = [file('old.png'), file('z.png', 2), file('a.png', 2)];
    expect(projectImageCover(project, files)?.name).toBe('a.png');
    expect(projectImageCover({ ...project, metadata: { kind: 'prototype', entryFile: 'old.png' } }, files)?.name).toBe('old.png');
  });
  it.each(['index.html', '../secret.png', '/host/secret.png', 'https://external/cover.png', 'data:image/png', 'a\\b.png', 'x\n.png'])('does not render an unsafe or non-image entry %s', entryFile => {
    expect(projectImageCover({ ...project, metadata: { kind: 'prototype', entryFile } }, [file(entryFile)])).toBeNull();
  });
  it('keeps nested image paths returned by the native file list', () => {
    expect(projectImageCover(project, [{ ...file('组织图.png'), path: 'results/组织图.png' }])?.name).toBe('results/组织图.png');
  });
  it('prefers covers and result figures over incidental new screenshots', () => {
    const files = [file('screenshot.png', 100), file('results/plot.png', 10), file('cover.png', 1)];
    expect(projectImageCovers(project, files).map(image => image.name)).toEqual(['cover.png', 'results/plot.png', 'screenshot.png']);
    expect(projectImageCovers(project, [...files].reverse())).toEqual(projectImageCovers(project, files));
  });
  it.each(['app-icon.png', 'matos-logo.png', 'logo.svg', 'favicon-32.png', 'icons/settings.png', 'node_modules/lib/chart.png'])('never automatically uses branding or implementation assets: %s', name => {
    expect(projectImageCover(project, [file(name)])).toBeNull();
    expect(projectImageCover({ ...project, metadata: { kind: 'prototype', entryFile: name } }, [file(name)])).toBeNull();
  });
  it('deduplicates an explicit cover returned in the file inventory', () => {
    expect(projectImageCovers({ ...project, metadata: { kind: 'prototype', entryFile: 'cover.png' } }, [file('cover.png')])).toHaveLength(1);
  });
});
