// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@open-design/contracts';
import { ProjectConversationsSidebar } from '../../src/components/ProjectConversationsSidebar';
import { I18nProvider } from '../../src/i18n';

// Phone pager hub page: on <=640px viewports the desktop conversations
// sidebar is display:none, so ProjectView renders this same component as a
// full-screen pager page (variant="page") — the phone's only entry point to
// group chats, member DMs, and invites. The page variant must not offer the
// desktop collapse affordance (swiping away IS the collapse) and must keep
// every group-chat entry visible.

function conversation(partial: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    projectId: 'p1',
    title: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    ...partial,
  } as Conversation;
}

const BASE_PROPS = {
  activeConversationId: 'dm-1',
  filesActive: false,
  creatingConversation: false,
  projectFiles: [],
  onSelectConversation: () => {},
  onNewConversation: () => {},
  onDeleteConversation: () => {},
  onRenameConversation: () => {},
  onOpenFiles: () => {},
  projectMemberRefs: ['role:compute', 'role:academic'],
  memberNames: { 'role:compute': '算力老王' },
  onInviteMembers: () => {},
  onStartGroupChat: () => {},
  onOpenMemberChat: () => {},
  onOpenAssetFile: () => {},
};

describe('ProjectConversationsSidebar (phone hub page variant)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders full-page without the desktop collapse affordance', () => {
    render(
      <I18nProvider initial="en">
        <ProjectConversationsSidebar
          {...BASE_PROPS}
          variant="page"
          conversations={[
            conversation({ id: 'grp-1', title: '项目群', memberRefs: ['role:compute', 'role:academic'] }),
            conversation({ id: 'dm-1', title: '算力老王', roleRef: 'role:compute' }),
          ]}
        />
      </I18nProvider>,
    );

    const page = screen.getByTestId('project-chats-page');
    expect(page.classList.contains('pcs-page')).toBe(true);
    // No collapse chevron: swiping back to the chat page replaces it. The
    // desktop-only collapse would render the 44px icon rail inside a
    // full-screen pager page, which is useless on a phone.
    expect(screen.queryByLabelText('Collapse chats')).toBeNull();
    // Group conversation row + member-count badge stay visible (the badge
    // appears on the group row AND the start-group entry meta line).
    expect(screen.getByText('项目群')).toBeTruthy();
    expect(screen.getAllByText('2 members').length).toBeGreaterThan(0);
    // Group-chat start entry renders for a multi-member roster.
    expect(screen.getByTestId('project-start-group-chat')).toBeTruthy();
    // Members render with the project alias applied (also appears as the
    // DM row's role tag, hence getAllByText).
    expect(screen.getAllByText('算力老王').length).toBeGreaterThan(0);
    expect(screen.getByTestId('project-member-compute')).toBeTruthy();
  });

  it('routes conversation picks and group-chat start through the handlers', () => {
    const onSelectConversation = vi.fn();
    const onStartGroupChat = vi.fn();
    render(
      <I18nProvider initial="en">
        <ProjectConversationsSidebar
          {...BASE_PROPS}
          variant="page"
          conversations={[
            conversation({ id: 'grp-1', title: '项目群', memberRefs: ['role:compute', 'role:academic'] }),
          ]}
          onSelectConversation={onSelectConversation}
          onStartGroupChat={onStartGroupChat}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText('项目群'));
    expect(onSelectConversation).toHaveBeenCalledWith('grp-1');
    fireEvent.click(screen.getByTestId('project-start-group-chat'));
    expect(onStartGroupChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop sidebar variant and its collapse toggle unchanged', () => {
    render(
      <I18nProvider initial="en">
        <ProjectConversationsSidebar
          {...BASE_PROPS}
          conversations={[conversation({ id: 'dm-1', title: '算力老王', roleRef: 'role:compute' })]}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('project-chats-sidebar')).toBeTruthy();
    expect(screen.queryByTestId('project-chats-page')).toBeNull();
    expect(screen.getByLabelText('Collapse chats')).toBeTruthy();
  });
});
