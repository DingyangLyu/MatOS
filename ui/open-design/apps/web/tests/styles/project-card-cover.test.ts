import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('native project card image framing', () => {
  it('fills the fixed preview without stretching the image or changing card height', () => {
    const css = postcss.parse(readFileSync(new URL('../../src/components/ProjectCardContents.module.css', import.meta.url), 'utf8'));
    const declarations: Record<string, string> = {};
    css.walkRules('.preview img', rule => {
      rule.walkDecls(decl => { declarations[decl.prop] = decl.value; });
    });
    expect(declarations).toMatchObject({ width: '100%', height: '100%', 'object-fit': 'cover' });
    css.walkRules('.preview', rule => {
      const preview: Record<string, string> = {};
      rule.walkDecls(decl => { preview[decl.prop] = decl.value; });
      expect(preview).toMatchObject({ height: '100px', overflow: 'hidden' });
    });
  });
});
