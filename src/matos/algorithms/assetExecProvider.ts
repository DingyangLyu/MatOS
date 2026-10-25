import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { MatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import {
  MATOS_ALGORITHM_SERIALIZED_INPUT_MAX_BYTES,
  matOSAlgorithmSurfaceIsSerializable,
  serializeMatOSAlgorithmInput,
} from './serialization.js'
import {
  getMatOSAlgorithmSurface,
  type MatOSAlgorithmProvider,
  type MatOSAlgorithmProviderOverrides,
} from './surface.js'

/**
 * Bridge from MatOS `tool` assets to Algorithm Layer providers.
 *
 * A tool asset opts in by declaring:
 *
 * ```json
 * {
 *   "type": "tool",
 *   "entry": "./strategy.cjs",
 *   "metadata": {
 *     "algorithmSurface": "context-ranking",
 *     "decisionProtocol": "json-v1"
 *   }
 * }
 * ```
 *
 * json-v1 protocol: the executable receives
 * `{"surfaceId":"<id>","protocol":"json-v1","input":{...}}` on stdin and must
 * print `{"decision":{...}}` to stdout and exit 0. Any violation (non-zero
 * exit, timeout, oversized or unparsable output) makes the provider throw,
 * which the surface converts into a baseline fallback. Decisions still pass
 * through the surface's `sanitizeDecision` clamp, so an asset strategy can
 * never escape surface invariants (candidate-set containment, approval
 * only-tighten).
 *
 * Execution is intentionally synchronous (spawnSync): live call sites such as
 * role runtime composition decide synchronously, and strategy calls are rare
 * (session composition / workflow approval), not per-token.
 */

export const MATOS_ALGORITHM_DECISION_PROTOCOL = 'json-v1'

const DEFAULT_EXEC_TIMEOUT_MS = 2000
const MIN_EXEC_TIMEOUT_MS = 100
const MAX_EXEC_TIMEOUT_MS = 10_000
const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024

// libseccomp is available in the MatOS Linux runtime. The wrapper installs a
// no-new-privileges filter before exec: strategies cannot open network sockets
// or mutate the filesystem. Algorithm provider assets are Node-only so the
// permission model can additionally limit reads to the one pinned entry file.
// Python/shell remain valid normal MatOS tools, but are not accepted as
// in-process algorithm providers until they have an equally strong read
// boundary through the native Tool/MCP/container permission machinery.
const SECCOMP_EXEC_WRAPPER = String.raw`
import ctypes, ctypes.util, errno, os, subprocess, sys

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
    'socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4',
    'sendto', 'sendmsg', 'sendmmsg', 'recvfrom', 'recvmsg', 'recvmmsg',
    'shutdown', 'setsockopt', 'getsockopt',
    'creat', 'unlink', 'unlinkat', 'rename', 'renameat', 'renameat2',
    'mkdir', 'mkdirat', 'rmdir', 'link', 'linkat', 'symlink', 'symlinkat',
    'mknod', 'mknodat', 'truncate', 'ftruncate', 'chmod', 'fchmod',
    'fchmodat', 'chown', 'fchown', 'fchownat', 'lchown', 'mount', 'umount2',
    'openat2',
]
for name in blocked:
    number = lib.seccomp_syscall_resolve_name(name.encode())
    if number >= 0 and lib.seccomp_rule_add(ctx, ERRNO, number, 0) != 0:
        lib.seccomp_release(ctx)
        raise SystemExit(125)

class ArgCmp(ctypes.Structure):
    _fields_ = [
        ('arg', ctypes.c_uint),
        ('op', ctypes.c_int),
        ('datum_a', ctypes.c_uint64),
        ('datum_b', ctypes.c_uint64),
    ]

lib.seccomp_rule_add_array.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
    ctypes.POINTER(ArgCmp),
]
lib.seccomp_rule_add_array.restype = ctypes.c_int
MASKED_EQ = 7
write_flags = [
    (os.O_ACCMODE, os.O_WRONLY),
    (os.O_ACCMODE, os.O_RDWR),
    (os.O_CREAT, os.O_CREAT),
    (os.O_TRUNC, os.O_TRUNC),
    (os.O_APPEND, os.O_APPEND),
]
if hasattr(os, 'O_TMPFILE'):
    write_flags.append((os.O_TMPFILE, os.O_TMPFILE))
for syscall_name, flags_arg in [('open', 1), ('openat', 2)]:
    number = lib.seccomp_syscall_resolve_name(syscall_name.encode())
    if number < 0:
        continue
    for mask, expected in write_flags:
        comparison = ArgCmp(flags_arg, MASKED_EQ, mask, expected)
        if lib.seccomp_rule_add_array(ctx, ERRNO, number, 1, ctypes.byref(comparison)) != 0:
            lib.seccomp_release(ctx)
            raise SystemExit(125)

libc = ctypes.CDLL(None)
if libc.prctl(38, 1, 0, 0, 0) != 0 or lib.seccomp_load(ctx) != 0:
    lib.seccomp_release(ctx)
    raise SystemExit(125)
lib.seccomp_release(ctx)
completed = subprocess.run(
    sys.argv[1:],
    input=sys.stdin.buffer.read(1048577),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=os.environ,
    check=False,
)
if len(completed.stdout) > 1048576 or len(completed.stderr) > 1048576:
    raise SystemExit(126)
sys.stdout.buffer.write(completed.stdout)
sys.stderr.buffer.write(completed.stderr)
raise SystemExit(completed.returncode)
`

const registeredProviderKeys = new Set<string>()

export type MatOSAssetExecProviderRegistration = {
  surfaceId: string
  providerId: string
  assetKey: string
}

export type MatOSAssetExecProviderSkip = {
  assetKey: string
  reason: 'unsupported-protocol' | 'unknown-surface' | 'no-runnable-entry'
}

export type MatOSAssetExecProviderReport = {
  registered: MatOSAssetExecProviderRegistration[]
  skipped: MatOSAssetExecProviderSkip[]
}

export type MatOSAssetExecProviderScope = {
  report: MatOSAssetExecProviderReport
  providerOverridesBySurface: ReadonlyMap<
    string,
    MatOSAlgorithmProviderOverrides
  >
  providersFor: (surfaceId: string) => MatOSAlgorithmProviderOverrides | undefined
}

/** Stable provider id for a strategy tool asset (`asset:tool:<id>@<ver>`). */
export function matOSAssetExecProviderId(asset: MatOSAsset): string {
  return `asset:tool:${asset.id}@${asset.version}`
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function assetExecDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.MATOS_ALGO_ASSET_PROVIDERS ??
    process.env.MATOS_ALGO_ASSET_PROVIDERS ??
    ''
  )
    .trim()
    .toLowerCase()
  return ['0', 'off', 'false', 'none'].includes(raw)
}

function executorTimeoutMs(asset: MatOSAsset): number {
  const executor = asset.metadata.executor
  const raw =
    executor && typeof executor === 'object' && !Array.isArray(executor)
      ? (executor as Record<string, unknown>).timeoutMs
      : undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(Math.max(Math.trunc(raw), MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS)
  }
  return DEFAULT_EXEC_TIMEOUT_MS
}

type AssetExecutorCommand = {
  command: string
  args: string[]
  entry: string
  runtime: 'node'
}

function executorCommand(
  asset: MatOSAsset,
): AssetExecutorCommand | undefined {
  const rawEntry =
    asset.entryAbsolutePath ??
    (asset.entryRelativePath
      ? join(asset.manifestDir, asset.entryRelativePath)
      : undefined)
  if (!rawEntry) {
    return undefined
  }
  // The runnable entry must stay inside the asset directory; an asset
  // manifest cannot point the strategy executor at arbitrary files.
  let entry = resolve(rawEntry)
  const assetRoot = resolve(asset.manifestDir)
  if (entry !== assetRoot && !entry.startsWith(`${assetRoot}${sep}`)) {
    return undefined
  }
  try {
    if (lstatSync(entry).isSymbolicLink() || !lstatSync(entry).isFile()) {
      return undefined
    }
    const realRoot = realpathSync(assetRoot)
    const realEntry = realpathSync(entry)
    if (realEntry !== realRoot && !realEntry.startsWith(`${realRoot}${sep}`)) {
      return undefined
    }
    // Node resolves the module before checking its filesystem permission.
    // Use that same path for both the entrypoint and the narrow read grant.
    entry = realEntry

  } catch {
    return undefined
  }
  if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs') || entry.endsWith('.ts')) {
    return {
      command: 'node',
      args: [
        '--permission',
        `--allow-fs-read=${entry}`,
        '--no-addons',
        '--no-global-search-paths',
        '--max-old-space-size=128',
        entry,
      ],
      entry,
      runtime: 'node',
    }
  }
  return undefined
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function assetProviderIdentity(asset: MatOSAsset): {
  version?: string
  assetRef: string
  configDigest: string
  implementationDigest: string
} | undefined {
  const command = executorCommand(asset)
  if (!command) return undefined
  try {
    const manifest = readFileSync(asset.manifestPath)
    const entry = readFileSync(command.entry)
    return {
      ...(asset.version ? { version: asset.version } : {}),
      assetRef: asset.canonicalKey,
      configDigest: sha256(
        JSON.stringify(
          stableValue({
            surfaceId: asset.metadata.algorithmSurface,
            protocol: asset.metadata.decisionProtocol,
            executor: asset.metadata.executor,
          }),
        ),
      ),
      implementationDigest: createHash('sha256')
        .update(manifest)
        .update('\0')
        .update(entry)
        .digest('hex'),
    }
  } catch {
    return undefined
  }
}

function execDecision(input: {
  asset: MatOSAsset
  surfaceId: string
  decisionInput: unknown
}): unknown {
  const command = executorCommand(input.asset)
  if (!command) {
    throw new Error(
      `Algorithm tool asset ${input.asset.canonicalKey} has no runnable entry`,
    )
  }
  // Only allowlisted input fields cross the process boundary; runtime
  // handles (registry, role, env) never reach strategy executables.
  const serializedInput = serializeMatOSAlgorithmInput(
    input.surfaceId,
    input.decisionInput,
  )
  if (!serializedInput) {
    throw new Error(
      `Algorithm surface ${input.surfaceId} has no serializable input contract`,
    )
  }
  const payload = JSON.stringify({
    surfaceId: input.surfaceId,
    protocol: MATOS_ALGORITHM_DECISION_PROTOCOL,
    input: serializedInput,
  })
  if (payload.length > MATOS_ALGORITHM_SERIALIZED_INPUT_MAX_BYTES) {
    throw new Error(
      `Algorithm strategy input for ${input.surfaceId} exceeds the serialized payload limit`,
    )
  }
  const result = spawnSync(
    'python3',
    ['-I', '-S', '-c', SECCOMP_EXEC_WRAPPER, command.command, ...command.args],
    {
    cwd: input.asset.manifestDir,
    input: payload,
    encoding: 'utf8',
    timeout: executorTimeoutMs(input.asset),
    maxBuffer: MAX_EXEC_OUTPUT_BYTES,
    // Minimal env: strategy executables get no ambient secrets.
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: '/nonexistent',
      TMPDIR: '/nonexistent',
      PYTHONNOUSERSITE: '1',
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    },
    },
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `Algorithm strategy ${input.asset.canonicalKey} exited with status ${result.status}`,
    )
  }
  const stdout = (result.stdout ?? '').trim()
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || parsed.decision === undefined) {
    throw new Error(
      `Algorithm strategy ${input.asset.canonicalKey} output has no decision field`,
    )
  }
  return parsed.decision
}

// A strategy *candidate* is any enabled tool asset that declares an
// algorithm surface. Candidates with the wrong protocol or an unknown
// surface are reported as skipped (instead of silently ignored) so
// `matos algo` diagnostics can explain why a strategy is not selectable.
function isAlgorithmStrategyCandidate(asset: MatOSAsset): boolean {
  return (
    asset.type === 'tool' &&
    asset.lifecycle.status === 'enabled' &&
    Boolean(optionalString(asset.metadata.algorithmSurface))
  )
}

/**
 * Static validation for algorithm strategy tool assets, used by
 * `validateMatOSAssets`. Because asset validation is the deterministic gate
 * shared by `matos assets validate`, self-evolution direct-editor usability
 * validation, and Gitea acceptance, a broken strategy edit (wrong protocol,
 * unknown surface, non-runnable or escaping entry) is rejected before it can
 * become an accepted runtime asset. Returns issue messages; empty means valid.
 * Uses the static serialization contract table so validation does not depend
 * on which surfaces happen to be registered in this process.
 */
export function matOSAlgorithmStrategyAssetIssues(asset: MatOSAsset): string[] {
  if (
    asset.type !== 'tool' ||
    !optionalString(asset.metadata.algorithmSurface)
  ) {
    return []
  }
  const issues: string[] = []
  const surfaceId = optionalString(asset.metadata.algorithmSurface) as string
  if (!matOSAlgorithmSurfaceIsSerializable(surfaceId)) {
    issues.push(
      `Unknown algorithm surface "${surfaceId}" (no serialization contract)`,
    )
  }
  const protocol = optionalString(asset.metadata.decisionProtocol)
  if (protocol !== MATOS_ALGORITHM_DECISION_PROTOCOL) {
    issues.push(
      `Algorithm strategy requires metadata.decisionProtocol "${MATOS_ALGORITHM_DECISION_PROTOCOL}", found "${protocol ?? '<missing>'}"`,
    )
  }
  if (!executorCommand(asset)) {
    issues.push(
      'Algorithm strategy entry must be a Node file (.js/.mjs/.cjs/.ts) inside the asset directory; Python/shell must use the native Tool/MCP/container permission path',
    )
  }
  return issues
}

/**
 * Builds registry-local providers without mutating the process-global surface
 * registry. Runtime composition uses this scope so two registries containing
 * the same type:id@version cannot reuse each other's executable closure.
 */
export function buildMatOSAssetExecProviderScope(
  registry: MatOSAssetRegistry,
  options: { env?: Record<string, string | undefined> } = {},
): MatOSAssetExecProviderScope {
  const providersBySurface = new Map<
    string,
    Map<string, MatOSAlgorithmProvider<unknown, unknown>>
  >()
  if (assetExecDisabled(options.env)) {
    const report = { registered: [], skipped: [] }
    return {
      report,
      providerOverridesBySurface: providersBySurface,
      providersFor: surfaceId => providersBySurface.get(surfaceId),
    }
  }
  const registered: MatOSAssetExecProviderRegistration[] = []
  const skipped: MatOSAssetExecProviderSkip[] = []
  for (const asset of registry.assets) {
    if (!isAlgorithmStrategyCandidate(asset)) {
      continue
    }
    if (
      optionalString(asset.metadata.decisionProtocol) !==
      MATOS_ALGORITHM_DECISION_PROTOCOL
    ) {
      skipped.push({
        assetKey: asset.canonicalKey,
        reason: 'unsupported-protocol',
      })
      continue
    }
    const surfaceId = optionalString(asset.metadata.algorithmSurface) as string
    const surface = getMatOSAlgorithmSurface(surfaceId)
    if (!surface || !matOSAlgorithmSurfaceIsSerializable(surfaceId)) {
      skipped.push({ assetKey: asset.canonicalKey, reason: 'unknown-surface' })
      continue
    }
    if (!executorCommand(asset)) {
      skipped.push({
        assetKey: asset.canonicalKey,
        reason: 'no-runnable-entry',
      })
      continue
    }
    const providerId = matOSAssetExecProviderId(asset)
    const identity = assetProviderIdentity(asset)
    if (!identity) {
      skipped.push({
        assetKey: asset.canonicalKey,
        reason: 'no-runnable-entry',
      })
      continue
    }
    registered.push({ surfaceId, providerId, assetKey: asset.canonicalKey })
    let surfaceProviders = providersBySurface.get(surfaceId)
    if (!surfaceProviders) {
      surfaceProviders = new Map()
      providersBySurface.set(surfaceId, surfaceProviders)
    }
    surfaceProviders.set(providerId.toLowerCase(), {
      id: providerId,
      description:
        asset.description ??
        `Executable algorithm strategy from ${asset.canonicalKey}`,
      ...identity,
      decide: decisionInput => execDecision({ asset, surfaceId, decisionInput }),
    })
  }
  const report = { registered, skipped }
  return {
    report,
    providerOverridesBySurface: providersBySurface,
    providersFor: surfaceId => providersBySurface.get(surfaceId),
  }
}

/**
 * Discovers strategy assets and exposes them through the process-global
 * provider registry for one-shot CLI and benchmark commands. Each call
 * replaces providers with fresh asset objects and unregisters asset providers
 * that disappeared, so same-version edits and removals take effect without a
 * process restart. Long-lived role composition uses the scoped API above.
 */
export function registerMatOSAssetExecProviders(
  registry: MatOSAssetRegistry,
  options: { env?: Record<string, string | undefined> } = {},
): MatOSAssetExecProviderReport {
  const scope = buildMatOSAssetExecProviderScope(registry, options)
  const currentKeys = new Set<string>()
  for (const [surfaceId, providers] of scope.providerOverridesBySurface) {
    const surface = getMatOSAlgorithmSurface(surfaceId)
    if (!surface) {
      continue
    }
    for (const provider of providers.values()) {
      const key = `${surfaceId}\u0000${provider.id.toLowerCase()}`
      try {
        // Asset refresh is an explicit registry transition. Remove only the
        // provider previously installed by this adapter before registering the
        // freshly identity-bound closure; arbitrary duplicate ids remain
        // rejected by the surface registry.
        if (registeredProviderKeys.has(key)) {
          surface.unregister(provider.id)
        }
        surface.register(provider)
        currentKeys.add(key)
      } catch {
        // Registration failures must never break asset loading or composition.
      }
    }
  }
  for (const key of registeredProviderKeys) {
    if (currentKeys.has(key)) {
      continue
    }
    const separator = key.indexOf('\u0000')
    const surfaceId = key.slice(0, separator)
    const providerId = key.slice(separator + 1)
    getMatOSAlgorithmSurface(surfaceId)?.unregister(providerId)
  }
  registeredProviderKeys.clear()
  for (const key of currentKeys) {
    registeredProviderKeys.add(key)
  }
  return scope.report
}

export function resetMatOSAssetExecAlgorithmProviderState(): void {
  for (const key of registeredProviderKeys) {
    const separator = key.indexOf('\u0000')
    const surfaceId = key.slice(0, separator)
    const providerId = key.slice(separator + 1)
    getMatOSAlgorithmSurface(surfaceId)?.unregister(providerId)
  }
  registeredProviderKeys.clear()
}
