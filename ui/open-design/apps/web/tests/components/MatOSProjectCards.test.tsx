// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignsTab } from '../../src/components/DesignsTab';
import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import { visibleProjectDirectory } from '../../src/utils/projectWorkspace';
import { I18nProvider } from '../../src/i18n';
import { fetchProjectCoverFiles, fetchProjectFileText } from '../../src/providers/registry';
import type { Project } from '../../src/types';

// Presentation fixtures only; no MatOS execution/provider is replaced.
vi.mock('../../src/providers/registry', () => ({
  fetchProjectCoverFiles: vi.fn(async () => []), fetchProjectFileText: vi.fn(async () => null),
  projectFileUrl: (_id: string, name: string) => `/files/${name}`,
}));
const project: Project = {
  id: 'p-1', name: '镍基合金研究', createdAt: 1, updatedAt: 2,
  skillId: null, status: { value: 'succeeded' },
  metadata: { kind: 'prototype', goal: '比较不同热处理条件下的材料性能', baseDir: '/workspace/group/shared/projects/未命名项目-1' },
  overview: { conversationCount: 3, latestConversationTitle: '比较拉伸结果', projectDir: '/workspace/group/shared/projects/未命名项目-1' },
};
afterEach(() => {
  cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
});
function renderSurface(home = false, projects = [project], onOpen = vi.fn(), onRename = vi.fn()) {
  render(<I18nProvider initial="zh-CN">{home
    ? <RecentProjectsStrip nativeMatOSChat projects={projects} onOpen={onOpen} onRename={onRename} onViewAll={() => {}} />
    : <DesignsTab nativeMatOSChat projects={projects} skills={[]} onOpen={onOpen} onRename={onRename} onDelete={() => {}} />
  }</I18nProvider>);
  return { onOpen, onRename };
}
describe('native MatOS project cards', () => {
  it.each([false, true])('opens preview cards in the web workspace (home=%s)', async home => {
    const { onOpen } = renderSurface(home);
    await waitFor(() => expect(fetchProjectCoverFiles).toHaveBeenCalled());
    expect(screen.getByTestId('matos-project-card').querySelector('[data-project-title]')?.textContent).toBe(project.name);
    expect(screen.queryByText(project.metadata!.goal!)).toBeNull();
    expect(screen.queryByText('原型')).toBeNull();
    expect(screen.queryByText(/自由设计/)).toBeNull();
    expect(screen.queryByText(/已完成/)).toBeNull();
    expect(document.querySelector('.project-thumb-face, .recent-projects__card-glyph')).toBeNull();
    expect(screen.queryByRole('button', { name: /OpenVSCode/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: project.name }));
    expect(onOpen).toHaveBeenCalledWith(project.id);
    expect(fetchProjectFileText).not.toHaveBeenCalled();
  });
  it('restores six recent projects instead of four oversized cards', () => {
    renderSurface(true, Array.from({ length: 8 }, (_, i) => ({ ...project, id: `p-${i}`, updatedAt: i })));
    expect(screen.getAllByTestId('matos-project-card')).toHaveLength(6);
  });
  it('searches the actual directory as well as the display name', () => {
    renderSurface();
    fireEvent.change(screen.getByRole('textbox', { name: /搜索/ }), { target: { value: '未命名项目-1' } });
    expect(screen.getByRole('button', { name: project.name })).toBeTruthy();
  });
  it.each([false, true])('keeps images and falls back to the project name (home=%s)', async home => {
    vi.mocked(fetchProjectCoverFiles).mockResolvedValueOnce([
      { name: 'index.html', kind: 'html', mtime: 9, size: 12, mime: 'text/html' },
      { name: '显微组织.png', kind: 'image', mtime: 2, size: 30, mime: 'image/png' },
    ]);
    const { onOpen } = renderSurface(home);
    const card = screen.getByTestId('matos-project-card');
    await waitFor(() => expect(card.querySelector('img')?.getAttribute('src')).toBe('/files/显微组织.png'));
    const image = card.querySelector('img')!;
    expect(card.querySelector('iframe')).toBeNull();
    fireEvent.click(image);
    expect(onOpen).toHaveBeenCalledWith(project.id);
    fireEvent.error(image);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[data-project-title]')?.textContent).toBe(project.name);
    expect(card.querySelector('[data-project-cover]')).toBeNull();
    expect(card.querySelector('.project-thumb-face, .recent-projects__card-glyph')).toBeNull();
  });
  it.each([false, true])('tries another real image when the selected cover fails (home=%s)', async home => {
    vi.mocked(fetchProjectCoverFiles).mockResolvedValueOnce([
      { name: 'figure.png', kind: 'image', mtime: 2, size: 30, mime: 'image/png' },
      { name: 'matos-logo.png', kind: 'image', mtime: 9, size: 30, mime: 'image/png' },
    ]);
    renderSurface(home, [{ ...project, metadata: { kind: 'prototype', entryFile: 'missing.png' } }]);
    const card = screen.getByTestId('matos-project-card');
    fireEvent.error(card.querySelector('img')!);
    await waitFor(() => expect(card.querySelector('img')?.getAttribute('src')).toBe('/files/figure.png'));
    expect(fetchProjectCoverFiles).toHaveBeenCalledOnce();
    fireEvent.error(card.querySelector('img')!);
    expect(card.querySelector('img')).toBeNull();
    expect(fetchProjectCoverFiles).toHaveBeenCalledOnce();
  });
  it('ignores tiny icons even with an unrecognizable filename', async () => {
    vi.mocked(fetchProjectCoverFiles).mockResolvedValueOnce([
      { name: 'unknown.png', kind: 'image', mtime: 2, size: 30, mime: 'image/png' },
    ]);
    renderSurface();
    const card = screen.getByTestId('matos-project-card');
    await waitFor(() => expect(card.querySelector('img')).not.toBeNull());
    const image = card.querySelector('img')!;
    Object.defineProperties(image, { naturalWidth: { value: 32 }, naturalHeight: { value: 32 } });
    fireEvent.load(image);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[data-project-title]')).not.toBeNull();
  });
  it.each([false, true])('honors an explicit image entry without scanning files (home=%s)', async home => {
    renderSurface(home, [{ ...project, metadata: { ...project.metadata!, entryFile: 'cover.png' } }]);
    await waitFor(() => expect(screen.getByTestId('matos-project-card').querySelector('img')?.getAttribute('src')).toBe('/files/cover.png'));
    expect(fetchProjectCoverFiles).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps the shared boundary and rename action (home=%s)', async home => {
    const shared: Project = { ...project, metadata: { kind: 'other', importedFrom: 'project-location', projectLocationId: 'shared-workspaces' } };
    const { onOpen, onRename } = renderSurface(home, [shared]);
    expect(screen.getByTestId('matos-project-card').dataset.projectBoundary).toBe('shared-with-me');
    expect(screen.getByTestId('project-shared-with-me-tag')).toBeTruthy();
    const more = screen.getByRole('button', { name: '更多操作' });
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新名称' } });
    fireEvent.submit(dialog);
    expect(onRename).toHaveBeenCalledWith(project.id, '新名称');
    expect(onOpen).not.toHaveBeenCalled();
  });
  it('keeps selection mode and the compact task board', () => {
    const { onOpen } = renderSurface();
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    fireEvent.click(screen.getByRole('button', { name: project.name }));
    expect(screen.getByTestId('matos-project-card').classList.contains('is-selected')).toBe(true);
    expect(screen.queryByRole('button', { name: /OpenVSCode/ })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    expect(document.querySelector('.design-kanban-card')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /OpenVSCode/ })).toBeNull();
  });
  it('does not expose host-only directories', () => {
    expect(visibleProjectDirectory({ ...project, overview: { conversationCount: 1, projectDir: '/vepfs/private/owner/project' } })).toBeNull();
    expect(visibleProjectDirectory({ ...project, overview: undefined, metadata: undefined })).toBeNull();
  });
});
