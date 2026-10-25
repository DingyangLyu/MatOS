// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UseEverywhereGuidePanel } from '../../src/components/UseEverywhereModal';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('UseEverywhereGuidePanel copy guide', () => {
  afterEach(() => {
    cleanup();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    }
    vi.restoreAllMocks();
  });

  it('copies the native guide without network calls', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<UseEverywhereGuidePanel daemonUrl="http://127.0.0.1:7456" />);
    fireEvent.click(screen.getByTestId('use-everywhere-copy-guide'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('matos login status --json');
    expect(copied).toContain('matos assets list --type mcp --json');
    expect(copied).toContain('/api/matos/workflow/run');
    expect(copied).not.toContain('`od ');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('copies a scientific MCP asset command from the MCP tab', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<UseEverywhereGuidePanel />);
    fireEvent.click(screen.getByTestId('use-everywhere-tab-mcp'));
    const section = screen.getByTestId('use-everywhere-section-mcp');
    const copyButtons = within(section).getAllByRole('button', { name: /copy snippet/i });
    const firstCopy = copyButtons[0];
    expect(firstCopy).toBeDefined();
    fireEvent.click(firstCopy as HTMLButtonElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('matos assets list --type mcp --json');
  });

  it('copies HTTP snippets with the active scoped daemon URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<UseEverywhereGuidePanel daemonUrl="http://workspace.test:8123/" />);
    fireEvent.click(screen.getByTestId('use-everywhere-tab-http'));
    const section = screen.getByTestId('use-everywhere-section-http');
    const copyButtons = within(section).getAllByRole('button', { name: /copy snippet/i });
    const firstCopy = copyButtons[0];
    expect(firstCopy).toBeDefined();
    fireEvent.click(firstCopy as HTMLButtonElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('http://workspace.test:8123/api/matos/assets');
    expect(copied).not.toContain('http://127.0.0.1:7456');
    expect(copied).not.toContain('http://workspace.test:8123//api/');
  });
});
