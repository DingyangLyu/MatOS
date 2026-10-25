// No-op stand-in for the optional @wooorm/starry-night syntax highlighter
// that svelte-multiselect (a matterviz dependency) tries to dynamic-import.
// We don't ship the docs-oriented highlighter in the viewer bundle; returning
// benign no-ops keeps the import resolvable without the runtime page error.

export const common: unknown[] = [];

export async function createStarryNight(): Promise<{
  highlight: (code: string, scope: string) => { type: string; children: unknown[] };
  flagToScope: (flag: string) => string | undefined;
  register: (grammars: unknown[]) => Promise<void>;
}> {
  return {
    highlight: () => ({ type: 'root', children: [] }),
    flagToScope: () => undefined,
    register: async () => {},
  };
}

export default { common, createStarryNight };
