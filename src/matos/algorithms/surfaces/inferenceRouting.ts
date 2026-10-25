import { createHash } from 'node:crypto'
import type { MatOSAsset } from '../../assets/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

export type MatOSInferenceRoute = {
  model?: string
  effort?: string | number
}

export type MatOSInferenceRoutingInput = {
  roleRef: string
  baselineRoute: MatOSInferenceRoute
  candidateRoutes: MatOSInferenceRoute[]
  taskClass?: string
  remainingBudget?: Record<string, number>
  role?: MatOSAsset
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
}

export type MatOSInferenceRoutingDecision = MatOSInferenceRoute & {
  reason?: string
}

function routeKey(route: MatOSInferenceRoute): string {
  return JSON.stringify([route.model ?? null, route.effort ?? null])
}

function roleAlgorithms(role: MatOSAsset | undefined): unknown {
  return role?.runtime.algorithms && typeof role.runtime.algorithms === 'object'
    ? role.runtime.algorithms
    : undefined
}

export const matOSInferenceRoutingSurface = createMatOSAlgorithmSurface<
  MatOSInferenceRoutingInput,
  MatOSInferenceRoutingDecision
>({
  surfaceId: 'inference-routing',
  envVar: 'MATOS_ALGO_INFERENCE_ROUTING',
  baseline: {
    description: 'Keeps the role runtime model and effort unchanged.',
    decide: input => ({ ...input.baselineRoute }),
  },
  sanitizeDecision: (decision, input) => {
    const candidates = new Map(
      [input.baselineRoute, ...input.candidateRoutes].map(route => [
        routeKey(route),
        route,
      ]),
    )
    const selected = candidates.get(routeKey(decision)) ?? input.baselineRoute
    return {
      ...selected,
      ...(typeof decision.reason === 'string' && decision.reason.trim()
        ? { reason: decision.reason.trim() }
        : {}),
    }
  },
  inputDigest: input =>
    createHash('sha256')
      .update(input.roleRef)
      .update('\u0000')
      .update(routeKey(input.baselineRoute))
      .update('\u0000')
      .update(input.candidateRoutes.map(routeKey).sort().join(','))
      .update('\u0000')
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(input.remainingBudget ?? {}).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        ),
      )
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    roleRef: input.roleRef,
    model: decision.model ?? 'default',
    effort: decision.effort ?? 'default',
    changed: routeKey(decision) !== routeKey(input.baselineRoute),
  }),
})

function effortCost(effort: string | number | undefined): number {
  if (typeof effort === 'number') return effort
  const normalized = effort?.trim().toLowerCase()
  return (
    {
      low: 1,
      medium: 2,
      high: 3,
      max: 4,
      xhigh: 5,
      ultra: 6,
    }[normalized ?? ''] ?? 3
  )
}

matOSInferenceRoutingSurface.register({
  id: 'budget-aware',
  description:
    'Selects the lowest authorized effort route only when the caller reports exhausted token or cost budget.',
  decide: input => {
    const exhausted = Object.entries(input.remainingBudget ?? {}).some(
      ([key, value]) =>
        /token|cost|call|turn/i.test(key) && Number.isFinite(value) && value <= 0,
    )
    if (!exhausted) return { ...input.baselineRoute }
    const selected = [input.baselineRoute, ...input.candidateRoutes]
      .map((route, index) => ({ route, index }))
      .sort(
        (left, right) =>
          effortCost(left.route.effort) - effortCost(right.route.effort) ||
          left.index - right.index,
      )[0]?.route
    return { ...(selected ?? input.baselineRoute), reason: 'budget-exhausted' }
  },
})

export function decideMatOSInferenceRouting(
  input: MatOSInferenceRoutingInput,
): MatOSAlgorithmDecisionOutcome<MatOSInferenceRoutingDecision> {
  return matOSInferenceRoutingSurface.decideSync(input, {
    env: input.env,
    roleAlgorithms: roleAlgorithms(input.role),
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  })
}
