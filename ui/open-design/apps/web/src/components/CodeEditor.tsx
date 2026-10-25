// Project text editor: CodeMirror 6 mounted lazily, with a plain textarea
// fallback while the editor chunk loads (and if it fails, the fallback simply
// stays — editing never breaks). Uncontrolled by design: the parent seeds
// `initialValue` and receives every change through `onChange`; external
// resets remount via `key`.

import { useEffect, useRef, useState } from 'react';
import type { EditorView, LatexAssistData } from '../runtime/codemirror';

interface Props {
  initialValue: string;
  fileName: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  testId?: string;
  /**
   * Focus the editor once CodeMirror mounts. Defaults to true (library file
   * viewer behavior); embedded editors lower on a page (asset cards) pass
   * false so opening a detail page does not scroll-jump to the editor.
   */
  autoFocus?: boolean;
  /**
   * Receives the CodeMirror view once mounted (and null on unmount) so hosts
   * can drive navigation like jump-to-line (LatexViewer's error panel).
   */
  onViewReady?: (view: EditorView | null) => void;
  /** LaTeX completion sources (cite keys, labels); .tex hosts pass this. */
  latexAssist?: LatexAssistData;
  /** Browser-native spellcheck on the editor content (LatexViewer toggle). */
  spellcheck?: boolean;
  /** Overleaf-style Visual Editor decorations (LatexViewer toggle). */
  latexRich?: boolean;
  /** Cmd/Ctrl+Enter handler (LatexViewer recompile). */
  onCompile?: () => void;
}

export function CodeEditor({ initialValue, fileName, onChange, onSave, testId, autoFocus = true, onViewReady, latexAssist, spellcheck, latexRich, onCompile }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCompileRef = useRef(onCompile);
  onCompileRef.current = onCompile;
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  // The latest doc lives here so the fallback textarea and CodeMirror hand
  // off cleanly if the user types before the editor chunk arrives.
  const docRef = useRef(initialValue);

  useEffect(() => {
    let view: EditorView | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { createCodeEditorView } = await import('../runtime/codemirror');
        if (cancelled || !hostRef.current) return;
        const seededDoc = docRef.current;
        view = await createCodeEditorView({
          parent: hostRef.current,
          doc: seededDoc,
          fileName,
          onDocChanged: (doc) => {
            docRef.current = doc;
            onChangeRef.current(doc);
          },
          onSave: () => onSaveRef.current?.(),
          ...(onCompile ? { onCompile: () => onCompileRef.current?.() } : {}),
          ...(latexAssist ? { latexAssist } : {}),
          ...(spellcheck ? { spellcheck } : {}),
          ...(latexRich ? { latexRich } : {}),
        });
        if (cancelled) {
          view.destroy();
          view = null;
          return;
        }
        // Keystrokes typed into the fallback textarea while the editor chunk
        // loaded advanced docRef past the seed; carry them into the view so
        // the swap never rolls the buffer back.
        if (docRef.current !== seededDoc) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: docRef.current },
          });
        }
        setReady(true);
        onViewReadyRef.current?.(view);
        if (autoFocus) view.focus();
      } catch (err) {
        console.warn('[CodeEditor] CodeMirror unavailable, textarea fallback stays', err);
      }
    })();
    return () => {
      cancelled = true;
      onViewReadyRef.current?.(null);
      view?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  return (
    <div className="code-editor" data-testid={testId}>
      {!ready ? (
        <textarea
          className="text-viewer__editor code-editor__fallback"
          defaultValue={initialValue}
          spellCheck={false}
          onChange={(event) => {
            docRef.current = event.target.value;
            onChangeRef.current(event.target.value);
          }}
        />
      ) : null}
      <div
        ref={hostRef}
        className="code-editor__host"
        style={{ display: ready ? undefined : 'none' }}
      />
    </div>
  );
}
