// @vitest-environment jsdom

// The LaTeX Visual Editor (latexRich) is a ViewPlugin decoration layer.
// CodeMirror forbids plugin-provided replace decorations that span line
// breaks (it throws a RangeError while building the view), so a `\cite{...}`
// key list wrapped across lines — completely normal LaTeX — must not be
// collapsed into a badge. These tests mount the real editor.

import { describe, expect, it } from 'vitest';
import { createCodeEditorView } from '../../src/runtime/codemirror';

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('latexRich visual decorations', () => {
  it('survives a \\cite key list that wraps across lines', async () => {
    const view = await createCodeEditorView({
      parent: host(),
      doc: 'Intro \\cite{smith2020,\n  jones2021} outro\n\\section{Done}\n',
      fileName: 'main.tex',
      onDocChanged: () => {},
      latexRich: true,
    });
    // Force a decoration rebuild with the selection away from the cite.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.state.doc.lines).toBe(4);
    view.destroy();
  });

  it('still badges a single-line \\cite and hides heading markup', async () => {
    const view = await createCodeEditorView({
      parent: host(),
      doc: '\\section{Results}\nSee \\cite{smith2020} here.\n',
      fileName: 'main.tex',
      onDocChanged: () => {},
      latexRich: true,
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const badges = view.dom.querySelectorAll('.cm-latexBadge');
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toBe('[smith2020]');
    expect(view.dom.querySelectorAll('.cm-latexH1').length).toBe(1);
    view.destroy();
  });

  it('keeps typing through a multi-line cite without breaking updates', async () => {
    const view = await createCodeEditorView({
      parent: host(),
      doc: 'A \\cite{a,\nb} B\n',
      fileName: 'main.tex',
      onDocChanged: () => {},
      latexRich: true,
    });
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'more' } });
    expect(view.state.doc.toString()).toContain('more');
    view.destroy();
  });
});
