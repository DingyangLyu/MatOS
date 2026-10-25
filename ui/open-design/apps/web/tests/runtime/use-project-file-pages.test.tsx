// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectFilePages } from '../../src/runtime/use-project-file-pages';
import type { ProjectFilesPageResponse } from '@open-design/contracts';

const fetchPage = vi.hoisted(() => vi.fn());
vi.mock('../../src/providers/registry', () => ({ fetchProjectFilesPage: (...args: unknown[]) => fetchPage(...args) }));
afterEach(() => { cleanup(); fetchPage.mockReset(); });
const page = (names: string[], nextCursor: string | null = null, snapshotAt = 1): ProjectFilesPageResponse => ({
  files: names.map(name => ({ name, size: 1, mtime: 1, mime: 'text/plain', kind: 'text' })),
  total: 5, nextCursor, snapshotAt,
});
describe('incremental project file browsing', () => {
  it('loads older files only on demand, deduplicates paths, and preserves a loaded page on unchanged refresh', async () => {
    fetchPage.mockResolvedValueOnce(page(['a'], 'older')).mockResolvedValueOnce(page(['a', 'b'], 'end')).mockResolvedValueOnce(page(['a'], 'older'));
    const { result } = renderHook(() => useProjectFilePages('p'));
    expect(fetchPage).not.toHaveBeenCalled();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.files.map(f => f.name)).toEqual(['a']);
    await act(async () => { await result.current.paging.loadMore(); });
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'p', 'older');
    expect(result.current.files.map(f => f.name)).toEqual(['a', 'b']);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.files.map(f => f.name)).toEqual(['a', 'b']);
  });
  it('ignores a delayed response after switching projects', async () => {
    let resolve!: (value: ProjectFilesPageResponse) => void;
    fetchPage.mockReturnValueOnce(new Promise<ProjectFilesPageResponse>(r => { resolve = r; }));
    const { result, rerender } = renderHook(({ id }) => useProjectFilePages(id), { initialProps: { id: 'a' } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.refresh(); });
    rerender({ id: 'b' });
    await act(async () => { resolve(page(['private-a'])); await pending; });
    expect(result.current.files).toEqual([]);
  });
  it('does not append an obsolete older page after a newer refresh', async () => {
    let resolve!: (value: ProjectFilesPageResponse) => void;
    fetchPage.mockResolvedValueOnce(page(['a'], 'older'))
      .mockReturnValueOnce(new Promise<ProjectFilesPageResponse>(r => { resolve = r; }))
      .mockResolvedValueOnce(page(['new'], 'new-cursor', 2));
    const { result } = renderHook(() => useProjectFilePages('p'));
    await act(async () => { await result.current.refresh(); });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.paging.loadMore(); });
    await act(async () => { await result.current.refresh(); });
    await act(async () => { resolve(page(['old'])); await pending; });
    expect(result.current.files.map(f => f.name)).toEqual(['new']);
  });
  it('retains files and a retryable cursor on failure', async () => {
    fetchPage.mockResolvedValueOnce(page(['a'], 'older')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(['b']));
    const { result } = renderHook(() => useProjectFilePages('p'));
    await act(async () => { await result.current.refresh(); });
    await act(async () => { await result.current.paging.loadMore(); });
    expect(result.current.files.map(f => f.name)).toEqual(['a']);
    expect(result.current.paging.error).toContain('offline');
    expect(result.current.paging.hasMore).toBe(true);
    await act(async () => { await result.current.paging.loadMore(); });
    expect(result.current.files.map(f => f.name)).toEqual(['a', 'b']);
    expect(result.current.paging.error).toBeNull();
  });
});
