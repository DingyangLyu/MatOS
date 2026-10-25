import { useEffect, useState } from 'react';
import type { Project, ProjectFile } from '../types';
import { fetchProjectCoverFiles, projectFileUrl } from '../providers/registry';
import { projectImageCover, projectImageCovers } from '../utils/projectImageCover';
import styles from './ProjectCardContents.module.css';

export function ProjectCardContents({ project }: { project: Project }) {
  // Discard failed candidates when the project files/entry change, including after rename.
  return <Contents key={`${project.id}:${project.updatedAt}:${project.metadata?.entryFile ?? ''}`} project={project} />;
}

function Contents({ project }: { project: Project }) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const explicit = projectImageCover(project);
  const needsFiles = !explicit || failed.has(explicit.name);

  useEffect(() => {
    if (!needsFiles) return;
    let active = true;
    void fetchProjectCoverFiles(project.id).then(result => {
      if (active) setFiles(result);
    }).catch(() => { /* A missing cover never blocks project navigation. */ });
    return () => { active = false; };
  }, [project.id, needsFiles]);

  const cover = projectImageCovers(project, files).find(candidate => !failed.has(candidate.name));
  const reject = (name: string) => setFailed(current => new Set([...current, name]));

  return <div className={`${styles.contents}${cover ? '' : ` ${styles.textOnly}`}`}>
    {cover ? <div className={styles.preview} data-project-cover>
      <img key={cover.name} src={projectFileUrl(project.id, cover.name)} alt="" loading="lazy"
        onError={() => reject(cover.name)} onLoad={event => {
          const image = event.currentTarget;
          if (image.naturalWidth < 160 || image.naturalHeight < 80) reject(cover.name);
        }} />
    </div> : null}
    <div className={styles.title} data-project-title title={project.name}><span>{project.name}</span></div>
  </div>;
}
