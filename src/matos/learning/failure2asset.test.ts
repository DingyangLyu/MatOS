import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
} from '../tools/matosToolRunner.js'
import {
  matOSEvolutionProposalPath,
  generateMatOSEvolutionProposals,
  generateMatOSEvolutionDraftAssets,
  listMatOSEvolutionProposals,
  readMatOSEvolutionProposal,
} from './proposalDrafts.js'
import {
  draftMatOSEvolutionBenchmark,
  runMatOSEvolutionBenchmarkRegression,
  runMatOSFailure2AssetFactory,
} from './benchmarkDrafts.js'
import type { MatOSUserTestLogEpisode } from './userTestLogIntake.js'

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-failure2asset-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeFile(
    getMatOSConfigPath(root),
    `${JSON.stringify(
      { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

async function writeEpisode(
  root: string,
  episode: MatOSUserTestLogEpisode,
): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'episodes')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${episode.episodeId}.json`),
    `${JSON.stringify(episode, null, 2)}\n`,
    'utf8',
  )
}

function toolFailureEpisode(
  overrides: Partial<MatOSUserTestLogEpisode> = {},
): MatOSUserTestLogEpisode {
  return {
    schemaVersion: 1,
    episodeId: 'episode-tf-0',
    intakeId: 'intake-x',
    createdAt: '2026-07-09T12:00:00.000Z',
    kind: 'tool-failure',
    summary: 'Tool demo-tool failed 3 time(s) across 2 session(s).',
    observedFailure: 'parse failed: dependency missing',
    suspectedRefs: ['tool:demo-tool'],
    evidenceRefs: { sessionIds: ['s1', 's2'] },
    benchmarkCandidate: { kind: 'tool-call', ref: 'tool:demo-tool' },
    privacy: { redacted: true },
    ...overrides,
  }
}

async function createTargetToolAsset(root: string): Promise<void> {
  const dir = join(root, '.matos', 'assets', 'packs', 'seed', 'tool', 'demo-tool')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(root, '.matos', 'assets', 'packs', 'seed', 'matos.pack.json'),
    `${JSON.stringify({ schemaVersion: 1, id: 'seed', name: 'seed', version: '0.1.0' }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'demo-tool',
        type: 'tool',
        name: 'Demo Tool',
        version: '0.1.0',
        entry: './tool.py',
        metadata: {
          promptPath: 'prompt.md',
          inputSchemaPath: 'input.schema.json',
          executor: {
            type: 'matos-python',
            runtime: 'python3',
            entry: './tool.py',
            timeoutMs: 30000,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'tool.py'), 'print("{}")\n', 'utf8')
  await writeFile(
    join(dir, 'input.schema.json'),
    `${JSON.stringify({ type: 'object', additionalProperties: true }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'prompt.md'), 'demo tool\n', 'utf8')
}

describe('Failure2Asset proposal generation', () => {
  test('tool-failure with a resolved tool asset drafts a preflight proposal', async () => {
    const root = await createFixtureRoot()
    await createTargetToolAsset(root)
    await writeEpisode(root, toolFailureEpisode())

    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-tf-0',
    })
    expect(proposals).toHaveLength(1)
    const proposal = proposals[0]
    expect(proposal.action).toBe('create-tool-preflight')
    expect(proposal.episodeKind).toBe('tool-failure')
    expect(proposal.plannedAssets.map(asset => asset.role).sort()).toEqual([
      'preflight-tool',
      'runbook',
    ])
    expect(proposal.benchmarkPlan.kind).toBe('tool-call')
    expect(proposal.diagnosis.resolvedAssetRefs[0]?.canonicalKey).toBe(
      'tool:demo-tool@0.1.0',
    )
    expect(proposal.gates.promotion.status).toBe('blocked')
    expect(existsSync(matOSEvolutionProposalPath(root, proposal.proposalId))).toBe(
      true,
    )

    const listed = await listMatOSEvolutionProposals(root)
    expect(listed.map(item => item.proposalId)).toContain(proposal.proposalId)
  })

  test('tool-failure without a resolved asset falls back to a runbook proposal', async () => {
    const root = await createFixtureRoot()
    await writeEpisode(
      root,
      toolFailureEpisode({
        episodeId: 'episode-tf-1',
        suspectedRefs: ['tool:not-an-asset'],
      }),
    )
    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-tf-1',
    })
    expect(proposals[0].action).toBe('create-knowledge-runbook')
    expect(proposals[0].plannedAssets).toHaveLength(1)
    expect(proposals[0].benchmarkPlan.kind).toBe('artifact-check')
  })

  test('workflow-failure drafts a workflow-run regression proposal', async () => {
    const root = await createFixtureRoot()
    await writeEpisode(root, {
      schemaVersion: 1,
      episodeId: 'episode-wf-0',
      intakeId: 'intake-x',
      createdAt: '2026-07-09T12:00:00.000Z',
      kind: 'workflow-failure',
      summary: 'Workflow workflow:demo run r1 failed at node screen.',
      observedFailure: 'exec node screen exited 66',
      suspectedRefs: ['workflow:demo'],
      evidenceRefs: { workflowRunIds: ['r1'] },
      benchmarkCandidate: { kind: 'workflow-run', ref: 'workflow:demo' },
      privacy: { redacted: true },
    })
    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-wf-0',
    })
    expect(proposals[0].action).toBe('create-knowledge-runbook')
    expect(proposals[0].benchmarkPlan.kind).toBe('workflow-run')
    expect(proposals[0].benchmarkPlan.subjectRef).toBe('workflow:demo')
  })
})

describe('Failure2Asset draft asset generation', () => {
  test('generates an executable preflight tool + runbook that validate', async () => {
    const root = await createFixtureRoot()
    await createTargetToolAsset(root)
    await writeEpisode(root, toolFailureEpisode())
    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-tf-0',
    })
    const proposalId = proposals[0].proposalId

    const result = await generateMatOSEvolutionDraftAssets({
      cwd: root,
      proposalId,
    })
    expect(result.applied).toBe(true)
    expect(result.status).toBe('applied')
    expect(result.validation.ok).toBe(true)
    expect(result.validation.assetValidation.ok).toBe(true)
    expect(result.validation.missingAssetRefs).toHaveLength(0)
    expect(existsSync(join(root, result.targetPackPath))).toBe(true)

    // The generated preflight tool is a real, loadable, runnable tool asset.
    const assets = await loadMatOSAssets(root)
    const preflight = assets.find(
      asset => asset.type === 'tool' && asset.id.startsWith('preflight-demo-tool'),
    )
    expect(preflight).toBeDefined()
    const validation = await validateMatOSAssets(assets, {
      includeDrafts: true,
      includeDisabled: true,
    })
    expect(validation.ok).toBe(true)

    const tools = await loadMatOSToolDefinitions([preflight!.manifestDir])
    const toolResult = await callMatOSTool(tools[0], {})
    const parsed = JSON.parse(toolResult.stdout) as {
      ok: boolean
      checks: Array<{ key: string; ok: boolean }>
    }
    // The seeded target tool asset is contract-complete, so preflight passes.
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.every(check => check.ok)).toBe(true)

    // Gate recorded on the proposal.
    const updated = await readMatOSEvolutionProposal(root, proposalId)
    expect(updated?.gates.draftAssets.status).toBe('generated')
  })
})

describe('Failure2Asset benchmark regression', () => {
  test('runbook artifact-check fails before draft assets and passes after', async () => {
    const root = await createFixtureRoot()
    await writeEpisode(
      root,
      toolFailureEpisode({
        episodeId: 'episode-tf-2',
        suspectedRefs: ['tool:missing-asset'],
      }),
    )
    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-tf-2',
    })
    const proposalId = proposals[0].proposalId
    expect(proposals[0].benchmarkPlan.kind).toBe('artifact-check')

    await draftMatOSEvolutionBenchmark({ cwd: root, proposalId })
    const before = await runMatOSEvolutionBenchmarkRegression({
      cwd: root,
      proposalId,
    })
    // The runbook artifact does not exist yet.
    expect(before.result.status).toBe('failed')

    await generateMatOSEvolutionDraftAssets({ cwd: root, proposalId })
    const after = await runMatOSEvolutionBenchmarkRegression({
      cwd: root,
      proposalId,
    })
    expect(after.result.status).toBe('succeeded')
    expect(after.result.ok).toBe(true)
    const updated = await readMatOSEvolutionProposal(root, proposalId)
    expect(updated?.gates.validation.status).toBe('succeeded')
  })

  test('tool-call regression is blocked without MATOS_RUN_REAL_BENCHMARKS', async () => {
    const root = await createFixtureRoot()
    await createTargetToolAsset(root)
    await writeEpisode(root, toolFailureEpisode({ episodeId: 'episode-tf-3' }))
    const { proposals } = await generateMatOSEvolutionProposals({
      cwd: root,
      episodeId: 'episode-tf-3',
    })
    const proposalId = proposals[0].proposalId
    await generateMatOSEvolutionDraftAssets({ cwd: root, proposalId })
    await draftMatOSEvolutionBenchmark({ cwd: root, proposalId })

    const prior = process.env.MATOS_RUN_REAL_BENCHMARKS
    delete process.env.MATOS_RUN_REAL_BENCHMARKS
    try {
      const regression = await runMatOSEvolutionBenchmarkRegression({
        cwd: root,
        proposalId,
      })
      expect(regression.result.status).toBe('blocked')
    } finally {
      if (prior !== undefined) {
        process.env.MATOS_RUN_REAL_BENCHMARKS = prior
      }
    }
  })
})

describe('Failure2Asset one-shot factory', () => {
  test('runs episode -> proposals -> draft assets -> benchmark -> regression', async () => {
    const root = await createFixtureRoot()
    await writeEpisode(
      root,
      toolFailureEpisode({
        episodeId: 'episode-factory-0',
        kind: 'user-feedback',
        suspectedRefs: [],
        summary: 'User reported a queue mismatch on VASP submission.',
        benchmarkCandidate: undefined,
      }),
    )
    const result = await runMatOSFailure2AssetFactory({
      cwd: root,
      episodeId: 'episode-factory-0',
    })
    expect(result.proposals).toHaveLength(1)
    const proposal = result.proposals[0]
    expect(proposal.draftAssets.applied).toBe(true)
    expect(proposal.benchmark.kind).toBe('artifact-check')
    expect(proposal.regression.status).toBe('succeeded')
    expect(proposal.gates.validation.status).toBe('succeeded')

    const packDir = join(root, proposal.draftAssets.targetPackPath)
    expect(existsSync(packDir)).toBe(true)
    const knowledgeManifestGlob = join(
      packDir,
      'knowledge',
    )
    expect(existsSync(knowledgeManifestGlob)).toBe(true)
  })
})
