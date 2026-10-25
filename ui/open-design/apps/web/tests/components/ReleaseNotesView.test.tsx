// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReleaseNotesView } from '../../src/components/ReleaseNotesView';
import { MATOS_RELEASE_NOTES } from '../../src/content/releaseNotes';
import { I18nProvider, type Locale } from '../../src/i18n';

afterEach(cleanup);

function renderReleaseNotes(locale: Locale = 'en') {
  return render(
    <I18nProvider initial={locale}>
      <ReleaseNotesView />
    </I18nProvider>,
  );
}

describe('ReleaseNotesView', () => {
  it('renders repository-owned releases', () => {
    renderReleaseNotes();

    expect(screen.getByRole('heading', { name: 'Release notes' })).toBeTruthy();
    expect(screen.getAllByTestId('release-note')).toHaveLength(MATOS_RELEASE_NOTES.length);
    expect(screen.getByText('MatOS 1.0')).toBeTruthy();
  });

  it('searches across release titles, summaries, and sections', () => {
    renderReleaseNotes();

    fireEvent.change(
      screen.getByPlaceholderText('Search versions, features, or fixes…'),
      { target: { value: 'ResearchClawBench' } },
    );
    expect(screen.getAllByTestId('release-note')).toHaveLength(1);

    fireEvent.change(
      screen.getByPlaceholderText('Search versions, features, or fixes…'),
      { target: { value: 'does-not-exist' } },
    );
    expect(screen.getByTestId('release-notes-empty')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getAllByTestId('release-note')).toHaveLength(MATOS_RELEASE_NOTES.length);
  });

  it('filters by topic', () => {
    renderReleaseNotes();

    fireEvent.click(screen.getByRole('button', { name: 'Benchmarks' }));
    expect(screen.getAllByTestId('release-note')).toHaveLength(1);
  });

  it('uses Chinese release copy in a Chinese workspace', () => {
    renderReleaseNotes('zh-CN');

    expect(screen.getByRole('heading', { name: '发布说明' })).toBeTruthy();
    expect(screen.getByText('科学工作区')).toBeTruthy();
  });

  it('describes only the public product surface', () => {
    const content = JSON.stringify(MATOS_RELEASE_NOTES).toLocaleLowerCase('en');
    for (const internal of ['gitee', 'coze', 'tos', 'feishu', 'gateway', 'openvscode']) {
      expect(content).not.toMatch(new RegExp(`\\b${internal}\\b`));
    }
    expect(MATOS_RELEASE_NOTES.filter((release) => release.latest)).toHaveLength(1);
  });
});
