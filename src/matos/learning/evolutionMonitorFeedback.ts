// Explicit feedback phrases confirm a user-feedback trigger directly: they are
// unambiguous complaints/corrections in both languages. Keep this list free of
// bare technical words; those live in the weak list below and must pass the
// semantic turn classifier before any hidden LLM analysis runs.
const USER_FEEDBACK_STRONG_PHRASES = [
  '做得不好',
  '做的不好',
  '做错',
  '不是很满意',
  '不满意',
  '需要修改',
  '修一下',
  '改一下',
  '重蹈覆辙',
  '生气',
  '不好用',
  '有bug',
  '跑不起来',
  '卡住了',
  '崩了',
  '又错',
  '又报错',
  '又失败',
  '还是错',
  '还是不对',
  '没生效',
  '不生效',
  'not working',
  "doesn't work",
  "doesnt work",
  'still wrong',
  'still broken',
  'still failing',
  'wrong again',
  'broken again',
  'failing again',
  'failed again',
]

// Weak signals: real feedback often contains them, but so do brand-new task
// prompts ("my VASP job failed, resubmit it"), pasted logs, and hedged
// questions. Production data showed bare `error`/`failed` prompts firing the
// full hidden critic pipeline on benign engineering requests - the single
// largest evolution spend leak. These words now only mark the turn as a
// semantic candidate; the cached fast classifier decides whether it is
// actually feedback.
const USER_FEEDBACK_WEAK_PHRASES = [
  '错了',
  '不对',
  '不行',
  '垃圾',
  '失败了',
  '报错了',
  '报错',
  '有问题',
  '没用',
  '没反应',
  '太慢了',
  'wrong',
  'bad',
  'broken',
  'failed',
  'error',
]

// Derived conservatively from the MCP random-id avoid list plus user-test
// feedback examples. Do not import the full blocklist here: it contains
// protected-class slurs and short substrings such as "ass" that are useful for
// random IDs but too noisy for user-feedback detection.
const USER_FEEDBACK_STRONG_NEGATIVE_WORDS = [
  'fuck',
  'fucking',
  'wtf',
  'shit',
  'damn',
  'crap',
  'piss',
  'pissed',
  'bitch',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function englishWordPattern(value: string): string {
  return `\\b${escapeRegExp(value)}\\b`
}

function feedbackPattern(phrases: string[]): RegExp {
  return new RegExp(
    phrases
      .map(phrase =>
        /^[\x00-\x7F]+$/.test(phrase)
          ? englishWordPattern(phrase)
          : escapeRegExp(phrase),
      )
      .join('|'),
    'i',
  )
}

const USER_FEEDBACK_STRONG_PATTERN = feedbackPattern([
  ...USER_FEEDBACK_STRONG_PHRASES,
  ...USER_FEEDBACK_STRONG_NEGATIVE_WORDS,
])

const USER_FEEDBACK_WEAK_PATTERN = feedbackPattern(USER_FEEDBACK_WEAK_PHRASES)

// English negation guard. Like the CJK guard below it neutralizes only the
// matched span instead of rejecting the whole prompt, so "no error now, but
// the plot is still wrong" keeps its real feedback part.
const USER_FEEDBACK_NEGATIVE_CONTEXT =
  /\b(?:no|without|zero|not?\s+a)\s+(?:error|failure|fail(?:ed|ure)?)\b/gi

// CJK counterpart, kept deliberately narrow: A-not-A question forms
// ("对不对/行不行/好不好") and error negations ("没(有)报错/别报错") contain
// feedback phrases as substrings but are not feedback. Neutralize just those
// spans so mixed messages like "行不行啊，这里又错了" still trigger on the
// real feedback part.
const USER_FEEDBACK_CJK_NEUTRALIZED_CONTEXT =
  /对不对|行不行|好不好|没有报错|没报错|别报错|如果.{0,4}错了|理解错了/g

export type MatOSPromptFeedbackSignal = 'confirmed' | 'candidate' | 'none'

/**
 * Classify how strongly a user prompt reads as feedback about the assistant's
 * previous work. `confirmed` fires the user-feedback trigger directly;
 * `candidate` defers to the semantic turn classifier (cheap, cached);
 * `none` leaves the turn to the generic candidate machinery.
 */
export function classifyPromptUserFeedbackSignal(
  prompt: string,
): MatOSPromptFeedbackSignal {
  const neutralized = prompt
    .replace(USER_FEEDBACK_CJK_NEUTRALIZED_CONTEXT, ' ')
    .replace(USER_FEEDBACK_NEGATIVE_CONTEXT, ' ')
  if (USER_FEEDBACK_STRONG_PATTERN.test(neutralized)) {
    return 'confirmed'
  }
  if (USER_FEEDBACK_WEAK_PATTERN.test(neutralized)) {
    return 'candidate'
  }
  return 'none'
}

export function promptIndicatesUserFeedback(prompt: string): boolean {
  return classifyPromptUserFeedbackSignal(prompt) === 'confirmed'
}
