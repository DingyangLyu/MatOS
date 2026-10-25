// Feishu-style project hub sidebar: conversations, MatOS members, assets.
//
// A project is a folder/department. The sidebar keeps the department's
// surfaces one click away: every conversation (group-chat style list), the
// MatOS roles as "members" (click = open/create that member's DM — a
// conversation bound to the role), and the project's asset drafts. Each
// conversation itself keeps the existing ChatPane style — this component
// only handles switching/creating/renaming/deleting through the handlers
// ProjectView already owns.

import { useEffect, useRef, useState } from 'react';
import type { Conversation, ProjectFile } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import {
  findByRoleRef,
  roleRefIdentity,
  roleRefRecordValue,
  sameRoleRef,
} from '../utils/roleRefs';
import { isWorkflowFileName } from './workflow-model';
import { Icon } from './Icon';

const COLLAPSE_KEY = 'od-project-chats-collapsed';

// --- MatOS members (roles) ---------------------------------------------------

export interface ProjectMemberRole {
  ref: string;
  id: string;
  /** Display name — the per-project custom alias when set, else the role name. */
  name: string;
  /** Underlying catalog role name, kept for a secondary label when aliased. */
  roleName: string;
  /** True when `name` is a project custom alias (differs from `roleName`). */
  aliased: boolean;
  description?: string | null;
}

let memberRolesCache: ProjectMemberRole[] | null = null;

/**
 * The full MatOS role catalog (`/api/matos/roles`). This is the invite
 * *source* — the project's own member roster is a subset chosen from it. The
 * sidebar no longer lists every catalog role as a member; it resolves invited
 * refs against this catalog for display names and feeds the invite dialog.
 */
export function useMemberRoles(): ProjectMemberRole[] {
  const [roles, setRoles] = useState<ProjectMemberRole[]>(memberRolesCache ?? []);
  useEffect(() => {
    if (memberRolesCache) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/matos/roles');
        if (!resp.ok) return;
        const payload = (await resp.json()) as {
          roles?: Array<{ ref?: string; id?: string; name?: string; description?: string | null }>;
        };
        const list = (payload.roles ?? [])
          .filter(
            (role): role is { ref: string; id?: string; name?: string; description?: string | null } =>
              typeof role.ref === 'string' && role.ref.startsWith('role:'),
          )
          .map((role) => {
            const roleName = role.name ?? role.ref.replace(/^role:/, '');
            return {
              ref: role.ref,
              id: role.id ?? role.ref.replace(/^role:/, ''),
              name: roleName,
              roleName,
              aliased: false,
              description: role.description ?? null,
            } satisfies ProjectMemberRole;
          });
        memberRolesCache = list;
        if (!cancelled) setRoles(list);
      } catch {
        // catalog simply stays empty when the bridge is unavailable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return roles;
}

/**
 * Resolve the project's invited member refs into display rows. Unknown refs
 * (a role that was renamed/removed from the catalog) still render with a
 * ref-derived fallback name so an invited member never silently disappears.
 *
 * `nameOverrides` is the project's `metadata.memberNames` alias map: when a
 * ref has an alias the row's `name` becomes that alias (and `aliased` is set),
 * while `roleName` keeps the underlying catalog name for a secondary label.
 * This is the single place custom member names enter the runtime, so the
 * sidebar, group @-bar, group-chat roster header, and auto-relay parsing all
 * see the same display name.
 */
export function resolveProjectMembers(
  memberRefs: string[],
  catalog: ProjectMemberRole[],
  nameOverrides?: Record<string, string> | null,
): ProjectMemberRole[] {
  const seen = new Set<string>();
  const out: ProjectMemberRole[] = [];
  for (const ref of memberRefs) {
    if (typeof ref !== 'string' || !ref.startsWith('role:')) continue;
    // Version-agnostic identity: dedupe, catalog matching, and alias lookup
    // must all survive a role asset version bump (`role:x@0.1.0` roster vs
    // `role:x@0.2.0` catalog), or the member renders as an unknown fallback.
    const identity = roleRefIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const match = findByRoleRef(catalog, ref);
    const roleName = match?.roleName ?? match?.name ?? identity.replace(/^role:/, '');
    const aliasRaw = roleRefRecordValue(nameOverrides, ref);
    const alias = typeof aliasRaw === 'string' ? aliasRaw.trim() : '';
    out.push({
      ref,
      id: match?.id ?? identity.replace(/^role:/, ''),
      name: alias || roleName,
      roleName,
      aliased: alias.length > 0 && alias !== roleName,
      description: match?.description ?? null,
    });
  }
  return out;
}

/**
 * Short display name for a role ref, preferring the project alias, then the
 * catalog name. `nameOverrides` is `metadata.memberNames`.
 */
function roleDisplayName(
  roleRef: string,
  roles: ProjectMemberRole[],
  nameOverrides?: Record<string, string> | null,
): string {
  const aliasRaw = roleRefRecordValue(nameOverrides, roleRef);
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim() : '';
  if (alias) return alias;
  const match = findByRoleRef(roles, roleRef);
  return match?.roleName ?? match?.name ?? roleRefIdentity(roleRef).replace(/^role:/, '');
}

// --- project asset drafts ------------------------------------------------------

const ASSET_ENTRY_TYPES: Record<string, string> = {
  'KNOWLEDGE.md': 'knowledge',
  'SKILL.md': 'skill',
  'TOOL.md': 'tool',
  'ROLE.md': 'role',
  'DATA.md': 'data',
};

export interface ProjectAssetDraft {
  file: ProjectFile;
  assetType: string;
}

/** Project files that are MatOS asset drafts (seeded entry files). */
export function projectAssetDrafts(files: ProjectFile[]): ProjectAssetDraft[] {
  const drafts: ProjectAssetDraft[] = [];
  for (const file of files) {
    const base = file.name.split('/').pop() ?? file.name;
    if (isWorkflowFileName(base)) {
      drafts.push({ file, assetType: 'workflow' });
      continue;
    }
    const type = ASSET_ENTRY_TYPES[base];
    if (type) drafts.push({ file, assetType: type });
  }
  return drafts.sort((a, b) => a.file.name.localeCompare(b.file.name));
}

function relativeLabel(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface Props {
  conversations: Conversation[];
  activeConversationId: string | null;
  /** True when the project shows the file-manager landing (focus mode). */
  filesActive: boolean;
  creatingConversation: boolean;
  projectFiles: ProjectFile[];
  /**
   * 'sidebar' (default): the desktop left column, collapsible.
   * 'page': a full-width page of the phone swipe pager (hub | chat | canvas);
   * no collapse affordance — swiping back to the chat page replaces it.
   */
  variant?: 'sidebar' | 'page';
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onOpenFiles: () => void;
  /** The project's invited member roster (`role:<id>` refs). */
  projectMemberRefs: string[];
  /** Per-member responsibility notes (`metadata.memberBriefs`) keyed by ref. */
  memberBriefs?: Record<string, string>;
  /** Per-member custom display names (`metadata.memberNames`) keyed by ref. */
  memberNames?: Record<string, string>;
  /** Open the invite dialog to add/remove project members. */
  onInviteMembers: () => void;
  /** Start a group chat seeded with the project's member roster. */
  onStartGroupChat: () => void;
  /** Open (or create) the member DM for a role. */
  onOpenMemberChat: (roleRef: string, roleName: string) => void;
  /** Open an asset draft file in the workspace. */
  onOpenAssetFile: (name: string) => void;
  /** Open the native MatOS asset selector for this project. */
  onManageAssets?: () => void;
  /** Number of native assets persistently selected for this project. */
  selectedAssetCount?: number;
  /** Create/manage cross-user project invite links. */
}

export function ProjectConversationsSidebar({
  conversations,
  activeConversationId,
  filesActive,
  creatingConversation,
  projectFiles,
  variant = 'sidebar',
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
  onOpenFiles,
  projectMemberRefs,
  memberBriefs,
  memberNames,
  onInviteMembers,
  onStartGroupChat,
  onOpenMemberChat,
  onOpenAssetFile,
  onManageAssets,
  selectedAssetCount = 0,
}: Props) {
  const { locale, t } = useI18n();
  const zh = locale.toLowerCase().startsWith('zh');
  const projectAssetsLabel = zh ? '项目资产' : 'Project assets';
  const roles = useMemberRoles();
  const members = resolveProjectMembers(projectMemberRefs, roles, memberNames);
  const assetDrafts = projectAssetDrafts(projectFiles);
  const isPage = variant === 'page';
  const [collapsedPref, setCollapsedPref] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // The phone pager page is never collapsed — swiping away IS the collapse.
  const collapsed = isPage ? false : collapsedPref;
  const [membersOpen, setMembersOpen] = useState(true);
  const [assetsOpen, setAssetsOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  const toggleCollapsed = () => {
    setCollapsedPref((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // best-effort preference
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <aside className="pcs pcs-collapsed" data-testid="project-chats-sidebar">
        <button
          type="button"
          className="pcs-icon-btn"
          title={t('project.chatsExpand')}
          aria-label={t('project.chatsExpand')}
          onClick={toggleCollapsed}
          data-testid="project-chats-expand"
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <button
          type="button"
          className={`pcs-icon-btn${filesActive ? ' is-active' : ''}`}
          title={t('project.filesEntry')}
          aria-label={t('project.filesEntry')}
          onClick={onOpenFiles}
        >
          <Icon name="folder" size={14} />
        </button>
        <button
          type="button"
          className="pcs-icon-btn"
          title={t('chat.new')}
          aria-label={t('chat.new')}
          disabled={creatingConversation}
          onClick={onNewConversation}
        >
          <Icon name="plus" size={14} />
        </button>
        {onManageAssets ? (
          <button
            type="button"
            className="pcs-collapsed-action"
            title={projectAssetsLabel}
            aria-label={projectAssetsLabel}
            onClick={onManageAssets}
            data-testid="project-manage-assets"
          >
            <Icon name="blocks" size={14} />
            <span>{projectAssetsLabel}</span>
            {selectedAssetCount > 0 ? <strong>{selectedAssetCount}</strong> : null}
          </button>
        ) : null}

      </aside>
    );
  }

  return (
    <aside
      className={`pcs${isPage ? ' pcs-page' : ''}`}
      data-testid={isPage ? 'project-chats-page' : 'project-chats-sidebar'}
    >
      <div className="pcs-head">
        <span className="pcs-title">{t('chat.conversationsHeading')}</span>
        <button
          type="button"
          className="pcs-icon-btn"
          title={t('chat.new')}
          aria-label={t('chat.new')}
          disabled={creatingConversation}
          onClick={onNewConversation}
          data-testid={isPage ? 'project-chats-page-new' : 'project-chats-new'}
        >
          <Icon name="plus" size={14} />
        </button>
        {isPage ? null : (
          <button
            type="button"
            className="pcs-icon-btn"
            title={t('project.chatsCollapse')}
            aria-label={t('project.chatsCollapse')}
            onClick={toggleCollapsed}
          >
            <Icon name="chevron-left" size={14} />
          </button>
        )}
      </div>
      <button
        type="button"
        className={`pcs-files${filesActive ? ' is-active' : ''}`}
        onClick={onOpenFiles}
        data-testid="project-chats-files"
      >
        <span className="pcs-row-icon">
          <Icon name="folder" size={14} />
        </span>
        <span className="pcs-row-title">{t('project.filesEntry')}</span>
      </button>
      {onManageAssets ? (
        <div className="pcs-project-actions" data-testid="project-access-actions">
          {onManageAssets ? (
            <button type="button" onClick={onManageAssets} data-testid="project-manage-assets">
              <Icon name="blocks" size={13} />
              <span>{projectAssetsLabel}</span>
              {selectedAssetCount > 0 ? <strong>{selectedAssetCount}</strong> : null}
            </button>
          ) : null}

        </div>
      ) : null}
      <div className="pcs-scroll">
        <div className="pcs-list" data-testid="project-chats-list">
          {conversations.map((conversation) => {
            const active = !filesActive && conversation.id === activeConversationId;
            const title = conversation.title || t('chat.untitledConversation');
            const groupMemberCount =
              Array.isArray(conversation.memberRefs) && conversation.memberRefs.length > 1
                ? conversation.memberRefs.length
                : 0;
            const isGroup = groupMemberCount > 0;
            const boundRole =
              !isGroup && typeof conversation.roleRef === 'string' && conversation.roleRef
                ? roleDisplayName(conversation.roleRef, roles, memberNames)
                : null;
            return (
              <div
                key={conversation.id}
                className={`pcs-row${active ? ' is-active' : ''}`}
                data-testid={`project-chat-row-${conversation.id}`}
              >
                {renamingId === conversation.id ? (
                  <input
                    ref={renameInputRef}
                    className="pcs-rename"
                    defaultValue={conversation.title ?? ''}
                    placeholder={t('chat.untitledConversation')}
                    onBlur={(event) => {
                      setRenamingId(null);
                      const next = event.target.value.trim();
                      if (next !== (conversation.title ?? '')) {
                        onRenameConversation(conversation.id, next);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                      if (event.key === 'Escape') {
                        (event.target as HTMLInputElement).value = conversation.title ?? '';
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="pcs-row-main"
                    onClick={() => onSelectConversation(conversation.id)}
                    onDoubleClick={() => setRenamingId(conversation.id)}
                    title={title}
                  >
                    <span className="pcs-row-icon">
                      <Icon
                        name={isGroup ? 'users' : boundRole ? 'sparkles' : 'comment'}
                        size={13}
                      />
                    </span>
                    <span className="pcs-row-text">
                      <span className="pcs-row-title">{title}</span>
                      <span className="pcs-row-meta">
                        {isGroup ? (
                          <span className="pcs-role-tag" title={(conversation.memberRefs ?? []).join(', ')}>
                            {t('project.groupMemberCount', { count: groupMemberCount })}
                          </span>
                        ) : boundRole ? (
                          <span className="pcs-role-tag" title={conversation.roleRef ?? ''}>
                            {boundRole}
                          </span>
                        ) : null}
                        {typeof conversation.messageCount === 'number'
                          ? `${conversation.messageCount} · `
                          : ''}
                        {relativeLabel(conversation.updatedAt || conversation.createdAt, t)}
                      </span>
                    </span>
                  </button>
                )}
                <span className="pcs-row-actions">
                  <button
                    type="button"
                    className="pcs-icon-btn"
                    title={t('project.renameChat')}
                    aria-label={t('project.renameChat')}
                    onClick={() => setRenamingId(conversation.id)}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                  <button
                    type="button"
                    className="pcs-icon-btn pcs-danger"
                    title={t('chat.deleteConversation')}
                    aria-label={t('chat.deleteConversation')}
                    onClick={() => onDeleteConversation(conversation.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </div>
            );
          })}
          {conversations.length === 0 ? (
            <div className="pcs-empty">{t('chat.emptyConversations')}</div>
          ) : null}
        </div>

        <div className="pcs-section" data-testid="project-members-section">
          <button
            type="button"
            className="pcs-section-head"
            aria-expanded={membersOpen}
            onClick={() => setMembersOpen((open) => !open)}
          >
            <span className={`pcs-section-chevron${membersOpen ? ' is-open' : ''}`} aria-hidden>
              <Icon name="chevron-right" size={11} />
            </span>
            <span className="pcs-section-title">{t('project.members')}</span>
            <span className="pcs-section-count">{members.length}</span>
            <span
              className="pcs-icon-btn pcs-section-action"
              role="button"
              tabIndex={0}
              title={t('project.inviteMembers')}
              aria-label={t('project.inviteMembers')}
              data-testid="project-members-invite"
              onClick={(event) => {
                event.stopPropagation();
                onInviteMembers();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onInviteMembers();
                }
              }}
            >
              <Icon name="plus" size={12} />
            </span>
          </button>
          {membersOpen ? (
            members.length > 0 ? (
              <>
                {members.length > 1 ? (
                  <button
                    type="button"
                    className="pcs-row pcs-group-start"
                    data-testid="project-start-group-chat"
                    title={t('project.startGroupChatHint')}
                    onClick={onStartGroupChat}
                  >
                    <span className="pcs-row-icon">
                      <Icon name="users" size={13} />
                    </span>
                    <span className="pcs-row-text">
                      <span className="pcs-row-title">{t('project.startGroupChat')}</span>
                      <span className="pcs-row-meta">
                        {t('project.groupMemberCount', { count: members.length })}
                      </span>
                    </span>
                  </button>
                ) : null}
                {members.map((role) => {
                  const hasDm = conversations.some(
                    (c) =>
                      sameRoleRef(c.roleRef, role.ref) &&
                      !(c.memberRefs && c.memberRefs.length > 1),
                  );
                  // The create-form responsibility note beats the generic
                  // "open/start DM" hint — "who does what" is the useful line.
                  // When the member is aliased, lead the meta line with the
                  // underlying role name so "who is this really" stays visible.
                  const brief = memberBriefs?.[role.ref]?.trim();
                  const fallbackHint = hasDm
                    ? t('project.memberOpenDm')
                    : t('project.memberStartDm');
                  const metaParts = [
                    role.aliased ? role.roleName : null,
                    brief || (role.aliased ? null : fallbackHint),
                  ].filter((part): part is string => Boolean(part));
                  const metaText = metaParts.length > 0 ? metaParts.join(' · ') : fallbackHint;
                  return (
                    <button
                      key={role.ref}
                      type="button"
                      className="pcs-row pcs-member"
                      data-testid={`project-member-${role.id}`}
                      title={
                        role.aliased
                          ? `${role.name} · ${role.roleName}${brief ? ` — ${brief}` : ''}`
                          : brief ?? role.description ?? role.ref
                      }
                      onClick={() => onOpenMemberChat(role.ref, role.name)}
                    >
                      <span className="pcs-member-avatar" aria-hidden>
                        {(role.name || role.id).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="pcs-row-text">
                        <span className="pcs-row-title">{role.name}</span>
                        <span className="pcs-row-meta">{metaText}</span>
                      </span>
                    </button>
                  );
                })}
              </>
            ) : (
              <button
                type="button"
                className="pcs-members-empty"
                data-testid="project-members-empty"
                onClick={onInviteMembers}
              >
                {t('project.membersEmpty')}
              </button>
            )
          ) : null}
        </div>

        {assetDrafts.length > 0 ? (
          <div className="pcs-section" data-testid="project-assets-section">
            <button
              type="button"
              className="pcs-section-head"
              aria-expanded={assetsOpen}
              onClick={() => setAssetsOpen((open) => !open)}
            >
              <span className={`pcs-section-chevron${assetsOpen ? ' is-open' : ''}`} aria-hidden>
                <Icon name="chevron-right" size={11} />
              </span>
              <span className="pcs-section-title">{t('project.assets')}</span>
              <span className="pcs-section-count">{assetDrafts.length}</span>
            </button>
            {assetsOpen
              ? assetDrafts.map(({ file, assetType }) => (
                  <button
                    key={file.name}
                    type="button"
                    className="pcs-row pcs-asset"
                    data-testid={`project-asset-${file.name}`}
                    title={file.name}
                    onClick={() => onOpenAssetFile(file.name)}
                  >
                    <span className="pcs-row-icon">
                      <Icon
                        name={
                          assetType === 'workflow'
                            ? 'fork'
                            : assetType === 'data'
                              ? 'database'
                              : assetType === 'skill'
                                ? 'lightbulb'
                                : assetType === 'tool'
                                  ? 'hammer'
                                  : assetType === 'role'
                                    ? 'sparkles'
                                    : 'file-text'
                        }
                        size={13}
                      />
                    </span>
                    <span className="pcs-row-text">
                      <span className="pcs-row-title">{file.name.split('/').pop()}</span>
                      <span className="pcs-row-meta">{assetType}</span>
                    </span>
                  </button>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
