// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import type { Project } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async (projectId: string, name: string) => {
    if (projectId === 'project-ds' && name === 'brand.json') {
      return JSON.stringify({
        logo: { primary: 'logos/favicon-1.png' },
        imagery: { samples: [{ file: 'imagery/cover-0.png', kind: 'cover' }] },
      });
    }
    if (projectId === 'project-ds-fallback' && name === 'brand.json') {
      return JSON.stringify({
        logo: {
          primary: 'logos/favicon-1.png',
          alternates: ['logos/wordmark.svg'],
        },
      });
    }
    return null;
  }),
  fetchProjectPreviewFiles: vi.fn(async (projectId: string) => {
    if (projectId === 'project-ds') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4 },
        { name: 'cover-0.png', path: 'imagery/cover-0.png', kind: 'image', mtime: 3 },
      ];
    }
    if (projectId === 'project-ds-fallback') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4 },
        { name: 'wordmark.svg', path: 'logos/wordmark.svg', kind: 'image', mtime: 3 },
      ];
    }
    if (projectId === 'project-html') {
      return [{ name: 'index.html', kind: 'html', mtime: 2 }];
    }
    if (projectId === 'project-deck') {
      return [{ name: 'index.html', kind: 'html', mtime: 2 }];
    }
    return [];
  }),
  projectFileUrl: (projectId: string, fileName: string) =>
    `/api/projects/${projectId}/files/${fileName}`,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    skillId: null,
    createdAt: 1,
    updatedAt: 2,
    status: { value: 'not_started' },
    ...overrides,
  };
}

function projects(count: number): Project[] {
  return Array.from({ length: count }, (_, index) =>
    project({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      updatedAt: count - index,
    }),
  );
}

describe('RecentProjectsStrip', () => {
  it('shows seven projects when the row has room for a seventh card', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1332 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container } = render(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(7);
    });
  });

  it('keeps six projects when the row is below the wide-card threshold', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1331 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container } = render(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(6);
  });

  it('remeasures when projects arrive after the initial empty render', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1400,
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1331 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container, rerender } = render(
      <RecentProjectsStrip
        projects={[]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    rerender(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(6);
  });

  it('marks legacy shared-workspace imports as imported projects', () => {
    const { container } = render(
      <RecentProjectsStrip
        projects={[
          project({
            id: 'project-shared',
            name: 'Shared calculation',
            metadata: {
              kind: 'other',
              importedFrom: 'project-location',
              projectLocationId: 'shared-workspaces',
            },
          }),
        ]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    const card = container.querySelector('[data-project-boundary="shared-with-me"]');
    expect(card).toBeTruthy();
    expect(screen.getByText('Imported project')).toBeTruthy();
  });

  it('renders deck project covers without deck navigation controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => `
          <!doctype html>
          <html>
            <head><title>Deck</title></head>
            <body>
              <section class="slide active">First slide</section>
              <section class="slide">Second slide</section>
              <div class="deck-counter"><button id="deck-prev">‹</button><span>1 / 10</span><button id="deck-next">›</button></div>
              <nav class="page-flip-controls" aria-label="Pagination">01 / 10</nav>
            </body>
          </html>
        `,
      })),
    );

    const { container } = render(
      <RecentProjectsStrip
        projects={[
          project({
            id: 'project-deck',
            name: 'Simple Deck',
            updatedAt: 4,
            metadata: { kind: 'deck' },
          }),
          project({
            id: 'project-html',
            name: 'Web Prototype',
            updatedAt: 3,
          }),
        ]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    const deckCard = container.querySelector('[data-project-id="project-deck"]');
    const htmlCard = container.querySelector('[data-project-id="project-html"]');

    await waitFor(() => {
      const deckIframe = deckCard?.querySelector('iframe') as HTMLIFrameElement | null;
      expect(deckIframe?.getAttribute('srcdoc')).toContain('First slide');
      expect(deckIframe?.getAttribute('srcdoc')).toContain('od-recent-deck-real-preview');
      expect(deckIframe?.getAttribute('srcdoc')).toContain('.page-flip-controls');
      expect(deckIframe?.getAttribute('srcdoc')).toContain('[aria-label="Pagination"]');
      expect(deckIframe?.getAttribute('srcdoc')).not.toContain('<script');
      expect(deckIframe?.getAttribute('src')).toBeNull();
      expect(htmlCard?.querySelector('iframe')?.getAttribute('src')).toBe(
        '/api/projects/project-html/files/index.html',
      );
    });
  });
});
