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

describe('entry rail overflow mode (short desktop/tablet windows)', () => {
  it('keeps the destination wrapper layout-transparent by default', () => {
    // Outside overflow mode the wrapper must not change desktop layout or
    // tooltips — `display: contents` erases its box entirely. Scoped to the
    // CSS before the phone breakpoint: the <=640px top bar deliberately
    // turns this wrapper into the sideways scroll strip (display: flex), so
    // a whole-file "last declaration wins" scan would read that instead.
    const beforePhone = entryLayoutCss.slice(
      0,
      entryLayoutCss.indexOf('@media (max-width: 640px)'),
    );
    const base = cssDeclarations(beforePhone, '.entry-nav-rail__scroll');
    expect(ruleValue(base, 'display')).toBe('contents');
  });

  it('clamps the rail to its grid area so overflow is measurable at all', () => {
    // Grid items default to `min-height: auto`, so the rail box silently grew
    // past its row to fit every icon: nothing measurably overflowed
    // (scrollHeight == clientHeight) while the excess icons hung below the
    // fold. Without this clamp the ResizeObserver never sees overflow and the
    // whole mode is dead code.
    const block = mediaBlock(entryLayoutCss, '(min-width: 641px)');
    const rail = cssDeclarations(block, '.entry-nav-rail');
    expect(ruleValue(rail, 'min-height')).toBe('0');
    expect(ruleValue(rail, 'max-height')).toBe('100%');
  });

  it('turns the destination list into the vertical scroll region in overflow mode', () => {
    const block = mediaBlock(entryLayoutCss, '(min-width: 641px)');
    const scroll = cssDeclarations(block, '.entry-nav-rail--overflow .entry-nav-rail__scroll');
    expect(ruleValue(scroll, 'display')).toBe('flex');
    expect(ruleValue(scroll, 'flex-direction')).toBe('column');
    expect(ruleValue(scroll, 'overflow-y')).toBe('auto');
    expect(ruleValue(scroll, 'min-height')).toBe('0');
    // The group must be allowed to shrink or the scroller never activates.
    const group = cssDeclarations(block, '.entry-nav-rail--overflow .entry-nav-rail__group');
    expect(ruleValue(group, 'min-height')).toBe('0');
  });

  it('pins brand, create, and footer outside the scroll region', () => {
    const block = mediaBlock(entryLayoutCss, '(min-width: 641px)');
    const pinned = cssDeclarations(block, '.entry-nav-rail--overflow .entry-nav-rail__footer');
    expect(ruleValue(pinned, 'flex-shrink')).toBe('0');
  });

  it('drops only the scroller tooltips (a scroll container would clip them)', () => {
    const block = mediaBlock(entryLayoutCss, '(min-width: 641px)');
    const tooltip = cssDeclarations(
      block,
      '.entry-nav-rail--overflow .entry-nav-rail__scroll [data-tooltip]::after',
    );
    expect(ruleValue(tooltip, 'display')).toBe('none');
  });

  it('stays out of the phone top-bar breakpoint, which scrolls sideways instead', () => {
    // The overflow rules are width-scoped to desktop/tablet; the <=640px bar
    // keeps its own horizontal scrolling for the group.
    const phone = mediaBlock(entryLayoutCss, '(max-width: 640px)');
    expect(phone).not.toContain('entry-nav-rail--overflow');
  });
});
