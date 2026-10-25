// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownExportMenu } from '../../src/components/MarkdownExportMenu';
import { exportMarkdownPdf } from '../../src/runtime/markdown-export';
import { exportAsMd } from '../../src/runtime/exports';

vi.mock('../../src/runtime/markdown-export', () => ({ exportMarkdownPdf: vi.fn(), openMarkdownDocument: vi.fn() }));
vi.mock('../../src/runtime/exports', () => ({ exportAsMd: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('MarkdownExportMenu', () => {
  it('exports resolved full history to PDF with project scope', async () => {
    const getMarkdown = vi.fn().mockResolvedValue('Older history\n\n$x^2$');
    render(<MarkdownExportMenu markdown="Visible" title="Report" projectId="own" getMarkdown={getMarkdown} />);
    fireEvent.click(screen.getByTestId('markdown-export-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PDF' }));
    await waitFor(() => expect(exportMarkdownPdf).toHaveBeenCalledWith('Older history\n\n$x^2$', expect.objectContaining({ projectId: 'own' })));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('preserves the original Markdown download and supports Escape focus return', async () => {
    render(<MarkdownExportMenu markdown="$x_i$" title="Report" />);
    const trigger = screen.getByTestId('markdown-export-menu');
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Markdown/ }));
    await waitFor(() => expect(exportAsMd).toHaveBeenCalledWith('$x_i$', 'Report'));
  });

  it('reports failed exports and lets the user try again', async () => {
    vi.mocked(exportMarkdownPdf).mockRejectedValueOnce(new Error('capture failed'));
    render(<MarkdownExportMenu markdown="Report" title="Report" />);
    fireEvent.click(screen.getByTestId('markdown-export-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /PDF/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByTestId('markdown-export-menu') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not export incomplete or empty content', () => {
    const { rerender } = render(<MarkdownExportMenu markdown="stream" title="Report" disabled />);
    expect((screen.getByTestId('markdown-export-menu') as HTMLButtonElement).disabled).toBe(true);
    rerender(<MarkdownExportMenu markdown=" " title="Report" />);
    expect((screen.getByTestId('markdown-export-menu') as HTMLButtonElement).disabled).toBe(true);
  });
});
