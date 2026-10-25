import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../../src/runtime/markdown';
import { renderMarkdownToSafeHtml } from '../../src/artifacts/markdown';

const renderers = {
  chat: (text: string) => renderToStaticMarkup(<>{renderMarkdown(text)}</>),
  document: renderMarkdownToSafeHtml,
};

for (const [surface, html] of Object.entries(renderers)) {
  describe(`${surface} scientific markdown`, () => {
    it.each([String.raw`$E=mc^2$`, String.raw`\(x_i^2 + y_i^2\)`,
      String.raw`$$\frac{1}{2}$$`, String.raw`\[\int_0^1 x^2\,dx\]`,
      '$$\n\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}\n$$'])('renders %s', text => {
      expect(html(text)).toContain('class="katex');
      expect(html(text)).toContain('<math');
    });

    it('preserves mathematics in lists and table cells', () => {
      const result = html('- Diffusion: $D_i = k_B T / \\zeta_i$\n\n| Quantity | Value |\n| --- | --- |\n| Energy | $E_0$ |');
      expect(result.match(/class="katex"/g)).toHaveLength(2);
      expect(result).toContain('<table');
    });

    it('does not change inline code, fenced code, escaped dollars or money', () => {
      const input = '`$x_i$`\n\n```latex\n\\[x^2\\]\n```\n\nCost: $5 and $10. Escaped: \\$x\\$.';
      const result = html(input);
      expect(result).not.toContain('class="katex');
      expect(result).toContain('$x_i$');
      expect(result).toContain('$5 and $10');
    });

    it('leaves partial streamed formulas visible without throwing', () => {
      expect(html('Value: $x_i +')).toContain('$x_i +');
      expect(html('\\[\\frac{1}{')).toContain('frac');
      expect(() => html('$\\unknowncommand{x}$')).not.toThrow();
    });

    it('does not allow formula markup to inject scripts, links or oversized rules', () => {
      const result = html(String.raw`$\href{javascript:alert(1)}{X}$ $\htmlStyle{position:fixed}{Y}$ <script>alert(1)</script>`);
      expect(result).not.toContain('href="javascript:');
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('style="position:fixed');
    });

    it('handles aligned equations without markdown splitting underscores or pipes', () => {
      const result = html(String.raw`\[\begin{aligned}a_i &= |b_i| \\ c_i &= d_i\end{aligned}\]`);
      expect(result).toContain('class="katex-display');
      expect(result).not.toContain('<em>');
    });

    it('does not confuse authored marker text with generated math', () => {
      const result = html('MATOSMATHTOKEN0END $x^2$');
      expect(result).toContain('MATOSMATHTOKEN0END');
      expect(result.match(/class="katex"/g)).toHaveLength(1);
    });

    it('accepts a longer closing code fence before a formula', () => {
      const result = html('```tex\n$x$\n````\n\n$y^2$');
      expect(result.match(/class="katex"/g)).toHaveLength(1);
      expect(result).toContain('$x$');
    });
  });
}

it('does not render formulas inside indented Markdown code', () => {
  expect(renderMarkdownToSafeHtml('    $x < y$\n    $z$')).not.toContain('class="katex');
  expect(renderMarkdownToSafeHtml('    $x < y$\n    $z$')).toContain('$x &lt; y$');
});
