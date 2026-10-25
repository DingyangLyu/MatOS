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

import type { MatOSEventSource } from '../sessions/eventTypes.js'
import { promptIndicatesUserFeedback } from './evolutionMonitorFeedback.js'
import { isMatOSExpectedToolGuardEvent } from './evolutionExpectedToolGuards.js'

type SelfEvolutionTriggerLike = {
  kind: string
  key: string
  eventId?: string
  summary: string
}

export type MatOSLowQualitySelfEvolutionTriggerCategory =
  | 'infrastructure-disk-full'
  | 'release-smoke-or-image-refresh'
  | 'provider-auth-or-transient'
  | 'missing-credential-or-config'
  | 'container-startup-without-agent-behavior'
  | 'expected-tool-guard-only'

export type MatOSSelfEvolutionTriggerQualityGateDecision =
  | {
      decision: 'run'
      reason: string
    }
  | {
      decision: 'skip'
      category: MatOSLowQualitySelfEvolutionTriggerCategory
      reason: string
    }

export function formatMatOSSelfEvolutionTriggerQualitySkipSummary(
  decision: Extract<MatOSSelfEvolutionTriggerQualityGateDecision, { decision: 'skip' }>,
): string {
  return `Skipped low-quality self-evolution trigger (${decision.category}): ${decision.reason}`
}

export function evaluateMatOSSelfEvolutionTriggerQualityGate(input: {
  trigger: SelfEvolutionTriggerLike
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
}): MatOSSelfEvolutionTriggerQualityGateDecision {
  const gateSetting = input.env?.MATOS_EVOLUTION_TRIGGER_QUALITY_GATE
  if (gateSetting === '0' || gateSetting === 'off' || gateSetting === 'disabled') {
    return { decision: 'run', reason: 'trigger quality gate disabled' }
  }

  if (input.trigger.kind === 'user-feedback') {
    return { decision: 'run', reason: 'explicit user feedback is always analyzed' }
  }

  if (input.trigger.kind === 'manual-evolve') {
    return { decision: 'run', reason: 'manual /evolve request is always analyzed' }
  }

  if (hasExplicitUserFeedback(input.events)) {
    return {
      decision: 'run',
      reason: 'session contains explicit user feedback',
    }
  }

  if (
    input.trigger.kind === 'session-end' &&
    hasOnlyExpectedToolGuardOutcomes(input.events)
  ) {
    return {
      decision: 'skip',
      category: 'expected-tool-guard-only',
      reason:
        'all relevant tool guard outcomes were deterministic checks working as designed, so there is no new asset failure to edit',
    }
  }

  const text = searchableTriggerText(input.trigger, input.events)
  const hasAgentBehavior = input.events.some(event =>
    [
      'matos.turn.started',
      'matos.agent.message',
      'matos.turn.completed',
      'matos.tool.call.started',
      'matos.tool.call.completed',
    ].includes(event.type),
  )

  if (/(enospc|no space left on device|disk full|fuse-overlayfs|root partition|session-env)/i.test(text)) {
    return {
      decision: 'skip',
      category: 'infrastructure-disk-full',
      reason:
        'disk/root-space infrastructure failures should be handled by runtime/storage policy, not by asset self-evolution',
    }
  }

  if (/(release smoke|smoke test|image refresh|channel image|exit125|exit code 125|zero assistant output|zero-output)/i.test(text)) {
    return {
      decision: 'skip',
      category: 'release-smoke-or-image-refresh',
      reason:
        'release smoke or image-refresh checks are deployment signals, not reusable user task evidence',
    }
  }

  if (/(missing api key|api key is not configured|missing credential|credential is not configured|provider config missing|base url is not configured)/i.test(text)) {
    return {
      decision: 'skip',
      category: 'missing-credential-or-config',
      reason:
        'missing provider/configuration prerequisites should route to login/config repair instead of asset evolution',
    }
  }

  if (/(invalid authentication credentials|401 invalid|insufficient balance|rate limit|model unavailable|provider timeout|api timeout|econnreset|etimedout)/i.test(text)) {
    return {
      decision: 'skip',
      category: 'provider-auth-or-transient',
      reason:
        'provider authentication, quota, and transient transport failures are not stable evidence for asset edits',
    }
  }

  if (
    input.trigger.kind === 'session-end' &&
    !hasAgentBehavior &&
    /(container|runtime|startup|spawn|init|entrypoint|zero output|no assistant response)/i.test(text)
  ) {
    return {
      decision: 'skip',
      category: 'container-startup-without-agent-behavior',
      reason:
        'the session ended before meaningful agent behavior, so there is no reusable trajectory to learn from',
    }
  }

  return {
    decision: 'run',
    reason: 'trigger contains task or agent evidence worth analyzing',
  }
}

function hasOnlyExpectedToolGuardOutcomes(events: MatOSEventSource[]): boolean {
  if (
    events.some(event =>
      ['matos.session.failed', 'matos.workflow.failed'].includes(event.type),
    )
  ) {
    return false
  }
  const toolCompletions = events.filter(
    event => event.type === 'matos.tool.call.completed',
  )
  const guardOutcomes = toolCompletions.filter(isMatOSExpectedToolGuardEvent)
  const actionableToolErrors = toolCompletions.filter(
    event => event.data.isError === true && !isMatOSExpectedToolGuardEvent(event),
  )
  return (
    guardOutcomes.length > 0 &&
    actionableToolErrors.length === 0
  )
}

function hasExplicitUserFeedback(events: MatOSEventSource[]): boolean {
  return events.some(event => {
    if (event.type !== 'matos.turn.started') {
      return false
    }
    const prompt = stringFromUnknown(event.data.prompt ?? event.data.promptPreview)
    return Boolean(prompt && promptIndicatesUserFeedback(prompt))
  })
}

function searchableTriggerText(
  trigger: SelfEvolutionTriggerLike,
  events: MatOSEventSource[],
): string {
  const parts = [trigger.kind, trigger.key, trigger.eventId ?? '', trigger.summary]
  for (const event of events) {
    parts.push(event.type, event.id, stringifyUnknown(event.data))
  }
  return parts.join('\n').slice(0, 80_000)
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
