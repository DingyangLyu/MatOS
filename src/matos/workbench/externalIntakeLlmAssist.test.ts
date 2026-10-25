import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type {
  EvolutionRoleInvocationInput,
  EvolutionRoleRunResult,
} from '../learning/evolutionRoleRunner.js'
import { classifyMatOSExternalIntakeSource } from './externalIntakeClassification.js'
import {
  buildExternalIntakeLlmAssistPrompt,
  collectExternalIntakeSourceSample,
  normalizeMatOSExternalIntakeLlmAssist,
  refineMatOSExternalIntakeWithLlm,
} from './externalIntakeLlmAssist.js'

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'matos-llmassist-repo-'))
  await writeFile(
    join(repo, 'README.md'),
    '# Relax CLI\n\nRelaxes a crystal with ASE.\n\n```bash\npython relax.py input.cif\n```\n',
    'utf8',
  )
  await writeFile(join(repo, 'requirements.txt'), 'ase\npymatgen\n', 'utf8')
  await writeFile(
    join(repo, 'relax.py'),
    'import sys\n\n\ndef main() -> None:\n    print(sys.argv)\n\n\nif __name__ == "__main__":\n    main()\n',
    'utf8',
  )
  return repo
}

describe('external intake LLM assist (deterministic)', () => {
  test('normalizes a valid assist payload and caps/clamps fields', () => {
    const normalized = normalizeMatOSExternalIntakeLlmAssist(
      {
        schemaVersion: 1,
        summary: 'A CLI that relaxes structures with ASE.',
        primaryAssetType: 'tool',
        entrypoints: [
          { path: 'relax.py', command: 'python relax.py input.cif', description: 'relax' },
          { notPath: true },
        ],
        dependencies: ['ase', 'pymatgen', 'ase', 42],
        exampleIo: ['cif -> relaxed energy'],
        preflight: ['conda env with ase'],
        license: 'MIT',
        provenanceNotes: 'from local repo',
        proposalAnnotations: [
          { ref: 'tool:relax', recommendedType: 'tool', confidence: 1.9, rationale: 'runnable' },
          { ref: 'x', recommendedType: 'not-a-type', confidence: 0.5, rationale: 'kept, type dropped' },
          { ref: 'no-rationale' },
        ],
        rerankedProposalRefs: ['tool:relax', 'knowledge:relax'],
      },
      'deepseek-v4-flash',
      false,
    )
    expect(normalized?.enabled).toBe(true)
    if (!normalized || normalized.enabled !== true) {
      throw new Error('expected enabled assist')
    }
    expect(normalized.primaryAssetType).toBe('tool')
    expect(normalized.entrypoints).toHaveLength(1)
    expect(normalized.entrypoints[0].path).toBe('relax.py')
    expect(normalized.dependencies).toEqual(['ase', 'pymatgen'])
    expect(normalized.proposalAnnotations).toHaveLength(2)
    expect(normalized.proposalAnnotations[0].confidence).toBe(1)
    expect(normalized.proposalAnnotations[1].recommendedType).toBeUndefined()
    expect(normalized.rerankedProposalRefs).toEqual(['tool:relax', 'knowledge:relax'])
  })

  test('rejects non-object and empty payloads', () => {
    expect(normalizeMatOSExternalIntakeLlmAssist(undefined, 'm', false)).toBeUndefined()
    expect(normalizeMatOSExternalIntakeLlmAssist('json', 'm', false)).toBeUndefined()
    expect(normalizeMatOSExternalIntakeLlmAssist({}, 'm', false)).toBeUndefined()
  })

  test('collects a readable source sample and builds a JSON-only prompt', async () => {
    const repo = await makeRepo()
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: repo,
      path: repo,
    })
    const sample = await collectExternalIntakeSourceSample({ classification })
    expect(sample).toContain('relax.py')
    expect(sample.toLowerCase()).toContain('ase')
    const prompt = buildExternalIntakeLlmAssistPrompt({ classification, sourceSample: sample })
    expect(prompt).toContain('Return JSON only')
    expect(prompt).toContain('Do NOT call any tools')
    expect(prompt).toContain('Proposals:')
  })

  test('refine uses the injected runner and returns an enabled assist', async () => {
    const repo = await makeRepo()
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: repo,
      path: repo,
    })
    const fakeRunner = async (
      input: EvolutionRoleInvocationInput,
    ): Promise<EvolutionRoleRunResult> => {
      expect(input.role).toBe('source-library-architect')
      expect(input.maxTurns).toBe(1)
      expect(input.extraArgs).toContain('--disallowed-tools')
      return {
        exitCode: 0,
        roleReference: 'role:source-library-architect',
        parsedResult: {
          schemaVersion: 1,
          summary: 'CLI relaxing crystals with ASE',
          primaryAssetType: 'tool',
          entrypoints: [{ path: 'relax.py', command: 'python relax.py input.cif' }],
          dependencies: ['ase', 'pymatgen'],
          exampleIo: ['cif -> relaxed energy'],
          preflight: ['conda env with ase+pymatgen'],
          license: 'unknown',
          proposalAnnotations: [],
          rerankedProposalRefs: [],
        },
        stdout: '',
        stderr: '',
      }
    }
    const assist = await refineMatOSExternalIntakeWithLlm({
      cwd: repo,
      classification,
      roleRunner: fakeRunner,
    })
    expect(assist.enabled).toBe(true)
    if (assist.enabled !== true) {
      throw new Error('expected enabled assist')
    }
    expect(assist.entrypoints[0].path).toBe('relax.py')
    expect(assist.dependencies).toContain('ase')
  })

  test('refine degrades gracefully on runner failure and bad JSON', async () => {
    const repo = await makeRepo()
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: repo,
      path: repo,
    })
    const failing = await refineMatOSExternalIntakeWithLlm({
      cwd: repo,
      classification,
      roleRunner: async () => ({
        exitCode: 1,
        roleReference: 'role:source-library-architect',
        stdout: '',
        stderr: 'boom',
      }),
    })
    expect(failing.enabled).toBe(false)

    const garbage = await refineMatOSExternalIntakeWithLlm({
      cwd: repo,
      classification,
      roleRunner: async () => ({
        exitCode: 0,
        roleReference: 'role:source-library-architect',
        parsedResult: 'not-json-object',
        stdout: '',
        stderr: '',
      }),
    })
    expect(garbage.enabled).toBe(false)
  })
})

// Explicit opt-in AND credential presence, matching benchmarkRunner.real.test.ts.
// Token presence alone must not silently trigger real provider calls in CI/unit lanes.
const runRealLlm =
  process.env.MATOS_RUN_REAL_LLM_TESTS === '1' &&
  Boolean(process.env.DEEPSEEK_API_KEY)

describe('external intake LLM assist (real DeepSeek)', () => {
  ;(runRealLlm ? test : test.skip)(
    'refines a real repo with the real role runner',
    async () => {
      const repo = await makeRepo()
      const classification = await classifyMatOSExternalIntakeSource({
        cwd: repo,
        path: repo,
      })
      const assist = await refineMatOSExternalIntakeWithLlm({
        cwd: repo,
        classification,
        model: process.env.MATOS_INTAKE_LLM_ASSIST_MODEL ?? 'deepseek-v4-flash',
      })
      if (assist.enabled === false) {
        throw new Error(`real LLM assist did not enable: ${assist.reason}`)
      }
      expect(assist.summary.length).toBeGreaterThan(0)
      const text = JSON.stringify(assist).toLowerCase()
      expect(text).toContain('ase')
    },
    180_000,
  )
})
