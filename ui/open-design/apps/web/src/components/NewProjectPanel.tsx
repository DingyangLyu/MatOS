import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@open-design/components';
import { isOpenDesignHostAvailable, pickHostWorkingDir } from '@open-design/host';
import type { OpenDesignHostProjectImportSuccess } from '@open-design/host';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { openFolderDialog } from '../providers/registry';
import type {
  ProjectKind,
  ProjectMetadata,
  ProjectPlatform,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { Icon } from './Icon';
import { Skeleton } from './Loading';
import { Toast } from './Toast';
import { useOpenFolderImport } from './useOpenFolderImport';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

type NewProjectPlatform = Exclude<ProjectPlatform, 'auto'>;

function folderPickerErrorDetails(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const message = err.message.trim();
  if (!message) return undefined;
  const detail = message.replace(/^Could not open folder picker:\s*/i, '').trim();
  return detail || message;
}

const DESIGN_PLATFORMS: Array<{
  value: NewProjectPlatform;
  labelKey: keyof Dict;
  hintKey: keyof Dict;
}> = [
  {
    value: 'responsive',
    labelKey: 'newproj.platform.responsive.label',
    hintKey: 'newproj.platform.responsive.hint',
  },
  {
    value: 'web-desktop',
    labelKey: 'newproj.platform.webDesktop.label',
    hintKey: 'newproj.platform.webDesktop.hint',
  },
  {
    value: 'mobile-ios',
    labelKey: 'newproj.platform.mobileIos.label',
    hintKey: 'newproj.platform.mobileIos.hint',
  },
  {
    value: 'mobile-android',
    labelKey: 'newproj.platform.mobileAndroid.label',
    hintKey: 'newproj.platform.mobileAndroid.hint',
  },
  {
    value: 'tablet',
    labelKey: 'newproj.platform.tablet.label',
    hintKey: 'newproj.platform.tablet.hint',
  },
  {
    value: 'desktop-app',
    labelKey: 'newproj.platform.desktopApp.label',
    hintKey: 'newproj.platform.desktopApp.hint',
  },
];

export type CreateTab = 'prototype' | 'deck' | 'template' | 'other';

export interface CreateInput {
  name: string;
  skillId: string | null;
  metadata: ProjectMetadata;
  userWorkingDirToken?: string;
}

interface Props {
  skills: SkillSummary[];
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  onCreate: (input: CreateInput) => void;
  // Local-server flow: the daemon-owned native folder picker returns the
  // selected baseDir, then the renderer POSTs `/api/import/folder`.
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  // Host flow: the desktop main process owns the picker dialog and
  // the import call atomically (`pickAndImport` IPC). The renderer
  // never sees the path or the HMAC token; it only receives the
  // host-owned project identifiers and forwards them here so App-level
  // state can refresh through the daemon API.
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
  loading?: boolean;
  initialTab?: CreateTab;
}

const TAB_LABEL_KEYS: Record<CreateTab, keyof Dict> = {
  prototype: 'newproj.tabPrototype',
  deck: 'newproj.tabDeck',
  template: 'newproj.tabTemplate',
  other: 'newproj.tabOther',
};

export function NewProjectPanel({
  skills,
  templates,
  onDeleteTemplate,
  onCreate,
  onImportFolder,
  onImportFolderResponse,
  loading = false,
  initialTab = 'prototype',
}: Props) {
  const t = useT();
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [workingDirToken, setWorkingDirToken] = useState<string | null>(null);
  const [workingDirPicking, setWorkingDirPicking] = useState(false);
  const [workingDirError, setWorkingDirError] = useState<
    { message: string; details?: string } | null
  >(null);
  const [tab, setTab] = useState<CreateTab>(initialTab);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const [name, setName] = useState('');
  // Per-tab metadata. Tracked independently so switching tabs preserves
  // each tab's pick rather than resetting to defaults.
  const [fidelity, setFidelity] = useState<'wireframe' | 'high-fidelity'>(
    'high-fidelity',
  );
  const [platformTargets, setPlatformTargets] = useState<NewProjectPlatform[]>(['responsive']);
  const [includeLandingPage, setIncludeLandingPage] = useState(false);
  const [includeOsWidgets, setIncludeOsWidgets] = useState(false);
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [animations, setAnimations] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // When entering the template tab, snap to the first user-saved template
  // if there is one (and we don't already have a valid pick). The template
  // tab no longer offers a built-in fallback — the entire point is to
  // start from a template *the user* created via Share.
  useEffect(() => {
    if (tab !== 'template') return;
    if (templates.length === 0) {
      setTemplateId(null);
      return;
    }
    if (templateId == null || !templates.some((t) => t.id === templateId)) {
      setTemplateId(templates[0]!.id);
    }
  }, [tab, templates, templateId]);

  // The skill the request still routes through — kept so prototype/deck
  // pick a default-rendered skill (so the agent gets the right SKILL.md
  // body) without requiring the user to choose one explicitly.
  const skillIdForTab = useMemo(() => {
    if (tab === 'other') return null;
    if (tab === 'prototype') {
      const list = skills.filter((s) => s.mode === 'prototype');
      return list.find((s) => s.defaultFor.includes('prototype'))?.id
        ?? list[0]?.id
        ?? null;
    }
    if (tab === 'deck') {
      const list = skills.filter((s) => s.mode === 'deck');
      return list.find((s) => s.defaultFor.includes('deck'))?.id
        ?? list[0]?.id
        ?? null;
    }
    return null;
  }, [tab, skills]);

  const canCreate =
    !loading && (tab !== 'template' || templateId != null);

  function updateTabScrollState() {
    const el = tabsRef.current;
    if (!el) return;
    const maxLeft = el.scrollWidth - el.clientWidth;
    setTabScroll({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxLeft - 2,
    });
  }

  function scrollTabs(direction: -1 | 1) {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.65),
      behavior: 'smooth',
    });
  }

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateTabScrollState();
    const onScroll = () => updateTabScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLButtonElement>('.newproj-tab.active');
    active?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    window.setTimeout(updateTabScrollState, 180);
  }, [tab]);

  function handleCreate() {
    if (!canCreate) return;
    const trimmedName = name.trim();
    const metadata = buildMetadata({
      tab,
      fidelity,
      platformTargets,
      includeLandingPage,
      includeOsWidgets,
      speakerNotes,
      animations,
      templateId,
      templates,
    });
        onCreate({
      name: trimmedName || autoName(tab, t),
      skillId: skillIdForTab,
      metadata: {
        ...metadata,
        nameSource: trimmedName ? 'user' : 'generated',
        ...(workingDir ? { userWorkingDir: workingDir } : {}),
      },
      ...(workingDirToken ? { userWorkingDirToken: workingDirToken } : {}),
    });
  }

  async function handlePickWorkingDir() {
    if (workingDirPicking) return;
    setWorkingDirPicking(true);
    setWorkingDirError(null);
    try {
      if (isOpenDesignHostAvailable()) {
        const result = await pickHostWorkingDir();
        if (result.ok) {
          setWorkingDir(result.baseDir);
          setWorkingDirToken(result.token);
          return;
        }
        if ('canceled' in result && result.canceled) return;
        setWorkingDirError({
          message: `Couldn't open the folder picker (${'reason' in result ? result.reason : 'host unavailable'}). Please update MatOS and try again.`,
        });
        return;
      }
      try {
        const picked = await openFolderDialog({ throwOnError: true });
        if (picked) {
          setWorkingDir(picked);
          setWorkingDirToken(null);
        }
      } catch (err) {
        setWorkingDirError({
          message: t('chat.linkedFolderPickError'),
          details: folderPickerErrorDetails(err),
        });
      }
    } finally {
      setWorkingDirPicking(false);
    }
  }

  const folderImport = useOpenFolderImport({
    skillId: skillIdForTab,
    onImportFolder,
    onImportFolderResponse,
  });

  return (
    <div className="newproj" data-testid="new-project-panel">
      <div className={`newproj-tabs-shell${tabScroll.left ? ' can-left' : ''}${tabScroll.right ? ' can-right' : ''}`}>
        <button
          type="button"
          className={`newproj-tabs-arrow left${tabScroll.left ? '' : ' hidden'}`}
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll project types left"
          tabIndex={tabScroll.left ? 0 : -1}
        >
          <Icon name="chevron-left" size={16} strokeWidth={2} />
        </button>
        <div className="newproj-tabs" role="tablist" ref={tabsRef}>
          {(Object.keys(TAB_LABEL_KEYS) as CreateTab[]).map((entry) => (
            <button
              key={entry}
              role="tab"
              data-testid={`new-project-tab-${entry}`}
              aria-selected={tab === entry}
              className={`newproj-tab ${tab === entry ? 'active' : ''}`}
              onClick={() => {
                if (entry !== tab) {
                                  }
                setTab(entry);
              }}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`newproj-tabs-arrow right${tabScroll.right ? '' : ' hidden'}`}
          onClick={() => scrollTabs(1)}
          aria-label="Scroll project types right"
          tabIndex={tabScroll.right ? 0 : -1}
        >
          <Icon name="chevron-right" size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="newproj-body">
        <h3 className="newproj-title">
          <span className="newproj-title-text">{titleForTab(tab, t)}</span>
        </h3>

        <div className="newproj-name-row">
          <input
            className="newproj-name"
            data-testid="new-project-name"
            placeholder={t('newproj.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="newproj-working-dir-row">
          <button
            type="button"
            className={`ghost newproj-working-dir od-tooltip${workingDir ? ' picked' : ''}`}
            onClick={() => void handlePickWorkingDir()}
            disabled={workingDirPicking}
            title={workingDir ?? t('workingDirPicker.homeTitle')}
            data-tooltip={workingDir ?? t('workingDirPicker.homeTitle')}
          >
            <Icon name="folder" size={13} />
            <span>
              {workingDirPicking
                ? t('workingDirPicker.processing')
                : workingDir
                  ? displayFolderName(workingDir)
                  : t('workingDirPicker.select')}
            </span>
          </button>
          {workingDir ? (
            <button
              type="button"
              className="newproj-working-dir-clear"
              onClick={() => {
                setWorkingDir(null);
                setWorkingDirToken(null);
              }}
              aria-label={t('workingDirPicker.clearAria')}
            >
              <Icon name="close" size={10} />
            </button>
          ) : null}
        </div>

        {tab === 'prototype' || tab === 'template' || tab === 'other' ? (
          <PlatformPicker value={platformTargets} onChange={setPlatformTargets} />
        ) : null}

        {tab === 'prototype' || tab === 'template' || tab === 'other' ? (
          <SurfaceOptions
            includeLandingPage={includeLandingPage}
            includeOsWidgets={includeOsWidgets}
            onIncludeLandingPage={setIncludeLandingPage}
            onIncludeOsWidgets={setIncludeOsWidgets}
          />
        ) : null}

        {tab === 'prototype' ? (
          <FidelityPicker value={fidelity} onChange={setFidelity} />
        ) : null}

        {tab === 'deck' ? (
          <ToggleRow
            label={t('newproj.toggleSpeakerNotes')}
            hint={t('newproj.toggleSpeakerNotesHint')}
            checked={speakerNotes}
            onChange={setSpeakerNotes}
          />
        ) : null}

        {tab === 'template' ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
              onDelete={onDeleteTemplate}
            />
            <ToggleRow
              label={t('newproj.toggleAnimations')}
              hint={t('newproj.toggleAnimationsHint')}
              checked={animations}
              onChange={setAnimations}
            />
          </>
        ) : null}

        <button
          className="primary newproj-create"
          data-testid="create-project"
          onClick={handleCreate}
          disabled={!canCreate}
          title={
            tab === 'template' && templateId == null
              ? t('newproj.createDisabledTitle')
              : undefined
          }
        >
          <Icon name="plus" size={13} />
          <span>
            {tab === 'template'
              ? t('newproj.createFromTemplate')
              : t('newproj.create')}
          </span>
        </button>
        {folderImport.available ? (
          <div className="newproj-open-folder">
            <button
              type="button"
              className="ghost newproj-import"
              disabled={folderImport.importing}
              onClick={() => void folderImport.openFolder()}
            >
              <Icon name="folder" size={13} />
              <span>{folderImport.importing ? 'Opening...' : 'Open folder'}</span>
            </button>
          </div>
        ) : null}
      </div>
      <div className="newproj-footer">{t('newproj.privacyFooter')}</div>
      {folderImport.error ? (
        <Toast
          message={folderImport.error.message}
          details={folderImport.error.details ?? null}
          ttlMs={6000}
          onDismiss={folderImport.clearError}
        />
      ) : null}
      {workingDirError ? (
        <Toast
          message={workingDirError.message}
          details={workingDirError.details ?? null}
          ttlMs={6000}
          onDismiss={() => setWorkingDirError(null)}
        />
      ) : null}
    </div>
  );
}

function displayFolderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function PlatformPicker({
  value,
  onChange,
}: {
  value: NewProjectPlatform[];
  onChange: (v: NewProjectPlatform[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  function togglePlatform(next: NewProjectPlatform) {
    const active = value.includes(next);
    const updated = active
      ? value.filter((item) => item !== next)
      : [...value, next];
    onChange(updated.length > 0 ? updated : ['responsive']);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle.
    const tid = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const primary = DESIGN_PLATFORMS.find((o) => o.value === value[0]) ?? null;
  const extraCount = Math.max(0, value.length - 1);

  return (
    <div
      className={`newproj-section ds-picker platform-picker${open ? ' open' : ''}`}
      ref={wrapRef}
    >
      <label className="newproj-label">Target platforms</label>
      <button
        type="button"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
      >
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? t(primary.labelKey) : 'Pick a platform'}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div
          className="ds-picker-popover"
          id={listboxId}
          role="listbox"
          aria-label="Target platforms"
          aria-multiselectable="true"
        >
          <div className="ds-picker-list">
            {DESIGN_PLATFORMS.map((option) => {
              const active = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ds-picker-item${active ? ' active' : ''}`}
                  onClick={() => togglePlatform(option.value)}
                >
                  <span className="ds-picker-item-text">
                    <span className="ds-picker-item-title">{t(option.labelKey)}</span>
                    <span className="ds-picker-item-sub">{t(option.hintKey)}</span>
                  </span>
                  <span
                    className={`ds-picker-mark check${active ? ' active' : ''}`}
                    aria-hidden
                  >
                    {active ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SurfaceOptions({
  includeLandingPage,
  includeOsWidgets,
  onIncludeLandingPage,
  onIncludeOsWidgets,
}: {
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  onIncludeLandingPage: (v: boolean) => void;
  onIncludeOsWidgets: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section surface-options">
      <label className="newproj-label">{t('newproj.surfaceOptionsLabel')}</label>
      <div className="compact-toggle-list">
        <CompactToggle
          label={t('newproj.includeLandingPage')}
          hint={t('newproj.includeLandingPageHint')}
          checked={includeLandingPage}
          onChange={onIncludeLandingPage}
        />
        <CompactToggle
          label={t('newproj.includeOsWidgets')}
          hint={t('newproj.includeOsWidgetsHint')}
          checked={includeOsWidgets}
          onChange={onIncludeOsWidgets}
        />
      </div>
    </div>
  );
}

// Lightweight inline toggle row. The hint moves to a native tooltip so the
// row stays one line tall — used by SurfaceOptions where the toggles are
// secondary controls and the full card treatment of ToggleRow felt too heavy.
function CompactToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`compact-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
      title={hint}
    >
      <span className="compact-toggle-label">{label}</span>
      <span className="compact-toggle-switch" aria-hidden />
    </button>
  );
}

function FidelityPicker({
  value,
  onChange,
}: {
  value: 'wireframe' | 'high-fidelity';
  onChange: (v: 'wireframe' | 'high-fidelity') => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.fidelityLabel')}</label>
      <div className="fidelity-grid">
        <FidelityCard
          active={value === 'wireframe'}
          onClick={() => onChange('wireframe')}
          label={t('newproj.fidelityWireframe')}
          variant="wireframe"
        />
        <FidelityCard
          active={value === 'high-fidelity'}
          onClick={() => onChange('high-fidelity')}
          label={t('newproj.fidelityHigh')}
          variant="high-fidelity"
        />
      </div>
    </div>
  );
}

function FidelityCard({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant: 'wireframe' | 'high-fidelity';
}) {
  return (
    <button
      type="button"
      className={`fidelity-card${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`fidelity-thumb fidelity-thumb-${variant}`} aria-hidden>
        {variant === 'wireframe' ? <WireframeArt /> : <HighFidelityArt />}
      </span>
      <span className="fidelity-label">{label}</span>
    </button>
  );
}

function WireframeArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="46" height="6" rx="2" fill="#d8d4cb" />
      <rect x="6" y="20" width="34" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="28" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="36" width="30" height="4" rx="2" fill="#ebe8e1" />
      <circle cx="22" cy="56" r="6" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="64" y="8" width="50" height="54" rx="3" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="22" width="32" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="30" width="38" height="4" rx="2" fill="#ebe8e1" />
    </svg>
  );
}

function HighFidelityArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="34" height="6" rx="2" fill="#1a1916" />
      <rect x="6" y="20" width="46" height="4" rx="2" fill="#74716b" />
      <rect x="6" y="28" width="42" height="4" rx="2" fill="#b3b0a8" />
      <rect x="6" y="40" width="22" height="9" rx="2" fill="#c96442" />
      <rect x="64" y="8" width="50" height="54" rx="4" fill="#fbeee5" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#c96442" />
      <rect x="70" y="22" width="32" height="3" rx="1.5" fill="#74716b" />
      <rect x="70" y="29" width="36" height="3" rx="1.5" fill="#b3b0a8" />
      <rect x="70" y="36" width="20" height="6" rx="2" fill="#c96442" />
    </svg>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
    >
      <div className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {hint ? <span className="toggle-row-hint">{hint}</span> : null}
      </div>
      <span className="toggle-row-switch" aria-hidden />
    </button>
  );
}

function TemplatePicker({
  templates,
  value,
  onChange,
  onDelete,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
  onDelete?: (id: string) => Promise<boolean>;
}) {
  const t = useT();
  const deleteTemplateTitleId = useId();
  const [confirmDelete, setConfirmDelete] = useState<
    { id: string; name: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  function closeConfirm() {
    setConfirmDelete(null);
    setDeleting(false);
    setDeleteError(false);
  }

  async function runDelete() {
    if (!confirmDelete || !onDelete) return;
    setDeleting(true);
    setDeleteError(false);
    let ok = false;
    try {
      ok = await onDelete(confirmDelete.id);
    } catch {
      ok = false;
    }
    if (ok) {
      if (value === confirmDelete.id) onChange(null);
      closeConfirm();
    } else {
      setDeleting(false);
      setDeleteError(true);
    }
  }

  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.templateLabel')}</label>
      {templates.length === 0 ? (
        <div className="template-howto">
          <span className="template-howto-title">
            {t('newproj.noTemplatesTitle')}
          </span>
          <span className="template-howto-body">
            {t('newproj.noTemplatesBody')}
          </span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((tpl) => {
            const fallbackDesc = `${t('newproj.savedTemplate')} · ${tpl.files.length} ${
              tpl.files.length === 1
                ? t('newproj.fileSingular')
                : t('newproj.filePlural')
            }`;
            return (
              <TemplateOption
                key={tpl.id}
                active={value === tpl.id}
                onClick={() => onChange(tpl.id)}
                onDelete={onDelete ? () => setConfirmDelete({ id: tpl.id, name: tpl.name }) : () => {}}
                name={tpl.name}
                description={tpl.description ?? fallbackDesc}
              />
            );
          })}
        </div>
      )}
      {confirmDelete ? (
        <Dialog
          className="modal-confirm"
          role="alertdialog"
          onClose={deleting ? undefined : closeConfirm}
          ariaLabelledBy={deleteTemplateTitleId}
        >
          <DialogTitle id={deleteTemplateTitleId}>{t('newproj.deleteTemplateTitle')}</DialogTitle>
          <DialogDescription className="modal-confirm-message">
            {t('newproj.deleteTemplateConfirm', { name: confirmDelete.name })}
          </DialogDescription>
          {deleteError ? (
            <p className="modal-confirm-error" role="alert">
              {t('newproj.deleteTemplateError')}
            </p>
          ) : null}
          <DialogFooter className="row">
            <button type="button" onClick={closeConfirm} disabled={deleting}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary danger"
              autoFocus
              disabled={deleting}
              onClick={runDelete}
            >
              {t('newproj.deleteTemplateConfirmCta')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}

function TemplateOption({
  active,
  onClick,
  onDelete,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  name: string;
  description: string;
}) {
  return (
    <div className={`template-option${active ? ' active' : ''}`}>
      <button
        type="button"
        className="template-option-select"
        onClick={onClick}
        aria-pressed={active}
      >
        <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
        <span className="template-option-text">
          <span className="template-option-name">{name}</span>
          <span className="template-option-desc">{description}</span>
        </span>
      </button>
      <button
        type="button"
        className="template-option-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete template"
        aria-label={`Delete template ${name}`}
      >
        ✕
      </button>
    </div>
  );
}

function buildMetadata(input: {
  tab: CreateTab;
  fidelity: 'wireframe' | 'high-fidelity';
  platformTargets: NewProjectPlatform[];
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  speakerNotes: boolean;
  animations: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
}): ProjectMetadata {
  const kind: ProjectKind = input.tab;
  const selectedPlatforms = normalizeSelectedPlatforms(input.platformTargets);
  const concreteTargets = platformTargetsFor(selectedPlatforms);
  const canIncludeOsWidgets = platformTargetsSupportOsWidgets(concreteTargets);
  const surfaceOptions = {
    ...(input.includeLandingPage ? { includeLandingPage: true } : {}),
    ...(input.includeOsWidgets && canIncludeOsWidgets ? { includeOsWidgets: true } : {}),
  };
  const base = {
    platform: selectedPlatforms[0],
    platformTargets: concreteTargets,
    ...surfaceOptions,
  };
  if (input.tab === 'prototype') {
    return { kind, ...base, fidelity: input.fidelity };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, ...base, animations: input.animations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      ...base,
      animations: input.animations,
      templateId: input.templateId,
      templateLabel: tpl?.name ?? 'Saved template',
    };
  }
  return { kind: 'other', ...base };
}

function normalizeSelectedPlatforms(platforms: NewProjectPlatform[]): NewProjectPlatform[] {
  const seen = new Set<NewProjectPlatform>();
  for (const platform of platforms) {
    if (DESIGN_PLATFORMS.some((option) => option.value === platform)) {
      seen.add(platform);
    }
  }
  return seen.size > 0 ? [...seen] : ['responsive'];
}

function platformTargetsSupportOsWidgets(platforms: ProjectPlatform[] | NewProjectPlatform[]): boolean {
  return platforms.some((platform) =>
    platform === 'mobile-ios'
    || platform === 'mobile-android'
    || platform === 'tablet',
  );
}

function platformTargetsFor(platforms: NewProjectPlatform[]): ProjectPlatform[] {
  const targets = new Set<ProjectPlatform>();
  for (const platform of platforms) {
    switch (platform) {
      case 'responsive':
        targets.add('responsive');
        break;
      case 'web-desktop':
        targets.add('web-desktop');
        break;
      case 'mobile-ios':
        targets.add('mobile-ios');
        break;
      case 'mobile-android':
        targets.add('mobile-android');
        break;
      case 'tablet':
        targets.add('tablet');
        break;
      case 'desktop-app':
        targets.add('desktop-app');
        break;
      default: {
        const exhaustive: never = platform;
        targets.add(exhaustive);
      }
    }
  }
  return targets.size > 0 ? [...targets] : ['responsive'];
}

function titleForTab(
  tab: CreateTab,
  t: TranslateFn,
): string {
  switch (tab) {
    case 'prototype':
      return t('newproj.titlePrototype');
    case 'deck':
      return t('newproj.titleDeck');
    case 'template':
      return t('newproj.titleTemplate');
    case 'other':
      return t('newproj.titleOther');
  }
}

function autoName(
  tab: CreateTab,
  t: TranslateFn,
): string {
  const stamp = new Date().toLocaleDateString();
  return `${t(TAB_LABEL_KEYS[tab])} · ${stamp}`;
}
