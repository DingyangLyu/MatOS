import type Database from 'better-sqlite3';

/** A display name is never an id or a path. Keep Chinese and other Unicode text. */
export function validatedProjectName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('name required');
  const name = value.trim();
  if (Array.from(name).length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('project name must contain at most 160 characters and no control characters');
  }
  return name;
}

/** Echoed names in old full-record saves are not rename requests. The
 * baseline is server-owned and captured before waiting in the mutation queue,
 * so such a save cannot undo a concurrent rename either. */
export function changedProjectName(value: unknown, currentName: string, baselineName?: string): string | undefined {
  if (typeof value === 'string' && (value === currentName || value === baselineName)) return undefined;
  return validatedProjectName(value);
}

/**
 * Reserve in the existing per-user project database, not in browser state.
 * An immediate transaction also serializes independent daemon connections.
 * Reservations survive rename/deletion/restart; a failed create may leave a
 * harmless gap, but must never recycle another in-flight request's number.
 */
export function reserveUntitledProjectName(db: Database.Database, input: string): string {
  const base = validatedProjectName(input).normalize('NFKC');
  // projectDirectoryName permits 72 codepoints. Keep room for a separator
  // and the full safe-integer suffix so truncation never removes the number.
  if (Array.from(base).length > 55) throw new Error('default project name is too long');
  return db.transaction(() => {
    const previous = db.prepare('SELECT value FROM project_name_counters WHERE base = ?').get(base) as
      { value: number } | undefined;
    let number = previous?.value ?? 0;
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid project name counter');
    const names = db.prepare('SELECT name FROM projects').all() as Array<{ name: string }>;
    const normalizedNames = new Set(names.map(row => row.name.normalize('NFKC')));
    let name: string;
    do {
      number += 1;
      if (!Number.isSafeInteger(number)) throw new Error('project name counter exhausted');
      name = /[\p{Script=Han}]/u.test(base) ? `${base}（${number}）` : `${base} (${number})`;
    } while (normalizedNames.has(name.normalize('NFKC')));
    db.prepare(`INSERT INTO project_name_counters (base, value) VALUES (?, ?)
      ON CONFLICT(base) DO UPDATE SET value = excluded.value`).run(base, number);
    return name;
  }).immediate();
}
