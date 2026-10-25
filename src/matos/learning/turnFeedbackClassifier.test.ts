import { describe, expect, test } from 'bun:test'
import type { EvolutionRoleInvocationInput } from './evolutionRoleRunner.js'
import {
  classifyMatOSTurnFeedbackWithLLM,
  normalizeMatOSTurnFeedbackClassification,
  realtimeTurnFeedbackKinds,
  shouldSemanticallyClassifyTurnPrompt,
  shouldTriggerRealtimeTurnFeedback,
  turnFeedbackClassifierPrompt,
  turnSemanticClassifierEnabled,
  TURN_FEEDBACK_CLASSIFIER_CACHE_VERSION,
  TURN_FEEDBACK_CLASSIFIER_PROMPT_LIMIT,
} from './turnFeedbackClassifier.js'

describe('MatOS turn feedback classifier', () => {
  test('normalizes valid classifications and clamps confidence', () => {
    expect(
      normalizeMatOSTurnFeedbackClassification({
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['correction', 'correction', 'frustration', 'not-a-kind'],
        confidence: 1.7,
        summary: 'User corrected the agent.',
      }),
    ).toEqual({
      schemaVersion: 1,
      isFeedback: true,
      kinds: ['correction', 'frustration'],
      confidence: 1,
      summary: 'User corrected the agent.',
    })
  })

  test('rejects invalid shapes and downgrades feedback without kinds', () => {
    expect(normalizeMatOSTurnFeedbackClassification(undefined)).toBeUndefined()
    expect(normalizeMatOSTurnFeedbackClassification('yes')).toBeUndefined()
    expect(
      normalizeMatOSTurnFeedbackClassification({ kinds: ['correction'] }),
    ).toBeUndefined()
    expect(
      normalizeMatOSTurnFeedbackClassification({
        isFeedback: true,
        kinds: ['unknown-kind'],
        confidence: 0.9,
      }),
    ).toMatchObject({ isFeedback: false, kinds: [] })
  })

  test('gates prompts that are too short or slash commands', () => {
    expect(shouldSemanticallyClassifyTurnPrompt('')).toBe(false)
    expect(shouldSemanticallyClassifyTurnPrompt('  继续  ')).toBe(false)
    expect(shouldSemanticallyClassifyTurnPrompt('/compact now')).toBe(false)
    expect(
      shouldSemanticallyClassifyTurnPrompt('怎么每次都要我提醒你激活环境'),
    ).toBe(true)
  })

  test('environment switch disables the semantic classifier', () => {
    expect(turnSemanticClassifierEnabled({})).toBe(true)
    expect(
      turnSemanticClassifierEnabled({
        MATOS_EVOLUTION_TURN_SEMANTIC_CLASSIFIER: 'off',
      }),
    ).toBe(false)
    expect(
      turnSemanticClassifierEnabled({
        MATOS_EVOLUTION_TURN_SEMANTIC_CLASSIFIER: 'disabled',
      }),
    ).toBe(false)
  })

  test('keeps stable instructions before the variable user message', () => {
    const prompt = turnFeedbackClassifierPrompt('换个思路吧，刚才那个方向不对路')
    const messageIndex = prompt.indexOf('换个思路吧')
    expect(prompt.indexOf('realtime turn-feedback classifier')).toBeLessThan(
      messageIndex,
    )
    expect(prompt.indexOf('Return exactly this JSON shape')).toBeLessThan(
      messageIndex,
    )
    expect(prompt).toContain('<<<')
    expect(prompt).toContain('>>>')
  })

  test('coerces string boolean isFeedback values', () => {
    expect(
      normalizeMatOSTurnFeedbackClassification({
        schemaVersion: 1,
        isFeedback: 'true',
        kinds: ['correction'],
        confidence: 0.8,
      })?.isFeedback,
    ).toBe(true)
    expect(
      normalizeMatOSTurnFeedbackClassification({
        schemaVersion: 1,
        isFeedback: 'false',
        kinds: [],
        confidence: 0.1,
      })?.isFeedback,
    ).toBe(false)
    expect(
      normalizeMatOSTurnFeedbackClassification({
        schemaVersion: 1,
        isFeedback: 'maybe',
        kinds: [],
        confidence: 0.1,
      }),
    ).toBeUndefined()
  })

  test('truncates oversized turn messages keeping head and tail', () => {
    const message = `HEAD_MARKER${'a'.repeat(
      TURN_FEEDBACK_CLASSIFIER_PROMPT_LIMIT + 500,
    )}TAIL_MARKER`
    const prompt = turnFeedbackClassifierPrompt(message)
    expect(prompt).toContain('[...truncated...]')
    // Head AND tail are preserved so trailing standing-expectation feedback
    // (e.g. "以后都...") at the end of a long message is not dropped.
    expect(prompt).toContain('HEAD_MARKER')
    expect(prompt).toContain('TAIL_MARKER')
    expect(prompt.length).toBeLessThan(
      TURN_FEEDBACK_CLASSIFIER_PROMPT_LIMIT + 2_000,
    )
  })

  test('realtime trigger requires confidence and a non-acceptance kind', () => {
    expect(
      realtimeTurnFeedbackKinds({
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['correction', 'acceptance'],
        confidence: 0.9,
      }),
    ).toEqual(['correction'])
    expect(
      shouldTriggerRealtimeTurnFeedback({
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['acceptance'],
        confidence: 0.95,
      }),
    ).toBe(false)
    expect(
      shouldTriggerRealtimeTurnFeedback({
        schemaVersion: 1,
        isFeedback: true,
        kinds: ['frustration'],
        confidence: 0.4,
      }),
    ).toBe(false)
    expect(shouldTriggerRealtimeTurnFeedback(undefined)).toBe(false)
  })

  test('classifies through the evolution role runner with cache material', async () => {
    const calls: EvolutionRoleInvocationInput[] = []
    const classification = await classifyMatOSTurnFeedbackWithLLM(
      {
        cwd: '/tmp/example',
        sessionId: 'session-1',
        eventId: 'turn-9',
        prompt: '怎么又把环境搞坏了，上次就说过要先激活 matos 环境',
      },
      async input => {
        calls.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:turn-feedback-classifier',
          resultText: '',
          parsedResult: {
            schemaVersion: 1,
            isFeedback: true,
            kinds: ['frustration', 'correction'],
            confidence: 0.92,
            summary: 'Repeated environment mistake.',
          },
          stdout: '',
          stderr: '',
        }
      },
    )

    expect(classification).toMatchObject({
      isFeedback: true,
      kinds: ['frustration', 'correction'],
      confidence: 0.92,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      role: 'turn-feedback-classifier',
      jobId: 'turn-feedback-classifier-session-1-turn-9',
      hidden: true,
      maxTurns: 1,
    })
    expect(calls[0]?.cacheKeyMaterial).toMatchObject({
      cacheVersion: TURN_FEEDBACK_CLASSIFIER_CACHE_VERSION,
    })
    expect(calls[0]?.prompt).toContain('怎么又把环境搞坏了')
  })

  test('returns undefined when the classifier role run fails', async () => {
    const classification = await classifyMatOSTurnFeedbackWithLLM(
      {
        cwd: '/tmp/example',
        sessionId: 'session-1',
        eventId: 'turn-10',
        prompt: '这个结果看起来怪怪的，确认一下收敛设置',
      },
      async () => ({
        exitCode: 1,
        roleReference: 'role:turn-feedback-classifier',
        stdout: '',
        stderr: 'provider unavailable',
      }),
    )
    expect(classification).toBeUndefined()
  })
})
