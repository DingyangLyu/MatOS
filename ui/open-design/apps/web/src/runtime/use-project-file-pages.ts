import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectFilesPageResponse } from '@open-design/contracts';
import { fetchProjectFilesPage } from '../providers/registry';
import type { ProjectFile } from '../types';

export interface ProjectFilePaging {
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => Promise<unknown>;
}

/** The loaded subset is explicitly separate from the daemon's full index.
 * Project switches/refreshes invalidate in-flight older-page responses. */
export function useProjectFilePages(projectId: string) {
  const [state, setState] = useState<ProjectFilesPageResponse>({ files: [], total: 0, nextCursor: null, snapshotAt: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(state);
  const generation = useRef(0);
  const refreshRequest = useRef<Promise<ProjectFile[]> | null>(null);
  const moreRequest = useRef<Promise<void> | null>(null);
  const commit = (next: ProjectFilesPageResponse) => { current.current = next; setState(next); };
  useEffect(() => {
    generation.current++;
    commit({ files: [], total: 0, nextCursor: null, snapshotAt: 0 });
    refreshRequest.current = null;
    moreRequest.current = null;
    setLoading(false); setError(null);
    return () => { generation.current++; };
  }, [projectId]);

  const refresh = useCallback((): Promise<ProjectFile[]> => {
    if (refreshRequest.current) return refreshRequest.current;
    const epoch = ++generation.current;
    const request = fetchProjectFilesPage(projectId).then(next => {
      if (generation.current !== epoch) return [];
      if (!next.snapshotAt || next.snapshotAt !== current.current.snapshotAt) commit(next);
      setError(null);
      return current.current.files;
    }).catch((err: unknown) => {
      if (generation.current === epoch) setError(String(err));
      return current.current.files;
    }).finally(() => {
      if (refreshRequest.current === request) refreshRequest.current = null;
    });
    refreshRequest.current = request;
    return request;
  }, [projectId]);

  const loadMore = useCallback((): Promise<void> => {
    if (moreRequest.current) return moreRequest.current;
    const cursor = current.current.nextCursor;
    if (!cursor) return Promise.resolve();
    const epoch = generation.current;
    setLoading(true);
    const request = fetchProjectFilesPage(projectId, cursor).then(next => {
      if (generation.current !== epoch) return;
      const byPath = new Map(current.current.files.map(file => [file.path || file.name, file]));
      for (const file of next.files) byPath.set(file.path || file.name, file);
      commit({ ...next, files: [...byPath.values()] });
      setError(null);
    }).catch((err: unknown) => {
      if (generation.current === epoch) setError(String(err));
    }).finally(() => {
      if (moreRequest.current === request) { moreRequest.current = null; setLoading(false); }
    });
    moreRequest.current = request;
    return request;
  }, [projectId]);
  return { files: state.files, refresh,
    paging: { total: state.total, hasMore: state.nextCursor !== null, loading, error,
      loadMore: state.nextCursor ? loadMore : refresh } satisfies ProjectFilePaging };
}
