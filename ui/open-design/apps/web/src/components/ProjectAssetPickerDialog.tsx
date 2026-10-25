import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { projectAssetSelectionRefs } from '../runtime/matos-project-assets';
import {
  assetBoundaryOf,
  fetchMatOSAssets,
  matOSAssetSelectionRef,
  matchesMatOSAssetBoundary,
  versionlessMatOSAssetRef,
  type MatOSAssetSummary,
} from '../runtime/matos-assets';
import { Icon } from './Icon';
import { assetAccentStyle, assetTypeMeta } from './asset-type-meta';
import styles from './ProjectAssetPickerDialog.module.css';

const PROJECT_SELECTABLE_TYPES = new Set([
  'knowledge',
  'data',
  'tool',
  'mcp',
  'skill',
  'workflow',
  'role',
]);
const MAX_PROJECT_ASSET_REFS = 64;

type BoundaryFilter = 'all' | 'public' | 'mine' | 'shared' | 'evolved' | 'project';

function matchesBoundary(
  asset: MatOSAssetSummary,
  filter: Exclude<BoundaryFilter, 'project'>,
): boolean {
  return matchesMatOSAssetBoundary(asset, filter);
}

function projectAssetIdentity(asset: MatOSAssetSummary): string {
  return `${asset.type}:${asset.id}`;
}

function projectAssetPickerPriority(asset: MatOSAssetSummary): number {
  const boundary = assetBoundaryOf(asset);
  if (boundary.sharedCopy) return 0;
  if (boundary.owner === 'current-scope') return 1;
  if (boundary.visibility === 'collaborative') return 2;
  return 3;
}

function preferProjectAssetPickerRow(
  current: MatOSAssetSummary,
  candidate: MatOSAssetSummary,
  selected: ReadonlySet<string>,
): MatOSAssetSummary {
  const currentRef = matOSAssetSelectionRef(current);
  const candidateRef = matOSAssetSelectionRef(candidate);
  const currentSelected = isProjectAssetSelected(current, selected);
  const candidateSelected = isProjectAssetSelected(candidate, selected);
  if (currentSelected !== candidateSelected) return candidateSelected ? candidate : current;
  const currentPriority = projectAssetPickerPriority(current);
  const candidatePriority = projectAssetPickerPriority(candidate);
  if (currentPriority !== candidatePriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }
  const versionOrder = (candidate.version ?? '').localeCompare(
    current.version ?? '',
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
  if (versionOrder !== 0) return versionOrder > 0 ? candidate : current;
  return candidateRef.localeCompare(currentRef) < 0 ? candidate : current;
}

/** The registry catalog deliberately retains multiple versions. A project
 * run, however, can bind only one effective version of a type:id identity.
 * Collapse that history for this picker, preferring the already-pinned
 * selection, then the user's/project overlay, then the newest public row. */
export function collapseProjectAssetPickerRows(
  assets: MatOSAssetSummary[],
  selected: ReadonlySet<string>,
): MatOSAssetSummary[] {
  const collapsed = new Map<string, MatOSAssetSummary>();
  for (const asset of assets) {
    const identity = projectAssetIdentity(asset);
    const current = collapsed.get(identity);
    collapsed.set(
      identity,
      current ? preferProjectAssetPickerRow(current, asset, selected) : asset,
    );
  }
  return [...collapsed.values()];
}

function isProjectAssetSelected(
  asset: MatOSAssetSummary,
  selected: ReadonlySet<string>,
): boolean {
  const exact = matOSAssetSelectionRef(asset);
  return selected.has(exact) || selected.has(projectAssetIdentity(asset));
}

export function resolvedProjectAssetSelections(
  selected: ReadonlySet<string>,
  assets: MatOSAssetSummary[],
  policy: 'follow-accepted' | 'pinned' = 'follow-accepted',
): string[] {
  const byIdentity = new Map(assets.map((asset) => [projectAssetIdentity(asset), asset]));
  const resolved = new Map<string, string>();
  for (const ref of selected) {
    const identity = versionlessMatOSAssetRef(ref);
    const asset = byIdentity.get(identity);
    // An unavailable explicit pin is still a pin, not permission to upgrade.
    resolved.set(identity, policy === 'pinned' && ref !== identity
      ? ref
      : asset ? matOSAssetSelectionRef(asset) : ref);
  }
  return projectAssetSelectionRefs([...resolved.values()], policy);
}

export function ProjectAssetPickerDialog({
  projectId,
  selectedRefs,
  versionPolicy = 'follow-accepted',
  saving,
  onSave,
  onClose,
}: {
  projectId: string;
  selectedRefs: string[];
  versionPolicy?: 'follow-accepted' | 'pinned';
  saving: boolean;
  onSave: (refs: string[]) => void;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale.toLowerCase().startsWith('zh');
  const copy = zh
    ? {
        title: '选择项目资产',
        hint: '从公共、个人和项目资产中选择。每次运行会加载当前可访问且已验收的版本，无需升级后重新勾选。',
        boundaryHint: '公共资产只读；我的资产私有可编辑；导入的资产是个人副本，可继续修改和自进化。',
        all: '全部',
        public: '公共资产',
        mine: '我的私有',
        shared: '导入',
        evolved: '已自进化',
        project: '项目资产',
        sharedCopy: '共享副本',
        privateAsset: '私有资产',
        publicAsset: '公共资产',
        projectAsset: '项目共享',
        evolvedBadge: '自进化',
        editable: '可修改',
        selected: '已选择',
        selectVisible: '全选当前结果',
        clearVisible: '清除当前结果',
        selectAsset: '选择资产',
        deselectAsset: '取消选择资产',
        details: '查看详情',
        closeDetails: '关闭详情',
        exactRef: '准确引用',
        sourceLabel: '来源',
        dependencies: '依赖',
        noDependencies: '没有声明依赖',
        selectionLimit: `每个项目最多选择 ${MAX_PROJECT_ASSET_REFS} 个根资产。批量选择已停在上限。`,
        save: '保存并使用',
        noMatch: '没有符合条件的可用资产。',
      }
    : {
        title: 'Choose project assets',
        hint: 'Select public, personal, and project assets. Each run loads the currently accessible, accepted version without reselecting after upgrades.',
        boundaryHint: 'Public assets are read-only. Your assets are private and editable. Assets imported into this workspace are personal copies that you can modify and evolve.',
        all: 'All',
        public: 'Public assets',
        mine: 'My assets',
        shared: 'Imported assets',
        evolved: 'Self-evolved',
        project: 'Project',
        sharedCopy: 'Shared copy',
        privateAsset: 'Private',
        publicAsset: 'Public',
        projectAsset: 'Project shared',
        evolvedBadge: 'Self-evolved',
        editable: 'Editable',
        selected: 'selected',
        selectVisible: 'Select visible',
        clearVisible: 'Clear visible',
        selectAsset: 'Select asset',
        deselectAsset: 'Deselect asset',
        details: 'View details',
        closeDetails: 'Close details',
        exactRef: 'Exact ref',
        sourceLabel: 'Source',
        dependencies: 'Dependencies',
        noDependencies: 'No declared dependencies',
        selectionLimit: `A project can select up to ${MAX_PROJECT_ASSET_REFS} root assets. Batch selection stopped at the limit.`,
        save: 'Save and use',
        noMatch: 'No usable assets match this filter.',
      };
  const [assets, setAssets] = useState<MatOSAssetSummary[]>([]);
  const [selected, setSelected] = useState(() => new Set(projectAssetSelectionRefs(selectedRefs, versionPolicy)));
  const [scope, setScope] = useState<BoundaryFilter>('all');
  const [query, setQuery] = useState('');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelected(new Set(projectAssetSelectionRefs(selectedRefs, versionPolicy))), [selectedRefs, versionPolicy]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchMatOSAssets({ projectId })
      .then((rows) => {
        if (!active) return;
        setAssets(rows.filter((asset) =>
          PROJECT_SELECTABLE_TYPES.has(asset.type) &&
          (asset.status === null || asset.status === 'enabled'),
        ));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const catalogAssets = useMemo(
    () => collapseProjectAssetPickerRows(assets, selected),
    [assets, selected],
  );

  const counts = useMemo(() => {
    const next: Record<BoundaryFilter, number> = {
      all: catalogAssets.length,
      public: 0,
      mine: 0,
      shared: 0,
      evolved: 0,
      project: 0,
    };
    for (const asset of catalogAssets) {
      for (const filter of ['public', 'mine', 'shared', 'evolved'] as const) {
        if (matchesBoundary(asset, filter)) next[filter] += 1;
      }
      if (isProjectAssetSelected(asset, selected)) next.project += 1;
    }
    return next;
  }, [catalogAssets, selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogAssets
      .filter((asset) => scope === 'project'
        ? isProjectAssetSelected(asset, selected)
        : matchesBoundary(asset, scope))
      .filter((asset) => !needle || [asset.name, asset.id, asset.description ?? '', ...asset.tags]
        .some((value) => value.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const aBoundary = assetBoundaryOf(a);
        const bBoundary = assetBoundaryOf(b);
        const priority = (boundary: ReturnType<typeof assetBoundaryOf>) =>
          boundary.sharedCopy ? 0 : boundary.owner === 'current-scope' ? 1 : boundary.visibility === 'collaborative' ? 2 : 3;
        return priority(aBoundary) - priority(bBoundary) || a.name.localeCompare(b.name);
      });
  }, [catalogAssets, query, scope, selected]);

  const detailAsset = useMemo(
    () => catalogAssets.find((asset) => matOSAssetSelectionRef(asset) === detailRef) ?? null,
    [catalogAssets, detailRef],
  );

  useEffect(() => {
    if (detailRef && !detailAsset) setDetailRef(null);
  }, [detailAsset, detailRef]);

  const toggle = (asset: MatOSAssetSummary) => {
    if (
      !isProjectAssetSelected(asset, selected) &&
      resolvedProjectAssetSelections(selected, catalogAssets).length >= MAX_PROJECT_ASSET_REFS
    ) {
      setSelectionNotice(copy.selectionLimit);
      return;
    }
    setSelectionNotice(null);
    setSelected((current) => {
      const next = new Set(current);
      const identity = projectAssetIdentity(asset);
      const wasSelected = isProjectAssetSelected(asset, current);
      for (const ref of next) {
        if (versionlessMatOSAssetRef(ref) === identity) next.delete(ref);
      }
      if (!wasSelected) next.add(projectAssetSelectionRefs([matOSAssetSelectionRef(asset)], versionPolicy)[0]!);
      return next;
    });
  };

  const updateVisibleSelection = (selectAll: boolean) => {
    if (selectAll) {
      const available = MAX_PROJECT_ASSET_REFS -
        resolvedProjectAssetSelections(selected, catalogAssets).length;
      const requested = visible.filter((asset) => !isProjectAssetSelected(asset, selected)).length;
      setSelectionNotice(requested > available ? copy.selectionLimit : null);
    } else {
      setSelectionNotice(null);
    }
    setSelected((current) => {
      const next = new Set(current);
      const identities = new Set([...next].map(versionlessMatOSAssetRef));
      for (const asset of visible) {
        const identity = projectAssetIdentity(asset);
        for (const ref of next) {
          if (versionlessMatOSAssetRef(ref) === identity) next.delete(ref);
        }
        identities.delete(identity);
        if (selectAll && identities.size < MAX_PROJECT_ASSET_REFS) {
          next.add(projectAssetSelectionRefs([matOSAssetSelectionRef(asset)], versionPolicy)[0]!);
          identities.add(identity);
        }
      }
      return next;
    });
  };

  const selectedRefsForSave = resolvedProjectAssetSelections(selected, catalogAssets, versionPolicy);
  const visibleSelectedCount = visible.filter((asset) =>
    isProjectAssetSelected(asset, selected)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelectedCount === visible.length;

  return createPortal(
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="project-assets-title">
        <header className={styles.header}>
          <span className={styles.headerIcon}><Icon name="blocks" size={18} /></span>
          <div>
            <h2 id="project-assets-title">{copy.title}</h2>
            <p>{versionPolicy === 'pinned' ? (zh ? '此项目已显式锁定资产版本；保存时保留版本。' : 'This project explicitly pins asset versions; saving preserves pins.') : copy.hint}</p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose} disabled={saving} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className={styles.toolbar}>
          <div className={styles.filters}>
            {(['all', 'public', 'mine', 'shared', 'evolved', 'project'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={scope === value ? styles.filterActive : styles.filter}
                onClick={() => setScope(value)}
              >
                {copy[value]} <span>{counts[value]}</span>
              </button>
            ))}
          </div>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('assets.searchPlaceholder')}
            />
          </label>
        </div>

        <div className={styles.boundaryNote}>
          <span className={styles.boundaryCopy}>
            <Icon name="shield" size={13} />
            <span>{copy.boundaryHint}</span>
          </span>
          <span className={styles.bulkActions}>
            <button
              type="button"
              onClick={() => updateVisibleSelection(true)}
              disabled={visible.length === 0 || allVisibleSelected || saving || selectedRefsForSave.length >= MAX_PROJECT_ASSET_REFS}
            >
              {copy.selectVisible}
            </button>
            <button
              type="button"
              onClick={() => updateVisibleSelection(false)}
              disabled={visibleSelectedCount === 0 || saving}
            >
              {copy.clearVisible}
            </button>
          </span>
        </div>

        {selectionNotice ? <div className={styles.selectionNotice}>{selectionNotice}</div> : null}

        {detailAsset ? (
          <section
            className={styles.detailPanel}
            role="region"
            aria-label={`${copy.details}: ${detailAsset.name}`}
          >
            <div className={styles.detailHeading}>
              <span className={styles.assetIcon} style={assetAccentStyle(detailAsset.type)}>
                <Icon name={assetTypeMeta(detailAsset.type).icon} size={16} />
              </span>
              <span>
                <strong>{detailAsset.name}</strong>
                <small>{detailAsset.description || matOSAssetSelectionRef(detailAsset)}</small>
              </span>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setDetailRef(null)}
                aria-label={copy.closeDetails}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <dl className={styles.detailGrid}>
              <div>
                <dt>{copy.exactRef}</dt>
                <dd><code>{matOSAssetSelectionRef(detailAsset)}</code></dd>
              </div>
              <div>
                <dt>{copy.sourceLabel}</dt>
                <dd>{[
                  detailAsset.git.scope,
                  detailAsset.git.sourceId,
                  detailAsset.packId,
                  detailAsset.source,
                ].filter(Boolean).join(' · ') || 'MatOS'}</dd>
              </div>
              <div className={styles.detailDependencies}>
                <dt>{copy.dependencies}</dt>
                <dd>
                  {detailAsset.dependencies.length > 0
                    ? detailAsset.dependencies.map((ref) => <code key={ref}>{ref}</code>)
                    : copy.noDependencies}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}

        <div className={styles.body}>
          {loading ? <div className={styles.empty}>{t('assets.loading')}</div> : null}
          {error ? <div className={styles.error}>{error}</div> : null}
          {!loading && !error && visible.length === 0 ? <div className={styles.empty}>{copy.noMatch}</div> : null}
          {visible.map((asset) => {
            const checked = isProjectAssetSelected(asset, selected);
            const boundary = assetBoundaryOf(asset);
            const boundaryLabel = boundary.sharedCopy
              ? copy.sharedCopy
              : boundary.visibility === 'public'
                ? copy.publicAsset
                : boundary.visibility === 'collaborative'
                  ? copy.projectAsset
                  : copy.privateAsset;
            return (
              <article
                key={matOSAssetSelectionRef(asset)}
                className={`${styles.card}${checked ? ` ${styles.cardSelected}` : ''}`}
                style={assetAccentStyle(asset.type)}
              >
                <button
                  type="button"
                  className={styles.cardMain}
                  onClick={() => setDetailRef(matOSAssetSelectionRef(asset))}
                  aria-label={`${copy.details}: ${asset.name}`}
                >
                  <span className={styles.assetIcon}><Icon name={assetTypeMeta(asset.type).icon} size={16} /></span>
                  <span className={styles.assetText}>
                    <span className={styles.assetName}>{asset.name}</span>
                    <span className={styles.assetDescription}>{asset.description || matOSAssetSelectionRef(asset)}</span>
                    <code className={styles.assetRef}>{matOSAssetSelectionRef(asset)}</code>
                    <span className={styles.assetMeta}>
                      <span>{asset.type}</span>
                      <span data-boundary={boundary.visibility}>{boundaryLabel}</span>
                      {boundary.editable ? <span>{copy.editable}</span> : null}
                      {boundary.selfEvolved ? <span>{copy.evolvedBadge} · {boundary.evolutionRuns}</span> : null}
                      {asset.version ? <span>v{asset.version}</span> : null}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={checked ? styles.checkActive : styles.check}
                  aria-pressed={checked}
                  aria-label={`${checked ? copy.deselectAsset : copy.selectAsset}: ${asset.name}`}
                  onClick={() => toggle(asset)}
                  disabled={!checked && selectedRefsForSave.length >= MAX_PROJECT_ASSET_REFS}
                >
                  {checked ? <Icon name="check" size={13} /> : null}
                </button>
              </article>
            );
          })}
        </div>

        <footer className={styles.footer}>
          <span>{selectedRefsForSave.length} {copy.selected}</span>
          <div>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => onSave(selectedRefsForSave)}
              disabled={saving}
            >
              {saving ? t('assets.saving') : copy.save}
            </button>

          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
