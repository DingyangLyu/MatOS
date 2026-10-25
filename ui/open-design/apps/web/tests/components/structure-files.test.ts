import { describe, expect, it } from 'vitest';
import {
  isStructureFileName,
  structureFileHasTextMode,
  structureViewKind,
} from '../../src/components/structure-files';

describe('structure-files', () => {
  it('detects single-structure text formats', () => {
    expect(structureViewKind('LiFePO4.cif')).toBe('structure');
    expect(structureViewKind('nested/dir/molecule.XYZ')).toBe('structure');
    expect(structureViewKind('relaxed.extxyz')).toBe('structure');
    expect(structureViewKind('protein.pdb')).toBe('structure');
    expect(structureViewKind('slab.vasp')).toBe('structure');
    expect(structureViewKind('structure.poscar')).toBe('structure');
  });

  it('detects extension-less VASP names', () => {
    expect(structureViewKind('POSCAR')).toBe('structure');
    expect(structureViewKind('CONTCAR')).toBe('structure');
    expect(structureViewKind('runs/relax/POSCAR')).toBe('structure');
    expect(structureViewKind('POSCAR.original')).toBe('structure');
    expect(structureViewKind('XDATCAR')).toBe('trajectory');
  });

  it('detects trajectory container formats', () => {
    expect(structureViewKind('md.traj')).toBe('trajectory');
    expect(structureViewKind('run.h5')).toBe('trajectory');
    expect(structureViewKind('relax.hdf5')).toBe('trajectory');
    expect(structureViewKind('frames.npz')).toBe('trajectory');
  });

  it('handles compressed suffixes', () => {
    expect(structureViewKind('TiO2.cif.gz')).toBe('structure');
    expect(structureViewKind('md.traj.gz')).toBe('trajectory');
  });

  it('leaves ordinary files alone', () => {
    expect(structureViewKind('notes.md')).toBeNull();
    expect(structureViewKind('index.html')).toBeNull();
    expect(structureViewKind('data.json')).toBeNull();
    expect(structureViewKind('script.py')).toBeNull();
    expect(isStructureFileName('style.css')).toBe(false);
  });

  it('offers text mode only for text-based formats', () => {
    expect(structureFileHasTextMode('LiFePO4.cif')).toBe(true);
    expect(structureFileHasTextMode('POSCAR')).toBe(true);
    expect(structureFileHasTextMode('md.traj')).toBe(false);
    expect(structureFileHasTextMode('run.h5')).toBe(false);
  });
});
