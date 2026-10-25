import type { ProjectFile } from './types';
import { isUserVisibleProjectFilePath } from './runtime/project-file-visibility';

// Implicit attribution is based on project-file timing or pre/post file-list
// diffs, unless a run records the file explicitly.
export function isImplicitProducedFileCandidate(file: ProjectFile): boolean {
  return isUserVisibleProducedFile(file);
}

export function isUserVisibleProducedFile(file: ProjectFile): boolean {
  return isUserVisibleProjectFilePath(file.path ?? file.name);
}

export function filterUserVisibleProjectFiles(files: readonly ProjectFile[]): ProjectFile[] {
  return files.filter(isUserVisibleProducedFile);
}

export function filterImplicitProducedFiles(files: readonly ProjectFile[]): ProjectFile[] {
  return files.filter(isImplicitProducedFileCandidate);
}
