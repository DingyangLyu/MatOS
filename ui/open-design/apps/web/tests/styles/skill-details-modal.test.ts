import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

function declarationsFor(css: ReturnType<typeof postcss.parse>, selector: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  css.walkRules(selector, (rule) => {
    if (rule.parent?.type === 'atrule') return;
    rule.walkDecls((decl) => {
      declarations[decl.prop] = decl.value;
    });
  });
  return declarations;
}

describe('skill details modal layout', () => {
  const css = postcss.parse(
    readFileSync(new URL('../../src/styles/viewer/mcp-client.css', import.meta.url), 'utf8'),
  );

  it('centers the panel over a dimmed backdrop', () => {
    expect(declarationsFor(css, '.skill-details-modal-backdrop')).toMatchObject({
      position: 'fixed',
      inset: '0',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
    });
    expect(declarationsFor(css, '.skill-details-modal')).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
      'max-width': '920px',
      overflow: 'hidden',
    });
  });

  it('keeps the header, scroll body, sections, chips, and footer styled', () => {
    expect(declarationsFor(css, '.skill-details-modal__head')).toMatchObject({
      display: 'flex',
      'justify-content': 'space-between',
      'border-bottom': '1px solid var(--border)',
    });
    expect(declarationsFor(css, '.skill-details-modal__body')).toMatchObject({
      flex: '1',
      'min-height': '0',
      overflow: 'auto',
    });
    expect(declarationsFor(css, '.skill-details-modal__section')).toMatchObject({
      padding: '16px 0',
      'border-bottom': '1px dashed var(--border)',
    });
    expect(declarationsFor(css, '.skill-details-modal__chip')).toMatchObject({
      display: 'inline-flex',
      'border-radius': 'var(--radius-pill)',
    });
    expect(declarationsFor(css, '.skill-details-modal__foot')).toMatchObject({
      display: 'flex',
      'justify-content': 'flex-end',
      'border-top': '1px solid var(--border)',
    });
    expect(declarationsFor(css, '.skill-details-modal__body-text')).toMatchObject({
      'max-height': '280px',
      'white-space': 'pre-wrap',
    });
  });

  it('uses the full viewport for the panel on small screens', () => {
    const mobilePanels: Array<Record<string, string>> = [];
    css.walkAtRules('media', (atRule) => {
      if (!atRule.params.includes('max-width: 640px')) return;
      atRule.walkRules('.skill-details-modal', (rule) => {
        const declarations: Record<string, string> = {};
        rule.walkDecls((decl) => {
          declarations[decl.prop] = decl.value;
        });
        mobilePanels.push(declarations);
      });
    });
    expect(mobilePanels).toHaveLength(1);
    expect(mobilePanels[0]).toMatchObject({
      'max-width': 'none',
      'max-height': '100vh',
      'border-radius': '0',
    });
  });
});
