import type { Project, ProjectFile } from '../types';

function isImagePath(path: string): boolean {
  return !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path)
    && !/[\\\x00-\x1f]/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.')
    && /\.(?:png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(path);
}

function isDecorativeImage(path: string): boolean {
  return /(^|\/)(node_modules|\.git|\.next|icons?|avatars?)(\/|$)/i.test(path)
    || /(^|[-_.])(logo|favicon|icon|wordmark|brandmark|avatar|badge|sprite)([-_.\d]|$)/i.test(path.split('/').at(-1)!);
}

function imageRank(path: string): number {
  if (/(^|[\/_. -])(cover|preview|overview|summary)([_. -]|$)|封面|总览/i.test(path)) return 2;
  if (/(^|[\/_. -])(results?|plots?|figures?|charts?|spectra|spectrum|structures?)([\/_. -]|$)|结果|结构|谱图/i.test(path)) return 1;
  return 0;
}

/** Stable, bounded candidates from the project's own files; never branding placeholders. */
export function projectImageCovers(project: Project, files: ProjectFile[] = []) {
  const entry = project.metadata?.entryFile;
  const candidates = files.filter(file => file.kind === 'image'
    && isImagePath(file.path ?? file.name) && !isDecorativeImage(file.path ?? file.name))
    .sort((a, b) => imageRank(b.path ?? b.name) - imageRank(a.path ?? a.name)
      || b.mtime - a.mtime || (a.path ?? a.name).localeCompare(b.path ?? b.name))
    .map(file => file.path ?? file.name);
  if (entry && isImagePath(entry) && !isDecorativeImage(entry)) candidates.unshift(entry);
  return [...new Set(candidates)].map(name => ({ kind: 'image' as const, name }));
}

export function projectImageCover(project: Project, files: ProjectFile[] = []) {
  return projectImageCovers(project, files)[0] ?? null;
}
