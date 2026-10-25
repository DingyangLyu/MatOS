import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  McpServerConfig,
  SkillSummary,
} from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import type { Locale } from '../i18n/types';
import {
  localizeSkillDescription,
  localizeSkillName,
} from '../i18n/content';
import { resolveFlyoutSide } from './composer-flyout-placement';
import { Icon, type IconName } from './Icon';

const PLUS_MENU_MARGIN = 12;
const PLUS_MENU_GAP = 8;
const PLUS_MENU_WIDTH = 208;
const PLUS_MENU_FLYOUT_WIDTH = 260;
const PLUS_MENU_SKILL_FLYOUT_WIDTH = 430;
const PLUS_MENU_TOOLBOX_FLYOUT_WIDTH = 320;
const PLUS_MENU_PREFERRED_MIN_HEIGHT = 180;
const PLUS_MENU_FLYOUT_MAX_HEIGHT = 320;
export type PlusMenuPlacementPreference = 'auto' | 'down' | 'up';
type PlusMenuFlyoutPlacement = 'right' | 'left' | 'contained';
type PlusMenuFlyoutVerticalPlacement = 'down' | 'up';
export type PlusMenuSubmenu = 'skills' | 'mcp' | 'toolbox';

type PlusMenuPopupStyle = CSSProperties & Record<'--plus-menu-flyout-max-height', string>;

function getFlyoutBoundary(anchor: HTMLElement): Pick<DOMRect, 'left' | 'right'> {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportBounds = { left: PLUS_MENU_MARGIN, right: viewportWidth - PLUS_MENU_MARGIN };
  const boundary = anchor.closest('.split-chat-slot, .pane');
  if (!boundary) return viewportBounds;

  const rect = boundary.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) || rect.right <= rect.left) {
    return viewportBounds;
  }

  return {
    left: Math.max(PLUS_MENU_MARGIN, rect.left),
    right: Math.min(viewportWidth - PLUS_MENU_MARGIN, rect.right),
  };
}

function getPlusMenuStyle(
  anchor: HTMLElement,
  placementPreference: PlusMenuPlacementPreference,
): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || PLUS_MENU_WIDTH;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 640;
  const width = Math.min(PLUS_MENU_WIDTH, Math.max(0, viewportWidth - PLUS_MENU_MARGIN * 2));
  const left = Math.min(
    Math.max(PLUS_MENU_MARGIN, rect.left),
    Math.max(PLUS_MENU_MARGIN, viewportWidth - PLUS_MENU_MARGIN - width),
  );
  const spaceAbove = rect.top - PLUS_MENU_MARGIN - PLUS_MENU_GAP;
  const spaceBelow = viewportHeight - rect.bottom - PLUS_MENU_MARGIN - PLUS_MENU_GAP;

  const upStyle = {
    left,
    top: 'auto',
    bottom: Math.max(PLUS_MENU_MARGIN, viewportHeight - rect.top + PLUS_MENU_GAP),
    width,
    maxHeight: Math.max(0, spaceAbove),
  } satisfies CSSProperties;
  const downStyle = {
    left,
    top: Math.max(PLUS_MENU_MARGIN, rect.bottom + PLUS_MENU_GAP),
    bottom: 'auto',
    width,
    maxHeight: Math.max(0, spaceBelow),
  } satisfies CSSProperties;

  if (placementPreference === 'down') {
    return downStyle;
  }
  if (placementPreference === 'up') {
    return upStyle;
  }

  if (spaceAbove >= PLUS_MENU_PREFERRED_MIN_HEIGHT || spaceAbove >= spaceBelow) {
    return {
      ...upStyle,
    };
  }

  return {
    ...downStyle,
  };
}

function getFlyoutPlacement(
  anchor: HTMLElement,
  flyoutWidth: number = PLUS_MENU_FLYOUT_WIDTH,
): PlusMenuFlyoutPlacement {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const boundary = getFlyoutBoundary(anchor);
  const menuWidth = Math.min(PLUS_MENU_WIDTH, Math.max(0, viewportWidth - PLUS_MENU_MARGIN * 2));
  const menuLeft = Math.min(
    Math.max(PLUS_MENU_MARGIN, rect.left),
    Math.max(PLUS_MENU_MARGIN, viewportWidth - PLUS_MENU_MARGIN - menuWidth),
  );
  return resolveFlyoutSide({
    menuLeft,
    menuWidth,
    flyoutWidth,
    gap: PLUS_MENU_GAP,
    boundaryLeft: boundary.left,
    boundaryRight: boundary.right,
  });
}

function getFlyoutWidth(submenu: PlusMenuSubmenu | null): number {
  if (submenu === 'skills') return PLUS_MENU_SKILL_FLYOUT_WIDTH;
  if (submenu === 'toolbox') return PLUS_MENU_TOOLBOX_FLYOUT_WIDTH;
  return PLUS_MENU_FLYOUT_WIDTH;
}

export interface ComposerPlusMenuProps {
  /** Enabled MCP servers shown under the "MCP" submenu. */
  mcpServers: McpServerConfig[];
  onPickMcp: (server: McpServerConfig) => void;
  /** Opens MCP settings; omit to hide the add row. */
  onAddMcp?: () => void;

  /** Available skills shown under the "Skills" submenu. */
  skills?: SkillSummary[];
  onPickSkill?: (skill: SkillSummary) => void;

  /** Triggers file attachment (opens the native picker). */
  onAttachFiles: () => void;
  attachLoading?: boolean;

  /** Opens the reference-project picker. */
  onReferenceProject?: () => void;

  /** Opens a native folder picker and stages the folder as local code context. */
  onLinkLocalCode?: () => void;


  /**
   * Optional "Design toolbox" row, rendered LAST. Only the project composer
   * passes this; the home composer omits it. The returned node is shown in a
   * right-side flyout reusing the same submenu styling.
   */
  renderToolbox?: (close: () => void) => ReactNode;
  toolboxLabel?: string;

  /** Test id for the trigger button. */
  triggerTestId?: string;

  /**
   * Notified when the menu opens. The project composer uses this to latch its
   * lazy MCP fetch, so the MCP submenu isn't empty when the "+" menu is the
   * first thing clicked on a cold composer.
   */
  onOpen?: () => void;


  /**
   * Notified once per submenu-open session when the user starts typing in
   * that flyout's search box. Carries which list was searched, never the
   * query text.
   */

  /**
   * Home opens below the trigger like Claude Design's project picker, while
   * the bottom project composer opens upward so it stays attached to the chat
   * bar. `auto` preserves the older viewport-driven fallback for tests and
   * any future neutral surface.
   */
  placementPreference?: PlusMenuPlacementPreference;
}

function mcpMatches(server: McpServerConfig, needle: string): boolean {
  if (!needle) return true;
  return `${server.label ?? ''} ${server.id}`.toLowerCase().includes(needle);
}

function menuSkillMatches(
  skill: SkillSummary,
  needle: string,
  localizedName: string,
  localizedDescription: string,
): boolean {
  if (!needle) return true;
  return [
    localizedName,
    localizedDescription,
    skill.id,
    skill.name,
    skill.description,
    skill.mode,
    skill.category ?? '',
    ...(skill.triggers ?? []),
  ].join(' ').toLowerCase().includes(needle);
}

/**
 * The composer "+" menu shared between the home hero and the project chat
 * composer. Owns its own open / submenu / search state; callers supply the
 * data lists and pick/add handlers. Pass `renderToolbox` to append the
 * project-only design-toolbox row.
 */
export function ComposerPlusMenu({
  skills = [],
  onPickSkill,
  mcpServers,
  onPickMcp,
  onAddMcp,
  onAttachFiles,
  attachLoading,
  onReferenceProject,
  onLinkLocalCode,
  renderToolbox,
  toolboxLabel,
  triggerTestId,
  onOpen,
  placementPreference = 'auto',
}: ComposerPlusMenuProps) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<PlusMenuSubmenu | null>(null);
  const [query, setQuery] = useState('');
  const [hoveredSkillId, setHoveredSkillId] = useState<string | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [flyoutPlacement, setFlyoutPlacement] = useState<PlusMenuFlyoutPlacement>('right');
  const [flyoutVerticalPlacement, setFlyoutVerticalPlacement] = useState<PlusMenuFlyoutVerticalPlacement>('down');
  const [flyoutMaxHeight, setFlyoutMaxHeight] = useState(PLUS_MENU_FLYOUT_MAX_HEIGHT);
  const [flyoutStyle, setFlyoutStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The skill and MCP flyouts share one `query`, but it is scoped to whichever
  // submenu is open. Reset it whenever the active submenu changes so a stale
  // skill search never filters the MCP list — which would otherwise show the
  // empty state even when servers exist.
  useEffect(() => {
    setQuery('');
    setHoveredSkillId(null);
  }, [submenu]);

  useEffect(() => () => {
    if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
  }, []);

  // Hover intent: side flyouts have a small visual gap from the parent row, so
  // closing immediately on row mouseleave makes diagonal cursor movement feel
  // broken. Defer close briefly; entering the flyout cancels the pending close.
  function cancelSubmenuClose() {
    if (submenuCloseTimer.current) {
      clearTimeout(submenuCloseTimer.current);
      submenuCloseTimer.current = null;
    }
  }

  function scheduleCloseSubmenu() {
    cancelSubmenuClose();
    submenuCloseTimer.current = setTimeout(() => {
      submenuCloseTimer.current = null;
      // Typing into a flyout's search box narrows its list, which reflows rows
      // out from under a stationary cursor — the browser then synthesizes a
      // `mouseleave` on the flyout even though the pointer never moved. Honoring
      // that close would yank the search box (and its preview column) away
      // mid-search, making the resource impossible to pick. Keep the submenu open
      // while its own search input still owns focus; the outside-click / Escape
      // handlers remain the deliberate ways to dismiss it.
      const active = document.activeElement;
      if (active && popupRef.current?.contains(active) && active.tagName === 'INPUT') {
        return;
      }
      setSubmenu(null);
    }, 200);
  }

  function close() {
    cancelSubmenuClose();
    setOpen(false);
    setSubmenu(null);
  }

  function updateFlyoutGeometry(row: HTMLDivElement | null, nextSubmenu: PlusMenuSubmenu | null) {
    const anchor = triggerRef.current;
    const flyoutWidth = getFlyoutWidth(nextSubmenu);
    const placement = anchor ? getFlyoutPlacement(anchor, flyoutWidth) : 'right';
    setFlyoutPlacement(placement);

    if (!row) {
      setFlyoutVerticalPlacement('down');
      setFlyoutMaxHeight(PLUS_MENU_FLYOUT_MAX_HEIGHT);
      setFlyoutStyle(null);
      return;
    }
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 640;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const rowRect = row.getBoundingClientRect();
    const downSpace = viewportHeight - (rowRect.top - 5) - PLUS_MENU_MARGIN;
    const upSpace = rowRect.bottom + 5 - PLUS_MENU_MARGIN;
    const verticalPlacement =
      downSpace >= PLUS_MENU_FLYOUT_MAX_HEIGHT || downSpace >= upSpace ? 'down' : 'up';
    const maxHeight = Math.max(
      120,
      Math.min(
        PLUS_MENU_FLYOUT_MAX_HEIGHT,
        verticalPlacement === 'up' ? upSpace : downSpace,
      ),
    );
    setFlyoutVerticalPlacement(verticalPlacement);
    setFlyoutMaxHeight(maxHeight);

    if (placement === 'contained') {
      setFlyoutStyle(null);
      return;
    }

    const sideStyle =
      placement === 'left'
        ? {
            left: Math.max(
              PLUS_MENU_MARGIN,
              rowRect.left - PLUS_MENU_GAP - flyoutWidth,
            ),
          }
        : {
            left: Math.min(
              Math.max(PLUS_MENU_MARGIN, rowRect.right + PLUS_MENU_GAP),
              Math.max(PLUS_MENU_MARGIN, viewportWidth - PLUS_MENU_MARGIN - flyoutWidth),
            ),
          };
    const verticalStyle =
      verticalPlacement === 'up'
        ? {
            top: 'auto',
            bottom: Math.max(PLUS_MENU_MARGIN, viewportHeight - rowRect.bottom + 5),
          }
        : {
            top: Math.max(PLUS_MENU_MARGIN, rowRect.top - 5),
            bottom: 'auto',
          };

    setFlyoutStyle({
      ...sideStyle,
      ...verticalStyle,
      width: Math.min(flyoutWidth, Math.max(0, viewportWidth - PLUS_MENU_MARGIN * 2)),
      maxHeight,
    });
  }

  function openSubmenu(
    next: PlusMenuSubmenu,
    row: HTMLDivElement | null,
  ) {
    cancelSubmenuClose();
    updateFlyoutGeometry(row, next);
    setSubmenu(next);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (submenu) {
        setSubmenu(null);
        return;
      }
      close();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, submenu]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    const updateMenuPosition = () => {
      const anchor = triggerRef.current;
      if (!anchor) return;
      setMenuStyle(getPlusMenuStyle(anchor, placementPreference));
      const activeRow = popupRef.current?.querySelector<HTMLDivElement>('.plus-menu__submenu-row.is-open') ?? null;
      updateFlyoutGeometry(activeRow, submenu);
    };

    updateMenuPosition();
    const popup = popupRef.current;
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    popup?.addEventListener('scroll', updateMenuPosition);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      popup?.removeEventListener('scroll', updateMenuPosition);
    };
  }, [open, submenu, placementPreference]);

  const needle = query.trim().toLowerCase();
  const filteredSkills = needle
    ? skills.filter((skill) =>
        menuSkillMatches(
          skill,
          needle,
          localizeSkillName(locale, skill),
          localizeSkillDescription(locale, skill),
        ),
      )
    : skills;
  const filteredMcp = needle
    ? mcpServers.filter((s) => mcpMatches(s, needle))
    : mcpServers;
  const hoveredSkill = useMemo(() => {
    if (submenu !== 'skills' || filteredSkills.length === 0) return null;
    return (
      filteredSkills.find((skill) => skill.id === hoveredSkillId) ??
      filteredSkills[0]
    );
  }, [submenu, filteredSkills, hoveredSkillId]);
  const popupStyle = menuStyle
    ? ({
        ...menuStyle,
        '--plus-menu-flyout-max-height': `${flyoutMaxHeight}px`,
      } satisfies PlusMenuPopupStyle)
    : undefined;

  return (
    <div className="plus-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`icon-btn plus-menu__trigger od-tooltip${open ? ' is-active' : ''}`}
        data-testid={triggerTestId}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          onOpen?.();
          setOpen(true);
        }}
        title={t('homeHero.addMenu')}
        data-tooltip={t('homeHero.addMenu')}
        aria-label={t('homeHero.addMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="plus" size={16} />
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popupRef}
          className={`plus-menu__popup plus-menu__popup--flyout-${flyoutPlacement} plus-menu__popup--flyout-y-${flyoutVerticalPlacement}`}
          role="menu"
          style={popupStyle}
        >
          <PlusMenuGroup label={t('chat.plus.group.files')}>
          <button
            type="button"
            role="menuitem"
            className="plus-menu__item"
            data-testid="composer-plus-attach"
            disabled={attachLoading}
            onClick={() => {
              close();
              onAttachFiles();
            }}
          >
            <Icon
              name={attachLoading ? 'spinner' : 'attach'}
              size={14}
              className="plus-menu__item-icon"
            />
            <span>{t('chat.plus.attachFiles')}</span>
          </button>
          {onReferenceProject ? (
            <button
              type="button"
              role="menuitem"
              className="plus-menu__item"
              data-testid="composer-plus-reference-project"
              onClick={() => {
                close();
                onReferenceProject();
              }}
            >
              <Icon name="folder" size={14} className="plus-menu__item-icon" />
              <span>{t('chat.plus.referenceProject')}</span>
            </button>
          ) : null}
          </PlusMenuGroup>

          {onLinkLocalCode ? (
            <PlusMenuGroup label={t('chat.plus.group.code')}>
              <button
                type="button"
                role="menuitem"
                className="plus-menu__item"
                data-testid="composer-plus-local-code"
                onClick={() => {
                  close();
                  onLinkLocalCode();
                }}
              >
                <Icon name="folder" size={14} className="plus-menu__item-icon" />
                <span>{t('chat.plus.linkLocalCode')}</span>
              </button>
            </PlusMenuGroup>
          ) : null}

          <PlusMenuGroup label={t('chat.plus.group.other')} hideLabel>
          {onPickSkill ? (
            <PlusSubmenuRow
              label={t('settings.skills')}
              icon="sparkles"
              open={submenu === 'skills'}
              testId="composer-plus-skills"
              onOpen={(row) => openSubmenu('skills', row)}
              onClose={scheduleCloseSubmenu}
              flyoutStyle={flyoutStyle}
              flyoutClassName={
                filteredSkills.length > 0 ? 'plus-menu__flyout--skills' : undefined
              }
            >
              <div className="plus-menu__skill-pane">
                <div className="plus-menu__skill-main">
                  <div className="plus-menu__search">
                    <Icon name="search" size={13} />
                    <input
                      value={query}
                      onChange={(event) => handleQueryChange(event.target.value)}
                      placeholder={t('settings.skills')}
                      aria-label={t('settings.skills')}
                    />
                  </div>
                  <div className="plus-menu__list">
                    {filteredSkills.length === 0 ? (
                      <div className="plus-menu__empty">{t('examples.emptyNoSkills')}</div>
                    ) : (
                      filteredSkills.map((skill) => {
                        const label = localizeSkillName(locale, skill);
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            role="menuitem"
                            className={`plus-menu__item${
                              skill.id === hoveredSkill?.id ? ' is-previewed' : ''
                            }`}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setHoveredSkillId(skill.id)}
                            onFocus={() => setHoveredSkillId(skill.id)}
                            onClick={() => {
                              close();
                              onPickSkill(skill);
                            }}
                          >
                            <Icon name="sparkles" size={15} className="plus-menu__item-icon" />
                            <span>{label}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
                {hoveredSkill ? (
                  <ComposerSkillPreview skill={hoveredSkill} locale={locale} />
                ) : null}
              </div>
            </PlusSubmenuRow>
          ) : null}
          <PlusSubmenuRow
            label={t('chat.plus.mcp')}
            icon="link"
            open={submenu === 'mcp'}
            testId="composer-plus-mcp"
            onOpen={(row) => openSubmenu('mcp', row)}
            onClose={scheduleCloseSubmenu}
            flyoutStyle={flyoutStyle}
          >
            <div className="plus-menu__search">
              <Icon name="search" size={13} />
              <input
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                placeholder="MCP"
                aria-label="MCP"
              />
            </div>
            <div className="plus-menu__list">
              {filteredMcp.length === 0 ? (
                <div className="plus-menu__empty">{t('homeHero.noMcp')}</div>
              ) : (
                filteredMcp.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    role="menuitem"
                    className="plus-menu__item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      close();
                      onPickMcp(server);
                    }}
                  >
                    <Icon name="link" size={14} className="plus-menu__item-icon" />
                    <span>{server.label || server.id}</span>
                  </button>
                ))
              )}
            </div>
            {onAddMcp ? (
              <>
                <div className="plus-menu__divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="plus-menu__item"
                  onClick={() => {
                    close();
                    onAddMcp();
                  }}
                >
                  <Icon name="plus" size={14} className="plus-menu__item-icon" />
                  <span>{t('homeHero.addMcp')}</span>
                </button>
              </>
            ) : null}
          </PlusSubmenuRow>
          {renderToolbox ? (
            <PlusSubmenuRow
              label={toolboxLabel ?? t('chat.designToolbox.tooltip')}
              icon="lightbulb"
              open={submenu === 'toolbox'}
              onOpen={(row) => openSubmenu('toolbox', row)}
              onClose={scheduleCloseSubmenu}
              flyoutStyle={flyoutStyle}
            >
              {renderToolbox(close)}
            </PlusSubmenuRow>
          ) : null}
          </PlusMenuGroup>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function PlusMenuGroup({
  label,
  hideLabel = false,
  children,
}: {
  label: string;
  hideLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="plus-menu__group" role="group" aria-label={label}>
      {hideLabel ? null : <div className="plus-menu__group-label">{label}</div>}
      {children}
    </div>
  );
}

function ComposerSkillPreview({
  skill,
  locale,
}: {
  skill: SkillSummary;
  locale: Locale;
}) {
  const title = localizeSkillName(locale, skill);
  const description = localizeSkillDescription(locale, skill) || skill.description;
  const triggers = skill.triggers?.filter(Boolean) ?? [];
  return (
    <div className="plus-menu__preview plus-menu__skill-preview" aria-live="polite">
      <div className="plus-menu__preview-meta">
        <div className="plus-menu__preview-title-row">
          <span className="plus-menu__preview-title">{title}</span>
          <span className="plus-menu__preview-kind">{skill.mode}</span>
        </div>
        {description ? (
          <p className="plus-menu__preview-desc">{description}</p>
        ) : null}
        <div className="plus-menu__skill-preview-meta">
          <span>{skill.source === 'user' ? 'User skill' : 'Built-in skill'}</span>
          {skill.category ? <span>{skill.category}</span> : null}
          {skill.surface ? <span>{skill.surface}</span> : null}
        </div>
        {triggers.length > 0 ? (
          <div className="plus-menu__skill-preview-triggers" aria-label="Skill triggers">
            {triggers.slice(0, 4).map((trigger) => (
              <span key={trigger}>{trigger}</span>
            ))}
          </div>
        ) : null}
        {skill.examplePrompt ? (
          <p className="plus-menu__skill-preview-example">
            {skill.examplePrompt}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PlusSubmenuRow({
  label,
  icon,
  open,
  onOpen,
  onClose,
  flyoutStyle,
  flyoutClassName,
  testId,
  children,
}: {
  label: string;
  icon: IconName;
  open: boolean;
  onOpen: (row: HTMLDivElement | null) => void;
  onClose: () => void;
  flyoutStyle?: CSSProperties | null;
  /** Extra class on the flyout, e.g. the wide skills-preview variant. */
  flyoutClassName?: string;
  testId?: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={rowRef}
      className={`plus-menu__submenu-row${open ? ' is-open' : ''}`}
      onMouseEnter={() => onOpen(rowRef.current)}
      onMouseLeave={onClose}
    >
      <button
        type="button"
        role="menuitem"
        className="plus-menu__item plus-menu__parent"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen(rowRef.current))}
      >
        <Icon name={icon} size={14} className="plus-menu__item-icon" />
        <span>{label}</span>
        <Icon name="chevron-right" size={13} className="plus-menu__chevron" />
      </button>
      {open ? (
        <div
          className={`plus-menu__flyout${flyoutClassName ? ` ${flyoutClassName}` : ''}`}
          role="menu"
          style={flyoutStyle ?? undefined}
          onMouseEnter={() => onOpen(rowRef.current)}
          onMouseLeave={onClose}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
