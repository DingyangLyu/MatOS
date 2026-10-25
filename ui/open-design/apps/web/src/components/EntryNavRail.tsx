// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand logo,
// followed by the primary destinations users expect to keep in reach:
// New project, home, projects, brand kit, automations, and
// integrations. Footer controls are reserved for lower-frequency
// support affordances such as the product-feedback destination.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useT } from '../i18n';
import type { EntryHomeView } from '../router';
import { fetchEvolutionOverview } from './matos-evolution-client';
import {
  createMatOSAssetProject,
  type MatOSAssetProjectType,
} from '../matos-asset-projects';

// MatOS create menu: the "+" offers every native creatable — a project
// plus the asset families (knowledge / skill / tool / role / workflow /
// data). Picking an asset type spawns an asset-editing project: agent
// chat on the left, the seeded asset file as the live editable artifact
// on the right (workflows open on the canvas). The project persists in
// the project list, so the draft and its conversation stay reopenable.
const CREATE_ASSET_ITEMS: Array<{ id: MatOSAssetProjectType; icon: IconName }> = [
  { id: 'knowledge', icon: 'file-text' },
  { id: 'skill', icon: 'sparkles' },
  { id: 'tool', icon: 'hammer' },
  { id: 'role', icon: 'puzzle' },
  { id: 'workflow', icon: 'fork' },
  { id: 'data', icon: 'layers-filled' },
];

export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Collapse the rail — called after a destination is chosen or the user dismisses it. */
  onClose: () => void;
  /**
   * Phone top-bar mode only: EntryShell moves the settings gear (the
   * `EntrySettingsMenu` that lives in the sticky topbar on desktop) into the
   * rail footer. Undefined on desktop/tablet. Product feedback remains a
   * first-class destination on every viewport.
   */
  settingsSlot?: ReactNode;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, tooltip, onClick, disabled, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </button>
  );
}

const EVOLUTION_PENDING_POLL_MS = 60_000;

// Edits parked under the manual approval mode need a human; the rail marks
// the Evolution destination while any wait.
function usePendingEvolutionProposals(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchEvolutionOverview()
        .then((overview) => {
          if (!cancelled) setCount(overview.proposals.length);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, EVOLUTION_PENDING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return count;
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  newProjectDisabled = false,
  open,
  onClose,
  settingsSlot,
}: Props) {
  const t = useT();
  const pendingEvolutionProposals = usePendingEvolutionProposals();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';
  const [createOpen, setCreateOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!createOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (createMenuRef.current?.contains(event.target as Node)) return;
      setCreateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreateOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [createOpen]);

  // Once opened the rail stays docked (Manus-style); navigating between
  // destinations no longer collapses it.
  const selectView = (next: EntryView) => {
    onViewChange(next);
  };

  // Release notes and activity history live in the footer on wide screens
  // and at the end of the scrolling strip on phones. CSS displays one copy.
  const renderSecondaryDestinations = (idSuffix: '' | '-phone') => (
    <>
      <NavButton
        active={view === 'blog'}
        ariaLabel={t('entry.helpWhatsNew')}
        tooltip={t('entry.helpWhatsNew')}
        onClick={() => selectView('blog')}
        testId={`entry-nav-blog${idSuffix}`}
      >
        <Icon name="book-open" size={18} />
      </NavButton>
      <NavButton
        active={view === 'profile'}
        ariaLabel={t('entry.navProfile')}
        tooltip={t('entry.navProfile')}
        onClick={() => selectView('profile')}
        testId={`entry-nav-profile${idSuffix}`}
      >
        <Icon name="history" size={18} />
      </NavButton>
    </>
  );

  // While collapsed the rail is visually hidden but its logo + nav buttons
  // stay mounted. Mark the whole rail `inert` so those controls leave the
  // keyboard tab order and pointer flow entirely — otherwise a fresh Tab on
  // the home screen would land on invisible rail controls before the visible
  // toggle/hero. `inert` is set imperatively to stay compatible across React
  // versions whose JSX types don't yet declare the attribute.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  // Short windows (768p laptops, non-maximized windows, landscape tablets)
  // cannot fit every destination, and the rail column does not scroll with
  // the page — the bottom icons and the whole footer used to sit below the
  // fold, unreachable. When the rail's content genuinely overflows its box,
  // `entry-nav-rail--overflow` turns the destination list into a vertical
  // scroll container (see entry-layout.css) while brand, "+", and footer stay
  // pinned. Measured with a ResizeObserver instead of a viewport-height media
  // query: a hardcoded threshold silently rots every time a destination is
  // added — which is exactly how the rail outgrew short screens unnoticed.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const nav = railRef.current;
    if (!nav) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      setOverflowing((current) => {
        if (current) {
          // In overflow mode the nav no longer overflows (the scroller eats
          // the excess), so the scroller itself is the source of truth.
          const scroller = scrollRef.current;
          if (!scroller) return false;
          // Hysteresis: leave overflow mode only with ~12px of real slack.
          // The two modes lay out a few pixels apart, so exiting at the
          // exact boundary re-enters on the very next observer tick — an
          // infinite enter/exit loop that re-renders every frame and reads
          // as a janky, "infinitely refreshing" rail on windows whose height
          // lands in that band. Inside the band we simply stay in overflow
          // mode, where a fitting list scrolls by zero and looks identical.
          return scroller.scrollHeight > scroller.clientHeight - 12;
        }
        return nav.scrollHeight > nav.clientHeight + 1;
      });
    };
    // Coalesce observer bursts into one post-layout measurement per frame;
    // synchronous setState inside the ResizeObserver callback forces layout
    // and can starve the observer's own delivery loop.
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(nav);
    // The group resizes when destinations mount/unmount (support links,
    // feature-flagged entries, phone settings slot) even if the nav box
    // does not, so observe it too.
    const group = nav.querySelector('.entry-nav-rail__group');
    if (group) observer.observe(group);
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}${overflowing ? ' entry-nav-rail--overflow' : ''}`}
      aria-label="Primary"
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__group">
        <div className="entry-nav-rail__brand">
          <button
            type="button"
            className="entry-nav-rail__logo"
            onClick={() => selectView('home')}
            aria-label={brandLabel}
            data-testid="entry-nav-logo"
          >
            <img
              src="/app-icon.svg"
              alt=""
              className="entry-nav-rail__logo-img"
              draggable={false}
            />
          </button>
          <button
            type="button"
            className="entry-nav-rail__collapse"
            onClick={onClose}
            aria-label={t('entry.navCollapse')}
            title={t('entry.navCollapse')}
            data-testid="entry-nav-collapse"
          >
            <Icon name="panel-left" size={20} />
          </button>
        </div>
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />
        <div className="entry-nav-rail__create" ref={createMenuRef}>
          <NavButton
            active={createOpen}
            ariaLabel={t('createMenu.aria')}
            tooltip={t('createMenu.aria')}
            onClick={() => setCreateOpen((current) => !current)}
            disabled={newProjectDisabled}
            testId="entry-nav-new-project"
          >
            <Icon name="plus" size={18} />
          </NavButton>
          {createOpen ? (
            <div className="create-menu" role="menu" aria-label={t('createMenu.aria')}>
              <button
                type="button"
                role="menuitem"
                className="create-menu__item"
                onClick={() => {
                  setCreateOpen(false);
                  onNewProject();
                }}
                data-testid="create-menu-project"
              >
                <span className="create-menu__icon"><Icon name="folder" size={15} /></span>
                <span className="create-menu__text">
                  <strong>{t('createMenu.project')}</strong>
                  <em>{t('createMenu.projectHint')}</em>
                </span>
              </button>
              <div className="create-menu__divider" role="separator" />
              {CREATE_ASSET_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="create-menu__item"
                  onClick={() => {
                    setCreateOpen(false);
                    void createMatOSAssetProject(item.id, t);
                  }}
                  data-testid={`create-menu-${item.id}`}
                >
                  <span className="create-menu__icon"><Icon name={item.icon} size={15} /></span>
                  <span className="create-menu__text">
                    <strong>{t(`createMenu.${item.id}` as never)}</strong>
                    <em>{t(`createMenu.${item.id}Hint` as never)}</em>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* Destination list. The wrapper is `display: contents` (layout
            no-op) until the rail genuinely overflows its box, when it becomes
            the vertical scroll container between the pinned brand/create slot
            above and the pinned footer below — otherwise 15+ destinations
            overflow short windows with no way to reach the bottom icons. */}
        <div className="entry-nav-rail__scroll" ref={scrollRef}>
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          tooltip={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={18} />
        </NavButton>
        <NavButton
          active={view === 'projects'}
          ariaLabel={t('entry.navProjects')}
          tooltip={t('entry.navProjects')}
          onClick={() => selectView('projects')}
          testId="entry-nav-projects"
        >
          <Icon name="folder" size={18} />
        </NavButton>
        {/* Legacy library and repository-mirror routes stay accessible by direct link; the public navigation focuses on local research. */}
        <NavButton
          active={view === 'assets'}
          ariaLabel={t('entry.navAssets')}
          tooltip={t('entry.navAssets')}
          onClick={() => selectView('assets')}
          testId="entry-nav-assets"
        >
          <Icon name="blocks" size={18} />
        </NavButton>
        <NavButton
          active={view === 'evolution'}
          ariaLabel={
            pendingEvolutionProposals > 0
              ? `${t('evolutionPage.nav')} · ${t('evolutionPage.pendingBadge', { count: pendingEvolutionProposals })}`
              : t('evolutionPage.nav')
          }
          tooltip={t('evolutionPage.nav')}
          onClick={() => selectView('evolution')}
          testId="entry-nav-evolution"
        >
          <Icon name="fork" size={18} />
          {pendingEvolutionProposals > 0 ? <span className="entry-nav-badge-dot" aria-hidden="true" /> : null}
        </NavButton>
        <NavButton
          active={view === 'tasks'}
          ariaLabel={t('entry.navTasks')}
          tooltip={t('entry.navTasks')}
          onClick={() => selectView('tasks')}
          testId="entry-nav-tasks"
        >
          <Icon name="kanban" size={18} />
        </NavButton>
        <NavButton
          active={view === 'workflows'}
          ariaLabel={t('workflow.studio')}
          tooltip={t('workflow.studio')}
          onClick={() => selectView('workflows')}
          testId="entry-nav-workflows"
        >
          <Icon name="workflow" size={18} />
        </NavButton>
        <NavButton
          active={view === 'ops'}
          ariaLabel={t('entry.navOps')}
          tooltip={t('entry.navOps')}
          onClick={() => selectView('ops')}
          testId="entry-nav-ops"
        >
          <Icon name="gauge" size={18} />
        </NavButton>
        {/* Schedules remain accessible through its direct route. */}
        <NavButton
          active={view === 'integrations'}
          ariaLabel={t('entry.navIntegrations')}
          tooltip={t('entry.navIntegrations')}
          onClick={() => selectView('integrations')}
          testId="entry-nav-integrations"
        >
          <Icon name="link" size={18} />
        </NavButton>
        {/* Phone-only copy of the secondary footer destinations — see the
            comment on renderSecondaryDestinations. display:none above 640px. */}
        <div className="entry-nav-rail__phone-tail">
          {renderSecondaryDestinations('-phone')}
        </div>
        </div>
      </div>
      <div className="entry-nav-rail__footer">
        <div className="entry-nav-rail__divider" role="separator" />
        {/* display:contents on desktop/tablet; display:none on phones where
            the copies above live in the scrollable strip instead. */}
        <div className="entry-nav-rail__footer-secondary">
          {renderSecondaryDestinations('')}
        </div>
        <NavButton
          active={view === 'feedback'}
          ariaLabel={t('entry.navFeedback')}
          tooltip={t('entry.navFeedback')}
          onClick={() => {
            try {
              if (window.location.pathname !== '/feedback') {
                window.sessionStorage.setItem('matos.feedback.sourcePath', window.location.pathname);
              }
            } catch {
              /* storage can be disabled */
            }
            selectView('feedback');
          }}
          testId="entry-nav-feedback"
        >
          <Icon name="comment" size={18} />
        </NavButton>
        {settingsSlot}
      </div>
    </nav>
  );
}
