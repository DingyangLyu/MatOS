import katex from 'katex';
import splitAtDelimiters from 'katex/contrib/auto-render/splitAtDelimiters';

export interface MarkdownMath {
  source: string;
  display: boolean;
  html: string;
}

const delimiters = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  ...['equation', 'equation*', 'align', 'align*', 'aligned', 'gather', 'gather*'].map(name => ({
    left: `\\begin{${name}}`, right: `\\end{${name}}`, display: true,
  })),
  { left: '$', right: '$', display: false },
];

/** Protect formulas before Markdown interprets underscores, pipes or backslashes.
 * KaTeX owns delimiter/braces and TeX parsing; code, URLs and escapes stay literal.
 * The marker prefix is absent from the input, so authored text cannot impersonate it.
 */
export function prepareMarkdownMath(input: string): { text: string; formulas: Map<string, MarkdownMath> } {
  const formulas = new Map<string, MarkdownMath>();
  let prefix = 'MATOSMATHTOKEN';
  while (input.includes(prefix)) prefix += 'X';
  // Fenced/inline code is opaque even while its closing fence is still streaming.
  const protectedText = /(^ {0,3}(`{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2`*[ \t]*(?=\n|$)|$(?![\s\S])))|(^ {0,3}(~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\4~*[ \t]*(?=\n|$)|$(?![\s\S])))|(`+)[\s\S]*?\5(?!`)|(?:https?:\/\/[^\s<>]+)|(?:!?\[[^\]\n]*\]\([^\n]*?\))/gm;
  const convert = (text: string): string => {
    const escapes: string[] = [];
    const masked = text.replace(/\\[\\$]/g, value => `${prefix}ESC${escapes.push(value) - 1}END`);
    const unmask = (value: string) => value.replace(new RegExp(`${prefix}ESC(\\d+)END`, 'g'),
      (_match, index: string) => escapes[Number(index)]!);
    return splitAtDelimiters(masked, delimiters).map(value => {
      const part = { ...value, data: unmask(value.data), rawData: value.rawData ? unmask(value.rawData) : undefined };
      if (part.type !== 'math' || !part.data.trim()) return part.rawData ?? part.data;
      const raw = part.rawData!;
      // Currency and unfinished output must not turn a paragraph into mathematics.
      if (raw[0] === '$' && raw[1] !== '$' && (/^\s|\s$|\n/.test(part.data))) return raw;
      if (part.data.length > 16_384 || formulas.size >= 512) return raw;
      let html: string;
      try {
        html = katex.renderToString(part.data, {
          displayMode: part.display, output: 'htmlAndMathml', throwOnError: true,
          trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
        });
      } catch {
        return raw;
      }
      const token = `${prefix}${formulas.size}END`;
      formulas.set(token, { source: raw, display: !!part.display, html });
      return token;
    }).join('');
  };
  let last = 0;
  let text = '';
  for (const match of input.matchAll(protectedText)) {
    text += convert(input.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  text += convert(input.slice(last));
  return { text, formulas };
}

export function restoreMarkdownMath(html: string, formulas: Map<string, MarkdownMath>): string {
  // Markdown may classify an indented block as code after tokenization.
  // Restore its literal source before replacing tokens in prose.
  html = html.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/g, code => {
    for (const [token, formula] of formulas) {
      code = code.replaceAll(token, () => formula.source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    }
    return code;
  });
  for (const [token, formula] of formulas) {
    const rendered = `<span class="md-math${formula.display ? ' md-math-display' : ''}">${formula.html}</span>`;
    html = html.replaceAll(token, () => rendered);
  }
  return html;
}
