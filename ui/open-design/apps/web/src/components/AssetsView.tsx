// MatOS Assets workbench.
//
// Maps the native MatOS asset registry — knowledges, data, tools (incl. MCP
// servers), skills, roles, and workflows — onto structured editors
// inside the entry shell (benchmark/evaluation and runtime families are
// staged out of the user-facing catalog for now). Users edit
// forms, documents, and the workflow canvas; raw files stay available
// Every mutation flows through the daemon's `/api/matos/assets` bridge
// (`matos assets ... --json`), so validation and Gitea governance stay
// native.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n, useT } from '../i18n';
import { navigate } from '../router';
import { Icon, type IconName } from './Icon';
import { AssetGraphView } from './AssetGraphView';
import { AssetRevisionArchive } from './AssetRevisionArchive';
import { CodeEditor } from './CodeEditor';
import { WorkflowEditorCore } from './WorkflowEditor';
import { WorkflowMiniMap } from './WorkflowMiniMap';
import { canvasEdgesFromDefinition, parseWorkflowDocument } from './workflow-model';
import { WorkflowAssetCard, WorkflowAssetDraftButton, compareWorkflowAssets, useWorkflowPreviews } from './WorkflowAssetCard';
import { WorkflowDocumentConflict } from './workflow-document';
import { assetAccentStyle, assetTypeMeta } from './asset-type-meta';
import {
  applyDataProfileToAssetJson,
  applyDependenciesToAssetJson,
  applyMcpServersToJson,
  applyMetadataToAssetJson,
  applyRoleRuntimeToAssetJson,
  applySkillFieldsToFrontmatter,
  applyToolBindingsToAssetJson,
  canvasJsonToWorkflowText,
  dataProfileFromAssetJson,
  dataProvenanceFromAssetJson,
  dependenciesFromAssetJson,
  groupDependencies,
  joinFrontmatter,
  knowledgeProfileFromAssetJson,
  mcpProfileFromAssetJson,
  mcpServersFromJson,
  metadataFromAssetJson,
  permissionsFromAssetJson,
  roleRuntimeFromAssetJson,
  skillFieldsFromFrontmatter,
  splitFrontmatter,
  toolBindingsFromAssetJson,
  workflowTextToCanvasJson,
  type AssetMetadataFields,
  type DataProfileFields,
  type DataProvenanceFields,
  type McpServerFields,
  type RoleRuntimeFields,
  type ToolBindingsFields,
} from './asset-editors';
import {
  assetBoundaryOf,
  clearMatOSAssetsCache,
  fetchMatOSAssets,
  getCachedMatOSAssets,
  matOSAssetSelectionRef,
  matchesMatOSAssetBoundary,
  type MatOSAssetBoundaryFilter,
  type MatOSAssetSummary,
} from '../runtime/matos-assets';

type AssetSummary = MatOSAssetSummary;

function assetBoundaryLabel(
  asset: AssetSummary,
  copy: { publicAsset: string; privateAsset: string; sharedCopy: string; projectAsset: string },
): string {
  const boundary = assetBoundaryOf(asset);
  if (boundary.sharedCopy) return copy.sharedCopy;
  if (boundary.visibility === 'public') return copy.publicAsset;
  if (boundary.visibility === 'collaborative') return copy.projectAsset;
  return copy.privateAsset;
}

interface AssetFile {
  name: string;
  content: string;
}

interface ValidationIssue {
  code?: string;
  message?: string;
}

type AssetTypeTab =
  | 'knowledge'
  | 'data'
  | 'tool'
  | 'skill'
  | 'role'
  | 'workflow';

// One tab per released product asset family. Lab/instrument assets are not a
// separate registry type — instrument drivers, measurement SOPs, and
// world-interface contracts live as tagged tool/workflow/knowledge assets —
// so they surface inside their family tab (and with a dashed "lab" ring in
// the graph view). Benchmarks/evaluations and runtimes are staged out of the
// user-facing catalog for now (the daemon's default listing skips them too);
// re-add their tabs here when the families are released.
const TYPE_TABS: Array<{ id: AssetTypeTab; types: string[]; icon: IconName }> = [
  { id: 'knowledge', types: ['knowledge'], icon: 'book-open' },
  { id: 'data', types: ['data'], icon: 'flask' },
  { id: 'tool', types: ['tool', 'mcp'], icon: 'hammer' },
  { id: 'skill', types: ['skill'], icon: 'sparkles' },
  { id: 'role', types: ['role'], icon: 'bot' },
  { id: 'workflow', types: ['workflow'], icon: 'fork' },
];

// The TOS archive pack registers hundreds of dataset/paper unit assets; the
// data tab gets source filters (curated vs archive, per upstream provider)
// and the grid renders in pages so the catalog stays responsive.
const DATA_ARCHIVE_TAG = 'material-bench';
const DATA_PROVIDER_TAGS = [
  'zenodo',
  'figshare',
  'materialscloud',
  'mendeley',
  'dryad',
  'huggingface',
  'github',
  'gitlab',
  'paper-doi',
  'doi',
  'arxiv',
  'web',
  'local',
] as const;
const GRID_RENDER_PAGE = 96;

const MOUNT_GROUPS: Array<{ type: string; labelKey: `assets.mounts.${string}` }> = [
  { type: 'skill', labelKey: 'assets.mounts.skills' },
  { type: 'tool', labelKey: 'assets.mounts.tools' },
  { type: 'mcp', labelKey: 'assets.mounts.mcp' },
  { type: 'knowledge', labelKey: 'assets.mounts.knowledges' },
  { type: 'data', labelKey: 'assets.mounts.data' },
  { type: 'workflow', labelKey: 'assets.mounts.workflows' },
  { type: 'role', labelKey: 'assets.mounts.roles' },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Keep the HTTP status message.
    }
    if (resp.status === 409) throw new WorkflowDocumentConflict(message);
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

async function putAssetFile(
  ref: string,
  name: string,
  content: string,
  expectedContent?: string,
): Promise<{ ok: boolean; validation: { ok?: boolean; errors?: ValidationIssue[] } }> {
  return fetchJson(`/api/matos/assets/${encodeURIComponent(ref)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content, expectedContent }),
  });
}

function tabForType(type: string): AssetTypeTab {
  return (TYPE_TABS.find((tab) => tab.types.includes(type))?.id ?? 'skill') as AssetTypeTab;
}

function fnv1a36(value: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h ^ value.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function AssetsView({ assetRef: rawAssetRef }: { assetRef: string | null }) {
  const { locale, t } = useI18n();
  const zh = locale.toLowerCase().startsWith('zh');
  const boundaryCopy = zh
    ? {
        title: '资产边界',
        hint: '公共资产由 MatOS 维护且只读；我的私有资产可独立修改；导入的资产是个人副本；“已自进化”只统计通过验收并已生效的改动。',
        all: '全部',
        public: '公共资产',
        mine: '我的私有',
        shared: '导入',
        evolved: '已自进化',
        project: '项目共享',
        publicAsset: '公共',
        privateAsset: '我的私有',
        sharedCopy: '共享副本',
        projectAsset: '项目共享',
        evolvedBadge: '已自进化',
      }
    : {
        title: 'Asset boundaries',
        hint: 'Public assets are MatOS-maintained and read-only. Your private assets are independently editable. Assets imported into this workspace are personal copies. Self-evolved counts only accepted changes that are live.',
        all: 'All',
        public: 'Public',
        mine: 'My private',
        shared: 'Imported assets',
        evolved: 'Self-evolved',
        project: 'Project shared',
        publicAsset: 'Public',
        privateAsset: 'My private',
        sharedCopy: 'Shared copy',
        projectAsset: 'Project shared',
        evolvedBadge: 'Self-evolved',
      };
  // `/assets/<type>` deep-links (e.g. from the Home asset gallery's
  // "view all") select a type tab; refs with a colon select an asset.
  const tabRef =
    rawAssetRef && !rawAssetRef.includes(':') && TYPE_TABS.some((tab) => tab.id === rawAssetRef)
      ? (rawAssetRef as AssetTypeTab)
      : null;
  const assetRef = tabRef ? null : rawAssetRef;
  const [assets, setAssets] = useState<AssetSummary[]>(() => getCachedMatOSAssets() ?? []);
  const [loading, setLoading] = useState(() => getCachedMatOSAssets() === undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AssetTypeTab>(tabRef ?? 'skill');
  const [boundaryFilter, setBoundaryFilter] = useState<MatOSAssetBoundaryFilter>('all');
  const [query, setQuery] = useState('');
  // Data-tab source filters: curated data assets vs the generated TOS archive
  // units, plus an upstream-provider drill-down inside the archive.
  const [dataSource, setDataSource] = useState<'all' | 'curated' | 'archive'>('all');
  const [dataProvider, setDataProvider] = useState<string | null>(null);
  const [renderCap, setRenderCap] = useState(GRID_RENDER_PAGE);
  const { previews, refreshPreviews } = useWorkflowPreviews(activeTab === 'workflow');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Catalog presentation: card grid or the relationship map. Session-scoped
  // persistence so a workbench user coming back from a detail editor lands
  // on the same view they left ('galaxy' is the legacy stored token from the
  // old canvas view; treat it as the graph).
  const [viewMode, setViewMode] = useState<'grid' | 'graph' | 'archive'>(() => {
    try {
      const stored = window.sessionStorage.getItem('od.assets.view');
      return stored === 'archive' ? 'archive' : stored === 'graph' || stored === 'galaxy' ? 'graph' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const switchViewMode = (mode: 'grid' | 'graph' | 'archive') => {
    setViewMode(mode);
    try {
      window.sessionStorage.setItem('od.assets.view', mode);
    } catch {
      // Session storage may be blocked; in-memory state still works.
    }
  };

  useEffect(() => {
    if (tabRef) setActiveTab(tabRef);
  }, [tabRef]);

  const refresh = useCallback(async (options: { force?: boolean } = {}) => {
    const cached = getCachedMatOSAssets();
    if (cached !== undefined) {
      setAssets(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const next = await fetchMatOSAssets({ refresh: options.force });
      setAssets(next);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => (assetRef ? assets.find((asset) => matOSAssetSelectionRef(asset) === assetRef)
      ?? assets.find((asset) => asset.ref === assetRef) ?? null : null),
    [assets, assetRef],
  );

  useEffect(() => {
    if (selected) setActiveTab(tabForType(selected.type));
  }, [selected]);

  const visible = useMemo(() => {
    const types = new Set(TYPE_TABS.find((tab) => tab.id === activeTab)?.types ?? []);
    const q = query.trim().toLowerCase();
    return assets
      .filter((asset) => types.has(asset.type))
      .filter((asset) => matchesMatOSAssetBoundary(asset, boundaryFilter))
      .filter((asset) => {
        if (activeTab !== 'data' || dataSource === 'all') return true;
        const archive = asset.tags.includes(DATA_ARCHIVE_TAG);
        return dataSource === 'archive' ? archive : !archive;
      })
      .filter(
        (asset) =>
          activeTab !== 'data' ||
          dataSource !== 'archive' ||
          !dataProvider ||
          asset.tags.includes(dataProvider),
      )
      .filter(
        (asset) =>
          !q ||
          asset.id.toLowerCase().includes(q) ||
          asset.name.toLowerCase().includes(q) ||
          (asset.description ?? '').toLowerCase().includes(q) ||
          asset.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        if (activeTab === 'workflow') return compareWorkflowAssets(a, b, previews);
        // Data tab: curated assets and the archive index assets lead; the
        // hundreds of generated TOS archive units follow alphabetically.
        if (activeTab === 'data') {
          const aArchive = a.tags.includes(DATA_ARCHIVE_TAG) && a.id.startsWith('mb-') ? 1 : 0;
          const bArchive = b.tags.includes(DATA_ARCHIVE_TAG) && b.id.startsWith('mb-') ? 1 : 0;
          if (aArchive !== bArchive) return aArchive - bArchive;
        }
        return a.id.localeCompare(b.id);
      });
  }, [assets, activeTab, boundaryFilter, query, dataSource, dataProvider, previews]);

  // Provider drill-down counts inside the archive scope (query still applies
  // through `visible`; counts stay stable per scope so chips do not jump).
  const providerCounts = useMemo(() => {
    if (activeTab !== 'data') return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const asset of assets) {
      if (asset.type !== 'data' || !asset.tags.includes(DATA_ARCHIVE_TAG)) continue;
      for (const tag of DATA_PROVIDER_TAGS) {
        if (asset.tags.includes(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [assets, activeTab]);

  const archiveCount = useMemo(
    () => assets.filter((asset) => asset.type === 'data' && asset.tags.includes(DATA_ARCHIVE_TAG)).length,
    [assets],
  );
  const curatedCount = useMemo(
    () => assets.filter((asset) => asset.type === 'data' && !asset.tags.includes(DATA_ARCHIVE_TAG)).length,
    [assets],
  );

  useEffect(() => {
    setRenderCap(GRID_RENDER_PAGE);
  }, [activeTab, boundaryFilter, query, dataSource, dataProvider]);

  useEffect(() => {
    if (dataSource !== 'archive') setDataProvider(null);
  }, [dataSource]);

  const counts = useMemo(() => {
    const map = new Map<AssetTypeTab, number>();
    for (const tab of TYPE_TABS) {
      map.set(tab.id, assets.filter((asset) => tab.types.includes(asset.type)).length);
    }
    return map;
  }, [assets]);

  const boundaryCounts = useMemo(() => {
    const types = new Set(TYPE_TABS.find((tab) => tab.id === activeTab)?.types ?? []);
    const current = assets.filter((asset) => types.has(asset.type));
    const result: Record<MatOSAssetBoundaryFilter, number> = {
      all: current.length,
      public: 0,
      mine: 0,
      shared: 0,
      evolved: 0,
      project: 0,
    };
    for (const asset of current) {
      for (const filter of ['public', 'mine', 'shared', 'evolved', 'project'] as const) {
        if (matchesMatOSAssetBoundary(asset, filter)) result[filter] += 1;
      }
    }
    return result;
  }, [activeTab, assets]);

  if (assetRef) {
    if (selected) {
      return (
        <AssetDetail
          // Key by ref: switching assets must remount the detail (fresh
          // files/busy/notice state) or a slow in-flight reload for asset A
          // can populate asset B's file list and mis-drive saves.
          key={selected.ref}
          asset={selected}
          allAssets={assets}
          onBack={() => navigate({ kind: 'home', view: 'assets' })}
          onChanged={refresh}
        />
      );
    }
    return (
      <section className="assets-view">
        <div className="assets-view__empty">
          {loading ? t('assets.loading') : t('assets.notFound')}
        </div>
      </section>
    );
  }

  return (
    <section className="assets-view" aria-labelledby="assets-title" data-testid="assets-view">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('assets.kicker')}</p>
          <h1 id="assets-title" className="entry-section__title">{t('assets.title')}</h1>
          <p className="integrations-view__lede">{t('assets.lede')}</p>
        </div>
        <div className="integrations-view__badge" aria-hidden="true">
          <Icon name="fork" size={15} />
          <span>{t('assets.governedBadge')}</span>
        </div>
      </header>

      <nav className="integrations-view__tabs assets-view__tabs" role="tablist" aria-label={t('assets.title')}>
        {TYPE_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`integrations-view__tab${active ? ' is-active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                // Type tabs filter the grid; the relationship map
                // intentionally shows the whole registry, so picking a type
                // jumps back to the filtered grid instead of silently doing
                // nothing.
                if (viewMode === 'graph') switchViewMode('grid');
              }}
              data-testid={`assets-tab-${tab.id}`}
              style={assetAccentStyle(tab.types[0] ?? tab.id)}
            >
              <span className="integrations-view__tab-label assets-view__tab-label">
                <span className="assets-view__tab-icon" aria-hidden>
                  <Icon name={tab.icon} size={13} />
                </span>
                {t(`assets.tab.${tab.id}` as never)}
                <span className="assets-view__tab-count">{counts.get(tab.id) ?? 0}</span>
              </span>
              <span className="integrations-view__tab-hint">{t(`assets.tabHint.${tab.id}` as never)}</span>
            </button>
          );
        })}
      </nav>

      <section className="assets-boundary" aria-labelledby="assets-boundary-title" data-testid="assets-boundary">
        <div className="assets-boundary__intro">
          <span className="assets-boundary__icon" aria-hidden><Icon name="shield" size={15} /></span>
          <div>
            <h2 id="assets-boundary-title">{boundaryCopy.title}</h2>
            <p>{boundaryCopy.hint}</p>
          </div>
        </div>
        <div className="assets-boundary__filters">
          {(['all', 'public', 'mine', 'shared', 'evolved', 'project'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={`assets-boundary__filter${boundaryFilter === filter ? ' is-active' : ''}`}
              aria-pressed={boundaryFilter === filter}
              onClick={() => {
                setBoundaryFilter(filter);
                if (viewMode === 'graph') switchViewMode('grid');
              }}
              data-testid={`assets-boundary-${filter}`}
            >
              {boundaryCopy[filter]}
              <span>{boundaryCounts[filter]}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="assets-view__toolbar">
        <div
          className="assets-view__mode"
          role="tablist"
          aria-label={t('assets.galaxy.viewToggle')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'grid'}
            className={`assets-view__mode-btn${viewMode === 'grid' ? ' is-active' : ''}`}
            onClick={() => switchViewMode('grid')}
            title={t('assets.galaxy.gridView')}
            data-testid="assets-mode-grid"
          >
            <Icon name="grid" size={14} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'graph'}
            className={`assets-view__mode-btn${viewMode === 'graph' ? ' is-active' : ''}`}
            onClick={() => switchViewMode('graph')}
            title={t('assets.galaxy.galaxyView')}
            data-testid="assets-mode-graph"
          >
            <Icon name="orbit" size={14} />
          </button>
          <button type="button" role="tab" aria-selected={viewMode === 'archive'} className={`assets-view__mode-btn${viewMode === 'archive' ? ' is-active' : ''}`} onClick={() => switchViewMode('archive')} title={locale.startsWith('zh') ? '版本存档' : 'Revision archive'} aria-label={locale.startsWith('zh') ? '版本存档' : 'Revision archive'} data-testid="assets-mode-archive"><Icon name="history" size={14} /></button>
        </div>
        {viewMode === 'grid' ? (
          <button
            type="button"
            className="assets-btn assets-view__register-btn"
            onClick={() => {
              setImportOpen((open) => !open);
              setRegisterOpen(false);
            }}
            data-testid="assets-import-toggle"
          >
            <Icon name="import" size={13} /> {t('assets.import.button')}
          </button>
        ) : null}
        {viewMode === 'grid' && activeTab === 'data' ? (
          <button
            type="button"
            className="assets-btn assets-btn--primary assets-view__register-btn"
            onClick={() => {
              setRegisterOpen((open) => !open);
              setImportOpen(false);
            }}
            data-testid="assets-register-data-toggle"
          >
            <Icon name="database" size={13} /> {t('assets.registerData.button')}
          </button>
        ) : null}
        {viewMode === 'grid' ? (
          <input
            className="assets-view__search"
            type="search"
            value={query}
            placeholder={t('assets.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
      </div>

      {viewMode === 'grid' && importOpen ? (
        <ImportAssetsPanel
          onClose={() => setImportOpen(false)}
          onImported={async (ref) => {
            setImportOpen(false);
            await refresh({ force: true });
            if (ref) {
              navigate({ kind: 'home', view: 'assets', assetRef: ref });
            }
          }}
        />
      ) : null}

      {viewMode === 'grid' && activeTab === 'data' && registerOpen ? (
        <RegisterDataPanel
          onClose={() => setRegisterOpen(false)}
          onRegistered={async (ref) => {
            setRegisterOpen(false);
            await refresh({ force: true });
            navigate({ kind: 'home', view: 'assets', assetRef: ref });
          }}
        />
      ) : null}

      {viewMode === 'grid' && activeTab === 'data' && archiveCount > 0 ? (
        <div className="assets-view__filters" data-testid="assets-data-filters">
          {(
            [
              ['all', t('assets.data.filterAll'), curatedCount + archiveCount],
              ['curated', t('assets.data.filterCurated'), curatedCount],
              ['archive', t('assets.data.filterArchive'), archiveCount],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={`assets-view__filter${dataSource === id ? ' is-active' : ''}`}
              aria-pressed={dataSource === id}
              onClick={() => setDataSource(id)}
            >
              {label}
              <span className="assets-view__filter-count">{count}</span>
            </button>
          ))}
          {dataSource === 'archive' ? (
            <span className="assets-view__filter-group">
              {[...providerCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([provider, count]) => (
                  <button
                    key={provider}
                    type="button"
                    className={`assets-view__filter assets-view__filter--provider${
                      dataProvider === provider ? ' is-active' : ''
                    }`}
                    aria-pressed={dataProvider === provider}
                    onClick={() => setDataProvider(dataProvider === provider ? null : provider)}
                  >
                    {provider}
                    <span className="assets-view__filter-count">{count}</span>
                  </button>
                ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {viewMode === 'archive' ? <AssetRevisionArchive /> : loading && assets.length === 0 ? (
        <div className="assets-view__empty">{t('assets.loading')}</div>
      ) : loadError && assets.length === 0 ? (
        <div className="assets-view__error">{loadError}</div>
      ) : viewMode === 'graph' ? (
        // The relationship map always shows the WHOLE registry (all type
        // tabs): the point of the view is cross-type lineage, and type
        // clusters already separate the families visually. The hundreds of
        // generated TOS archive unit leaves (mb-*) would drown that lineage,
        // so the archive is represented by its units-index/world-model assets
        // and the individual units stay in the filtered grid.
        <AssetGraphView
          assets={assets.filter(
            (asset) =>
              !(
                asset.type === 'data' &&
                asset.id.startsWith('mb-') &&
                asset.tags.includes(DATA_ARCHIVE_TAG)
              ),
          )}
          onOpenAsset={(ref) => navigate({ kind: 'home', view: 'assets', assetRef: ref })}
        />
      ) : visible.length === 0 ? (
        <div className="assets-view__empty">{t('assets.empty')}</div>
      ) : (
        <div className="assets-view__grid">
          {activeTab === 'workflow' && previews === null ? <div className="wf-asset-gallery__error" role="status">
            <span>{t('workflow.gallery.unavailable')}</span>
            <button type="button" className="assets-btn" onClick={refreshPreviews}>
              <Icon name="refresh" size={14} />{t('library.refresh')}
            </button>
          </div> : null}
          {visible.slice(0, renderCap).map((asset) => {
            if (asset.type === 'workflow') return <WorkflowAssetCard key={matOSAssetSelectionRef(asset)} asset={asset} previews={previews} />;
            const boundary = assetBoundaryOf(asset);
            return (
              <button
                key={asset.ref}
                type="button"
                className="assets-card"
                data-asset-type={asset.type}
                data-asset-boundary={boundary.sharedCopy ? 'shared' : boundary.visibility}
                style={assetAccentStyle(asset.type)}
                onClick={() => navigate({ kind: 'home', view: 'assets', assetRef: asset.ref })}
              >
                <div className="assets-card__top">
                  <span className="assets-card__icon">
                    <Icon name={assetTypeMeta(asset.type).icon} size={16} />
                  </span>
                  <span className="assets-card__name">{asset.name}</span>
                  {asset.version ? <span className="assets-card__version">v{asset.version}</span> : null}
                </div>
                <p className="assets-card__desc">{asset.description ?? ''}</p>
                <div className="assets-card__meta">
                  <span className="assets-card__type">{asset.type}</span>
                  <span
                    className="assets-card__scope"
                    data-boundary={boundary.sharedCopy ? 'shared' : boundary.visibility}
                  >
                    {assetBoundaryLabel(asset, boundaryCopy)}
                  </span>
                  {boundary.selfEvolved ? (
                    <span className="assets-card__evolved">
                      <Icon name="sparkles" size={10} /> {boundaryCopy.evolvedBadge} · {boundary.evolutionRuns}
                    </span>
                  ) : null}
                  {asset.tags
                    .filter((tag) => tag !== 'forked' && tag !== 'project-share')
                    .slice(0, 2)
                    .map((tag) => (
                      <span key={tag} className="assets-card__tag">{tag}</span>
                    ))}
                </div>
              </button>
            );
          })}
          {visible.length > renderCap ? (
            <button
              type="button"
              className="assets-card assets-card--more"
              onClick={() => setRenderCap((cap) => cap + GRID_RENDER_PAGE)}
              data-testid="assets-show-more"
            >
              <Icon name="chevron-down" size={16} />
              {t('assets.showMore', { n: String(Math.min(GRID_RENDER_PAGE, visible.length - renderCap)) })}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Register dataset: thin form over POST /api/matos/assets/register-data
// (`matos assets register-data --json`). Reference-only: payloads stay at
// their source; the daemon writes one project-local manifest with DOI/URL/
// path provenance and validates the registry.
// ---------------------------------------------------------------------------

function slugifyAssetId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function RegisterDataPanel({
  onRegistered,
  onClose,
}: {
  onRegistered: (ref: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [doi, setDoi] = useState('');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = idTouched ? slugifyAssetId(id) : slugifyAssetId(name);
  const hasSource = Boolean(doi.trim() || url.trim() || path.trim());

  const submit = async () => {
    if (!name.trim() || !effectiveId || busy) return;
    if (!hasSource) {
      setError(t('assets.registerData.needSource'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tagList = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const payload = await fetchJson<{ ref?: string }>('/api/matos/assets/register-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: effectiveId,
          name: name.trim(),
          ...(doi.trim() ? { doi: doi.trim() } : {}),
          ...(url.trim() ? { urls: [url.trim()] } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          ...(tagList.length > 0 ? { tags: tagList } : {}),
        }),
      });
      const ref = String(payload.ref ?? `data:${effectiveId}`).replace(/@[^@]*$/, '');
      await onRegistered(ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="assets-panel assets-register" data-testid="assets-register-data-panel">
      <PanelHead
        icon="database"
        title={t('assets.registerData.button')}
        action={
          <span className="assets-register__actions">
            <button type="button" className="assets-btn" onClick={onClose}>
              {t('assets.back')}
            </button>
            <button
              type="button"
              className="assets-btn assets-btn--primary"
              disabled={busy || !name.trim() || !effectiveId}
              onClick={() => void submit()}
              data-testid="assets-register-data-submit"
            >
              {busy ? t('assets.saving') : t('assets.registerData.submit')}
            </button>
          </span>
        }
      />
      <p className="assets-panel__hint">{t('assets.registerData.hint')}</p>
      {error ? <div className="assets-view__error">{error}</div> : null}
      <div className="assets-register__grid">
        <label className="assets-form__field">
          <span>{t('assets.form.name')}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Alkaline HER Pt cations MD"
            data-testid="assets-register-data-name"
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.registerData.id')}</span>
          <input
            className="assets-input--mono"
            value={effectiveId}
            onChange={(event) => {
              setIdTouched(true);
              setId(event.target.value);
            }}
            placeholder="her-pt-cations"
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.registerData.doi')}</span>
          <input
            className="assets-input--mono"
            value={doi}
            onChange={(event) => setDoi(event.target.value)}
            placeholder="10.5281/zenodo.7026971"
            data-testid="assets-register-data-doi"
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.registerData.url')}</span>
          <input
            className="assets-input--mono"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://zenodo.org/records/7026971"
          />
        </label>
        <label className="assets-form__field assets-form__field--wide">
          <span>{t('assets.registerData.path')}</span>
          <input
            className="assets-input--mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/workspace/knowledge/… or datasets/…"
          />
        </label>
        <label className="assets-form__field assets-form__field--wide">
          <span>{t('assets.form.description')}</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.registerData.domain')}</span>
          <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="Catalysis" />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.form.tags')}</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="materials, catalysis"
          />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Universal import: thin form over the native external-intake draft-pack
// pipeline (POST /api/matos/assets/import-preview|import-apply|import-upload
// -> `matos workbench search intake-draft[-apply]`). Any source — local path,
// uploaded zip/tar/pdf, git URL, http(s) download — is acquired/staged and
// deterministically classified into typed asset proposals (tool/skill/
// knowledge/data/workflow/…); apply is gated by the preview's confirmation
// fingerprint and MatOS-side validation/rollback.
// ---------------------------------------------------------------------------

interface ImportPreviewPayload {
  validation?: { ok?: boolean; issues?: Array<{ code?: string; severity?: string; message?: string }> };
  plan?: {
    targetPack?: { packId?: string };
    proposedAssets?: Array<{
      type?: string;
      id?: string;
      ref?: string;
      primary?: boolean;
      confidence?: string;
    }>;
  };
  transaction?: { confirmationFingerprint?: string };
}

export function ImportAssetsPanel({
  onImported,
  onClose,
}: {
  onImported: (ref: string | null) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState('');
  const [packId, setPackId] = useState('');
  const [executable, setExecutable] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewPayload | null>(null);

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    setPreview(null);
    try {
      const payload = new FormData();
      payload.set('file', file);
      const resp = await fetch('/api/matos/assets/import-upload', { method: 'POST', body: payload });
      if (!resp.ok) throw new Error(`upload failed: HTTP ${resp.status}`);
      const body = (await resp.json()) as { path?: string };
      if (body.path) setSource(body.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const uploadFolder = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    setPreview(null);
    try {
      const relativePaths = files.map((file) => file.webkitRelativePath || file.name);
      const payload = new FormData();
      // Multer must receive this field before file parts so it can stream each
      // file directly into the correct relative directory.
      payload.set('relativePaths', JSON.stringify(relativePaths));
      for (const file of files) payload.append('files', file, file.name);
      const resp = await fetch('/api/matos/assets/import-upload-folder', {
        method: 'POST',
        body: payload,
      });
      const body = (await resp.json().catch(() => null)) as {
        path?: string;
        error?: string | { message?: string };
      } | null;
      const uploadError = typeof body?.error === 'string' ? body.error : body?.error?.message;
      if (!resp.ok) throw new Error(uploadError ?? `folder upload failed: HTTP ${resp.status}`);
      if (body?.path) setSource(body.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const requestBody = () => ({
    source: source.trim(),
    ...(packId.trim() ? { packId: packId.trim() } : {}),
    ...(executable ? { executable: true } : {}),
  });

  const runPreview = async () => {
    if (!source.trim() || busy) {
      if (!source.trim()) setError(t('assets.import.needSource'));
      return;
    }
    setBusy('preview');
    setError(null);
    setPreview(null);
    try {
      const payload = await fetchJson<ImportPreviewPayload>('/api/matos/assets/import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody()),
      });
      setPreview(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    const fingerprint = preview?.transaction?.confirmationFingerprint;
    if (!fingerprint || busy) return;
    setBusy('apply');
    setError(null);
    try {
      const payload = await fetchJson<ImportPreviewPayload & { applied?: boolean }>(
        '/api/matos/assets/import-apply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...requestBody(), fingerprint }),
        },
      );
      // A confirmed import is added to the user's assets right away; when that
      // step fails the assets stay as drafts and the user gets the reason.
      const adoption = (payload as { adoption?: { ok?: boolean; error?: string } | null }).adoption;
      if (adoption && adoption.ok === false) {
        setError(t('assets.import.adoptFailed', { message: adoption.error ?? '' }));
        setBusy(null);
        return;
      }
      const proposals = payload.plan?.proposedAssets ?? preview?.plan?.proposedAssets ?? [];
      const primary = proposals.find((asset) => asset.primary) ?? proposals[0];
      const ref = primary?.ref ? primary.ref.replace(/@[^@]*$/, '') : null;
      await onImported(ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const proposals = preview?.plan?.proposedAssets ?? [];
  const issues = preview?.validation?.issues ?? [];
  const previewOk = preview?.validation?.ok === true && Boolean(preview?.transaction?.confirmationFingerprint);

  return (
    <div className="assets-panel assets-register" data-testid="assets-import-panel">
      <PanelHead
        icon="import"
        title={t('assets.import.button')}
        action={
          <span className="assets-register__actions">
            <button type="button" className="assets-btn" onClick={onClose}>
              {t('assets.back')}
            </button>
            <button
              type="button"
              className="assets-btn"
              disabled={busy !== null || uploading || !source.trim()}
              onClick={() => void runPreview()}
              data-testid="assets-import-preview"
            >
              {busy === 'preview' ? t('assets.import.previewing') : t('assets.import.preview')}
            </button>
            <button
              type="button"
              className="assets-btn assets-btn--primary"
              disabled={busy !== null || !previewOk}
              onClick={() => void runApply()}
              data-testid="assets-import-apply"
            >
              {busy === 'apply'
                ? t('assets.import.applying')
                : t('assets.import.apply', { n: String(proposals.length || 0) })}
            </button>
          </span>
        }
      />
      <p className="assets-panel__hint">{t('assets.import.hint')}</p>
      {error ? <div className="assets-view__error">{error}</div> : null}
      <div className="assets-register__grid">
        <label className="assets-form__field assets-form__field--wide">
          <span>{t('assets.import.source')}</span>
          <input
            className="assets-input--mono"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPreview(null);
            }}
            placeholder="https://github.com/org/repo · https://…/dataset.zip · /workspace/…"
            data-testid="assets-import-source"
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.import.upload')}</span>
          <input
            type="file"
            accept=".zip,.tar,.gz,.tgz,.bz2,.xz,.pdf,.md,.txt"
            disabled={uploading || busy !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
            }}
          />
        </label>
        <label className="assets-form__field">
          <span>
            {t('assets.import.upload')} ({t('chat.designToolbox.context.folder')})
          </span>
          <input
            ref={(input) => {
              input?.setAttribute('webkitdirectory', '');
              input?.setAttribute('directory', '');
            }}
            type="file"
            multiple
            disabled={uploading || busy !== null}
            data-testid="assets-import-folder-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void uploadFolder(files);
            }}
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.import.packId')}</span>
          <input
            className="assets-input--mono"
            value={packId}
            onChange={(event) => setPackId(event.target.value)}
            placeholder="auto"
          />
        </label>
        <label className="assets-form__field assets-import__toggle">
          <span>{t('assets.import.executable')}</span>
          <input
            type="checkbox"
            checked={executable}
            onChange={(event) => {
              setExecutable(event.target.checked);
              setPreview(null);
            }}
          />
        </label>
      </div>

      {preview ? (
        <div className="assets-import__result" data-testid="assets-import-result">
          <p className="assets-provenance__label">{t('assets.import.proposals')}</p>
          {proposals.length === 0 ? (
            <p className="assets-panel__hint">{t('assets.empty')}</p>
          ) : (
            <div className="assets-detail__chips">
              {proposals.map((asset) => (
                <span
                  key={asset.ref ?? asset.id}
                  className={`assets-detail__chip${asset.primary ? ' assets-detail__chip--version' : ''}`}
                >
                  {asset.type}:{asset.id}
                  {asset.confidence ? ` · ${asset.confidence}` : ''}
                </span>
              ))}
            </div>
          )}
          {issues.length > 0 ? (
            <div className="assets-import__issues">
              {issues.slice(0, 6).map((issue, index) => (
                <div
                  key={index}
                  className={
                    issue.severity === 'error' ? 'assets-view__error' : 'assets-panel__hint'
                  }
                >
                  {issue.code ? `${issue.code}: ` : ''}
                  {issue.message ?? ''}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail: structured editors per asset type
// ---------------------------------------------------------------------------

function AssetDetail({
  asset,
  allAssets,
  onBack,
  onChanged,
}: {
  asset: AssetSummary;
  allAssets: AssetSummary[];
  onBack: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { locale, t } = useI18n();
  const zh = locale.toLowerCase().startsWith('zh');
  const boundaryCopy = zh
    ? {
        publicAsset: '公共资产',
        privateAsset: '我的私有资产',
        sharedCopy: '导入的私有副本',
        projectAsset: '项目共享资产',
        editable: '可自由修改',
        readOnly: '只读',
        evolved: '已通过自进化更新',
      }
    : {
        publicAsset: 'Public asset',
        privateAsset: 'My private asset',
        sharedCopy: 'Imported private copy',
        projectAsset: 'Project-shared asset',
        editable: 'Freely editable',
        readOnly: 'Read-only',
        evolved: 'Updated by accepted self-evolution',
      };
  const boundary = assetBoundaryOf(asset);
  const selectionRef = asset.type === 'workflow' ? matOSAssetSelectionRef(asset) : asset.ref;
  const boundaryIcon: IconName = boundary.sharedCopy
    ? 'fork'
    : boundary.visibility === 'public'
      ? 'globe'
      : boundary.visibility === 'collaborative'
        ? 'users'
        : 'shield';
  const [files, setFiles] = useState<AssetFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const reload = useCallback(async () => {
    try {
      const payload = await fetchJson<{ asset: AssetSummary; files: AssetFile[] }>(
        `/api/matos/assets/${encodeURIComponent(selectionRef)}`,
      );
      setFiles(payload.files);
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
      setFiles([]);
    }
  }, [selectionRef]);

  useEffect(() => {
    setFiles(null);
    void reload();
  }, [reload]);

  const fileByName = useCallback(
    (name: string | null) => files?.find((file) => file.name === name) ?? null,
    [files],
  );

  const handleValidation = useCallback(
    (validation: { ok?: boolean; errors?: ValidationIssue[] } | undefined) => {
      const errors = Array.isArray(validation?.errors) ? validation.errors : [];
      setIssues(errors);
      setNotice(
        validation?.ok === false
          ? { tone: 'error', text: t('assets.validationFailed') }
          : { tone: 'ok', text: t('assets.saved') },
      );
    },
    [t],
  );

  const saveFile = useCallback(
    async (name: string, content: string, expectedContent?: string): Promise<boolean> => {
      setBusy(name);
      setNotice(null);
      try {
        const payload = await putAssetFile(selectionRef, name, content, expectedContent);
        setFiles((current) =>
          current?.map((file) => (file.name === name ? { ...file, content } : file)) ?? current,
        );
        handleValidation(payload.validation);
        return payload.validation?.ok !== false;
      } catch (err) {
        setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
        if (expectedContent !== undefined) throw err;
        return false;
      } finally {
        setBusy(null);
      }
    },
    [selectionRef, handleValidation],
  );

  const publish = useCallback(async () => {
    setBusy('publish');
    setNotice(null);
    try {
      await fetchJson(`/api/matos/assets/${encodeURIComponent(selectionRef)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `matos-studio: update ${asset.ref}` }),
      });
      setNotice({ tone: 'ok', text: t('assets.published') });
      await onChanged();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [asset.ref, selectionRef, onChanged, t]);

  const assetJson = fileByName('asset.json');
  // Drafts from an earlier import are not in any asset source yet, so they
  // cannot be published; adopting moves their pack into the user's assets.
  const intakePackId = useMemo(() => {
    if (asset.git.sourceId || !assetJson) return null;
    try {
      const manifest = JSON.parse(assetJson.content) as {
        lifecycle?: { origin?: string };
        metadata?: { intake?: { intakeId?: string } };
      };
      const packId = manifest.metadata?.intake?.intakeId;
      return manifest.lifecycle?.origin === 'matos-external-intake-draft' && typeof packId === 'string'
        ? packId
        : null;
    } catch {
      return null;
    }
  }, [asset.git.sourceId, assetJson]);

  const adoptDraft = useCallback(async () => {
    if (!intakePackId) return;
    setBusy('adopt');
    setNotice(null);
    try {
      await fetchJson('/api/matos/assets/import-adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: intakePackId }),
      });
      setNotice({ tone: 'ok', text: t('assets.import.adopted') });
      // The asset moved from the draft pack into the user's source: drop the
      // cached listing and the draft's files.
      clearMatOSAssetsCache();
      await onChanged();
      await reload();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [intakePackId, onChanged, reload, t]);
  const entryFile = fileByName(asset.entry) ?? files?.find((f) => f.name.endsWith('.md')) ?? null;
  const workflowEntry =
    asset.type === 'workflow'
      ? fileByName(asset.entry)
      : null;
  const mcpEntry = asset.type === 'mcp' ? fileByName('mcp.json') : null;
  const typeMeta = assetTypeMeta(asset.type);
  const permissions = assetJson ? permissionsFromAssetJson(assetJson.content) : null;
  const knowledgeProfile =
    asset.type === 'knowledge' && assetJson ? knowledgeProfileFromAssetJson(assetJson.content) : null;
  const dataProvenance =
    asset.type === 'data' && assetJson ? dataProvenanceFromAssetJson(assetJson.content) : null;
  // Generated archive units (TOS dataset/paper units) are read-only records:
  // the source/provenance card is the main body and the hand-edited families
  // editor only appears when the asset actually declares mount families.
  const showDataFamilies =
    asset.type === 'data' &&
    assetJson !== null &&
    (!dataProvenance?.generated || dataProfileFromAssetJson(assetJson.content).families.length > 0);

  return (
    <section
      className="assets-view assets-detail"
      data-testid="asset-detail"
      data-asset-type={asset.type}
      style={assetAccentStyle(asset.type)}
    >
      <header className="integrations-view__hero assets-detail__hero">
        <span className="assets-detail__hero-art" aria-hidden>
          <Icon name={typeMeta.icon} size={148} strokeWidth={0.9} />
        </span>
        <div className="assets-detail__title">
          <button type="button" className="assets-detail__back" onClick={onBack} aria-label={t('assets.back')}>
            <Icon name="arrow-left" size={16} />
          </button>
          <span className="assets-detail__type-badge" aria-hidden>
            <Icon name={typeMeta.icon} size={22} />
          </span>
          <div className="assets-detail__heading">
            <p className="integrations-view__kicker assets-detail__kicker">
              {t(`assets.type.${assetTypeMeta(asset.type).type}` as never)}
              <code className="assets-detail__ref">{asset.ref}</code>
            </p>
            <h1 className="entry-section__title">{asset.name}</h1>
            <p className="integrations-view__lede">{asset.description ?? ''}</p>
            <div className="assets-detail__chips">
              {asset.version ? (
                <span className="assets-detail__chip assets-detail__chip--version">v{asset.version}</span>
              ) : null}
              <span className="assets-detail__chip assets-detail__chip--scope" data-boundary={boundary.visibility}>
                <Icon name={boundaryIcon} size={11} /> {assetBoundaryLabel(asset, boundaryCopy)}
              </span>
              <span className="assets-detail__chip">
                <Icon name={boundary.editable ? 'edit' : 'shield'} size={11} />
                {boundary.editable ? boundaryCopy.editable : boundaryCopy.readOnly}
              </span>
              {boundary.selfEvolved ? (
                <span className="assets-detail__chip assets-detail__chip--evolved">
                  <Icon name="sparkles" size={11} /> {boundaryCopy.evolved} · {boundary.evolutionRuns}
                </span>
              ) : null}
              {asset.packId ? (
                <span className="assets-detail__chip">
                  <Icon name="blocks" size={11} /> {asset.packId}
                </span>
              ) : null}
              {asset.dependencies.length > 0 ? (
                <span className="assets-detail__chip">
                  <Icon name="link" size={11} />{' '}
                  {t('assets.hero.deps', { n: String(asset.dependencies.length) })}
                </span>
              ) : null}
              {asset.tags.slice(0, 5).map((tag) => (
                <span key={tag} className="assets-detail__chip assets-detail__chip--tag">{tag}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="assets-detail__actions">
          {workflowEntry && /\.(json|ya?ml)$/i.test(workflowEntry.name) ? <WorkflowAssetDraftButton asset={asset} /> : null}
          {asset.git.webUrl ? (
            <a className="assets-detail__git" href={asset.git.webUrl} target="_blank" rel="noreferrer">
              <Icon name="external-link" size={13} /> {t('assets.openInGitea')}
            </a>
          ) : null}
          {intakePackId ? (
            <button
              type="button"
              className="assets-btn assets-btn--primary"
              disabled={busy !== null}
              onClick={() => void adoptDraft()}
              data-testid="assets-intake-adopt"
            >
              {busy === 'adopt' ? t('assets.import.adopting') : t('assets.import.adopt')}
            </button>
          ) : (
            <button
              type="button"
              className="assets-btn assets-btn--primary"
              disabled={busy !== null || !asset.git.sourceId || (asset.type === 'workflow' && !boundary.editable)}
              onClick={() => void publish()}
            >
              {busy === 'publish' ? t('assets.publishing') : t('assets.publish')}
            </button>
          )}
        </div>
      </header>

      {notice ? (
        <div className={`assets-view__notice assets-view__notice--${notice.tone}`}>{notice.text}</div>
      ) : null}
      {issues.length > 0 ? (
        <div className="assets-view__error">
          {issues.map((issue, index) => (
            <div key={index}>{issue.code ? `${issue.code}: ` : ''}{issue.message ?? ''}</div>
          ))}
        </div>
      ) : null}

      {files === null ? (
        <div className="assets-view__empty">{t('assets.loading')}</div>
      ) : asset.type === 'workflow' && workflowEntry && /\.(json|ya?ml)$/i.test(workflowEntry.name) ? (
        <WorkflowAssetEditor
          asset={asset}
          entry={workflowEntry}
          readOnly={!boundary.editable}
          onSaveFile={saveFile}
          roleOptions={allAssets.filter((a) => a.type === 'role').map((a) => a.ref)}
        />
      ) : (
        <div className="assets-detail__stack">
          {assetJson ? (
            <MetadataCard assetJson={assetJson} busy={busy} onSave={saveFile} />
          ) : null}
          {asset.type === 'role' && assetJson ? (
            <RoleRuntimeCard assetJson={assetJson} busy={busy} onSave={saveFile} />
          ) : null}
          {asset.type === 'role' && assetJson ? (
            <RoleMountsCard
              assetJson={assetJson}
              allAssets={allAssets}
              busy={busy}
              onSave={saveFile}
            />
          ) : null}
          {asset.type === 'mcp' && mcpEntry ? (
            <McpServersCard entry={mcpEntry} assetJson={assetJson} busy={busy} onSave={saveFile} />
          ) : null}
          {asset.type === 'tool' && assetJson ? (
            <ToolBindingsCard assetJson={assetJson} allAssets={allAssets} busy={busy} onSave={saveFile} />
          ) : null}
          {dataProvenance?.present ? <DataProvenanceCard fields={dataProvenance} /> : null}
          {showDataFamilies && assetJson ? (
            <DataFamiliesCard assetJson={assetJson} busy={busy} onSave={saveFile} />
          ) : null}
          {knowledgeProfile &&
          (knowledgeProfile.capabilities.length > 0 ||
            knowledgeProfile.executionMode ||
            knowledgeProfile.safetyNotes.length > 0 ||
            knowledgeProfile.requiresApproval ||
            knowledgeProfile.simulationOnly) ? (
            <KnowledgeProfileCard profile={knowledgeProfile} />
          ) : null}
          {permissions?.present ? <PermissionsCard permissions={permissions} /> : null}
          {asset.type === 'skill' && entryFile ? (
            <SkillDocumentCard entryFile={entryFile} busy={busy} onSave={saveFile} />
          ) : entryFile && entryFile.name !== 'asset.json' && entryFile.name !== 'mcp.json' ? (
            <DocumentCard
              title={t('assets.docTitle')}
              file={entryFile}
              busy={busy}
              onSave={saveFile}
            />
          ) : null}
        </div>
      )}


      <AssetRevisionArchive assetRef={asset.ref} />

      {files !== null && files.length > 0 ? (
        <AdvancedRawFiles files={files} busy={busy} onSave={saveFile} />
      ) : null}

    </section>
  );
}


/** Friendly file-manager projection for the aggregate native data asset. */
// --- shared panel chrome ------------------------------------------------------

/**
 * Uniform structured-editor panel head: accent-tinted icon + title on the
 * left, the action slot (usually Save) on the right.
 */
function PanelHead({
  icon,
  title,
  action,
}: {
  icon: IconName;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="assets-panel__head">
      <span className="assets-panel__title">
        <span className="assets-panel__icon" aria-hidden>
          <Icon name={icon} size={14} />
        </span>
        <h2>{title}</h2>
      </span>
      {action}
    </div>
  );
}

// --- metadata form ----------------------------------------------------------

function MetadataCard({
  assetJson,
  busy,
  onSave,
}: {
  assetJson: AssetFile;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [fields, setFields] = useState<AssetMetadataFields>(() => metadataFromAssetJson(assetJson.content));
  const [baseline, setBaseline] = useState(assetJson.content);
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    if (assetJson.content !== baseline) {
      setFields(metadataFromAssetJson(assetJson.content));
      setBaseline(assetJson.content);
    }
  }, [assetJson.content, baseline]);

  const dirty = useMemo(
    () => applyMetadataToAssetJson(baseline, fields) !== applyMetadataToAssetJson(baseline, metadataFromAssetJson(baseline)),
    [baseline, fields],
  );

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag || fields.tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    setFields((current) => ({ ...current, tags: [...current.tags, tag] }));
    setTagDraft('');
  };

  return (
    <div className="assets-panel">
      <PanelHead
        icon="info"
        title={t('assets.metadataTitle')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(assetJson.name, applyMetadataToAssetJson(baseline, fields))}
          >
            {busy === assetJson.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <div className="assets-form">
        <label className="assets-form__field">
          <span>{t('assets.form.name')}</span>
          <input
            value={fields.name}
            onChange={(event) => setFields((c) => ({ ...c, name: event.target.value }))}
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.form.version')}</span>
          <input
            value={fields.version}
            onChange={(event) => setFields((c) => ({ ...c, version: event.target.value }))}
          />
        </label>
        <label className="assets-form__field assets-form__field--wide">
          <span>{t('assets.form.description')}</span>
          <textarea
            rows={3}
            value={fields.description}
            onChange={(event) => setFields((c) => ({ ...c, description: event.target.value }))}
          />
        </label>
        <div className="assets-form__field assets-form__field--wide">
          <span>{t('assets.form.tags')}</span>
          <div className="assets-chips">
            {fields.tags.map((tag) => (
              <span key={tag} className="assets-chip">
                {tag}
                <button
                  type="button"
                  aria-label={t('assets.form.removeTag')}
                  onClick={() =>
                    setFields((c) => ({ ...c, tags: c.tags.filter((x) => x !== tag) }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="assets-chips__input"
              value={tagDraft}
              placeholder={t('assets.form.addTag')}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// --- role runtime overrides editor -------------------------------------------
//
// Edits the role manifest's `runtime` block (model / effort / permission
// mode / max turns) — the same block `matos roles runtime set` writes and the
// `matos --role` launch path composes into the agent graph. Saving goes
// through the normal asset.json save path (validation + Gitea governance),
// so it cannot race the metadata/mounts cards' writes.

const ROLE_RUNTIME_EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'max'] as const;
const ROLE_RUNTIME_PERMISSION_OPTIONS = [
  '',
  'plan',
  'default',
  'acceptEdits',
  'bypassPermissions',
] as const;

function RoleRuntimeCard({
  assetJson,
  busy,
  onSave,
}: {
  assetJson: AssetFile;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [baseline, setBaseline] = useState(assetJson.content);
  const [fields, setFields] = useState<RoleRuntimeFields>(() =>
    roleRuntimeFromAssetJson(assetJson.content),
  );

  useEffect(() => {
    if (assetJson.content !== baseline) {
      setFields(roleRuntimeFromAssetJson(assetJson.content));
      setBaseline(assetJson.content);
    }
  }, [assetJson.content, baseline]);

  const dirty = useMemo(
    () =>
      JSON.stringify(roleRuntimeFromAssetJson(baseline)) !== JSON.stringify(fields),
    [baseline, fields],
  );
  const maxTurnsInvalid =
    fields.maxTurns.trim() !== '' &&
    (!Number.isInteger(Number(fields.maxTurns)) || Number(fields.maxTurns) <= 0);

  const set = (patch: Partial<RoleRuntimeFields>) =>
    setFields((current) => ({ ...current, ...patch }));

  return (
    <div className="assets-panel" data-testid="role-runtime-card">
      <PanelHead
        icon="sliders"
        title={t('assets.runtime.title')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || maxTurnsInvalid || busy !== null}
            data-testid="role-runtime-save"
            onClick={() =>
              void onSave(assetJson.name, applyRoleRuntimeToAssetJson(baseline, fields))
            }
          >
            {busy === assetJson.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <p className="assets-panel__hint">{t('assets.runtime.hint')}</p>
      <div className="assets-form">
        <label className="assets-form__field">
          <span>{t('assets.runtime.model')}</span>
          <input
            value={fields.model}
            placeholder={t('assets.runtime.modelPlaceholder')}
            data-testid="role-runtime-model"
            onChange={(event) => set({ model: event.target.value })}
          />
        </label>
        <label className="assets-form__field">
          <span>{t('assets.runtime.effort')}</span>
          <select
            value={fields.effort}
            data-testid="role-runtime-effort"
            onChange={(event) => set({ effort: event.target.value })}
          >
            {ROLE_RUNTIME_EFFORT_OPTIONS.map((option) => (
              <option key={option || 'default'} value={option}>
                {option === ''
                  ? t('assets.runtime.inherit')
                  : t(`assets.runtime.effort.${option}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="assets-form__field">
          <span>{t('assets.runtime.permissionMode')}</span>
          <select
            value={fields.permissionMode}
            data-testid="role-runtime-permission"
            onChange={(event) => set({ permissionMode: event.target.value })}
          >
            {ROLE_RUNTIME_PERMISSION_OPTIONS.map((option) => (
              <option key={option || 'default-mode'} value={option}>
                {option === ''
                  ? t('assets.runtime.inherit')
                  : t(`assets.runtime.permission.${option}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="assets-form__field">
          <span>{t('assets.runtime.maxTurns')}</span>
          <input
            value={fields.maxTurns}
            inputMode="numeric"
            placeholder={t('assets.runtime.inherit')}
            aria-invalid={maxTurnsInvalid}
            data-testid="role-runtime-max-turns"
            onChange={(event) => set({ maxTurns: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}

// --- role mounts editor ------------------------------------------------------

function RoleMountsCard({
  assetJson,
  allAssets,
  busy,
  onSave,
}: {
  assetJson: AssetFile;
  allAssets: AssetSummary[];
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [deps, setDeps] = useState<string[]>(() => dependenciesFromAssetJson(assetJson.content));
  const [baseline, setBaseline] = useState(assetJson.content);
  const [pickerGroup, setPickerGroup] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');

  useEffect(() => {
    if (assetJson.content !== baseline) {
      setDeps(dependenciesFromAssetJson(assetJson.content));
      setBaseline(assetJson.content);
    }
  }, [assetJson.content, baseline]);

  const dirty = useMemo(() => {
    const original = dependenciesFromAssetJson(baseline);
    return JSON.stringify(original) !== JSON.stringify(deps);
  }, [baseline, deps]);

  const groups = groupDependencies(deps);
  const depSet = new Set(deps.map((d) => d.replace(/@.*$/, '')));
  const candidates = pickerGroup
    ? allAssets
        .filter((a) => a.type === pickerGroup && !depSet.has(a.ref))
        .filter((a) => {
          const q = pickerQuery.trim().toLowerCase();
          return !q || a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
        })
        .slice(0, 30)
    : [];

  return (
    <div className="assets-panel">
      <PanelHead
        icon="blocks"
        title={t('assets.mounts.title')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(assetJson.name, applyDependenciesToAssetJson(baseline, deps))}
          >
            {busy === assetJson.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <p className="assets-panel__hint">{t('assets.mounts.hint')}</p>
      <div className="assets-mounts">
        {MOUNT_GROUPS.map((group) => {
          const refs = groups.get(group.type) ?? [];
          return (
            <div key={group.type} className="assets-mounts__group" style={assetAccentStyle(group.type)}>
              <div className="assets-mounts__label">
                <span className="assets-mounts__label-icon" aria-hidden>
                  <Icon name={assetTypeMeta(group.type).icon} size={12} />
                </span>
                {t(group.labelKey as never)}
                {refs.length > 0 ? <span className="assets-mounts__count">{refs.length}</span> : null}
                <button
                  type="button"
                  className="assets-mounts__add"
                  aria-label={t('assets.mounts.add')}
                  onClick={() => {
                    setPickerGroup((current) => (current === group.type ? null : group.type));
                    setPickerQuery('');
                  }}
                >
                  +
                </button>
              </div>
              <div className="assets-chips">
                {refs.length === 0 ? <span className="assets-mounts__none">—</span> : null}
                {refs.map((dep) => (
                  <span key={dep} className="assets-chip">
                    <button
                      type="button"
                      className="assets-chip__link"
                      onClick={() =>
                        navigate({ kind: 'home', view: 'assets', assetRef: dep.replace(/@.*$/, '') })
                      }
                    >
                      {dep.slice(dep.indexOf(':') + 1)}
                    </button>
                    <button
                      type="button"
                      aria-label={t('assets.mounts.remove')}
                      onClick={() => setDeps((current) => current.filter((x) => x !== dep))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              {pickerGroup === group.type ? (
                <div className="assets-mounts__picker">
                  <input
                    autoFocus
                    value={pickerQuery}
                    placeholder={t('assets.searchPlaceholder')}
                    onChange={(event) => setPickerQuery(event.target.value)}
                  />
                  <div className="assets-mounts__options">
                    {candidates.length === 0 ? (
                      <div className="assets-mounts__none">{t('assets.empty')}</div>
                    ) : (
                      candidates.map((candidate) => (
                        <button
                          key={candidate.ref}
                          type="button"
                          onClick={() => {
                            setDeps((current) => [...current, candidate.ref]);
                            setPickerGroup(null);
                          }}
                        >
                          <strong>{candidate.id}</strong>
                          <span>{candidate.description ?? ''}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- skill document (frontmatter form + markdown body) -----------------------

function SkillDocumentCard({
  entryFile,
  busy,
  onSave,
}: {
  entryFile: AssetFile;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [baseline, setBaseline] = useState(entryFile.content);
  const parts = useMemo(() => splitFrontmatter(baseline), [baseline]);
  const [fmFields, setFmFields] = useState(() => skillFieldsFromFrontmatter(parts.frontmatter));
  const [body, setBody] = useState(parts.body);
  const [toolDraft, setToolDraft] = useState('');

  useEffect(() => {
    if (entryFile.content !== baseline) {
      setBaseline(entryFile.content);
      const next = splitFrontmatter(entryFile.content);
      setFmFields(skillFieldsFromFrontmatter(next.frontmatter));
      setBody(next.body);
    }
  }, [entryFile.content, baseline]);

  const compose = useCallback(() => {
    const frontmatter = parts.hasFrontmatter
      ? applySkillFieldsToFrontmatter(parts.frontmatter, fmFields)
      : parts.frontmatter;
    return joinFrontmatter({ frontmatter, body, hasFrontmatter: parts.hasFrontmatter });
  }, [parts, fmFields, body]);

  // Compare against the round-tripped baseline (parse → serialize), not the
  // raw file: front-matter normalization (key order, quoting) must not make
  // an untouched skill look dirty.
  const baselineComposed = useMemo(() => {
    const frontmatter = parts.hasFrontmatter
      ? applySkillFieldsToFrontmatter(parts.frontmatter, skillFieldsFromFrontmatter(parts.frontmatter))
      : parts.frontmatter;
    return joinFrontmatter({ frontmatter, body: parts.body, hasFrontmatter: parts.hasFrontmatter });
  }, [parts]);

  const dirty = compose() !== baselineComposed;

  return (
    <div className="assets-panel">
      <PanelHead
        icon="sparkles"
        title={t('assets.skillDocTitle')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(entryFile.name, compose())}
          >
            {busy === entryFile.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      {parts.hasFrontmatter ? (
        <div className="assets-form">
          <label className="assets-form__field assets-form__field--wide">
            <span>{t('assets.form.description')}</span>
            <textarea
              rows={2}
              value={fmFields.description}
              onChange={(event) =>
                setFmFields((c) => ({ ...c, description: event.target.value }))
              }
            />
          </label>
          <div className="assets-form__field assets-form__field--wide">
            <span>{t('assets.form.allowedTools')}</span>
            <div className="assets-chips">
              {fmFields.allowedTools.map((tool) => (
                <span key={tool} className="assets-chip">
                  {tool}
                  <button
                    type="button"
                    aria-label={t('assets.form.removeTag')}
                    onClick={() =>
                      setFmFields((c) => ({
                        ...c,
                        allowedTools: c.allowedTools.filter((x) => x !== tool),
                      }))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="assets-chips__input"
                value={toolDraft}
                placeholder={t('assets.form.addTool')}
                onChange={(event) => setToolDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const tool = toolDraft.trim();
                    if (tool && !fmFields.allowedTools.includes(tool)) {
                      setFmFields((c) => ({ ...c, allowedTools: [...c.allowedTools, tool] }));
                    }
                    setToolDraft('');
                  }
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
      <div className="assets-doc">
        <span className="assets-doc__label">{t('assets.docBody')}</span>
        <div className="assets-doc__editor">
          <CodeEditor
            key={`${entryFile.name}:${fnv1a36(baseline)}`}
            initialValue={body}
            fileName={entryFile.name}
            autoFocus={false}
            onChange={setBody}
            onSave={() => {
              if (compose() !== baselineComposed && busy === null) void onSave(entryFile.name, compose());
            }}
          />
        </div>
      </div>
    </div>
  );
}

// --- generic document editor (knowledge / tool docs) -------------------------

function DocumentCard({
  title,
  file,
  busy,
  onSave,
}: {
  title: string;
  file: AssetFile;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(file.content);
  const [baseline, setBaseline] = useState(file.content);

  useEffect(() => {
    if (file.content !== baseline) {
      setBaseline(file.content);
      setDraft(file.content);
    }
  }, [file.content, baseline]);

  const docIcon: IconName = file.name.endsWith('.json')
    ? 'braces'
    : file.name.endsWith('.yaml') || file.name.endsWith('.yml')
      ? 'file-code'
      : 'file-text';

  return (
    <div className="assets-panel">
      <PanelHead
        icon={docIcon}
        title={title}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={draft === baseline || busy !== null}
            onClick={() => void onSave(file.name, draft)}
          >
            {busy === file.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <div className="assets-doc">
        <span className="assets-doc__label">{file.name}</span>
        <div className="assets-doc__editor">
          <CodeEditor
            key={`${file.name}:${fnv1a36(baseline)}`}
            initialValue={draft}
            fileName={file.name}
            autoFocus={false}
            onChange={setDraft}
            onSave={() => {
              if (draft !== baseline && busy === null) void onSave(file.name, draft);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// --- MCP servers (mcp.json structured editor) --------------------------------
//
// The launch config agents actually consume: server name → command/args/env.
// Round-trips unknown per-server keys (cwd, transport, url, …) through
// applyMcpServersToJson; asset.json's runtimeHints surface as a read-only
// launch profile strip so operators see conda/model requirements next to the
// command they are editing.

function McpServersCard({
  entry,
  assetJson,
  busy,
  onSave,
}: {
  entry: AssetFile;
  assetJson: AssetFile | null;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [baseline, setBaseline] = useState(entry.content);
  const [servers, setServers] = useState<McpServerFields[]>(() => mcpServersFromJson(entry.content));

  useEffect(() => {
    if (entry.content !== baseline) {
      setBaseline(entry.content);
      setServers(mcpServersFromJson(entry.content));
    }
  }, [entry.content, baseline]);

  const profile = useMemo(
    () => (assetJson ? mcpProfileFromAssetJson(assetJson.content) : null),
    [assetJson],
  );

  const dirty = useMemo(
    () => applyMcpServersToJson(baseline, servers) !== applyMcpServersToJson(baseline, mcpServersFromJson(baseline)),
    [baseline, servers],
  );

  const patchServer = (index: number, patch: Partial<McpServerFields>) =>
    setServers((current) => current.map((server, i) => (i === index ? { ...server, ...patch } : server)));

  return (
    <div className="assets-panel" data-testid="mcp-servers-card">
      <PanelHead
        icon="server"
        title={t('assets.mcp.title')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(entry.name, applyMcpServersToJson(baseline, servers))}
          >
            {busy === entry.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <p className="assets-panel__hint">{t('assets.mcp.hint')}</p>

      {profile && (profile.serverName || profile.condaEnvs.length > 0 || profile.requiresModels) ? (
        <div className="assets-mcp__profile">
          {profile.serverName ? (
            <span className="assets-detail__chip">
              <Icon name="plug" size={11} /> {profile.serverName}
            </span>
          ) : null}
          {profile.condaEnvs.map((env) => (
            <span key={env} className="assets-detail__chip">
              <Icon name="terminal" size={11} /> {env}
            </span>
          ))}
          {profile.requiresModels ? (
            <span className="assets-detail__chip assets-detail__chip--warn">
              <Icon name="database" size={11} /> {t('assets.mcp.requiresModels')}
            </span>
          ) : null}
        </div>
      ) : null}

      {servers.length === 0 ? (
        <p className="assets-panel__hint assets-mcp__empty">{t('assets.mcp.empty')}</p>
      ) : (
        servers.map((server, index) => (
          <div key={index} className="assets-mcp__server">
            <div className="assets-mcp__server-head">
              <span className="assets-mcp__server-icon" aria-hidden>
                <Icon name="server" size={13} />
              </span>
              <input
                className="assets-mcp__server-name"
                value={server.name}
                placeholder={t('assets.mcp.serverName')}
                aria-label={t('assets.mcp.serverName')}
                onChange={(event) => patchServer(index, { name: event.target.value })}
              />
              <button
                type="button"
                className="assets-mcp__server-remove"
                aria-label={t('assets.mcp.removeServer')}
                title={t('assets.mcp.removeServer')}
                onClick={() => setServers((current) => current.filter((_, i) => i !== index))}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
            <label className="assets-form__field assets-form__field--wide">
              <span>
                <Icon name="terminal" size={11} /> {t('assets.mcp.command')}
              </span>
              <input
                value={server.command}
                spellCheck={false}
                className="assets-input--mono"
                onChange={(event) => patchServer(index, { command: event.target.value })}
              />
            </label>
            <label className="assets-form__field assets-form__field--wide">
              <span>
                <Icon name="braces" size={11} /> {t('assets.mcp.args')}
              </span>
              <textarea
                rows={Math.min(8, Math.max(2, server.args.length + 1))}
                value={server.args.join('\n')}
                spellCheck={false}
                className="assets-input--mono"
                onChange={(event) =>
                  patchServer(index, {
                    args: event.target.value === '' ? [] : event.target.value.split('\n'),
                  })
                }
              />
            </label>
            <div className="assets-form__field assets-form__field--wide">
              <span>
                <Icon name="variable" size={11} /> {t('assets.mcp.env')}
              </span>
              <div className="assets-kv">
                {server.env.map(([key, value], envIndex) => (
                  <div key={envIndex} className="assets-kv__row">
                    <input
                      className="assets-kv__key assets-input--mono"
                      value={key}
                      placeholder={t('assets.mcp.envKey')}
                      aria-label={t('assets.mcp.envKey')}
                      spellCheck={false}
                      onChange={(event) =>
                        patchServer(index, {
                          env: server.env.map((pair, i) =>
                            i === envIndex ? [event.target.value, pair[1]] : pair,
                          ),
                        })
                      }
                    />
                    <input
                      className="assets-kv__value assets-input--mono"
                      value={value}
                      placeholder={t('assets.mcp.envValue')}
                      aria-label={t('assets.mcp.envValue')}
                      spellCheck={false}
                      onChange={(event) =>
                        patchServer(index, {
                          env: server.env.map((pair, i) =>
                            i === envIndex ? [pair[0], event.target.value] : pair,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="assets-kv__remove"
                      aria-label={t('common.delete')}
                      onClick={() =>
                        patchServer(index, { env: server.env.filter((_, i) => i !== envIndex) })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="assets-kv__add"
                  onClick={() => patchServer(index, { env: [...server.env, ['', '']] })}
                >
                  <Icon name="plus" size={12} /> {t('assets.mcp.addEnv')}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      <button
        type="button"
        className="assets-btn assets-mcp__add-server"
        onClick={() =>
          setServers((current) => [...current, { name: '', command: '', args: [], env: [] }])
        }
      >
        <Icon name="plus" size={12} /> {t('assets.mcp.addServer')}
      </button>
    </div>
  );
}

// --- tool bindings (builtinTools / mcpServers in asset.json metadata) --------

function ToolBindingsCard({
  assetJson,
  allAssets,
  busy,
  onSave,
}: {
  assetJson: AssetFile;
  allAssets: AssetSummary[];
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [baseline, setBaseline] = useState(assetJson.content);
  const [fields, setFields] = useState<ToolBindingsFields>(() => toolBindingsFromAssetJson(assetJson.content));
  const [builtinDraft, setBuiltinDraft] = useState('');
  const [mcpDraft, setMcpDraft] = useState('');

  useEffect(() => {
    if (assetJson.content !== baseline) {
      setBaseline(assetJson.content);
      setFields(toolBindingsFromAssetJson(assetJson.content));
    }
  }, [assetJson.content, baseline]);

  const dirty = useMemo(
    () =>
      JSON.stringify(toolBindingsFromAssetJson(baseline)) !== JSON.stringify(fields),
    [baseline, fields],
  );

  const mcpOptions = useMemo(
    () =>
      allAssets
        .filter((a) => a.type === 'mcp')
        .map((a) => a.id)
        .filter((id) => !fields.mcpServers.includes(id)),
    [allAssets, fields.mcpServers],
  );

  const addBuiltin = () => {
    const tool = builtinDraft.trim();
    setBuiltinDraft('');
    if (!tool || fields.builtinTools.includes(tool)) return;
    setFields((c) => ({ ...c, builtinTools: [...c.builtinTools, tool] }));
  };
  const addMcp = (value: string) => {
    const ref = value.trim();
    setMcpDraft('');
    if (!ref || fields.mcpServers.includes(ref)) return;
    setFields((c) => ({ ...c, mcpServers: [...c.mcpServers, ref] }));
  };

  return (
    <div className="assets-panel" data-testid="tool-bindings-card">
      <PanelHead
        icon="hammer"
        title={t('assets.tool.title')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(assetJson.name, applyToolBindingsToAssetJson(baseline, fields))}
          >
            {busy === assetJson.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <p className="assets-panel__hint">{t('assets.tool.hint')}</p>
      {fields.kind ? (
        <div className="assets-mcp__profile">
          <span className="assets-detail__chip">
            <Icon name="info" size={11} /> {fields.kind}
          </span>
        </div>
      ) : null}
      <div className="assets-form">
        <div className="assets-form__field assets-form__field--wide">
          <span>
            <Icon name="hammer" size={11} /> {t('assets.tool.builtin')}
          </span>
          <div className="assets-chips">
            {fields.builtinTools.map((tool) => (
              <span key={tool} className="assets-chip">
                {tool}
                <button
                  type="button"
                  aria-label={t('assets.form.removeTag')}
                  onClick={() =>
                    setFields((c) => ({ ...c, builtinTools: c.builtinTools.filter((x) => x !== tool) }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="assets-chips__input"
              value={builtinDraft}
              placeholder={t('assets.tool.addBuiltin')}
              onChange={(event) => setBuiltinDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addBuiltin();
                }
              }}
              onBlur={addBuiltin}
            />
          </div>
        </div>
        <div className="assets-form__field assets-form__field--wide">
          <span>
            <Icon name="plug" size={11} /> {t('assets.tool.mcpRefs')}
          </span>
          <div className="assets-chips">
            {fields.mcpServers.map((ref) => (
              <span key={ref} className="assets-chip">
                {ref}
                <button
                  type="button"
                  aria-label={t('assets.form.removeTag')}
                  onClick={() =>
                    setFields((c) => ({ ...c, mcpServers: c.mcpServers.filter((x) => x !== ref) }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="assets-chips__input"
              value={mcpDraft}
              list="assets-tool-mcp-options"
              placeholder={t('assets.tool.addMcpRef')}
              onChange={(event) => setMcpDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addMcp(mcpDraft);
                }
              }}
              onBlur={() => addMcp(mcpDraft)}
            />
            <datalist id="assets-tool-mcp-options">
              {mcpOptions.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- data source & provenance (dataset/paper units) ---------------------------
//
// Read-only projection of the unit metadata written by
// scripts/material-bench-units-to-assets.py (and curated data assets that
// declare sourceUrl/doi): upstream record, DOI links, source URLs, TOS
// payload status/size, archive directories, and the catalog query that
// resolves the unit at runtime.

export function DataProvenanceCard({ fields }: { fields: DataProvenanceFields }) {
  const t = useT();
  const dois = [fields.doi, fields.paperDoi].filter((doi, index, all) => doi && all.indexOf(doi) === index);
  const payloadTone =
    fields.payloadStatus === 'archived-tos' ? 'ok' : fields.payloadStatus ? 'pending' : '';
  return (
    <div className="assets-panel" data-testid="data-provenance-card">
      <PanelHead icon="globe" title={t('assets.data.provenanceTitle')} />
      <div className="assets-detail__chips assets-provenance__chips">
        {fields.provider ? (
          <span className="assets-detail__chip assets-detail__chip--tag">
            <Icon name="database" size={11} /> {fields.provider}
            {fields.providerId ? ` · ${fields.providerId}` : ''}
          </span>
        ) : null}
        {fields.unitKind ? <span className="assets-detail__chip">{fields.unitKind}</span> : null}
        {fields.payloadStatus ? (
          <span className={`assets-detail__chip assets-provenance__chip--${payloadTone}`}>
            <Icon name={payloadTone === 'ok' ? 'check' : 'info'} size={11} /> {fields.payloadStatus}
          </span>
        ) : null}
        {fields.payloadKind && fields.payloadKind !== 'data' ? (
          <span className="assets-detail__chip">{fields.payloadKind}</span>
        ) : null}
        {fields.sizeHuman ? (
          <span className="assets-detail__chip assets-detail__chip--version">{fields.sizeHuman}</span>
        ) : null}
        {typeof fields.recordCount === 'number' && fields.recordCount > 0 ? (
          <span className="assets-detail__chip">
            {t('assets.data.records', { n: String(fields.recordCount) })}
          </span>
        ) : null}
        {fields.curationIssues.map((issue) => (
          <span key={issue} className="assets-detail__chip assets-provenance__chip--pending">
            {issue}
          </span>
        ))}
      </div>

      {dois.length > 0 ? (
        <div className="assets-provenance__row">
          <span className="assets-provenance__label">DOI</span>
          <span className="assets-provenance__value">
            {dois.map((doi) => (
              <a
                key={doi}
                className="assets-provenance__link"
                href={`https://doi.org/${doi}`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="external-link" size={11} /> {doi}
              </a>
            ))}
          </span>
        </div>
      ) : null}

      {fields.sourceUrls.length > 0 ? (
        <div className="assets-provenance__row">
          <span className="assets-provenance__label">{t('assets.data.links')}</span>
          <span className="assets-provenance__value">
            {fields.sourceUrls.slice(0, 8).map((url) => (
              <a key={url} className="assets-provenance__link" href={url} target="_blank" rel="noreferrer">
                <Icon name="external-link" size={11} /> <span className="assets-provenance__url">{url}</span>
              </a>
            ))}
          </span>
        </div>
      ) : null}

      {fields.collections.length > 0 ? (
        <div className="assets-provenance__row">
          <span className="assets-provenance__label">{t('assets.data.collections')}</span>
          <span className="assets-provenance__value">
            {fields.collections.slice(0, 8).map((collection) => (
              <code key={collection} className="assets-provenance__code">{collection}</code>
            ))}
          </span>
        </div>
      ) : null}

      {fields.containerPath || fields.payloadPaths.length > 0 ? (
        <div className="assets-provenance__row">
          <span className="assets-provenance__label">{t('assets.data.payload')}</span>
          <span className="assets-provenance__value assets-provenance__value--stack">
            {(fields.payloadPaths.length > 0 ? fields.payloadPaths : [fields.containerPath])
              .slice(0, 6)
              .map((path) => (
                <code key={path} className="assets-provenance__code">{path}</code>
              ))}
            {fields.tosArchive ? (
              <code className="assets-provenance__code assets-provenance__code--dim">
                tos://{fields.tosArchive}
              </code>
            ) : null}
          </span>
        </div>
      ) : null}

      {fields.catalogTool ? (
        <p className="assets-panel__hint assets-provenance__hint">
          {t('assets.data.queryHint')}{' '}
          <code className="assets-provenance__code">{fields.catalogTool}</code>
          {fields.recommendedQuery ? (
            <>
              {' '}
              <code className="assets-provenance__code">{fields.recommendedQuery}</code>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// --- data mounts (containerRoot + families table) -----------------------------

const DATA_FAMILY_COLUMNS: Array<{
  key: keyof Omit<DataProfileFields['families'][number], never>;
  labelKey:
    | 'assets.data.family'
    | 'assets.data.version'
    | 'assets.data.functional'
    | 'assets.data.protocol'
    | 'assets.data.containerPath';
  wide?: boolean;
}> = [
  { key: 'family', labelKey: 'assets.data.family' },
  { key: 'version', labelKey: 'assets.data.version' },
  { key: 'functional', labelKey: 'assets.data.functional' },
  { key: 'protocol', labelKey: 'assets.data.protocol' },
  { key: 'containerPath', labelKey: 'assets.data.containerPath', wide: true },
];

function DataFamiliesCard({
  assetJson,
  busy,
  onSave,
}: {
  assetJson: AssetFile;
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [baseline, setBaseline] = useState(assetJson.content);
  const [fields, setFields] = useState<DataProfileFields>(() => dataProfileFromAssetJson(assetJson.content));

  useEffect(() => {
    if (assetJson.content !== baseline) {
      setBaseline(assetJson.content);
      setFields(dataProfileFromAssetJson(assetJson.content));
    }
  }, [assetJson.content, baseline]);

  const dirty = useMemo(
    () => JSON.stringify(dataProfileFromAssetJson(baseline)) !== JSON.stringify(fields),
    [baseline, fields],
  );

  const patchRow = (index: number, key: string, value: string) =>
    setFields((current) => ({
      ...current,
      families: current.families.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    }));

  return (
    <div className="assets-panel" data-testid="data-families-card">
      <PanelHead
        icon="flask"
        title={t('assets.data.title')}
        action={
          <button
            type="button"
            className="assets-btn assets-btn--primary"
            disabled={!dirty || busy !== null}
            onClick={() => void onSave(assetJson.name, applyDataProfileToAssetJson(baseline, fields))}
          >
            {busy === assetJson.name ? t('assets.saving') : t('assets.save')}
          </button>
        }
      />
      <p className="assets-panel__hint">{t('assets.data.hint')}</p>
      {fields.kind ? (
        <div className="assets-mcp__profile">
          <span className="assets-detail__chip">
            <Icon name="info" size={11} /> {fields.kind}
          </span>
        </div>
      ) : null}
      <label className="assets-form__field assets-form__field--wide">
        <span>
          <Icon name="folder" size={11} /> {t('assets.data.containerRoot')}
        </span>
        <input
          value={fields.containerRoot}
          spellCheck={false}
          className="assets-input--mono"
          placeholder="/opt/matos-tools/…"
          onChange={(event) => setFields((c) => ({ ...c, containerRoot: event.target.value }))}
        />
      </label>
      <div className="assets-form__field assets-form__field--wide">
        <span>
          <Icon name="database" size={11} /> {t('assets.data.families')}
        </span>
        {fields.families.length === 0 ? (
          <p className="assets-panel__hint">{t('assets.data.empty')}</p>
        ) : (
          <div className="assets-table" role="table">
            <div className="assets-table__row assets-table__row--head" role="row">
              {DATA_FAMILY_COLUMNS.map((column) => (
                <span
                  key={column.key}
                  role="columnheader"
                  className={`assets-table__cell${column.wide ? ' assets-table__cell--wide' : ''}`}
                >
                  {t(column.labelKey)}
                </span>
              ))}
              <span className="assets-table__cell assets-table__cell--actions" aria-hidden />
            </div>
            {fields.families.map((row, index) => (
              <div key={index} className="assets-table__row" role="row">
                {DATA_FAMILY_COLUMNS.map((column) => (
                  <span
                    key={column.key}
                    role="cell"
                    className={`assets-table__cell${column.wide ? ' assets-table__cell--wide' : ''}`}
                  >
                    <input
                      value={row[column.key]}
                      spellCheck={false}
                      aria-label={t(column.labelKey)}
                      className={column.wide ? 'assets-input--mono' : undefined}
                      onChange={(event) => patchRow(index, column.key, event.target.value)}
                    />
                  </span>
                ))}
                <span className="assets-table__cell assets-table__cell--actions" role="cell">
                  <button
                    type="button"
                    className="assets-kv__remove"
                    aria-label={t('assets.data.removeFamily')}
                    title={t('assets.data.removeFamily')}
                    onClick={() =>
                      setFields((c) => ({ ...c, families: c.families.filter((_, i) => i !== index) }))
                    }
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="assets-kv__add"
          onClick={() =>
            setFields((c) => ({
              ...c,
              families: [
                ...c.families,
                { family: '', version: '', functional: '', protocol: '', containerPath: '' },
              ],
            }))
          }
        >
          <Icon name="plus" size={12} /> {t('assets.data.addFamily')}
        </button>
      </div>
    </div>
  );
}

// --- knowledge capability/safety profile (read-only) --------------------------

const KNOWLEDGE_RISK_CLASS: Record<string, string> = {
  low: 'assets-cap__risk--low',
  medium: 'assets-cap__risk--medium',
  high: 'assets-cap__risk--high',
};

function KnowledgeProfileCard({ profile }: { profile: ReturnType<typeof knowledgeProfileFromAssetJson> }) {
  const t = useT();
  return (
    <div className="assets-panel" data-testid="knowledge-profile-card">
      <PanelHead icon="book-open" title={t('assets.knowledge.title')} />
      <p className="assets-panel__hint">{t('assets.knowledge.hint')}</p>
      <div className="assets-mcp__profile">
        {profile.kind ? (
          <span className="assets-detail__chip">
            <Icon name="info" size={11} /> {profile.kind}
          </span>
        ) : null}
        {profile.executionMode ? (
          <span className="assets-detail__chip">
            <Icon name="play" size={11} /> {profile.executionMode}
          </span>
        ) : null}
        {profile.requiresApproval ? (
          <span className="assets-detail__chip assets-detail__chip--warn">
            <Icon name="thumbs-up" size={11} /> {t('assets.knowledge.requiresApproval')}
          </span>
        ) : null}
        {profile.simulationOnly ? (
          <span className="assets-detail__chip">
            <Icon name="eye" size={11} /> {t('assets.knowledge.simulationOnly')}
          </span>
        ) : null}
      </div>
      {profile.capabilities.length > 0 ? (
        <div className="assets-cap__list">
          {profile.capabilities.map((cap) => (
            <div key={cap.id || cap.label} className="assets-cap">
              <div className="assets-cap__head">
                <span className="assets-cap__name">{cap.label || cap.id}</span>
                {cap.riskLevel ? (
                  <span className={`assets-cap__risk ${KNOWLEDGE_RISK_CLASS[cap.riskLevel] ?? ''}`.trim()}>
                    <Icon name="gauge" size={10} />
                    {cap.riskLevel in KNOWLEDGE_RISK_CLASS
                      ? t(`assets.knowledge.risk.${cap.riskLevel}` as never)
                      : cap.riskLevel}
                  </span>
                ) : null}
                {cap.sideEffects ? (
                  <span className="assets-cap__risk assets-cap__risk--medium">
                    <Icon name="alert-triangle" size={10} /> {t('assets.knowledge.sideEffects')}
                  </span>
                ) : null}
              </div>
              {cap.description ? <p className="assets-cap__desc">{cap.description}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {profile.safetyNotes.length > 0 ? (
        <div className="assets-cap__notes">
          <span className="assets-cap__notes-head">
            <Icon name="shield" size={12} /> {t('assets.knowledge.notes')}
          </span>
          <ul>
            {profile.safetyNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// --- permissions profile (read-only badges) -----------------------------------

const PERMISSION_ROWS: Array<{
  key: 'shell' | 'network' | 'workspace';
  icon: IconName;
  labelKey: 'assets.permissions.shell' | 'assets.permissions.network' | 'assets.permissions.workspace';
}> = [
  { key: 'shell', icon: 'terminal', labelKey: 'assets.permissions.shell' },
  { key: 'network', icon: 'globe', labelKey: 'assets.permissions.network' },
  { key: 'workspace', icon: 'folder', labelKey: 'assets.permissions.workspace' },
];

function permissionTone(value: string): string {
  if (/^(disabled|none|read-only|readonly)$/i.test(value)) return 'assets-perm__value--safe';
  if (/^(read-write|readwrite|full|all)$/i.test(value)) return 'assets-perm__value--open';
  return '';
}

function PermissionsCard({ permissions }: { permissions: ReturnType<typeof permissionsFromAssetJson> }) {
  const t = useT();
  return (
    <div className="assets-panel" data-testid="permissions-card">
      <PanelHead icon="shield" title={t('assets.permissions.title')} />
      <p className="assets-panel__hint">{t('assets.permissions.hint')}</p>
      <div className="assets-perm">
        {PERMISSION_ROWS.map((row) => (
          <div key={row.key} className="assets-perm__row">
            <span className="assets-perm__label">
              <Icon name={row.icon} size={12} /> {t(row.labelKey)}
            </span>
            <span className={`assets-perm__value ${permissionTone(permissions[row.key])}`.trim()}>
              {permissions[row.key] || t('assets.permissions.none')}
            </span>
          </div>
        ))}
        <div className="assets-perm__row">
          <span className="assets-perm__label">
            <Icon name="eye-off" size={12} /> {t('assets.permissions.secrets')}
          </span>
          <span className="assets-perm__value">
            {permissions.secrets.length > 0
              ? permissions.secrets.join(', ')
              : t('assets.permissions.none')}
          </span>
        </div>
      </div>
    </div>
  );
}

// --- workflow canvas ---------------------------------------------------------

function WorkflowAssetEditor({
  asset,
  entry,
  readOnly,
  onSaveFile,
  roleOptions,
}: {
  asset: AssetSummary;
  entry: AssetFile;
  readOnly: boolean;
  onSaveFile: (name: string, content: string, expectedContent?: string) => Promise<boolean>;
  roleOptions: string[];
}) {
  const t = useT();
  const [mode, setMode] = useState<'canvas' | 'text'>('canvas');
  const [parseError, setParseError] = useState<string | null>(null);
  const selectionRef = matOSAssetSelectionRef(asset);
  const baseContents = useMemo(() => new Map<string, string>(), [selectionRef, entry.name]);

  const loadText = useCallback(async () => {
    try {
      setParseError(null);
      const detail = await fetchJson<{ files: AssetFile[] }>(`/api/matos/assets/${encodeURIComponent(selectionRef)}`);
      const source = detail.files.find((file) => file.name === entry.name);
      if (!source) throw new Error(`Asset file not found: ${entry.name}`);
      const text = workflowTextToCanvasJson(source.content, entry.name);
      baseContents.set(text, source.content);
      return text;
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [selectionRef, entry.content, entry.name, baseContents]);

  const saveText = useCallback(
    async (json: string, expectedText?: string) => {
      const text = canvasJsonToWorkflowText(json, entry.name);
      const base = expectedText === undefined ? undefined : baseContents.get(expectedText);
      if (base === undefined) throw new Error('Asset revision is unavailable');
      const ok = await onSaveFile(entry.name, text, base);
      if (!ok) throw new Error('validation failed');
      baseContents.set(json, text);
    },
    [entry.name, onSaveFile, baseContents],
  );

  if (readOnly) {
    let preview = null;
    try {
      const parsed = parseWorkflowDocument(workflowTextToCanvasJson(entry.content, entry.name), asset.id);
      if (!parsed.parseError) preview = {
        ref: asset.ref,
        nodeCount: parsed.definition.nodes.length,
        edgeCount: canvasEdgesFromDefinition(parsed.definition).length,
        nodes: parsed.definition.nodes.map(node => ({ id: node.id, type: node.type, label: String(node.label ?? node.id) })),
        edges: canvasEdgesFromDefinition(parsed.definition).map(edge => ({ from: edge.from, to: edge.to })),
      };
    } catch { /* The original document remains available for diagnosis. */ }
    return <div className="assets-workflow" data-testid="workflow-asset-readonly">
      {preview ? <div className="wf-asset-readonly__graph"><WorkflowMiniMap preview={preview} /></div> : <p>{t('workflow.gallery.unavailable')}</p>}
      <details><summary>{entry.name}</summary><pre className="wf-asset-readonly__source">{entry.content}</pre></details>
    </div>;
  }

  if (mode === 'text' || parseError) {
    return (
      <div className="assets-detail__stack">
        {parseError ? <div className="assets-view__error">{parseError}</div> : null}
        <div className="assets-workflow__bar assets-workflow__bar--standalone">
          <span className="assets-workflow__hint">{entry.name}</span>
          <button
            type="button"
            className="assets-btn"
            disabled={Boolean(parseError)}
            onClick={() => setMode('canvas')}
          >
            {t('assets.canvasMode')}
          </button>
        </div>
        <DocumentCard title={t('assets.docTitle')} file={entry} busy={null} onSave={onSaveFile} />
      </div>
    );
  }

  return (
    <div className="assets-workflow">
      <div className="assets-workflow__bar">
        <span className="assets-workflow__hint">{t('assets.workflowHint')}</span>
        <button type="button" className="assets-btn" onClick={() => setMode('text')}>
          {t('assets.textMode')}
        </button>
      </div>
      <div className="assets-workflow__canvas">
        <WorkflowEditorCore
          key={`asset:${selectionRef}:${entry.name}`}
          docKey={`asset:${selectionRef}:${entry.name}`}
          fileLabel={`${selectionRef}/${entry.name}`}
          fallbackName={asset.id}
          sourceKey={`asset:${selectionRef}:${entry.name}:${entry.content}`}
          loadText={loadText}
          saveText={saveText}
          roleOptions={roleOptions}
        />
      </div>
    </div>
  );
}

// --- advanced raw files (escape hatch) ---------------------------------------

function AdvancedRawFiles({
  files,
  busy,
  onSave,
}: {
  files: AssetFile[];
  busy: string | null;
  onSave: (name: string, content: string) => Promise<boolean>;
}) {
  const t = useT();
  const [active, setActive] = useState<string | null>(null);
  const activeFile = files.find((file) => file.name === active) ?? null;

  return (
    <details className="assets-advanced">
      <summary>{t('assets.advanced')}</summary>
      <div className="assets-advanced__body">
        <div className="assets-advanced__tabs">
          {files.map((file) => (
            <button
              key={file.name}
              type="button"
              className={`assets-advanced__tab${file.name === active ? ' is-active' : ''}`}
              onClick={() => setActive(file.name)}
            >
              {file.name}
            </button>
          ))}
        </div>
        {activeFile ? (
          <DocumentCard title={activeFile.name} file={activeFile} busy={busy} onSave={onSave} />
        ) : (
          <p className="assets-panel__hint">{t('assets.advancedHint')}</p>
        )}
      </div>
    </details>
  );
}
