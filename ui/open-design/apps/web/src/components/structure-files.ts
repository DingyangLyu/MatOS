// Atomistic structure / trajectory file detection for the MatterViz viewer.
//
// Anything matched here gets the 3D visualization surface by default (with a
// text-mode toggle for the text-based formats). Detection is name-based so it
// works regardless of the daemon's mime-driven `kind` (e.g. binary ASE .traj
// arrives as kind 'binary', POSCAR has no extension at all).

/** Multi-frame formats the MatterViz Trajectory player handles. */
const TRAJECTORY_EXTENSIONS = new Set(['traj', 'h5', 'hdf5', 'npz']);

/** Single-structure text formats the MatterViz Structure viewer parses. */
const STRUCTURE_EXTENSIONS = new Set([
  'cif',
  'mcif',
  'poscar',
  'vasp',
  'xyz',
  'extxyz',
  'pdb',
]);

/** Extension-less VASP file names that are structures (case-insensitive). */
const VASP_BASENAMES = new Set(['poscar', 'contcar']);

/** Multi-frame VASP MD output; plays in the Trajectory component. */
const VASP_TRAJECTORY_BASENAMES = new Set(['xdatcar']);

function baseName(name: string): string {
  return (name.split('/').pop() ?? name).toLowerCase();
}

function extensionOf(base: string): string {
  // Strip a trailing compression suffix first (structure.cif.gz).
  const stripped = base.replace(/\.(gz|bz2|xz)$/, '');
  const dot = stripped.lastIndexOf('.');
  return dot >= 0 ? stripped.slice(dot + 1) : '';
}

export type StructureViewKind = 'structure' | 'trajectory';

/** Which MatterViz surface should render this file, or null when none. */
export function structureViewKind(name: string): StructureViewKind | null {
  const base = baseName(name);
  const stem = base.replace(/\.(gz|bz2|xz)$/, '');
  if (VASP_TRAJECTORY_BASENAMES.has(stem)) return 'trajectory';
  if (VASP_BASENAMES.has(stem) || VASP_BASENAMES.has(stem.split('.')[0] ?? '')) {
    return 'structure';
  }
  const ext = extensionOf(base);
  if (TRAJECTORY_EXTENSIONS.has(ext)) return 'trajectory';
  if (STRUCTURE_EXTENSIONS.has(ext)) return 'structure';
  return null;
}

export function isStructureFileName(name: string): boolean {
  return structureViewKind(name) !== null;
}

/** Binary formats have no readable text mode; the toggle hides for them. */
export function structureFileHasTextMode(name: string): boolean {
  const ext = extensionOf(baseName(name));
  return !TRAJECTORY_EXTENSIONS.has(ext) || ext === '';
}
