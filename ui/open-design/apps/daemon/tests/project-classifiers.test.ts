import { describe, expect, it } from 'vitest';
import { kindFor, mimeFor } from '../src/projects.js';

// `kindFor` and `mimeFor` are the daemon's two file-classifier helpers.
// `kindFor` returns the coarse bucket the frontend dispatches to a viewer
// in `apps/web/src/components/FileViewer.tsx`; `mimeFor` is the
// Content-Type the daemon writes when serving the file directly. Both
// were uncovered until this file landed even though `kindFor` is called
// from `projects.ts`, `media.ts`, and `document-preview.ts`. These tests
// pin the contracts so future bucket extensions (e.g. issue #61's `.py`
// addition, or upcoming `.yaml` / `.toml` / `.sh`) can be made safely.

describe('kindFor', () => {
  it('classifies .sketch.json as code', () => {
    expect(kindFor('drawing.sketch.json')).toBe('code');
    expect(kindFor('nested/path/board.sketch.json')).toBe('code');
  });

  it('classifies native workflow JSON and YAML entries as workflow', () => {
    for (const name of [
      'relax.workflow.json',
      'relax.workflow.yaml',
      'relax.workflow.yml',
      'packs/relax/workflow.json',
      'packs/relax/workflow.yaml',
      'packs/relax/workflow.yml',
      'RELAX.WORKFLOW.YAML',
    ]) {
      expect(kindFor(name)).toBe('workflow');
    }
    expect(kindFor('ordinary.yaml')).toBe('text');
    expect(kindFor('workflow-notes.json')).toBe('code');
  });

  it('classifies HTML files as html', () => {
    expect(kindFor('index.html')).toBe('html');
    expect(kindFor('legacy.htm')).toBe('html');
  });

  it('classifies .svg as image', () => {
    expect(kindFor('logo.svg')).toBe('image');
  });

  it('classifies raster image extensions as image', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']) {
      expect(kindFor(`photo${ext}`)).toBe('image');
    }
  });

  it('classifies video extensions as video', () => {
    for (const ext of ['.mp4', '.mov', '.webm']) {
      expect(kindFor(`clip${ext}`)).toBe('video');
    }
  });

  it('classifies audio extensions as audio', () => {
    for (const ext of ['.mp3', '.wav', '.m4a']) {
      expect(kindFor(`track${ext}`)).toBe('audio');
    }
  });

  it('classifies markdown and plain text as text', () => {
    expect(kindFor('readme.md')).toBe('text');
    expect(kindFor('notes.txt')).toBe('text');
  });

  it('classifies code-like and line-oriented JSON extensions as code', () => {
    for (const ext of [
      '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonl',
      '.ndjson', '.ipynb', '.css', '.scss', '.py', '.r', '.cpp', '.go',
      '.rs', '.sql', '.vue',
    ]) {
      expect(kindFor(`module${ext}`)).toBe('code');
    }
  });

  it('classifies office document extensions to their respective buckets', () => {
    expect(kindFor('report.pdf')).toBe('pdf');
    expect(kindFor('memo.docx')).toBe('document');
    expect(kindFor('deck.pptx')).toBe('presentation');
    expect(kindFor('budget.xlsx')).toBe('spreadsheet');
  });

  it('classifies materials-science / simulation inputs, outputs, and logs as text', () => {
    // The original complaint: `.in` / `.out` (and friends) were treated as
    // binary and refused by the file viewer. DFT / MD / quantum-chemistry
    // codes emit ASCII inputs, outputs, logs, and data — they must open in
    // the text viewer.
    for (const ext of [
      '.in', '.out', '.log', '.dat', '.inp',
      '.pwi', '.pwo', '.fdf', '.nw', '.gjf', '.com',
      '.lammps', '.lmp', '.data', '.xsf', '.cube', '.chg',
      '.yaml', '.yml', '.toml', '.cfg', '.csv', '.slurm',
      '.rap', '.gnu', '.upf', '.pdos_tot',
    ]) {
      expect(kindFor(`calc${ext}`)).toBe('text');
    }
    expect(kindFor('si.pdos_atm#1(Si)_wfc#2(p)')).toBe('text');
  });

  it('classifies conventional extension-less project text files as text', () => {
    for (const name of ['Makefile', 'Dockerfile', 'LICENSE', 'NOTICE', 'CHANGELOG']) {
      expect(kindFor(name)).toBe('text');
    }
  });

  it('classifies extension-less VASP files (INCAR/KPOINTS/OUTCAR/…) as text', () => {
    for (const base of ['INCAR', 'KPOINTS', 'OUTCAR', 'OSZICAR', 'POTCAR', 'CHGCAR']) {
      expect(kindFor(base)).toBe('text');
      expect(kindFor(`run1/${base}`)).toBe('text');
    }
  });

  it('falls back to binary for unmapped extensions and extensionless names', () => {
    expect(kindFor('app.exe')).toBe('binary');
    expect(kindFor('archive.tar.gz')).toBe('binary');
    // WAVECAR is a large binary VASP wavefunction — must NOT be mistaken for
    // one of the ASCII VASP files above.
    expect(kindFor('WAVECAR')).toBe('binary');
    expect(kindFor('opaque-file')).toBe('binary');
    expect(kindFor('fort.5')).toBe('binary');
  });

  it('is case-insensitive on the extension', () => {
    expect(kindFor('IMG.PNG')).toBe('image');
    expect(kindFor('SCRIPT.PY')).toBe('code');
    expect(kindFor('PAGE.HTML')).toBe('html');
    expect(kindFor('REPORT.PDF')).toBe('pdf');
  });
});

describe('mimeFor', () => {
  it('returns the mapped Content-Type for known extensions', () => {
    // Web/text formats — verify the charset suffix lands so browsers
    // don't second-guess encoding.
    expect(mimeFor('a.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('a.htm')).toBe('text/html; charset=utf-8');
    expect(mimeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('a.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('a.mjs')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('a.cjs')).toBe('text/javascript; charset=utf-8');
    // `.jsx` and `.tsx` are served to browsers running Babel-standalone
    // (multi-file React prototypes), so they need a JS-family MIME — see
    // issue #336. `.ts` stays as `text/typescript` because it has no
    // browser-execution path; tooling reads it as TS source.
    expect(mimeFor('a.jsx')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('a.tsx')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('a.ts')).toBe('text/typescript; charset=utf-8');
    expect(mimeFor('a.py')).toBe('text/x-python; charset=utf-8');
    expect(mimeFor('a.json')).toBe('application/json; charset=utf-8');
    expect(mimeFor('a.jsonl')).toBe('application/x-ndjson; charset=utf-8');
    expect(mimeFor('a.ndjson')).toBe('application/x-ndjson; charset=utf-8');
    expect(mimeFor('a.ipynb')).toBe('application/json; charset=utf-8');
    expect(mimeFor('a.md')).toBe('text/markdown; charset=utf-8');
    expect(mimeFor('a.txt')).toBe('text/plain; charset=utf-8');

    // Office / PDF — opaque application types.
    expect(mimeFor('a.pdf')).toBe('application/pdf');
    expect(mimeFor('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeFor('a.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(mimeFor('a.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    // Image / video / audio — verify the IANA-canonical types so
    // browsers preview inline instead of forcing a download.
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeFor('a.gif')).toBe('image/gif');
    expect(mimeFor('a.webp')).toBe('image/webp');
    expect(mimeFor('a.avif')).toBe('image/avif');
    expect(mimeFor('a.mp4')).toBe('video/mp4');
    expect(mimeFor('a.mov')).toBe('video/quicktime');
    expect(mimeFor('a.webm')).toBe('video/webm');
    expect(mimeFor('a.mp3')).toBe('audio/mpeg');
    expect(mimeFor('a.wav')).toBe('audio/wav');
    expect(mimeFor('a.m4a')).toBe('audio/mp4');
  });

  it('serves materials-science text files as text/plain so they preview and search', () => {
    for (const name of [
      'relax.in', 'scf.out', 'md.log', 'energy.dat',
      'INCAR', 'KPOINTS', 'OUTCAR', 'run/INCAR',
      'input.pwi', 'system.lammps', 'mol.gjf', 'grid.cube',
      'si.bands.dat.rap', 'si.bands.dat.gnu', 'Si.UPF',
      'si.pdos_tot', 'si.pdos_atm#1(Si)_wfc#2(p)',
    ]) {
      expect(mimeFor(name)).toBe('text/plain; charset=utf-8');
    }
  });

  it('falls back to application/octet-stream for unmapped extensions', () => {
    // Anything outside EXT_MIME — covers archives and binaries the daemon
    // doesn't know about. Browsers receiving octet-stream typically force a
    // download, which is the safe default.
    expect(mimeFor('app.exe')).toBe('application/octet-stream');
    expect(mimeFor('archive.tar.gz')).toBe('application/octet-stream');
    // WAVECAR stays binary (large VASP wavefunction) even though sibling
    // VASP files are ASCII.
    expect(mimeFor('WAVECAR')).toBe('application/octet-stream');
    expect(mimeFor('image.bmp')).toBe('application/octet-stream');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeFor('IMG.PNG')).toBe('image/png');
    expect(mimeFor('PAGE.HTML')).toBe('text/html; charset=utf-8');
    expect(mimeFor('SCRIPT.PY')).toBe('text/x-python; charset=utf-8');
    expect(mimeFor('FOO.JSON')).toBe('application/json; charset=utf-8');
  });
});
