// @vitest-environment jsdom

// Red spec for the "composer stays put when the project members sidebar
// collapses" bug: the project split gives the chat column a FIXED pixel track
// (`projectSplitStyle` in ProjectView.tsx), so collapsing the left .pcs
// sidebar (228px -> 44px) shifts the chat pane sideways WITHOUT resizing it.
// The portaled `.chat-composer-fixed-layer` positions off the slot's
// getBoundingClientRect(), re-measured only on slot/pane RESIZE — a pure
// position shift fired nothing, leaving the composer glued to its stale left
// offset. The `.split` host is the one element that DOES resize in this
// scenario, so ChatPane must observe it.

// Polyfill scrollTo for jsdom (not available in jsdom's HTMLElement)
if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  HTMLElement.prototype.scrollTo = function (
    options?: ScrollToOptions | number,
    _y?: number,
  ) {
    if (typeof options === 'object' && options !== null) {
      if (options.top !== undefined) this.scrollTop = options.top;
      if (options.left !== undefined) this.scrollLeft = options.left;
    }
  };
}

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
import type { ChatMessage } from '../../src/types';

// Per-instance ResizeObserver recording so the test can fire ONLY the
// observers whose observed targets actually resized — matching real browser
// semantics: when the sidebar collapses, the fixed-width chat slot/pane do
// NOT resize; only the `.split` grid host does.
type ObserverRecord = { callback: ResizeObserverCallback; targets: Element[] };
let observerRecords: ObserverRecord[];
let rafCallbacks: FrameRequestCallback[];
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

// Controllable geometry for the composer slot. `left` moves when the members
// sidebar collapses; `width`/`bottom` stay fixed (fixed-track chat column).
let slotRect: { left: number; width: number; top: number; bottom: number };

function isComposerSlot(el: Element): boolean {
  return el.classList?.contains('chat-composer-slot') ?? false;
}

beforeEach(() => {
  observerRecords = [];
  rafCallbacks = [];
  slotRect = { left: 240, width: 420, top: 500, bottom: 560 };

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });

  originalResizeObserver = globalThis.ResizeObserver;
  class MockResizeObserver {
    private record: ObserverRecord;
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [] };
      observerRecords.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.push(target);
    }
    unobserve(target: Element) {
      this.record.targets = this.record.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.record.targets = [];
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });

  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isComposerSlot(this)) {
      return {
        x: slotRect.left,
        y: slotRect.top,
        left: slotRect.left,
        right: slotRect.left + slotRect.width,
        top: slotRect.top,
        bottom: slotRect.bottom,
        width: slotRect.width,
        height: slotRect.bottom - slotRect.top,
        toJSON() {},
      } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  } else {
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  }
  observerRecords = [];
  rafCallbacks = [];
});

async function flushFrames() {
  await act(async () => {
    // Effects can schedule follow-up frames from within a frame callback
    // (measure -> setState -> re-measure), so drain until quiet.
    for (let i = 0; i < 5 && rafCallbacks.length > 0; i += 1) {
      const callbacks = rafCallbacks.splice(0);
      callbacks.forEach((callback) => callback(performance.now()));
      await Promise.resolve();
    }
  });
}

/** Fire exactly the ResizeObserver callbacks that observe `el` — real browser
 * behavior when only `el` changed size. */
async function fireResizeFor(el: Element) {
  await act(async () => {
    for (const record of observerRecords) {
      if (record.targets.includes(el)) {
        record.callback(
          [{ target: el } as unknown as ResizeObserverEntry],
          { disconnect() {}, observe() {}, unobserve() {} } as unknown as ResizeObserver,
        );
      }
    }
    await Promise.resolve();
  });
  await flushFrames();
}

const MESSAGES: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'hello', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'hi', createdAt: 2 },
];

/** ChatPane mounted inside the project split layout, mirroring ProjectView:
 * .app.app-with-chats > [.pcs sidebar] + .split > .split-chat-slot > .pane */
function projectLayout() {
  return (
    <div className="app app-with-chats">
      <aside className="pcs" data-testid="members-sidebar" />
      <div className="split">
        <div className="split-chat-slot">
          <ChatPane
            messages={MESSAGES}
            streaming={false}
            error={null}
            projectId="project-1"
            projectFiles={[]}
            onEnsureProject={async () => 'project-1'}
            onSend={() => {}}
            onStop={() => {}}
            conversations={[]}
            activeConversationId={null}
            onSelectConversation={() => {}}
            onDeleteConversation={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

describe('portaled composer repositioning when the members sidebar collapses', () => {
  it('re-measures the slot when the .split host resizes (sidebar collapse shifts a fixed-width chat pane)', async () => {
    const { container } = render(projectLayout());
    await flushFrames();

    const layer = document.querySelector<HTMLElement>('.chat-composer-fixed-layer');
    expect(layer).not.toBeNull();
    expect(layer!.style.left).toBe('240px');

    // Collapse the members sidebar: the chat column keeps its fixed width and
    // merely SHIFTS left; the only element that resizes is the .split host.
    slotRect = { ...slotRect, left: 56 };
    const split = container.querySelector('.split')!;
    await fireResizeFor(split);

    expect(
      document.querySelector<HTMLElement>('.chat-composer-fixed-layer')!.style.left,
    ).toBe('56px');
  });
});
