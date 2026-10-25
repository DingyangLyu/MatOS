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

import { randomUUID } from 'node:crypto'
import {
  runMatOSSelfEvolutionForSession,
  runMatOSSelfEvolutionForWorkflowEvidence,
  type MatOSSelfEvolutionTrigger,
} from './evolutionMonitor.js'
import {
  evolutionWorkerSuppressedByEnv,
  spawnSessionCloseEvolutionWorker,
  spawnSessionTriggerEvolutionWorker,
  spawnWorkflowEvidenceEvolutionWorker,
} from './evolutionWorkerDispatch.js'
import {
  MATOS_EVOLUTION_TARGET_ASSET_TYPES,
  type MatOSEvolutionTargetAssetType,
} from './evolutionTargetGovernance.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'

export {
  spawnSessionCloseEvolutionWorker,
  spawnSessionTriggerEvolutionWorker,
  spawnWorkflowEvidenceEvolutionWorker,
}

export type MatOSEvolutionSessionCloseInput = {
  cwd: string
  sessionId: string
  sessionPath: string
  hidden?: boolean
}

export type MatOSWorkflowEvidenceEvolutionInput = {
  cwd: string
  evidence: MatOSWorkflowEvidence
}

export type MatOSManualEvolutionAssetType =
  | 'auto'
  | 'experience'
  | MatOSEvolutionTargetAssetType

export type MatOSManualEvolutionInput = {
  cwd: string
  sessionId: string
  sessionPath: string
  assetTypes: readonly MatOSManualEvolutionAssetType[]
  trigger?: MatOSSelfEvolutionTrigger
}

export type MatOSEvolutionProvider = {
  id: string
  enabled: boolean
  scheduleSessionCloseJobs: (
    input: MatOSEvolutionSessionCloseInput,
  ) => Promise<void>
  createWorkflowEvidenceJobs: (
    input: MatOSWorkflowEvidenceEvolutionInput,
  ) => Promise<void>
}

const disabledProvider: MatOSEvolutionProvider = {
  id: 'disabled',
  enabled: false,
  scheduleSessionCloseJobs: async () => undefined,
  createWorkflowEvidenceJobs: async () => undefined,
}

export function scheduleMatOSBackgroundEvolutionTask(
  task: () => Promise<void>,
): void {
  if (evolutionWorkerSuppressedByEnv()) {
    return
  }
  const rawDelay = Number(process.env.MATOS_BACKGROUND_EVOLUTION_DELAY_MS)
  const delayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1000
  const timer = setTimeout(() => {
    void task().catch(() => {
      // Background self-evolution must never fail the foreground user path.
    })
  }, delayMs)
  timer.unref?.()
}

function normalizeManualEvolutionAssetType(
  value: string,
): MatOSManualEvolutionAssetType | undefined {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized) {
    return undefined
  }
  const singular = normalized.endsWith('s')
    ? normalized.slice(0, -1)
    : normalized
  if (singular === 'auto' || singular === 'experience') {
    return singular
  }
  return (MATOS_EVOLUTION_TARGET_ASSET_TYPES as readonly string[]).includes(
    singular,
  )
    ? (singular as MatOSEvolutionTargetAssetType)
    : undefined
}

export function normalizeMatOSManualEvolutionAssetTypes(
  values: readonly string[],
): MatOSManualEvolutionAssetType[] {
  const seen = new Set<MatOSManualEvolutionAssetType>()
  for (const value of values) {
    const normalized = normalizeManualEvolutionAssetType(value)
    if (normalized) {
      seen.add(normalized)
    }
  }
  if (seen.size > 1) {
    seen.delete('auto')
  }
  return [...seen]
}

export function directMatOSManualEvolutionTargetTypes(
  values: readonly MatOSManualEvolutionAssetType[],
): MatOSEvolutionTargetAssetType[] {
  return [
    ...new Set(
      values.filter((value): value is MatOSEvolutionTargetAssetType =>
        (MATOS_EVOLUTION_TARGET_ASSET_TYPES as readonly string[]).includes(
          value,
        ),
      ),
    ),
  ].sort()
}

export function matOSManualEvolutionExperienceOnly(
  values: readonly MatOSManualEvolutionAssetType[],
): boolean {
  const normalized = normalizeMatOSManualEvolutionAssetTypes(values)
  return (
    normalized.length === 1 &&
    normalized[0] === 'experience' &&
    directMatOSManualEvolutionTargetTypes(normalized).length === 0
  )
}

export function formatMatOSManualEvolutionAssetTypes(
  values: readonly MatOSManualEvolutionAssetType[],
): string {
  const normalized = normalizeMatOSManualEvolutionAssetTypes(values)
  return (normalized.length > 0 ? normalized : ['auto']).join(', ')
}

export function buildMatOSManualEvolutionTrigger(input: {
  cwd: string
  sessionId: string
  sessionPath: string
  assetTypes: readonly MatOSManualEvolutionAssetType[]
  requestId?: string
}): MatOSSelfEvolutionTrigger {
  const assetTypes = normalizeMatOSManualEvolutionAssetTypes(input.assetTypes)
  const targetAssetTypes = directMatOSManualEvolutionTargetTypes(assetTypes)
  const experienceOnly = matOSManualEvolutionExperienceOnly(assetTypes)
  const requestId = input.requestId?.trim() || randomUUID()
  return {
    kind: 'manual-evolve',
    key: `manual-evolve:${input.sessionId}:${requestId}`,
    summary: `The user explicitly requested /evolve for target assets: ${formatMatOSManualEvolutionAssetTypes(assetTypes)}.`,
    ...(targetAssetTypes.length > 0 ? { targetAssetTypes } : {}),
    ...(experienceOnly ? { experienceOnly: true } : {}),
  }
}

export function spawnManualSessionEvolutionWorker(
  input: MatOSManualEvolutionInput,
): boolean {
  const trigger =
    input.trigger ??
    buildMatOSManualEvolutionTrigger({
      cwd: input.cwd,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      assetTypes: input.assetTypes,
    })
  return spawnSessionTriggerEvolutionWorker({
    cwd: input.cwd,
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    trigger,
  })
}

export function scheduleManualMatOSEvolutionForSession(
  input: MatOSManualEvolutionInput,
): { trigger: MatOSSelfEvolutionTrigger; spawned: boolean } {
  const trigger =
    input.trigger ??
    buildMatOSManualEvolutionTrigger({
      cwd: input.cwd,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      assetTypes: input.assetTypes,
    })
  const request = { ...input, trigger }
  const spawned = spawnManualSessionEvolutionWorker(request)
  if (!spawned) {
    scheduleMatOSBackgroundEvolutionTask(async () => {
      await runMatOSSelfEvolutionForSession({
        cwd: input.cwd,
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        trigger,
      })
    })
  }
  return { trigger, spawned }
}

const directEditorProvider: MatOSEvolutionProvider = {
  id: 'direct-editor',
  enabled: true,
  scheduleSessionCloseJobs: async input => {
    // Hidden runs (evolution stages, internal workers) must not learn from
    // themselves. The worker already no-ops on hidden input, but spawning a
    // detached bun process per hidden child just to no-op wasted a process +
    // env load on every direct-editor/critic run.
    if (input.hidden) {
      return undefined
    }
    if (spawnSessionCloseEvolutionWorker(input)) {
      return undefined
    }
    scheduleMatOSBackgroundEvolutionTask(async () => {
      await runMatOSSelfEvolutionForSession({
        ...input,
        trigger: {
          kind: 'session-end',
          key: `session-end:${input.sessionId}`,
          summary:
            'The session closed and should be checked for reusable experience.',
        },
      })
    })
    return undefined
  },
  createWorkflowEvidenceJobs: async input => {
    if (spawnWorkflowEvidenceEvolutionWorker(input)) {
      return undefined
    }
    scheduleMatOSBackgroundEvolutionTask(async () => {
      await runMatOSSelfEvolutionForWorkflowEvidence(input)
    })
    return undefined
  },
}

const providers = new Map<string, MatOSEvolutionProvider>([
  [directEditorProvider.id, directEditorProvider],
  ['experience', directEditorProvider],
  ['experience-direct-editor', directEditorProvider],
  ['native', directEditorProvider],
  [disabledProvider.id, disabledProvider],
  ['none', disabledProvider],
  ['off', disabledProvider],
])

export function registerMatOSEvolutionProvider(
  provider: MatOSEvolutionProvider,
): void {
  providers.set(provider.id, provider)
}

export function listMatOSEvolutionProviderIds(): string[] {
  return [...providers.keys()].sort()
}

const unknownProviderWarnings = new Set<string>()

export function resolveMatOSEvolutionProvider(
  env: NodeJS.ProcessEnv = process.env,
): MatOSEvolutionProvider {
  const raw = env.MATOS_EVOLUTION_PROVIDER?.trim() ?? ''
  if (!raw) {
    return directEditorProvider
  }
  const provider = providers.get(raw) ?? providers.get(raw.toLowerCase())
  if (provider) {
    return provider
  }
  // Fail safe: an unrecognized value (for example the typo "disable") must
  // not silently enable hidden LLM self-evolution runs the operator tried to
  // turn off. Warn once per value so background schedulers do not spam.
  const warningKey = raw.toLowerCase()
  if (!unknownProviderWarnings.has(warningKey)) {
    unknownProviderWarnings.add(warningKey)
    console.warn(
      `[MatOS] Unknown MATOS_EVOLUTION_PROVIDER value "${raw}"; treating self-evolution as disabled. ` +
        `Known values: ${listMatOSEvolutionProviderIds().join(', ')}.`,
    )
  }
  return disabledProvider
}
