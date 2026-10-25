/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
MatOSWorkbenchAction,
MatOSWorkbenchActionKey,
MatOSWorkbenchProjectSummary,
MatOSWorkbenchResource,
MatOSWorkbenchResourceType
} from './types.js'

import { projectPinEventsRef,projectPinStoreRef,type ProjectPinStore } from './projectPinStore.js'
export function countByType(resources: MatOSWorkbenchResource[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const resource of resources) {
    counts[resource.type] = (counts[resource.type] ?? 0) + 1
  }
  return counts
}

export function refsFor(resources: MatOSWorkbenchResource[], types: MatOSWorkbenchResourceType[]): string[] {
  const accepted = new Set(types)
  return resources
    .filter(resource => accepted.has(resource.type))
    .map(resource => resource.ref)
}

export function groupResources(resources: MatOSWorkbenchResource[]): MatOSWorkbenchProjectSummary['resourceGroups'] {
  const groups = new Map<MatOSWorkbenchResourceType, MatOSWorkbenchResource[]>()
  for (const resource of resources) {
    const group = groups.get(resource.type) ?? []
    group.push(resource)
    groups.set(resource.type, group)
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, group]) => ({
      type,
      count: group.length,
      resources: group,
    }))
}

export function resourceAction(resource: MatOSWorkbenchResource, key: MatOSWorkbenchActionKey): MatOSWorkbenchAction | undefined {
  return resource.actions.find(action => action.key === key)
}

export function actionRefCandidates(resources: MatOSWorkbenchResource[], key: MatOSWorkbenchActionKey): string[] {
  return resources
    .filter(resource => resourceAction(resource, key))
    .map(resource => resource.ref)
}

export function rollbackRefCandidates(resources: MatOSWorkbenchResource[]): string[] {
  return resources
    .filter(resource => {
      const rollback = resourceAction(resource, 'rollback')
      return Boolean(
        rollback &&
        (
          (resource.lineage?.rollbackTargetCount ?? 0) > 0 ||
          (resource.lineage?.releases?.length ?? 0) > 0
        ),
      )
    })
    .map(resource => resource.ref)
}

export function resourceRefsWithWarnings(resources: MatOSWorkbenchResource[]): string[] {
  return resources
    .filter(resource => (resource.warnings?.length ?? 0) > 0)
    .map(resource => resource.ref)
}

export function projectPinnedResources(
  resources: MatOSWorkbenchResource[],
  store: ProjectPinStore,
): NonNullable<MatOSWorkbenchProjectSummary['pinnedResources']> {
  const preferred: Array<{
    key: string
    label: string
    types: MatOSWorkbenchResourceType[]
    reason: string
  }> = [
    {
      key: 'primary-role',
      label: 'Primary Role',
      types: ['role'],
      reason: 'First native MatOS role.',
    },
    {
      key: 'primary-workflow',
      label: 'Primary Workflow',
      types: ['workflow'],
      reason: 'First runnable MatOS workflow.',
    },
    {
      key: 'knowledge',
      label: 'Knowledge',
      types: ['knowledge'],
      reason: 'Native knowledge asset.',
    },
    {
      key: 'tooling',
      label: 'Tooling',
      types: ['tool', 'plugin', 'mcp'],
      reason: 'Native callable/tooling asset.',
    },
    {
      key: 'skill',
      label: 'Skill',
      types: ['skill'],
      reason: 'Native skill asset available for MatOS Skill Library surfaces.',
    },
    {
      key: 'compute',
      label: 'Compute Evidence',
      types: ['compute-job', 'runtime'],
      reason: 'Native compute or runtime evidence available for Project IDE panels.',
    },
    {
      key: 'review',
      label: 'Review Evidence',
      types: ['experience', 'evolution-proposal', 'evaluation', 'benchmark'],
      reason: 'Native review/evolution/evaluation asset available for audit surfaces.',
    },
    {
      key: 'trace',
      label: 'Trace',
      types: ['trace'],
      reason: 'Native trace evidence available for debugging and provenance.',
    },
  ]
  const seen = new Set<string>()
  const items: NonNullable<MatOSWorkbenchProjectSummary['pinnedResources']>['items'] = []
  const byRef = new Map(resources.map(resource => [resource.ref, resource]))
  for (const pin of store.pins) {
    const resource = byRef.get(pin.ref)
    if (!resource || seen.has(resource.ref)) {
      continue
    }
    seen.add(resource.ref)
    items.push({
      key: `stored:${resource.ref}`,
      label: pin.label ?? resource.name,
      reason: pin.reason ?? 'Pinned by the native MatOS Project IDE preference store.',
      source: 'stored',
      pinnedAt: pin.pinnedAt,
      updatedAt: pin.updatedAt,
      ref: resource.ref,
      type: resource.type,
      resource: projectSummaryResource(resource),
    })
  }
  for (const pin of preferred) {
    const match = pin.types
      .map(type => resources.find(resource => resource.type === type && !seen.has(resource.ref)))
      .find((resource): resource is MatOSWorkbenchResource => Boolean(resource))
    if (!match) {
      continue
    }
    seen.add(match.ref)
    items.push({
      key: pin.key,
      label: pin.label,
      reason: pin.reason,
      source: 'derived',
      ref: match.ref,
      type: match.type,
      resource: projectSummaryResource(match),
    })
  }
  return {
    mode: 'native-project-pins',
    policy: {
      persistence: 'native-workbench-store',
      storeRef: projectPinStoreRef(),
      eventLogRef: projectPinEventsRef(),
      write: {
        enabled: true,
        reason: 'Project pinning is stored in the native MatOS workspace preference store and audited in a JSONL event log.',
      },
    },
    items,
  }
}

export function projectReviewState(
  resources: MatOSWorkbenchResource[],
): NonNullable<MatOSWorkbenchProjectSummary['reviewState']> {
  const draftRefs = resources
    .filter(resource => resource.lifecycle === 'draft' || resource.status === 'draft')
    .map(resource => resource.ref)
  const disabledRefs = resources
    .filter(resource => resource.lifecycle === 'disabled' || resource.status === 'disabled')
    .map(resource => resource.ref)
  const warningRefs = resourceRefsWithWarnings(resources)
  const evolutionRefs = refsFor(resources, ['experience', 'evolution-proposal', 'evaluation'])
  const blockedMutationCount = resources.reduce((count, resource) => {
    return count + resource.actions.filter(action =>
      action.maturity === 'controlled-mutation' && action.enabled === false
    ).length
  }, 0)
  const attentionCount = draftRefs.length + disabledRefs.length + warningRefs.length
  return {
    mode: 'native-project-review-summary',
    status: attentionCount > 0 ? 'attention' : evolutionRefs.length > 0 ? 'ready' : 'idle',
    counts: {
      draft: draftRefs.length,
      disabled: disabledRefs.length,
      warning: warningRefs.length,
      evolution: evolutionRefs.length,
      blockedMutation: blockedMutationCount,
    },
    refs: {
      draft: draftRefs,
      disabled: disabledRefs,
      warning: warningRefs,
      evolution: evolutionRefs,
    },
    policy: {
      source: 'matos-resource-facade',
      hiddenInternalEvolution: true,
    },
  }
}

export function projectReleaseState(
  resources: MatOSWorkbenchResource[],
): NonNullable<MatOSWorkbenchProjectSummary['releaseState']> {
  const publishCandidateRefs = actionRefCandidates(resources, 'publish')
  const rollbackCandidateRefs = rollbackRefCandidates(resources)
  return {
    mode: 'native-project-release-summary',
    status: rollbackCandidateRefs.length > 0
      ? 'rollback-ready'
      : publishCandidateRefs.length > 0
        ? 'preview-ready'
        : 'idle',
    publishCandidateRefs,
    rollbackCandidateRefs,
    policy: {
      source: 'matos-asset-history',
      applyRequiresConfirmation: true,
      sharedGlobalPromotion: 'operator-gated',
    },
  }
}

export function projectHealth(
  resources: MatOSWorkbenchResource[],
  reviewState: NonNullable<MatOSWorkbenchProjectSummary['reviewState']>,
  releaseState: NonNullable<MatOSWorkbenchProjectSummary['releaseState']>,
): NonNullable<MatOSWorkbenchProjectSummary['health']> {
  const checks: NonNullable<MatOSWorkbenchProjectSummary['health']>['checks'] = [
    {
      key: 'resources',
      label: 'Native Resources',
      status: resources.length > 0 ? 'passed' : 'blocked',
      count: resources.length,
      refs: resources.slice(0, 25).map(resource => resource.ref),
      summary: resources.length > 0
        ? `${resources.length} native MatOS resources are visible to Project IDE.`
        : 'No native MatOS resources were visible to Project IDE.',
    },
    {
      key: 'review-attention',
      label: 'Review Attention',
      status: reviewState.status === 'attention' ? 'warning' : 'passed',
      count: reviewState.counts.draft + reviewState.counts.disabled + reviewState.counts.warning,
      refs: [
        ...reviewState.refs.draft,
        ...reviewState.refs.disabled,
        ...reviewState.refs.warning,
      ].slice(0, 25),
      summary: reviewState.status === 'attention'
        ? 'Draft, disabled, or warning-bearing resources need review.'
        : 'No draft, disabled, or warning-bearing resources are visible in the project summary.',
    },
    {
      key: 'release-gates',
      label: 'Release Gates',
      status: releaseState.status === 'idle' ? 'warning' : 'passed',
      count: releaseState.publishCandidateRefs.length + releaseState.rollbackCandidateRefs.length,
      refs: [
        ...releaseState.publishCandidateRefs,
        ...releaseState.rollbackCandidateRefs,
      ].slice(0, 25),
      summary: releaseState.status === 'idle'
        ? 'No native release preview targets are currently exposed.'
        : 'Native release preview or rollback targets are exposed through MatOS asset-history gates.',
    },
  ]
  const hasBlocked = checks.some(check => check.status === 'blocked')
  const hasWarning = checks.some(check => check.status === 'warning')
  return {
    mode: 'native-project-health-summary',
    status: hasBlocked ? 'empty' : hasWarning ? 'needs-attention' : 'ready',
    checks,
  }
}

export function projectSummaryResource(resource: MatOSWorkbenchResource): MatOSWorkbenchResource {
  return {
    id: resource.id,
    ref: resource.ref,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    scopeRef: resource.scopeRef,
    lifecycle: resource.lifecycle,
    status: resource.status,
    icon: resource.icon,
    tags: resource.tags?.slice(0, 8),
    owner: resource.owner,
    updatedAt: resource.updatedAt,
    source: resource.source,
    packId: resource.packId,
    version: resource.version,
    actions: [],
    warnings: resource.warnings,
  }
}

export function mergeResourcesByRef(resources: MatOSWorkbenchResource[]): MatOSWorkbenchResource[] {
  const seen = new Set<string>()
  const merged: MatOSWorkbenchResource[] = []
  for (const resource of resources) {
    const key = resource.ref || resource.id
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(resource)
  }
  return merged
}
