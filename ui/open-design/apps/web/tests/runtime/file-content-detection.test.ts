import { describe, expect, it } from 'vitest';

import {
  isProbablyUtf8Text,
  MAX_AUTODETECT_TEXT_FILE_BYTES,
  shouldAutodetectTextFile,
} from '../../src/runtime/file-content-detection';
import type { ProjectFile } from '../../src/types';

function file(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'unknown.payload',
    path: 'unknown.payload',
    size: 1024,
    mtime: 1,
    kind: 'binary',
    mime: 'application/octet-stream',
    ...overrides,
  };
}

describe('unknown project-file text detection', () => {
  it('recognizes UTF-8 scientific output, JSONL, and empty files as text', () => {
    expect(isProbablyUtf8Text(new TextEncoder().encode('! total energy = -10.2 Ry\n'))).toBe(true);
    expect(isProbablyUtf8Text(new TextEncoder().encode('{"event":"done"}\n{"event":"saved"}\n'))).toBe(true);
    expect(isProbablyUtf8Text(new Uint8Array())).toBe(true);
    expect(isProbablyUtf8Text(new TextEncoder().encode('中文计算结果\n'))).toBe(true);
  });

  it('keeps NUL-bearing, malformed UTF-8, and control-heavy payloads binary', () => {
    expect(isProbablyUtf8Text(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(false);
    expect(isProbablyUtf8Text(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBe(false);
    expect(isProbablyUtf8Text(Uint8Array.from([1, 2, 3, 4, 5, 65]))).toBe(false);
  });

  it('only auto-probes bounded files already classified as binary', () => {
    expect(shouldAutodetectTextFile(file())).toBe(true);
    expect(shouldAutodetectTextFile(file({ size: 0 }))).toBe(true);
    expect(
      shouldAutodetectTextFile(file({ size: MAX_AUTODETECT_TEXT_FILE_BYTES + 1 })),
    ).toBe(false);
    expect(shouldAutodetectTextFile(file({ kind: 'text', mime: 'text/plain' }))).toBe(false);
  });
});
