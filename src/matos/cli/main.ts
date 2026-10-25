import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMatOSAppRoot, resolveMatOSBuildInfo } from './buildInfo.js'
import { configureMatOSEnvironment } from '../env.js'
import {
  applyMatOSProviderEnvToProcess,
  resolveMatOSProviderEnv,
} from '../provider/profile.js'
import {
  runMatOSAssetsCommand,
  runMatOSAssetTypeListCommand,
} from './assets.js'
import { runMatOSInit } from './init.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'

type LaunchAgent = (
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<number>

export type MatOSCliOptions = {
  cwd?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  launchAgent?: LaunchAgent
}

type CliIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

// Commands that must work without provider settings (to configure them).
const PROVIDER_FREE_COMMANDS = new Set(['login', 'help', '--help', '-h', '--version', '-v', '-V'])

function isBrokenPipeError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' &&
    (('code' in error && error.code === 'EPIPE') || ('errno' in error && error.errno === -32)))
}

function safeWriter(writer: (text: string) => void): (text: string) => void {
  return text => {
    try {
      writer(text)
    } catch (error) {
      if (!isBrokenPipeError(error)) throw error
    }
  }
}

export function matOSVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(resolveMatOSAppRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Agent sessions run in-process on DeepSeek Harness.
async function defaultLaunchAgent(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<number> {
  const { runMatOSAgentCli } = await import('../host/agentCli.js')
  const controller = new AbortController()
  const abort = (signal: NodeJS.Signals) => controller.abort(signal)
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  try {
    return await runMatOSAgentCli(args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: process.stdin,
      stdout: text => { process.stdout.write(text) },
      stderr: text => { process.stderr.write(text) },
      signal: controller.signal,
    })
  } finally {
    process.off('SIGTERM', abort)
    process.off('SIGINT', abort)
  }
}

// Daemon chat spawns pass the user task through MATOS_TASK_TEXT because the
// prompt travels over stdin after role composition ranks knowledge and
// experience against it. Consume it so tool subprocesses never inherit it.
function consumeTaskTextFromEnv(): string | undefined {
  const raw = process.env.MATOS_TASK_TEXT
  if (raw === undefined) return undefined
  delete process.env.MATOS_TASK_TEXT
  const trimmed = raw.trim()
  return trimmed ? trimmed.slice(0, 2000) : undefined
}

async function defaultRole(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { readMatOSProjectMetadata } = await import('../projectMetadata.js')
  const metadata = await readMatOSProjectMetadata(cwd, { allowMissing: true })
  if (metadata.id) {
    const { defaultProjectRoleRef } = await import('./run.js')
    return defaultProjectRoleRef(metadata, [env.MATOS_WORKSPACE_ROLE_REF, env.MATOS_ROLE_REF])
  }
  const configured = env.MATOS_WORKSPACE_ROLE_REF || env.MATOS_ROLE_REF
  return configured?.trim() ? configured : 'role:compute'
}

type RoleArgs = {
  role?: string
  additionalAssetRefs: string[]
  passthroughArgs: string[]
  error?: string
}

function parseRoleArgs(args: string[]): RoleArgs {
  const parsed: RoleArgs = { additionalAssetRefs: [], passthroughArgs: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (name === '--role' || name === '--asset') {
      const value = inline ?? args[++index]
      if (!value || value.startsWith('-')) return { ...parsed, error: `Usage: matos ${name} <ref>\n` }
      if (name === '--role') parsed.role = value
      else if (!parsed.additionalAssetRefs.includes(value)) parsed.additionalAssetRefs.push(value)
      continue
    }
    if (name === '--execution' && (inline ?? args[index + 1]) !== 'local') {
      return { ...parsed, error: 'This MatOS edition runs agents locally only.\n' }
    }
    if (name === '--execution') {
      if (inline === undefined) index++
      continue
    }
    parsed.passthroughArgs.push(arg)
  }
  return parsed
}

/** Compose a role and run its agent session (interactive or stream-json). */
async function launchRoleSession(
  args: string[],
  input: { cwd: string; launchAgent: LaunchAgent; role: string; additionalAssetRefs: string[] },
): Promise<number> {
  const {
    buildMatOSRoleLaunchInvocation,
    cleanupMatOSRunInvocationMaterialization,
    matOSInvocationAssetTraceEnv,
    recordMatOSAssetLoadedEvents,
  } = await import('./run.js')
  const taskText = consumeTaskTextFromEnv()
  const invocation = await buildMatOSRoleLaunchInvocation(input.role, input.cwd, args, {
    ...(taskText ? { taskText } : {}),
    ...(input.additionalAssetRefs.length ? { additionalAssetRefs: input.additionalAssetRefs } : {}),
  })
  const recorder = await createMatOSEventRecorder(input.cwd, {
    command: `matos ${args.map(arg => JSON.stringify(arg)).join(' ')}`.trim(),
    cwd: input.cwd,
    execution: 'local',
    roleRef: invocation.roleReference,
  })
  await recordMatOSAssetLoadedEvents({
    recorder,
    assets: invocation.assets,
    selectedAssetKeys: invocation.selectedAssetKeys,
    roleReference: invocation.roleReference,
  })
  let releaseProjectWriter = async () => {}
  try {
    if (invocation.projectAccess) {
      const { acquireMatOSProjectWriteLock } = await import('../runtime/projectWriteLock.js')
      releaseProjectWriter = await acquireMatOSProjectWriteLock({
        cwd: invocation.projectAccess.projectCwd,
        runId: recorder.sessionId,
        env: process.env,
      })
    }
  } catch (error) {
    await cleanupMatOSRunInvocationMaterialization(input.cwd, invocation).catch(() => {})
    await recorder.close().catch(() => {})
    throw error
  }
  const access = invocation.projectAccess
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...recorder.traceEnv,
    ...matOSInvocationAssetTraceEnv(invocation),
    MATOS_ROLE_REF: invocation.roleReference,
    MATOS_EXECUTION: 'local',
    ...(access ? {
      MATOS_PROJECT_CWD: access.projectCwd,
      MATOS_PROJECT_ID: access.projectId,
      MATOS_PROJECT_MEMBER_ID: access.memberId,
      MATOS_PROJECT_ORIGIN_ROLE_REF: invocation.roleReference,
      MATOS_WORKSPACE_ROLE_REF: invocation.roleReference,
      MATOS_PROJECT_WRITE_LOCK_HELD: recorder.sessionId,
      MATOS_PROJECT_WRITE_LOCK_CWD: access.projectCwd,
    } : {}),
  }
  try {
    const exitCode = await input.launchAgent(invocation.agentArgs, { cwd: input.cwd, env })
    await recorder.record({
      type: exitCode === 0 ? 'matos.session.completed' : 'matos.session.failed',
      data: { exitCode, execution: 'local', agentEngine: 'deepseek-harness' },
    })
    return exitCode
  } catch (error) {
    await recorder.record({
      type: 'matos.session.failed',
      data: { execution: 'local', error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  } finally {
    await cleanupMatOSRunInvocationMaterialization(input.cwd, invocation)
    await recorder.close()
    await releaseProjectWriter().catch(() => {})
  }
}

function printHelp(stdout: (text: string) => void): void {
  stdout(`MatOS: scientific agent workspace on DeepSeek Harness

Usage:
  matos [--role <role-ref>] [--asset <asset-ref> ...]   interactive session
  matos --role <role-ref> -p --input-format stream-json --output-format stream-json
  matos run [--role <role-ref>] [--asset <asset-ref> ...] "<task>"
  matos init [--standalone] [--scope user:<id>|project:<id>]
  matos login status|set|test|reset [--json]
  matos assets <list|show|validate|graph|archive|...> [--json]
  matos skills
  matos roles <list|show|runtime> [--json]
  matos workflow <list|show|run|runs|inspect|events|...> [--json]
  matos workbench <workflows|projects|feedback|models|search> [--json]
  matos evolve <status|monitor|feedback|...> [--json]
  matos usage profile [--json]
  matos --version [--json]
`)
}

function printVersion(stdout: (text: string) => void, args: string[]): void {
  const version = matOSVersion()
  if (args.includes('--json')) {
    stdout(`${JSON.stringify({ product: 'matos', ...resolveMatOSBuildInfo({ version }) })}\n`)
    return
  }
  stdout(`${version} (MatOS)\n`)
}

export async function runMatOSCli(args: string[], options: MatOSCliOptions = {}): Promise<number> {
  const command = args[0]
  const io: CliIO = {
    cwd: options.cwd ?? process.cwd(),
    stdout: safeWriter(options.stdout ?? (text => { process.stdout.write(text) })),
    stderr: safeWriter(options.stderr ?? (text => { process.stderr.write(text) })),
  }
  const launchAgent = options.launchAgent ?? defaultLaunchAgent
  configureMatOSEnvironment()
  if (!PROVIDER_FREE_COMMANDS.has(command ?? '')) {
    const provider = await resolveMatOSProviderEnv({ cwd: io.cwd, env: process.env })
    applyMatOSProviderEnvToProcess(provider.env)
  }

  switch (command) {
    case 'gateway':
    case 'workspace':
    case 'runtime':
      io.stderr('MatOS is single-user; use ./deploy.sh or scripts/matos-web.sh.\\n')
      return 2
    case 'help':
    case '--help':
    case '-h':
      printHelp(io.stdout)
      return 0
    case '--version':
    case '-v':
    case '-V':
      printVersion(io.stdout, args)
      return 0
    case 'init': {
      const scopeIndex = args.indexOf('--scope')
      if (scopeIndex >= 0 && (!args[scopeIndex + 1] || args[scopeIndex + 1]!.startsWith('--'))) {
        io.stderr('matos init --scope requires a scope reference\n')
        return 1
      }
      return runMatOSInit(io, {
        standalone: args.includes('--standalone'),
        scopeRef: scopeIndex >= 0 ? args[scopeIndex + 1] : undefined,
      })
    }
    case 'login': {
      const { runMatOSLoginCommand } = await import('./login.js')
      return runMatOSLoginCommand(args.slice(1), io)
    }
    case 'assets':
      return runMatOSAssetsCommand(args.slice(1), io)
    case 'skills':
      return runMatOSAssetTypeListCommand('skill', io, args.slice(1))
    case 'roles': {
      const { runMatOSRolesCommand } = await import('./roles.js')
      return runMatOSRolesCommand(args.slice(1), io)
    }
    case 'workflow': {
      const { runMatOSWorkflowCommand } = await import('./workflow.js')
      return runMatOSWorkflowCommand(args.slice(1), io)
    }
    case 'workbench': {
      const { runMatOSWorkbenchCommand } = await import('./workbench.js')
      return runMatOSWorkbenchCommand(args.slice(1), io)
    }
    case 'trace': {
      const {runMatOSTraceCommand}=await import('./trace.js')
      return runMatOSTraceCommand(args.slice(1),io)
    }
    case 'evolve': {
      const { runMatOSEvolveCommand } = await import('./evolve.js')
      return runMatOSEvolveCommand(args.slice(1), io)
    }
    case 'usage': {
      const { runMatOSUsageCommand } = await import('./usage.js')
      return runMatOSUsageCommand(args.slice(1), io)
    }
    case 'run': {
      const { runMatOSAgentTask } = await import('./run.js')
      return runMatOSAgentTask(args.slice(1), io)
    }
  }

  if (command && !command.startsWith('-')) {
    io.stderr(`Unknown matos command: ${command}\n`)
    printHelp(io.stderr)
    return 1
  }
  const roleArgs = parseRoleArgs(args)
  if (roleArgs.error) {
    io.stderr(roleArgs.error)
    return 1
  }
  try {
    return await launchRoleSession(roleArgs.passthroughArgs, {
      cwd: io.cwd,
      launchAgent,
      role: roleArgs.role ?? await defaultRole(io.cwd),
      additionalAssetRefs: roleArgs.additionalAssetRefs,
    })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
