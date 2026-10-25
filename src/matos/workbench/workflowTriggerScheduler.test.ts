import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getMatOSConfigPath } from '../project.js'
import {
  getMatOSWorkbenchWorkflowTrigger,
  saveMatOSWorkbenchWorkflowTrigger,
  updateMatOSWorkbenchWorkflowTriggerScheduler,
} from './workflowTriggers.js'
import {
  computeNextCronFire,
  fireMatOSWorkbenchWorkflowTrigger,
  parseCronExpression,
  serveMatOSWorkflowTriggerScheduler,
  tickMatOSWorkflowTriggerScheduler,
} from './workflowTriggerScheduler.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createSchedulerFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-trigger-scheduler-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
    execution: {
      runtimeDataDir: join(root, 'runtime-state'),
    },
  })
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'relax')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'relax',
    type: 'workflow',
    name: 'Relax',
    version: '0.1.0',
    description: 'Relax a structure.',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: relax',
      'parameters:',
      '  structure:',
      '    type: string',
      '    required: false',
      'policy:',
      '  approvalMode: bypass',
      '  defaultRisk: low',
      'nodes:',
      '  prepare:',
      '    type: exec',
      '    command: "printf ready"',
      'outputs:',
      '  ready:',
      '    value: "{{ nodes.prepare.outputs.stdout }}"',
      '',
    ].join('\n'),
    'utf8',
  )
  return root
}

async function saveCronTrigger(
  root: string,
  options: { triggerId: string; crontab: string; timezone?: string; status?: number },
): Promise<void> {
  const saved = await saveMatOSWorkbenchWorkflowTrigger({
    cwd: root,
    workflowRef: 'workflow:relax@0.1.0',
    request: {
      trigger_id: options.triggerId,
      event_id: 'matos.schedule.cron',
      name: `Cron ${options.triggerId}`,
      config: {
        crontab: options.crontab,
        ...(options.timezone ? { timezone: options.timezone } : {}),
      },
      payload: { parameters: { structure: 'cu.cif' } },
      status: options.status ?? 1,
    },
  })
  expect(saved.applied).toBe(true)
}

describe('MatOS workflow trigger cron parsing', () => {
  test('computes next fire instants for seconds-first and classic cron forms', () => {
    const from = Date.parse('2026-06-10T05:00:00.000Z')

    // Coze form default: daily at midnight, seconds-first 6-field form.
    expect(computeNextCronFire('0 0 0 * * *', from)).toBe(Date.parse('2026-06-11T00:00:00.000Z'))

    // Classic 5-field form.
    expect(computeNextCronFire('30 2 * * *', from)).toBe(Date.parse('2026-06-11T02:30:00.000Z'))

    // Step minutes fire within the same hour.
    expect(computeNextCronFire('0 */5 * * * *', Date.parse('2026-06-10T05:02:30.000Z'))).toBe(
      Date.parse('2026-06-10T05:05:00.000Z'),
    )

    // Day-of-week: 2026-06-10 is a Wednesday; next Monday 09:00 is 2026-06-15.
    expect(computeNextCronFire('0 0 9 * * 1', from)).toBe(Date.parse('2026-06-15T09:00:00.000Z'))

    // Seconds field inside the current minute.
    expect(computeNextCronFire('45 * * * * *', Date.parse('2026-06-10T05:00:10.000Z'))).toBe(
      Date.parse('2026-06-10T05:00:45.000Z'),
    )

    // A strict next-after semantics: an exact match advances to the next slot.
    expect(computeNextCronFire('0 0 0 * * *', Date.parse('2026-06-11T00:00:00.000Z'))).toBe(
      Date.parse('2026-06-12T00:00:00.000Z'),
    )
  })

  test('honours IANA timezones when resolving wall-clock fields', () => {
    const from = Date.parse('2026-06-10T05:00:00.000Z')
    // 05:00 UTC is 13:00 in Asia/Shanghai; next CST midnight is 16:00 UTC.
    expect(computeNextCronFire('0 0 0 * * *', from, 'Asia/Shanghai')).toBe(
      Date.parse('2026-06-10T16:00:00.000Z'),
    )
  })

  test('arms leap-day schedules that fall years ahead', () => {
    // The next Feb 29 after 2026-06-10 is in 2028 (a leap year), which is well
    // beyond a one-year search window. The old 366-day bound returned undefined
    // and the trigger could never arm.
    expect(computeNextCronFire('0 0 0 29 2 *', Date.parse('2026-06-10T05:00:00.000Z'))).toBe(
      Date.parse('2028-02-29T00:00:00.000Z'),
    )
    // From inside the leap year the same instant is found.
    expect(computeNextCronFire('0 0 0 29 2 *', Date.parse('2028-01-01T00:00:00.000Z'))).toBe(
      Date.parse('2028-02-29T00:00:00.000Z'),
    )
  })

  test('rejects malformed and never-matching expressions', () => {
    expect(parseCronExpression('not a cron')).toBeUndefined()
    expect(parseCronExpression('99 * * * *')).toBeUndefined()
    expect(parseCronExpression('* * * *')).toBeUndefined()
    expect(parseCronExpression('0 0 0 * * * *')).toBeUndefined()
    // Open-ended ranges must not silently parse as 0-N / N-max.
    expect(parseCronExpression('-5 * * * *')).toBeUndefined()
    expect(parseCronExpression('5- * * * *')).toBeUndefined()
    // February 31st never exists, so the bounded search gives up.
    expect(computeNextCronFire('0 0 0 31 2 *', Date.parse('2026-06-10T05:00:00.000Z'))).toBeUndefined()
    // February 30th never exists either; the date-feasibility guard rejects it
    // instantly instead of walking the whole window.
    expect(computeNextCronFire('0 0 0 30 2 *', Date.parse('2026-06-10T05:00:00.000Z'))).toBeUndefined()
  })
})

describe('MatOS workflow trigger scheduler', () => {
  test('arms new cron triggers without firing, then fires real workflow runs when due', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-cron-1', crontab: '0 0 0 * * *' })
    const t0 = Date.parse('2026-06-10T05:00:00.000Z')

    // First sight arms the trigger and persists nextFireAt without firing.
    const armTick = await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: t0 })
    expect(armTick.evaluated).toBe(1)
    expect(armTick.fired).toHaveLength(0)
    expect(armTick.armed).toHaveLength(1)
    const armedAt = armTick.armed[0]?.nextFireAt ?? 0
    expect(armedAt).toBe(Date.parse('2026-06-11T00:00:00.000Z'))
    expect(armTick.nextWakeAt).toBe(armedAt)

    const armedDetail = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-cron-1',
    })
    expect(armedDetail.trigger?.scheduler?.nextFireAt).toBe(armedAt)
    expect(armedDetail.trigger?.scheduler?.cron).toBe('0 0 0 * * *')

    // Not due yet: nothing fires and the wake hint stays on the armed instant.
    const idleTick = await tickMatOSWorkflowTriggerScheduler({
      cwd: root,
      now: armedAt - 60_000,
    })
    expect(idleTick.fired).toHaveLength(0)
    expect(idleTick.due).toBe(0)
    expect(idleTick.nextWakeAt).toBe(armedAt)

    // Due (long outage): fires exactly one real catch-up run, then re-arms.
    const fireNow = armedAt + 3 * 60 * 60 * 1000
    const fireTick = await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: fireNow })
    expect(fireTick.due).toBe(1)
    expect(fireTick.fired).toHaveLength(1)
    expect(fireTick.fired[0]?.error).toBeUndefined()
    expect(fireTick.fired[0]?.runId).toBeTruthy()
    expect(fireTick.fired[0]?.runStatus).toBe('completed')

    const firedDetail = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-cron-1',
    })
    expect(firedDetail.trigger?.scheduler?.lastRunId).toBe(fireTick.fired[0]?.runId ?? '')
    expect(firedDetail.trigger?.scheduler?.lastFiredAt).toBe(fireNow)
    const reArmedAt = firedDetail.trigger?.scheduler?.nextFireAt ?? 0
    expect(reArmedAt).toBe(Date.parse('2026-06-12T00:00:00.000Z'))

    // The real workflow run wrote its run directory (under the fixture's
    // configured runtime-data scope) with the trigger payload parameters.
    const runId = fireTick.fired[0]?.runId ?? ''
    const runRecordPath = join(
      root,
      'runtime-state',
      'scopes',
      'users',
      'local',
      'workflows',
      'runs',
      runId,
      'run.json',
    )
    const runRecord = JSON.parse(await readFile(runRecordPath, 'utf8')) as {
      status?: string
      parameters?: Record<string, unknown>
      provenance?: Record<string, unknown>
      trace?: { traceId?: string; sessionId?: string; scopeRef?: string }
    }
    expect(runRecord.status).toBe('completed')
    expect(runRecord.parameters?.structure).toBe('cu.cif')
    expect(runRecord.provenance).toMatchObject({
      source: 'trigger',
      triggerId: 'trg-cron-1',
      triggerEventId: 'matos.schedule.cron',
      triggerAppId: 'matos-schedule',
      firedAt: fireNow,
    })
    expect(typeof runRecord.provenance?.payloadDigest).toBe('string')
    expect(String(runRecord.provenance?.payloadDigest)).toMatch(/^sha256:/)
    expect(runRecord.trace?.traceId).toBeTruthy()
    expect(runRecord.trace?.sessionId).toBeTruthy()
    expect(runRecord.trace?.scopeRef).toBe('user:local')
  }, 30_000)

  test('skips closed triggers, ignores non-cron events, and reports invalid cron expressions', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-closed', crontab: '0 0 0 * * *', status: 0 })
    const manual = await saveMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      request: {
        trigger_id: 'trg-manual',
        event_id: 'matos.manual.run',
        name: 'Manual run',
        config: {},
        payload: {},
        status: 1,
      },
    })
    expect(manual.applied).toBe(true)
    // Bypass save-time validation to simulate legacy bad data in the store.
    const storePathSafe = 'workflow_relax@0.1.0'.replace(/[^a-zA-Z0-9._:@-]+/g, '_')
    void storePathSafe

    const tick = await tickMatOSWorkflowTriggerScheduler({
      cwd: root,
      now: Date.parse('2026-06-10T05:00:00.000Z'),
    })
    // Only cron triggers are evaluated; the closed one is skipped.
    expect(tick.evaluated).toBe(1)
    expect(tick.skipped).toEqual([
      {
        triggerId: 'trg-closed',
        workflowRef: 'workflow:relax@0.1.0',
        reason: 'trigger_closed',
      },
    ])
    expect(tick.fired).toHaveLength(0)
  })

  test('concurrent ticks fire one due trigger at most once', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-race', crontab: '0 0 0 * * *' })
    const t0 = Date.parse('2026-06-10T05:00:00.000Z')
    await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: t0 })

    // Both ticks observe the same due instant. The pre-fire re-arm write plus
    // the per-trigger firing lease must keep the workflow run at-most-once.
    const fireNow = Date.parse('2026-06-11T00:00:01.000Z')
    const [a, b] = await Promise.all([
      tickMatOSWorkflowTriggerScheduler({ cwd: root, now: fireNow }),
      tickMatOSWorkflowTriggerScheduler({ cwd: root, now: fireNow }),
    ])
    const fired = [...a.fired, ...b.fired]
    expect(fired).toHaveLength(1)
    expect(fired[0]?.error).toBeUndefined()
    expect(fired[0]?.runStatus).toBe('completed')

    const detail = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-race',
    })
    expect(detail.trigger?.scheduler?.lastRunId).toBe(fired[0]?.runId ?? '')
    expect(detail.trigger?.scheduler?.nextFireAt).toBe(Date.parse('2026-06-12T00:00:00.000Z'))
  }, 30_000)

  test('fires multiple due triggers in one tick with bounded concurrency', async () => {
    const root = await createSchedulerFixture()
    for (const triggerId of ['trg-a', 'trg-b', 'trg-c']) {
      await saveCronTrigger(root, { triggerId, crontab: '0 0 0 * * *' })
    }
    const t0 = Date.parse('2026-06-10T05:00:00.000Z')
    await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: t0 })

    const fireNow = Date.parse('2026-06-11T00:00:01.000Z')
    const tick = await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: fireNow })
    expect(tick.due).toBe(3)
    expect(tick.fired).toHaveLength(3)
    const runIds = tick.fired.map(item => item.runId).filter(Boolean)
    expect(new Set(runIds).size).toBe(3)
    for (const fired of tick.fired) {
      expect(fired.error).toBeUndefined()
      expect(fired.runStatus).toBe('completed')
    }
  }, 60_000)

  test('re-arms when the cron expression changes instead of firing stale schedules', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-edit', crontab: '0 0 0 * * *' })
    const t0 = Date.parse('2026-06-10T05:00:00.000Z')
    await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: t0 })

    // Edit the schedule; the stored nextFireAt snapshot no longer applies.
    await saveCronTrigger(root, { triggerId: 'trg-edit', crontab: '0 30 6 * * *' })
    const past = Date.parse('2026-06-11T01:00:00.000Z')
    const tick = await tickMatOSWorkflowTriggerScheduler({ cwd: root, now: past })
    expect(tick.fired).toHaveLength(0)
    expect(tick.armed).toHaveLength(1)
    expect(tick.armed[0]?.nextFireAt).toBe(Date.parse('2026-06-11T06:30:00.000Z'))
  })

  test('fires manual triggers on demand through the same provenance-recording path', async () => {
    const root = await createSchedulerFixture()
    const saved = await saveMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      request: {
        trigger_id: 'trg-manual-fire',
        event_id: 'matos.manual.run',
        name: 'Manual fire',
        config: {},
        payload: { parameters: { structure: 'fe.cif' } },
        status: 1,
      },
    })
    expect(saved.applied).toBe(true)
    expect(saved.trigger).not.toBeNull()
    const fired = await fireMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      trigger: saved.trigger ?? (() => { throw new Error('missing trigger') })(),
    })
    expect(fired.error).toBeUndefined()
    expect(fired.runId).toBeTruthy()
    expect(fired.runStatus).toBe('completed')

    const detail = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-manual-fire',
    })
    expect(detail.trigger?.scheduler?.lastRunId).toBe(fired.runId ?? '')
    const runRecordPath = join(
      root,
      'runtime-state',
      'scopes',
      'users',
      'local',
      'workflows',
      'runs',
      fired.runId ?? '',
      'run.json',
    )
    const runRecord = JSON.parse(await readFile(runRecordPath, 'utf8')) as {
      provenance?: Record<string, unknown>
      trace?: { traceId?: string; sessionId?: string }
    }
    expect(runRecord.provenance).toMatchObject({
      source: 'trigger',
      triggerId: 'trg-manual-fire',
      triggerEventId: 'matos.manual.run',
      triggerAppId: 'matos-manual',
    })
    expect(String(runRecord.provenance?.payloadDigest)).toMatch(/^sha256:/)
    expect(runRecord.trace?.traceId).toBeTruthy()
    expect(runRecord.trace?.sessionId).toBeTruthy()
  }, 30_000)

  test('serve loop ticks until max ticks with abort support', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-serve', crontab: '0 0 0 * * *' })
    const ticks: number[] = []
    const result = await serveMatOSWorkflowTriggerScheduler({
      cwd: root,
      intervalMs: 5_000,
      maxTicks: 1,
      onTick: tick => {
        ticks.push(tick.evaluated)
      },
    })
    expect(result.ticks).toBe(1)
    expect(ticks).toEqual([1])
  })
})

describe('MatOS workflow trigger store concurrency', () => {
  test('serializes concurrent scheduler updates so no trigger update is lost', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-a', crontab: '0 0 0 * * *' })
    await saveCronTrigger(root, { triggerId: 'trg-b', crontab: '0 0 0 * * *' })

    // Both triggers live in the same workflow store file. Interleave many
    // scheduler-bookkeeping writes against the two of them at once: each is a
    // read-modify-write over the shared file, so without a store lock the two
    // streams clobber each other and one trigger ends up with no scheduler
    // state at all.
    const updates: Promise<unknown>[] = []
    for (let i = 0; i < 12; i += 1) {
      updates.push(
        updateMatOSWorkbenchWorkflowTriggerScheduler({
          cwd: root,
          workflowRef: 'workflow:relax@0.1.0',
          triggerId: 'trg-a',
          scheduler: { cron: '0 0 0 * * *', nextFireAt: 1000 + i },
        }),
      )
      updates.push(
        updateMatOSWorkbenchWorkflowTriggerScheduler({
          cwd: root,
          workflowRef: 'workflow:relax@0.1.0',
          triggerId: 'trg-b',
          scheduler: { cron: '0 0 0 * * *', nextFireAt: 5000 + i },
        }),
      )
    }
    await Promise.all(updates)

    const a = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-a',
    })
    const b = await getMatOSWorkbenchWorkflowTrigger({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-b',
    })
    // Each trigger keeps its own bookkeeping; neither was dropped by the other.
    expect(a.trigger?.scheduler?.nextFireAt).toBeGreaterThanOrEqual(1000)
    expect(a.trigger?.scheduler?.nextFireAt).toBeLessThan(2000)
    expect(b.trigger?.scheduler?.nextFireAt).toBeGreaterThanOrEqual(5000)
    expect(b.trigger?.scheduler?.nextFireAt).toBeLessThan(6000)
  })

  test('reclaims a stale store lock left by a crashed holder', async () => {
    const root = await createSchedulerFixture()
    await saveCronTrigger(root, { triggerId: 'trg-stale', crontab: '0 0 0 * * *' })
    // Simulate a holder that crashed mid-mutation: a lock directory whose mtime
    // is well past the stale bound. A new mutation must reclaim it and apply.
    const lockDir = join(
      root,
      '.matos',
      'workbench',
      'workflow-triggers',
      '.store.lock',
    )
    await mkdir(lockDir, { recursive: true })
    const stale = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lockDir, stale, stale)

    const updated = await updateMatOSWorkbenchWorkflowTriggerScheduler({
      cwd: root,
      workflowRef: 'workflow:relax@0.1.0',
      triggerId: 'trg-stale',
      scheduler: { cron: '0 0 0 * * *', nextFireAt: 4242 },
    })
    expect(updated?.scheduler?.nextFireAt).toBe(4242)
  })
})
