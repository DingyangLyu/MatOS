import type { ProjectFile } from '../types';

export const MAX_AUTODETECT_TEXT_FILE_BYTES = 8 * 1024 * 1024;
export const TEXT_SNIFF_BYTES = 64 * 1024;

export function shouldAutodetectTextFile(file: ProjectFile): boolean {
  return (
    file.kind === 'binary' &&
    Number.isFinite(file.size) &&
    file.size >= 0 &&
    file.size <= MAX_AUTODETECT_TEXT_FILE_BYTES
  );
}

/**
 * Conservative UTF-8 text sniffing for an otherwise unknown file type.
 * Genuine binary formats nearly always contain NULs, invalid UTF-8, or a
 * meaningful density of non-whitespace control bytes in their first 64 KiB.
 */
export function isProbablyUtf8Text(input: ArrayBuffer | Uint8Array): boolean {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bytes = source.subarray(0, TEXT_SNIFF_BYTES);
  if (bytes.length === 0) return true;

  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controlBytes += 1;
    } else if (byte === 0x7f) {
      controlBytes += 1;
    }
  }
  if (controlBytes > Math.max(2, Math.floor(bytes.length * 0.01))) return false;

  try {
    // `stream: true` tolerates a multibyte code point split exactly at the
    // sniff boundary while still rejecting malformed sequences inside it.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}
