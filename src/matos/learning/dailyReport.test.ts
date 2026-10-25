import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildMatOSEvolutionDailyReport } from './dailyReport.js'
import { runMatOSEvolveCommand } from '../cli/evolve.js'

type EditFixture = {
  runId: string
  status: string
  rawStatus?: string
  statusReason?: string
  updatedAt: string
  summary?: string
  createdAssets?: string[]
  updatedAssets?: string[]
  evidenceRefs?: string[]
  sourceAcceptance?: Array<{
    sourceId: string
    acceptedBranch: string
    commit: string
    ok: boolean
    pushed: boolean
    validationOk: boolean
  }>
}

type ClusterFixture = {
  clusterId: string
  failureSignature: string
  workflowRef: string
  occurrences: number
  lastSeenAt: string
}

async function writeUserRecords(
  runtimeDataDir: string,
  userId: string,
  input: { edits?: EditFixture[]; clusters?: ClusterFixture[] },
): Promise<void> {
  const base = join(
    runtimeDataDir,
    'scopes',
    'users',
    userId,
    'workspace-state',
    'shared',
    '.matos',
    'evolution',
  )
  for (const edit of input.edits ?? []) {
    const dir = join(base, 'direct-editor', 'runs', edit.runId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({
        runId: edit.runId,
        status: edit.status,
        ...(edit.rawStatus ? { rawStatus: edit.rawStatus } : {}),
        ...(edit.statusReason ? { statusReason: edit.statusReason } : {}),
        createdAt: edit.updatedAt,
        updatedAt: edit.updatedAt,
        scope: 'core',
        input: {},
        editorOutput: {
          summary: edit.summary ?? '',
          modifiedFiles: [],
          createdAssets: edit.createdAssets ?? [],
          updatedAssets: edit.updatedAssets ?? [],
          disabledAssets: [],
          evidenceRefs: edit.evidenceRefs ?? [],
          expectedBehaviorChange: '',
          nextSessionEffect: '',
        },
        modifiedFiles: [],
        createdAssets: edit.createdAssets ?? [],
        updatedAssets: edit.updatedAssets ?? [],
        disabledAssets: [],
        evidenceRefs: edit.evidenceRefs ?? [],
        ...(edit.sourceAcceptance
          ? { sourceAcceptance: edit.sourceAcceptance }
          : {}),
        roleExitCode: 0,
      }),
      'utf8',
    )
  }
  for (const cluster of input.clusters ?? []) {
    const dir = join(base, 'replay-clusters', cluster.clusterId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'cluster.json'),
      JSON.stringify({
        schemaVersion: 1,
        clusterId: cluster.clusterId,
        status: 'open',
        workflowRef: cluster.workflowRef,
        failureSignature: cluster.failureSignature,
        occurrences: cluster.occurrences,
        candidateIds: [],
        runIds: [],
        firstSeenAt: cluster.lastSeenAt,
        lastSeenAt: cluster.lastSeenAt,
        proposal: {
          kind: 'repeated-failure',
          summary: 'repeated failure',
          suggestedTargets: ['workflow'],
        },
      }),
      'utf8',
    )
  }
}

async function makeDeployRoot(): Promise<string> {
  const deployRoot = await mkdtemp(join(tmpdir(), 'matos-dailyreport-'))
  const runtimeDataDir = join(deployRoot, 'runtime')
  await writeUserRecords(runtimeDataDir, 'alice', {
    edits: [
      {
        runId: 'direct-editor-a1',
        status: 'accepted',
        updatedAt: '2026-06-11T10:00:00.000Z',
        createdAssets: ['skill:relax@0.1.0'],
      },
    ],
    clusters: [
      {
        clusterId: 'cluster-shared-a',
        failureSignature: 'sig-shared',
        workflowRef: 'workflow:a',
        occurrences: 2,
        lastSeenAt: '2026-06-11T09:00:00.000Z',
      },
    ],
  })
  await writeUserRecords(runtimeDataDir, 'bob', {
    edits: [
      {
        runId: 'direct-editor-b1',
        status: 'rolled_back',
        updatedAt: '2026-06-11T11:00:00.000Z',
      },
      {
        runId: 'direct-editor-b2',
        status: 'blocked',
        updatedAt: '2026-06-11T11:30:00.000Z',
      },
      {
        runId: 'direct-editor-b3',
        status: 'failed',
        updatedAt: '2026-06-11T12:00:00.000Z',
      },
    ],
    clusters: [
      {
        clusterId: 'cluster-shared-b',
        failureSignature: 'sig-shared',
        workflowRef: 'workflow:b',
        occurrences: 3,
        lastSeenAt: '2026-06-11T09:30:00.000Z',
      },
      {
        clusterId: 'cluster-bob-only',
        failureSignature: 'sig-bob-only',
        workflowRef: 'workflow:c',
        occurrences: 1,
        lastSeenAt: '2026-06-11T08:00:00.000Z',
      },
    ],
  })
  return deployRoot
}

describe('MatOS evolution daily report (slice 1)', () => {
  test('aggregates per-user records and groups failure signatures across users', async () => {
    const deployRoot = await makeDeployRoot()
    const report = await buildMatOSEvolutionDailyReport({
      cwd: deployRoot,
      runtimeDataDir: join(deployRoot, 'runtime'),
    })

    expect(report.usersScanned).toBe(2)
    expect(report.totals.directEdits).toBe(4)
    expect(report.totals.accepted).toBe(1)
    expect(report.totals.rolledBack).toBe(1)
    expect(report.totals.blocked).toBe(1)
    expect(report.totals.failed).toBe(1)
    expect(report.totals.replayClusters).toBe(3)
    expect(report.totals.crossUserFailureClusters).toBe(2)

    const shared = report.crossUserFailureClusters[0]
    expect(shared.failureSignature).toBe('sig-shared')
    expect(shared.userCount).toBe(2)
    expect(shared.users).toEqual(['alice', 'bob'])
    expect(shared.totalOccurrences).toBe(5)
    expect(shared.workflowRefs).toEqual(['workflow:a', 'workflow:b'])

    expect(report.recentDirectEdits).toHaveLength(4)
    // newest (bob, 12:00) first
    expect(report.recentDirectEdits[0].userId).toBe('bob')
    expect(report.recentDirectEdits[0].status).toBe('failed')
  })

  test('aggregates algorithm strategy regression records per user', async () => {
    const deployRoot = await makeDeployRoot()
    const regressionsDir = join(
      deployRoot,
      'runtime',
      'scopes',
      'users',
      'alice',
      'workspace-state',
      'shared',
      '.matos',
      'algorithms',
      'regressions',
    )
    await mkdir(regressionsDir, { recursive: true })
    await writeFile(
      join(regressionsDir, 'reg-1.json'),
      JSON.stringify({
        schemaVersion: 1,
        regressionId: 'reg-1',
        createdAt: '2026-06-11T12:30:00.000Z',
        trigger: { kind: 'direct-editor', runId: 'direct-editor-a1' },
        changedStrategyAssets: [
          {
            assetKey: 'tool:my-ranker@0.1.0',
            surfaceId: 'context-ranking',
            providerId: 'asset:tool:my-ranker@0.1.0',
          },
        ],
        benchmarks: [
          {
            benchmarkRef: 'benchmark:my-ranker-regression@0.1.0',
            caseId: 'my-ranker-regression',
            status: 'failed',
            ok: false,
            message: 'agreement 0 < 1',
          },
        ],
        overallOk: false,
        status: 'completed',
      }),
      'utf8',
    )

    const report = await buildMatOSEvolutionDailyReport({
      cwd: deployRoot,
      runtimeDataDir: join(deployRoot, 'runtime'),
    })
    expect(report.totals.algorithmRegressions).toBe(1)
    expect(report.totals.failedAlgorithmRegressions).toBe(1)
    expect(report.algorithmRegressions).toHaveLength(1)
    expect(report.algorithmRegressions[0]).toMatchObject({
      userId: 'alice',
      regressionId: 'reg-1',
      trigger: 'direct-editor(direct-editor-a1)',
      overallOk: false,
      benchmarkCount: 1,
      failedBenchmarkRefs: ['benchmark:my-ranker-regression@0.1.0'],
    })
  })

  test('--since filters out older records', async () => {
    const deployRoot = await makeDeployRoot()
    const report = await buildMatOSEvolutionDailyReport({
      cwd: deployRoot,
      runtimeDataDir: join(deployRoot, 'runtime'),
      since: '2026-06-11T10:30:00.000Z',
    })
    // bob's 11:00, 11:30 and 12:00 edits survive; alice's 10:00 edit is filtered
    expect(report.totals.directEdits).toBe(3)
    expect(report.totals.blocked).toBe(1)
    expect(report.totals.failed).toBe(1)
    expect(report.recentDirectEdits[0].userId).toBe('bob')
    // both clusters are before the since cutoff -> filtered out
    expect(report.totals.replayClusters).toBe(0)
    expect(report.totals.crossUserFailureClusters).toBe(0)
  })

  test('separates effective asset impact from legacy dirty blocked records', async () => {
    const deployRoot = await mkdtemp(join(tmpdir(), 'matos-dailyreport-impact-'))
    const runtimeDataDir = join(deployRoot, 'runtime')
    await writeUserRecords(runtimeDataDir, 'weibaole', {
      edits: [
        {
          runId: 'direct-editor-impact-accepted',
          status: 'accepted_merged',
          updatedAt: '2026-06-18T04:10:00.000Z',
          createdAssets: ['tool:bash-enospc-recovery@0.1.0'],
          updatedAssets: [
            'skill:bash-runtime-hygiene@0.1.0',
            'knowledge:runtime-enospc-runbook@0.1.0',
          ],
        },
        {
          runId: 'direct-editor-legacy-dirty',
          status: 'blocked',
          rawStatus: 'failed',
          statusReason: 'legacy_dirty_preflight',
          updatedAt: '2026-06-18T04:11:00.000Z',
        },
        {
          runId: 'direct-editor-conflict',
          status: 'pending_merge',
          updatedAt: '2026-06-18T04:12:00.000Z',
          updatedAssets: ['role:compute@1.0.0'],
        },
      ],
    })

    const report = await buildMatOSEvolutionDailyReport({
      cwd: deployRoot,
      runtimeDataDir,
    })

    expect(report.totals.directEdits).toBe(3)
    expect(report.totals.blocked).toBe(2)
    expect(report.totals.legacyBlocked).toBe(1)
    expect(report.totals.activeBlocked).toBe(1)
    expect(report.totals.effectiveDirectEdits).toBe(1)
    expect(report.totals.assetChanges.created.total).toBe(1)
    expect(report.totals.assetChanges.created.byType.tool).toBe(1)
    expect(report.totals.assetChanges.updated.total).toBe(2)
    expect(report.totals.assetChanges.updated.byType.skill).toBe(1)
    expect(report.totals.assetChanges.updated.byType.knowledge).toBe(1)
    expect(report.users[0]?.directEdits.legacyBlocked).toBe(1)
    expect(report.users[0]?.directEdits.activeBlocked).toBe(1)
    expect(report.recentDirectEdits.find(edit => edit.runId === 'direct-editor-legacy-dirty')).toMatchObject({
      status: 'blocked',
      statusReason: 'legacy_dirty_preflight',
      effective: false,
    })
  })

  test('surfaces accepted user-local direct edits as promotion review candidates', async () => {
    const deployRoot = await mkdtemp(join(tmpdir(), 'matos-dailyreport-promotion-'))
    const runtimeDataDir = join(deployRoot, 'runtime')
    await writeUserRecords(runtimeDataDir, 'zhicheng', {
      edits: [
        {
          runId: 'direct-editor-conda-probe',
          status: 'accepted',
          updatedAt: '2026-06-18T07:00:00.000Z',
          summary: 'Added conda submodule import probe guidance.',
          updatedAssets: ['role:compute@1.0.0'],
          evidenceRefs: ['experience:compute-conda-env-probe-submodule-gap@0.1.0'],
          sourceAcceptance: [
            {
              sourceId: 'matos-user-assets-zhicheng',
              acceptedBranch: 'accepted/matos-user-assets-zhicheng/stable',
              commit: 'abc123',
              ok: true,
              pushed: true,
              validationOk: true,
            },
          ],
        },
        {
          runId: 'direct-editor-noop',
          status: 'noop',
          updatedAt: '2026-06-18T07:05:00.000Z',
          summary: 'No reusable change.',
          updatedAssets: ['role:compute@1.0.0'],
        },
      ],
    })

    const report = await buildMatOSEvolutionDailyReport({
      cwd: deployRoot,
      runtimeDataDir,
    })

    expect(report.totals.promotionCandidates).toBe(1)
    expect(report.promotionCandidates).toEqual([
      expect.objectContaining({
        userId: 'zhicheng',
        runId: 'direct-editor-conda-probe',
        sourceScopeRef: 'user:zhicheng',
        targetScope: 'global',
        reason: 'accepted_user_local_direct_edit',
        assets: ['role:compute@1.0.0'],
        summary: 'Added conda submodule import probe guidance.',
        evidenceRefs: ['experience:compute-conda-env-probe-submodule-gap@0.1.0'],
        sourceAcceptance: [
          {
            sourceId: 'matos-user-assets-zhicheng',
            acceptedBranch: 'accepted/matos-user-assets-zhicheng/stable',
            commit: 'abc123',
            ok: true,
            pushed: true,
            validationOk: true,
          },
        ],
      }),
    ])
  })

  test('reports no user scopes gracefully', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'matos-dailyreport-empty-'))
    const report = await buildMatOSEvolutionDailyReport({
      cwd: empty,
      runtimeDataDir: join(empty, 'runtime'),
    })
    expect(report.usersScanned).toBe(0)
    expect(report.notes.some(note => note.includes('No user scopes'))).toBe(true)
  })

  test('CLI matos evolve daily-report --json returns the report', async () => {
    const deployRoot = await makeDeployRoot()
    const out: string[] = []
    const code = await runMatOSEvolveCommand(
      [
        'daily-report',
        '--runtime-data-dir',
        join(deployRoot, 'runtime'),
        '--json',
      ],
      {
        cwd: deployRoot,
        env: process.env,
        stdout: text => out.push(text),
        stderr: () => {},
      },
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.mode).toBe('evolution-daily-report')
    expect(parsed.usersScanned).toBe(2)
    expect(parsed.crossUserFailureClusters[0].failureSignature).toBe('sig-shared')
  })
})
