
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { readMatOSProjectConfig } from '../project.js'
import { resolveMatOSRuntimeScope } from '../runtime/scopes.js'
import {
  envValue,
  type MatOSEnv,
} from '../runtime/runtimeEnv.js'
import { validateWorkflowDefinition } from '../workflows/validateWorkflow.js'

export type MatOSWorkflowTaskRunner = (
  args: string[],
  options: {
    cwd: string
    stdout: (text: string) => void
    stderr: (text: string) => void
  },
) => Promise<number>

export type MatOSWorkflowIO = {
  cwd: string
  env?: MatOSEnv
  /** Read stdin only when a command explicitly selects `-` as an input file. */
  stdin?: () => Promise<string> | string
  stdout: (text: string) => void
  stderr: (text: string) => void
  workflowContainer?: MatOSWorkflowContainerOps
  runTask?: MatOSWorkflowTaskRunner
}

type MatOSWorkflowContainerOps = {
  run: (input: MatOSWorkflowContainerRunInput) => Promise<number>
}

type MatOSWorkflowContainerRunInput = {
  hostCwd: string
  cwd: string
  scopeReference?: string
  argv: string[]
  env?: Record<string, string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export type ParsedArgs = {
  positionals: string[]
  json: boolean
  help: boolean
  params: Record<string, unknown>
  paramArgs: string[]
  execution?: 'local' | 'container'
  node?: string
  message?: string
  scope?: string
  id?: string
  name?: string
  version?: string
  description?: string
  fingerprint?: string
  expectedDefinition?: string
  reason?: string
  failedChildrenOnly?: boolean
  nodeJson?: string
  nodeFile?: string
  patchJson?: string
  patchFile?: string
  outputsJson?: string
  outputsFile?: string
  definitionJson?: string
  definitionFile?: string
  from?: string
  to?: string
  patch?: string
  route?: string
  guard?: string
  reducerJson?: string
  maxTraversals?: number
  transitionId?: string
  initialNode?: string
  maxTransitions?: number
  maxFrames?: number
  disable?: boolean
  operationsJson?: string
  operationsFile?: string
  sourceNode?: string
  risk?: 'low' | 'medium' | 'high'
  role?: string
  evidence?: string
  plan?: boolean
  detach?: boolean
  noPublish?: boolean
  timeoutSeconds?: string
  sinceEvent?: string
  tail?: string
}

const WORKFLOW_USAGE = `MatOS workflow CLI

Usage:
  matos workflow list [--json]
  matos workflow runs [<query>] [--scope <scope-ref>] [--json]
    (recent run rows: runId, status, workflowRef, updatedAt — use status/inspect for one run's detail)
  matos workflow show <workflow-ref> [--json]
  matos workflow validate <workflow-ref> [--json]
  matos workflow compile <workflow-ref> [--json]
  matos workflow compile-inspect <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow contract <workflow-ref|runId|draft:draftId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow preflight <workflow-ref> [--param key=value] [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow templates [<template-id>] [--json]
    (curated parameterized node templates — QE runs, convergence guards, compute jobs, structured agent analysis — to compose and adapt)
  matos workflow author --id <workflow-id> (--definition-json <json> | --definition-file <path|->) [--name <name>] [--version <version>] [--description <text>] [--no-publish] [--scope <scope-ref>] [--json]
    (one-call authoring: create/reset the draft, validate the definition, and publish it as workflow:<id>)
  matos workflow run <workflow-ref> [--param key=value] [--detach] [--execution local|container] [--scope <scope-ref>] [--json]
    (--detach: create the run, hand execution to a detached background worker, and return the runId immediately; follow with wait/status)
  matos workflow wait <runId> [--timeout-seconds <n>] [--since-event <eventId>] [--execution local|container] [--scope <scope-ref>] [--json]
    (bounded long-poll: blocks until the run settles, needs input/approval, stalls, or the timeout elapses; returns progress + guidance)
  matos workflow status <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow inspect <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow recover <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow recover-apply <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow recover-queue [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow recover-drain [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow reconcile <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow patches <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow patch-propose <runId> --operations <json-array>|--operations-file <path> [--reason <reason>] [--risk low|medium|high] [--source-node <nodeId>] [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow patch-inspect <runId> --patch <patchId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow patch-approve|patch-reject|patch-apply <runId> --patch <patchId> [--reason <reason>] [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow events <runId> [--tail <1-1000>] [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow approval-status <runId> [--json]
  matos workflow respond <runId> --node <nodeId> --message <message> [--json]
  matos workflow approve <runId> --node <nodeId> [--fingerprint <sha256>] [--message <message>] [--json]
  matos workflow deny <runId> --node <nodeId> [--reason <reason>] [--json]
  matos workflow cancel|pause|resume <runId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow retry-node <runId> --node <nodeId> [--failed-children-only] [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow skip-node <runId> --node <nodeId> [--execution local|container] [--scope <scope-ref>] [--json]
  matos workflow draft <subcommand> --help
  matos workflow draft create|list|show|compile|import-component|add-node|update-node|delete-node|connect|disconnect|set-outputs ...
  matos workflow draft replace-definition <draftId> (--definition-json <json> | --definition-file <path|->) [--json]
  matos workflow draft publish <draftId> --id <workflow-id> [--json]
  matos workflow draft connect-transition <draftId> --from <nodeId> --to <nodeId> [--route success|failure|always] [--guard <expr>] [--reducer-json <json>] [--max-traversals <n>] [--transition-id <id>]
  matos workflow draft disconnect-transition <draftId> [--transition-id <id>] [--from <nodeId>] [--to <nodeId>]
  matos workflow draft set-state-machine <draftId> --initial-node <nodeId> --max-transitions <n> [--max-frames <n>] | --disable
    (add transitions first, then set-state-machine; state-machine validation requires at least one transition)
  matos workflow draft from-task "<task>" [--role <role-ref>] [--plan] [--json]
  matos workflow repair <runId> [--role <role-ref>] [--evidence <text>] [--plan] [--json]
  matos workflow optimize <workflow-ref> [--evidence <text>] [--role <role-ref>] [--plan] [--json]
  matos workflow fork <runId> [--json]

Examples:
  matos workflow list --json
  matos workflow validate workflow:atomistic-materials-discovery --json
  matos workflow compile workflow:atomistic-materials-discovery --json
  matos workflow contract workflow:atomistic-materials-discovery --json
  matos workflow run workflow:atomistic-materials-discovery --execution container --scope user:admin --json
`

const WORKFLOW_DRAFT_USAGE: Record<string, string> = {
  'from-task':
    'Usage: matos workflow draft from-task "<task>" [--role <role-ref>] [--plan] [--json]',
  list: 'Usage: matos workflow draft list [--scope <scope-ref>] [--json]',
  create:
    'Usage: matos workflow draft create [--id <draft-id>] [--name <name>] [--version <version>] [--description <text>] [--scope <scope-ref>] [--json]',
  show:
    'Usage: matos workflow draft show <draftId> [--scope <scope-ref>] [--json]',
  compile:
    'Usage: matos workflow draft compile <draftId> [--scope <scope-ref>] [--json]',
  validate:
    'Usage: matos workflow draft validate <draftId> [--scope <scope-ref>] [--json] (alias of compile: validates the stored draft and prints diagnostics)',
  'import-component':
    'Usage: matos workflow draft import-component <draftId> <workflow-ref> [--scope <scope-ref>] [--json]',
  publish:
    'Usage: matos workflow draft publish <draftId> --id <workflow-id> [--name <name>] [--version <version>] [--description <text>] [--expected-definition <digest>] [--scope <scope-ref>] [--json]',
  'add-node':
    'Usage: matos workflow draft add-node <draftId> (--node-json <json> | --node-file <path>) [--scope <scope-ref>] [--json]',
  'update-node':
    'Usage: matos workflow draft update-node <draftId> --node <nodeId> (--patch-json <json> | --patch-file <path>) [--scope <scope-ref>] [--json]',
  'delete-node':
    'Usage: matos workflow draft delete-node <draftId> --node <nodeId> [--scope <scope-ref>] [--json]',
  connect:
    'Usage: matos workflow draft connect <draftId> --from <nodeId> --to <nodeId> [--scope <scope-ref>] [--json]',
  disconnect:
    'Usage: matos workflow draft disconnect <draftId> --from <nodeId> --to <nodeId> [--scope <scope-ref>] [--json]',
  'connect-transition':
    'Usage: matos workflow draft connect-transition <draftId> --from <nodeId> --to <nodeId> [--route success|failure|always] [--guard <expr>] [--reducer-json <json>] [--max-traversals <n>] [--transition-id <id>] [--scope <scope-ref>] [--json]',
  'disconnect-transition':
    'Usage: matos workflow draft disconnect-transition <draftId> [--transition-id <id>] [--from <nodeId>] [--to <nodeId>] [--scope <scope-ref>] [--json]',
  'set-state-machine':
    'Usage: matos workflow draft set-state-machine <draftId> (--initial-node <nodeId> --max-transitions <n> [--max-frames <n>] | --disable) [--scope <scope-ref>] [--json]',
  'set-outputs':
    'Usage: matos workflow draft set-outputs <draftId> (--outputs-json <json> | --outputs-file <path>) [--scope <scope-ref>] [--json]',
  'replace-definition':
    'Usage: matos workflow draft replace-definition <draftId> (--definition-json <json> | --definition-file <path|->) [--scope <scope-ref>] [--json]',
}

const WORKFLOW_DRAFT_HELP = `MatOS workflow draft CLI

Usage:
  matos workflow draft <subcommand> --help
  matos workflow draft create|list|show|validate|compile|import-component|publish
  matos workflow draft add-node|update-node|delete-node|connect|disconnect
  matos workflow draft connect-transition|disconnect-transition|set-state-machine
  matos workflow draft set-outputs|replace-definition|from-task
`

export function isHelpSubcommand(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h'
}

export function printWorkflowHelp(io: MatOSWorkflowIO): number {
  io.stdout(WORKFLOW_USAGE)
  return 0
}

export function workflowDraftUsage(subcommand: string): string {
  return WORKFLOW_DRAFT_USAGE[subcommand] ?? WORKFLOW_DRAFT_HELP.trimEnd()
}

export function printWorkflowDraftHelp(
  io: MatOSWorkflowIO,
  subcommand?: string,
): number {
  const usage = subcommand
    ? workflowDraftUsage(subcommand)
    : WORKFLOW_DRAFT_HELP.trimEnd()
  io.stdout(`${usage}\n`)
  return 0
}

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    help: false,
    params: {},
    paramArgs: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--param') {
      const value = args[index + 1]
      if (value) {
        setParam(parsed.params, value)
        parsed.paramArgs.push(value)
      }
      index += 1
    } else if (arg?.startsWith('--param=')) {
      const value = arg.slice('--param='.length)
      setParam(parsed.params, value)
      parsed.paramArgs.push(value)
    } else if (arg === '--execution') {
      const value = args[index + 1]
      if (value === 'local' || value === 'container') {
        parsed.execution = value
      }
      index += 1
    } else if (arg?.startsWith('--execution=')) {
      const value = arg.slice('--execution='.length)
      if (value === 'local' || value === 'container') {
        parsed.execution = value
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
    } else if (arg === '--scope') {
      parsed.scope = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--scope=')) {
      parsed.scope = arg.slice('--scope='.length)
    } else if (arg === '--id') {
      parsed.id = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--id=')) {
      parsed.id = arg.slice('--id='.length)
    } else if (arg === '--name') {
      parsed.name = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--name=')) {
      parsed.name = arg.slice('--name='.length)
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
    } else if (arg === '--fingerprint') {
      parsed.fingerprint = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--fingerprint=')) {
      parsed.fingerprint = arg.slice('--fingerprint='.length)
    } else if (arg === '--expected-definition') {
      parsed.expectedDefinition = args[index + 1] ?? ''
      index += 1
    } else if (arg?.startsWith('--expected-definition=')) {
      parsed.expectedDefinition = arg.slice('--expected-definition='.length)
    } else if (arg === '--tail') {
      parsed.tail = args[index + 1] ?? ''
      index += 1
    } else if (arg?.startsWith('--tail=')) {
      parsed.tail = arg.slice('--tail='.length)
    } else if (arg === '--reason') {
      parsed.reason = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--reason=')) {
      parsed.reason = arg.slice('--reason='.length)
    } else if (arg === '--failed-children-only') {
      parsed.failedChildrenOnly = true
    } else if (arg === '--node-json') {
      parsed.nodeJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--node-json=')) {
      parsed.nodeJson = arg.slice('--node-json='.length)
    } else if (arg === '--node-file') {
      parsed.nodeFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--node-file=')) {
      parsed.nodeFile = arg.slice('--node-file='.length)
    } else if (arg === '--patch-json') {
      parsed.patchJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--patch-json=')) {
      parsed.patchJson = arg.slice('--patch-json='.length)
    } else if (arg === '--patch-file') {
      parsed.patchFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--patch-file=')) {
      parsed.patchFile = arg.slice('--patch-file='.length)
    } else if (arg === '--outputs-json') {
      parsed.outputsJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--outputs-json=')) {
      parsed.outputsJson = arg.slice('--outputs-json='.length)
    } else if (arg === '--outputs-file') {
      parsed.outputsFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--outputs-file=')) {
      parsed.outputsFile = arg.slice('--outputs-file='.length)
    } else if (arg === '--definition-json') {
      parsed.definitionJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--definition-json=')) {
      parsed.definitionJson = arg.slice('--definition-json='.length)
    } else if (arg === '--definition-file') {
      parsed.definitionFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--definition-file=')) {
      parsed.definitionFile = arg.slice('--definition-file='.length)
    } else if (arg === '--from') {
      parsed.from = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--from=')) {
      parsed.from = arg.slice('--from='.length)
    } else if (arg === '--to') {
      parsed.to = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--to=')) {
      parsed.to = arg.slice('--to='.length)
    } else if (arg === '--patch') {
      parsed.patch = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--patch=')) {
      parsed.patch = arg.slice('--patch='.length)
    } else if (arg === '--route') {
      parsed.route = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--route=')) {
      parsed.route = arg.slice('--route='.length)
    } else if (arg === '--guard') {
      parsed.guard = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--guard=')) {
      parsed.guard = arg.slice('--guard='.length)
    } else if (arg === '--reducer-json') {
      parsed.reducerJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--reducer-json=')) {
      parsed.reducerJson = arg.slice('--reducer-json='.length)
    } else if (arg === '--max-traversals') {
      parsed.maxTraversals = Number(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--max-traversals=')) {
      parsed.maxTraversals = Number(arg.slice('--max-traversals='.length))
    } else if (arg === '--transition-id') {
      parsed.transitionId = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--transition-id=')) {
      parsed.transitionId = arg.slice('--transition-id='.length)
    } else if (arg === '--initial-node') {
      parsed.initialNode = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--initial-node=')) {
      parsed.initialNode = arg.slice('--initial-node='.length)
    } else if (arg === '--max-transitions') {
      parsed.maxTransitions = Number(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--max-transitions=')) {
      parsed.maxTransitions = Number(arg.slice('--max-transitions='.length))
    } else if (arg === '--max-frames') {
      parsed.maxFrames = Number(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--max-frames=')) {
      parsed.maxFrames = Number(arg.slice('--max-frames='.length))
    } else if (arg === '--disable') {
      parsed.disable = true
    } else if (arg === '--operations') {
      parsed.operationsJson = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--operations=')) {
      parsed.operationsJson = arg.slice('--operations='.length)
    } else if (arg === '--operations-file') {
      parsed.operationsFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--operations-file=')) {
      parsed.operationsFile = arg.slice('--operations-file='.length)
    } else if (arg === '--source-node') {
      parsed.sourceNode = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--source-node=')) {
      parsed.sourceNode = arg.slice('--source-node='.length)
    } else if (arg === '--risk') {
      const value = args[index + 1]
      if (value === 'low' || value === 'medium' || value === 'high') {
        parsed.risk = value
      }
      index += 1
    } else if (arg?.startsWith('--risk=')) {
      const value = arg.slice('--risk='.length)
      if (value === 'low' || value === 'medium' || value === 'high') {
        parsed.risk = value
      }
    } else if (arg === '--role') {
      parsed.role = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--role=')) {
      parsed.role = arg.slice('--role='.length)
    } else if (arg === '--evidence') {
      parsed.evidence = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--evidence=')) {
      parsed.evidence = arg.slice('--evidence='.length)
    } else if (arg === '--plan') {
      parsed.plan = true
    } else if (arg === '--detach') {
      parsed.detach = true
    } else if (arg === '--no-publish') {
      parsed.noPublish = true
    } else if (arg === '--timeout-seconds') {
      parsed.timeoutSeconds = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--timeout-seconds=')) {
      parsed.timeoutSeconds = arg.slice('--timeout-seconds='.length)
    } else if (arg === '--since-event') {
      parsed.sinceEvent = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--since-event=')) {
      parsed.sinceEvent = arg.slice('--since-event='.length)
    } else if (arg) {
      parsed.positionals.push(arg)
    }
  }
  return parsed
}

function setParam(params: Record<string, unknown>, assignment: string): void {
  const separator = assignment.indexOf('=')
  if (separator <= 0) {
    return
  }
  const key = assignment.slice(0, separator)
  const rawValue = assignment.slice(separator + 1)
  let value: unknown
  try {
    value = JSON.parse(rawValue) as unknown
  } catch {
    value = rawValue
  }
  const indexed = key.match(/^([A-Za-z][A-Za-z0-9_.-]*)\[(\d+)\]$/)
  if (!indexed) {
    params[key] = value
    return
  }
  const parameterName = indexed[1]!
  const index = Number(indexed[2])
  if (!Number.isSafeInteger(index) || index > 10_000) {
    return
  }
  const current = params[parameterName]
  const values = Array.isArray(current) ? [...current] : []
  values[index] = value
  params[parameterName] = values
}

export function writeJson(io: MatOSWorkflowIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

export function workflowServiceContext(
  io: MatOSWorkflowIO,
  scopeRef?: string,
): { cwd: string; scopeRef?: string; env?: MatOSEnv } {
  const context: { cwd: string; scopeRef?: string; env?: MatOSEnv } = {
    cwd: io.cwd,
  }
  if (scopeRef) {
    context.scopeRef = scopeRef
  }
  if (io.env) {
    context.env = io.env
  }
  return context
}


function workflowTraceEnv(sourceEnv: MatOSEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [
    'MATOS_TRACE_ID',
    'MATOS_SESSION_ID',
    'MATOS_PARENT_SESSION_ID',
    'MATOS_WORKFLOW_SESSION_ID',
    'MATOS_TURN_ID',
    'MATOS_USER_ID',
    'MATOS_SCOPE_ID',
    'MATOS_PROJECT_ID',
    'MATOS_RUNTIME_PROFILE_REF',
    'MATOS_ROLE_REF',
    'MATOS_ASSET_ROOTS',
    'MATOS_DEFAULT_ASSET_ROOTS',
    'MATOS_USER_VISIBLE_ASSET_ROOTS',
    'MATOS_BUNDLED_ASSET_ROOT',
    'MATOS_EDITABLE_CORE_ASSET_ROOT',
    'MATOS_READ_ROOTS',
    'MATOS_WRITE_ROOTS',
    'MATOS_INTERNAL_STATE_DIR',
    'MATOS_RUNTIME_MATERIALIZATION_DIR',
    'MATOS_WORKSPACE_ROOT',
    'MATOS_WORKSPACE_DIR',
    'MATOS_SESSION_DIR',
    'MATOS_WORKFLOW_RUNS_DIR',
    'MATOS_WORKFLOW_DRAFTS_DIR',
    'MATOS_CACHE_DIR',
    'MATOS_HIDE_INTERNAL_ASSET_SOURCE',
    'MATOS_VEPFS_PATH_MAP',
    'MATOS_AGENT_HOME',
    'HOME',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'NPM_CONFIG_CACHE',
    'PYTHONUSERBASE',
    'MATOS_USER_PYTHONUSERBASE',
    'PIP_USER',
    'PIP_CACHE_DIR',
    'UV_CACHE_DIR',
    'HF_HOME',
    'HF_ENDPOINT',
    'HUGGINGFACE_HUB_ENDPOINT',
    'TORCH_HOME',
    'WANDB_DIR',
    'CONDA_ENVS_PATH',
    'CONDA_PKGS_DIRS',
    'FONTCONFIG_PATH',
    'MPLCONFIGDIR',
  ]) {
    const value = envValue(sourceEnv, key)
    if (value) {
      env[key] = value
    }
  }
  env.MATOS_EXECUTION = 'container'
  return env
}

const DEFAULT_WORKFLOW_CONTAINER_OPS: MatOSWorkflowContainerOps = {
  async run() {
    throw new Error('This MatOS edition runs workflows locally only')
  },
}

export const CONTAINER_WORKFLOW_LIFECYCLE_COMMANDS = new Set([
  'status',
  'wait',
  'inspect',
  'compile-inspect',
  'contract',
  'recover',
  'recover-apply',
  'recover-queue',
  'recover-drain',
  'reconcile',
  'patches',
  'patch-propose',
  'patch-inspect',
  'patch-approve',
  'patch-reject',
  'patch-apply',
  'events',
  'artifacts',
  'approval-status',
  'respond',
  'approve',
  'deny',
  'cancel',
  'pause',
  'resume',
  'retry-node',
  'skip-node',
])

export function containerLifecycleArgv(
  subcommand: string,
  parsed: ParsedArgs,
): string[] {
  const argv = ['/app/bin/matos', 'workflow', subcommand]
  const runId = parsed.positionals[0]
  if (runId) {
    argv.push(runId)
  }
  if (parsed.scope) {
    argv.push('--scope', parsed.scope)
  }
  if (parsed.node) {
    argv.push('--node', parsed.node)
  }
  if (parsed.message !== undefined) {
    argv.push('--message', parsed.message)
  }
  if (parsed.fingerprint) {
    argv.push('--fingerprint', parsed.fingerprint)
  }
  if (parsed.tail !== undefined) {
    argv.push('--tail', parsed.tail)
  }
  if (parsed.reason) {
    argv.push('--reason', parsed.reason)
  }
  if (parsed.patch) {
    argv.push('--patch', parsed.patch)
  }
  if (parsed.operationsJson !== undefined) {
    argv.push('--operations', parsed.operationsJson)
  }
  if (parsed.operationsFile !== undefined) {
    argv.push('--operations-file', parsed.operationsFile)
  }
  if (parsed.sourceNode) {
    argv.push('--source-node', parsed.sourceNode)
  }
  if (parsed.risk) {
    argv.push('--risk', parsed.risk)
  }
  if (parsed.timeoutSeconds !== undefined) {
    argv.push('--timeout-seconds', parsed.timeoutSeconds)
  }
  if (parsed.sinceEvent !== undefined) {
    argv.push('--since-event', parsed.sinceEvent)
  }
  if (parsed.json) {
    argv.push('--json')
  }
  return argv
}

export async function runWorkflowCommandInContainer(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
  argv: string[],
): Promise<number> {
  const runner = io.workflowContainer ?? DEFAULT_WORKFLOW_CONTAINER_OPS
  try {
    return await runner.run({
      hostCwd: io.cwd,
      cwd: '/workspace/group/shared',
      scopeReference: parsed.scope,
      argv,
      env: workflowTraceEnv(io.env ?? process.env),
      stdout: io.stdout,
      stderr: io.stderr,
    })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function resolveWorkflowScope(
  io: MatOSWorkflowIO,
  scopeRef?: string,
): Promise<ReturnType<typeof resolveMatOSRuntimeScope>> {
  const config = await readMatOSProjectConfig(io.cwd)
  const scope = resolveMatOSRuntimeScope(io.cwd, {
    scopeRef,
    runtimeDataDir: config.execution?.runtimeDataDir,
    env: io.env,
  })
  const runsDir = envValue(io.env ?? process.env, 'MATOS_WORKFLOW_RUNS_DIR')
  if (!runsDir) {
    return scope
  }
  return {
    ...scope,
    workflowsDir: dirname(runsDir),
    workflowRunsDir: runsDir,
  }
}

export async function runDirForRunId(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  scopeRef?: string,
): Promise<string | undefined> {
  if (!runId) {
    return undefined
  }
  const scope = await resolveWorkflowScope(io, scopeRef)
  return join(scope.workflowRunsDir, runId)
}

export function parseMessage(value: string | undefined): unknown {
  if (value === undefined) {
    return ''
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export async function jsonPayload(
  value: string | undefined,
  file: string | undefined,
  cwd: string,
  stdin?: () => Promise<string> | string,
): Promise<unknown> {
  if (value !== undefined) {
    return JSON.parse(value) as unknown
  }
  if (file !== undefined) {
    if (file === '-') {
      const content = stdin ? await stdin() : await readWorkflowStdin()
      return JSON.parse(content) as unknown
    }
    const path = isAbsolute(file) ? file : join(cwd, file)
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  }
  throw new Error('JSON payload is required')
}

async function readWorkflowStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

export function draftMutationStatus(
  io: MatOSWorkflowIO,
  draftId: string,
  operation: string,
  validation: ReturnType<typeof validateWorkflowDefinition>,
): void {
  io.stdout(`${draftId}\t${operation}\t${validation.ok ? 'valid' : 'invalid'}\n`)
}
