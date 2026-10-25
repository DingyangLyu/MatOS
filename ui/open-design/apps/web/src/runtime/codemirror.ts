// Lazy CodeMirror 6 assembly for the project text editor.
//
// Imported dynamically (like ./shiki) so the editor toolchain stays out of
// the initial bundle — the browser only pays for it when a file actually
// enters edit mode. Exposes one factory that wires the extension stack:
// history/undo, search, indentation, bracket matching, active-line, a
// filename-driven language, and a CSS-variable theme that follows the app's
// light/dark palette without a separate CodeMirror skin.

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';

async function languageForFile(fileName: string): Promise<Extension | null> {
  const name = fileName.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  try {
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript({ jsx: ext === 'jsx' });
      }
      case 'ts':
      case 'tsx': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript({ typescript: true, jsx: ext === 'tsx' });
      }
      case 'json':
      case 'jsonl':
      case 'geojson': {
        const { json } = await import('@codemirror/lang-json');
        return json();
      }
      case 'py': {
        const { python } = await import('@codemirror/lang-python');
        return python();
      }
      case 'md':
      case 'markdown': {
        const { markdown } = await import('@codemirror/lang-markdown');
        return markdown();
      }
      case 'css': {
        const { css } = await import('@codemirror/lang-css');
        return css();
      }
      case 'html':
      case 'htm': {
        const { html } = await import('@codemirror/lang-html');
        return html();
      }
      case 'yml':
      case 'yaml': {
        const { yaml } = await import('@codemirror/lang-yaml');
        return yaml();
      }
      case 'tex':
      case 'ltx':
      case 'sty':
      case 'cls':
      case 'bib': {
        // No first-party @codemirror/lang-latex exists; the maintained legacy
        // stex stream mode covers TeX/LaTeX (and reads well enough for BibTeX).
        const [{ StreamLanguage }, { stex }] = await Promise.all([
          import('@codemirror/language'),
          import('@codemirror/legacy-modes/mode/stex'),
        ]);
        return StreamLanguage.define(stex);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Palette follows the app CSS variables so the editor renders correctly in
// both themes without tracking theme state in React.
const appTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12.5px',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--accent, #c96442)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent, #c96442)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text-faint, #888)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent, #c96442) 5%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #c96442) 8%, transparent)',
    color: 'var(--text)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #c96442) 22%, transparent) !important',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #c96442) 14%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-panel, var(--bg))',
    color: 'var(--text)',
    borderTop: '1px solid var(--border)',
  },
  '.cm-panels input, .cm-panels button, .cm-panels label': { fontSize: '11.5px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 193, 7, 0.28)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 152, 0, 0.45)' },
});

/**
 * Live completion data for LaTeX assists. Getters are called at completion
 * time so the host can keep them fresh (labels from the open buffer, cite
 * keys from project .bib files) without rebuilding the editor.
 */
export interface LatexAssistData {
  getLabels: () => string[];
  getCites: () => Array<{ key: string; title?: string }>;
}

// Common LaTeX commands for the backslash completion. Deliberately modest:
// enough for fluent writing, not a full CTAN catalog.
const LATEX_COMMANDS = [
  'begin{', 'end{', 'section{', 'subsection{', 'subsubsection{', 'paragraph{',
  'title{', 'author{', 'date{', 'maketitle', 'tableofcontents', 'appendix',
  'label{', 'ref{', 'eqref{', 'autoref{', 'cref{', 'pageref{',
  'cite{', 'citep{', 'citet{', 'bibliography{', 'bibliographystyle{',
  'usepackage{', 'documentclass{', 'input{', 'include{', 'includegraphics[width=\\linewidth]{',
  'textbf{', 'textit{', 'texttt{', 'textsc{', 'emph{', 'underline{',
  'footnote{', 'caption{', 'centering', 'item', 'frac{', 'sqrt{', 'sum_{', 'int_{',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'lambda', 'mu', 'sigma', 'omega',
  'mathrm{', 'mathbf{', 'mathcal{', 'mathbb{', 'text{', 'left(', 'right)',
  'times', 'cdot', 'pm', 'approx', 'neq', 'leq', 'geq', 'infty', 'partial', 'nabla',
  'hline', 'toprule', 'midrule', 'bottomrule', 'multicolumn{', 'multirow{',
  'newcommand{', 'renewcommand{', 'vspace{', 'hspace{', 'noindent', 'linewidth',
  'textwidth', 'columnwidth', 'and', 'affiliation{', 'thanks{', 'keywords{',
];

const LATEX_ENVIRONMENTS = [
  'document', 'abstract', 'figure', 'figure*', 'table', 'table*', 'tabular',
  'equation', 'equation*', 'align', 'align*', 'gather', 'itemize', 'enumerate',
  'description', 'center', 'quote', 'verbatim', 'minipage', 'thebibliography',
  'theorem', 'lemma', 'proof', 'algorithm', 'matrix', 'pmatrix', 'bmatrix', 'cases',
  'frame', 'columns', 'block',
];

async function latexAssistExtension(assist: LatexAssistData): Promise<Extension> {
  const { autocompletion, closeBrackets, closeBracketsKeymap } = await import('@codemirror/autocomplete');
  // Brace pairing matters constantly in LaTeX ({...} on every command);
  // scoped to .tex hosts so other file types keep the upstream behavior.
  const brackets: Extension = [closeBrackets(), keymap.of(closeBracketsKeymap)];
  const completion = autocompletion({
    override: [
      (context) => {
        // \cite{...} / \ref{...} style key completion (also inside comma lists).
        const keyArg = context.matchBefore(/\\(cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref|vref)\{[^}]*/);
        if (keyArg) {
          const braceIndex = keyArg.text.indexOf('{');
          const listStart = keyArg.from + braceIndex + 1;
          const lastComma = context.state.sliceDoc(listStart, context.pos).lastIndexOf(',');
          const from = lastComma === -1 ? listStart : listStart + lastComma + 1;
          const isCite = keyArg.text.startsWith('\\cite');
          const options = isCite
            ? assist.getCites().map((cite) => ({
                label: cite.key,
                type: 'constant' as const,
                ...(cite.title ? { detail: cite.title.slice(0, 60) } : {}),
              }))
            : assist.getLabels().map((label) => ({ label, type: 'labelName' as const }));
          if (options.length === 0) return null;
          return { from, options, validFor: /^[^\s{},]*$/ };
        }
        // \begin{...} / \end{...} environment names.
        const env = context.matchBefore(/\\(?:begin|end)\{[a-zA-Z*]*/);
        if (env) {
          const from = env.from + env.text.indexOf('{') + 1;
          return {
            from,
            options: LATEX_ENVIRONMENTS.map((name) => ({ label: name, type: 'type' as const })),
            validFor: /^[a-zA-Z*]*$/,
          };
        }
        // Backslash command completion.
        const command = context.matchBefore(/\\[a-zA-Z]*/);
        if (command && (command.text.length > 1 || context.explicit)) {
          return {
            from: command.from + 1,
            options: LATEX_COMMANDS.map((name) => ({ label: name, type: 'keyword' as const })),
            validFor: /^[a-zA-Z]*$/,
          };
        }
        return null;
      },
    ],
  });
  return [completion, brackets];
}

// ---------------------------------------------------------------------------
// LaTeX "Visual Editor" (Overleaf-style rich-text layer)
//
// A decoration-only view plugin: markup stays in the document, but away from
// the cursor the noisy parts render as formatted text — \section{...} shows
// as a heading, \textbf/\textit/\emph as styled spans with hidden braces,
// \item as a bullet, \cite/\ref as compact badges, \begin/\end lines dimmed.
// Any decorated range touched by the primary selection reveals its source
// (Overleaf's behavior), so editing stays plain LaTeX.

/** Index of the `}` closing the `{` at openIndex, honoring nesting and \{. */
function findBalancedClose(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1; // skip escaped char
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const LATEX_RICH_HEADINGS: Record<string, string> = {
  chapter: 'cm-latexH1',
  section: 'cm-latexH1',
  subsection: 'cm-latexH2',
  subsubsection: 'cm-latexH3',
  paragraph: 'cm-latexH3',
  title: 'cm-latexH1',
};

const LATEX_RICH_INLINE: Record<string, string> = {
  textbf: 'cm-latexBold',
  textit: 'cm-latexItalic',
  emph: 'cm-latexItalic',
  underline: 'cm-latexUnderline',
  texttt: 'cm-latexMono',
};

const latexRichTheme = EditorView.baseTheme({
  '.cm-latexH1': { fontSize: '1.45em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-latexH2': { fontSize: '1.25em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-latexH3': { fontSize: '1.1em', fontWeight: '700' },
  '.cm-latexBold': { fontWeight: '700' },
  '.cm-latexItalic': { fontStyle: 'italic' },
  '.cm-latexUnderline': { textDecoration: 'underline' },
  '.cm-latexMono': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    background: 'color-mix(in srgb, var(--text, #444) 8%, transparent)',
    borderRadius: '3px',
  },
  '.cm-latexDim': { opacity: '0.45' },
  '.cm-latexBadge': {
    display: 'inline-block',
    padding: '0 5px',
    borderRadius: '8px',
    fontSize: '0.85em',
    background: 'color-mix(in srgb, var(--accent, #c96442) 14%, transparent)',
    color: 'var(--text)',
    verticalAlign: 'baseline',
  },
  '.cm-latexBullet': { color: 'var(--accent, #c96442)', fontWeight: '700' },
});

async function latexRichExtension(): Promise<Extension> {
  const { Decoration, ViewPlugin, WidgetType } = await import('@codemirror/view');
  const { RangeSetBuilder } = await import('@codemirror/state');

  class TextWidget extends WidgetType {
    constructor(readonly text: string, readonly className: string) {
      super();
    }
    override eq(other: TextWidget): boolean {
      return other.text === this.text && other.className === this.className;
    }
    toDOM(): HTMLElement {
      const span = document.createElement('span');
      span.className = this.className;
      span.textContent = this.text;
      return span;
    }
    override ignoreEvent(): boolean {
      return false;
    }
  }

  interface Deco {
    from: number;
    to: number;
    deco: import('@codemirror/view').Decoration;
  }

  const buildDecorations = (view: import('@codemirror/view').EditorView) => {
    const decorations: Deco[] = [];
    const selection = view.state.selection.main;
    // A decorated construct whose range touches the selection reveals its
    // source for editing.
    const revealed = (from: number, to: number) =>
      selection.to >= from && selection.from <= to;

    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      // Commands with a braced argument we restyle.
      const command = /\\(chapter|section|subsection|subsubsection|paragraph|title|textbf|textit|emph|underline|texttt|cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref)\*?\{/g;
      let match: RegExpExecArray | null;
      while ((match = command.exec(text)) !== null) {
        const name = match[1] ?? '';
        const openIdx = match.index + match[0].length - 1;
        const closeIdx = findBalancedClose(text, openIdx);
        if (closeIdx === -1) continue;
        const start = from + match.index;
        const end = from + closeIdx + 1;
        if (revealed(start, end)) continue;
        const contentFrom = from + openIdx + 1;
        const contentTo = from + closeIdx;
        const heading = LATEX_RICH_HEADINGS[name];
        const inline = LATEX_RICH_INLINE[name];
        if (heading || inline) {
          // Hide `\cmd{` and `}`, style the content in between.
          decorations.push({ from: start, to: contentFrom, deco: Decoration.replace({}) });
          if (contentTo > contentFrom) {
            decorations.push({
              from: contentFrom,
              to: contentTo,
              deco: Decoration.mark({ class: heading ?? inline ?? '' }),
            });
          }
          decorations.push({ from: contentTo, to: end, deco: Decoration.replace({}) });
        } else {
          // \cite / \ref family: compact badge with the key list.
          const keys = view.state.sliceDoc(contentFrom, contentTo);
          if (keys.includes('\n')) {
            // Replace decorations that span line breaks are illegal from a
            // ViewPlugin (CodeMirror throws a RangeError and the editor
            // fails to build). A key list wrapped across lines keeps its
            // raw source instead of a badge.
            command.lastIndex = closeIdx + 1;
            continue;
          }
          const label = name.startsWith('cite') ? `[${keys}]` : `→${keys}`;
          decorations.push({
            from: start,
            to: end,
            deco: Decoration.replace({ widget: new TextWidget(label, 'cm-latexBadge') }),
          });
        }
        command.lastIndex = closeIdx + 1;
      }
      // \item -> bullet; \begin/\end lines -> dimmed.
      const simple = /\\(item\b|begin\{[^}]*\}|end\{[^}]*\})/g;
      while ((match = simple.exec(text)) !== null) {
        const start = from + match.index;
        const end = start + match[0].length;
        if (revealed(start, end)) continue;
        if (match[0].startsWith('\\item')) {
          decorations.push({
            from: start,
            to: end,
            deco: Decoration.replace({ widget: new TextWidget('•', 'cm-latexBullet') }),
          });
        } else {
          decorations.push({ from: start, to: end, deco: Decoration.mark({ class: 'cm-latexDim' }) });
        }
      }
    }

    decorations.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<import('@codemirror/view').Decoration>();
    let lastFrom = -1;
    let lastTo = -1;
    for (const { from, to, deco } of decorations) {
      // Drop overlaps from nested constructs; the outer decoration wins.
      if (from < lastTo && from >= lastFrom) continue;
      builder.add(from, to, deco);
      lastFrom = from;
      lastTo = to;
    }
    return builder.finish();
  };

  const plugin = ViewPlugin.define(
    (view) => ({
      decorations: buildDecorations(view),
      update(update: import('@codemirror/view').ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      },
    }),
    { decorations: (instance) => instance.decorations },
  );

  return [plugin, latexRichTheme];
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  fileName: string;
  onDocChanged: (doc: string) => void;
  /** Cmd/Ctrl+S handler; returning true suppresses the browser dialog. */
  onSave?: () => void;
  /** Cmd/Ctrl+Enter handler (Overleaf-style recompile from the editor). */
  onCompile?: () => void;
  readOnly?: boolean;
  /** LaTeX completion sources (cite keys, labels); .tex hosts pass this. */
  latexAssist?: LatexAssistData;
  /** Browser-native spellcheck on the editable content. Off by default. */
  spellcheck?: boolean;
  /** Overleaf-style Visual Editor: rich-text decorations over LaTeX markup. */
  latexRich?: boolean;
}

export async function createCodeEditorView(options: CreateEditorOptions): Promise<EditorView> {
  const language = await languageForFile(options.fileName);
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    history(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      ...(options.onSave
        ? [{
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              options.onSave?.();
              return true;
            },
          }]
        : []),
      ...(options.onCompile
        ? [{
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              options.onCompile?.();
              return true;
            },
          }]
        : []),
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    appTheme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onDocChanged(update.state.doc.toString());
    }),
  ];
  if (language) extensions.push(language);
  if (options.readOnly) extensions.push(EditorState.readOnly.of(true));
  if (options.latexAssist) {
    extensions.push(await latexAssistExtension(options.latexAssist));
  }
  if (options.latexRich) {
    extensions.push(await latexRichExtension());
  }
  if (options.spellcheck) {
    extensions.push(EditorView.contentAttributes.of({ spellcheck: 'true' }));
  }
  return new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.doc, extensions }),
  });
}

export type { EditorView };
