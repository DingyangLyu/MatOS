import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { redactTraceValue, traceContextFromEnv } from '../sessions/traceContext.js'
import type {
  MatOSAlgorithmComponentPin,
  MatOSAlgorithmSurfacePin,
} from '../workflows/executionContext.js'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import { listMatOSAlgorithmSurfaces } from './surface.js'
import {
  matOSWorkflowControllerBindingDigest,
  resolveMatOSWorkflowControllerBinding,
  type MatOSWorkflowControllerBinding,
} from './controllerBinding.js'
import { resolveMatOSAlgorithmComponentPins } from './componentTool.js'

export const MATOS_ALGORITHM_RUN_MANIFEST_MAX_BYTES = 1024 * 1024
const MATOS_ALGORITHM_RUN_MANIFEST_REQUIREMENT_MAX_BYTES = 4096

export type MatOSAlgorithmRunManifestSurface = {
  surfaceId: string
  providerId: string
  source: 'explicit' | 'env' | 'role' | 'default'
  requested?: string
  baseline: boolean
  version: string
  assetRef?: string
  configDigest: string
  implementationDigest: string
  shadow?: {
    providerId: string
    source: 'explicit' | 'env' | 'role'
    version: string
    assetRef?: string
    configDigest: string
    implementationDigest: string
  }
}

export type MatOSAlgorithmRunManifestController =
  Omit<MatOSWorkflowControllerBinding, 'config'> & {
    bindingDigest: string
    assetRefs?: string[]
  }

export type MatOSAlgorithmRunManifestComponent = Omit<
  MatOSAlgorithmComponentPin,
  'manifestDigest'
>

export type MatOSAlgorithmRunManifest = {
  schemaVersion: 1
  generatedAt: string
  /** Alias matching the public V2 manifest contract. */
  createdAt?: string
  runId: string
  workflowRef: string
  baselineGuaranteed: true
  surfaces: MatOSAlgorithmRunManifestSurface[]
  /** Ordinary backend/tool assets authorized to produce domain decisions. */
  components: MatOSAlgorithmRunManifestComponent[]
  /** Compatibility view consumed by the current workflow controller bridge. */
  controller?: MatOSAlgorithmRunManifestController
  /** Generic V2 controller list; empty for a static workflow. */
  controllers?: MatOSAlgorithmRunManifestController[]
  modelRefs?: string[]
  runtimeRefs?: string[]
  benchmarkObjectiveRef?: string
  configurationDigest: string
  manifestDigest: string
  codeRevision?: string
  runtimeRef?: string
  scopeRef?: string
  traceId?: string
}

export class MatOSAlgorithmRunManifestError extends Error {
  readonly runDir: string

  constructor(runDir: string, message: string, options?: { cause?: unknown }) {
    super(`MatOS algorithm run manifest error: ${message}`, options)
    this.name = 'MatOSAlgorithmRunManifestError'
    this.runDir = runDir
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function digest(value: unknown): string {
  // JSON round-tripping removes shared object identity before redaction. The
  // redactor intentionally treats repeated object identities as circular;
  // without this normalization an in-memory body that reuses the controller
  // object would hash differently from the same body read back from JSON.
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown
  return createHash('sha256')
    .update(JSON.stringify(stableValue(redactTraceValue(jsonValue))))
    .digest('hex')
}

function boundedReference(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > maxLength ||
    normalized.includes('\0') ||
    isAbsolute(normalized)
  ) {
    return undefined
  }
  return normalized
}

function sortedUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
}

function workflowModelRefs(
  definition: MatOSWorkflowDefinition | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const refs: Array<string | undefined> = [
    boundedReference(env.MATOS_DSH_MODEL),
  ]
  for (const node of definition?.nodes ?? []) {
    refs.push(boundedReference(node.model))
    const args = Array.isArray(node.passthroughArgs)
      ? node.passthroughArgs.filter((item): item is string => typeof item === 'string')
      : []
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]
      if (argument === '--model') refs.push(boundedReference(args[index + 1]))
      if (argument.startsWith('--model=')) {
        refs.push(boundedReference(argument.slice('--model='.length)))
      }
    }
  }
  return sortedUnique(refs)
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === code,
  )
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isOptionalBoundedReference(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      !value.includes('\0'))
  )
}

function validManifestShape(value: unknown): value is MatOSAlgorithmRunManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<MatOSAlgorithmRunManifest>
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.runId !== 'string' ||
    !manifest.runId ||
    typeof manifest.workflowRef !== 'string' ||
    !manifest.workflowRef ||
    manifest.baselineGuaranteed !== true ||
    !Array.isArray(manifest.surfaces) ||
    !Array.isArray(manifest.components) ||
    !isDigest(manifest.configurationDigest) ||
    !isDigest(manifest.manifestDigest)
  ) {
    return false
  }
  const componentNodes = new Set<string>()
  for (const component of manifest.components) {
    if (
      !component ||
      typeof component !== 'object' ||
      typeof component.nodeId !== 'string' ||
      !component.nodeId ||
      componentNodes.has(component.nodeId) ||
      component.protocol !== 'json-v1' ||
      !['policy', 'controller', 'optimizer'].includes(component.plane) ||
      typeof component.providerId !== 'string' ||
      !component.providerId ||
      typeof component.providerVersion !== 'string' ||
      !component.providerVersion ||
      typeof component.assetRef !== 'string' ||
      !component.assetRef ||
      !isDigest(component.configDigest) ||
      !isDigest(component.assetManifestDigest) ||
      !isDigest(component.entryDigest) ||
      !isDigest(component.implementationDigest) ||
      !Array.isArray(component.runtimeRefs) ||
      component.runtimeRefs.some(ref => !isOptionalBoundedReference(ref))
    ) {
      return false
    }
    componentNodes.add(component.nodeId)
  }
  const seen = new Set<string>()
  for (const surface of manifest.surfaces) {
    if (
      !surface ||
      typeof surface !== 'object' ||
      typeof surface.surfaceId !== 'string' ||
      !surface.surfaceId ||
      typeof surface.providerId !== 'string' ||
      !surface.providerId ||
      !['explicit', 'env', 'role', 'default'].includes(surface.source) ||
      typeof surface.baseline !== 'boolean' ||
      seen.has(surface.surfaceId) ||
      typeof surface.version !== 'string' ||
      !surface.version.trim() ||
      !isDigest(surface.configDigest) ||
      !isDigest(surface.implementationDigest) ||
      (surface.shadow !== undefined &&
        (!surface.shadow ||
          typeof surface.shadow.providerId !== 'string' ||
          !surface.shadow.providerId ||
          !['explicit', 'env', 'role'].includes(surface.shadow.source) ||
          typeof surface.shadow.version !== 'string' ||
          !surface.shadow.version.trim() ||
          !isDigest(surface.shadow.configDigest) ||
          !isDigest(surface.shadow.implementationDigest)))
    ) {
      return false
    }
    seen.add(surface.surfaceId)
  }
  const controllers = [
    ...(manifest.controller ? [manifest.controller] : []),
    ...(manifest.controllers ?? []),
  ]
  for (const controller of controllers) {
    if (
      !controller ||
      typeof controller !== 'object' ||
      typeof controller.providerId !== 'string' ||
      !controller.providerId ||
      typeof controller.providerVersion !== 'string' ||
      !controller.providerVersion ||
      !Number.isSafeInteger(controller.stateVersion) ||
      controller.stateVersion < 1 ||
      !isDigest(controller.configDigest) ||
      !isDigest(controller.implementationDigest) ||
      !isDigest(controller.bindingDigest) ||
      !isOptionalBoundedReference(controller.assetRef) ||
      !isOptionalBoundedReference(controller.runtimeRef)
    ) {
      return false
    }
  }
  return true
}

export function matOSAlgorithmRunManifestDigest(
  manifest: Omit<MatOSAlgorithmRunManifest, 'manifestDigest'>,
): string {
  return digest(manifest)
}

export function matOSAlgorithmRunManifestPath(runDir: string): string {
  return join(runDir, 'algorithm-manifest.json')
}

export function matOSAlgorithmRunManifestRequirementPath(runDir: string): string {
  return join(runDir, 'algorithm-manifest.required')
}

export function matOSAlgorithmSurfacePinsFromManifest(
  manifest: MatOSAlgorithmRunManifest,
): ReadonlyMap<string, MatOSAlgorithmSurfacePin> {
  return new Map(
    manifest.surfaces.map(surface => [
      surface.surfaceId,
      {
        surfaceId: surface.surfaceId,
        providerId: surface.providerId,
        source: surface.source,
        ...(surface.requested ? { requested: surface.requested } : {}),
        version: surface.version,
        ...(surface.assetRef ? { assetRef: surface.assetRef } : {}),
        configDigest: surface.configDigest,
        implementationDigest: surface.implementationDigest,
        ...(surface.shadow ? { shadow: { ...surface.shadow } } : {}),
        manifestDigest: manifest.manifestDigest,
      },
    ]),
  )
}

export function matOSAlgorithmComponentPinsFromManifest(
  manifest: MatOSAlgorithmRunManifest,
): ReadonlyMap<string, MatOSAlgorithmComponentPin> {
  return new Map(
    manifest.components.map(component => [
      component.nodeId,
      {
        ...component,
        runtimeRefs: [...component.runtimeRefs],
        manifestDigest: manifest.manifestDigest,
      },
    ]),
  )
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // The manifest file itself was fsynced; directory fsync is best effort on
    // filesystems that reject opening directories through Node.
  }
}

type MatOSAlgorithmRunManifestRequirement = {
  schemaVersion: 1
  runId: string
  workflowRef: string
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

async function readManifestRequirement(
  runDir: string,
): Promise<MatOSAlgorithmRunManifestRequirement | undefined> {
  const path = matOSAlgorithmRunManifestRequirementPath(runDir)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > MATOS_ALGORITHM_RUN_MANIFEST_REQUIREMENT_MAX_BYTES
    ) {
      return undefined
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== before.size) return undefined
    const content = await handle.readFile('utf8')
    if (Buffer.byteLength(content) !== opened.size) return undefined
    const parsed = JSON.parse(content) as Partial<MatOSAlgorithmRunManifestRequirement>
    return parsed.schemaVersion === 1 &&
      typeof parsed.runId === 'string' &&
      parsed.runId.length > 0 &&
      typeof parsed.workflowRef === 'string' &&
      parsed.workflowRef.length > 0
      ? (parsed as MatOSAlgorithmRunManifestRequirement)
      : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function requireManifestForRun(input: {
  runDir: string
  runId: string
  workflowRef: string
}): Promise<void> {
  const existing = await readManifestRequirement(input.runDir)
  if (existing) {
    if (
      existing.runId === input.runId &&
      existing.workflowRef === input.workflowRef
    ) {
      return
    }
    throw new MatOSAlgorithmRunManifestError(
      input.runDir,
      'the immutable requirement belongs to a different workflow run',
    )
  }
  const finalPath = matOSAlgorithmRunManifestRequirementPath(input.runDir)
  if (await pathEntryExists(finalPath)) {
    throw new MatOSAlgorithmRunManifestError(
      input.runDir,
      'the immutable requirement is corrupt or unsafe',
    )
  }
  const temporaryPath = join(
    input.runDir,
    `.algorithm-manifest-required.${process.pid}.${randomUUID()}.tmp`,
  )
  const serialized = `${JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    workflowRef: input.workflowRef,
  } satisfies MatOSAlgorithmRunManifestRequirement)}\n`
  let temporary: Awaited<ReturnType<typeof open>> | undefined
  try {
    temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    await temporary.writeFile(serialized, 'utf8')
    await temporary.sync()
    await temporary.close()
    temporary = undefined
    await link(temporaryPath, finalPath)
    await syncDirectory(input.runDir)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      const concurrent = await readManifestRequirement(input.runDir)
      if (
        concurrent?.runId === input.runId &&
        concurrent.workflowRef === input.workflowRef
      ) {
        return
      }
    }
    throw new MatOSAlgorithmRunManifestError(
      input.runDir,
      'failed to publish the immutable requirement',
      { cause: error },
    )
  } finally {
    await temporary?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Creates an immutable, content-addressed run manifest. A hard-link publish
 * makes the final pathname appear atomically and refuses to replace an
 * existing file (including a symlink), so concurrent writers cannot hot-swap
 * the provider set of an already-started run.
 */
export async function writeMatOSAlgorithmRunManifest(input: {
  runDir: string
  runId: string
  workflowRef: string
  workflowAlgorithms?: unknown
  workflowDefinition?: MatOSWorkflowDefinition
  /** Project whose current native asset registry resolves component refs. */
  projectCwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<MatOSAlgorithmRunManifest> {
  try {
    await requireManifestForRun(input)
    const existing = await readMatOSAlgorithmRunManifest(input.runDir)
    if (existing) {
      if (
        existing.runId === input.runId &&
        existing.workflowRef === input.workflowRef
      ) {
        return existing
      }
      throw new MatOSAlgorithmRunManifestError(
        input.runDir,
        'the immutable manifest belongs to a different workflow run',
      )
    }
    if (await pathEntryExists(matOSAlgorithmRunManifestPath(input.runDir))) {
      throw new MatOSAlgorithmRunManifestError(
        input.runDir,
        'the immutable manifest is corrupt or unsafe',
      )
    }

    const env = input.env ?? process.env
    const trace = traceContextFromEnv(env)
    const surfaces = listMatOSAlgorithmSurfaces().map(surface => {
      const resolution = surface.resolve({
        env,
        roleAlgorithms: input.workflowAlgorithms,
        ignoreExecutionPin: true,
      })
      const shadowResolution = surface.resolveShadow({
        env,
        roleAlgorithms: input.workflowAlgorithms,
        ignoreExecutionPin: true,
      })
      const provider = resolution.provider
      return {
        surfaceId: surface.surfaceId,
        providerId: provider.id,
        source: resolution.source as 'explicit' | 'env' | 'role' | 'default',
        ...(resolution.requested ? { requested: resolution.requested } : {}),
        baseline: provider.id === surface.baselineProviderId,
        version: provider.version,
        ...(provider.assetRef ? { assetRef: provider.assetRef } : {}),
        configDigest: provider.configDigest,
        implementationDigest: provider.implementationDigest,
        ...(shadowResolution
          ? {
              shadow: {
                providerId: shadowResolution.provider.id,
                source: shadowResolution.source as 'explicit' | 'env' | 'role',
                version: shadowResolution.provider.version,
                ...(shadowResolution.provider.assetRef
                  ? { assetRef: shadowResolution.provider.assetRef }
                  : {}),
                configDigest: shadowResolution.provider.configDigest,
                implementationDigest:
                  shadowResolution.provider.implementationDigest,
              },
            }
          : {}),
      } satisfies MatOSAlgorithmRunManifestSurface
    })
    const binding = input.workflowDefinition
      ? resolveMatOSWorkflowControllerBinding({
          definition: input.workflowDefinition,
          workflowRef: input.workflowRef,
        })
      : undefined
    const declaresComponents = input.workflowDefinition?.nodes.some(
      node => node.algorithmDecision !== undefined,
    )
    if (declaresComponents && !input.projectCwd) {
      throw new Error(
        'algorithm component manifest creation requires the current project cwd',
      )
    }
    const components = input.workflowDefinition
      ? await resolveMatOSAlgorithmComponentPins({
          cwd: input.projectCwd ?? input.runDir,
          definition: input.workflowDefinition,
        })
      : []
    const controller: MatOSAlgorithmRunManifestController | undefined = binding
      ? {
          mode: binding.mode,
          providerId: binding.providerId,
          providerVersion: binding.providerVersion,
          stateVersion: binding.stateVersion,
          implementationDigest: binding.implementationDigest,
          ...(binding.assetRef ? { assetRef: binding.assetRef } : {}),
          ...(binding.runtimeRef ? { runtimeRef: binding.runtimeRef } : {}),
          configDigest: binding.configDigest,
          objectiveRef: binding.objectiveRef,
          seed: binding.seed,
          bounds: binding.bounds,
          budgetLimits: binding.budgetLimits,
          onFailure: binding.onFailure,
          bindingDigest: matOSWorkflowControllerBindingDigest(binding),
          assetRefs: binding.assetRef ? [binding.assetRef] : [],
        }
      : undefined
    const modelRefs = workflowModelRefs(input.workflowDefinition, env)
    const runtimeRefs = sortedUnique([
      boundedReference(trace?.runtimeRef),
      ...surfaces.map(surface => boundedReference(surface.assetRef)),
      ...surfaces.map(surface => boundedReference(surface.shadow?.assetRef)),
      boundedReference(controller?.runtimeRef),
      boundedReference(controller?.assetRef),
      ...components.flatMap(component =>
        component.runtimeRefs.map(ref => boundedReference(ref)),
      ),
    ])
    const timestamp = new Date().toISOString()
    const body: Omit<MatOSAlgorithmRunManifest, 'manifestDigest'> = {
      schemaVersion: 1,
      generatedAt: timestamp,
      createdAt: timestamp,
      runId: input.runId,
      workflowRef: input.workflowRef,
      baselineGuaranteed: true,
      surfaces,
      components,
      ...(controller ? { controller } : {}),
      controllers: controller ? [controller] : [],
      modelRefs,
      runtimeRefs,
      ...(controller?.objectiveRef
        ? { benchmarkObjectiveRef: controller.objectiveRef }
        : {}),
      configurationDigest: digest({
        workflowAlgorithms: input.workflowAlgorithms,
        surfaces,
        components,
        controller,
        modelRefs,
        runtimeRefs,
      }),
      ...(boundedReference(
        env.MATOS_CODE_REVISION ?? env.GIT_COMMIT ?? env.CI_COMMIT_SHA,
      )
        ? {
            codeRevision: boundedReference(
              env.MATOS_CODE_REVISION ?? env.GIT_COMMIT ?? env.CI_COMMIT_SHA,
            ),
          }
        : {}),
      ...(boundedReference(trace?.runtimeRef)
        ? { runtimeRef: boundedReference(trace?.runtimeRef) }
        : {}),
      ...(boundedReference(trace?.scopeRef)
        ? { scopeRef: boundedReference(trace?.scopeRef) }
        : {}),
      ...(boundedReference(trace?.traceId)
        ? { traceId: boundedReference(trace?.traceId) }
        : {}),
    }
    const manifest: MatOSAlgorithmRunManifest = {
      ...body,
      manifestDigest: matOSAlgorithmRunManifestDigest(body),
    }
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(serialized) > MATOS_ALGORITHM_RUN_MANIFEST_MAX_BYTES) {
      throw new MatOSAlgorithmRunManifestError(
        input.runDir,
        'the generated manifest exceeds the size limit',
      )
    }

    const finalPath = matOSAlgorithmRunManifestPath(input.runDir)
    const temporaryPath = join(
      input.runDir,
      `.algorithm-manifest.${process.pid}.${randomUUID()}.tmp`,
    )
    let temporary: Awaited<ReturnType<typeof open>> | undefined
    try {
      temporary = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      await temporary.writeFile(serialized, 'utf8')
      await temporary.sync()
      await temporary.close()
      temporary = undefined
      await link(temporaryPath, finalPath)
      await syncDirectory(input.runDir)
      return manifest
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        const concurrent = await readMatOSAlgorithmRunManifest(input.runDir)
        if (
          concurrent?.runId === input.runId &&
          concurrent.workflowRef === input.workflowRef
        ) {
          return concurrent
        }
      }
      throw new MatOSAlgorithmRunManifestError(
        input.runDir,
        'failed to publish the immutable manifest',
        { cause: error },
      )
    } finally {
      await temporary?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof MatOSAlgorithmRunManifestError) throw error
    throw new MatOSAlgorithmRunManifestError(
      input.runDir,
      'manifest creation failed closed',
      { cause: error },
    )
  }
}

export async function readMatOSAlgorithmRunManifest(
  runDir: string,
): Promise<MatOSAlgorithmRunManifest | undefined> {
  const path = matOSAlgorithmRunManifestPath(runDir)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > MATOS_ALGORITHM_RUN_MANIFEST_MAX_BYTES
    ) {
      return undefined
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== before.size) return undefined
    const content = await handle.readFile('utf8')
    if (Buffer.byteLength(content) !== opened.size) return undefined
    const parsed = JSON.parse(content) as unknown
    if (!validManifestShape(parsed)) return undefined
    const { manifestDigest, ...body } = parsed
    return manifestDigest === matOSAlgorithmRunManifestDigest(body)
      ? parsed
      : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function requireMatOSAlgorithmRunManifest(
  runDir: string,
  expected: { runId?: string; workflowRef?: string } = {},
): Promise<MatOSAlgorithmRunManifest> {
  const manifest = await readMatOSAlgorithmRunManifestForExecution(
    runDir,
    expected,
  )
  if (!manifest) {
    throw new MatOSAlgorithmRunManifestError(
      runDir,
      'the required manifest is missing, corrupt, or digest-mismatched',
    )
  }
  return manifest
}

/**
 * Low-level workflow runtime remains usable without the product integration.
 * Once a V2 writer has marked a run as manifest-required, however, execution
 * may never silently downgrade to an unpinned legacy path.
 */
export async function readMatOSAlgorithmRunManifestForExecution(
  runDir: string,
  expected: { runId?: string; workflowRef?: string } = {},
): Promise<MatOSAlgorithmRunManifest | undefined> {
  const requirementPath = matOSAlgorithmRunManifestRequirementPath(runDir)
  const requirementExists = await pathEntryExists(requirementPath)
  const requirement = requirementExists
    ? await readManifestRequirement(runDir)
    : undefined
  if (requirementExists && !requirement) {
    throw new MatOSAlgorithmRunManifestError(
      runDir,
      'the immutable manifest requirement is corrupt or unsafe',
    )
  }
  const manifest = await readMatOSAlgorithmRunManifest(runDir)
  if (manifest) {
    if (
      requirement &&
      (requirement.runId !== manifest.runId ||
        requirement.workflowRef !== manifest.workflowRef)
    ) {
      throw new MatOSAlgorithmRunManifestError(
        runDir,
        'the immutable requirement does not match the execution manifest',
      )
    }
    if (expected.runId && manifest.runId !== expected.runId) {
      throw new MatOSAlgorithmRunManifestError(
        runDir,
        'the execution manifest run id does not match',
      )
    }
    if (expected.workflowRef && manifest.workflowRef !== expected.workflowRef) {
      throw new MatOSAlgorithmRunManifestError(
        runDir,
        'the execution manifest workflow ref does not match',
      )
    }
    return manifest
  }
  if (
    requirementExists ||
    (await pathEntryExists(matOSAlgorithmRunManifestPath(runDir)))
  ) {
    throw new MatOSAlgorithmRunManifestError(
      runDir,
      'manifest-required execution cannot continue without a valid manifest',
    )
  }
  return undefined
}
