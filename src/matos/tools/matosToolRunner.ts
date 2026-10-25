import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { currentMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'
import { normalizeMatOSToolName } from './toolNames.js'

export { normalizeMatOSToolName } from './toolNames.js'

export type MatOSToolDefinition = {
  id: string
  label: string
  description: string
  dir: string
  entry: string
  runtime: string
  pythonEnvironment?: MatOSToolManagedPythonEnvironment
  timeoutMs: number
  mcpName: string
  inputSchema: MatOSToolInputSchema
  prompt: string | undefined
  isReadOnly: boolean
  isDestructive: boolean
}

export type MatOSToolManagedPythonEnvironment = {
  kind: 'managed-python'
  name: string
  prefix: string
  pythonVersion?: string
  packages: Record<string, string>
  imports: string[]
}

export type MatOSToolCallResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type MatOSToolInputSchema = {
  type: 'object'
  properties?: Record<string, object>
  required?: string[]
  [key: string]: unknown
}

const PAPER_DB_ENV_KEYS = new Set([
  'MATOS_PAPER_DB_BASE_URL',
  'MATOS_PAPER_DB_USERNAME',
  'MATOS_PAPER_DB_PASSWORD',
  'MATOS_PAPER_DB_ENV_FILE',
  'MATOS_PAPER_DB_DOWNLOAD_ROOT',
  'MATOS_PAPER_DB_TIMEOUT_SECONDS',
  'MATOS_PAPER_DB_HTTP_PROXY',
  'MATOS_PAPER_DB_HTTPS_PROXY',
  'MATOS_CROSSREF_BASE_URL',
])

const COMPONENT_STDOUT_MAX_BYTES = 256 * 1024
const COMPONENT_STDERR_MAX_BYTES = 64 * 1024
// Non-component tools previously buffered stdout/stderr without any limit, so
// one runaway tool process could OOM the asset MCP server. Generous defaults;
// override with MATOS_TOOL_STDOUT_MAX_BYTES / MATOS_TOOL_STDERR_MAX_BYTES.
const DEFAULT_TOOL_STDOUT_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_TOOL_STDERR_MAX_BYTES = 4 * 1024 * 1024
// Grace between SIGTERM and SIGKILL when a tool ignores the timeout signal.
const DEFAULT_TOOL_KILL_GRACE_MS = 5000
const DEFAULT_MANAGED_PYTHON_ENV_ROOT = '/opt/matos-tools/conda/envs'
const MANAGED_PYTHON_ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const MANAGED_PYTHON_VERSION_RE = /^\d+(?:\.\d+){0,2}$/u
const PYTHON_DISTRIBUTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const PYTHON_IMPORT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u
const PYTHON_PACKAGE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,127}$/u
const managedPythonEnvironmentChecks = new Map<string, Promise<void>>()

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
const COMPONENT_SECRET_ENV_KEY =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|CREDENTIAL|COOKIE|PRIVATE[_-]?KEY)/iu

// Python component tools run after their one pinned source file and required
// stdlib modules are loaded. The seccomp filter then denies every subsequent
// filesystem open, mutation, network socket, and child-process syscall. This
// turns manifest permissions into an enforced read-none decision boundary;
// observable scientific inputs must arrive on stdin through workflow nodes.
const PYTHON_ALGORITHM_COMPONENT_WRAPPER = String.raw`
import __future__, ctypes, ctypes.util, errno, hashlib, json, math, os, pathlib, random, re
import signal, statistics, sys, time, typing

entry = sys.argv[1]
with open(entry, 'rb') as handle:
    source = handle.read(16777217)
if len(source) > 16777216:
    raise SystemExit(124)

lib = ctypes.CDLL(ctypes.util.find_library('seccomp') or 'libseccomp.so.2')
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
lib.seccomp_rule_add.restype = ctypes.c_int
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_load.restype = ctypes.c_int
lib.seccomp_release.argtypes = [ctypes.c_void_p]
ALLOW = 0x7fff0000
ERRNO = 0x00050000 | errno.EPERM
ctx = lib.seccomp_init(ALLOW)
if not ctx:
    raise SystemExit(125)
blocked = [
    'open', 'openat', 'openat2', 'creat', 'truncate', 'ftruncate',
    'unlink', 'unlinkat', 'rename', 'renameat', 'renameat2',
    'mkdir', 'mkdirat', 'rmdir', 'link', 'linkat', 'symlink', 'symlinkat',
    'mknod', 'mknodat', 'chmod', 'fchmod', 'fchmodat',
    'chown', 'fchown', 'fchownat', 'lchown', 'mount', 'umount2',
    'socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4',
    'sendto', 'sendmsg', 'sendmmsg', 'recvfrom', 'recvmsg', 'recvmmsg',
    'shutdown', 'setsockopt', 'getsockopt',
    'clone', 'clone3', 'fork', 'vfork', 'execve', 'execveat',
]
for name in blocked:
    number = lib.seccomp_syscall_resolve_name(name.encode())
    if number >= 0 and lib.seccomp_rule_add(ctx, ERRNO, number, 0) != 0:
        lib.seccomp_release(ctx)
        raise SystemExit(125)
libc = ctypes.CDLL(None)
if libc.prctl(38, 1, 0, 0, 0) != 0 or lib.seccomp_load(ctx) != 0:
    lib.seccomp_release(ctx)
    raise SystemExit(125)
lib.seccomp_release(ctx)
scope = {'__name__': '__main__', '__file__': entry, '__builtins__': __builtins__}
exec(compile(source, entry, 'exec'), scope, scope)
`

function algorithmComponentBaseEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (COMPONENT_SECRET_ENV_KEY.test(key)) continue
    if (
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'TZ',
        'VIRTUAL_ENV',
        'CONDA_PREFIX',
        'LD_LIBRARY_PATH',
      ].includes(key) ||
      key.startsWith('LC_') ||
      key.startsWith('PYTHON')
    ) {
      allowed[key] = value
    }
  }
  return allowed
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean),
      )]
    : []
}

function parseManagedPythonEnvironment(
  value: unknown,
  toolId: string,
): MatOSToolManagedPythonEnvironment | undefined {
  if (value === undefined || value === null) return undefined
  const raw = metadataObject(value)
  const kind = optionalString(raw.kind)
  if (kind !== 'managed-python') {
    throw new Error(
      `MatOS tool ${toolId} pythonEnvironment.kind must be "managed-python"`,
    )
  }
  const name = optionalString(raw.name)
  if (!name || !MANAGED_PYTHON_ENV_NAME_RE.test(name)) {
    throw new Error(`MatOS tool ${toolId} has an invalid managed Python environment name`)
  }
  const pythonVersion = optionalString(raw.pythonVersion ?? raw.python)
  if (pythonVersion && !MANAGED_PYTHON_VERSION_RE.test(pythonVersion)) {
    throw new Error(`MatOS tool ${toolId} has an invalid managed Python version`)
  }
  const rawPackages = metadataObject(raw.packages)
  const packages: Record<string, string> = {}
  for (const [distribution, versionValue] of Object.entries(rawPackages)) {
    const version = optionalString(versionValue)
    if (
      !PYTHON_DISTRIBUTION_RE.test(distribution) ||
      !version ||
      !PYTHON_PACKAGE_VERSION_RE.test(version)
    ) {
      throw new Error(
        `MatOS tool ${toolId} has an invalid managed Python package requirement`,
      )
    }
    packages[distribution] = version
  }
  const imports = stringList(raw.imports)
  if (imports.some(importName => !PYTHON_IMPORT_RE.test(importName))) {
    throw new Error(`MatOS tool ${toolId} has an invalid managed Python import probe`)
  }
  const root =
    optionalString(process.env.MATOS_SYSTEM_CONDA_ENVS_PATH) ??
    DEFAULT_MANAGED_PYTHON_ENV_ROOT
  return {
    kind: 'managed-python',
    name,
    prefix: resolve(root, name),
    ...(pythonVersion ? { pythonVersion } : {}),
    packages,
    imports,
  }
}

const MANAGED_PYTHON_ENVIRONMENT_PROBE = String.raw`
import importlib
import importlib.metadata as metadata
import json
import sys

expected_python = sys.argv[1]
expected_packages = json.loads(sys.argv[2])
expected_imports = json.loads(sys.argv[3])
actual_python = sys.version.split()[0]
issues = []
if expected_python and not (
    actual_python == expected_python or actual_python.startswith(expected_python + ".")
):
    issues.append({"kind": "python", "expected": expected_python, "actual": actual_python})
for distribution, expected in expected_packages.items():
    try:
        actual = metadata.version(distribution)
    except metadata.PackageNotFoundError:
        actual = None
    if actual != expected:
        issues.append({
            "kind": "package",
            "name": distribution,
            "expected": expected,
            "actual": actual,
        })
for import_name in expected_imports:
    try:
        importlib.import_module(import_name)
    except Exception as error:
        issues.append({
            "kind": "import",
            "name": import_name,
            "error": f"{type(error).__name__}: {error}",
        })
print(json.dumps({"python": actual_python, "issues": issues}, sort_keys=True))
raise SystemExit(1 if issues else 0)
`

async function verifyManagedPythonEnvironment(
  tool: MatOSToolDefinition,
  env: Record<string, string | undefined>,
): Promise<void> {
  const contract = tool.pythonEnvironment
  if (!contract) return
  const cacheKey = JSON.stringify([
    tool.runtime,
    contract.pythonVersion,
    contract.packages,
    contract.imports,
  ])
  const existing = managedPythonEnvironmentChecks.get(cacheKey)
  if (existing) return existing
  const check = new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      tool.runtime,
      [
        '-I',
        '-c',
        MANAGED_PYTHON_ENVIRONMENT_PROBE,
        contract.pythonVersion ?? '',
        JSON.stringify(contract.packages),
        JSON.stringify(contract.imports),
      ],
      {
        cwd: tool.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(
        new Error(
          `MatOS managed Python environment "${contract.name}" preflight timed out`,
        ),
      )
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(
        new Error(
          `MatOS managed Python environment "${contract.name}" is unavailable: ${error.message}`,
        ),
      )
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolvePromise()
        return
      }
      let detail = stderr.trim() || stdout.trim()
      try {
        const parsed = JSON.parse(stdout) as { issues?: unknown }
        if (Array.isArray(parsed.issues)) detail = JSON.stringify(parsed.issues)
      } catch {
        // Preserve the bounded interpreter output as the diagnostic.
      }
      rejectPromise(
        new Error(
          `MatOS managed Python environment "${contract.name}" is incompatible${
            detail ? `: ${detail}` : ''
          }`,
        ),
      )
    })
  })
  managedPythonEnvironmentChecks.set(cacheKey, check)
  try {
    await check
  } catch (error) {
    managedPythonEnvironmentChecks.delete(cacheKey)
    throw error
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function readJsonIfExists(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJson(path)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

function normalizeInputSchema(schema: Record<string, unknown>): MatOSToolInputSchema {
  return {
    ...schema,
    type: 'object',
    properties:
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, object>)
        : undefined,
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : undefined,
  }
}

function parseEnvAssignment(line: string): [string, string] | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined
  }
  if (trimmed.startsWith('export ')) {
    trimmed = trimmed.slice('export '.length).trim()
  }
  const separator = trimmed.indexOf('=')
  if (separator < 1) {
    return undefined
  }
  const key = trimmed.slice(0, separator).trim()
  if (!PAPER_DB_ENV_KEYS.has(key)) {
    return undefined
  }
  let value = trimmed.slice(separator + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1)
  }
  return [key, value]
}

function ancestorEnvFiles(start: string): string[] {
  let current = resolve(start)
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, '.env.deploy')
    if (existsSync(candidate)) {
      return [candidate]
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return []
}

async function loadPaperDbEnvFiles(
  baseEnv: NodeJS.ProcessEnv,
  extraPaths: string[] = [],
): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...baseEnv }
  const explicitEnvKeys = new Set(
    [...PAPER_DB_ENV_KEYS].filter(key =>
      Object.prototype.hasOwnProperty.call(baseEnv, key),
    ),
  )
  const paths = [
    { path: '.env.deploy', override: false },
    ...extraPaths.map(path => ({ path, override: false })),
    { path: env.MATOS_DEPLOY_ENV_FILE, override: false },
    { path: '/run/matos-paper-db.env', override: true },
    { path: '/home/paper-db.env', override: true },
    { path: '/home/workspace/.matos/paper-db.env', override: true },
    { path: env.MATOS_PAPER_DB_ENV_FILE, override: true },
  ].filter((item): item is { path: string; override: boolean } => Boolean(item.path))

  for (const { path, override } of paths) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseEnvAssignment(line)
      if (!parsed) {
        continue
      }
      const [key, value] = parsed
      if (override || !explicitEnvKeys.has(key)) {
        env[key] = value
      }
    }
  }
  return env
}

async function toolProcessEnv(
  tool: MatOSToolDefinition,
): Promise<Record<string, string | undefined>> {
  const baseEnv =
    tool.id === 'paper-database' || tool.mcpName === 'paper_database'
      ? await loadPaperDbEnvFiles(process.env, ancestorEnvFiles(tool.dir))
      : process.env
  const pythonEnvironment = tool.pythonEnvironment
  const environmentEnv = pythonEnvironment
    ? {
        ...baseEnv,
        PATH: `${join(pythonEnvironment.prefix, 'bin')}:${baseEnv.PATH ?? ''}`,
        PYTHONNOUSERSITE: '1',
        PYTHONPATH: '',
        CONDA_PREFIX: pythonEnvironment.prefix,
        VIRTUAL_ENV: pythonEnvironment.prefix,
        MATOS_TOOL_PYTHON_ENVIRONMENT: pythonEnvironment.name,
      }
    : baseEnv
  const workflow = currentMatOSWorkflowExecutionContext()
  if (!workflow) return environmentEnv
  const componentPin = workflow.workflowNodeId
    ? workflow.algorithmComponentPins?.get(workflow.workflowNodeId)
    : undefined
  return {
    ...(componentPin
      ? algorithmComponentBaseEnv(environmentEnv)
      : environmentEnv),
    MATOS_WORKFLOW_RUN_ID: workflow.runId,
    ...(!componentPin
      ? {
          MATOS_WORKFLOW_RUN_DIR: workflow.runDir,
          MATOS_WORKFLOW_RUNS_DIR: dirname(workflow.runDir),
          MATOS_PROJECT_CWD: workflow.projectCwd,
        }
      : {}),
    ...(workflow.scopeRef ? { MATOS_SCOPE_REF: workflow.scopeRef } : {}),
    ...(workflow.workflowNodeId
      ? { MATOS_WORKFLOW_NODE_ID: workflow.workflowNodeId }
      : {}),
    ...(workflow.attempt !== undefined
      ? { MATOS_WORKFLOW_ATTEMPT: String(workflow.attempt) }
      : {}),
    ...(componentPin
      ? {
          MATOS_ALGORITHM_DECISION_PROTOCOL: componentPin.protocol,
          MATOS_ALGORITHM_PLANE: componentPin.plane,
          MATOS_ALGORITHM_PROVIDER_ID: componentPin.providerId,
          MATOS_ALGORITHM_PROVIDER_VERSION: componentPin.providerVersion,
          MATOS_ALGORITHM_ASSET_REF: componentPin.assetRef,
          MATOS_ALGORITHM_CONFIG_DIGEST: componentPin.configDigest,
          MATOS_ALGORITHM_ASSET_MANIFEST_DIGEST:
            componentPin.assetManifestDigest,
          MATOS_ALGORITHM_ENTRY_DIGEST: componentPin.entryDigest,
          MATOS_ALGORITHM_IMPLEMENTATION_DIGEST:
            componentPin.implementationDigest,
          MATOS_ALGORITHM_RUN_MANIFEST_DIGEST: componentPin.manifestDigest,
        }
      : {}),
  }
}

export async function loadMatOSToolDefinitions(
  toolDirs: string[],
): Promise<MatOSToolDefinition[]> {
  const definitions: MatOSToolDefinition[] = []

  for (const toolDir of toolDirs) {
    const nativeManifest = await readJsonIfExists(join(toolDir, 'asset.json'))
    const legacyManifest = nativeManifest
      ? undefined
      : await readJson(join(toolDir, 'matos.tool.json'))
    const manifest = nativeManifest ?? legacyManifest ?? {}
    const metadata = metadataObject(manifest.metadata)
    const nativeExecutor = metadataObject(metadata.executor)
    const legacyImpl = metadataObject(manifest.impl)
    const executor = nativeManifest ? nativeExecutor : legacyImpl
    const id = optionalString(manifest.id) ?? basename(toolDir)
    if (nativeManifest && optionalString(metadata.kind) === 'builtin-pack') {
      continue
    }
    const entry =
      optionalString(executor.entry) ?? optionalString(manifest.entry)
    if (!entry) {
      throw new Error(`MatOS tool ${id} is missing executor entry`)
    }

    const inputSchemaPath = nativeManifest
      ? optionalString(metadata.inputSchemaPath)
      : optionalString(manifest.inputSchema)
    const promptPath = nativeManifest
      ? optionalString(metadata.promptPath)
      : optionalString(manifest.prompt)
    const inputSchema = normalizeInputSchema(
      inputSchemaPath
        ? await readJson(resolve(toolDir, inputSchemaPath))
        : { type: 'object', additionalProperties: true },
    )
    const prompt = promptPath
      ? await readFile(resolve(toolDir, promptPath), 'utf8').catch(() => undefined)
      : undefined
    const pythonEnvironment = parseManagedPythonEnvironment(
      executor.pythonEnvironment,
      id,
    )
    const declaredRuntime = optionalString(executor.runtime)
    const managedRuntime = pythonEnvironment
      ? join(pythonEnvironment.prefix, 'bin', 'python')
      : undefined
    if (
      managedRuntime &&
      declaredRuntime &&
      !['python', 'python3'].includes(declaredRuntime.toLowerCase()) &&
      resolve(declaredRuntime) !== resolve(managedRuntime)
    ) {
      throw new Error(
        `MatOS tool ${id} runtime conflicts with its managed Python environment`,
      )
    }

    definitions.push({
      id,
      label:
        optionalString(manifest.label) ?? optionalString(manifest.name) ?? id,
      description:
        optionalString(manifest.description) ??
        optionalString(manifest.label) ??
        optionalString(manifest.name) ??
        id,
      dir: toolDir,
      entry: resolve(toolDir, entry),
      runtime: managedRuntime ?? declaredRuntime ?? 'python3',
      ...(pythonEnvironment ? { pythonEnvironment } : {}),
      timeoutMs:
        typeof executor.timeoutMs === 'number' &&
        Number.isFinite(executor.timeoutMs)
          ? executor.timeoutMs
          : 30000,
      mcpName: optionalString(executor.mcpName) ?? normalizeMatOSToolName(id),
      inputSchema,
      prompt,
      isReadOnly:
        metadata.isReadOnly === true || legacyManifest?.isReadOnly === true,
      isDestructive:
        metadata.isDestructive === true ||
        legacyManifest?.isDestructive === true,
    })
  }

  return definitions.sort((a, b) => a.id.localeCompare(b.id))
}

export async function callMatOSTool(
  tool: MatOSToolDefinition,
  input: unknown,
): Promise<MatOSToolCallResult> {
  const env = await toolProcessEnv(tool)
  await verifyManagedPythonEnvironment(tool, env)
  const workflow = currentMatOSWorkflowExecutionContext()
  const componentPin = workflow?.workflowNodeId
    ? workflow.algorithmComponentPins?.get(workflow.workflowNodeId)
    : undefined
  let command = tool.runtime
  let args = [tool.entry]
  if (componentPin) {
    const runtime = basename(tool.runtime).toLowerCase()
    if (runtime === 'python' || runtime === 'python3') {
      args = ['-I', '-S', '-c', PYTHON_ALGORITHM_COMPONENT_WRAPPER, tool.entry]
    } else if (runtime === 'node' || runtime === 'nodejs') {
      args = [
        '--permission',
        `--allow-fs-read=${tool.entry}`,
        '--no-addons',
        '--no-global-search-paths',
        '--max-old-space-size=128',
        tool.entry,
      ]
    } else {
      throw new Error(
        `Algorithm component runtime is not enforceable: ${tool.runtime}`,
      )
    }
  }
  const stdoutMaxBytes = componentPin
    ? COMPONENT_STDOUT_MAX_BYTES
    : positiveIntEnv('MATOS_TOOL_STDOUT_MAX_BYTES', DEFAULT_TOOL_STDOUT_MAX_BYTES)
  const stderrMaxBytes = componentPin
    ? COMPONENT_STDERR_MAX_BYTES
    : positiveIntEnv('MATOS_TOOL_STDERR_MAX_BYTES', DEFAULT_TOOL_STDERR_MAX_BYTES)
  const killGraceMs = positiveIntEnv(
    'MATOS_TOOL_KILL_GRACE_MS',
    DEFAULT_TOOL_KILL_GRACE_MS,
  )
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: tool.dir,
      env,
      // Own process group so timeout/limit kills reach the whole tool subtree
      // (a Python tool that spawned solvers/helpers), not just the direct
      // child. Killing only the child leaked SIGTERM-ignoring trees forever.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined
    const killProcessTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal)
          return
        }
      } catch {
        // Fall through to the direct-child kill below.
      }
      try {
        child.kill(signal)
      } catch {
        // The tool process may have exited between checks.
      }
    }
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      if (componentPin) {
        killProcessTree('SIGKILL')
      } else {
        killProcessTree('SIGTERM')
        killEscalationTimer = setTimeout(() => {
          killProcessTree('SIGKILL')
        }, killGraceMs)
        killEscalationTimer.unref?.()
      }
      settled = true
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Timed out after ${tool.timeoutMs}ms`,
      })
    }, tool.timeoutMs)
    const settleWithLimitExceeded = (message: string): void => {
      killProcessTree('SIGKILL')
      settled = true
      clearTimeout(timeout)
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: message,
      })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (settled) return
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes > stdoutMaxBytes) {
        settleWithLimitExceeded(
          componentPin
            ? 'Algorithm component stdout exceeded the 256 KiB limit'
            : `MatOS tool stdout exceeded the ${stdoutMaxBytes} byte limit`,
        )
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (settled) return
      stderrBytes += Buffer.byteLength(chunk, 'utf8')
      if (stderrBytes > stderrMaxBytes) {
        settleWithLimitExceeded(
          componentPin
            ? 'Algorithm component stderr exceeded the 64 KiB limit'
            : `MatOS tool stderr exceeded the ${stderrMaxBytes} byte limit`,
        )
        return
      }
      stderr += chunk
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer)
      }
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolvePromise({ exitCode: code, stdout, stderr })
    })
    // A tool killed mid-write (timeout/limit) can surface EPIPE on stdin;
    // without a listener that would crash the MCP server process.
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify({ input: input ?? {} })}\n`)
  })
}
