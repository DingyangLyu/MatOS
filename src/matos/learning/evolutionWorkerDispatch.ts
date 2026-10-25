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

import { spawn, type SpawnOptions } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MatOSSelfEvolutionTrigger } from './evolutionMonitor.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'

export type MatOSEvolutionSessionTriggerWorkerInput = {
  cwd: string
  sessionId: string
  sessionPath: string
  trigger: MatOSSelfEvolutionTrigger
  hidden?: boolean
}

export type MatOSEvolutionSessionCloseWorkerInput = {
  cwd: string
  sessionId: string
  sessionPath: string
  hidden?: boolean
}

export type MatOSWorkflowEvidenceEvolutionWorkerInput = {
  cwd: string
  evidence: MatOSWorkflowEvidence
}

function evolutionWorkerEntrypointPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'matos-evolution-worker.ts',
  )
}

function envFlagEnabled(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  )
}

// Mirrors the disabled provider ids in evolutionProvider.ts (not imported to
// avoid a module cycle): a deployment that selects the disabled provider must
// also suppress detached workers and scheduled background fallbacks.
function evolutionProviderDisabledByEnv(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return (
    normalized === 'disabled' || normalized === 'none' || normalized === 'off'
  )
}

export function evolutionWorkerSuppressedByEnv(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): boolean {
  return (
    envFlagEnabled(env.MATOS_BENCHMARK_MODE) ||
    envFlagEnabled(env.MATOS_DISABLE_EVOLUTION) ||
    envFlagEnabled(env.MATOS_DISABLE_EVOLUTION_WORKER) ||
    envFlagEnabled(env.MATOS_DISABLE_EVOLUTION_JOBS) ||
    envFlagEnabled(env.MATOS_DISABLE_REFLECTION_FORK) ||
    envFlagEnabled(env.MATOS_DISABLE_SELF_EVOLUTION) ||
    envFlagEnabled(env.MATOS_DISABLE_ALWAYS_ON_LEARNING) ||
    evolutionProviderDisabledByEnv(env.MATOS_EVOLUTION_PROVIDER)
  )
}

// A .ts worker entrypoint is only executable by a bun runtime. Node bundles
// (bin/matos gateway runs .mjs under node) would spawn node with a .ts entry:
// spawn() itself succeeds, the child dies asynchronously, and evolution went
// silently dead because the "spawned" result skipped the inline fallback.
export function evolutionWorkerEntrypointRunnableByRuntime(
  entrypoint: string,
  runtime: { execPath?: string; bunVersion?: string } = {},
): boolean {
  if (!entrypoint.endsWith('.ts')) {
    return true
  }
  const bunVersion =
    'bunVersion' in runtime ? runtime.bunVersion : process.versions.bun
  if (bunVersion) {
    return true
  }
  const exec = basename(runtime.execPath ?? process.execPath).toLowerCase()
  return exec === 'bun' || exec.startsWith('bun.') || exec.startsWith('bun-')
}

/**
 * Project member-binding env inherited from a visible project session. Hidden
 * evolution runners are internal infrastructure, not project members: an
 * inherited MATOS_PROJECT_MEMBER_ID made every stage role launch inside a
 * project cwd fail the member gate ("project member 'x' is not bound to
 * role:user-feedback-critic", src/matos/cli/run.ts project-access wiring), and
 * inherited write-lock claims would let a detached worker skip real project
 * write-lock acquisition after the owning session exited
 * (src/matos/runtime/projectWriteLock.ts). Scope/user/provider env such as
 * MATOS_USER_ID, MATOS_SCOPE_ID/MATOS_SCOPE_REF, and provider credentials is
 * intentionally preserved because scoped provider-profile resolution depends
 * on it.
 */
export const HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS = [
  'MATOS_LAB_ACTOR_FILE',
  'MATOS_PROJECT_MEMBER_ID',
  'MATOS_PROJECT_ORIGIN_ROLE_REF',
  'MATOS_PROJECT_WRITE_LOCK_HELD',
  'MATOS_PROJECT_WRITE_LOCK_CWD',
] as const

export function hiddenEvolutionWorkerEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    MATOS_INTERNAL_HIDDEN_RUN: '1',
    MATOS_BACKGROUND_EVOLUTION_WORKER: '1',
  }
  for (const key of HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS) {
    delete env[key]
  }
  return env
}

function spawnDetachedEvolutionWorker(
  args: string[],
  options: SpawnOptions,
): boolean {
  if (evolutionWorkerSuppressedByEnv()) {
    return false
  }
  if (!evolutionWorkerEntrypointRunnableByRuntime(args[0] ?? '')) {
    return false
  }
  try {
    const child = spawn(process.execPath, args, options)
    child.on('error', () => {
      // Detached self-evolution must never fail the foreground user path.
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

export function sessionTriggerEvolutionWorkerArgs(
  input: MatOSEvolutionSessionTriggerWorkerInput,
): string[] {
  const trigger = input.trigger
  return [
    evolutionWorkerEntrypointPath(),
    'session-trigger',
    '--cwd',
    input.cwd,
    '--session-id',
    input.sessionId,
    '--session-path',
    input.sessionPath,
    '--trigger-kind',
    trigger.kind,
    '--trigger-key',
    trigger.key,
    '--summary',
    trigger.summary,
    ...(trigger.eventId ? ['--event-id', trigger.eventId] : []),
    ...(trigger.targetAssetTypes?.length
      ? ['--target-asset-types', trigger.targetAssetTypes.join(',')]
      : []),
    // Without this, spawned workers rebuild the trigger without its preferred
    // refs and the strict tool-contract path never runs.
    ...(trigger.targetAssetRefs?.length
      ? ['--target-asset-refs', trigger.targetAssetRefs.join(',')]
      : []),
    ...(trigger.experienceOnly ? ['--experience-only'] : []),
    // Candidate triggers only passed the cheap heuristic; the worker must
    // re-run the semantic classifier before starting the hidden pipeline.
    ...(trigger.semanticCandidate ? ['--semantic-candidate'] : []),
    ...(input.hidden ? ['--hidden'] : []),
  ]
}

export function spawnSessionTriggerEvolutionWorker(
  input: MatOSEvolutionSessionTriggerWorkerInput,
): boolean {
  return spawnDetachedEvolutionWorker(sessionTriggerEvolutionWorkerArgs(input), {
    cwd: input.cwd,
    detached: true,
    env: hiddenEvolutionWorkerEnv(),
    stdio: 'ignore',
  })
}

export function spawnSessionCloseEvolutionWorker(
  input: MatOSEvolutionSessionCloseWorkerInput,
): boolean {
  return spawnDetachedEvolutionWorker(
    [
      evolutionWorkerEntrypointPath(),
      'session-close',
      '--cwd',
      input.cwd,
      '--session-id',
      input.sessionId,
      '--session-path',
      input.sessionPath,
      ...(input.hidden ? ['--hidden'] : []),
    ],
    {
      cwd: input.cwd,
      detached: true,
      env: hiddenEvolutionWorkerEnv(),
      stdio: 'ignore',
    },
  )
}

export function spawnWorkflowEvidenceEvolutionWorker(
  input: MatOSWorkflowEvidenceEvolutionWorkerInput,
): boolean {
  const evidencePath = input.evidence.path
  if (!evidencePath) {
    return false
  }
  return spawnDetachedEvolutionWorker(
    [
      evolutionWorkerEntrypointPath(),
      'workflow-evidence',
      '--cwd',
      input.cwd,
      '--evidence',
      evidencePath,
    ],
    {
      cwd: input.cwd,
      detached: true,
      env: hiddenEvolutionWorkerEnv(),
      stdio: 'ignore',
    },
  )
}
