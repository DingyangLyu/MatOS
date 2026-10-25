// MatOS new-project modal — the "+" → Project entry point.
//
// Replaces the upstream Open Design create panel (prototype / deck / media
// tabs) with MatOS project semantics: a project is a mission-driven working
// folder shared by a roster of agent roles. The form captures
//
//   1. project name,
//   2. the overall mission (`metadata.goal`, injected into every member
//      run's system prompt as the project charter),
//   3. the member roles pulled into the project and what each one is
//      responsible for (`metadata.members` + `metadata.memberBriefs`),
//   4. the working folder — one folder per project, all agents run inside
//      it (a project location + a folder name that doubles as the project
//      id, so the daemon creates `<location>/<folder>` and pins it as
//      `metadata.baseDir`).
//
// Visual chrome (backdrop, head, status rows) intentionally reuses the
// `.new-project-modal` CSS contract so the dialog looks native next to the
// legacy panel; the form body uses the `matos-np-*` classes defined in
// styles/home/new-project-modal.css.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ProjectLocation, ProjectMetadata } from '@open-design/contracts';
import { modalOverlay, modalContent } from '../motion';
import { useI18n } from '../i18n';
import { useMatOSRoles } from '../runtime/matos-roles';
import { fetchProjectLocations } from '../state/project-locations';
import { randomUUID } from '../utils/uuid';
import { Icon } from './Icon';

export interface MatOSCreateProjectInput {
  name: string;
  skillId: null;
  metadata: ProjectMetadata;
  /** Slug id (= folder name) when a real project location is selected. */
  id?: string;
  projectLocationId?: string;
  requestId?: string;
}

interface Props {
  open: boolean;
  onCreate: (input: MatOSCreateProjectInput) => Promise<boolean> | boolean | void;
  onClose: () => void;
}

interface MemberRow {
  key: number;
  ref: string;
  /** Per-project custom name shown in the group chat and used for @-mentions. */
  name: string;
  brief: string;
}

const BUILT_IN_LOCATION_ID = 'default';

const MAX_MEMBER_NAME_LEN = 40;

/** Stable avatar accent from the role ref so members read as distinct people. */
function memberAvatarHue(ref: string): number {
  let hash = 0;
  for (let i = 0; i < ref.length; i++) hash = (hash * 31 + ref.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** Project-id-safe folder slug (daemon `isSafeId`: `[A-Za-z0-9._-]+`). */
export function projectFolderSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
}

function fallbackFolderSlug(): string {
  return `project-${Date.now().toString(36).slice(-4)}`;
}

export function MatOSNewProjectModal({ open, ...rest }: Props) {
  return <AnimatePresence>{open ? <MatOSNewProjectModalBody {...rest} /> : null}</AnimatePresence>;
}

function MatOSNewProjectModalBody({ onCreate, onClose }: Omit<Props, 'open'>) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const memberKeyRef = useRef(1);

  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([{ key: 0, ref: '', name: '', brief: '' }]);
  const [locations, setLocations] = useState<ProjectLocation[]>([]);
  const [locationId, setLocationId] = useState<string>(BUILT_IN_LOCATION_ID);
  const [folderName, setFolderName] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { roles } = useMatOSRoles(true);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectLocations().then((list) => {
      if (cancelled) return;
      setLocations(list);
      // Prefer the first real folder root (the deployment's "Workspace"
      // location when configured) over the hidden managed store.
      const preferred = list.find((loc) => !loc.builtIn) ?? list[0];
      if (preferred) setLocationId(preferred.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [creating, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Folder name mirrors the project name until the user edits it directly.
  useEffect(() => {
    if (!folderTouched) setFolderName(projectFolderSlug(name));
  }, [name, folderTouched]);

  const selectedLocation = useMemo(
    () => locations.find((loc) => loc.id === locationId) ?? null,
    [locations, locationId],
  );
  const isManagedLocation = !selectedLocation || selectedLocation.builtIn === true;

  const roleOptions = useMemo(
    () =>
      roles.map((role) => ({
        ref: role.ref,
        name: role.name,
        description: role.description ?? '',
      })),
    [roles],
  );

  const pickedRefs = useMemo(
    () => new Set(members.map((m) => m.ref).filter(Boolean)),
    [members],
  );

  const selectedMemberCount = members.filter((m) => m.ref).length;

  /** Catalog display name for a picked role ref (falls back to the ref slug). */
  const roleNameOf = (ref: string): string => {
    const match = roleOptions.find((option) => option.ref === ref);
    return match?.name ?? ref.replace(/^role:/, '');
  };

  function updateMember(key: number, patch: Partial<MemberRow>) {
    setMembers((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addMemberRow() {
    setMembers((rows) => [...rows, { key: memberKeyRef.current++, ref: '', name: '', brief: '' }]);
  }

  function removeMemberRow(key: number) {
    setMembers((rows) =>
      rows.length > 1
        ? rows.filter((row) => row.key !== key)
        : rows.map((row) => (row.key === key ? { ...row, ref: '', name: '', brief: '' } : row)),
    );
  }

  function buildMetadata(): ProjectMetadata {
    const memberRefs: string[] = [];
    const memberBriefs: Record<string, string> = {};
    const memberNames: Record<string, string> = {};
    for (const row of members) {
      const ref = row.ref.trim();
      if (!ref || memberRefs.includes(ref)) continue;
      memberRefs.push(ref);
      const brief = row.brief.trim();
      if (brief) memberBriefs[ref] = brief.slice(0, 600);
      // Store the alias only when it is a real rename — a non-empty name that
      // differs from the catalog role name — so unchanged members fall back to
      // the role name everywhere (sidebar, group @-bar, charter prompt).
      const alias = row.name.trim();
      if (alias && alias !== roleNameOf(ref)) {
        memberNames[ref] = alias.slice(0, MAX_MEMBER_NAME_LEN);
      }
    }
    const trimmedGoal = goal.trim();
    return {
      kind: 'other',
      nameSource: 'user',
      // MatOS projects skip the OD design-discovery form: the mission +
      // roster below are the brief.
      skipDiscoveryBrief: true,
      ...(trimmedGoal ? { goal: trimmedGoal.slice(0, 4000) } : {}),
      ...(memberRefs.length > 0 ? { members: memberRefs } : {}),
      ...(Object.keys(memberBriefs).length > 0 ? { memberBriefs } : {}),
      ...(Object.keys(memberNames).length > 0 ? { memberNames } : {}),
    };
  }

  async function handleCreate() {
    if (creating) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('matosNewProject.nameRequired'));
      return;
    }
    setCreating(true);
    setError(null);
    const metadata = buildMetadata();
    const baseSlug = isManagedLocation
      ? null
      : (projectFolderSlug(folderName) || projectFolderSlug(trimmedName) || fallbackFolderSlug());
    try {
      // Slug ids can collide with an existing project/folder; retry with a
      // numeric suffix a couple of times before surfacing the error.
      const attempts = baseSlug ? [baseSlug, `${baseSlug}-2`, `${baseSlug}-3`] : [null];
      let lastError: unknown = null;
      for (const slug of attempts) {
        try {
          const result = await onCreate({
            name: trimmedName,
            skillId: null,
                      metadata,
            ...(slug ? { id: slug } : {}),
            ...(baseSlug && selectedLocation ? { projectLocationId: selectedLocation.id } : {}),
            requestId: randomUUID(),
          });
          if (result === false) {
            setError(t('matosNewProject.error'));
            return;
          }
          onClose();
          return;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : '';
          if (!/already exists|EEXIST/i.test(message)) throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(t('matosNewProject.error'));
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : t('matosNewProject.error'));
    } finally {
      setCreating(false);
    }
  }

  const previewFolder = selectedLocation && !isManagedLocation
    ? `${selectedLocation.path.replace(/\/+$/, '')}/${projectFolderSlug(folderName) || projectFolderSlug(name) || '…'}`
    : null;

  return (
    <motion.div
      className="new-project-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('matosNewProject.title')}
      data-testid="matos-new-project-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !creating) onClose();
      }}
      variants={modalOverlay}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className="new-project-modal matos-np"
        variants={modalContent}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <header className="new-project-modal__head">
          <h2 className="new-project-modal__title">{t('matosNewProject.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            className="new-project-modal__close"
            onClick={onClose}
            disabled={creating}
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="new-project-modal__body matos-np__body">
          <div className="matos-np__scroll">
            {/* Name */}
            <section className="matos-np__section">
              <label className="matos-np__label" htmlFor="matos-np-name">
                {t('matosNewProject.nameLabel')}
              </label>
              <input
                id="matos-np-name"
                className="matos-np__input matos-np__input--name"
                data-testid="matos-np-name"
                placeholder={t('matosNewProject.namePlaceholder')}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </section>

            {/* Mission */}
            <section className="matos-np__section">
              <label className="matos-np__label" htmlFor="matos-np-goal">
                {t('matosNewProject.goalLabel')}
              </label>
              <textarea
                id="matos-np-goal"
                className="matos-np__textarea"
                data-testid="matos-np-goal"
                placeholder={t('matosNewProject.goalPlaceholder')}
                value={goal}
                rows={3}
                maxLength={4000}
                onChange={(e) => setGoal(e.target.value)}
              />
              <p className="matos-np__hint">{t('matosNewProject.goalHint')}</p>
            </section>

            {/* Members */}
            <section className="matos-np__section">
              <div className="matos-np__label-row">
                <label className="matos-np__label">
                  {t('matosNewProject.membersLabel')}
                  {selectedMemberCount > 0 ? (
                    <span className="matos-np__count">{selectedMemberCount}</span>
                  ) : null}
                </label>
              </div>
              <div className="matos-np__members" data-testid="matos-np-members">
                {members.map((row) => {
                  const initial = (row.name.trim() || roleNameOf(row.ref) || '?')
                    .slice(0, 1)
                    .toUpperCase();
                  return (
                    <div className="matos-np__member-card" key={row.key}>
                      <div className="matos-np__member-head">
                        <span
                          className="matos-np__member-avatar"
                          aria-hidden
                          style={
                            row.ref
                              ? { background: `hsl(${memberAvatarHue(row.ref)} 62% 46%)`, color: '#fff' }
                              : undefined
                          }
                        >
                          {row.ref ? initial : <Icon name="bot" size={14} />}
                        </span>
                        <select
                          className="matos-np__select"
                          data-testid={`matos-np-member-role-${row.key}`}
                          value={row.ref}
                          onChange={(e) => updateMember(row.key, { ref: e.target.value })}
                          aria-label={t('matosNewProject.memberRolePlaceholder')}
                        >
                          <option value="">{t('matosNewProject.memberRolePlaceholder')}</option>
                          {roleOptions.map((option) => (
                            <option
                              key={option.ref}
                              value={option.ref}
                              disabled={option.ref !== row.ref && pickedRefs.has(option.ref)}
                            >
                              {option.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="matos-np__member-remove"
                          onClick={() => removeMemberRow(row.key)}
                          aria-label={t('matosNewProject.removeMember')}
                          title={t('matosNewProject.removeMember')}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                      <div className="matos-np__member-fields">
                        <input
                          className="matos-np__input matos-np__member-name"
                          data-testid={`matos-np-member-name-${row.key}`}
                          placeholder={t('matosNewProject.memberNamePlaceholder')}
                          aria-label={t('matosNewProject.memberNameLabel')}
                          value={row.name}
                          maxLength={MAX_MEMBER_NAME_LEN}
                          disabled={!row.ref}
                          onChange={(e) => updateMember(row.key, { name: e.target.value })}
                        />
                        <input
                          className="matos-np__input matos-np__member-brief"
                          data-testid={`matos-np-member-brief-${row.key}`}
                          placeholder={t('matosNewProject.memberBriefPlaceholder')}
                          value={row.brief}
                          maxLength={600}
                          disabled={!row.ref}
                          onChange={(e) => updateMember(row.key, { brief: e.target.value })}
                        />
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="matos-np__add-member"
                  data-testid="matos-np-add-member"
                  onClick={addMemberRow}
                >
                  <Icon name="plus" size={13} />
                  <span>{t('matosNewProject.addMember')}</span>
                </button>
              </div>
              <p className="matos-np__hint">{t('matosNewProject.membersHint')}</p>
            </section>

            {/* Working folder */}
            <section className="matos-np__section">
              <label className="matos-np__label" htmlFor="matos-np-location">
                {t('matosNewProject.folderLabel')}
              </label>
              <div
                className={`matos-np__folder-row${isManagedLocation ? ' matos-np__folder-row--managed' : ''}`}
              >
                <span className="matos-np__member-icon" aria-hidden>
                  <Icon name="folder" size={14} />
                </span>
                <select
                  id="matos-np-location"
                  className="matos-np__select matos-np__select--location"
                  data-testid="matos-np-location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  {locations.length === 0 ? (
                    <option value={BUILT_IN_LOCATION_ID}>
                      {t('matosNewProject.folderManaged')}
                    </option>
                  ) : null}
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.builtIn ? t('matosNewProject.folderManaged') : `${loc.name} — ${loc.path}`}
                    </option>
                  ))}
                </select>
                {!isManagedLocation ? (
                  <input
                    className="matos-np__input matos-np__folder-name"
                    data-testid="matos-np-folder-name"
                    aria-label={t('matosNewProject.folderNameLabel')}
                    placeholder={t('matosNewProject.folderNameLabel')}
                    value={folderName}
                    maxLength={48}
                    onChange={(e) => {
                      setFolderTouched(true);
                      setFolderName(projectFolderSlug(e.target.value) || e.target.value.trim().toLowerCase());
                    }}
                  />
                ) : null}
              </div>
              {previewFolder ? (
                <p className="matos-np__hint matos-np__hint--path" data-testid="matos-np-folder-preview">
                  {previewFolder}
                </p>
              ) : null}
              <p className="matos-np__hint">{t('matosNewProject.folderHint')}</p>
            </section>
          </div>

          <button
            type="button"
            className="primary newproj-create matos-np__create"
            data-testid="matos-np-create"
            disabled={creating || !name.trim()}
            onClick={() => {
              void handleCreate();
            }}
          >
            <Icon name="plus" size={14} />
            <span>{creating ? t('matosNewProject.creating') : t('matosNewProject.create')}</span>
          </button>

          {creating ? (
            <div className="new-project-modal__status" role="status">
              {t('matosNewProject.creating')}
            </div>
          ) : null}
          {error ? (
            <div className="new-project-modal__status error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </motion.div>
    </motion.div>
  );
}
