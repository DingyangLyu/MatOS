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

import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import type { MatOSWorkbenchResourceType } from '../workbench/types.js'

export type WorkbenchIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export type ParsedWorkbenchArgs = {
  positionals: string[]
  rawTail?: string[]
  json: boolean
  query?: string
  scope?: string
  types?: string[]
  limit?: number
  offset?: number
  endOffset?: number
  sessionOffset?: number
  jobOutputOffset?: number
  maxTurns?: number
  jobId?: string
  now?: number
  intervalSeconds?: number
  maxTicks?: number
  includeDisabled: boolean
  includeHidden: boolean
  allowSensitive: boolean
  includeLineage: boolean
  lightweight: boolean
  submit: boolean
  apply: boolean
  mode?: 'explore' | 'lineage' | 'impact' | 'validate' | 'raw' | 'personal' | 'promotion' | 'runtime' | 'audit' | 'asset' | 'forest' | 'headless' | 'chat' | 'interactive' | 'all' | 'web'
  viewerMode?: 'user' | 'operator'
  direction?: 'dependencies' | 'reverse' | 'all'
  node?: string
  message?: string
  signal?: string
  reason?: string
  fingerprint?: string
  patchId?: string
  operationsJson?: string
  sourceNode?: string
  risk?: 'low' | 'medium' | 'high'
  snapshotRef?: string
  releaseId?: string
  releaseName?: string
  targetRef?: string
  targetId?: string
  packId?: string
  version?: string
  description?: string
  llmAssist?: boolean
  withBenchmark?: boolean
  executable?: boolean
  model?: string
  displayName?: string
  sourceUrl?: string
  forceStale: boolean
  failedChildrenOnly: boolean
  dryRun: boolean
  targetGpus?: string
  demandMode?: string
  api?: string
  traceId?: string
  chatSessionId?: string
  turnId?: string
  resumeSessionId?: string
  payloadJson?: string
  mutation?: string
  kind?: string
  action?: string
  projectId?: string
  path?: string
  conversationId?: string
  topicId?: string
  areaId?: string
  roleRef?: string
  memberId?: string
  assetRef?: string
  workflowRef?: string
  format?: 'csv' | 'jsonl'
  recordKind?: string
  status?: string
  sourceUrlType?: string
  metadataCompleteness?: string
  domain?: string
  collection?: string
  sortBy?: string
  sortDirection?: 'asc' | 'desc'
  maxBytes?: number
  params: Record<string, unknown>
  error?: string
}

export const WORKBENCH_USAGE = `MatOS workbench CLI

Usage:
  matos workbench resources list [--type <type>] [--types a,b] [--query <text>] [--limit <n>] [--offset <n>] [--include-disabled] [--lightweight] [--json]
  matos workbench resources show <resource-ref> [--include-hidden] [--json]
  matos workbench resources graph [resource-ref] [--mode explore|lineage|impact|validate|raw] [--json]
  matos workbench resources actions <resource-ref> [--json]
  matos workbench resources invoke-action <resource-ref> <action-key> [--payload-json <json>] [--fingerprint <sha256>] [--reason <text>] [--json]
  matos workbench resources create --type <knowledge|data|tool|skill|role|workflow|mcp> --name <name> [--id <id>] [--version <semver>] [--description <text>] [--pack-id <id>] [--json]
  matos workbench resources create-apply --type <knowledge|data|tool|skill|role|workflow|mcp> --name <name> --fingerprint <sha256> [--id <id>] [--version <semver>] [--description <text>] [--pack-id <id>] [--reason <text>] [--json]
  matos workbench resources draft [resource-ref] --kind <kind> --payload-json <json> [--mutation <kind>] [--json]
  matos workbench resources apply-draft <resource-ref> --kind <kind> --payload-json <json> --fingerprint <sha256> [--mutation <kind>] [--reason <text>] [--json]
  matos workbench commands list [--mode headless|chat|interactive|all|web] [--role <role-ref>] [--query <text>] [--limit <n>] [--offset <n>] [--include-hidden] [--json]
  matos workbench commands suggest [--query <text>] [--mode headless|chat|interactive|all|web] [--role <role-ref>] [--limit <n>] [--offset <n>] [--include-hidden] [--json]
  matos workbench commands resolve <slash-input> [--mode headless|chat|interactive|all|web] [--role <role-ref>] [--include-hidden] [--json]
  matos workbench models list [--json]

  matos workbench workflows list [--include-hidden] [--lightweight] [--json]
  matos workbench workflows show|validate|compile|intake <workflow-ref> [--param key=value] [--json]
  matos workbench workflows draft [workflow-ref] --payload-json <json> [--mutation <kind>] [--json]
  matos workbench workflows apply-draft <workflow-ref> --payload-json <json> --fingerprint <sha256> [--mutation <kind>] [--reason <text>] [--json]
  matos workbench workflows trigger-events [--json]
  matos workbench workflows triggers <workflow-ref> [--json]
  matos workbench workflows trigger <workflow-ref> [--trigger-id <id>] [--json]
  matos workbench workflows save-trigger <workflow-ref> --payload-json <json> [--json]
  matos workbench workflows delete-trigger <workflow-ref> --trigger-id <id> [--json]
  matos workbench workflows trigger-scheduler tick [--now <iso|ms>] [--json]
  matos workbench workflows trigger-scheduler serve [--interval <seconds>] [--max-ticks <n>] [--json]
  matos workbench workflows fire-trigger <trigger-id> [--json]
  matos workbench workflows fire-trigger <workflow-ref> --trigger-id <id> [--json]
  matos workbench workflows attach-tool <workflow-ref> --payload-json <json> [--fingerprint <sha256>] [--reason <text>] [--json]
  matos workbench workflows detach-tool <workflow-ref> --payload-json <json> [--fingerprint <sha256>] [--reason <text>] [--json]
  matos workbench workflows attach-role <workflow-ref> --role <role-ref> [--fingerprint <sha256>] [--reason <text>] [--json]
  matos workbench workflows intake-session start <workflow-ref> [--param key=value] [--message <text>] [--json]
  matos workbench workflows intake-session show|send|confirm|run <session-id> [--param key=value] [--message <text>] [--json]
  matos workbench workflows builder-session start [workflow-ref] [--description <goal>] [--json]
  matos workbench workflows builder-session show|send <session-id> [--message <text>] [--payload-json <json>] [--json]
  matos workbench workflows run <workflow-ref> [--param key=value] [--json]
  matos workbench workflows node-debug <workflow-ref> --node <nodeId> [--param key=value] [--json]
  matos workbench workflows status|inspect|compile-inspect|events|artifacts|approvals|contracts <runId> [--json]
  matos workbench workflows monitor <runId> [--limit <n>] [--offset <n>] [--json]
  matos workbench workflows run-graph <runId> [--json]
  matos workbench workflows recover|recover-apply|recover-queue|recover-drain <runId> [--json]
  matos workbench workflows patches <runId> [--json]
  matos workbench workflows patch-propose <runId> --operations <json-array> [--reason <reason>] [--risk low|medium|high] [--source-node <nodeId>] [--json]
  matos workbench workflows patch-inspect|patch-approve|patch-reject|patch-apply <runId> --patch <patchId> [--reason <reason>] [--json]
  matos workbench workflows respond <runId> --node <nodeId> --message <message> [--json]
  matos workbench workflows approve|deny <runId> --node <nodeId> [--fingerprint <sha256>] [--reason <reason>] [--json]
  matos workbench workflows cancel|pause|resume <runId> [--json]
  matos workbench workflows retry-node|skip-node <runId> --node <nodeId> [--json]

  matos workbench roles list [--json]
  matos workbench roles show|compose <role-ref> [--json]
  matos workbench roles debug <role-ref> [--trace-id <trace-id>] [--query <text>] [--limit <n>] [--lightweight] [--json]
  matos workbench roles debug-run <role-ref> --message <prompt> [--max-turns <n>] [--trace-id <id>] [--chat-session-id <id>] [--resume-session-id <id>] [--submit] [--json]
  matos workbench roles chat-stream <role-ref> --message <prompt> [--conversation-id <id>] [--chat-session-id <id>] [--turn-id <id>] [--resume-session-id <id>] --json
  matos workbench roles jobs <role-ref> [--trace-id <trace-id>|--job-id <job-id>] [--json]
  matos workbench roles job <role-ref> <job-id> [--json]
  matos workbench roles cancel-job <role-ref> <job-id> [--signal <signal>] [--json]
  matos workbench roles draft [role-ref] --payload-json <json> [--mutation <kind>] [--json]
  matos workbench roles apply-draft <role-ref> --payload-json <json> --fingerprint <sha256> [--mutation <kind>] [--reason <text>] [--json]

  matos workbench evolution inbox [--json]
  matos workbench evolution tree [--asset <asset-ref>] [--mode personal|promotion|runtime|audit|asset|forest] [--json]
  matos workbench evolution show <record-or-asset-ref> [--json]
  matos workbench evolution action <record-or-asset-ref> <inspect|approve|reject|rollback> [--fingerprint <sha256>] [--reason <text>] [--json]

  matos workbench releases preview <asset-ref> [--action publish|approve|reject|rollback] [--json]
  matos workbench releases apply <asset-ref> --action publish|rollback --fingerprint <sha256> [--snapshot <snapshot-id-or-commit>] [--release-id <release-id>] [--reason <text>] [--json]

  matos workbench knowledge list [--json]
  matos workbench knowledge show <knowledge-or-data-ref> [--json]
  matos workbench knowledge documents <knowledge-ref> [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench knowledge document <knowledge-ref> <document-id> [--json]
  matos workbench knowledge import <knowledge-ref> --payload-json <json> [--mutation <kind>] [--json]
  matos workbench knowledge import-apply <knowledge-ref> --payload-json <json> --fingerprint <sha256> [--mutation <kind>] [--reason <text>] [--json]
  matos workbench knowledge slices <knowledge-ref> [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench knowledge slice <knowledge-ref> <slice-id> [--json]

  matos workbench compute status [--target-gpus <ids>] [--demand-mode <mode>] [--json]
  matos workbench compute check [--dry-run] [--target-gpus <ids>] [--demand-mode <mode>] [--json]

  matos workbench traces list [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench traces show <trace-id|session-id> [--json]
  matos workbench traces transcript <trace-id|session-id> [transcript-id] --viewer operator [--limit <n>] [--json]
  matos workbench traces live <trace-id|session-id> [--session-offset <n>] [--job-id <job-id>] [--job-output-offset <n>] [--limit <n>] [--json]

  matos workbench projects list [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects create <name> [--json]
  matos workbench projects show <project-id> [--json]
  matos workbench projects members <project-id> [--json]
  matos workbench projects member-add <project-id> --role <role-ref> [--name <name>] [--json]
  matos workbench projects member-remove <project-id> --member-id <id> [--json]
  matos workbench projects send <project-id> --conversation <id> [--topic <id>] --message <text> [--json]
  matos workbench projects chat <project-id> --conversation <id> [--role <role-ref>] --message <text> [--json]
  matos workbench projects timeline <project-id> [--conversation <id>] [--topic <id>] [--limit <n>] [--json]
  matos workbench projects areas <project-id> [--json]
  matos workbench projects area-create <project-id> --kind <kind> --name <name> [--role <role-ref>] [--json]
  matos workbench projects bind-asset <project-id> <asset-ref> [--json]
  matos workbench projects bind-workflow <project-id> <workflow-ref> [--json]
  matos workbench projects summary [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects pins [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects pin|unpin|toggle-pin <resource-ref> [--reason <text>] [--json]
  matos workbench projects activity [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects runs [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects run-detail <run-id|workflow-run-ref> [--json]
  matos workbench projects artifacts [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects artifact-detail <artifact-id|artifact-ref> [--json]
  matos workbench projects files [project-id] [--path <relative-path>] [--limit <n>] [--include-hidden] [--allow-sensitive] [--json]
  matos workbench projects file-read [project-id] --path <relative-path> [--max-bytes <n>] [--allow-sensitive] [--json]
  matos workbench projects file-write [project-id] --path <relative-path> --payload-json '{"content":"..."}' [--allow-sensitive] [--json]
  matos workbench projects file-mkdir [project-id] --path <relative-path> [--allow-sensitive] [--json]
  matos workbench projects file-delete [project-id] --path <relative-path> [--allow-sensitive] [--json]
  matos workbench projects compute [--query <text>] [--limit <n>] [--offset <n>] [--target-gpus <ids>] [--demand-mode <mode>] [--json]
  matos workbench projects compute-history [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects compute-job <job-id|compute-job-ref> [--target-gpus <ids>] [--demand-mode <mode>] [--json]
  matos workbench projects compute-job-action <job-id|compute-job-ref> <inspect|view-trace|validate|reconcile|cancel> [--apply --fingerprint <sha256>] [--target-gpus <ids>] [--demand-mode <mode>] [--json]
  matos workbench projects benchmarks [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench projects benchmark-detail <benchmark-or-evaluation-ref> [--json]
  matos workbench search assets [--query <text>] [--types a,b] [--limit <n>] [--offset <n>] [--json]
  matos workbench search templates [--query <text>] [--types a,b] [--limit <n>] [--offset <n>] [--json]
  matos workbench search favorites [--query <text>] [--types a,b] [--limit <n>] [--offset <n>] [--json]
  matos workbench search favorite|unfavorite|toggle-favorite <resource-ref> [--reason <text>] [--json]
  matos workbench search duplicate <resource-ref> [--target-ref <resource-ref>|--target-id <id>] [--name <name>] [--json]
  matos workbench search duplicate-apply <resource-ref> --fingerprint <sha256> [--target-ref <resource-ref>|--target-id <id>] [--name <name>] [--reason <text>] [--json]
  matos workbench search intakes [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench search intake-register --source-url <url> [--target-id <id>] [--name <name>] [--json]
  matos workbench search intake-register-apply --source-url <url> --fingerprint <sha256> [--target-id <id>] [--name <name>] [--reason <text>] [--json]
  matos workbench search intake-import <external-intake-ref> [--kind <asset-type>] [--json]
  matos workbench search intake-import-apply <external-intake-ref> [--kind <asset-type>] --fingerprint <sha256> [--reason <text>] [--json]
  matos workbench search intake-materialize <external-intake-ref> [--json]
  matos workbench search intake-materialize-apply <external-intake-ref> --fingerprint <sha256> [--reason <text>] [--json]
  matos workbench search intake-classify <source: path|zip|tar|git-url|http-url> [--llm-assist] [--model <model>] [--json]
  matos workbench search intake-draft <source: path|zip|tar|git-url|http-url> [--pack-id <id>] [--with-benchmark] [--executable] [--llm-assist] [--model <model>] [--json]
  matos workbench search intake-draft-apply <source> --fingerprint <sha256> [--pack-id <id>] [--with-benchmark] [--executable] [--llm-assist] [--model <model>] [--reason <text>] [--json]
  matos workbench search documents [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench data sources [--json]
  matos workbench data catalog <source-id> [--query <text>] [--record-kind <kind>] [--domain <name>] [--collection <name>] [--status <status>] [--metadata-completeness <value>] [--limit <n>] [--offset <n>] [--json]
  matos workbench data pin <source-id> --payload-json <row-json> [--id <asset-id>] [--name <name>] [--reason <text>] [--json]
  matos workbench tables query <data-ref> [--query <text>] [--limit <n>] [--offset <n>] [--sort-by <field>] [--sort-direction asc|desc] [--json]
  matos workbench tables export <data-ref> [--format csv|jsonl] [--query <text>] [--limit <n>] [--offset <n>] [--sort-by <field>] [--sort-direction asc|desc] [--json]
  matos workbench tables export-apply <data-ref> --fingerprint <sha256> [--format csv|jsonl] [--query <text>] [--limit <n>] [--offset <n>] [--sort-by <field>] [--sort-direction asc|desc] [--reason <text>] [--json]
  matos workbench tables row <data-ref> <row-id-or-index> [--json]
  matos workbench tools dry-run <tool-ref> [--api <api-id-or-name>] [--payload-json <json>] [--json]
  matos workbench tools telemetry <tool-ref> [--api <api-id-or-name>] [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench feedback list [--limit <n>] [--offset <n>] [--json]
  matos workbench feedback submit --payload-json <json> [--json]
  matos workbench feedback backfill-git [--path <git-repository>] [--json]
  matos workbench feedback status <report-id> <open|triaged|in_progress|resolved|closed|rejected> [--json]
  matos workbench feedback attachment <report-id> <attachment-id> --json
  matos workbench fixtures testsets <workflow-ref> [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench fixtures testset-save <workflow-ref> --payload-json <json> [--json]
  matos workbench fixtures testset-check <workflow-ref> --payload-json <json> [--json]
  matos workbench fixtures testset-delete <workflow-ref> --payload-json <json> [--json]
  matos workbench fixtures mocksets [--payload-json <json>] [--query <text>] [--limit <n>] [--offset <n>] [--json]
  matos workbench fixtures mockset-save --payload-json <json> [--json]
  matos workbench fixtures mockset-delete --payload-json <json> [--json]
  matos workbench fixtures mockset-bindings --payload-json <json> [--json]
  matos workbench fixtures mockset-bind --payload-json <json> [--json]
  matos workbench fixtures mockset-usage --payload-json <json> [--json]
  matos workbench fixtures mock-rules --payload-json <json> [--json]
  matos workbench fixtures mock-rule-save --payload-json <json> [--json]
  matos workbench fixtures mock-rule-delete --payload-json <json> [--json]
`

export const WORKBENCH_RESOURCE_GRAPH_MODE_ERROR =
  '--mode must be explore, lineage, impact, validate, or raw'

export const WORKBENCH_EVOLUTION_TREE_MODE_ERROR =
  '--mode must be personal, promotion, runtime, audit, asset, or forest'

export const WORKBENCH_SLASH_COMMAND_MODE_ERROR =
  '--mode must be headless, chat, interactive, all, or web'

function parseNumber(value: string | undefined, name: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

// Accepts an ISO-8601 timestamp or epoch milliseconds.
function parseInstant(value: string | undefined, name: string): number {
  if (!value) {
    throw new Error(`${name} requires an ISO timestamp or epoch milliseconds`)
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an ISO timestamp or epoch milliseconds`)
  }
  return parsed
}

function parseTypes(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

const WORKBENCH_MODE_ERROR =
  '--mode must be explore, lineage, impact, validate, raw, personal, promotion, runtime, audit, asset, forest, headless, chat, interactive, all, or web'

function parseWorkbenchMode(
  value: string | undefined,
): ParsedWorkbenchArgs['mode'] | undefined {
  if (
    value === 'explore' ||
    value === 'lineage' ||
    value === 'impact' ||
    value === 'validate' ||
    value === 'raw' ||
    value === 'personal' ||
    value === 'promotion' ||
    value === 'runtime' ||
    value === 'audit' ||
    value === 'asset' ||
    value === 'forest' ||
    value === 'headless' ||
    value === 'chat' ||
    value === 'interactive' ||
    value === 'all' ||
    value === 'web'
  ) {
    return value
  }
  return undefined
}

function setParam(target: Record<string, unknown>, value: string): void {
  const separator = value.indexOf('=')
  if (separator <= 0) {
    target[value] = true
    return
  }
  const key = value.slice(0, separator)
  const raw = value.slice(separator + 1)
  try {
    target[key] = JSON.parse(raw)
  } catch {
    target[key] = raw
  }
}

export function parseArgs(args: string[]): ParsedWorkbenchArgs {
  const parsed: ParsedWorkbenchArgs = {
    positionals: [],
    json: false,
    includeDisabled: false,
    includeHidden: false,
    allowSensitive: false,
    includeLineage: false,
    lightweight: false,
    submit: false,
    apply: false,
    failedChildrenOnly: false,
    dryRun: false,
    forceStale: false,
    params: {},
  }
  const rawTailStartsAt =
    (args[0] === 'commands' || args[0] === 'slash-commands') &&
    args[1] === 'resolve'
      ? 2
      : -1
  let rawTailInputStarted = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    try {
      if (rawTailStartsAt >= 0 && index >= rawTailStartsAt) {
        if (arg === '--') {
          const tail = args.slice(index + 1)
          parsed.positionals.push(...tail)
          parsed.rawTail = [...(parsed.rawTail ?? []), ...tail]
          break
        }
        if (arg === '--json') {
          parsed.json = true
          continue
        }
        if (!rawTailInputStarted && arg === '--include-hidden') {
          parsed.includeHidden = true
          continue
        }
        if (!rawTailInputStarted && arg === '--limit') {
          parsed.limit = parseNumber(args[index + 1], '--limit')
          index += 1
          continue
        }
        if (!rawTailInputStarted && arg?.startsWith('--limit=')) {
          parsed.limit = parseNumber(arg.slice('--limit='.length), '--limit')
          continue
        }
        if (arg === '--mode') {
          const mode = parseWorkbenchMode(args[index + 1])
          if (mode) {
            parsed.mode = mode
          } else {
            parsed.error = WORKBENCH_MODE_ERROR
          }
          index += 1
          continue
        }
        if (arg?.startsWith('--mode=')) {
          const mode = parseWorkbenchMode(arg.slice('--mode='.length))
          if (mode) {
            parsed.mode = mode
          } else {
            parsed.error = WORKBENCH_MODE_ERROR
          }
          continue
        }
        if (!rawTailInputStarted && (arg === '--role' || arg === '--role-ref')) {
          parsed.roleRef = args[index + 1]
          index += 1
          continue
        }
        if (!rawTailInputStarted && arg?.startsWith('--role=')) {
          parsed.roleRef = arg.slice('--role='.length)
          continue
        }
        if (!rawTailInputStarted && arg?.startsWith('--role-ref=')) {
          parsed.roleRef = arg.slice('--role-ref='.length)
          continue
        }
        if (arg) {
          parsed.positionals.push(arg)
          parsed.rawTail = [...(parsed.rawTail ?? []), arg]
          rawTailInputStarted = true
          continue
        }
      }

      if (arg === '--json') {
        parsed.json = true
      } else if (arg === '--include-disabled') {
        parsed.includeDisabled = true
      } else if (arg === '--include-hidden') {
        parsed.includeHidden = true
      } else if (arg === '--allow-sensitive') {
        parsed.allowSensitive = true
      } else if (arg === '--include-lineage') {
        parsed.includeLineage = true
      } else if (arg === '--lightweight') {
        parsed.lightweight = true
      } else if (arg === '--failed-children-only') {
        parsed.failedChildrenOnly = true
      } else if (arg === '--dry-run') {
        parsed.dryRun = true
      } else if (arg === '--force-stale') {
        parsed.forceStale = true
      } else if (arg === '--submit') {
        parsed.submit = true
      } else if (arg === '--apply') {
        parsed.apply = true
      } else if (arg === '--query') {
        parsed.query = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--query=')) {
        parsed.query = arg.slice('--query='.length)
      } else if (arg === '--scope') {
        parsed.scope = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--scope=')) {
        parsed.scope = arg.slice('--scope='.length)
      } else if (arg === '--type') {
        parsed.types = [
          ...(parsed.types ?? []),
          ...(args[index + 1] ? [args[index + 1]] : []),
        ]
        index += 1
      } else if (arg?.startsWith('--type=')) {
        parsed.types = [...(parsed.types ?? []), arg.slice('--type='.length)]
      } else if (arg === '--types') {
        parsed.types = parseTypes(args[index + 1])
        index += 1
      } else if (arg?.startsWith('--types=')) {
        parsed.types = parseTypes(arg.slice('--types='.length))
      } else if (arg === '--limit') {
        parsed.limit = parseNumber(args[index + 1], '--limit')
        index += 1
      } else if (arg?.startsWith('--limit=')) {
        parsed.limit = parseNumber(arg.slice('--limit='.length), '--limit')
      } else if (arg === '--offset') {
        parsed.offset = parseNumber(args[index + 1], '--offset')
        index += 1
      } else if (arg?.startsWith('--offset=')) {
        parsed.offset = parseNumber(arg.slice('--offset='.length), '--offset')
      } else if (arg === '--end-offset') {
        parsed.endOffset = parseNumber(args[index + 1], '--end-offset')
        index += 1
      } else if (arg?.startsWith('--end-offset=')) {
        parsed.endOffset = parseNumber(arg.slice('--end-offset='.length), '--end-offset')
      } else if (arg === '--session-offset') {
        parsed.sessionOffset = parseNumber(args[index + 1], '--session-offset')
        index += 1
      } else if (arg?.startsWith('--session-offset=')) {
        parsed.sessionOffset = parseNumber(arg.slice('--session-offset='.length), '--session-offset')
      } else if (arg === '--job-output-offset') {
        parsed.jobOutputOffset = parseNumber(args[index + 1], '--job-output-offset')
        index += 1
      } else if (arg?.startsWith('--job-output-offset=')) {
        parsed.jobOutputOffset = parseNumber(arg.slice('--job-output-offset='.length), '--job-output-offset')
      } else if (arg === '--max-turns') {
        parsed.maxTurns = parseNumber(args[index + 1], '--max-turns')
        index += 1
      } else if (arg?.startsWith('--max-turns=')) {
        parsed.maxTurns = parseNumber(arg.slice('--max-turns='.length), '--max-turns')
      } else if (arg === '--now') {
        parsed.now = parseInstant(args[index + 1], '--now')
        index += 1
      } else if (arg?.startsWith('--now=')) {
        parsed.now = parseInstant(arg.slice('--now='.length), '--now')
      } else if (arg === '--interval') {
        parsed.intervalSeconds = parseNumber(args[index + 1], '--interval')
        index += 1
      } else if (arg?.startsWith('--interval=')) {
        parsed.intervalSeconds = parseNumber(arg.slice('--interval='.length), '--interval')
      } else if (arg === '--max-ticks') {
        parsed.maxTicks = parseNumber(args[index + 1], '--max-ticks')
        index += 1
      } else if (arg?.startsWith('--max-ticks=')) {
        parsed.maxTicks = parseNumber(arg.slice('--max-ticks='.length), '--max-ticks')
      } else if (arg === '--job-id' || arg === '--job' || arg === '--trigger-id') {
        parsed.jobId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--job-id=')) {
        parsed.jobId = arg.slice('--job-id='.length)
      } else if (arg?.startsWith('--job=')) {
        parsed.jobId = arg.slice('--job='.length)
      } else if (arg?.startsWith('--trigger-id=')) {
        parsed.jobId = arg.slice('--trigger-id='.length)
      } else if (arg === '--mode') {
        const mode = parseWorkbenchMode(args[index + 1])
        if (mode) {
          parsed.mode = mode
        } else {
          parsed.error = WORKBENCH_MODE_ERROR
        }
        index += 1
      } else if (arg?.startsWith('--mode=')) {
        const mode = parseWorkbenchMode(arg.slice('--mode='.length))
        if (mode) {
          parsed.mode = mode
        } else {
          parsed.error = WORKBENCH_MODE_ERROR
        }
      } else if (arg === '--viewer' || arg === '--viewer-mode') {
        const value = args[index + 1]
        if (value === 'user' || value === 'operator') {
          parsed.viewerMode = value
        } else {
          parsed.error = '--viewer must be user or operator'
        }
        index += 1
      } else if (arg?.startsWith('--viewer=')) {
        const value = arg.slice('--viewer='.length)
        if (value === 'user' || value === 'operator') {
          parsed.viewerMode = value
        } else {
          parsed.error = '--viewer must be user or operator'
        }
      } else if (arg?.startsWith('--viewer-mode=')) {
        const value = arg.slice('--viewer-mode='.length)
        if (value === 'user' || value === 'operator') {
          parsed.viewerMode = value
        } else {
          parsed.error = '--viewer-mode must be user or operator'
        }
      } else if (arg === '--direction') {
        const value = args[index + 1]
        if (value === 'dependencies' || value === 'reverse' || value === 'all') {
          parsed.direction = value
        } else {
          parsed.error = '--direction must be dependencies, reverse, or all'
        }
        index += 1
      } else if (arg?.startsWith('--direction=')) {
        const value = arg.slice('--direction='.length)
        if (value === 'dependencies' || value === 'reverse' || value === 'all') {
          parsed.direction = value
        } else {
          parsed.error = '--direction must be dependencies, reverse, or all'
        }
      } else if (arg === '--node') {
        parsed.node = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--node=')) {
        parsed.node = arg.slice('--node='.length)
      } else if (arg === '--message') {
        parsed.message = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--message=')) {
        parsed.message = arg.slice('--message='.length)
      } else if (arg === '--signal') {
        parsed.signal = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--signal=')) {
        parsed.signal = arg.slice('--signal='.length)
      } else if (arg === '--reason') {
        parsed.reason = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--reason=')) {
        parsed.reason = arg.slice('--reason='.length)
      } else if (arg === '--fingerprint') {
        parsed.fingerprint = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--fingerprint=')) {
        parsed.fingerprint = arg.slice('--fingerprint='.length)
      } else if (arg === '--patch' || arg === '--patch-id') {
        parsed.patchId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--patch=')) {
        parsed.patchId = arg.slice('--patch='.length)
      } else if (arg?.startsWith('--patch-id=')) {
        parsed.patchId = arg.slice('--patch-id='.length)
      } else if (arg === '--operations') {
        parsed.operationsJson = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--operations=')) {
        parsed.operationsJson = arg.slice('--operations='.length)
      } else if (arg === '--source-node') {
        parsed.sourceNode = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--source-node=')) {
        parsed.sourceNode = arg.slice('--source-node='.length)
      } else if (arg === '--risk') {
        const value = args[index + 1]
        if (value === 'low' || value === 'medium' || value === 'high') {
          parsed.risk = value
        } else {
          parsed.error = '--risk must be low, medium, or high'
        }
        index += 1
      } else if (arg?.startsWith('--risk=')) {
        const value = arg.slice('--risk='.length)
        if (value === 'low' || value === 'medium' || value === 'high') {
          parsed.risk = value
        } else {
          parsed.error = '--risk must be low, medium, or high'
        }
      } else if (arg === '--snapshot' || arg === '--snapshot-ref') {
        parsed.snapshotRef = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--snapshot=')) {
        parsed.snapshotRef = arg.slice('--snapshot='.length)
      } else if (arg?.startsWith('--snapshot-ref=')) {
        parsed.snapshotRef = arg.slice('--snapshot-ref='.length)
      } else if (arg === '--release-id' || arg === '--release') {
        parsed.releaseId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--release-id=')) {
        parsed.releaseId = arg.slice('--release-id='.length)
      } else if (arg?.startsWith('--release=')) {
        parsed.releaseId = arg.slice('--release='.length)
      } else if (arg === '--target-ref') {
        parsed.targetRef = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--target-ref=')) {
        parsed.targetRef = arg.slice('--target-ref='.length)
      } else if (arg === '--target-id') {
        parsed.targetId = args[index + 1]
        index += 1
      } else if (arg === '--id') {
        parsed.targetId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--target-id=')) {
        parsed.targetId = arg.slice('--target-id='.length)
      } else if (arg?.startsWith('--id=')) {
        parsed.targetId = arg.slice('--id='.length)
      } else if (arg === '--pack-id') {
        parsed.packId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--pack-id=')) {
        parsed.packId = arg.slice('--pack-id='.length)
      } else if (arg === '--llm-assist' || arg === '--llm') {
        parsed.llmAssist = true
      } else if (arg === '--with-benchmark' || arg === '--benchmark') {
        parsed.withBenchmark = true
      } else if (arg === '--executable' || arg === '--exec-entries') {
        parsed.executable = true
      } else if (arg === '--model') {
        parsed.model = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--model=')) {
        parsed.model = arg.slice('--model='.length)
      } else if (arg === '--version') {
        parsed.version = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--version=')) {
        parsed.version = arg.slice('--version='.length)
      } else if (arg === '--description') {
        parsed.description = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--description=')) {
        parsed.description = arg.slice('--description='.length)
      } else if (arg === '--display-name') {
        parsed.displayName = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--display-name=')) {
        parsed.displayName = arg.slice('--display-name='.length)
      } else if (arg === '--source-url' || arg === '--url') {
        parsed.sourceUrl = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--source-url=')) {
        parsed.sourceUrl = arg.slice('--source-url='.length)
      } else if (arg?.startsWith('--url=')) {
        parsed.sourceUrl = arg.slice('--url='.length)
      } else if (arg === '--release-name') {
        parsed.releaseName = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--release-name=')) {
        parsed.releaseName = arg.slice('--release-name='.length)
      } else if (arg?.startsWith('--name=')) {
        parsed.displayName = arg.slice('--name='.length)
        parsed.releaseName = arg.slice('--name='.length)
      } else if (arg === '--name') {
        parsed.displayName = args[index + 1]
        parsed.releaseName = args[index + 1]
        index += 1
      } else if (arg === '--target-gpus') {
        parsed.targetGpus = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--target-gpus=')) {
        parsed.targetGpus = arg.slice('--target-gpus='.length)
      } else if (arg === '--demand-mode') {
        parsed.demandMode = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--demand-mode=')) {
        parsed.demandMode = arg.slice('--demand-mode='.length)
      } else if (arg === '--api' || arg === '--api-id') {
        parsed.api = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--api=')) {
        parsed.api = arg.slice('--api='.length)
      } else if (arg?.startsWith('--api-id=')) {
        parsed.api = arg.slice('--api-id='.length)
      } else if (arg === '--trace-id' || arg === '--trace') {
        parsed.traceId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--trace-id=')) {
        parsed.traceId = arg.slice('--trace-id='.length)
      } else if (arg?.startsWith('--trace=')) {
        parsed.traceId = arg.slice('--trace='.length)
      } else if (arg === '--chat-session-id' || arg === '--session-id') {
        parsed.chatSessionId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--chat-session-id=')) {
        parsed.chatSessionId = arg.slice('--chat-session-id='.length)
      } else if (arg?.startsWith('--session-id=')) {
        parsed.chatSessionId = arg.slice('--session-id='.length)
      } else if (arg === '--turn-id') {
        parsed.turnId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--turn-id=')) {
        parsed.turnId = arg.slice('--turn-id='.length)
      } else if (arg === '--resume-session-id' || arg === '--upstream-session-id') {
        parsed.resumeSessionId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--resume-session-id=')) {
        parsed.resumeSessionId = arg.slice('--resume-session-id='.length)
      } else if (arg?.startsWith('--upstream-session-id=')) {
        parsed.resumeSessionId = arg.slice('--upstream-session-id='.length)
      } else if (arg === '--payload-json') {
        parsed.payloadJson = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--payload-json=')) {
        parsed.payloadJson = arg.slice('--payload-json='.length)
      } else if (arg === '--mutation') {
        parsed.mutation = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--mutation=')) {
        parsed.mutation = arg.slice('--mutation='.length)
      } else if (arg === '--kind') {
        parsed.kind = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--kind=')) {
        parsed.kind = arg.slice('--kind='.length)
      } else if (arg === '--record-kind') {
        parsed.recordKind = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--record-kind=')) {
        parsed.recordKind = arg.slice('--record-kind='.length)
      } else if (arg === '--status') {
        parsed.status = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--status=')) {
        parsed.status = arg.slice('--status='.length)
      } else if (arg === '--source-url-type') {
        parsed.sourceUrlType = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--source-url-type=')) {
        parsed.sourceUrlType = arg.slice('--source-url-type='.length)
      } else if (arg === '--metadata-completeness') {
        parsed.metadataCompleteness = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--metadata-completeness=')) {
        parsed.metadataCompleteness = arg.slice('--metadata-completeness='.length)
      } else if (arg === '--domain') {
        parsed.domain = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--domain=')) {
        parsed.domain = arg.slice('--domain='.length)
      } else if (arg === '--collection') {
        parsed.collection = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--collection=')) {
        parsed.collection = arg.slice('--collection='.length)
      } else if (arg === '--action') {
        parsed.action = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--action=')) {
        parsed.action = arg.slice('--action='.length)
      } else if (arg === '--project-id' || arg === '--project') {
        parsed.projectId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--project-id=')) {
        parsed.projectId = arg.slice('--project-id='.length)
      } else if (arg?.startsWith('--project=')) {
        parsed.projectId = arg.slice('--project='.length)
      } else if (arg === '--path' || arg === '--file') {
        parsed.path = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--path=')) {
        parsed.path = arg.slice('--path='.length)
      } else if (arg?.startsWith('--file=')) {
        parsed.path = arg.slice('--file='.length)
      } else if (arg === '--max-bytes') {
        const value = Number(args[index + 1])
        if (Number.isFinite(value) && value > 0) {
          parsed.maxBytes = Math.floor(value)
        } else {
          parsed.error = '--max-bytes must be a positive number'
        }
        index += 1
      } else if (arg?.startsWith('--max-bytes=')) {
        const value = Number(arg.slice('--max-bytes='.length))
        if (Number.isFinite(value) && value > 0) {
          parsed.maxBytes = Math.floor(value)
        } else {
          parsed.error = '--max-bytes must be a positive number'
        }
      } else if (arg === '--conversation' || arg === '--conversation-id') {
        parsed.conversationId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--conversation=')) {
        parsed.conversationId = arg.slice('--conversation='.length)
      } else if (arg?.startsWith('--conversation-id=')) {
        parsed.conversationId = arg.slice('--conversation-id='.length)
      } else if (arg === '--topic' || arg === '--topic-id') {
        parsed.topicId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--topic=')) {
        parsed.topicId = arg.slice('--topic='.length)
      } else if (arg?.startsWith('--topic-id=')) {
        parsed.topicId = arg.slice('--topic-id='.length)
      } else if (arg === '--area' || arg === '--area-id') {
        parsed.areaId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--area=')) {
        parsed.areaId = arg.slice('--area='.length)
      } else if (arg?.startsWith('--area-id=')) {
        parsed.areaId = arg.slice('--area-id='.length)
      } else if (arg === '--role' || arg === '--role-ref') {
        parsed.roleRef = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--role=')) {
        parsed.roleRef = arg.slice('--role='.length)
      } else if (arg?.startsWith('--role-ref=')) {
        parsed.roleRef = arg.slice('--role-ref='.length)
      } else if (arg === '--member-id' || arg === '--member') {
        parsed.memberId = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--member-id=')) {
        parsed.memberId = arg.slice('--member-id='.length)
      } else if (arg?.startsWith('--member=')) {
        parsed.memberId = arg.slice('--member='.length)
      } else if (arg === '--asset' || arg === '--asset-ref') {
        parsed.assetRef = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--asset=')) {
        parsed.assetRef = arg.slice('--asset='.length)
      } else if (arg?.startsWith('--asset-ref=')) {
        parsed.assetRef = arg.slice('--asset-ref='.length)
      } else if (arg === '--workflow' || arg === '--workflow-ref') {
        parsed.workflowRef = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--workflow=')) {
        parsed.workflowRef = arg.slice('--workflow='.length)
      } else if (arg?.startsWith('--workflow-ref=')) {
        parsed.workflowRef = arg.slice('--workflow-ref='.length)
      } else if (arg === '--format') {
        const value = args[index + 1]
        if (value === 'csv' || value === 'jsonl') {
          parsed.format = value
        } else {
          parsed.error = '--format must be csv or jsonl'
        }
        index += 1
      } else if (arg?.startsWith('--format=')) {
        const value = arg.slice('--format='.length)
        if (value === 'csv' || value === 'jsonl') {
          parsed.format = value
        } else {
          parsed.error = '--format must be csv or jsonl'
        }
      } else if (arg === '--sort-by') {
        parsed.sortBy = args[index + 1]
        index += 1
      } else if (arg?.startsWith('--sort-by=')) {
        parsed.sortBy = arg.slice('--sort-by='.length)
      } else if (arg === '--sort-direction') {
        const value = args[index + 1]
        if (value === 'asc' || value === 'desc') {
          parsed.sortDirection = value
        } else {
          parsed.error = '--sort-direction must be asc or desc'
        }
        index += 1
      } else if (arg?.startsWith('--sort-direction=')) {
        const value = arg.slice('--sort-direction='.length)
        if (value === 'asc' || value === 'desc') {
          parsed.sortDirection = value
        } else {
          parsed.error = '--sort-direction must be asc or desc'
        }
      } else if (arg === '--param') {
        const value = args[index + 1]
        if (value) {
          setParam(parsed.params, value)
        }
        index += 1
      } else if (arg?.startsWith('--param=')) {
        setParam(parsed.params, arg.slice('--param='.length))
      } else if (arg?.startsWith('--')) {
        parsed.error = `Unknown option: ${arg}`
      } else if (arg) {
        parsed.positionals.push(arg)
      }
    } catch (error) {
      parsed.error = error instanceof Error ? error.message : String(error)
    }
  }
  return parsed
}

export function writeJson(io: WorkbenchIO, value: unknown): void {
  io.stdout(
    `${JSON.stringify(redactMatOSAssetOutput(value, { cwd: io.cwd }), null, 2)}\n`,
  )
}

export function writeResult(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
  value: unknown,
): number {
  const text = `${JSON.stringify(
    redactMatOSAssetOutput(value, { cwd: io.cwd }),
    null,
    2,
  )}\n`
  io.stdout(text)
  return parsed.json ? 0 : 0
}

export function resourceGraphMode(
  value: ParsedWorkbenchArgs['mode'],
): 'explore' | 'lineage' | 'impact' | 'validate' | 'raw' | undefined {
  return value === 'explore' ||
    value === 'lineage' ||
    value === 'impact' ||
    value === 'validate' ||
    value === 'raw'
    ? value
    : undefined
}

export function evolutionTreeMode(
  value: ParsedWorkbenchArgs['mode'],
): 'personal' | 'promotion' | 'runtime' | 'audit' | 'asset' | 'forest' | undefined {
  return value === 'personal' ||
    value === 'promotion' ||
    value === 'runtime' ||
    value === 'audit' ||
    value === 'asset' ||
    value === 'forest'
    ? value
    : undefined
}

export function context(parsed: ParsedWorkbenchArgs, io: WorkbenchIO) {
  return {
    cwd: io.cwd,
    scopeRef: parsed.scope,
    projectId: parsed.projectId,
    env: process.env,
  }
}

export function roleDebugRunContext(parsed: ParsedWorkbenchArgs, io: WorkbenchIO) {
  const base = context(parsed, io)
  const chatSessionId = parsed.chatSessionId ?? parsed.conversationId
  const traceId = parsed.traceId ?? parsed.conversationId ?? chatSessionId
  return {
    ...base,
    env: {
      ...base.env,
      ...(traceId ? { MATOS_TRACE_ID: traceId } : {}),
      ...(chatSessionId
        ? {
            MATOS_SESSION_ID: chatSessionId,
            MATOS_CHAT_SESSION_ID: chatSessionId,
          }
        : {}),
      ...(parsed.conversationId
        ? { MATOS_CONVERSATION_ID: parsed.conversationId }
        : {}),
      ...(parsed.projectId ? { MATOS_PROJECT_ID: parsed.projectId } : {}),
      ...(parsed.projectId && parsed.conversationId
        ? { MATOS_PROJECT_CONVERSATION_ID: parsed.conversationId }
        : {}),
      ...(parsed.topicId ? { MATOS_PROJECT_TOPIC_ID: parsed.topicId } : {}),
      ...(parsed.areaId ? { MATOS_PROJECT_AREA_ID: parsed.areaId } : {}),
    },
  }
}

export function parsedResourceTypes(parsed: ParsedWorkbenchArgs): MatOSWorkbenchResourceType[] | undefined {
  return parsed.types as MatOSWorkbenchResourceType[] | undefined
}
