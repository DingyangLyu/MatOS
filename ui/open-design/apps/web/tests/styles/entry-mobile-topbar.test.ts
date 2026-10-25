import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryLayoutCss = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
  'utf8',
);

/** Return the body (between the outermost braces) of the first `@media <query>` block. */
function mediaBlock(css: string, query: string): string {
  const marker = `@media ${query}`;
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`Missing ${marker}`);
  const open = css.indexOf('{', start);
  if (open === -1) throw new Error(`Malformed ${marker}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces in ${marker}`);
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

describe('entry mobile top-bar (<=640px)', () => {
  const mobile = mediaBlock(entryLayoutCss, '(max-width: 640px)');

  it('collapses the entry grid to a single column with the rail stacked on top', () => {
    const entry = cssDeclarations(mobile, '.entry-shell--no-header .entry');
    // Single content column; !important is required to beat the
    // `.entry { grid-template-columns: 56px 1fr !important }` rule that
    // workspace/drawer.css applies at <=900px.
    expect(ruleValue(entry, 'grid-template-columns')).toBe('minmax(0, 1fr) !important');
    expect(ruleValue(entry, 'grid-template-rows')).toBe('auto minmax(0, 1fr) !important');
  });

  it('re-flows the rail into a single-row horizontal bar with its own backdrop', () => {
    const rail = cssDeclarations(mobile, '.entry-nav-rail');
    expect(ruleValue(rail, 'flex-direction')).toBe('row');
    // Single row: the destination group scrolls sideways instead of wrapping
    // into a second row that eats vertical space on phones.
    expect(ruleValue(rail, 'flex-wrap')).toBe('nowrap');
    expect(ruleValue(rail, 'width')).toBe('100%');
    expect(ruleValue(rail, 'height')).toBe('auto');
    expect(ruleValue(rail, 'pointer-events')).toBe('auto');
    // The bar grounds its icons on an explicit layer edge (hairline) so it
    // never reads as loose glyphs floating over the content below.
    expect(ruleValue(rail, 'border-bottom')).toContain('1px solid');

    // The destination strip (`__scroll`) is the sideways-scrolling region.
    // The group itself must stay overflow: visible — it wraps the "+"
    // create button whose popover would be clipped by a scroll container,
    // and scrolling the whole group used to carry the brand logo away.
    const group = cssDeclarations(mobile, '.entry-nav-rail__group');
    expect(ruleValue(group, 'flex')).toBe('1 1 0');
    expect(ruleValue(group, 'flex-wrap')).toBe('nowrap');
    expect(ruleValue(group, 'overflow')).toBe('visible');
    const scroll = cssDeclarations(mobile, '.entry-nav-rail__scroll');
    expect(ruleValue(scroll, 'flex')).toBe('1 1 0');
    expect(ruleValue(scroll, 'overflow-x')).toBe('auto');
    // Overflow affordance: right-edge fade plus end padding so the last
    // icon scrolls clear of the fade band instead of reading as disabled.
    expect(ruleValue(scroll, 'mask-image')).toContain('linear-gradient');
    expect(ruleValue(scroll, 'padding-inline-end')).toBe('26px');
    const footer = cssDeclarations(mobile, '.entry-nav-rail__footer');
    expect(ruleValue(footer, 'flex')).toBe('0 0 auto');
    expect(ruleValue(footer, 'flex-direction')).toBe('row');
    // Footer diet: the low-frequency trio moves into the scrollable strip
    // (phone-tail) so only Feedback + Settings stay pinned at the right.
    const tail = cssDeclarations(mobile, '.entry-nav-rail__phone-tail');
    expect(ruleValue(tail, 'display')).toBe('contents');
    const secondary = cssDeclarations(mobile, '.entry-nav-rail__footer-secondary');
    expect(ruleValue(secondary, 'display')).toBe('none');
    // 44px touch targets (Apple/Android minimum) — the bar used to force
    // 38px. `rail` is the block already read at the top of this test.
    expect(ruleValue(rail, '--entry-rail-touch-target')).toBe('44px');
  });

  it('keeps the bar visible (never clips it to the collapsed 0-width column)', () => {
    const collapsed = cssDeclarations(mobile, '.entry:not(.entry--rail-open) .entry-nav-rail');
    expect(ruleValue(collapsed, 'overflow')).toBe('visible');
  });

  it('drops the fold/toggle affordances that only make sense for a docked rail', () => {
    const toggle = cssDeclarations(mobile, '.entry-rail-toggle');
    const collapse = cssDeclarations(mobile, '.entry-nav-rail__collapse');
    expect(ruleValue(toggle, 'display')).toBe('none !important');
    expect(ruleValue(collapse, 'display')).toBe('none !important');
  });

  it('re-points the create/help popovers to open downward instead of off-screen', () => {
    // The "+" button lives inside the horizontally scrolling group whose
    // overflow would clip an absolute child, so the menu re-anchors to the
    // bar itself (the trigger wrapper goes static).
    const createWrap = cssDeclarations(mobile, '.entry-nav-rail__create');
    expect(ruleValue(createWrap, 'position')).toBe('static');
    const create = cssDeclarations(mobile, '.create-menu');
    expect(ruleValue(create, 'top')).toBe('calc(100% + 6px)');
    expect(ruleValue(create, 'left')).toBe('8px');
    expect(ruleValue(create, 'right')).toBe('auto');

    const help = cssDeclarations(mobile, '.entry-help-popover');
    expect(ruleValue(help, 'top')).toBe('calc(100% + 8px)');
    expect(ruleValue(help, 'right')).toBe('0');
    expect(ruleValue(help, 'left')).toBe('auto');
    expect(ruleValue(help, 'bottom')).toBe('auto');
  });

  it('leaves the desktop docked-rail grid untouched', () => {
    // The desktop expand rule must still size the first column to the rail
    // width; only the phone breakpoint switches to a single column.
    expect(entryLayoutCss).toContain(
      'grid-template-columns: var(--entry-rail-width, 56px) minmax(0, 1fr);',
    );
    // The desktop base rail stays a vertical column outside the media query.
    const beforeMobile = entryLayoutCss.slice(0, entryLayoutCss.indexOf('@media (max-width: 640px)'));
    const desktopRail = cssDeclarations(beforeMobile, '.entry-nav-rail');
    expect(ruleValue(desktopRail, 'flex-direction')).toBe('column');
  });
});
