// 3D atomistic viewer pane backed by MatterViz custom elements.
//
// The heavy MatterViz bundle (three.js + parsers, compiled from Svelte to
// <mv-structure>/<mv-trajectory> custom elements by tools/matterviz-elements)
// ships as a static asset under /matterviz/elements.js and is module-imported
// once on first use. The elements fetch and parse the file themselves via
// `data_url` (same-origin project raw URL), which keeps format handling —
// CIF/POSCAR/XYZ/EXTXYZ/PDB, ASE .traj, HDF5, XDATCAR, .gz — inside MatterViz.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { projectRawUrl } from '../providers/registry';
import type { ProjectFile } from '../types';
import type { StructureViewKind } from './structure-files';

let elementsPromise: Promise<void> | null = null;

// Loaded through a real <script type="module"> tag (not a bundler-analyzed
// dynamic import): the bundle is a static asset outside the Next build graph
// and Turbopack must not try to resolve or rewrite the specifier.
function loadMatterVizElements(): Promise<void> {
  if (typeof customElements !== 'undefined' && customElements.get('mv-structure')) {
    return Promise.resolve();
  }
  if (!elementsPromise) {
    elementsPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = '/matterviz/elements.js';
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        reject(new Error('failed to load /matterviz/elements.js'));
      };
      document.head.appendChild(script);
    });
    elementsPromise.catch(() => {
      // Allow a retry on the next mount instead of caching the failure.
      elementsPromise = null;
    });
  }
  return elementsPromise;
}

interface Props {
  projectId: string;
  file: ProjectFile;
  viewKind: StructureViewKind;
}

export function MatterVizPane({ projectId, file, viewKind }: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void loadMatterVizElements()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const tag = viewKind === 'trajectory' ? 'mv-trajectory' : 'mv-structure';
        const element = document.createElement(tag) as HTMLElement & { data_url?: string };
        element.setAttribute('data-testid', 'matterviz-element');
        element.style.width = '100%';
        element.style.height = '100%';
        // Property assignment (not attribute) so the Svelte custom element
        // receives the value through its typed prop.
        element.data_url = projectRawUrl(projectId, file.name);
        hostRef.current.replaceChildren(element);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, viewKind]);

  return (
    <div className="matterviz-pane" data-testid="matterviz-pane">
      {status === 'loading' ? (
        <div className="viewer-empty">{t('structureViewer.loading')}</div>
      ) : null}
      {status === 'error' ? (
        <div className="viewer-empty">{t('structureViewer.loadFailed')}</div>
      ) : null}
      <div
        ref={hostRef}
        className="matterviz-pane__host"
        style={{ display: status === 'ready' ? undefined : 'none' }}
      />
    </div>
  );
}
