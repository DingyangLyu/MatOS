import { useEffect, useState } from 'react';
import type { MatOSAssetArchiveDetail, MatOSAssetArchiveList, MatOSAssetArchiveRestore, MatOSAssetArchiveRevision } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body as T;
}

export function AssetRevisionArchive({ assetRef }: { assetRef?: string }) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [page, setPage] = useState<MatOSAssetArchiveList | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MatOSAssetArchiveRevision | null>(null);
  const [from, setFrom] = useState('');
  useEffect(() => { setOffset(0); setPage(null); setSelected(null); setFrom(''); }, [assetRef]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const query = new URLSearchParams({ offset: String(offset), ...(assetRef ? { asset: assetRef } : {}) });
    void request<MatOSAssetArchiveList>(`/api/matos/assets-archive?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message)); });
    return () => controller.abort();
  }, [assetRef, offset, refresh]);
  const states: Record<string, string> = zh ? {
    accepted: '已接受', 'accepted-local': '本地接受', candidate: '候选', 'validated-candidate': '候选已验证',
    snapshot: '快照', rollback: '回滚', 'restore-before': '回滚前', 'git-history': 'Git 历史',
  } : { accepted: 'Accepted', 'accepted-local': 'Locally accepted', candidate: 'Candidate', 'validated-candidate': 'Validated candidate', snapshot: 'Snapshot', rollback: 'Rollback', 'restore-before': 'Before restore' };
  return <section className="asset-archive" aria-label={zh ? '资产版本存档' : 'Asset revision archive'} data-testid="asset-revision-archive">
    <header className="asset-archive__header">
      <h2>{zh ? '版本存档' : 'Revision Archive'} {page ? <small>{page.total}</small> : null}</h2>
      <button type="button" className="assets-btn" title={zh ? '刷新存档' : 'Refresh archive'} aria-label={zh ? '刷新存档' : 'Refresh archive'} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={15} /></button>
    </header>
    {error ? <p role="alert" className="assets-view__error">{error}</p> : !page ? <p role="status">{zh ? '正在读取版本存档…' : 'Loading revisions...'}</p> : <>
      {page.issues.length ? <p role="status" className="assets-view__error">{zh ? '部分存档内容不可用，请检查归档完整性。' : 'Some archive content is unavailable. Check archive integrity.'}</p> : null}
      {!page.revisions.length ? <p>{zh ? '暂无版本存档' : 'No archived revisions'}</p> : <div className="asset-archive__layout">
        <div className="asset-archive__revisions">
          <ol className="asset-archive__list">
            {page.revisions.map(revision => <li key={revision.revisionId}>
              <button type="button" className={`asset-archive__row${selected?.revisionId === revision.revisionId ? ' is-selected' : ''}`} aria-pressed={selected?.revisionId === revision.revisionId} onClick={() => { setSelected(revision); setFrom(''); }}>
                <span className="asset-archive__name">{revision.name}<span className={`asset-archive__state is-${revision.state}`}>{revision.configuredCurrent ? (zh ? '当前配置' : 'Configured current') : states[revision.state] || revision.state}</span></span>
                <code>{revision.assetRef}</code>
                <span className="asset-archive__meta"><time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString()}</time><code>{(revision.sourceCommit || revision.commit).slice(0, 10)}</code></span>
                <span className="asset-archive__meta">{revision.scopeRef || revision.scope} · {revision.fileCount} {zh ? '个文件' : 'files'}</span>
              </button>
            </li>)}
          </ol>
          <nav className="asset-archive__pagination" aria-label={zh ? '存档分页' : 'Archive pages'}>
            <button className="assets-btn" type="button" disabled={offset === 0} onClick={() => { setPage(null); setOffset(Math.max(0, offset - 50)); }} aria-label={zh ? '上一页' : 'Previous page'} title={zh ? '上一页' : 'Previous page'}><Icon name="chevron-left" size={14} /></button>
            <span>{offset + 1} - {offset + page.revisions.length} / {page.total}</span>
            <button className="assets-btn" type="button" disabled={!page.hasMore} onClick={() => { setPage(null); setOffset(page.nextOffset); }} aria-label={zh ? '下一页' : 'Next page'} title={zh ? '下一页' : 'Next page'}><Icon name="chevron-right" size={14} /></button>
          </nav>
        </div>
        {selected ? <div className="asset-archive__detail">
          <label className="asset-archive__compare">{zh ? '比较版本' : 'Compare revision'}
            <select value={from} onChange={event => setFrom(event.target.value)}>
              <option value="">{zh ? '完整内容' : 'Full content'}</option>
              {page.revisions.filter(item => item.revisionId !== selected.revisionId && item.assetRef.split('@')[0] === selected.assetRef.split('@')[0] && item.scope === selected.scope && item.scopeRef === selected.scopeRef && item.sourceId === selected.sourceId).map(item => <option key={item.revisionId} value={item.revisionId}>{item.version} · {new Date(item.createdAt).toLocaleString()} · {item.commit.slice(0, 7)}</option>)}
            </select>
          </label>
          <RevisionContent key={`${selected.revisionId}:${from}`} revision={selected} from={from} zh={zh} onRestored={() => setRefresh(value => value + 1)} />
        </div> : null}
      </div>}
    </>}
  </section>;
}

function RevisionContent({ revision, from, zh, onRestored }: { revision: MatOSAssetArchiveRevision; from: string; zh: boolean; onRestored: () => void }) {
  const [detail, setDetail] = useState<MatOSAssetArchiveDetail | null>(null);
  const [diff, setDiff] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MatOSAssetArchiveRestore | null>(null);
  const [result, setResult] = useState<MatOSAssetArchiveRestore | null>(null);
  const url = `/api/matos/assets-archive/${encodeURIComponent(revision.revisionId)}`;
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const task = from ? request<{ patch: string; truncated: boolean }>(`${url}?from=${encodeURIComponent(from)}`, options).then(value => setDiff(value)) : request<MatOSAssetArchiveDetail>(url, options).then(value => setDetail(value));
    void task.catch(reason => { if (!controller.signal.aborted) setError(String(reason.message)); });
    return () => controller.abort();
  }, [url, from]);
  const restore = async (apply: boolean) => {
    setBusy(true); setError(''); setResult(null);
    try {
      const value = await request<MatOSAssetArchiveRestore>(`${url}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply, expectedCurrent: preview?.expectedCurrent }) });
      if (value.ok === false) throw new Error(zh ? '回滚未通过校验，运行版本未更新。' : 'Rollback failed validation; the runtime version was not updated.');
      if (apply) { setResult(value); setPreview(null); onRestored(); } else setPreview(value);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setPreview(null); }
    finally { setBusy(false); }
  };
  return <>
    {revision.audit ? <div className="asset-archive__audit"><code>{revision.audit.runId}</code>{revision.audit.verdict ? <span> · {revision.audit.verdict}</span> : null}<p>{revision.audit.summary}</p>{revision.audit.expectedBehaviorChange ? <p>{revision.audit.expectedBehaviorChange}</p> : null}</div> : null}
    <div className="asset-archive__actions">
      <code>{revision.sourceCommit || revision.commit}</code>
      <button type="button" className="assets-btn" disabled={busy} onClick={() => void restore(false)}><Icon name="history" size={14} />{zh ? '回滚预览' : 'Preview rollback'}</button>
    </div>
    {error ? <p role="alert" className="assets-view__error">{error}</p> : null}
    {busy ? <p role="status">{zh ? '正在验证…' : 'Validating...'}</p> : null}
    {preview ? <div className="asset-archive__confirmation" role="group" aria-label={zh ? '确认回滚' : 'Confirm rollback'}>
      <strong>{preview.mode === 'candidate' ? (zh ? '创建回滚候选，运行版本保持不变' : 'Create rollback candidate; runtime stays unchanged') : (zh ? '恢复所选资产，保留恢复前快照' : 'Restore this asset with a before-restore snapshot')}</strong>
      {preview.canRestore ? <>
        <ul>{preview.files?.map(file => <li key={file}><code>{file}</code></li>)}</ul>
        <button type="button" className="assets-btn" disabled={busy} onClick={() => void restore(true)}>{zh ? '确认回滚' : 'Confirm rollback'}</button>
      </> : <p>{zh ? '该版本需要资产所有者审核，或当前无需变更。' : 'Owner review is required, or no changes are needed.'}</p>}
      <button type="button" className="assets-btn" disabled={busy} onClick={() => setPreview(null)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {result ? <p role="status">{result.action === 'noop' ? (zh ? '内容一致，无需变更。' : 'No changes needed.') : result.action === 'restored' ? (zh ? '已恢复，前后快照已存档。' : 'Restored; before and after snapshots archived.') : (zh ? '回滚候选已提交，等待接受。' : 'Rollback candidate submitted for acceptance.')}
      {/^https?:\/\//.test(result.pullRequest?.url || result.pullRequest?.html_url || '') ? <> <a href={result.pullRequest?.url || result.pullRequest?.html_url} target="_blank" rel="noopener noreferrer">{zh ? '查看候选' : 'View candidate'}</a></> : null}
    </p> : null}
    {diff ? <><pre className="asset-archive__code">{diff.patch || (zh ? '内容一致' : 'No changes')}</pre>{diff.truncated ? <p>{zh ? '差异预览已截断' : 'Diff preview truncated'}</p> : null}</> : detail ? detail.files.map(file => <details key={file.path} open={file.path === 'asset.json'}><summary><code>{file.path}</code> <small>{file.sizeBytes} B</small></summary><pre className="asset-archive__code">{file.content ?? (zh ? '内容不可预览' : 'Content unavailable for preview')}</pre></details>) : !error ? <p role="status">{zh ? '正在读取内容…' : 'Loading content...'}</p> : null}
  </>;
}
