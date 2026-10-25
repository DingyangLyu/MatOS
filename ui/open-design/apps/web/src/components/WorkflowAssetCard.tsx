import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { navigate } from '../router';
import { matOSAssetSelectionRef, type MatOSAssetSummary } from '../runtime/matos-assets';
import { Icon } from './Icon';
import { WorkflowMiniMap } from './WorkflowMiniMap';
import type { WorkflowPreviewGraph } from './workflow-minimap-model';

export type WorkflowPreviews = Map<string, WorkflowPreviewGraph> | null | undefined;

// The daemon caches file parsing. Re-read on mount/refresh so asset edits and
// a transient failure cannot leave the browser stuck with an obsolete graph.
export function useWorkflowPreviews(enabled = true) {
  const [previews, setPreviews] = useState<WorkflowPreviews>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    setPreviews(undefined);
    const timeout = setTimeout(() => { controller.abort(); if (active) setPreviews(null); }, 45_000);
    void (async () => {
      try {
        const response = await fetch(`/api/matos/workflow-previews${revision ? '?refresh=1' : ''}`, {
          cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { previews?: WorkflowPreviewGraph[] };
        if (!Array.isArray(body.previews)) throw new Error('Invalid workflow previews');
        const map = new Map<string, WorkflowPreviewGraph>();
        for (const preview of body.previews) {
          map.set(preview.canonicalKey ?? preview.ref, preview);
        }
        if (active) setPreviews(map);
      } catch {
        if (active) setPreviews(null);
      } finally { clearTimeout(timeout); }
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [enabled, revision]);
  return { previews, refreshPreviews: () => setRevision(value => value + 1) };
}

export function workflowPreviewFor(asset: MatOSAssetSummary, previews: WorkflowPreviews) {
  return previews?.get(matOSAssetSelectionRef(asset)) ?? previews?.get(asset.ref) ?? null;
}

export function compareWorkflowAssets(a: MatOSAssetSummary, b: MatOSAssetSummary, previews: WorkflowPreviews) {
  const left = workflowPreviewFor(a, previews);
  const right = workflowPreviewFor(b, previews);
  return (right?.nodeCount ?? 0) - (left?.nodeCount ?? 0)
    || (right?.edgeCount ?? 0) - (left?.edgeCount ?? 0)
    || a.id.localeCompare(b.id)
    || matOSAssetSelectionRef(a).localeCompare(matOSAssetSelectionRef(b));
}

export function WorkflowAssetDraftButton({ asset, disabled = false }: { asset: MatOSAssetSummary; disabled?: boolean }) {
  const t = useT();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openCopy = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const { createWorkflowAssetDraft } = await import('./workflow-asset-draft');
      const draft = await createWorkflowAssetDraft(asset, t);
      navigate({ kind: 'project', projectId: draft.projectId, conversationId: draft.conversationId, fileName: draft.seedName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { pending.current = false; setBusy(false); }
  };
  return <div className="wf-asset-card__copy">
    <button type="button" className="assets-btn" disabled={disabled || busy}
      onClick={() => void openCopy()} data-testid="workflow-asset-edit-copy">
      <Icon name={busy ? 'spinner' : 'copy'} size={14} />{t('workflow.gallery.edit')}
    </button>
    {error ? <p className="wf-asset-card__error" role="alert">{error}</p> : null}
  </div>;
}

export function WorkflowAssetCard({ asset, previews }: { asset: MatOSAssetSummary; previews: WorkflowPreviews }) {
  const t = useT();
  const preview = workflowPreviewFor(asset, previews);
  const structured = /\.(json|ya?ml)$/i.test(asset.entry ?? '');
  const open = () => navigate({ kind: 'home', view: 'assets', assetRef: matOSAssetSelectionRef(asset) });
  const state = !structured ? 'workflow.gallery.document' : previews === undefined
    ? 'assets.loading' : preview ? 'workflow.gallery.definition' : 'workflow.gallery.unavailable';
  return <article className="wf-asset-card" data-asset-type="workflow" data-asset-ref={asset.ref}
    data-node-count={preview?.nodeCount ?? 0}>
    <header className="wf-asset-card__header">
      <Icon name="fork" size={16} />
      <button type="button" onClick={open} title={asset.name}
        data-testid={`matos-assets-home-open-${asset.ref}`}>{asset.name}</button>
      <span>{asset.version ? `v${asset.version}` : ''}</span>
    </header>
    <button type="button" className="wf-asset-card__preview" onClick={open} aria-label={`${t('assetsHome.open')} ${asset.name}`}>
      {preview ? <>
        <WorkflowMiniMap preview={preview} compact />
        {preview.nodeCount > 9 ? <span className="wf-asset-card__more">+{preview.nodeCount - 9}</span> : null}
      </> : <span className="wf-asset-card__empty">
        <Icon name={!structured ? 'file-text' : previews === undefined ? 'spinner' : 'alert-triangle'} size={22} />{t(state)}
      </span>}
    </button>
    <div className="wf-asset-card__body">
      <div className="wf-asset-card__stats">
        <span>{preview ? t('assetsHome.wfStats', { nodes: preview.nodeCount, edges: preview.edgeCount }) : t(state)}</span>
        {asset.status && asset.status !== 'enabled' ? <span>{asset.status}</span> : null}
      </div>
      <p title={asset.description ?? ''}>{asset.description || asset.name}</p>
    </div>
    <footer className="wf-asset-card__footer">
      <button type="button" className="assets-btn" onClick={open}><Icon name="external-link" size={14} />{t('assetsHome.open')}</button>
      {structured ? <WorkflowAssetDraftButton asset={asset} disabled={!preview} /> : null}
    </footer>
  </article>;
}
