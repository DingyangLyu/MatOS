import type {
MatOSWorkbenchAssetTemplateItem,
MatOSWorkbenchContext,
MatOSWorkbenchProjectSummary,
MatOSWorkbenchResource,
MatOSWorkbenchResourceType,
MatOSWorkbenchSearchRanking
} from './types.js'

import { boolValue,recordValue,searchRankingForFields,stringValue } from './projectSearchUtils.js'
export const MARKETPLACE_ALLOWED_VISIBILITY = ['shared', 'global', 'core', 'public'] as const

export function policyMetadata(resource: MatOSWorkbenchResource): Record<string, unknown> {
  const metadata = recordValue(resource.metadata)
  return {
    ...recordValue(metadata.marketplace),
    ...recordValue(metadata.template),
    ...recordValue(metadata.external),
  }
}

export function marketplaceVisibility(resource: MatOSWorkbenchResource): string | undefined {
  const metadata = recordValue(resource.metadata)
  const policy = policyMetadata(resource)
  return stringValue(policy.visibility) ??
    stringValue(policy.scope) ??
    stringValue(policy.scopeRef) ??
    stringValue(policy.scope_ref) ??
    stringValue(metadata.visibility) ??
    stringValue(metadata.scope) ??
    stringValue(metadata.scopeRef)
}

export function isSharedGlobalMarketplaceResource(resource: MatOSWorkbenchResource): boolean {
  const metadata = recordValue(resource.metadata)
  const policy = policyMetadata(resource)
  const visibility = marketplaceVisibility(resource)?.toLowerCase()
  if (visibility && (MARKETPLACE_ALLOWED_VISIBILITY as readonly string[]).includes(visibility)) {
    return true
  }
  return boolValue(policy.public) ||
    boolValue(policy.shared) ||
    boolValue(policy.global) ||
    boolValue(metadata.public) ||
    boolValue(metadata.shared) ||
    boolValue(metadata.global)
}

export function projectIdentity(input: MatOSWorkbenchContext): MatOSWorkbenchProjectSummary['project'] {
  const projectId = input.projectId ?? input.scopeRef ?? 'matos-local-project'
  return {
    id: projectId,
    name: input.projectId ? 'MatOS Project' : 'MatOS Workspace',
    cwd: input.cwd,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
  }
}

export function searchMatchScore(resource: MatOSWorkbenchResource, query: string): number {
  return resourceSearchRanking(resource, query).score
}

export function resourceSearchRanking(resource: MatOSWorkbenchResource, query: string, rank = 0): MatOSWorkbenchSearchRanking {
  return searchRankingForFields({
    query,
    rank,
    fields: [
      { field: 'id', value: resource.id, exact: 1000, prefix: 800, contains: 300 },
      { field: 'ref', value: resource.ref, exact: 950, prefix: 850, contains: 700 },
      { field: 'name', value: resource.name, exact: 900, prefix: 650, contains: 500 },
      { field: 'type', value: resource.type, exact: 450, prefix: 250, contains: 150 },
      { field: 'description', value: resource.description, exact: 250, prefix: 225, contains: 200 },
      { field: 'tags', value: (resource.tags ?? []).join(' '), exact: 700, prefix: 550, contains: 450 },
      { field: 'dependencies', value: (resource.dependencies ?? []).join(' '), exact: 350, prefix: 275, contains: 225 },
    ],
  })
}

export function rankSearchResults(resources: MatOSWorkbenchResource[], query: string): MatOSWorkbenchResource[] {
  return [...resources].sort((left, right) => {
    const scoreDelta = searchMatchScore(right, query) - searchMatchScore(left, query)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    const typeDelta = left.type.localeCompare(right.type)
    if (typeDelta !== 0) {
      return typeDelta
    }
    return left.name.localeCompare(right.name) || left.ref.localeCompare(right.ref)
  })
}

export function attachResourceSearchRankings(
  resources: MatOSWorkbenchResource[],
  query: string,
  offset = 0,
): MatOSWorkbenchResource[] {
  return resources.map((resource, index) => ({
    ...resource,
    searchRanking: resourceSearchRanking(resource, query, offset + index + 1),
  }))
}

export const TEMPLATE_RESOURCE_TYPES = new Set<MatOSWorkbenchResourceType>([
  'role',
  'workflow',
  'tool',
  'skill',
  'plugin',
  'mcp',
  'knowledge',
  'data',
  'benchmark',
  'benchmark-suite',
  'evaluation',
])

export function templateMetadata(resource: MatOSWorkbenchResource): Record<string, unknown> {
  return policyMetadata(resource)
}

export function templateCategory(resource: MatOSWorkbenchResource): string {
  const metadata = templateMetadata(resource)
  return stringValue(metadata.category) ?? stringValue(metadata.kind) ?? resource.type
}

export function templateId(resource: MatOSWorkbenchResource): string {
  const metadata = templateMetadata(resource)
  return stringValue(metadata.id) ?? stringValue(metadata.templateId) ?? resource.ref
}

export function templateItemFromResource(resource: MatOSWorkbenchResource): MatOSWorkbenchAssetTemplateItem {
  return {
    id: `template:${resource.ref}`,
    templateId: templateId(resource),
    resourceRef: resource.ref,
    type: resource.type,
    title: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    category: templateCategory(resource),
    tags: resource.tags ?? [],
    dependencies: resource.dependencies ?? [],
    ...(resource.status ? { status: resource.status } : {}),
    source: 'matos-asset-registry',
    actions: resource.actions,
    matos: resource,
  }
}

export function templateMatchesQuery(template: MatOSWorkbenchAssetTemplateItem, query: string): boolean {
  if (!query) {
    return true
  }
  const needle = query.toLowerCase()
  return [
    template.templateId,
    template.resourceRef,
    template.type,
    template.title,
    template.description,
    template.category,
    template.status,
    ...template.tags,
    ...template.dependencies,
  ].some(value => stringValue(value)?.toLowerCase().includes(needle))
}

export function templateSearchScore(template: MatOSWorkbenchAssetTemplateItem, query: string): number {
  return templateSearchRanking(template, query).score
}

export function templateSearchRanking(
  template: MatOSWorkbenchAssetTemplateItem,
  query: string,
  rank = 0,
): MatOSWorkbenchSearchRanking {
  return searchRankingForFields({
    query,
    rank,
    fields: [
      { field: 'templateId', value: template.templateId, exact: 1000, prefix: 850, contains: 650 },
      { field: 'resourceRef', value: template.resourceRef, exact: 1000, prefix: 850, contains: 600 },
      { field: 'title', value: template.title, exact: 900, prefix: 700, contains: 500 },
      { field: 'tags', value: template.tags.join(' '), exact: 850, prefix: 650, contains: 450 },
      { field: 'category', value: template.category, exact: 800, prefix: 500, contains: 300 },
      { field: 'type', value: template.type, exact: 800, prefix: 500, contains: 300 },
      { field: 'description', value: template.description, exact: 250, prefix: 225, contains: 200 },
      { field: 'dependencies', value: template.dependencies.join(' '), exact: 350, prefix: 275, contains: 225 },
    ],
  })
}
