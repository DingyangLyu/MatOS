/** Project picker selections are subscriptions to an accepted scoped identity,
 * not immutable dependency pins. Older pickers persisted the displayed version;
 * interpret those records the same way, without rewriting metadata during reads.
 * Operators can opt an entire reproducibility project into `pinned`; explicit
 * CLI --asset arguments and manifest dependencies never pass through this helper.
 * The registry still enforces scope, lifecycle and exact dependency resolution.
 */
export function matOSProjectAssetRefs(metadata: Record<string, unknown>): string[] {
  const policy = metadata.assetVersionPolicy ?? 'follow-accepted'
  if (policy !== 'follow-accepted' && policy !== 'pinned') {
    throw new Error(`Invalid MatOS project asset version policy: ${String(policy)}`)
  }
  const refs = Array.isArray(metadata.assetRefs)
    ? metadata.assetRefs.flatMap(value => typeof value === 'string' && value.trim() ? [value.trim()] : [])
    : []
  return [...new Set(refs.map(ref => policy === 'pinned' ? ref : ref.replace(/@[^@]+$/, '')))].slice(0, 64)
}

/** An explicit per-run selection overrides the project's following default for
 * that identity. Never load both the pinned and latest version unintentionally.
 */
export function matOSRunAssetRefs(metadata: Record<string, unknown>, explicit: readonly string[]): string[] {
  const refs = explicit.map(ref => ref.trim()).filter(Boolean)
  const identities = new Set(refs.map(ref => ref.replace(/@[^@]+$/, '')))
  return [...new Set([
    ...matOSProjectAssetRefs(metadata).filter(ref => !identities.has(ref.replace(/@[^@]+$/, ''))),
    ...refs,
  ])].slice(0, 64)
}
