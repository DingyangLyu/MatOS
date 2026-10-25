// @vitest-environment jsdom
//
// The conversations composer renders the MatOS role picker through the
// `matosRolePicker` slot (same staged-contexts position the upstream
// design-system picker used). These specs pin the slot contract:
//  - the slot renders inside the staged-contexts row with its own wrapper;
//  - providing only the role picker must NOT light up design-system-only
//    affordances (the "+" menu design-system entry stays hidden).

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';

function renderComposer(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  return render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onOpenMcpSettings={vi.fn()}
      skills={[]}
      {...overrides}
    />,
  );
}

// Flush the composer's lazy mount fetches (MCP servers, plugins).
async function flushMounts() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ChatComposer matosRolePicker slot', () => {
  it('renders the role picker slot inside the staged-contexts row', async () => {
    renderComposer({
      matosRolePicker: (
        <button type="button" data-testid="matos-role-slot-probe">
          Compute
        </button>
      ),
    });
    await flushMounts();

    const staged = screen.getByTestId('staged-contexts');
    const wrap = staged.querySelector('.staged-context-picker--matos-role');
    expect(wrap).toBeTruthy();
    expect(wrap!.querySelector('[data-testid="matos-role-slot-probe"]')).toBeTruthy();
    // No design-system wrapper appears when only the role picker is slotted.
    expect(staged.querySelector('.staged-context-picker--design-system')).toBeNull();
  });

  it('keeps the "+" menu design-system entry gated on the design-system slot', async () => {
    renderComposer({
      matosRolePicker: <button type="button">Compute</button>,
    });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    await screen.findByTestId('composer-plus-reference-project');
    expect(screen.queryByTestId('composer-plus-design-system')).toBeNull();
  });

});
