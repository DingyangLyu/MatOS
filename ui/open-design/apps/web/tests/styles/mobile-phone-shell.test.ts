import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellCss = readFileSync(
  new URL('../../src/styles/shell.css', import.meta.url),
  'utf8',
);
const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const terminalCss = readFileSync(
  new URL('../../src/styles/workspace/terminal.css', import.meta.url),
  'utf8',
);
const terminalViewerCss = readFileSync(
  new URL('../../src/components/workspace/TerminalViewer.module.css', import.meta.url),
  'utf8',
);

/** Concatenate the bodies of every `@media <query>` block in the sheet. */
function mediaBlocks(css: string, query: string): string {
  const marker = `@media ${query}`;
  const bodies: string[] = [];
  let cursor = 0;
  while (true) {
    const start = css.indexOf(marker, cursor);
    if (start === -1) break;
    const open = css.indexOf('{', start);
    if (open === -1) throw new Error(`Malformed ${marker}`);
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`Unbalanced braces in ${marker}`);
    bodies.push(css.slice(open + 1, end));
    cursor = end + 1;
  }
  if (bodies.length === 0) throw new Error(`Missing ${marker}`);
  return bodies.join('\n');
}

/** Join the declaration bodies of every rule whose selector list includes `selector`. */
function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [
    ...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g')),
  ];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('phone workspace shell (<=640px)', () => {
  const mobile = mediaBlocks(shellCss, '(max-width: 640px)');

  it('hides the workspace tab strip on non-desktop shells (single top bar)', () => {
    const chrome = cssDeclarations(
      mobile,
      '.workspace-shell:not(.workspace-shell--desktop) .workspace-tabs-chrome.app-chrome-header',
    );
    expect(ruleValue(chrome, 'display')).toBe('none');

    const shell = cssDeclarations(mobile, '.workspace-shell:not(.workspace-shell--desktop)');
    expect(ruleValue(shell, 'grid-template-rows')).toBe('minmax(0, 1fr)');
    expect(ruleValue(shell, '--workspace-tabs-chrome-height')).toBe('0px');
  });

  it('keeps the desktop client strip outside the phone override', () => {
    // The base (non-media) strip rule must survive for the desktop app,
    // where the strip carries the drag region and traffic lights.
    const beforeMobile = shellCss.slice(0, shellCss.indexOf('@media (max-width: 640px)'));
    const base = cssDeclarations(beforeMobile, '.workspace-tabs-chrome.app-chrome-header');
    expect(ruleValue(base, 'height')).toBe('38px');
  });

  it('turns the project split into a horizontal snap pager (chat page first)', () => {
    const split = cssDeclarations(mobile, '.split:not(.split-focus)');
    expect(ruleValue(split, 'display')).toBe('flex');
    expect(ruleValue(split, 'overflow-x')).toBe('auto');
    expect(ruleValue(split, 'scroll-snap-type')).toBe('x mandatory');

    const pages = cssDeclarations(mobile, '.split:not(.split-focus) > .split-chat-slot');
    expect(ruleValue(pages, 'flex')).toBe('0 0 100%');
    expect(ruleValue(pages, 'min-width')).toBe('100%');
    expect(ruleValue(pages, 'scroll-snap-align')).toBe('start');
    expect(ruleValue(pages, 'scroll-snap-stop')).toBe('always');
    // The workspace pane is the second page of the same pager.
    expect(mobile).toContain('.split:not(.split-focus) > .workspace');
  });

  it('keeps the tablet stacked-split fallback for 641-760px', () => {
    const tablet = mediaBlocks(shellCss, '(max-width: 760px)');
    const split = cssDeclarations(tablet, '.split:not(.split-focus)');
    expect(ruleValue(split, 'grid-template-rows')).toBe('minmax(0, 11fr) minmax(0, 9fr)');
  });
});

describe('phone home composer footer (<=640px)', () => {
  const mobile = mediaBlocks(homeHeroCss, '(max-width: 640px)');

  it('keeps the whole footer on one row and right-aligns the action cluster', () => {
    const foot = cssDeclarations(mobile, '.home-hero__input-foot');
    expect(ruleValue(foot, 'flex-wrap')).toBe('nowrap');
    const right = cssDeclarations(mobile, '.home-hero__foot-right');
    expect(ruleValue(right, 'margin-left')).toBe('auto');
    const left = cssDeclarations(mobile, '.home-hero__foot-left');
    expect(ruleValue(left, 'flex-wrap')).toBe('nowrap');
  });

  it('collapses the send button to icon-only', () => {
    const submit = cssDeclarations(mobile, '.home-hero__submit');
    expect(ruleValue(submit, 'width')).toBe('36px');
    const label = cssDeclarations(mobile, '.home-hero__submit span');
    expect(ruleValue(label, 'display')).toBe('none');
  });

  it('collapses the template pill and mode toggle to compact chips', () => {
    const kicker = cssDeclarations(mobile, '.home-hero__template-kicker');
    expect(ruleValue(kicker, 'display')).toBe('none');
    const modeLabel = cssDeclarations(
      mobile,
      '.home-hero__mode-switcher .session-mode-toggle__label',
    );
    expect(ruleValue(modeLabel, 'display')).toBe('none');
  });

  it('re-anchors the template menu to the footer row at card width', () => {
    const option = cssDeclarations(mobile, '.home-hero__template-option');
    expect(ruleValue(option, 'position')).toBe('static');
    const menu = cssDeclarations(mobile, '.home-hero__template-menu');
    expect(ruleValue(menu, 'left')).toBe('0');
    expect(ruleValue(menu, 'right')).toBe('0');
    expect(ruleValue(menu, 'width')).toBe('auto');
    const grid = cssDeclarations(mobile, '.home-hero__template-grid');
    expect(ruleValue(grid, 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('keeps accessory rows inside the viewport', () => {
    const workdir = cssDeclarations(mobile, '.home-hero__workdir-row');
    expect(ruleValue(workdir, 'flex-wrap')).toBe('wrap');
    const switcher = cssDeclarations(
      mobile,
      '.home-hero__execution-switcher .inline-switcher__popover',
    );
    expect(ruleValue(switcher, 'max-width')).toBe('calc(100vw - 48px)');
  });

  it('gives the role picker list the whole popover (preview hidden on touch)', () => {
    const body = cssDeclarations(
      mobile,
      '.project-ds-picker-popover--matos-role .project-ds-picker-body',
    );
    expect(ruleValue(body, 'grid-template-columns')).toBe('1fr');
    const list = cssDeclarations(
      mobile,
      '.project-ds-picker-popover--matos-role .project-ds-picker-list',
    );
    expect(ruleValue(list, 'max-height')).toBe('none');
    const preview = cssDeclarations(
      mobile,
      '.project-ds-picker-popover--matos-role .project-ds-picker-preview',
    );
    expect(ruleValue(preview, 'display')).toBe('none');
  });
});

describe('phone terminal input (<=640px)', () => {
  // Upstream xterm.css (and TerminalViewer's !important re-park) hide the
  // focus-sink textarea at left:-9999em; on the phone snap pager, input-path
  // characters (space, mobile IME keys) make Chrome scroll the caret into
  // view, which would snap the user from the terminal back to the chat page.
  // Both layers must pin the textarea at the terminal's own origin on phones.
  it('parks the xterm helper textarea in-view so typing cannot yank the pager', () => {
    const mobile = mediaBlocks(terminalCss, '(max-width: 640px)');
    const textarea = cssDeclarations(mobile, '.xterm .xterm-helper-textarea');
    expect(ruleValue(textarea, 'left')).toBe('0');
  });

  it('outweighs the module re-park (!important) inside the terminal surface', () => {
    const base = cssDeclarations(terminalViewerCss, '.surface :global(.xterm-helper-textarea)');
    expect(ruleValue(base, 'left')).toContain('!important');
    const mobile = mediaBlocks(terminalViewerCss, '(max-width: 640px)');
    const override = cssDeclarations(mobile, '.surface :global(.xterm-helper-textarea)');
    expect(ruleValue(override, 'left')).toBe('0 !important');
    // The override must come AFTER the base park so equal-importance cascade
    // resolves in its favor.
    expect(terminalViewerCss.indexOf('@media (max-width: 640px)')).toBeGreaterThan(
      terminalViewerCss.indexOf('left: -9999em !important'),
    );
  });
});
