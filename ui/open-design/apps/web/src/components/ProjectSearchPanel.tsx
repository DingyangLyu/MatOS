// Cmd/Ctrl+Shift+F project-wide content search overlay.
//
// Sibling of the QuickSwitcher file palette (same qs-* shell styles): a
// debounced query hits the daemon's `/api/projects/:id/search` content grep
// and results render grouped by file with line numbers and snippets.
// Enter / click opens the file's tab. Purely a consumer of the existing
// search endpoint — no daemon changes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { modalOverlay, scaleIn } from '../motion';
import { useT } from '../i18n';
import { searchProjectContent, type ProjectContentMatch } from '../providers/registry';
import { nextCursor } from './QuickSwitcher';

const SEARCH_DEBOUNCE_MS = 260;
const MAX_MATCHES = 300;

interface Props {
  projectId: string;
  onOpenFile: (name: string) => void;
  onClose: () => void;
}

export function ProjectSearchPanel({ projectId, onOpenFile, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ProjectContentMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches([]);
      setSearchedQuery('');
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const result = await searchProjectContent(projectId, trimmed, { max: MAX_MATCHES });
        setMatches(result);
        setSearchedQuery(trimmed);
        setCursor(0);
        setSearching(false);
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, projectId]);

  // Group hits by file, preserving result order.
  const groups = useMemo(() => {
    const byFile = new Map<string, ProjectContentMatch[]>();
    for (const match of matches) {
      const list = byFile.get(match.file) ?? [];
      list.push(match);
      byFile.set(match.file, list);
    }
    return [...byFile.entries()];
  }, [matches]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  function open(match: ProjectContentMatch) {
    onOpenFile(match.file);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((current) => nextCursor(current, matches.length, e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = matches[cursor];
      if (hit) open(hit);
    }
  }

  const hasQuery = query.trim().length > 0;
  const emptyLabel = searching
    ? t('projectSearch.searching')
    : hasQuery && searchedQuery
      ? t('projectSearch.noMatches')
      : t('projectSearch.hint');

  let flatIndex = -1;

  return (
    <motion.div
      className="qs-overlay"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      variants={modalOverlay}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className="qs-palette ps-palette"
        onMouseDown={(e) => e.stopPropagation()}
        variants={scaleIn}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <input
          ref={inputRef}
          className="qs-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('projectSearch.placeholder')}
          spellCheck={false}
          aria-label={t('projectSearch.placeholder')}
          data-testid="project-search-input"
        />
        <div className="qs-list ps-list" ref={listRef} role="listbox">
          {matches.length === 0 ? (
            <div className="qs-empty">{emptyLabel}</div>
          ) : (
            groups.map(([file, fileMatches]) => (
              <div key={file} className="ps-group">
                <div className="ps-file" title={file}>
                  <span className="ps-file-name">{file.split('/').pop()}</span>
                  {file.includes('/') ? (
                    <span className="ps-file-dir">{file.slice(0, file.lastIndexOf('/'))}</span>
                  ) : null}
                  <span className="ps-file-count">{fileMatches.length}</span>
                </div>
                {fileMatches.map((match) => {
                  flatIndex += 1;
                  const idx = flatIndex;
                  return (
                    <div
                      key={`${match.file}:${match.line}:${idx}`}
                      data-idx={idx}
                      role="option"
                      aria-selected={idx === cursor}
                      className={`qs-row ps-row ${idx === cursor ? 'qs-row-active' : ''}`}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => open(match)}
                    >
                      <span className="ps-line">{match.line}</span>
                      <span className="ps-snippet">{highlightSnippet(match.snippet, searchedQuery)}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="qs-footer">
          <span>
            {matches.length > 0
              ? t('projectSearch.matchCount', {
                  count: String(matches.length),
                  files: String(groups.length),
                })
              : ''}
          </span>
          <span><kbd>↵</kbd> {t('quickSwitcher.open')}</span>
          <span><kbd>esc</kbd> {t('quickSwitcher.close')}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Bold the first case-insensitive occurrence of the query in the snippet. */
function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const trimmed = snippet.trim();
  if (!query) return trimmed;
  const at = trimmed.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return trimmed;
  return (
    <>
      {trimmed.slice(0, at)}
      <mark>{trimmed.slice(at, at + query.length)}</mark>
      {trimmed.slice(at + query.length)}
    </>
  );
}
