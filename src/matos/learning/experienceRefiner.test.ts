import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { EvolutionRoleInvocationInput } from './evolutionRoleRunner.js'
import type { MatOSEvolutionSharedPromptCacheRoleRunner } from './evolutionSharedPromptCache.js'
import { refineMatOSExperienceWithLLM } from './experienceRefiner.js'

describe('MatOS experience LLM refiner', () => {
  test('invokes the experience refiner as a hidden non-persistent role run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-refiner-'))
    const invocations: EvolutionRoleInvocationInput[] = []

    await refineMatOSExperienceWithLLM({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-1.jsonl'),
      events: [
        {
          id: 'event-1',
          type: 'matos.session.completed',
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-1',
          sessionId: 'session-1',
          data: { exitCode: 0 },
          sourcePath: join(root, '.matos', 'sessions', 'session-1.jsonl'),
        },
      ],
      roleRunner: async input => {
        invocations.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:experience-refiner',
          resultText: '{"shouldWrite":false,"reason":"not enough evidence"}',
          parsedResult: { shouldWrite: false, reason: 'not enough evidence' },
          stdout: '',
          stderr: '',
        }
      },
    })

    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({
      cwd: root,
      role: 'experience-refiner',
      jobId: 'experience-refiner-session-1',
      hidden: true,
      maxTurns: 0,
    })
    expect(invocations[0]?.prompt).toContain('Return JSON only')
    expect(invocations[0]?.prompt).toContain('Do not call tools')
    expect(invocations[0]?.prompt).toContain('session-1')
  })

  test('passes prior feedback critic output into the refiner prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-refiner-feedback-'))
    const invocations: EvolutionRoleInvocationInput[] = []

    await refineMatOSExperienceWithLLM({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-feedback.jsonl'),
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'User feedback supports local GPU priority.',
        signals: [
          {
            id: 'feedback-local-gpu-priority',
            kind: 'instruction',
            severity: 'high',
            explicitness: 'explicit',
            claim: 'Prefer local idle GPUs before remote queues.',
            target: {
              assetTypes: ['role', 'skill'],
              roleRefs: ['role:compute'],
              toolNames: ['hpc_submit'],
              workflowRefs: [],
            },
            evidenceExcerpt: '本地的gpu优先级别最高',
            sourceEventRefs: ['event:turn-feedback'],
            confidence: 0.91,
          },
        ],
        decisions: [
          {
            signalId: 'feedback-local-gpu-priority',
            reasonableness: 'strong',
            evidenceSupport: 'supported',
            generalizability: 'role_specific',
            risk: 'low',
            recommendedAction: 'direct_edit',
            why: 'Trace supports making local GPU priority explicit.',
            counterArguments: [
              'Remote queues can still be useful when local GPUs are busy.',
            ],
            confidence: 0.88,
          },
        ],
      },
      events: [
        {
          id: 'turn-feedback',
          type: 'matos.turn.started',
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-feedback',
          sessionId: 'session-feedback',
          roleRef: 'role:compute',
          data: { prompt: '本地的gpu优先级别最高' },
          sourcePath: join(root, '.matos', 'sessions', 'session-feedback.jsonl'),
        },
      ],
      roleRunner: async input => {
        invocations.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:experience-refiner',
          parsedResult: { shouldWrite: false, reason: 'not enough evidence' },
          stdout: '',
          stderr: '',
        }
      },
    })

    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.prompt).toContain('previousLLMOutputs')
    expect(invocations[0]?.prompt).toContain('feedbackAnalysis')
    expect(invocations[0]?.prompt).toContain('recommendedAction')
    expect(invocations[0]?.prompt).toContain('direct_edit')
    expect(invocations[0]?.prompt).toContain('本地的gpu优先级别最高')
  })

  test('uses shared evidence prefix without resending full trajectory text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-refiner-shared-'))
    const invocations: EvolutionRoleInvocationInput[] = []
    const sharedRunner = (async input => {
      invocations.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:experience-refiner',
        parsedResult: { shouldWrite: false, reason: 'not enough evidence' },
        stdout: '',
        stderr: '',
      }
    }) as MatOSEvolutionSharedPromptCacheRoleRunner
    sharedRunner.usesSharedEvidencePrefix = true
    sharedRunner.sharedEvidencePrefixKey = 'shared-prefix-test'
    sharedRunner.sharedEvidenceCwd = root

    await refineMatOSExperienceWithLLM({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-shared.jsonl'),
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'CRITIC-SMALL-OUTPUT',
        signals: [],
        decisions: [],
      },
      events: [
        {
          id: 'turn-shared-refiner',
          type: 'matos.turn.started',
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-shared-refiner',
          sessionId: 'session-shared',
          roleRef: 'role:compute',
          data: { prompt: 'FULL-REFINER-TRAJECTORY-SHOULD-NOT-BE-RESENT' },
          sourcePath: join(root, '.matos', 'sessions', 'session-shared.jsonl'),
        },
      ],
      roleRunner: sharedRunner,
    })

    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.prompt).toContain('matos-evolution-shared-evidence-prefix')
    expect(invocations[0]?.prompt).toContain('CRITIC-SMALL-OUTPUT')
    expect(invocations[0]?.prompt).not.toContain('TrajectoryPackage:')
    expect(invocations[0]?.prompt).not.toContain(
      'FULL-REFINER-TRAJECTORY-SHOULD-NOT-BE-RESENT',
    )
  })

  test('passes the complete trajectory and complete prior LLM analysis into the refiner prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-refiner-full-'))
    const invocations: EvolutionRoleInvocationInput[] = []
    const earlyPrompt = `早期失败背景-${'a'.repeat(1600)}-REFINER-EARLY-END`
    const latePrompt = `后期用户纠正-${'b'.repeat(1600)}-REFINER-LATE-END`

    await refineMatOSExperienceWithLLM({
      cwd: root,
      sessionPath: join(root, '.matos', 'sessions', 'session-full.jsonl'),
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: `critic full detail ${'c'.repeat(1600)}-CRITIC-FULL-END`,
        signals: [],
        decisions: [],
      },
      events: [
        {
          id: 'turn-refiner-early',
          type: 'matos.turn.started',
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-refiner-full',
          sessionId: 'session-full',
          roleRef: 'role:compute',
          data: { prompt: earlyPrompt },
          sourcePath: join(root, '.matos', 'sessions', 'session-full.jsonl'),
        },
        ...Array.from({ length: 210 }, (_, index) => ({
          id: `refiner-tool-${index}`,
          type: 'matos.tool.call.completed' as const,
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-refiner-full',
          sessionId: 'session-full',
          roleRef: 'role:compute',
          data: { toolName: 'Bash', toolUseId: `toolu_${index}`, isError: false },
          sourcePath: join(root, '.matos', 'sessions', 'session-full.jsonl'),
        })),
        {
          id: 'turn-refiner-late',
          type: 'matos.turn.started',
          timestamp: '2026-06-03T00:00:00.000Z',
          traceId: 'trace-refiner-full',
          sessionId: 'session-full',
          roleRef: 'role:compute',
          data: { prompt: latePrompt },
          sourcePath: join(root, '.matos', 'sessions', 'session-full.jsonl'),
        },
      ],
      roleRunner: async input => {
        invocations.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:experience-refiner',
          parsedResult: { shouldWrite: false, reason: 'not enough evidence' },
          stdout: '',
          stderr: '',
        }
      },
    })

    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.prompt).toContain('turn-refiner-early')
    expect(invocations[0]?.prompt).toContain('refiner-tool-0')
    expect(invocations[0]?.prompt).toContain('refiner-tool-209')
    expect(invocations[0]?.prompt).toContain('REFINER-EARLY-END')
    expect(invocations[0]?.prompt).toContain('REFINER-LATE-END')
    expect(invocations[0]?.prompt).toContain('CRITIC-FULL-END')
  })
})
