import { resolve } from 'node:path'

export function assertSafeEvolutionRecordId(id: string, label: string): string {
  const trimmed = id.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..')
  ) {
    throw new Error(`Invalid ${label}: ${id}`)
  }
  return trimmed
}

export function assertPathStaysUnderRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}/`)
  ) {
    throw new Error(`Path escapes ${root}`)
  }
  return resolvedCandidate
}
