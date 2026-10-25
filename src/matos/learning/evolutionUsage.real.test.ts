import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createMatOSEvolutionSharedPromptCacheRunner,
  MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION,
  type MatOSEvolutionSharedEvidencePrefix,
} from './evolutionSharedPromptCache.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'
import { readMatOSEvolutionDailySpend } from './evolutionBudgetGate.js'
import { runEvolutionRole } from './evolutionRoleRunner.js'

// Explicitly opt in: real native CLI + real configured provider, never a fake executable.
const enabled =
  process.env.MATOS_RUN_REAL_LLM_TESTS === '1' &&
  process.env.MATOS_TOKEN_ACCOUNTING_SMOKE === '1' &&
  Boolean(process.env.DEEPSEEK_API_KEY?.trim())
test.skipIf(!enabled)(
  'real hidden shared worker accounts prefix/stage once and pays nothing on cached replay',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-accounting-real-'))
    const saved = { ...process.env }
    let runner: Awaited<
      ReturnType<typeof createMatOSEvolutionSharedPromptCacheRunner>
    >
    let replay: typeof runner
    try {
      Object.assign(process.env, {
        MATOS_SCOPE_REF: 'core',
        MATOS_SCOPE_ID: 'core',
        MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
        MATOS_SESSION_DIR: join(root, 'sessions'),
        MATOS_AGENT_HOME: join(root, 'home'),
        MATOS_GITEA_DISABLE_OPERATOR_ENV: '1',
        MATOS_EVOLUTION_SHARED_TURN_TIMEOUT_MS: '120000',
        MATOS_EVOLUTION_ROLE_MAX_RETRIES: '0',
      })
      await mkdir(join(root, '.matos'), { recursive: true })
      await writeFile(
        join(root, '.matos/matos.json'),
        JSON.stringify({
          version: 1,
          includeDefaultAssetRoots: false,
          assetRoots: [resolve(import.meta.dir, '../../../matos-assets')],
          execution: { runtimeDataDir: join(root, 'runtime') },
        }),
      )
      const evidence: MatOSEvolutionSharedEvidencePrefix = {
        schemaVersion: 1 as const,
        cacheVersion: MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION,
        jobId: 'usage-smoke',
        events: [
          {
            kind: 'test',
            summary:
              'A numeric accounting smoke test; no assets should be edited.',
          },
        ],
      }
      const source = { cwd: root, jobId: 'usage-smoke', evidence }
      runner = await createMatOSEvolutionSharedPromptCacheRunner(source)
      expect(runner).toBeDefined()
      const stage = {
        cwd: root,
        role: 'user-feedback-critic',
        jobId: 'usage-smoke',
        hidden: true,
        prompt:
          'This is a transport/accounting check. Reply only with JSON: {"schemaVersion":1,"ok":true}. Do not call tools.',
        cacheKeyMaterial: { smoke: root },
        extraArgs: [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS],
        maxTurns: 1,
      }
      const first = await runner!.roleRunner(stage)
      expect(first.exitCode).toBe(0)
      expect(first.usage!.output_tokens).toBeGreaterThan(0)
      const dir = join(root, 'sessions/usage/evolution')
      const files = await readdir(dir)
      expect(files).toHaveLength(2) // actual prefix and stage; not a synthetic charge
      const records = await Promise.all(
        files.map((f) => readFile(join(dir, f), 'utf8').then(JSON.parse)),
      )
      const tokens = records
        .flatMap((r) => r.rows)
        .reduce(
          (sum, r) =>
            sum +
            Object.values(r.usage).reduce((n: number, v) => n + Number(v), 0),
          0,
        )
      const spend = await readMatOSEvolutionDailySpend({ cwd: root })
      expect(spend.totalTokens).toBe(tokens)
      await runner!.close()
      runner = undefined
      replay = await createMatOSEvolutionSharedPromptCacheRunner(source)
      const hit = await replay!.roleRunner(stage)
      expect(hit.cache?.hit).toBe(true)
      expect((await readdir(dir)).length).toBe(2)
      expect(
        (await readMatOSEvolutionDailySpend({ cwd: root })).totalTokens,
      ).toBe(tokens)
      await replay!.close()
      replay = undefined
      const standalone = await runEvolutionRole({
        ...stage,
        cacheKeyMaterial: { smoke: root, standalone: true },
      })
      expect(standalone.exitCode).toBe(0)
      expect((await readdir(dir)).length).toBe(3)
      const standaloneTokens = Object.values(standalone.usage ?? {})
        .filter((v): v is number => typeof v === 'number')
        .reduce((a, b) => a + b, 0)
      expect(
        (await readMatOSEvolutionDailySpend({ cwd: root })).totalTokens,
      ).toBe(tokens + standaloneTokens)
      console.log(
        JSON.stringify({
          smoke: 'real-provider-accounting',
          recordedTurns: 3,
          tokens: tokens + standaloneTokens,
          costUsdEstimate: (await readMatOSEvolutionDailySpend({ cwd: root }))
            .totalCostUsd,
          replayCacheHit: true,
        }),
      )
    } finally {
      await runner?.close()
      await replay?.close()
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  },
  300_000,
)
