function matOSSkillRuntimeNameParts(assetId: string): string[] {
  return assetId
    .split(/[\\/]+/)
    .map(part => part.trim().replace(/[^A-Za-z0-9_.-]+/g, '-'))
    .map(part => part.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
}

export function matOSSkillRuntimeName(assetId: string): string {
  const parts = matOSSkillRuntimeNameParts(assetId)
  return parts.join('__') || 'skill'
}

export function matOSSkillRuntimeLeafAlias(assetId: string): string | undefined {
  const parts = matOSSkillRuntimeNameParts(assetId)
  if (parts.length <= 1) {
    return undefined
  }
  return parts[parts.length - 1]
}
