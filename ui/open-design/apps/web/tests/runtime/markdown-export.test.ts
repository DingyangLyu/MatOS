// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { markdownExportHtml, openMarkdownDocument } from '../../src/runtime/markdown-export';

describe('scientific document export', () => {
  it('renders safe math and preserves tables and code without allowing active HTML', () => {
    const html = markdownExportHtml('# Report\n\n$x_i$\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```tex\n$x$\n```\n\n<script>alert(1)</script>', { title: '</title><script>unsafe</script>' });
    expect(html).toContain('class="katex"');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('$x$');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</title><script>');
  });

  it('resolves nested project images through the existing scoped raw URL', () => {
    const html = markdownExportHtml('![plot](../plot.png)\n\n![root](/api/file.png)', { title: '报告', projectId: 'own-project', fileName: 'reports/result.md' });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.images[0]!.src).toContain('/api/projects/own-project/raw/plot.png');
    expect(doc.images[1]!.src).toMatch(/^http.*\/api\/file.png$/);
    expect(doc.title).toBe('报告');
  });

  it('surfaces blocked popups instead of reporting successful export', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => openMarkdownDocument('Report', { title: 'Report' })).toThrow('Popup blocked');
    open.mockRestore();
  });

  it('keeps headings with their first content block during PDF pagination', () => {
    const html = markdownExportHtml('# Report\n\n## Results\n\nA paragraph.\n\nNext paragraph.', { title: 'Report' });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const group = doc.querySelector('h2')!.parentElement!;
    expect(group.hasAttribute('data-matos-heading-group')).toBe(true);
    expect(group.textContent).toContain('A paragraph.');
    expect(group.textContent).not.toContain('Next paragraph.');
  });
});
