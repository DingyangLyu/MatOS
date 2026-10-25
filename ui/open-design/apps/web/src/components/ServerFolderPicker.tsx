// Server-side folder picker for headless/gateway deployments.
//
// The upstream picker opens a native OS dialog on the daemon host, which
// does not exist behind the MatOS gateway (headless server, remote
// browser). This modal browses the daemon's jailed directory roots via
// `/api/matos/fs/dirs` instead, so "working directory" pickers operate on
// the user's actual server-side workspace.
//
// `requestServerFolder()` is the imperative bridge for non-React call
// sites (providers/registry.ts): it mounts nothing itself — the App
// renders one <ServerFolderPickerHost/> that listens for requests.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';

interface FsRoot {
  id: string;
  label: string;
  path: string;
}

interface FsListing {
  roots: FsRoot[];
  path: string | null;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
}

let pendingResolve: ((value: string | null) => void) | null = null;

/** True when the MatOS server-side browser is available on this daemon. */
export async function serverFolderBrowserAvailable(): Promise<boolean> {
  try {
    const resp = await fetch('/api/matos/fs/dirs', { headers: { accept: 'application/json' } });
    return resp.ok;
  } catch {
    return false;
  }
}

export function requestServerFolder(): Promise<string | null> {
  return new Promise((resolve) => {
    // A second concurrent request cancels the first.
    pendingResolve?.(null);
    pendingResolve = resolve;
    window.dispatchEvent(new CustomEvent('matos:pick-server-folder'));
  });
}

async function fetchListing(target: string | null): Promise<FsListing> {
  const url = target
    ? `/api/matos/fs/dirs?path=${encodeURIComponent(target)}`
    : '/api/matos/fs/dirs';
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as FsListing;
}

export function ServerFolderPickerHost() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const navigateTo = useCallback(async (target: string | null) => {
    setCreating(false);
    setNewName('');
    try {
      const next = await fetchListing(target);
      if (target === null && next.roots.length > 0) {
        // Land directly inside the first root instead of an empty shell.
        setListing(await fetchListing(next.roots[0]!.path));
      } else {
        setListing(next);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const createFolder = useCallback(async () => {
    const parent = listing?.path;
    const name = newName.trim();
    if (!parent || !name) return;
    setCreateBusy(true);
    try {
      const resp = await fetch('/api/matos/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent, name }),
      });
      const body = (await resp.json()) as {
        ok?: boolean;
        path?: string;
        error?: { message?: string };
      };
      if (!resp.ok || !body.ok || !body.path) {
        throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
      }
      setCreating(false);
      setNewName('');
      // Step straight into the freshly created folder so "Use this folder"
      // selects it with one more click.
      const next = await fetchListing(body.path);
      setListing(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [listing, newName]);

  useEffect(() => {
    const onRequest = () => {
      setOpen(true);
      setListing(null);
      setError(null);
      void navigateTo(null);
    };
    window.addEventListener('matos:pick-server-folder', onRequest);
    return () => window.removeEventListener('matos:pick-server-folder', onRequest);
  }, [navigateTo]);

  const finish = useCallback((value: string | null) => {
    setOpen(false);
    pendingResolve?.(value);
    pendingResolve = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open) return null;

  return (
    <div className="server-folder__backdrop" role="presentation" onClick={() => finish(null)}>
      <div
        className="server-folder"
        role="dialog"
        aria-modal="true"
        aria-label={t('folderPicker.title')}
        onClick={(event) => event.stopPropagation()}
        data-testid="server-folder-picker"
      >
        <div className="server-folder__head">
          <h2>{t('folderPicker.title')}</h2>
          <button type="button" className="server-folder__close" onClick={() => finish(null)} aria-label={t('repoImport.cancel')}>
            <Icon name="close" size={14} />
          </button>
        </div>

        {listing && listing.roots.length > 1 ? (
          <div className="server-folder__roots">
            {listing.roots.map((root) => (
              <button
                key={root.id}
                type="button"
                className={`server-folder__root${listing.path?.startsWith(root.path) ? ' is-active' : ''}`}
                onClick={() => void navigateTo(root.path)}
              >
                {root.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="server-folder__crumb" title={listing?.path ?? ''}>
          <Icon name="folder" size={13} />
          <code>{listing?.path ?? '…'}</code>
        </div>

        <div className="server-folder__list" role="listbox">
          {error ? (
            <div className="server-folder__state">{error}</div>
          ) : listing === null ? (
            <div className="server-folder__state">{t('assets.loading')}</div>
          ) : (
            <>
              {listing.parent ? (
                <button type="button" className="server-folder__row" onClick={() => void navigateTo(listing.parent)}>
                  <Icon name="arrow-up" size={13} />
                  <span>..</span>
                </button>
              ) : null}
              {listing.dirs.length === 0 && !listing.parent ? (
                <div className="server-folder__state">{t('folderPicker.empty')}</div>
              ) : (
                listing.dirs.map((dir) => (
                  <button
                    key={dir.path}
                    type="button"
                    className="server-folder__row"
                    onClick={() => void navigateTo(dir.path)}
                    data-testid={`server-folder-dir-${dir.name}`}
                  >
                    <Icon name="folder-filled" size={13} />
                    <span>{dir.name}</span>
                  </button>
                ))
              )}
            </>
          )}
        </div>

        {creating ? (
          <div className="server-folder__newrow">
            <Icon name="folder-filled" size={13} />
            <input
              autoFocus
              value={newName}
              placeholder={t('folderPicker.newFolderPlaceholder')}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createFolder();
                }
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setCreating(false);
                  setNewName('');
                }
              }}
              data-testid="server-folder-new-name"
            />
            <button
              type="button"
              className="assets-btn assets-btn--primary"
              disabled={!newName.trim() || createBusy}
              onClick={() => void createFolder()}
              data-testid="server-folder-new-confirm"
            >
              {createBusy ? t('assets.saving') : t('folderPicker.create')}
            </button>
          </div>
        ) : null}

        <div className="server-folder__foot">
          <button
            type="button"
            className="assets-btn server-folder__new-btn"
            disabled={!listing?.path}
            onClick={() => setCreating((current) => !current)}
            data-testid="server-folder-new"
          >
            <Icon name="plus" size={13} /> {t('folderPicker.newFolder')}
          </button>
          <span className="server-folder__foot-spacer" />
          <button type="button" className="assets-btn" onClick={() => finish(null)}>
            {t('repoImport.cancel')}
          </button>
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!listing?.path}
            onClick={() => finish(listing?.path ?? null)}
            data-testid="server-folder-select"
          >
            {t('folderPicker.select')}
          </button>
        </div>
      </div>
    </div>
  );
}
