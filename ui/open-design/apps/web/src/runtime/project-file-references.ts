const REFERENCE_BOUNDARY = /[\s`"'“”‘’\[\]()<>{}:：,，.。;；!?！？]/;
const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
const isBoundary = (value: string | undefined) => value === undefined || REFERENCE_BOUNDARY.test(value);

interface PathNode {
  children: Map<string, PathNode>;
  matches?: Array<{ name: string; order: number }>;
}

/**
 * Index paths once, then walk only prefixes actually present at text boundaries.
 * Never compile/test a regular expression for every line × workspace file:
 * scientific projects can contain tens of thousands of files. Keep the same
 * case, punctuation and longest-name-first per-line semantics without truncating
 * either the transcript or the project index.
 */
export function extractKnownProjectFileRefs(
  content: string,
  projectFileNames: ReadonlySet<string>,
): string[] {
  const refs: string[] = [];
  const names = Array.from(projectFileNames)
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!content || names.length === 0) return refs;
  const root: PathNode = { children: new Map() };
  for (const [order, name] of names.entries()) {
    const normalized = normalizePath(name);
    if (!normalized) continue;
    let node = root;
    for (let i = 0; i < normalized.length; i++) {
      const character = normalized[i]!;
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    (node.matches ??= []).push({ name, order });
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = normalizePath(rawLine);
    const matches = new Map<number, string>();
    for (let start = 0; start < line.length; start++) {
      if (!isBoundary(line[start - 1])) continue;
      let node = root;
      for (let end = start; end < line.length; end++) {
        const child = node.children.get(line[end]!);
        if (!child) break;
        node = child;
        if (node.matches && isBoundary(line[end + 1])) {
          for (const match of node.matches) matches.set(match.order, match.name);
        }
      }
    }
    for (const [, name] of Array.from(matches).sort(([a], [b]) => a - b)) refs.push(name);
  }
  return refs;
}

export function lineContainsFileReference(line: string, ref: string): boolean {
  const normalizedLine = normalizePath(line);
  const normalizedRef = normalizePath(ref);
  if (!normalizedRef) return false;
  let start = normalizedLine.indexOf(normalizedRef);
  while (start !== -1) {
    if (isBoundary(normalizedLine[start - 1]) && isBoundary(normalizedLine[start + normalizedRef.length])) return true;
    start = normalizedLine.indexOf(normalizedRef, start + 1);
  }
  return false;
}
