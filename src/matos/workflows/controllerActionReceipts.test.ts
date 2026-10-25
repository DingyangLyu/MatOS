import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { createMatOSControllerAction } from '../algorithms/controllers/protocol.js'
import { controllerTestObservation } from '../algorithms/controllers/testFixtures.js'
import {
  MatOSControllerActionReceiptError,
  MatOSControllerActionReceiptStore,
  sanitizeMatOSControllerActionReceipt,
} from './controllerActionReceipts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), 'matos-controller-receipts-'))
  roots.push(runDir)
  const observation = controllerTestObservation({ readyNodeRefs: [] })
  const action = createMatOSControllerAction({
    observation,
    seed: 41,
    intent: {
      type: 'recovery-request',
      checkpointRef: 'workflow-recovery:failure-set-1',
      mode: 'reconcile',
      reason: 'delegate to native recovery classifier',
    },
  })
  return { action, runDir }
}

describe('MatOS controller action receipts', () => {
  test('content-addresses append-only proposed/applied receipts and replays the same effect', async () => {
    const { action, runDir } = await fixture()
    const store = new MatOSControllerActionReceiptStore(runDir)
    const effectRef = 'controller-effect:recovery:failure-set-1'
    const proposed = await store.propose({
      action,
      effectRef,
      safeRefs: ['workflow-recovery:failure-set-1'],
    })
    expect(proposed.replayed).toBe(false)
    expect(proposed.receipt.status).toBe('proposed')
    expect(sanitizeMatOSControllerActionReceipt(proposed.receipt)).toEqual(
      proposed.receipt,
    )

    const applied = await store.transition({
      effectRef,
      expectedReceiptId: proposed.receipt.receiptId,
      status: 'applied',
      safeRefs: ['workflow-recovery-report:abc123', 'workflow-run:completed'],
    })
    expect(applied.replayed).toBe(false)
    expect(applied.receipt.previousReceiptId).toBe(proposed.receipt.receiptId)
    expect(applied.receipt.receiptId).not.toBe(proposed.receipt.receiptId)

    const replay = await store.propose({
      action,
      effectRef,
      safeRefs: ['workflow-recovery:failure-set-1'],
    })
    expect(replay).toMatchObject({ replayed: true })
    expect(replay.receipt.receiptId).toBe(applied.receipt.receiptId)

    const lines = (
      await readFile(store.pathForEffect(effectRef), 'utf8')
    ).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  test('serializes concurrent receipt CAS so only one terminal transition wins', async () => {
    const { action, runDir } = await fixture()
    const effectRef = 'controller-effect:recovery:concurrent'
    const storeA = new MatOSControllerActionReceiptStore(runDir)
    const storeB = new MatOSControllerActionReceiptStore(runDir)
    const proposed = await storeA.propose({ action, effectRef })

    const settled = await Promise.allSettled([
      storeA.transition({
        effectRef,
        expectedReceiptId: proposed.receipt.receiptId,
        status: 'applied',
        safeRefs: ['workflow-recovery-report:first'],
      }),
      storeB.transition({
        effectRef,
        expectedReceiptId: proposed.receipt.receiptId,
        status: 'rejected',
        safeRefs: ['workflow-recovery-report:second'],
      }),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(item => item.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'receipt-cas-mismatch',
    })
  })

  test('fails closed after a crash window where the effect happened before its applied receipt', async () => {
    const { action, runDir } = await fixture()
    const effectRef = 'controller-effect:recovery:crash-window'
    const effectPath = join(runDir, 'non-replayable-effect.txt')
    const firstStore = new MatOSControllerActionReceiptStore(runDir)
    const proposed = await firstStore.propose({ action, effectRef })
    expect(proposed.replayed).toBe(false)

    // The external effect completed, but the process died before it could
    // append an applied receipt.
    await writeFile(effectPath, 'executed-once\n', { flag: 'wx' })

    const restartedStore = new MatOSControllerActionReceiptStore(runDir)
    const ambiguous = await restartedStore.propose({ action, effectRef })
    expect(ambiguous).toMatchObject({
      replayed: true,
      receipt: { status: 'proposed' },
    })
    const paused = await restartedStore.transition({
      effectRef,
      expectedReceiptId: ambiguous.receipt.receiptId,
      status: 'paused',
      safeRefs: ['controller-replay:ambiguous-proposal'],
    })
    expect(paused.receipt.status).toBe('paused')
    expect(await readFile(effectPath, 'utf8')).toBe('executed-once\n')

    const replay = await restartedStore.propose({ action, effectRef })
    expect(replay.receipt.status).toBe('paused')
    expect(replay.replayed).toBe(true)
  })

  test('rejects a symlinked receipt directory instead of following it', async () => {
    const { action, runDir } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'matos-controller-receipts-outside-'))
    roots.push(outside)
    await mkdir(join(runDir, 'controllers'), { recursive: true })
    await symlink(outside, join(runDir, 'controllers', 'action-receipts'))
    const store = new MatOSControllerActionReceiptStore(runDir)
    await expect(
      store.propose({
        action,
        effectRef: 'controller-effect:recovery:symlink',
      }),
    ).rejects.toBeInstanceOf(MatOSControllerActionReceiptError)
  })
})
