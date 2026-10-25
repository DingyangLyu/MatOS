import { MATOS_ASSET_TYPES, type MatOSAssetType } from './types.js'

export type MatOSAssetReference = {
  raw: string
  type: string | undefined
  id: string
  version: string | undefined
}

// Deterministic, locale-independent string ordering for winner selection and
// published index ordering. `String.prototype.localeCompare` consults the
// process ICU locale, weights punctuation/case differently per locale, and
// treats control characters such as the `\0` field separators in registry
// sort keys as ignorable (two distinct keys can compare equal), so the same
// asset set could resolve or serialize differently across runtimes/locales.
// Plain `<`/`>` compares UTF-16 code units, which is identical everywhere.
export function compareMatOSAssetStrings(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

export function toMatOSAssetAlias(type: string, id: string): string {
  return `${type}:${id}`
}

export function toMatOSAssetKey(
  type: string,
  id: string,
  version: string,
): string {
  return `${toMatOSAssetAlias(type, id)}@${version}`
}

export function isMatOSAssetType(type: string): type is MatOSAssetType {
  return (MATOS_ASSET_TYPES as readonly string[]).includes(type)
}

export function parseMatOSAssetReference(raw: string): MatOSAssetReference {
  const trimmed = raw.trim()
  const separator = trimmed.indexOf(':')
  const type = separator === -1 ? undefined : trimmed.slice(0, separator)
  const idAndVersion = separator === -1 ? trimmed : trimmed.slice(separator + 1)
  const versionSeparator = idAndVersion.lastIndexOf('@')

  if (versionSeparator > 0) {
    return {
      raw,
      type,
      id: idAndVersion.slice(0, versionSeparator),
      version: idAndVersion.slice(versionSeparator + 1),
    }
  }

  return {
    raw,
    type,
    id: idAndVersion,
    version: undefined,
  }
}

type ParsedVersion = {
  main: number[]
  prerelease: string[]
}

function parseVersion(version: string): ParsedVersion {
  const hyphenIndex = version.indexOf('-')
  const mainRaw = hyphenIndex === -1 ? version : version.slice(0, hyphenIndex)
  const prereleaseRaw =
    hyphenIndex === -1 ? undefined : version.slice(hyphenIndex + 1)
  const main = mainRaw.split('.').map(part => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  return {
    main,
    prerelease: prereleaseRaw ? prereleaseRaw.split('.') : [],
  }
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a) ? Number.parseInt(a, 10) : undefined
  const bNumeric = /^\d+$/.test(b) ? Number.parseInt(b, 10) : undefined
  if (aNumeric !== undefined && bNumeric !== undefined) {
    return aNumeric - bNumeric
  }
  // Numeric identifiers sort below alphanumeric identifiers, per semver.
  if (aNumeric !== undefined) {
    return -1
  }
  if (bNumeric !== undefined) {
    return 1
  }
  // Semver compares alphanumeric identifiers in ASCII order; locale collation
  // would flip e.g. `Beta` vs `alpha` and make the winner locale-dependent.
  return compareMatOSAssetStrings(a, b)
}

export function compareMatOSAssetVersions(a: string, b: string): number {
  const aVersion = parseVersion(a)
  const bVersion = parseVersion(b)
  const mainLength = Math.max(aVersion.main.length, bVersion.main.length)

  for (let index = 0; index < mainLength; index += 1) {
    const diff = (aVersion.main[index] ?? 0) - (bVersion.main[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }

  // A release outranks any prerelease of the same main version.
  if (aVersion.prerelease.length === 0 && bVersion.prerelease.length > 0) {
    return 1
  }
  if (aVersion.prerelease.length > 0 && bVersion.prerelease.length === 0) {
    return -1
  }

  const prereleaseLength = Math.max(
    aVersion.prerelease.length,
    bVersion.prerelease.length,
  )
  for (let index = 0; index < prereleaseLength; index += 1) {
    const aPart = aVersion.prerelease[index]
    const bPart = bVersion.prerelease[index]
    if (aPart === undefined) {
      return -1
    }
    if (bPart === undefined) {
      return 1
    }
    const diff = comparePrereleaseIdentifiers(aPart, bPart)
    if (diff !== 0) {
      return diff
    }
  }

  return compareMatOSAssetStrings(a, b)
}
