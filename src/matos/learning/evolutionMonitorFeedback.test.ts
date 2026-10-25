import { describe, expect, test } from 'bun:test'
import {
  classifyPromptUserFeedbackSignal,
  promptIndicatesUserFeedback,
} from './evolutionMonitorFeedback.js'

describe('MatOS user feedback prompt heuristic', () => {
  test('explicit CJK and English complaints confirm directly', () => {
    for (const prompt of [
      '不对，这里做错了，需要修改。',
      '又报错了，还是那个队列问题',
      '这个 workflow 做得不好，不是很满意',
      'this run is broken again',
      '这个工具不好用，卡住了',
      "the pipeline still doesn't work",
    ]) {
      expect(classifyPromptUserFeedbackSignal(prompt)).toBe('confirmed')
      expect(promptIndicatesUserFeedback(prompt)).toBe(true)
    }
  })

  test('bare technical words only mark a semantic candidate', () => {
    for (const prompt of [
      'add error handling to utils.py',
      'my VASP job failed, please resubmit it',
      '帮我查一下这个报错是什么意思',
      '结果不对的话就换个泛函重算',
      'the bad-pixel mask needs regeneration',
    ]) {
      expect(classifyPromptUserFeedbackSignal(prompt)).toBe('candidate')
      expect(promptIndicatesUserFeedback(prompt)).toBe(false)
    }
  })

  test('A-not-A questions are not treated as feedback at all', () => {
    for (const prompt of [
      '你看这样改对不对？',
      '这个参数行不行，你确认一下',
      '收敛标准这样设好不好？',
    ]) {
      expect(classifyPromptUserFeedbackSignal(prompt)).toBe('none')
    }
  })

  test('CJK negations of errors are not treated as feedback', () => {
    for (const prompt of [
      '现在没有报错了，继续下一步',
      '这次没报错了，挺好',
      '注意别报错了，先做个干跑',
    ]) {
      expect(classifyPromptUserFeedbackSignal(prompt)).toBe('none')
    }
  })

  test('question forms mixed with real feedback still confirm', () => {
    expect(classifyPromptUserFeedbackSignal('行不行啊你，这里又错了')).toBe(
      'confirmed',
    )
  })

  test('hedged mixed prompts fall back to the candidate classifier', () => {
    expect(
      classifyPromptUserFeedbackSignal('对不对先不管，反正结果不对'),
    ).toBe('candidate')
  })

  test('English negation neutralizes only the negated span', () => {
    expect(
      classifyPromptUserFeedbackSignal('finished with no error at all'),
    ).toBe('none')
    // The real feedback part after a negated span must survive.
    expect(
      classifyPromptUserFeedbackSignal(
        'no error now, but the plot is still wrong',
      ),
    ).toBe('confirmed')
    expect(classifyPromptUserFeedbackSignal('there is an error in the run')).toBe(
      'candidate',
    )
  })

  test('hedged understanding-check phrases are neutralized', () => {
    expect(
      classifyPromptUserFeedbackSignal('如果我理解错了请指出，我们继续'),
    ).toBe('none')
  })
})
