// MatOS project-as-department member invite dialog.
//
// A project is a department; its members are MatOS roles the user has invited
// from the full role catalog. This dialog is the invite surface: it lists the
// catalog (searchable), lets the user toggle who belongs to this project, and
// give each invited member a per-project custom name (e.g. call `role:compute`
// "算力老王"). It returns the chosen `role:<id>` roster plus the alias map. It
// does NOT run anything — the sidebar turns members into DMs or a group chat,
// each of which still executes through the native `matos --role` CLI path.
//
// Layout note: rows are <button>/<div>, never bare <label>. The shared modal
// chrome ships a global `.modal label { flex-direction: column }` rule for
// stacked form fields; reusing <label> for a horizontal row (as the first
// version did) inherited that rule and stacked the avatar/checkbox/text into a
// broken centered column. Buttons + aria-labels keep the row layout ours.

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogFooter, DialogTitle } from '@open-design/components';
import { useT } from '../i18n';
import { Icon } from './Icon';
import type { ProjectMemberRole } from './ProjectConversationsSidebar';
import styles from './MemberInviteDialog.module.css';

interface Props {
  /** Full MatOS role catalog to invite from. */
  catalog: ProjectMemberRole[];
  /** Currently invited member refs (`role:<id>`). */
  invitedRefs: string[];
  /** Current per-member custom names (`metadata.memberNames`) keyed by ref. */
  invitedNames?: Record<string, string>;
  /** Persist the new roster (deduped `role:<id>`) + alias map (non-default). */
  onSave: (refs: string[], names: Record<string, string>) => void;
  onClose: () => void;
  /** True while the save round-trip is in flight (disables the confirm button). */
  saving?: boolean;
}

const MAX_ALIAS_LEN = 40;

/** Stable avatar accent from the role ref so members read as distinct people. */
function avatarHue(ref: string): number {
  let hash = 0;
  for (let i = 0; i < ref.length; i++) hash = (hash * 31 + ref.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function MemberInviteDialog({
  catalog,
  invitedRefs,
  invitedNames,
  onSave,
  onClose,
  saving = false,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Ordered selection so the "selected" strip mirrors invite order.
  const [selected, setSelected] = useState<string[]>(() =>
    invitedRefs.filter((ref) => typeof ref === 'string' && ref.startsWith('role:')),
  );
  const [names, setNames] = useState<Record<string, string>>(() => ({ ...(invitedNames ?? {}) }));

  const catalogByRef = useMemo(() => {
    const map = new Map<string, ProjectMemberRole>();
    for (const role of catalog) map.set(role.ref, role);
    return map;
  }, [catalog]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((role) => {
      const haystack = `${role.name} ${role.roleName} ${role.id} ${role.description ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [catalog, query]);

  const roleNameOf = (ref: string): string => {
    const match = catalogByRef.get(ref);
    return match?.roleName ?? match?.name ?? ref.replace(/^role:/, '');
  };

  const toggle = (ref: string) => {
    setSelected((current) =>
      current.includes(ref) ? current.filter((r) => r !== ref) : [...current, ref],
    );
  };

  const setAlias = (ref: string, value: string) => {
    setNames((current) => ({ ...current, [ref]: value.slice(0, MAX_ALIAS_LEN) }));
  };

  const handleSave = () => {
    // Keep only aliases that are non-empty AND differ from the role name, so
    // the stored map is minimal and unchanged names fall back to the catalog.
    const cleanedNames: Record<string, string> = {};
    for (const ref of selected) {
      const alias = (names[ref] ?? '').trim();
      if (alias && alias !== roleNameOf(ref)) cleanedNames[ref] = alias;
    }
    onSave(selected, cleanedNames);
  };

  const selectedRoles = selected.map((ref) => {
    const found = catalogByRef.get(ref);
    if (found) return found;
    const id = ref.replace(/^role:/, '');
    return {
      ref,
      id,
      name: id,
      roleName: id,
      aliased: false,
      description: null,
    } satisfies ProjectMemberRole;
  });

  const dialog = (
    <Dialog
      className={styles.dialog}
      ariaLabelledBy="member-invite-title"
      onClose={onClose}
      closeOnEscape
      data-testid="member-invite-dialog"
    >
      <div className={styles.head}>
        <DialogTitle id="member-invite-title" className={styles.title}>
          {t('project.inviteMembers')}
        </DialogTitle>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label={t('common.cancel')}
          disabled={saving}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      <p className={styles.hint}>{t('project.inviteMembersHint')}</p>

      <div className={styles.columns}>
        {/* Catalog picker */}
        <div className={styles.pickerCol}>
          <div className={styles.search}>
            <Icon name="search" size={14} />
            <input
              type="text"
              value={query}
              placeholder={t('project.inviteSearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('project.inviteSearchPlaceholder')}
              autoFocus
            />
          </div>
          <div className={styles.list} data-testid="member-invite-list" role="listbox" aria-multiselectable>
            {filtered.length === 0 ? (
              <div className={styles.empty}>{t('project.inviteNoRoles')}</div>
            ) : (
              filtered.map((role) => {
                const checked = selectedSet.has(role.ref);
                return (
                  <button
                    type="button"
                    key={role.ref}
                    className={`${styles.row}${checked ? ` ${styles.rowSelected}` : ''}`}
                    data-testid={`member-invite-row-${role.id}`}
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(role.ref)}
                  >
                    <span
                      className={styles.avatar}
                      aria-hidden
                      style={{
                        background: `hsl(${avatarHue(role.ref)} 62% 46%)`,
                      }}
                    >
                      {(role.roleName || role.id).slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.text}>
                      <span className={styles.name}>{role.roleName}</span>
                      {role.description ? (
                        <span className={styles.desc}>{role.description}</span>
                      ) : null}
                    </span>
                    <span className={`${styles.check}${checked ? ` ${styles.checkOn}` : ''}`} aria-hidden>
                      <Icon name={checked ? 'check' : 'plus'} size={13} />
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Selected roster with per-member naming */}
        <div className={styles.rosterCol}>
          <div className={styles.rosterHead}>
            <span className={styles.rosterTitle}>{t('project.inviteRosterTitle')}</span>
            <span className={styles.count}>
              {t('project.inviteSelectedCount', { count: selected.length })}
            </span>
          </div>
          {selectedRoles.length === 0 ? (
            <div className={styles.rosterEmpty}>{t('project.inviteRosterEmpty')}</div>
          ) : (
            <div className={styles.roster} data-testid="member-invite-roster">
              {selectedRoles.map((role) => (
                <div className={styles.rosterRow} key={role.ref} data-testid={`member-invite-selected-${role.id}`}>
                  <span
                    className={styles.avatar}
                    aria-hidden
                    style={{ background: `hsl(${avatarHue(role.ref)} 62% 46%)` }}
                  >
                    {((names[role.ref] || role.roleName || role.id).slice(0, 1)).toUpperCase()}
                  </span>
                  <span className={styles.rosterText}>
                    <input
                      className={styles.nameInput}
                      value={names[role.ref] ?? ''}
                      placeholder={role.roleName}
                      maxLength={MAX_ALIAS_LEN}
                      aria-label={t('project.inviteNameLabel', { role: role.roleName })}
                      data-testid={`member-invite-name-${role.id}`}
                      onChange={(event) => setAlias(role.ref, event.target.value)}
                    />
                    <span className={styles.rosterRole}>{role.roleName}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => toggle(role.ref)}
                    aria-label={t('project.inviteRemove', { role: role.roleName })}
                    title={t('project.inviteRemove', { role: role.roleName })}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className={styles.nameHint}>{t('project.inviteNameHint')}</p>
        </div>
      </div>

      <DialogFooter className={styles.footer}>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving}
          data-testid="member-invite-save"
        >
          {t('project.inviteSave')}
        </Button>
      </DialogFooter>
    </Dialog>
  );

  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
