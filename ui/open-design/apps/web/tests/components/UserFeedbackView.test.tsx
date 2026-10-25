// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackIssueListResponse } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import {
  UserFeedbackView,
  buildFixHeatmap,
} from '../../src/components/UserFeedbackView';

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const issueList: FeedbackIssueListResponse = {
  issues: [
    {
      id: 'feedback-20260709120000000-old001',
      createdAt: '2026-07-09T12:00:00.000Z',
      updatedAt: '2026-07-09T12:00:00.000Z',
      resolvedAt: null,
      status: 'open',
      kind: 'bug',
      severity: 'high',
      title: 'Older preview issue',
      message: 'The preview was blank.',
      messagePreview: 'The preview was blank.',
      contact: '',
      context: { sourcePath: '/projects/demo' },
      attachments: [],
      viewerAccess: 'full',
    },
    {
      id: 'feedback-20260710120000000-new001',
      createdAt: '2026-07-10T12:00:00.000Z',
      updatedAt: '2026-07-10T13:00:00.000Z',
      resolvedAt: '2026-07-10T13:00:00.000Z',
      status: 'resolved',
      kind: 'suggestion',
      severity: 'normal',
      title: 'Newer workflow suggestion',
      message: 'Show the latest run at the top.',
      messagePreview: 'Show the latest run at the top.',
      contact: '',
      context: { note: 'Useful in long projects.' },
      attachments: [{
        id: 'image-1-abc12345',
        name: 'workflow.png',
        mimeType: 'image/png',
        size: 16,
        url: '/api/matos/feedback/feedback-20260710120000000-new001/attachments/image-1-abc12345',
      }],
      viewerAccess: 'full',
    },
  ],
  summary: {
    total: 2,
    fixedTotal: 1,
    statusCounts: { open: 1, resolved: 1 },
    resolvedDaily: { '2026-07-10': 1 },
  },
};

function renderFeedback() {
  return render(
    <I18nProvider initial="en">
      <UserFeedbackView />
    </I18nProvider>,
  );
}

describe('UserFeedbackView', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:feedback-preview');
    URL.revokeObjectURL = vi.fn();
    window.sessionStorage.setItem('matos.feedback.sourcePath', '/projects/source-project');
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders real counts, the repair heatmap, and newest issues first', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(issueList), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { container } = renderFeedback();

    expect(await screen.findByRole('heading', { name: 'Issues & suggestions' })).toBeTruthy();
    expect(screen.getByText('Bug-fix activity')).toBeTruthy();
    expect(screen.getByText('1 fixed in the last year')).toBeTruthy();
    const titles = Array.from(container.querySelectorAll('.user-feedback__issue-title-row > strong'))
      .map((node) => node.textContent);
    expect(titles).toEqual(['Newer workflow suggestion', 'Older preview issue']);

    fireEvent.click(screen.getByRole('button', { name: /Newer workflow suggestion/ }));
    expect(screen.getAllByText('Show the latest run at the top.')).toHaveLength(2);
    expect(screen.getByAltText('workflow.png')).toBeTruthy();
  });

  it('shows the response status when the feedback service is stale or unavailable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Cannot GET /api/matos/feedback', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }));
    renderFeedback();

    expect(await screen.findByText(/HTTP 404/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows another user issue title without exposing or expanding its details', async () => {
    const titleOnlyIssue = {
      ...issueList.issues[0]!,
      message: '',
      messagePreview: '',
      context: {},
      attachments: [],
      viewerAccess: 'title' as const,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      issues: [titleOnlyIssue],
      summary: issueList.summary,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    renderFeedback();

    const issueButton = await screen.findByRole('button', { name: /Older preview issue/ });
    expect(issueButton).toBeDisabled();
    expect(issueButton).toHaveAttribute('title', 'Details are visible to administrators only');
    expect(screen.queryByText('The preview was blank.')).toBeNull();
  });

  it('keeps a title-only submission collapsed instead of expanding an empty admin detail', async () => {
    const titleOnlyIssue = {
      ...issueList.issues[0]!,
      id: 'feedback-20260711090000000-mine01',
      title: 'My own report',
      message: '',
      messagePreview: '',
      context: {},
      attachments: [],
      viewerAccess: 'title' as const,
    };
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ issue: titleOnlyIssue }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        issues: [titleOnlyIssue],
        summary: issueList.summary,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { container } = renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'My own report' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Something broke.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));

    await screen.findByText(/Submitted feedback-20260711090000000-mine01/);
    expect(container.querySelector('.user-feedback__issue-detail')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /My own report/ })).toBeNull();
  });

  it('filters issues by search text across title, id, and preview', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(issueList), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    const search = screen.getByRole('searchbox', { name: 'Search title, ID, or content' });
    fireEvent.change(search, { target: { value: 'preview was blank' } });
    expect(screen.getByText('Older preview issue')).toBeTruthy();
    expect(screen.queryByText('Newer workflow suggestion')).toBeNull();

    fireEvent.change(search, { target: { value: 'no-such-issue' } });
    expect(screen.getByText('No matching issues')).toBeTruthy();
  });

  it('shows per-status counts on the filter chips including not-planned', async () => {
    const rejectedIssue = {
      ...issueList.issues[0]!,
      id: 'feedback-20260708120000000-rej001',
      title: 'Rejected idea',
      status: 'rejected' as const,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      issues: [...issueList.issues, rejectedIssue],
      summary: { ...issueList.summary, total: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    const allChip = screen.getByRole('button', { name: /^All/ });
    expect(allChip.querySelector('.user-feedback__filter-count')?.textContent).toBe('3');
    const rejectedChip = screen.getByRole('button', { name: /^Not planned/ });
    expect(rejectedChip.querySelector('.user-feedback__filter-count')?.textContent).toBe('1');

    fireEvent.click(rejectedChip);
    expect(screen.getByText('Rejected idea')).toBeTruthy();
    expect(screen.queryByText('Older preview issue')).toBeNull();
  });

  it('attaches images pasted from the clipboard', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(issueList), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { container } = renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    const pasted = new File(
      [Buffer.from('89504e470d0a1a0a', 'hex')],
      'pasted.png',
      { type: 'image/png' },
    );
    fireEvent.paste(container.querySelector('.user-feedback__form') as HTMLFormElement, {
      clipboardData: { files: [pasted] },
    });
    expect(await screen.findByText('pasted.png')).toBeTruthy();
  });

  it('restores an unsent composer draft from session storage', async () => {
    window.sessionStorage.setItem('matos.feedback.draft', JSON.stringify({
      kind: 'suggestion',
      severity: 'high',
      title: 'Draft title',
      message: 'Draft body',
      contextNote: 'Draft note',
    }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(issueList), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    expect(screen.getByLabelText(/Title/)).toHaveValue('Draft title');
    expect(screen.getByLabelText(/Description/)).toHaveValue('Draft body');
    expect(screen.getByLabelText(/Additional context/)).toHaveValue('Draft note');
    expect(screen.getByRole('button', { name: 'Suggestion' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByDisplayValue('High')).toHaveValue('high');
  });

  it('lets an administrator update an expanded issue status', async () => {
    let patchBody: { status?: string } | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as { status?: string };
        return new Response(JSON.stringify({
          issue: {
            ...issueList.issues[1]!,
            status: 'in_progress',
            resolvedAt: null,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(issueList), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    renderFeedback();

    fireEvent.click(await screen.findByRole('button', { name: /Newer workflow suggestion/ }));
    const statusSelect = screen.getByRole('combobox', { name: /Newer workflow suggestion/ });
    fireEvent.change(statusSelect, {
      target: { value: 'in_progress' },
    });

    await waitFor(() => expect(patchBody).toEqual({ status: 'in_progress' }));
    expect(statusSelect).toHaveValue('in_progress');
  });

  it('submits title, content, context, and images through one multipart request', async () => {
    const createdIssue = {
      ...issueList.issues[0]!,
      id: 'feedback-20260710150000000-new002',
      createdAt: '2026-07-10T15:00:00.000Z',
      updatedAt: '2026-07-10T15:00:00.000Z',
      title: 'Canvas toolbar overlaps nodes',
      message: 'The toolbar covers the first workflow node.',
      messagePreview: 'The toolbar covers the first workflow node.',
      attachments: [],
    };
    let submittedForm: FormData | null = null;
    let call = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      if (init?.method === 'POST') {
        submittedForm = init.body as FormData;
        return new Response(JSON.stringify({ issue: createdIssue }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(call > 2
        ? { ...issueList, issues: [createdIssue, ...issueList.issues], summary: { ...issueList.summary, total: 3 } }
        : issueList), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    renderFeedback();
    await screen.findByRole('heading', { name: 'Issues & suggestions' });

    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: 'Canvas toolbar overlaps nodes' },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'The toolbar covers the first workflow node.' },
    });
    fireEvent.change(screen.getByLabelText(/Additional context/), {
      target: { value: 'Happens after zooming to 125%.' },
    });
    const image = new File(
      [Buffer.from('89504e470d0a1a0a', 'hex')],
      'overlap.png',
      { type: 'image/png' },
    );
    fireEvent.change(document.querySelector('#feedback-images') as HTMLInputElement, {
      target: { files: [image] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));

    await waitFor(() => expect(submittedForm).not.toBeNull());
    const form = submittedForm as unknown as FormData;
    expect(form.get('title')).toBe('Canvas toolbar overlaps nodes');
    expect(form.get('message')).toBe('The toolbar covers the first workflow node.');
    expect((form.getAll('images')[0] as File).name).toBe('overlap.png');
    const context = JSON.parse(String(form.get('context'))) as Record<string, string>;
    expect(context.sourcePath).toBe('/projects/source-project');
    expect(context.note).toBe('Happens after zooming to 125%.');
    expect(await screen.findByText(/Submitted feedback-20260710150000000-new002/)).toBeTruthy();
    expect(window.sessionStorage.getItem('matos.feedback.draft')).toBeNull();
  });

  it('paginates large historical backfills six issues at a time', async () => {
    const issues = Array.from({ length: 55 }, (_, index) => ({
      ...issueList.issues[0]!,
      id: `feedback-git-${String(index).padStart(40, '0')}`,
      createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 55 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 55 - index)).toISOString(),
      resolvedAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 55 - index)).toISOString(),
      status: 'resolved' as const,
      title: `Historical issue ${index + 1}`,
    }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      issues,
      summary: {
        total: issues.length,
        fixedTotal: issues.length,
        statusCounts: { resolved: issues.length },
        resolvedDaily: { '2026-07-10': issues.length },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { container } = renderFeedback();

    await screen.findByRole('heading', { name: 'Issues & suggestions' });
    expect(container.querySelectorAll('.user-feedback__issue')).toHaveLength(6);
    expect(screen.getByText('1–6 / 55')).toBeTruthy();
    expect(screen.getByText('Historical issue 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(container.querySelectorAll('.user-feedback__issue')).toHaveLength(6);
    expect(screen.getByText('7–12 / 55')).toBeTruthy();
    expect(screen.queryByText('Historical issue 1')).toBeNull();
    expect(screen.getByText('Historical issue 7')).toBeTruthy();
  });
});

describe('buildFixHeatmap', () => {
  it('uses daily fix counts for levels and excludes future cells', () => {
    const heatmap = buildFixHeatmap(
      {
        '2026-07-07': 1,
        '2026-07-08': 2,
        '2026-07-09': 3,
        '2026-07-10': 6,
      },
      new Date('2026-07-10T12:00:00.000Z'),
    );
    const days = heatmap.weeks.flatMap((week) => week.days).filter(Boolean);
    expect(days.find((day) => day?.date === '2026-07-07')?.level).toBe(1);
    expect(days.find((day) => day?.date === '2026-07-08')?.level).toBe(2);
    expect(days.find((day) => day?.date === '2026-07-09')?.level).toBe(3);
    expect(days.find((day) => day?.date === '2026-07-10')?.level).toBe(4);
    expect(heatmap.visibleTotal).toBe(12);
  });
});
