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
import { readFile } from 'node:fs/promises'
import { loadMatOSDeployEnvDefaults } from '../matos/deployEnvDefaults.js'
import {
  runMatOSSelfEvolutionForSession,
  runMatOSSelfEvolutionForWorkflowEvidence,
  type MatOSSelfEvolutionTriggerKind,
} from '../matos/learning/evolutionMonitor.js'
import { appendMonitorRecord } from '../matos/learning/evolutionMonitorRecords.js'
import { resolveMatOSEvolutionProvider } from '../matos/learning/evolutionProvider.js'
import { evolutionProviderCredentialsPreflight } from '../matos/learning/evolutionRoleRunner.js'
import {
  MATOS_EVOLUTION_TARGET_ASSET_TYPES,
  type MatOSEvolutionTargetAssetType,
} from '../matos/learning/evolutionTargetGovernance.js'
import { evolutionWorkerSuppressedByEnv } from '../matos/learning/evolutionWorkerDispatch.js'
import type { MatOSWorkflowEvidence } from '../matos/learning/workflowEvidence.js'
import {
  installMatOSCrashCapture,
  recordMatOSFatalExit,
} from '../matos/support/crashCapture.js'

function usage(): never {
  console.error(
    'Usage: matos-evolution-worker workflow-evidence --cwd <cwd> --evidence <path> | session-close --cwd <cwd> --session-id <id> --session-path <path> [--hidden] | session-trigger --cwd <cwd> --session-id <id> --session-path <path> --trigger-kind <kind> --trigger-key <key> --summary <summary> [--event-id <id>] [--target-asset-types <csv>] [--target-asset-refs <csv>] [--experience-only] [--semantic-candidate] [--hidden]',
  )
  process.exit(2)
}

export type MatOSEvolutionWorkerParsedArgs =
  | {
      mode: 'workflow-evidence'
      cwd: string
      evidencePath: string
    }
  | {
      mode: 'session-close'
      cwd: string
      sessionId: string
      sessionPath: string
      hidden: boolean
    }
  | {
      mode: 'session-trigger'
      cwd: string
      sessionId: string
      sessionPath: string
      triggerKind: MatOSSelfEvolutionTriggerKind
      triggerKey: string
      summary: string
      eventId: string
      targetAssetTypes: MatOSEvolutionTargetAssetType[]
      targetAssetRefs: string[]
      experienceOnly: boolean
      semanticCandidate: boolean
      hidden: boolean
    }

function parseTargetAssetTypes(value: string): MatOSEvolutionTargetAssetType[] {
  return [
    ...new Set(
      value
        .split(',')
        .map(item => item.trim())
        .filter((item): item is MatOSEvolutionTargetAssetType =>
          (MATOS_EVOLUTION_TARGET_ASSET_TYPES as readonly string[]).includes(
            item,
          ),
        ),
    ),
  ].sort()
}

function parseTriggerKind(value: string): MatOSSelfEvolutionTriggerKind {
  const known: readonly MatOSSelfEvolutionTriggerKind[] = [
    'user-feedback',
    'tool-failure',
    'workflow-failure',
    'agent-repeated-action',
    'manual-evolve',
    'session-end',
  ]
  if ((known as readonly string[]).includes(value)) {
    return value as MatOSSelfEvolutionTriggerKind
  }
  usage()
}

export function parseMatOSEvolutionWorkerArgs(
  args: string[],
): MatOSEvolutionWorkerParsedArgs {
  const [mode, ...rest] = args
  if (
    mode !== 'workflow-evidence' &&
    mode !== 'session-close' &&
    mode !== 'session-trigger'
  ) {
    usage()
  }
  let cwd = ''
  let evidencePath = ''
  let sessionId = ''
  let sessionPath = ''
  let triggerKind = ''
  let triggerKey = ''
  let summary = ''
  let eventId = ''
  let targetAssetTypes: MatOSEvolutionTargetAssetType[] = []
  let targetAssetRefs: string[] = []
  let experienceOnly = false
  let semanticCandidate = false
  let hidden = false
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--cwd') {
      cwd = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--evidence') {
      evidencePath = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--session-id') {
      sessionId = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--session-path') {
      sessionPath = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--trigger-kind') {
      triggerKind = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--trigger-key') {
      triggerKey = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--summary') {
      summary = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--event-id') {
      eventId = rest[index + 1] ?? ''
      index += 1
    } else if (arg === '--target-asset-types') {
      targetAssetTypes = parseTargetAssetTypes(rest[index + 1] ?? '')
      index += 1
    } else if (arg === '--target-asset-refs') {
      targetAssetRefs = (rest[index + 1] ?? '')
        .split(',')
        .map(ref => ref.trim())
        .filter(Boolean)
      index += 1
    } else if (arg === '--experience-only') {
      experienceOnly = true
    } else if (arg === '--semantic-candidate') {
      semanticCandidate = true
    } else if (arg === '--hidden') {
      hidden = true
    } else {
      usage()
    }
  }
  if (mode === 'workflow-evidence') {
    if (!cwd || !evidencePath) {
      usage()
    }
    return { mode, cwd, evidencePath }
  }
  if (!cwd || !sessionId || !sessionPath) {
    usage()
  }
  if (mode === 'session-trigger') {
    if (!triggerKind || !triggerKey || !summary) {
      usage()
    }
    return {
      mode,
      cwd,
      sessionId,
      sessionPath,
      triggerKind: parseTriggerKind(triggerKind),
      triggerKey,
      summary,
      eventId,
      targetAssetTypes,
      targetAssetRefs,
      experienceOnly,
      semanticCandidate,
      hidden,
    }
  }
  return { mode, cwd, sessionId, sessionPath, hidden }
}

function evolutionProviderPreflightDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = String(env.MATOS_EVOLUTION_PROVIDER_PREFLIGHT ?? '')
    .trim()
    .toLowerCase()
  if (normalized === '0' || normalized === 'off' || normalized === 'disabled') {
    return true
  }
  if (normalized === '1' || normalized === 'on') {
    return false
  }
  // Tests keep the hidden pipeline inert; without an explicit opt-in the
  // preflight must not turn a credential-less test env into skip records.
  return env.NODE_ENV === 'test'
}

// Resolve provider credentials once before dispatching the hidden pipeline.
// A worker without any usable credential previously burned a full critic role
// run to discover the auth failure; conclude with a machine-readable monitor
// record instead and never start the LLM stage.
async function evolutionWorkerProviderPreflightOk(input: {
  cwd: string
  sessionId: string
  triggerKind: MatOSSelfEvolutionTriggerKind
  triggerKey: string
}): Promise<boolean> {
  if (evolutionProviderPreflightDisabled()) {
    return true
  }
  let preflight: Awaited<
    ReturnType<typeof evolutionProviderCredentialsPreflight>
  >
  try {
    preflight = await evolutionProviderCredentialsPreflight({ cwd: input.cwd })
  } catch {
    // Resolution errors must not block the pipeline; stage-level failure
    // classification still covers a broken provider setup.
    return true
  }
  if (preflight.ok) {
    return true
  }
  const timestamp = new Date().toISOString()
  await appendMonitorRecord(input.cwd, {
    recordId: `monitor-${randomUUID()}`,
    sessionId: input.sessionId,
    triggerKind: input.triggerKind,
    triggerKey: input.triggerKey,
    status: 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
    summary:
      'Self-evolution was skipped because no usable model provider credential was available to the hidden worker; the LLM stage was not started.',
    error: `provider_credentials_unavailable scope=${preflight.scopeRef} provider=${preflight.providerType}`,
  }).catch(() => undefined)
  return false
}

// Returns false when the worker exits without dispatching because evolution is
// disabled for this process. The parent decided to spawn with its own env, but
// deploy env defaults (loaded below) and provider selection can disable
// evolution after the fact; recheck in-process so a disabled deployment never
// pays for the hidden pipeline.
export async function runMatOSEvolutionWorker(
  parsed: MatOSEvolutionWorkerParsedArgs,
): Promise<boolean> {
  await loadMatOSDeployEnvDefaults({ cwd: parsed.cwd }).catch(() => undefined)
  if (
    evolutionWorkerSuppressedByEnv() ||
    !resolveMatOSEvolutionProvider().enabled
  ) {
    return false
  }
  if (parsed.mode === 'workflow-evidence') {
    const evidence = JSON.parse(
      await readFile(parsed.evidencePath, 'utf8'),
    ) as MatOSWorkflowEvidence
    // Session/trigger identity mirrors workflowEvidenceSessionId and
    // workflowEvidenceTrigger in evolutionMonitor.ts so a preflight skip
    // record lands in the same ledger the pipeline itself would write to.
    const hasFailure =
      evidence.status === 'failed' ||
      evidence.nodeSummary.some(node => node.hasError || node.status === 'failed')
    const preflightOk = await evolutionWorkerProviderPreflightOk({
      cwd: parsed.cwd,
      sessionId: evidence.traceId ?? evidence.runId,
      triggerKind: hasFailure ? 'workflow-failure' : 'session-end',
      triggerKey: hasFailure
        ? `workflow-failure:${evidence.evidenceId}`
        : `workflow-session-end:${evidence.evidenceId}`,
    })
    if (!preflightOk) {
      return false
    }
    await runMatOSSelfEvolutionForWorkflowEvidence({
      cwd: parsed.cwd,
      evidence: { ...evidence, path: parsed.evidencePath },
    })
    return true
  }
  const trigger =
    parsed.mode === 'session-trigger'
      ? {
          kind: parsed.triggerKind,
          key: parsed.triggerKey,
          summary: parsed.summary,
          ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
          ...(parsed.targetAssetTypes.length > 0
            ? { targetAssetTypes: parsed.targetAssetTypes }
            : {}),
          ...(parsed.targetAssetRefs.length > 0
            ? { targetAssetRefs: parsed.targetAssetRefs }
            : {}),
          ...(parsed.experienceOnly ? { experienceOnly: true } : {}),
          // Candidate triggers are re-classified semantically inside
          // runMatOSSelfEvolutionForSession before any pipeline spend.
          ...(parsed.semanticCandidate ? { semanticCandidate: true } : {}),
        }
      : {
          kind: 'session-end' as const,
          key: `session-end:${parsed.sessionId}`,
          summary:
            'The session closed and should be checked for reusable experience.',
        }
  if (
    // Hidden session runs never start the pipeline (the monitor no-ops on
    // hidden input), so a preflight record would be spurious.
    !parsed.hidden &&
    !(await evolutionWorkerProviderPreflightOk({
      cwd: parsed.cwd,
      sessionId: parsed.sessionId,
      triggerKind: trigger.kind,
      triggerKey: trigger.key,
    }))
  ) {
    return false
  }
  await runMatOSSelfEvolutionForSession({
    cwd: parsed.cwd,
    sessionId: parsed.sessionId,
    sessionPath: parsed.sessionPath,
    hidden: parsed.hidden,
    trigger,
  })
  return true
}

if (import.meta.main) {
  installMatOSCrashCapture({ component: 'evolution-worker' })
  try {
    await runMatOSEvolutionWorker(
      parseMatOSEvolutionWorkerArgs(process.argv.slice(2)),
    )
  } catch (error) {
    // Hidden evolution workers must never surface failures to the user-facing
    // CLI, but the death itself must stay traceable in the crash channel.
    recordMatOSFatalExit({ component: 'evolution-worker', error })
  }
}
