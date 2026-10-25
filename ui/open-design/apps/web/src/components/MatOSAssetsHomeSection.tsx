// Home showcase for the MatOS asset registry.
//
// Replaces the upstream Community/template gallery *content* while keeping
// its visual language: the `plugins-home` section shell and the gallery
// tile (window bar + preview frame + hover actions) are reused class-for-
// class. Instead of one flat template grid, assets render as one clearly
// separated group per asset type — workflows, skills, tools & MCP,
// knowledge, roles — each with its own labeled header, count, and a
// "view all" jump into the Assets workbench tab (/assets/<type>).
//
// Tiles are type-aware: workflow cards draw the asset's real DAG as an SVG
// mini flowchart (skeletons batched from `/api/matos/workflow-previews`),
// and every card carries the shared per-type accent, dependency preview
// rows, id breadcrumbs, and a watermark glyph so sparse manifests still
// read as designed surfaces rather than empty frames.
//
// This is a MatOS product surface and therefore fails closed. A registry
// failure or empty scope must never reveal the upstream Open Design gallery.

import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { navigate } from '../router';
import { Icon, type IconName } from './Icon';
import { assetAccentStyle, assetTypeMeta } from './asset-type-meta';
import { WorkflowAssetCard, compareWorkflowAssets, useWorkflowPreviews } from './WorkflowAssetCard';
import {
  fetchMatOSAssets,
  getCachedMatOSAssets,
  matOSAssetSelectionRef,
  type MatOSAssetSummary,
} from '../runtime/matos-assets';

type AssetSummary = MatOSAssetSummary;

// Released families only — benchmark/evaluation and runtime assets are
// staged out of the user-facing catalog for now (mirrors the daemon
// bridge's default type list and the Assets workbench tabs).
const GROUPS: Array<{ id: string; types: string[]; icon: IconName }> = [
  { id: 'workflow', types: ['workflow'], icon: 'fork' },
  { id: 'skill', types: ['skill'], icon: 'sparkles' },
  { id: 'tool', types: ['tool', 'mcp'], icon: 'hammer' },
  { id: 'knowledge', types: ['knowledge'], icon: 'file-text' },
  { id: 'data', types: ['data'], icon: 'database' },
  { id: 'role', types: ['role'], icon: 'puzzle' },
];

const GROUP_TILE_LIMIT = 6;
const TILE_DEP_LIMIT = 3;
const TILE_TAG_LIMIT = 3;

export function MatOSAssetsHomeSection() {
  const t = useT();
  const [assets, setAssets] = useState<AssetSummary[] | null | undefined>(getCachedMatOSAssets());
  const { previews, refreshPreviews } = useWorkflowPreviews();

  useEffect(() => {
    let alive = true;
    void fetchMatOSAssets()
      .then((result) => {
        if (alive) setAssets(result);
      })
      .catch(() => {
        if (alive) setAssets(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => {
    if (!assets) return [];
    return GROUPS.map((group) => {
      const items = assets
        .filter((asset) => group.types.includes(asset.type))
        .sort((a, b) => {
          if (group.id === 'workflow') return compareWorkflowAssets(a, b, previews);
          // The generated TOS archive units (hundreds of `mb-*` data assets)
          // would alphabetically flood the data showcase tiles; keep curated
          // assets and the archive index assets first, archive units last.
          const aArchive = a.tags.includes('material-bench') && a.id.startsWith('mb-') ? 1 : 0;
          const bArchive = b.tags.includes('material-bench') && b.id.startsWith('mb-') ? 1 : 0;
          return aArchive - bArchive || a.id.localeCompare(b.id);
        });
      return { ...group, total: items.length, items: items.slice(0, GROUP_TILE_LIMIT) };
    }).filter((group) => group.total > 0);
  }, [assets, previews]);

  if (assets === undefined) {
    // Probe in flight: keep the section shell stable to avoid a flash of the
    // community gallery before the MatOS registry answers.
    return (
      <section className="plugins-home" data-testid="matos-assets-home">
        <header className="plugins-home__head">
          <div className="plugins-home__heading">
            <h2 className="plugins-home__title">{t('assetsHome.title')}</h2>
          </div>
        </header>
        <div className="plugins-home__empty">{t('assets.loading')}</div>
      </section>
    );
  }

  if (assets === null || groups.length === 0) {
    return (
      <section className="plugins-home matos-assets-home" data-testid="matos-assets-home">
        <header className="plugins-home__head">
          <div className="plugins-home__heading">
            <h2 className="plugins-home__title">{t('assetsHome.title')}</h2>
          </div>
          <div className="plugins-home__head-tools">
            <button
              type="button"
              className="plugins-home__linkbtn"
              onClick={() => navigate({ kind: 'home', view: 'assets' })}
              data-testid="matos-assets-home-workbench"
            >
              {t('assetsHome.openWorkbench')}
            </button>
          </div>
        </header>
        <div className="plugins-home__empty">{t('assets.empty')}</div>
      </section>
    );
  }

  return (
    <section className="plugins-home matos-assets-home" data-testid="matos-assets-home">
      <header className="plugins-home__head">
        <div className="plugins-home__heading">
          <h2 className="plugins-home__title">{t('assetsHome.title')}</h2>
          <p className="plugins-home__subtitle">{t('assetsHome.subtitle')}</p>
        </div>
        <div className="plugins-home__head-tools">
          <button
            type="button"
            className="plugins-home__linkbtn"
            onClick={() => navigate({ kind: 'home', view: 'assets' })}
            data-testid="matos-assets-home-workbench"
          >
            {t('assetsHome.openWorkbench')}
          </button>
        </div>
      </header>

      {groups.map((group) => (
        <div key={group.id} className="matos-assets-home__group" data-asset-group={group.id}>
          <div
            className="matos-assets-home__group-head"
            style={assetAccentStyle(group.id)}
          >
            <span className="matos-assets-home__group-icon" data-asset-type={group.id}>
              <Icon name={group.icon} size={14} />
            </span>
            <h3 className="matos-assets-home__group-title">
              {t(`assets.tab.${group.id}` as never)}
            </h3>
            <span className="matos-assets-home__group-count">{group.total}</span>
            {group.id !== 'workflow' ? <span className="matos-assets-home__group-hint">
              {t(`assets.tabHint.${group.id}` as never)}
            </span> : null}
            {group.id === 'workflow' && previews === null ? <button type="button" className="assets-btn"
              title={t('library.refresh')} aria-label={t('library.refresh')} onClick={refreshPreviews}>
              <Icon name="refresh" size={14} />
            </button> : null}
            <button
              type="button"
              className="plugins-home__linkbtn matos-assets-home__group-all"
              onClick={() =>
                navigate({ kind: 'home', view: 'assets', assetRef: group.id })
              }
              data-testid={`matos-assets-home-all-${group.id}`}
            >
              {t('assetsHome.viewAll')}
            </button>
          </div>
          <div className="plugins-home__grid plugins-home__grid--gallery" role="list">
            {group.items.map((asset) => asset.type === 'workflow' ? (
              <WorkflowAssetCard key={matOSAssetSelectionRef(asset)} asset={asset} previews={previews} />
            ) : (
              <AssetGalleryTile
                key={asset.ref}
                asset={asset}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** `skill:2d-materials/band-edges` → `['2d-materials', 'band-edges']`. */
function idSegments(asset: AssetSummary): string[] {
  return asset.id.split('/').filter(Boolean);
}

function parseDependencyRef(ref: string): { type: string; id: string } {
  const colon = ref.indexOf(':');
  const rest = colon >= 0 ? ref.slice(colon + 1) : ref;
  return {
    type: colon >= 0 ? ref.slice(0, colon) : 'asset',
    id: rest.replace(/@[^@]*$/, ''),
  };
}

function AssetGalleryTile({
  asset,
}: {
  asset: AssetSummary;
}) {
  const t = useT();
  const meta = assetTypeMeta(asset.type);
  const open = () => navigate({ kind: 'home', view: 'assets', assetRef: asset.ref });
  const deps = asset.dependencies ?? [];
  const tags = asset.tags ?? [];
  const description = asset.description?.trim() ?? '';
  const segments = idSegments(asset);

  return (
    <article
      role="listitem"
      className="plugins-home__card plugins-home__card--gallery matos-assets-home__card"
      data-asset-type={asset.type}
      style={assetAccentStyle(asset.type)}
      onClick={open}
    >
      <div className="plugins-home__gallery-bar">
        <span className="plugins-home__gallery-dot" aria-hidden />
        <button
          type="button"
          className="plugins-home__gallery-name"
          title={asset.name}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          data-testid={`matos-assets-home-open-${asset.ref}`}
        >
          {asset.name}
        </button>
        {asset.version ? (
          <span className="matos-assets-home__tile-version">v{asset.version}</span>
        ) : null}
      </div>
      <div
        className="plugins-home__gallery-frame matos-assets-home__frame"
        data-asset-type={asset.type}
      >
          <StandardTileBody
            asset={asset}
            meta={{ icon: meta.icon }}
            description={description}
            segments={segments}
            deps={deps}
            tags={tags}
          />
        <div className="plugins-home__gallery-actions">
          <button
            type="button"
            className="plugins-home__action plugins-home__action--primary"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            <Icon name="external-link" size={12} />
            <span>{t('assetsHome.open')}</span>
          </button>
        </div>
      </div>
    </article>
  );
}

/** Non-workflow asset tiles. */
function StandardTileBody({
  asset,
  meta,
  description,
  segments,
  deps,
  tags,
}: {
  asset: AssetSummary;
  meta: { icon: IconName };
  description: string;
  segments: string[];
  deps: string[];
  tags: string[];
}) {
  const t = useT();
  const runtime = asset.runtime;
  const runtimeChips: string[] = [];
  if (runtime?.model) runtimeChips.push(runtime.model);
  if (runtime?.effort) runtimeChips.push(runtime.effort);
  if (runtime?.maxTurns) runtimeChips.push(`≤${runtime.maxTurns}`);

  // Leaf assets (many skills) carry no description, deps, or runtime — just
  // an id + tags. Center the identity block and enlarge the watermark so
  // they read as a designed cover rather than a top-aligned sparse frame.
  const sparse =
    !description && deps.length === 0 && runtimeChips.length === 0;

  return (
    <div
      className={`matos-assets-home__tile-body${sparse ? ' matos-assets-home__tile-body--sparse' : ''}`}
    >
      <span className="matos-assets-home__tile-art" aria-hidden>
        <Icon name={meta.icon} size={sparse ? 168 : 128} strokeWidth={1} />
      </span>
      <div className="matos-assets-home__tile-top">
        <span className="matos-assets-home__tile-icon" data-asset-type={asset.type}>
          <Icon name={meta.icon} size={20} />
        </span>
        <span className="matos-assets-home__tile-type">{asset.type}</span>
        {asset.git.scope ? (
          <span className="matos-assets-home__tile-scope">{asset.git.scope}</span>
        ) : null}
      </div>

      {description ? (
        <p className="matos-assets-home__tile-desc">{description}</p>
      ) : (
        <div className="matos-assets-home__tile-crumbs" title={asset.id}>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="matos-assets-home__tile-crumb-step">
              {index > 0 ? (
                <Icon name="chevron-right" size={10} aria-hidden />
              ) : null}
              <span className="matos-assets-home__tile-crumb">{segment}</span>
            </span>
          ))}
        </div>
      )}

      {runtimeChips.length > 0 ? (
        <div className="matos-assets-home__tile-runtime">
          <Icon name="sliders" size={11} aria-hidden />
          {runtimeChips.map((chip) => (
            <span key={chip} className="matos-assets-home__tile-runtime-chip">
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      {deps.length > 0 ? (
        <div className="matos-assets-home__tile-deps">
          <span className="matos-assets-home__tile-deps-label">
            {t('assetsHome.deps')}
            <span className="matos-assets-home__tile-deps-count">{deps.length}</span>
          </span>
          <ul className="matos-assets-home__dep-list">
            {deps.slice(0, TILE_DEP_LIMIT).map((dep) => {
              const parsed = parseDependencyRef(dep);
              const depMeta = assetTypeMeta(parsed.type);
              return (
                <li
                  key={dep}
                  className="matos-assets-home__dep"
                  style={assetAccentStyle(parsed.type)}
                  title={dep}
                >
                  <span className="matos-assets-home__dep-icon">
                    <Icon name={depMeta.icon} size={11} />
                  </span>
                  <span className="matos-assets-home__dep-id">{parsed.id}</span>
                  <span className="matos-assets-home__dep-type">{parsed.type}</span>
                </li>
              );
            })}
          </ul>
          {deps.length > TILE_DEP_LIMIT ? (
            <span className="matos-assets-home__dep-more">
              +{deps.length - TILE_DEP_LIMIT}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="matos-assets-home__tile-meta">
        {asset.entry ? (
          <span className="matos-assets-home__tile-entry">
            <Icon name="file-code" size={10} aria-hidden />
            {asset.entry}
          </span>
        ) : null}
        <TagRow tags={tags} />
      </div>
    </div>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.slice(0, TILE_TAG_LIMIT).map((tag) => (
        <span key={tag} className="matos-assets-home__tile-tag">
          {tag}
        </span>
      ))}
      {tags.length > TILE_TAG_LIMIT ? (
        <span className="matos-assets-home__tile-tag matos-assets-home__tile-tag--more">
          +{tags.length - TILE_TAG_LIMIT}
        </span>
      ) : null}
    </>
  );
}
