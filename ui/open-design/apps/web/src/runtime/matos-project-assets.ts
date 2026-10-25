/** The picker selects an identity, not the catalog's displayed version. */
export function projectAssetSelectionRefs(refs: readonly string[], policy: 'follow-accepted' | 'pinned' = 'follow-accepted'): string[] {
  return [...new Set(refs.map(ref => policy === 'pinned' ? ref.trim() : ref.trim().replace(/@[^@]+$/, '')).filter(Boolean))];
}
