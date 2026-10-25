import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type {
  EvolutionRoleInvocationInput,
  EvolutionRoleRunResult,
} from '../learning/evolutionRoleRunner.js'
import type { MatOSAssetMergePlan } from './mergePlan.js'
import {
  buildMatOSAssetMergeReviewPrompt,
  normalizeMatOSAssetMergeReview,
  reviewMatOSAssetMergeWithLlm,
} from './mergeReview.js'

async function writeFileWithParents(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

function samplePlan(): MatOSAssetMergePlan {
  return {
    schemaVersion: 1,
    upstreamSourceId: 'core-assets',
    targetSourceId: 'alice-assets',
    generatedAt: '2026-06-19T00:00:00.000Z',
    summary: {
      total: 1,
      actions: {
        auto_add: 0,
        auto_metadata: 0,
        llm_user_merge: 1,
        manual_review: 0,
        blocked: 0,
        no_change: 0,
      },
      safeToAutoApply: 0,
      requiresLlmReview: 1,
      requiresUserConfirmation: 1,
    },
    items: [
      {
        action: 'llm_user_merge',
        identityKey: 'role:compute',
        upstreamRef: 'role:compute@1.0.0',
        targetRef: 'role:compute@1.0.0',
        upstreamManifestPath: 'packs/matos-core/roles/compute/asset.json',
        targetManifestPath: 'packs/alice/roles/compute/asset.json',
        upstreamVersion: '1.0.0',
        targetVersion: '1.0.0',
        changedPaths: [
          'packs/matos-core/roles/compute/ROLE.md',
          'packs/alice/roles/compute/ROLE.md',
        ],
        reason:
          'Scoped target already specializes the same asset identity; merge requires semantic comparison and user confirmation.',
        safeToAutoApply: false,
        requiresLlmReview: true,
        requiresUserConfirmation: true,
      },
    ],
  }
}

describe('MatOS asset merge LLM review', () => {
  test('normalizes LLM review output and clamps confidence', () => {
    const normalized = normalizeMatOSAssetMergeReview(
      {
        schemaVersion: 1,
        summary: 'Compute role needs a user-guided merge.',
        items: [
          {
            identityKey: 'role:compute',
            recommendation: 'merge_manually',
            upstreamSummary: 'Core adds safer defaults.',
            targetSummary: 'Alice keeps local queue policy.',
            rationale: 'Both sides contain useful non-overlapping guidance.',
            risks: ['queue policy may change'],
            confidence: 2,
          },
          {
            identityKey: 'missing',
            recommendation: 'unsupported',
            rationale: '',
          },
        ],
      },
      samplePlan(),
      'deepseek-v4-flash',
      false,
    )
    expect(normalized?.enabled).toBe(true)
    if (!normalized || normalized.enabled !== true) {
      throw new Error('expected enabled merge review')
    }
    expect(normalized.items).toHaveLength(1)
    expect(normalized.items[0]).toMatchObject({
      identityKey: 'role:compute',
      action: 'llm_user_merge',
      recommendation: 'merge_manually',
      confidence: 1,
    })
  })

  test('rejects summary-only LLM output when reviewable items exist', () => {
    const normalized = normalizeMatOSAssetMergeReview(
      {
        schemaVersion: 1,
        summary: 'Review generated.',
        items: [
          {
            identityKey: 'missing',
            recommendation: 'apply_upstream',
            rationale: '',
          },
        ],
      },
      samplePlan(),
      'deepseek-v4-flash',
      false,
    )

    expect(normalized).toBeUndefined()
  })

  test('builds a JSON-only prompt with upstream and scoped asset samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-review-prompt-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeFileWithParents(
      join(upstream, 'packs', 'matos-core', 'roles', 'compute', 'ROLE.md'),
      '# Compute\n\nCore shared defaults.\n',
    )
    await writeFileWithParents(
      join(target, 'packs', 'alice', 'roles', 'compute', 'ROLE.md'),
      '# Compute\n\nAlice local queue policy.\n',
    )

    const prompt = await buildMatOSAssetMergeReviewPrompt({
      plan: samplePlan(),
      upstreamRoot: upstream,
      targetRoot: target,
    })

    expect(prompt).toContain('Return JSON only')
    expect(prompt).toContain('Do NOT call any tools')
    expect(prompt).toContain('role:compute')
    expect(prompt).toContain('Core shared defaults')
    expect(prompt).toContain('Alice local queue policy')
  })

  test('prioritizes manifest and instruction files when sampling large asset diffs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-review-priority-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    const changedPaths = [
      ...Array.from({ length: 10 }, (_, index) =>
        `packs/matos-core/skills/big/examples/filler-${index}.txt`
      ),
      'packs/matos-core/skills/big/SKILL.md',
      'packs/matos-core/skills/big/asset.json',
    ]
    for (const path of changedPaths) {
      await writeFileWithParents(join(upstream, path), `filler ${path}\n`)
      await writeFileWithParents(join(target, path), `target ${path}\n`)
    }
    await writeFileWithParents(
      join(upstream, 'packs/matos-core/skills/big/SKILL.md'),
      '# Big Skill\n\nCritical upstream instruction.\n',
    )
    await writeFileWithParents(
      join(upstream, 'packs/matos-core/skills/big/asset.json'),
      '{"id":"big","type":"skill","version":"1.0.0"}\n',
    )
    const plan = samplePlan()
    plan.items[0] = {
      ...plan.items[0],
      identityKey: 'skill:big',
      upstreamRef: 'skill:big@1.0.0',
      targetRef: 'skill:big@1.0.0',
      changedPaths,
    }

    const prompt = await buildMatOSAssetMergeReviewPrompt({
      plan,
      upstreamRoot: upstream,
      targetRoot: target,
    })

    expect(prompt).toContain('Critical upstream instruction')
    expect(prompt).toContain('packs/matos-core/skills/big/asset.json')
  })

  test('runs the hidden self-evolution worker through an injected role runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-review-runner-'))
    const upstream = join(root, 'upstream')
    const target = join(root, 'target')
    await writeFileWithParents(
      join(upstream, 'packs', 'matos-core', 'roles', 'compute', 'ROLE.md'),
      '# Compute\n\nCore shared defaults.\n',
    )
    await writeFileWithParents(
      join(target, 'packs', 'alice', 'roles', 'compute', 'ROLE.md'),
      '# Compute\n\nAlice local queue policy.\n',
    )
    const fakeRunner = async (
      input: EvolutionRoleInvocationInput,
    ): Promise<EvolutionRoleRunResult> => {
      expect(input.role).toBe('self-evolution-worker')
      expect(input.hidden).toBe(true)
      expect(input.maxTurns).toBe(1)
      expect(input.extraArgs).toContain('--disallowed-tools')
      expect(input.prompt).toContain('role:compute')
      return {
        exitCode: 0,
        roleReference: 'role:self-evolution-worker',
        parsedResult: {
          schemaVersion: 1,
          summary: 'Review generated.',
          items: [
            {
              identityKey: 'role:compute',
              recommendation: 'merge_manually',
              upstreamSummary: 'Core shared defaults.',
              targetSummary: 'Alice queue policy.',
              rationale: 'Keep both.',
              risks: ['manual confirmation required'],
              confidence: 0.8,
            },
          ],
        },
        stdout: '',
        stderr: '',
      }
    }

    const review = await reviewMatOSAssetMergeWithLlm({
      cwd: root,
      plan: samplePlan(),
      upstreamRoot: upstream,
      targetRoot: target,
      roleRunner: fakeRunner,
    })

    expect(review.enabled).toBe(true)
    if (review.enabled !== true) {
      throw new Error('expected enabled review')
    }
    expect(review.items[0].recommendation).toBe('merge_manually')
  })

  test('degrades gracefully when the hidden review worker fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-merge-review-failure-'))
    const review = await reviewMatOSAssetMergeWithLlm({
      cwd: root,
      plan: samplePlan(),
      upstreamRoot: join(root, 'upstream'),
      targetRoot: join(root, 'target'),
      roleRunner: async () => ({
        exitCode: 1,
        roleReference: 'role:self-evolution-worker',
        stdout: '',
        stderr: 'boom',
      }),
    })
    expect(review.enabled).toBe(false)
  })
})
