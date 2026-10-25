// MatOS role picker for the Home composer. Same two-column popover
// interaction as the composer pickers (searchable list +
// right-hand preview) bound to a single selection: `onChange(id | null)`
// where the id is the matos agent's model-option id (`role:<id>`) and `null`
// means "Default role" (the run launches without an explicit `--role` and
// MatOS resolves the deployment default, usually role:compute).
//
// The list itself comes from the matos agent's model options (the daemon's
// `matos workbench roles list --json` projection, already loaded with
// /api/agents), so the picker, the top-bar model switcher, and the spawned
// run all share one catalog. Rich details for the right-hand preview
// (description, tags) are fetched lazily from `/api/matos/roles` on first
// open — a cold MatOS registry walk must not block Home rendering.
//
// The popover intentionally reuses the `project-ds-picker-*` CSS contract and
// the `home-hero__ds-row-*` trigger styling so it drops into the workdir row
// without new global styles.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentModelOption } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { useMatOSRoles, type MatOSRoleSummary } from '../runtime/matos-roles';
import { roleRefIdentity, sameRoleRef } from '../utils/roleRefs';
import { Icon } from './Icon';

interface PopoverAnchor {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

interface Props {
  /** matos agent model options; ids are `role:<id>` plus a `default` entry. */
  roles: AgentModelOption[];
  /** Selected `role:<id>` option id, or null for the default role. */
  selectedRoleId: string | null;
  loading?: boolean;
  onChange: (id: string | null) => void;
  /** Project role boundary: invited members plus project-bound role assets. */
  allowedRoleRefs?: readonly string[] | null;
  /**
   * Member-DM lock: when set, this conversation is bound to a single member
   * agent's role, so the picker is pinned to it — the trigger shows the
   * member's role name with a lock glyph and the popover never opens. `id` is
   * the `role:<id>` ref; `name` is the member/role display name.
   */
  lockedRole?: { id: string; name: string } | null;
}

/** `role:compute` → `compute` (for stable testids and detail lookups). */
function roleIdPart(optionId: string): string {
  return optionId.startsWith('role:') ? optionId.slice('role:'.length) : optionId;
}

// --- preview scene art -------------------------------------------------------
//
// Every role gets a small "scene" banner in the preview pane so the picker
// reads as a catalog of working contexts instead of a bare name list. The
// scene is derived from the role's id/name/tags with keyword matching — roles
// are user-generated (self-evolution, packs, Gitea syncs), so this must work
// for refs we have never seen; unknown roles fall back to the MatOS lattice.

type RoleSceneCategory =
  | 'battery'
  | 'catalysis'
  | 'academic'
  | 'ml'
  | 'workflow'
  | 'data'
  | 'structure'
  | 'compute'
  | 'default';

const ROLE_SCENE_RULES: Array<{ category: RoleSceneCategory; pattern: RegExp }> = [
  { category: 'battery', pattern: /batter|electrochem|electrode|anode|cathode|electrolyte/i },
  { category: 'catalysis', pattern: /cataly|microkinetic|adsorpt|reaction|kinetic/i },
  { category: 'academic', pattern: /academ|literature|review|citation|paper|deep-research|research/i },
  { category: 'ml', pattern: /\bml\b|mlip|machine|neural|potential|train|intelligen/i },
  { category: 'workflow', pattern: /workflow|pipeline|builder|orchestr|automat/i },
  { category: 'data', pattern: /chemin|informat|dataset|database|data|screen/i },
  { category: 'structure', pattern: /glass|amorphous|crystal|structur|interface|modeling|lattice/i },
  { category: 'compute', pattern: /comput|dft|electron|transport|defect|phonon|foundation|band|vasp|quantum/i },
];

function roleSceneCategory(haystack: string): RoleSceneCategory {
  for (const rule of ROLE_SCENE_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return 'default';
}

/** Inline scene illustrations — stroke inherits currentColor, accents fixed. */
function RoleSceneArt({ category }: { category: RoleSceneCategory }) {
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    fill: 'none',
  };
  const soft = { ...stroke, opacity: 0.38, strokeWidth: 1.5 };
  switch (category) {
    case 'battery':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <rect x="70" y="38" width="150" height="48" rx="10" {...stroke} />
          <rect x="220" y="52" width="14" height="20" rx="4" {...stroke} />
          <path d="M96 62h28M110 48v28" {...soft} />
          <path d="M176 48v28M162 62h28" {...soft} />
          <circle cx="138" cy="54" r="4" fill="#0891b2" />
          <circle cx="150" cy="68" r="4" fill="#0891b2" opacity="0.75" />
          <circle cx="126" cy="70" r="4" fill="#0891b2" opacity="0.5" />
          <path d="M252 44c14 8 14 24 0 32" {...soft} />
        </svg>
      );
    case 'catalysis':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <path d="M56 92h208" {...stroke} />
          <path d="M76 92v-8m24 8v-8m24 8v-8m24 8v-8m24 8v-8m24 8v-8m24 8v-8m24 8v-8" {...soft} />
          <circle cx="112" cy="66" r="9" {...stroke} />
          <circle cx="134" cy="52" r="6" {...soft} />
          <circle cx="196" cy="62" r="9" {...stroke} />
          <circle cx="216" cy="48" r="6" {...soft} />
          <path d="M130 34c22-14 44-12 62 2" {...soft} markerEnd="none" />
          <path d="M186 32l8 4-6 7" {...soft} />
          <circle cx="112" cy="66" r="3" fill="#0891b2" />
          <circle cx="196" cy="62" r="3" fill="#0891b2" />
        </svg>
      );
    case 'academic':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <rect x="74" y="30" width="104" height="64" rx="8" {...stroke} />
          <rect x="90" y="22" width="104" height="64" rx="8" {...soft} />
          <path d="M90 48h72M90 60h72M90 72h48" {...soft} />
          <circle cx="216" cy="72" r="16" {...stroke} />
          <path d="M228 84l14 14" {...stroke} />
          <path d="M243 34c-3 8-9 10-9 10s8 1 9 10c1-9 9-10 9-10s-8-2-9-10z" fill="#0891b2" opacity="0.85" />
        </svg>
      );
    case 'ml':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          {[
            [88, 36], [88, 60], [88, 84],
            [160, 28], [160, 52], [160, 76], [160, 98],
            [232, 44], [232, 76],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="7" {...(x === 160 ? soft : stroke)} />
          ))}
          {([
            [88, 36], [88, 60], [88, 84],
          ] as Array<[number, number]>).flatMap(([x, y]) =>
            ([[160, 28], [160, 52], [160, 76], [160, 98]] as Array<[number, number]>).map(([tx, ty], j) => (
              <path key={`${x}-${y}-${j}`} d={`M${x + 7} ${y}L${tx - 7} ${ty}`} opacity="0.18" stroke="currentColor" strokeWidth="1" />
            )),
          )}
          {([[160, 28], [160, 52], [160, 76], [160, 98]] as Array<[number, number]>).flatMap(([x, y]) =>
            ([[232, 44], [232, 76]] as Array<[number, number]>).map(([tx, ty], j) => (
              <path key={`h-${x}-${y}-${j}`} d={`M${x + 7} ${y}L${tx - 7} ${ty}`} opacity="0.18" stroke="currentColor" strokeWidth="1" />
            )),
          )}
          <circle cx="232" cy="44" r="3" fill="#0891b2" />
        </svg>
      );
    case 'workflow':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <rect x="62" y="48" width="52" height="30" rx="8" {...stroke} />
          <rect x="150" y="20" width="52" height="30" rx="8" {...soft} />
          <rect x="150" y="72" width="52" height="30" rx="8" {...stroke} />
          <rect x="238" y="48" width="52" height="30" rx="8" {...stroke} />
          <path d="M114 58c16 0 20-16 36-20M114 68c16 0 20 16 36 19" {...soft} />
          <path d="M202 36c16 4 22 18 36 22M202 87c16-4 22-16 36-21" {...soft} />
          <circle cx="264" cy="63" r="3.5" fill="#0891b2" />
        </svg>
      );
    case 'data':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <ellipse cx="112" cy="34" rx="38" ry="12" {...stroke} />
          <path d="M74 34v44c0 7 17 12 38 12s38-5 38-12V34" {...stroke} />
          <path d="M74 56c0 7 17 12 38 12s38-5 38-12" {...soft} />
          <path d="M196 88V56m26 32V40m26 48V64" {...stroke} />
          <circle cx="196" cy="48" r="3.5" fill="#0891b2" />
          <circle cx="222" cy="32" r="3.5" fill="#0891b2" opacity="0.7" />
          <circle cx="248" cy="56" r="3.5" fill="#0891b2" opacity="0.45" />
        </svg>
      );
    case 'structure':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <path d="M96 36l34 20v40l-34 20-34-20V56z" transform="translate(30 -18) scale(0.72)" {...stroke} />
          <path d="M126 56l-30-18-30 18m60 0v36m-60-36v36m60 0l-30 18-30-18" transform="translate(30 -18) scale(0.72)" {...soft} />
          <circle cx="204" cy="42" r="5" {...stroke} />
          <circle cx="238" cy="60" r="5" {...soft} />
          <circle cx="216" cy="84" r="5" {...stroke} />
          <circle cx="256" cy="90" r="5" {...soft} />
          <circle cx="252" cy="30" r="5" {...soft} />
          <path d="M208 46l26 12m-16 24l-14-32m22 34l34 6m-6-56l-24 22" opacity="0.25" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="204" cy="42" r="2" fill="#0891b2" />
        </svg>
      );
    case 'compute':
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <ellipse cx="160" cy="60" rx="66" ry="24" {...soft} />
          <ellipse cx="160" cy="60" rx="66" ry="24" transform="rotate(60 160 60)" {...soft} />
          <ellipse cx="160" cy="60" rx="66" ry="24" transform="rotate(-60 160 60)" {...soft} />
          <circle cx="160" cy="60" r="10" {...stroke} />
          <circle cx="226" cy="60" r="4" fill="#0891b2" />
          <circle cx="127" cy="17" r="4" fill="#0891b2" opacity="0.7" />
          <circle cx="118" cy="99" r="4" fill="#0891b2" opacity="0.45" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 320 120" aria-hidden className="matos-role-scene__art">
          <circle cx="160" cy="60" r="12" {...stroke} />
          {[
            [160, 20], [196, 40], [196, 80], [160, 100], [124, 80], [124, 40],
          ].map(([x, y], i) => (
            <g key={i}>
              <path d={`M160 60L${x} ${y}`} {...soft} />
              <circle cx={x} cy={y} r="7" {...stroke} />
            </g>
          ))}
          <circle cx="160" cy="60" r="4" fill="#0891b2" />
        </svg>
      );
  }
}

// Description shapes like "Academic research agent — literature survey,
// review writing, citation management" split into a summary line plus
// capability chips; a plain sentence stays a single summary paragraph.
function splitRoleDescription(description: string | null): {
  summary: string | null;
  capabilities: string[];
} {
  const text = (description ?? '').trim();
  if (!text) return { summary: null, capabilities: [] };
  const match = /\s*[—–]\s*|\s+-\s+/.exec(text);
  if (!match || match.index === 0) return { summary: text, capabilities: [] };
  const head = text.slice(0, match.index).trim();
  const tail = text.slice(match.index + match[0].length).trim();
  const capabilities = tail
    .split(/[,;，；、]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 48)
    .slice(0, 8);
  if (capabilities.length < 2) return { summary: text, capabilities: [] };
  return { summary: head, capabilities };
}

const MOUNT_PREVIEW_GROUPS: Array<{ type: string; labelKey: 'assets.mounts.skills' | 'assets.mounts.tools' | 'assets.mounts.mcp' | 'assets.mounts.knowledges' | 'assets.mounts.data' | 'assets.mounts.workflows' | 'assets.mounts.roles' }> = [
  { type: 'skill', labelKey: 'assets.mounts.skills' },
  { type: 'tool', labelKey: 'assets.mounts.tools' },
  { type: 'mcp', labelKey: 'assets.mounts.mcp' },
  { type: 'knowledge', labelKey: 'assets.mounts.knowledges' },
  { type: 'data', labelKey: 'assets.mounts.data' },
  { type: 'workflow', labelKey: 'assets.mounts.workflows' },
  { type: 'role', labelKey: 'assets.mounts.roles' },
];

function mountCounts(dependencies: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dep of dependencies) {
    const idx = dep.indexOf(':');
    if (idx <= 0) continue;
    const type = dep.slice(0, idx);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

export function MatOSRolePicker({
  roles,
  selectedRoleId,
  loading,
  onChange,
  lockedRole,
  allowedRoleRefs,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [hovered, setHovered] = useState<AgentModelOption | null>(null);
  // Whether the "Default role" row is the active preview target.
  const [hoveredDefault, setHoveredDefault] = useState(false);

  // Rich per-role details (description, tags) for the preview pane, keyed by
  // both the full ref and the bare id. Loaded on first open (and TTL-refreshed
  // by the runtime module so an expanding registry shows up without reload).
  // Also loaded eagerly when the persisted selection is a ref the agent
  // options don't know (e.g. a registry-only role picked before a reload), so
  // the trigger can label it without waiting for the user to open the picker.
  const selectionUnknown =
    selectedRoleId !== null && !roles.some((option) => sameRoleRef(option.id, selectedRoleId));
  const { roles: roleDetails } = useMatOSRoles(open || selectionUnknown, {
    refresh: open,
  });

  const allowedRoles = useMemo(() => {
    if (!allowedRoleRefs || allowedRoleRefs.length === 0) return null;
    const byIdentity = new Map<string, string>();
    for (const ref of allowedRoleRefs) {
      const trimmed = ref.trim();
      if (trimmed) byIdentity.set(roleRefIdentity(trimmed), trimmed);
    }
    return byIdentity.size > 0 ? byIdentity : null;
  }, [allowedRoleRefs]);

  // Selectable rows = the live registry catalog merged over the agent's model
  // options. The agent options (daemon `matos workbench roles list` probe) are
  // the always-present base, but they freeze to a static fallback when that
  // probe times out on a cold start — and the MatOS asset registry keeps
  // growing (self-evolution, user packs, Gitea syncs). `/api/matos/roles` is
  // the dynamic registration source of truth, so any registry role missing
  // from the agent options is appended here; `--role` accepts free refs, so a
  // merged-in role runs exactly like a probed one. The synthetic `default`
  // row is dropped — the picker renders its own default option.
  const roleOptions = useMemo(() => {
    const out: AgentModelOption[] = [];
    const seen = new Set<string>();
    const add = (option: AgentModelOption) => {
      if (option.id === 'default') return;
      const identity = roleRefIdentity(option.id);
      if (allowedRoles && !allowedRoles.has(identity)) return;
      if (seen.has(identity)) return;
      out.push(option);
      seen.add(identity);
    };
    for (const option of roles) {
      add(option);
    }
    for (const detail of roleDetails) {
      add({ id: detail.ref, label: detail.name });
    }
    if (allowedRoles) {
      for (const [identity, ref] of allowedRoles) {
        if (seen.has(identity)) continue;
        add({ id: ref, label: identity.replace(/^role:/, '') });
      }
    }
    return out;
  }, [allowedRoles, roles, roleDetails]);

  const selected = useMemo(
    () => roleOptions.find((option) => sameRoleRef(option.id, selectedRoleId)) ?? null,
    [roleOptions, selectedRoleId],
  );
  const detailsByRef = useMemo(() => {
    const map = new Map<string, MatOSRoleSummary>();
    for (const detail of roleDetails) {
      map.set(detail.ref, detail);
      map.set(detail.id, detail);
    }
    return map;
  }, [roleDetails]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Same viewport-aware anchoring as the composer pickers: the trigger sits
  // in the row below the composer, so the popover usually opens upward.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    function updateAnchor() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.innerWidth;
      const popoverWidth = Math.min(640, Math.max(320, viewport - 24));
      const left = Math.max(8, Math.min(viewport - popoverWidth - 8, rect.left));
      const gap = 6;
      const margin = 12;
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const openUp = spaceBelow < 320 && spaceAbove > spaceBelow;
      if (openUp) {
        setAnchor({
          bottom: window.innerHeight - rect.top + gap,
          left,
          width: popoverWidth,
          maxHeight: Math.max(220, Math.min(420, spaceAbove)),
        });
      } else {
        setAnchor({
          top: rect.bottom + gap,
          left,
          width: popoverWidth,
          maxHeight: Math.max(220, Math.min(420, spaceBelow)),
        });
      }
    }
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    return () => {
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setHovered(null);
      setHoveredDefault(false);
    }
  }, [open]);

  // Right-pane preview priority: hovered role, hovered default row, the
  // current selection, then the default blurb when nothing is selected.
  let previewOption: AgentModelOption | null = null;
  let previewDefault = false;
  if (open) {
    if (hovered) previewOption = hovered;
    else if (hoveredDefault) previewDefault = true;
    else if (selectedRoleId != null) previewOption = selected;
    else previewDefault = true;
  }
  const previewDetail = previewOption
    ? detailsByRef.get(previewOption.id) ?? detailsByRef.get(roleIdPart(previewOption.id)) ?? null
    : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return roleOptions;
    return roleOptions.filter((option) => {
      const detail = detailsByRef.get(option.id) ?? detailsByRef.get(roleIdPart(option.id));
      const haystack = `${option.label} ${option.id} ${detail?.description ?? ''} ${detail?.tags.join(' ') ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, roleOptions, detailsByRef]);

  const selectRole = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  const selectRoleOnKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string | null) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectRole(id);
  };

  const clearSelection = () => {
    setQuery('');
    onChange(null);
    inputRef.current?.focus();
  };

  const renderOption = (option: AgentModelOption) => {
    const active = sameRoleRef(option.id, selectedRoleId);
    const testId = roleIdPart(option.id);
    return (
      <button
        key={option.id}
        type="button"
        className={`project-ds-picker-option${active ? ' active' : ''}`}
        role="option"
        aria-selected={active}
        onMouseEnter={() => {
          setHovered(option);
          setHoveredDefault(false);
        }}
        onFocus={() => {
          setHovered(option);
          setHoveredDefault(false);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          selectRole(option.id);
        }}
        onKeyDown={(event) => selectRoleOnKeyDown(event, option.id)}
        data-testid={`matos-role-picker-option-${testId}`}
      >
        <div className="project-ds-picker-option-head">
          <span className="project-ds-picker-option-title">{option.label}</span>
          {active ? (
            <span
              className="project-ds-picker-option-check"
              data-testid={`matos-role-picker-option-${testId}-check`}
            >
              <Icon name="check" size={13} strokeWidth={2} />
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  const popover: ReactNode =
    open && anchor && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            // The extra modifier scopes the phone layout (list-only, preview
            // hidden — see home-hero.css) to this picker without touching other
            // pickers that share the base popover contract.
            className="project-ds-picker-popover project-ds-picker-popover--matos-role"
            data-testid="matos-role-picker-popover"
            data-placement={anchor.bottom !== undefined ? 'up' : 'down'}
            style={{
              top: anchor.top,
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
              maxHeight: anchor.maxHeight,
            }}
          >
            <div className="project-ds-picker-search">
              <Icon name="search" size={12} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('matosRolePicker.searchPlaceholder')}
                data-testid="matos-role-picker-search"
              />
              {allowedRoles ? null : (
                <button
                  type="button"
                  className="project-ds-picker-action"
                  data-testid="matos-role-picker-clear"
                  onClick={clearSelection}
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
            <div className="project-ds-picker-body">
              <div className="project-ds-picker-list" role="listbox">
                {allowedRoles ? null : (
                  <button
                    type="button"
                    className={`project-ds-picker-option${selectedRoleId == null ? ' active' : ''}`}
                    role="option"
                    aria-selected={selectedRoleId == null}
                    onMouseEnter={() => {
                      setHovered(null);
                      setHoveredDefault(true);
                    }}
                    onFocus={() => {
                      setHovered(null);
                      setHoveredDefault(true);
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectRole(null);
                    }}
                    onKeyDown={(event) => selectRoleOnKeyDown(event, null)}
                    data-testid="matos-role-picker-option-default"
                  >
                    <div className="project-ds-picker-option-head">
                      <span className="project-ds-picker-option-title">
                        {t('matosRolePicker.defaultTitle')}
                      </span>
                      {selectedRoleId == null ? (
                        <span
                          className="project-ds-picker-option-check"
                          data-testid="matos-role-picker-option-default-check"
                        >
                          <Icon name="check" size={13} strokeWidth={2} />
                        </span>
                      ) : null}
                    </div>
                  </button>
                )}
                {filtered.length > 0 ? (
                  <div
                    className="project-ds-picker-group-label"
                    role="presentation"
                    data-testid="matos-role-picker-group-roles"
                  >
                    {t('matosRolePicker.rolesGroup')}
                  </div>
                ) : null}
                {filtered.map(renderOption)}
                {filtered.length === 0 ? (
                  <div className="project-ds-picker-empty">{t('matosRolePicker.empty')}</div>
                ) : null}
              </div>
              <div className="project-ds-picker-preview" data-testid="matos-role-picker-preview">
                {previewDefault ? (
                  <div className="matos-role-preview" data-testid="matos-role-picker-preview-default">
                    <div className="matos-role-scene matos-role-scene--default">
                      <RoleSceneArt category="default" />
                    </div>
                    <div className="matos-role-preview__head">
                      <strong>{t('matosRolePicker.defaultTitle')}</strong>
                      <code className="matos-role-preview__ref">role:*</code>
                    </div>
                    <p className="matos-role-preview__summary">
                      {t('matosRolePicker.defaultSummary')}
                    </p>
                  </div>
                ) : previewOption ? (
                  (() => {
                    const name = previewDetail?.name ?? previewOption.label;
                    const category = roleSceneCategory(
                      `${previewOption.id} ${name} ${previewDetail?.tags.join(' ') ?? ''} ${previewDetail?.description ?? ''}`,
                    );
                    const { summary, capabilities } = splitRoleDescription(
                      previewDetail?.description ?? null,
                    );
                    const counts = mountCounts(previewDetail?.dependencies ?? []);
                    const mountChips = MOUNT_PREVIEW_GROUPS.filter(
                      (group) => (counts.get(group.type) ?? 0) > 0,
                    );
                    const tagChips =
                      previewDetail && previewDetail.tags.length > 0 && capabilities.length === 0
                        ? previewDetail.tags.slice(0, 8)
                        : [];
                    return (
                      <div className="matos-role-preview" data-testid="matos-role-picker-preview-role">
                        <div className={`matos-role-scene matos-role-scene--${category}`}>
                          <RoleSceneArt category={category} />
                        </div>
                        <div className="matos-role-preview__head">
                          <strong>{name}</strong>
                          <code className="matos-role-preview__ref">{previewOption.id}</code>
                        </div>
                        {summary ? (
                          <p className="matos-role-preview__summary">{summary}</p>
                        ) : (
                          <p className="matos-role-preview__summary matos-role-preview__summary--muted">
                            {t('matosRolePicker.previewHint')}
                          </p>
                        )}
                        {capabilities.length > 0 ? (
                          <div className="matos-role-preview__section">
                            <div className="matos-role-preview__label">
                              {t('matosRolePicker.capabilities')}
                            </div>
                            <div className="matos-role-preview__chips">
                              {capabilities.map((cap) => (
                                <span key={cap} className="matos-role-preview__chip">
                                  {cap}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {tagChips.length > 0 ? (
                          <div className="matos-role-preview__section">
                            <div className="matos-role-preview__label">
                              {t('matosRolePicker.capabilities')}
                            </div>
                            <div className="matos-role-preview__chips">
                              {tagChips.map((tag) => (
                                <span key={tag} className="matos-role-preview__chip">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {mountChips.length > 0 ? (
                          <div className="matos-role-preview__section">
                            <div className="matos-role-preview__label">
                              {t('assets.mounts.title')}
                            </div>
                            <div className="matos-role-preview__chips">
                              {mountChips.map((group) => (
                                <span
                                  key={group.type}
                                  className="matos-role-preview__chip matos-role-preview__chip--mount"
                                >
                                  {t(group.labelKey)}
                                  <em>{counts.get(group.type)}</em>
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {previewDetail?.runtime ? (
                          <div
                            className="matos-role-preview__section"
                            data-testid="matos-role-picker-preview-runtime"
                          >
                            <div className="matos-role-preview__label">
                              {t('assets.runtime.title')}
                            </div>
                            <div className="matos-role-preview__chips">
                              {previewDetail.runtime.model ? (
                                <span className="matos-role-preview__chip">
                                  {t('assets.runtime.model')}
                                  <em>{previewDetail.runtime.model}</em>
                                </span>
                              ) : null}
                              {previewDetail.runtime.effort ? (
                                <span className="matos-role-preview__chip">
                                  {t('assets.runtime.effort')}
                                  <em>{previewDetail.runtime.effort}</em>
                                </span>
                              ) : null}
                              {previewDetail.runtime.permissionMode ? (
                                <span className="matos-role-preview__chip">
                                  {t('assets.runtime.permissionMode')}
                                  <em>{previewDetail.runtime.permissionMode}</em>
                                </span>
                              ) : null}
                              {previewDetail.runtime.maxTurns ? (
                                <span className="matos-role-preview__chip">
                                  {t('assets.runtime.maxTurns')}
                                  <em>{previewDetail.runtime.maxTurns}</em>
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()
                ) : (
                  <div className="project-ds-picker-preview-stage">
                    <div className="project-ds-picker-preview-empty">
                      {t('matosRolePicker.previewHint')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  // Member-DM lock: the conversation is bound to one member agent's role, so
  // the picker is read-only and pinned to that role. Show a lock glyph + the
  // member role name and never open the popover.
  if (lockedRole) {
    return (
      <div
        ref={wrapRef}
        className="home-hero__ds-row-picker home-hero__ds-row-picker--locked"
        data-testid="home-hero-matos-role-picker"
      >
        <button
          type="button"
          className="home-hero__ds-row-trigger is-locked"
          data-testid="home-hero-matos-role-trigger"
          disabled
          aria-disabled="true"
          title={t('matosRolePicker.lockedHint', { role: lockedRole.name })}
        >
          <Icon name="shield" size={12} className="home-hero__ds-row-trigger-icon" />
          <span className="home-hero__ds-row-trigger-label">{lockedRole.name}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="home-hero__ds-row-picker"
      data-testid="home-hero-matos-role-picker"
    >
      <button
        ref={triggerRef}
        type="button"
        className="home-hero__ds-row-trigger"
        data-testid="home-hero-matos-role-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading}
        title={selected?.label ?? t('matosRolePicker.defaultTitle')}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sparkles" size={13} className="home-hero__ds-row-trigger-icon" />
        <span className="home-hero__ds-row-trigger-label">
          {loading
            ? t('matosRolePicker.loading')
            : selected?.label ?? t('matosRolePicker.defaultTitle')}
        </span>
        <Icon name="chevron-down" size={11} className="home-hero__ds-row-trigger-chevron" />
      </button>
      {popover}
    </div>
  );
}
