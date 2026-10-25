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
import { runMatOSBenchmarkCase } from '../learning/benchmarkRunner.js'
import {
  applyMatOSWorkbenchExternalIntakeDraftPack,
  previewMatOSWorkbenchExternalIntakeDraftPack,
} from './externalIntakeDraftPack.js'
import { chooseMatOSExternalIntakeToolEntrypoint } from './externalIntakeExecutableEntries.js'
import { classifyMatOSExternalIntakeSource } from './externalIntakeClassification.js'

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-intake-exec-'))
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

async function createRunnableRepo(root: string, name = 'runnablekit'): Promise<string> {
  const repo = join(root, 'sources', name)
  await mkdir(repo, { recursive: true })
  await writeFile(
    join(repo, 'README.md'),
    `# ${name}\n\nA runnable CLI that echoes JSON.\n\n## Usage\n\n\`\`\`bash\npython3 main.py\n\`\`\`\n`,
    'utf8',
  )
  await writeFile(join(repo, 'requirements.txt'), 'rich\n', 'utf8')
  // Top-level Python packaging + console script makes this a tool-first bundle.
  await writeFile(
    join(repo, 'pyproject.toml'),
    [
      '[project]',
      `name = "${name}"`,
      'version = "0.1.0"',
      '',
      '[project.scripts]',
      `${name} = "${name}:main"`,
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(repo, 'main.py'),
    'import json, sys\n\n\ndef main():\n    print(json.dumps({"runnablekit": "ok", "args": sys.argv[1:]}))\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main())\n',
    'utf8',
  )
  return repo
}

async function createPaperMarkdown(root: string): Promise<string> {
  const dir = join(root, 'sources', 'papers')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'method.md')
  await writeFile(
    path,
    '# A Fast Method For X\n\n## Abstract\n\nWe describe a reproducible method for computing X with lower cost.\n\n## Methods\n\nWe use a three-step procedure.\n',
    'utf8',
  )
  return path
}

describe('external intake entrypoint detection', () => {
  test('prefers root main.py deterministically', async () => {
    const root = await createFixtureRoot()
    await createRunnableRepo(root)
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/runnablekit',
    })
    const wrapper = chooseMatOSExternalIntakeToolEntrypoint({ classification })
    expect(wrapper).toEqual({
      sourceEntry: 'main.py',
      runtime: 'python3',
      origin: 'deterministic',
    })
  })

  test('rejects unsafe llm entrypoints and falls back to deterministic', async () => {
    const root = await createFixtureRoot()
    await createRunnableRepo(root)
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/runnablekit',
    })
    const wrapper = chooseMatOSExternalIntakeToolEntrypoint({
      classification,
      llmAssist: {
        enabled: true,
        schemaVersion: 1,
        model: 'test',
        summary: 'x',
        entrypoints: [
          { path: '../../etc/passwd' },
          { path: 'main.py; rm -rf /' },
          { path: 'does-not-exist.py' },
        ],
        dependencies: [],
        exampleIo: [],
        preflight: [],
        proposalAnnotations: [],
        rerankedProposalRefs: [],
        cacheHit: false,
      },
    })
    // All LLM entrypoints are unsafe/nonexistent; deterministic main.py wins.
    expect(wrapper?.sourceEntry).toBe('main.py')
    expect(wrapper?.origin).toBe('deterministic')
  })
})

describe('external intake executable draft packs', () => {
  test('repo2asset --executable generates a runnable tool wrapper + benchmarks', async () => {
    const root = await createFixtureRoot()
    await createRunnableRepo(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/runnablekit',
      executable: true,
      withBenchmark: true,
    })
    expect(preview.validation.ok).toBe(true)
    expect(preview.plan.executable?.toolWrapper?.sourceEntry).toBe('main.py')
    const roles = preview.plan.proposedAssets.map(asset => asset.role)
    expect(roles).toContain('classified')
    expect(roles).toContain('derived-benchmark-integrity')
    expect(roles).toContain('derived-benchmark-tool-smoke')
    const toolAsset = preview.plan.proposedAssets.find(
      asset => asset.type === 'tool',
    )
    expect(toolAsset?.executable).toBe(true)

    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/runnablekit',
      executable: true,
      withBenchmark: true,
      fingerprint: preview.transaction.confirmationFingerprint,
    })
    expect(applied.applied).toBe(true)
    expect(applied.validation.ok).toBe(true)

    // The generated tool asset is real and runnable through the tool runner.
    const assets = await loadMatOSAssets(root)
    const validation = await validateMatOSAssets(assets, {
      includeDrafts: true,
      includeDisabled: true,
    })
    expect(validation.ok).toBe(true)
    const tool = assets.find(
      asset => asset.type === 'tool' && asset.id === 'runnablekit',
    )
    expect(tool).toBeDefined()
    const tools = await loadMatOSToolDefinitions([tool!.manifestDir])
    const dryRun = await callMatOSTool(tools[0], { dryRun: true })
    const dryParsed = JSON.parse(dryRun.stdout) as {
      ok: boolean
      mode: string
      preflight: Array<{ ok: boolean }>
    }
    expect(dryParsed.mode).toBe('dry-run')
    expect(dryParsed.ok).toBe(true)
    const realRun = await callMatOSTool(tools[0], { args: ['--x', '1'] })
    const realParsed = JSON.parse(realRun.stdout) as {
      ok: boolean
      exitCode: number
      stdout: string
    }
    expect(realParsed.ok).toBe(true)
    expect(realParsed.exitCode).toBe(0)
    expect(realParsed.stdout).toContain('runnablekit')

    // The generated dry-run smoke benchmark passes through the shared runner.
    const smokePath = join(
      root,
      '.matos/assets/packs/intake-runnablekit/benchmark/runnablekit-tool-smoke/case.json',
    )
    expect(existsSync(smokePath)).toBe(true)
    const prior = process.env.MATOS_RUN_REAL_BENCHMARKS
    process.env.MATOS_RUN_REAL_BENCHMARKS = '1'
    try {
      const smoke = await runMatOSBenchmarkCase({
        cwd: root,
        benchmarkRef: 'benchmark:runnablekit-tool-smoke@0.1.0',
        casePath: smokePath,
      })
      expect(smoke.ok).toBe(true)
    } finally {
      if (prior === undefined) {
        delete process.env.MATOS_RUN_REAL_BENCHMARKS
      } else {
        process.env.MATOS_RUN_REAL_BENCHMARKS = prior
      }
    }
  })

  test('paper2asset --executable extracts real text into KNOWLEDGE.md', async () => {
    const root = await createFixtureRoot()
    const paperPath = await createPaperMarkdown(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: paperPath,
      executable: true,
    })
    expect(preview.validation.ok).toBe(true)
    expect(preview.plan.executable?.paper?.extraction.ok).toBe(true)
    expect(preview.plan.executable?.paper?.extraction.method).toBe('plain-read')

    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: paperPath,
      executable: true,
      fingerprint: preview.transaction.confirmationFingerprint,
    })
    expect(applied.applied).toBe(true)
    const knowledge = await readFile(
      join(
        root,
        '.matos/assets/packs/intake-method/knowledge/method/KNOWLEDGE.md',
      ),
      'utf8',
    )
    expect(knowledge).toContain('A Fast Method For X')
    expect(knowledge).toContain('reproducible method for computing X')
    expect(knowledge).toContain('Source path: sources/papers/method.md')
  })

  test('executable preview fingerprint is stable across repeated previews', async () => {
    const root = await createFixtureRoot()
    await createRunnableRepo(root)
    const first = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/runnablekit',
      executable: true,
      withBenchmark: true,
    })
    const second = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/runnablekit',
      executable: true,
      withBenchmark: true,
    })
    expect(second.transaction.confirmationFingerprint).toBe(
      first.transaction.confirmationFingerprint,
    )
  })
})
