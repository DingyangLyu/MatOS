// Standalone materials-visualization workbench mounted as a `matterviz:<n>`
// workspace tab (see `MatterVizTabId`). It is opened from the tab strip's "+"
// launcher ("Materials viewer") and is a discoverable home for MatterViz that
// does not require the user to first find a structure file in the tree.
//
// It reuses the same MatterViz surface (`MatterVizPane`) and the same name-based
// structure/trajectory detection (`structure-files`) the FileViewer uses when a
// `.cif` / POSCAR / `.xyz` / `.traj` file is opened directly — so behaviour is
// identical, only the entry point differs. The tab lets the user pick any
// structure/trajectory file already in the project and swap between them, and
// guides them to upload one when the project has none yet.

import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import type { ProjectFile } from '../types';
import { MatterVizPane } from './MatterVizPane';
import { isStructureFileName, structureViewKind } from './structure-files';

interface Props {
  projectId: string;
  files: ProjectFile[];
  /** Open the Design Files upload picker (from the workspace launcher). */
  onUpload?: () => void;
  /** Optional file to preselect (e.g. the file that was active when opened). */
  initialFileName?: string | null;
}

export function MaterialsViewerTab({ projectId, files, onUpload, initialFileName }: Props) {
  const t = useT();

  // Every structure / trajectory file in the project, newest first, so the
  // picker offers the most relevant candidate by default.
  const structureFiles = useMemo(
    () =>
      files
        .filter((file) => isStructureFileName(file.name))
        .slice()
        .sort((a, b) => b.mtime - a.mtime),
    [files],
  );

  const defaultName = useMemo(() => {
    if (initialFileName && structureFiles.some((f) => f.name === initialFileName)) {
      return initialFileName;
    }
    return structureFiles[0]?.name ?? null;
  }, [initialFileName, structureFiles]);

  const [selectedName, setSelectedName] = useState<string | null>(defaultName);

  // Keep the selection valid as files load/refresh: fall back to the default
  // when the chosen file disappears (deleted/renamed) or none was set yet.
  useEffect(() => {
    setSelectedName((current) => {
      if (current && structureFiles.some((f) => f.name === current)) return current;
      return defaultName;
    });
  }, [defaultName, structureFiles]);

  const selectedFile = useMemo(
    () => structureFiles.find((f) => f.name === selectedName) ?? null,
    [selectedName, structureFiles],
  );
  const viewKind = selectedFile ? structureViewKind(selectedFile.name) : null;

  return (
    <div className="materials-viewer" data-testid="materials-viewer">
      <div className="materials-viewer__bar">
        <span className="materials-viewer__label">{t('materialsViewer.title')}</span>
        {structureFiles.length > 0 ? (
          <label className="materials-viewer__picker">
            <span className="materials-viewer__picker-label">{t('materialsViewer.pickLabel')}</span>
            <select
              className="materials-viewer__select"
              value={selectedName ?? ''}
              onChange={(event) => setSelectedName(event.target.value || null)}
              data-testid="materials-viewer-select"
            >
              {structureFiles.map((file) => (
                <option key={file.name} value={file.name}>
                  {file.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="materials-viewer__body">
        {selectedFile && viewKind ? (
          <MatterVizPane
            key={`${projectId}:${selectedFile.name}:${selectedFile.mtime}`}
            projectId={projectId}
            file={selectedFile}
            viewKind={viewKind}
          />
        ) : (
          <div className="materials-viewer__empty" data-testid="materials-viewer-empty">
            <div className="materials-viewer__empty-title">{t('materialsViewer.emptyTitle')}</div>
            <p className="materials-viewer__empty-body">{t('materialsViewer.emptyBody')}</p>
            {onUpload ? (
              <button
                type="button"
                className="materials-viewer__upload"
                onClick={onUpload}
                data-testid="materials-viewer-upload"
              >
                {t('materialsViewer.upload')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
