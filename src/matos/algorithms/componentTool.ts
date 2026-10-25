import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import type { MatOSAlgorithmComponentPin } from '../workflows/executionContext.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from '../workflows/types.js'

export const MATOS_ALGORITHM_DECISION_PROTOCOL = 'json-v1' as const
export const MATOS_ALGORITHM_COMPONENT_FILE_MAX_BYTES = 16 * 1024 * 1024
export const MATOS_ALGORITHM_DECISION_RECEIPT_MAX_BYTES = 256 * 1024

export type MatOSAlgorithmDecisionProtocol =
  typeof MATOS_ALGORITHM_DECISION_PROTOCOL
export type MatOSAlgorithmComponentPlane =
  | 'policy'
  | 'controller'
  | 'optimizer'

export type MatOSAlgorithmComponentDeclaration = {
  protocol: MatOSAlgorithmDecisionProtocol
  componentRef: string
  plane: MatOSAlgorithmComponentPlane
  providerId: string
  providerVersion: string
  config: Record<string, unknown>
}

export type MatOSAlgorithmDecisionReceipt = {
  schemaVersion: 1
  protocol: MatOSAlgorithmDecisionProtocol
  /** Provider-local provenance only; the runtime-derived decisionId remains authoritative. */
  providerDecisionId: string
  decisionId: string
  runId: string
  nodeId: string
  attempt: number
  plane: MatOSAlgorithmComponentPlane
  providerId: string
  providerVersion: string
  assetRef: string
  configDigest: string
  inputDigest: string
  implementationDigest: string
  manifestDigest: string
  evaluationRefs: string[]
  validationRefs: string[]
  metricRefs: string[]
  receiptDigest: string
}

type AlgorithmComponentMetadata = {
  protocol: MatOSAlgorithmDecisionProtocol
  plane: MatOSAlgorithmComponentPlane
  providerId: string
  providerVersion: string
}

const PLANES = new Set<MatOSAlgorithmComponentPlane>([
  'policy',
  'controller',
  'optimizer',
])
const RECEIPT_FIELDS = new Set([
  'schemaVersion',
  'protocol',
  'decisionId',
  'runId',
  'nodeId',
  'attempt',
  'plane',
  'providerId',
  'providerVersion',
  'assetRef',
  'configDigest',
  'implementationDigest',
  'manifestDigest',
  'evaluationRefs',
  'validationRefs',
  'metricRefs',
])
const SECRET_LIKE_KEY =
  /(?:^|_)(?:api_?key|token|secret|password|passwd|credential|authorization|auth|cookie|private_?key)(?:$|_)/iu
const CREDENTIAL_LIKE_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/u

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedIdentity(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized &&
    normalized.length <= maxLength &&
    !/[\0\r\n]/u.test(normalized)
    ? normalized
    : undefined
}

function safeReference(value: unknown): string | undefined {
  const normalized = boundedIdentity(value, 1024)
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /^[a-z]:[\\/]|^\\\\/iu.test(normalized) ||
    normalized.split(/[\\/]/u).includes('..')
  ) {
    return undefined
  }
  return normalized
}

function digestBuffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
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

export function matOSAlgorithmComponentConfigDigest(value: unknown): string {
  return digestBuffer(JSON.stringify(stableValue(value)))
}

function validJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'string' || value.length <= 64 * 1024
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.length <= 1024 && value.every(item => validJsonValue(item, depth + 1))
  }
  const record = recordValue(value)
  if (!record || Object.keys(record).length > 1024) return false
  return Object.entries(record).every(
    ([key, item]) =>
      key.length > 0 && key.length <= 256 && validJsonValue(item, depth + 1),
  )
}

function normalizedKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .toLowerCase()
}

function unsafeComponentValueReason(
  value: unknown,
  path: string,
  depth = 0,
  seen = new WeakSet<object>(),
): string | undefined {
  if (depth > 12) return `${path} exceeds the maximum nesting depth`
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return `${path} contains an oversized string`
    if (CREDENTIAL_LIKE_VALUE.test(value)) {
      return `${path} contains a credential-like value`
    }
    if (isAbsolute(value) || /^[a-z]:[\\/]|^\\\\/iu.test(value)) {
      return `${path} contains a host-absolute path; use a scoped asset/data ref`
    }
    return undefined
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return undefined
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) return `${path} contains too many values`
    if (seen.has(value)) return `${path} contains a cycle`
    seen.add(value)
    for (const [index, item] of value.entries()) {
      const issue = unsafeComponentValueReason(
        item,
        `${path}[${index}]`,
        depth + 1,
        seen,
      )
      if (issue) return issue
    }
    seen.delete(value)
    return undefined
  }
  const record = recordValue(value)
  if (!record || Object.getPrototypeOf(record) !== Object.prototype) {
    return `${path} must contain plain JSON values only`
  }
  if (Object.keys(record).length > 1024) return `${path} has too many fields`
  if (seen.has(record)) return `${path} contains a cycle`
  seen.add(record)
  for (const [key, item] of Object.entries(record)) {
    if (SECRET_LIKE_KEY.test(normalizedKey(key))) {
      return `${path}.${key} is secret-like and is not allowed`
    }
    if (item === undefined) return `${path}.${key} must not be undefined`
    const issue = unsafeComponentValueReason(
      item,
      `${path}.${key}`,
      depth + 1,
      seen,
    )
    if (issue) return issue
  }
  seen.delete(record)
  return undefined
}

export function assertSafeMatOSAlgorithmComponentInput(
  value: unknown,
  label = 'algorithm component input',
): void {
  const issue = unsafeComponentValueReason(value, label)
  if (issue) throw new Error(issue)
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${label} is not serializable JSON`, { cause: error })
  }
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw new Error(`${label} exceeds the 256 KiB input limit`)
  }
}

function algorithmComponentMetadata(
  asset: MatOSAsset,
): AlgorithmComponentMetadata | undefined {
  const raw = recordValue(asset.metadata.algorithmDecision)
  if (!raw) return undefined
  const protocol = boundedIdentity(raw.protocol)
  const plane = boundedIdentity(raw.plane)
  const provider = recordValue(raw.provider)
  const providerId = boundedIdentity(raw.providerId ?? provider?.id)
  const providerVersion = boundedIdentity(
    raw.providerVersion ?? provider?.version,
  )
  if (
    protocol !== MATOS_ALGORITHM_DECISION_PROTOCOL ||
    !plane ||
    !PLANES.has(plane as MatOSAlgorithmComponentPlane) ||
    !providerId ||
    !providerVersion
  ) {
    return undefined
  }
  return {
    protocol,
    plane: plane as MatOSAlgorithmComponentPlane,
    providerId,
    providerVersion,
  }
}

export function matOSAlgorithmComponentAssetIssues(asset: MatOSAsset): string[] {
  if (asset.metadata.algorithmDecision === undefined) return []
  if (asset.type !== 'tool') {
    return ['metadata.algorithmDecision is supported only on tool assets']
  }
  const metadata = algorithmComponentMetadata(asset)
  if (!metadata) {
    return [
      'metadata.algorithmDecision must declare protocol=json-v1, plane=policy|controller|optimizer, providerId, and providerVersion',
    ]
  }
  if (!asset.version || metadata.providerVersion !== asset.version) {
    return [
      'metadata.algorithmDecision.providerVersion must equal the tool asset version',
    ]
  }
  if (!asset.entryAbsolutePath) {
    return ['algorithm-decision tool asset must declare an entry file']
  }
  const permissions = recordValue(asset.permissions)
  const executor = recordValue(asset.metadata.executor)
  const issues: string[] = []
  if (
    asset.metadata.isReadOnly !== true ||
    asset.metadata.isDestructive !== false
  ) {
    issues.push(
      'algorithm-decision tool must set metadata.isReadOnly=true and metadata.isDestructive=false',
    )
  }
  if (
    !permissions ||
    permissions.shell !== 'disabled' ||
    permissions.network !== 'disabled' ||
    !['read-only', 'disabled', 'none'].includes(String(permissions.workspace)) ||
    !Array.isArray(permissions.secrets) ||
    permissions.secrets.length !== 0
  ) {
    issues.push(
      'algorithm-decision tool permissions must disable shell/network, limit workspace to read-only or less, and declare secrets=[]',
    )
  }
  if (!['python', 'python3', 'node', 'nodejs'].includes(String(executor?.runtime))) {
    issues.push(
      'algorithm-decision tool executor.runtime must use an enforceable python3 or node runtime',
    )
  }
  return issues
}

export function matOSAlgorithmComponentDeclarationForNode(
  node: MatOSWorkflowNode,
): MatOSAlgorithmComponentDeclaration | undefined {
  if (node.algorithmDecision === undefined) return undefined
  const raw = recordValue(node.algorithmDecision)
  if (!raw) {
    throw new Error(`Workflow node ${node.id} algorithmDecision must be an object`)
  }
  const protocol = boundedIdentity(raw.protocol)
  const componentRef = safeReference(raw.componentRef)
  const plane = boundedIdentity(raw.plane)
  const providerId = boundedIdentity(raw.providerId)
  const providerVersion = boundedIdentity(raw.providerVersion)
  const config = raw.config === undefined ? {} : recordValue(raw.config)
  if (
    protocol !== MATOS_ALGORITHM_DECISION_PROTOCOL ||
    !componentRef ||
    !plane ||
    !PLANES.has(plane as MatOSAlgorithmComponentPlane) ||
    !providerId ||
    !providerVersion ||
    !config ||
    !validJsonValue(config) ||
    Buffer.byteLength(JSON.stringify(config), 'utf8') > 64 * 1024
  ) {
    throw new Error(
      `Workflow node ${node.id} algorithmDecision must declare protocol=json-v1, componentRef, plane, providerId, providerVersion, and a bounded JSON config object`,
    )
  }
  assertSafeMatOSAlgorithmComponentInput(
    config,
    `Workflow node ${node.id} algorithmDecision.config`,
  )
  return {
    protocol,
    componentRef,
    plane: plane as MatOSAlgorithmComponentPlane,
    providerId,
    providerVersion,
    config,
  }
}

async function readPinnedFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maxBytes
  ) {
    throw new Error(`Algorithm component file is missing, unsafe, or oversized`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Algorithm component file changed while it was opened')
    }
    const content = await handle.readFile()
    const after = await lstat(path)
    if (
      Buffer.byteLength(content) !== opened.size ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('Algorithm component file changed while it was hashed')
    }
    return content
  } finally {
    await handle.close()
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

function componentRuntimeRefs(asset: MatOSAsset): string[] {
  const provenance = recordValue(asset.metadata.sourceProvenance)
  const runtimeRef = recordValue(provenance?.runtimeRef)
  const values: unknown[] = [
    provenance?.sourceId,
    provenance?.scopeRef,
    provenance?.currentCommit,
    runtimeRef?.ref,
    runtimeRef?.commit,
  ]
  if (runtimeRef?.mode === 'accepted-ref' && runtimeRef.ref) {
    values.push(`accepted-ref:${String(runtimeRef.ref)}`)
  } else if (runtimeRef?.mode === 'commit' && runtimeRef.commit) {
    values.push(`commit:${String(runtimeRef.commit)}`)
  }
  return [...new Set(values.map(safeReference).filter((item): item is string => Boolean(item)))].sort()
}

async function pinForAsset(input: {
  node: MatOSWorkflowNode
  declaration: MatOSAlgorithmComponentDeclaration
  asset: MatOSAsset
}): Promise<Omit<MatOSAlgorithmComponentPin, 'manifestDigest'>> {
  const { asset, declaration, node } = input
  const issues = matOSAlgorithmComponentAssetIssues(asset)
  if (issues.length > 0) throw new Error(issues.join('; '))
  const metadata = algorithmComponentMetadata(asset)!
  if (
    metadata.protocol !== declaration.protocol ||
    metadata.plane !== declaration.plane ||
    metadata.providerId !== declaration.providerId ||
    metadata.providerVersion !== declaration.providerVersion
  ) {
    throw new Error(
      `Workflow node ${node.id} algorithmDecision identity does not match ${asset.canonicalKey}`,
    )
  }
  if (!asset.entryAbsolutePath) {
    throw new Error(`Algorithm component ${asset.canonicalKey} has no entry file`)
  }
  const executor = recordValue(asset.metadata.executor)
  const executorEntry = boundedIdentity(executor?.entry, 4096)
  if (!executorEntry || isAbsolute(executorEntry)) {
    throw new Error(
      `Algorithm component ${asset.canonicalKey} has an unsafe executor entry`,
    )
  }
  const manifestRoot = await realpath(asset.manifestDir)
  const entryPath = await realpath(asset.entryAbsolutePath)
  const executedEntryPath = await realpath(resolve(asset.manifestDir, executorEntry))
  if (!isWithin(manifestRoot, entryPath)) {
    throw new Error(`Algorithm component entry escapes its asset directory`)
  }
  if (executedEntryPath !== entryPath) {
    throw new Error(
      `Algorithm component manifest entry and executor entry must resolve to the same file`,
    )
  }
  const [manifest, entry] = await Promise.all([
    readPinnedFile(asset.manifestPath, 1024 * 1024),
    readPinnedFile(asset.entryAbsolutePath, MATOS_ALGORITHM_COMPONENT_FILE_MAX_BYTES),
  ])
  const assetManifestDigest = digestBuffer(manifest)
  const entryDigest = digestBuffer(entry)
  return {
    nodeId: node.id,
    protocol: declaration.protocol,
    plane: declaration.plane,
    providerId: declaration.providerId,
    providerVersion: declaration.providerVersion,
    assetRef: asset.canonicalKey,
    configDigest: matOSAlgorithmComponentConfigDigest(declaration.config),
    assetManifestDigest,
    entryDigest,
    implementationDigest: digestBuffer(
      Buffer.concat([manifest, Buffer.from([0]), entry]),
    ),
    runtimeRefs: componentRuntimeRefs(asset),
  }
}

function explicitToolRef(node: MatOSWorkflowNode): string | undefined {
  return typeof node.tool === 'string' && node.tool.trim()
    ? node.tool.trim()
    : undefined
}

export async function resolveMatOSAlgorithmComponentPins(input: {
  cwd: string
  definition: MatOSWorkflowDefinition
}): Promise<Array<Omit<MatOSAlgorithmComponentPin, 'manifestDigest'>>> {
  const declared = input.definition.nodes
    .map(node => ({ node, declaration: matOSAlgorithmComponentDeclarationForNode(node) }))
    .filter(
      (item): item is {
        node: MatOSWorkflowNode
        declaration: MatOSAlgorithmComponentDeclaration
      } => Boolean(item.declaration),
    )
  if (declared.length === 0) return []
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const pins = []
  for (const { node, declaration } of declared) {
    if (node.type !== 'backend') {
      throw new Error(
        `Workflow node ${node.id} algorithmDecision requires the native backend/tool adapter`,
      )
    }
    if (explicitToolRef(node) !== declaration.componentRef) {
      throw new Error(
        `Workflow node ${node.id} tool must exactly match algorithmDecision.componentRef`,
      )
    }
    const asset = registry.resolve(declaration.componentRef)
    if (!asset || asset.type !== 'tool') {
      throw new Error(
        `Workflow node ${node.id} algorithm component not found: ${declaration.componentRef}`,
      )
    }
    pins.push(await pinForAsset({ node, declaration, asset }))
  }
  return pins.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
}

function pinsEqual(
  left: Omit<MatOSAlgorithmComponentPin, 'manifestDigest'>,
  right: Omit<MatOSAlgorithmComponentPin, 'manifestDigest'>,
): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

export async function verifyMatOSAlgorithmComponentPin(input: {
  cwd: string
  node: MatOSWorkflowNode
  pin: MatOSAlgorithmComponentPin
}): Promise<void> {
  const declaration = matOSAlgorithmComponentDeclarationForNode(input.node)
  if (!declaration) {
    throw new Error(`Workflow node ${input.node.id} is missing algorithmDecision`)
  }
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const asset = registry.resolve(declaration.componentRef)
  if (!asset || asset.type !== 'tool') {
    throw new Error(`Pinned algorithm component is no longer resolvable`)
  }
  const current = await pinForAsset({
    node: input.node,
    declaration,
    asset,
  })
  const { manifestDigest: _manifestDigest, ...pinned } = input.pin
  if (!pinsEqual(current, pinned)) {
    throw new Error(
      `Pinned algorithm component changed after run creation: ${input.pin.assetRef}`,
    )
  }
}

function receiptReferenceList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`algorithmDecision.${field} must be a bounded reference array`)
  }
  const refs = value.map(safeReference)
  if (refs.some(item => !item)) {
    throw new Error(`algorithmDecision.${field} contains an unsafe reference`)
  }
  return [...new Set(refs as string[])]
}

export function parseMatOSAlgorithmDecisionReceipt(input: {
  payload: unknown
  payloadBytes: number
  pin: MatOSAlgorithmComponentPin
  runId: string
  nodeId: string
  attempt: number
  inputDigest: string
}): MatOSAlgorithmDecisionReceipt {
  if (input.payloadBytes > MATOS_ALGORITHM_DECISION_RECEIPT_MAX_BYTES) {
    throw new Error('Algorithm component output exceeds the receipt size limit')
  }
  const payload = recordValue(input.payload)
  const raw = recordValue(payload?.algorithmDecision)
  if (!raw) throw new Error('Algorithm component omitted algorithmDecision receipt')
  const unknown = Object.keys(raw).filter(key => !RECEIPT_FIELDS.has(key))
  if (unknown.length > 0) {
    throw new Error(`Algorithm decision receipt has unsupported fields: ${unknown.join(', ')}`)
  }
  const providerDecisionId = safeReference(raw.decisionId)
  const domainDecisionId = safeReference(
    recordValue(payload?.domainDecision)?.decisionId,
  )
  const evaluationRefs = receiptReferenceList(raw.evaluationRefs, 'evaluationRefs')
  const validationRefs = receiptReferenceList(raw.validationRefs, 'validationRefs')
  const metricRefs = receiptReferenceList(raw.metricRefs, 'metricRefs')
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) {
    throw new Error('Algorithm component input digest is invalid')
  }
  if (
    raw.schemaVersion !== 1 ||
    raw.protocol !== input.pin.protocol ||
    !providerDecisionId ||
    raw.runId !== input.runId ||
    raw.nodeId !== input.nodeId ||
    raw.attempt !== input.attempt ||
    raw.plane !== input.pin.plane ||
    raw.providerId !== input.pin.providerId ||
    raw.providerVersion !== input.pin.providerVersion ||
    raw.assetRef !== input.pin.assetRef ||
    raw.configDigest !== input.pin.configDigest ||
    raw.implementationDigest !== input.pin.implementationDigest ||
    raw.manifestDigest !== input.pin.manifestDigest
  ) {
    throw new Error('Algorithm decision receipt identity or digest does not match its run pin')
  }
  if (domainDecisionId && domainDecisionId !== providerDecisionId) {
    throw new Error(
      'Algorithm decision receipt does not match the provider domain decision',
    )
  }
  const providerReceiptBody = {
    schemaVersion: 1 as const,
    protocol: input.pin.protocol,
    providerDecisionId,
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    plane: input.pin.plane,
    providerId: input.pin.providerId,
    providerVersion: input.pin.providerVersion,
    assetRef: input.pin.assetRef,
    configDigest: input.pin.configDigest,
    inputDigest: input.inputDigest,
    implementationDigest: input.pin.implementationDigest,
    manifestDigest: input.pin.manifestDigest,
    evaluationRefs,
    validationRefs,
    metricRefs,
  }
  const receiptDigest = matOSAlgorithmComponentConfigDigest(providerReceiptBody)
  const decisionId = `algorithm-component-decision:${matOSAlgorithmComponentConfigDigest({
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    providerId: input.pin.providerId,
    providerVersion: input.pin.providerVersion,
    assetRef: input.pin.assetRef,
    configDigest: input.pin.configDigest,
    inputDigest: input.inputDigest,
    implementationDigest: input.pin.implementationDigest,
    manifestDigest: input.pin.manifestDigest,
    receiptDigest,
  })}`
  return {
    schemaVersion: 1,
    protocol: input.pin.protocol,
    providerDecisionId,
    decisionId,
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    plane: input.pin.plane,
    providerId: input.pin.providerId,
    providerVersion: input.pin.providerVersion,
    assetRef: input.pin.assetRef,
    configDigest: input.pin.configDigest,
    inputDigest: input.inputDigest,
    implementationDigest: input.pin.implementationDigest,
    manifestDigest: input.pin.manifestDigest,
    evaluationRefs,
    validationRefs,
    metricRefs,
    receiptDigest,
  }
}
