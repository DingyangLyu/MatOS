import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendBoundedControllerFile,
  ensureControllerStoreDirectory,
  readBoundedControllerFile,
  withControllerFileLock,
} from '../algorithms/controllers/storeIo.js'
import {
  matOSControllerDigest,
  type MatOSControllerAction,
} from '../algorithms/controllers/protocol.js'

export const MATOS_CONTROLLER_ACTION_RECEIPT_SCHEMA_VERSION = 1 as const
export const MATOS_CONTROLLER_ACTION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024

export type MatOSControllerActionReceiptStatus =
  | 'proposed'
  | 'applied'
  | 'rejected'
  | 'paused'

export type MatOSControllerActionReceipt = Readonly<{
  schemaVersion: typeof MATOS_CONTROLLER_ACTION_RECEIPT_SCHEMA_VERSION
  receiptId: string
  sequence: number
  previousReceiptId?: string
  recordedAt: string
  status: MatOSControllerActionReceiptStatus
  effectRef: string
  actionId: string
  actionType: MatOSControllerAction['type']
  runRef: string
  scopeRef: string
  observationDigest: string
  eventCursor: string
  manifestDigest: string
  graphDigest: string
  graphVersion: number
  safeRefs: readonly string[]
}>

export class MatOSControllerActionReceiptError extends Error {
  readonly code:
    | 'invalid-receipt'
    | 'receipt-corrupt'
    | 'receipt-cas-mismatch'
    | 'unsafe-receipt-path'

  constructor(
    code: MatOSControllerActionReceiptError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'MatOSControllerActionReceiptError'
    this.code = code
  }
}

function receiptError(
  code: MatOSControllerActionReceiptError['code'],
  message: string,
): never {
  throw new MatOSControllerActionReceiptError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedRef(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,4095}$/.test(value)
  ) {
    receiptError('invalid-receipt', `${path} must be a bounded safe reference`)
  }
  return value
}

function safeRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    receiptError('invalid-receipt', 'safeRefs must be a bounded reference array')
  }
  return Object.freeze(
    [...new Set(value.map((item, index) => boundedRef(item, `safeRefs[${index}]`)))].sort(),
  )
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    receiptError('invalid-receipt', `${path} must be a non-negative integer`)
  }
  return Number(value)
}

const RECEIPT_STATUSES = new Set<MatOSControllerActionReceiptStatus>([
  'proposed',
  'applied',
  'rejected',
  'paused',
])

const ACTION_TYPES = new Set<MatOSControllerAction['type']>([
  'noop',
  'rank-ready',
  'propose-graph-patch',
  'request-validation',
  'request-human',
  'pause',
  'stop-request',
  'recovery-request',
])

function createReceipt(
  input: Omit<MatOSControllerActionReceipt, 'schemaVersion' | 'receiptId'>,
): MatOSControllerActionReceipt {
  const recordedAt = boundedRef(input.recordedAt, 'recordedAt')
  if (!Number.isFinite(Date.parse(recordedAt))) {
    receiptError('invalid-receipt', 'recordedAt must be an ISO timestamp')
  }
  if (!RECEIPT_STATUSES.has(input.status)) {
    receiptError('invalid-receipt', 'receipt status is unsupported')
  }
  if (!ACTION_TYPES.has(input.actionType)) {
    receiptError('invalid-receipt', 'receipt action type is unsupported')
  }
  const body = {
    schemaVersion: MATOS_CONTROLLER_ACTION_RECEIPT_SCHEMA_VERSION,
    sequence: nonNegativeInteger(input.sequence, 'sequence'),
    ...(input.previousReceiptId
      ? { previousReceiptId: boundedRef(input.previousReceiptId, 'previousReceiptId') }
      : {}),
    recordedAt,
    status: input.status,
    effectRef: boundedRef(input.effectRef, 'effectRef'),
    actionId: boundedRef(input.actionId, 'actionId'),
    actionType: input.actionType,
    runRef: boundedRef(input.runRef, 'runRef'),
    scopeRef: boundedRef(input.scopeRef, 'scopeRef'),
    observationDigest: boundedRef(input.observationDigest, 'observationDigest'),
    eventCursor: boundedRef(input.eventCursor, 'eventCursor'),
    manifestDigest: boundedRef(input.manifestDigest, 'manifestDigest'),
    graphDigest: boundedRef(input.graphDigest, 'graphDigest'),
    graphVersion: nonNegativeInteger(input.graphVersion, 'graphVersion'),
    safeRefs: safeRefs(input.safeRefs),
  }
  if ((body.sequence === 0) !== (body.previousReceiptId === undefined)) {
    receiptError(
      'invalid-receipt',
      'only the proposed sequence zero receipt may omit previousReceiptId',
    )
  }
  if (
    (body.sequence === 0 && body.status !== 'proposed') ||
    (body.sequence > 0 && body.status === 'proposed')
  ) {
    receiptError('invalid-receipt', 'receipt status does not match its sequence')
  }
  const receiptId = `controller-action-receipt:${matOSControllerDigest(body)}`
  return Object.freeze({ ...body, receiptId })
}

export function sanitizeMatOSControllerActionReceipt(
  value: unknown,
): MatOSControllerActionReceipt {
  if (!isRecord(value) || value.schemaVersion !== MATOS_CONTROLLER_ACTION_RECEIPT_SCHEMA_VERSION) {
    receiptError('receipt-corrupt', 'controller action receipt schema is invalid')
  }
  const receipt = createReceipt(
    value as unknown as Omit<
      MatOSControllerActionReceipt,
      'schemaVersion' | 'receiptId'
    >,
  )
  if (value.receiptId !== receipt.receiptId) {
    receiptError('receipt-corrupt', 'controller action receipt digest is invalid')
  }
  return receipt
}

function sameContext(
  first: MatOSControllerActionReceipt,
  next: MatOSControllerActionReceipt,
): boolean {
  return (
    first.effectRef === next.effectRef &&
    first.actionId === next.actionId &&
    first.actionType === next.actionType &&
    first.runRef === next.runRef &&
    first.scopeRef === next.scopeRef &&
    first.observationDigest === next.observationDigest &&
    first.eventCursor === next.eventCursor &&
    first.manifestDigest === next.manifestDigest &&
    first.graphDigest === next.graphDigest &&
    first.graphVersion === next.graphVersion
  )
}

export class MatOSControllerActionReceiptStore {
  readonly runDir: string
  readonly root: string

  constructor(runDir: string) {
    this.runDir = runDir
    this.root = join(runDir, 'controllers', 'action-receipts')
  }

  pathForEffect(effectRef: string): string {
    const ref = boundedRef(effectRef, 'effectRef')
    const digest = createHash('sha256').update(ref).digest('hex')
    return join(this.root, `${digest}.jsonl`)
  }

  async #prepare(): Promise<void> {
    try {
      const controllers = join(this.runDir, 'controllers')
      await ensureControllerStoreDirectory(controllers)
      await ensureControllerStoreDirectory(this.root)
      const metadata = await lstat(this.root)
      if (metadata.isSymbolicLink()) {
        receiptError('unsafe-receipt-path', 'action receipt root must not be a symlink')
      }
    } catch (error) {
      if (error instanceof MatOSControllerActionReceiptError) throw error
      receiptError('unsafe-receipt-path', String(error))
    }
  }

  async #read(effectRef: string): Promise<MatOSControllerActionReceipt[]> {
    const path = this.pathForEffect(effectRef)
    let raw: string | undefined
    try {
      raw = await readBoundedControllerFile({
        path,
        maxBytes: MATOS_CONTROLLER_ACTION_RECEIPT_MAX_BYTES,
        missingOk: true,
      })
    } catch (error) {
      receiptError('unsafe-receipt-path', String(error))
    }
    if (raw === undefined) return []
    const receipts: MatOSControllerActionReceipt[] = []
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        receiptError('receipt-corrupt', `invalid receipt JSON at line ${index + 1}`)
      }
      const receipt = sanitizeMatOSControllerActionReceipt(parsed)
      const previous = receipts.at(-1)
      if (
        receipt.sequence !== receipts.length ||
        receipt.previousReceiptId !== previous?.receiptId ||
        (previous && !sameContext(previous, receipt))
      ) {
        receiptError('receipt-corrupt', 'controller action receipt chain is invalid')
      }
      receipts.push(receipt)
    }
    return receipts
  }

  async latest(effectRef: string): Promise<MatOSControllerActionReceipt | undefined> {
    await this.#prepare()
    return (await this.#read(effectRef)).at(-1)
  }

  async propose(input: {
    action: MatOSControllerAction
    effectRef: string
    safeRefs?: readonly string[]
  }): Promise<{ receipt: MatOSControllerActionReceipt; replayed: boolean }> {
    await this.#prepare()
    const path = this.pathForEffect(input.effectRef)
    return withControllerFileLock({
      path,
      operation: async () => {
        const existing = (await this.#read(input.effectRef)).at(-1)
        if (existing) return { receipt: existing, replayed: true }
        const receipt = createReceipt({
          sequence: 0,
          recordedAt: new Date().toISOString(),
          status: 'proposed',
          effectRef: input.effectRef,
          actionId: input.action.actionId,
          actionType: input.action.type,
          runRef: input.action.runRef,
          scopeRef: input.action.scopeRef,
          observationDigest: input.action.cas.expectedObservationDigest,
          eventCursor: input.action.cas.expectedEventCursor,
          manifestDigest: input.action.cas.expectedManifestDigest,
          graphDigest: input.action.cas.expectedGraphDigest,
          graphVersion: input.action.cas.expectedGraphVersion,
          safeRefs: input.safeRefs ?? [],
        })
        await appendBoundedControllerFile({
          path,
          data: `${JSON.stringify(receipt)}\n`,
          maxBytes: MATOS_CONTROLLER_ACTION_RECEIPT_MAX_BYTES,
        })
        return { receipt, replayed: false }
      },
    }).catch(error => {
      if (error instanceof MatOSControllerActionReceiptError) throw error
      receiptError('unsafe-receipt-path', String(error))
    })
  }

  async transition(input: {
    effectRef: string
    expectedReceiptId: string
    status: Exclude<MatOSControllerActionReceiptStatus, 'proposed'>
    safeRefs?: readonly string[]
  }): Promise<{ receipt: MatOSControllerActionReceipt; replayed: boolean }> {
    await this.#prepare()
    const path = this.pathForEffect(input.effectRef)
    return withControllerFileLock({
      path,
      operation: async () => {
        const existing = (await this.#read(input.effectRef)).at(-1)
        if (!existing) {
          receiptError('receipt-cas-mismatch', 'receipt proposal does not exist')
        }
        const refs = safeRefs([...(existing.safeRefs ?? []), ...(input.safeRefs ?? [])])
        if (existing.receiptId !== input.expectedReceiptId) {
          if (
            existing.status === input.status &&
            matOSControllerDigest(existing.safeRefs) === matOSControllerDigest(refs)
          ) {
            return { receipt: existing, replayed: true }
          }
          receiptError('receipt-cas-mismatch', 'receipt transition CAS is stale')
        }
        if (existing.status !== 'proposed') {
          receiptError('receipt-cas-mismatch', 'receipt already has a terminal status')
        }
        const receipt = createReceipt({
          sequence: existing.sequence + 1,
          previousReceiptId: existing.receiptId,
          recordedAt: new Date().toISOString(),
          status: input.status,
          effectRef: existing.effectRef,
          actionId: existing.actionId,
          actionType: existing.actionType,
          runRef: existing.runRef,
          scopeRef: existing.scopeRef,
          observationDigest: existing.observationDigest,
          eventCursor: existing.eventCursor,
          manifestDigest: existing.manifestDigest,
          graphDigest: existing.graphDigest,
          graphVersion: existing.graphVersion,
          safeRefs: refs,
        })
        await appendBoundedControllerFile({
          path,
          data: `${JSON.stringify(receipt)}\n`,
          maxBytes: MATOS_CONTROLLER_ACTION_RECEIPT_MAX_BYTES,
        })
        return { receipt, replayed: false }
      },
    }).catch(error => {
      if (error instanceof MatOSControllerActionReceiptError) throw error
      receiptError('unsafe-receipt-path', String(error))
    })
  }
}
