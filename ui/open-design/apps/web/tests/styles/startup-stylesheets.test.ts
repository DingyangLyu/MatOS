import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Inspect the actual entry CSS dependency graph. The expanded-CSS helper
// drops external imports, which would hide a render-blocking CDN dependency.
function startupStylesheets(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const files = [css];
  for (const match of css.matchAll(/@import\s+(?:url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|['"]([^'"]+)['"])/gi)) {
    const specifier = match[1] ?? match[2]!;
    expect(specifier, `Blocking stylesheet imported by ${file}`).not.toMatch(/^(?:https?:)?\/\//i);
    if (specifier.startsWith('.')) {
      files.push(...startupStylesheets(resolve(dirname(file), specifier), seen));
    }
  }
  return files;
}

describe('workspace startup stylesheets', () => {
  it('loads styles and fonts without contacting an external font/CDN server', () => {
    const stylesheets = startupStylesheets(resolve('src/index.css'));
    expect(stylesheets.length).toBeGreaterThan(1);
    for (const css of stylesheets) {
      for (const font of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
        expect(font[1]).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i);
      }
    }
  });
});
