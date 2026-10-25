import {
  resolveWorkflowTemplateValue,
  type WorkflowExpressionContext,
} from './workflowExpressions.js'

export type WorkflowConditionEvaluation = {
  ok: boolean
  observed?: unknown
  expected?: unknown
}

type ComparisonOperator = '==' | '!=' | '>=' | '<=' | '>' | '<'
type ContainsOperator = 'contains' | 'not contains'

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') {
    return true
  }
  if (trimmed === 'false') {
    return false
  }
  if (trimmed === 'null') {
    return null
  }
  const numeric = Number(trimmed)
  if (trimmed.length > 0 && Number.isFinite(numeric)) {
    return numeric
  }
  return trimmed
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right)
  }
  return String(left).trim() === String(right).trim()
}

function orderedCompare(
  left: unknown,
  right: unknown,
  operator: '>' | '<' | '>=' | '<=',
): boolean {
  const leftNum = Number(left)
  const rightNum = Number(right)
  const numeric = Number.isFinite(leftNum) && Number.isFinite(rightNum)
  const [a, b]: [number | string, number | string] = numeric
    ? [leftNum, rightNum]
    : [String(left).trim(), String(right).trim()]
  switch (operator) {
    case '>':
      return a > b
    case '<':
      return a < b
    case '>=':
      return a >= b
    case '<=':
      return a <= b
    default:
      return false
  }
}

// Split an expression on a top-level operator, ignoring occurrences nested in
// quotes, parentheses, or bracket lists so operands may contain those chars.
function splitTopLevel(expression: string, operator: '||' | '&&'): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ''
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index] ?? ''
    if (quote) {
      current += char
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[') {
      depth += 1
      current += char
      continue
    }
    if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(current)
      current = ''
      index += operator.length - 1
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function isFullyParenthesized(expression: string): boolean {
  if (!expression.startsWith('(') || !expression.endsWith(')')) {
    return false
  }
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index] ?? ''
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0 && index !== expression.length - 1) {
        return false
      }
    }
  }
  return depth === 0
}

const NO_TEMPLATE_VALUES: Map<string, unknown> = new Map()

function evaluateLeaf(expression: string): WorkflowConditionEvaluation {
  return evaluateLeafWithValues(expression, NO_TEMPLATE_VALUES)
}

function evaluateLeafWithValues(
  expression: string,
  values: Map<string, unknown>,
): WorkflowConditionEvaluation {
  const trimmed = expression.trim()
  if (trimmed.length === 0) {
    return { ok: true }
  }

  const contains = trimmed.match(/^(.+?)\s+(not\s+contains|contains)\s+(.+)$/)
  if (contains) {
    const left = resolveOperand(contains[1] ?? '', values)
    const operator = (contains[2] ?? 'contains').trim() as ContainsOperator
    const right = resolveOperand(contains[3] ?? '', values)
    const matched = String(left).includes(String(right))
    return {
      ok: operator === 'not contains' ? !matched : matched,
      observed: left,
      expected: right,
    }
  }

  const membership = trimmed.match(/^(.+?)\s+in\s+\[(.*)\]$/)
  if (membership) {
    const left = resolveOperand(membership[1] ?? '', values)
    const items = (membership[2] ?? '')
      .split(',')
      .map(item => resolveOperand(item, values))
    return {
      ok: items.some(value => sameValue(left, value)),
      observed: left,
      expected: items,
    }
  }

  const comparison = trimmed.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/)
  if (comparison) {
    const left = resolveOperand(comparison[1] ?? '', values)
    const operator = comparison[2] as ComparisonOperator
    const right = resolveOperand(comparison[3] ?? '', values)
    let ok: boolean
    if (operator === '==') {
      ok = sameValue(left, right)
    } else if (operator === '!=') {
      ok = !sameValue(left, right)
    } else {
      ok = orderedCompare(left, right, operator)
    }
    return { ok, observed: left, expected: right }
  }

  const scalar = resolveOperand(trimmed, values)
  return { ok: Boolean(scalar), observed: scalar, expected: true }
}

// Evaluate a boolean expression supporting ||, &&, ! and parentheses on top
// of the leaf comparison/membership grammar. Template expressions must
// already be replaced by placeholders; values are injected per-operand.
function evaluateBooleanExpressionWithValues(
  expression: string,
  values: Map<string, unknown>,
): boolean {
  const trimmed = expression.trim()
  if (trimmed.length === 0) {
    return true
  }

  const orParts = splitTopLevel(trimmed, '||')
  if (orParts.length > 1) {
    return orParts.some(part =>
      evaluateBooleanExpressionWithValues(part, values),
    )
  }

  const andParts = splitTopLevel(trimmed, '&&')
  if (andParts.length > 1) {
    return andParts.every(part =>
      evaluateBooleanExpressionWithValues(part, values),
    )
  }

  if (trimmed.startsWith('!') && trimmed[1] !== '=') {
    return !evaluateBooleanExpressionWithValues(trimmed.slice(1), values)
  }

  if (isFullyParenthesized(trimmed)) {
    return evaluateBooleanExpressionWithValues(trimmed.slice(1, -1), values)
  }

  return evaluateLeafWithValues(trimmed, values).ok
}

function hasTopLevelBoolean(expression: string): boolean {
  return (
    splitTopLevel(expression, '||').length > 1 ||
    splitTopLevel(expression, '&&').length > 1 ||
    (expression.startsWith('!') && expression[1] !== '=') ||
    isFullyParenthesized(expression)
  )
}

/**
 * Substitute template expressions with structure-neutral placeholders before
 * the boolean grammar parses the condition. Resolving templates into the raw
 * text first (the old behavior) let VALUES rewrite the expression STRUCTURE:
 * an upstream output containing `&&`, quotes, or a comparison operator (all
 * common in scientific error strings) changed how the condition parsed and
 * silently routed the wrong branch. With placeholders the structure is fixed
 * by the author's text alone; values are injected per-operand afterwards.
 */
type TemplatePlaceholders = {
  expression: string
  values: Map<string, unknown>
}

const WORKFLOW_TEMPLATE_PATTERN = /\{\{[^{}]*\}\}/g

function extractTemplatePlaceholders(
  condition: string,
  context: WorkflowExpressionContext,
): TemplatePlaceholders {
  const values = new Map<string, unknown>()
  let index = 0
  const expression = condition.replace(WORKFLOW_TEMPLATE_PATTERN, match => {
    const key = `\u0000tpl${index}\u0000`
    index += 1
    values.set(key, resolveWorkflowTemplateValue(match, context))
    return key
  })
  return { expression, values }
}

function substitutePlaceholders(
  text: string,
  values: Map<string, unknown>,
): string {
  let result = text
  for (const [key, value] of values) {
    if (!result.includes(key)) {
      continue
    }
    result = result.split(key).join(String(value ?? ''))
  }
  return result
}

/**
 * Resolve one operand: a bare placeholder yields the template's value with
 * its type intact (numbers compare numerically, objects stay objects);
 * anything else is string-interpolated and parsed as a scalar literal.
 */
function resolveOperand(
  operand: string,
  values: Map<string, unknown>,
): unknown {
  const trimmed = operand.trim()
  if (values.has(trimmed)) {
    return values.get(trimmed)
  }
  return parseScalar(substitutePlaceholders(trimmed, values))
}

export function evaluateWorkflowCondition(
  condition: string | undefined,
  context: WorkflowExpressionContext,
): boolean {
  return evaluateWorkflowConditionDetail(condition, context).ok
}

export function evaluateWorkflowConditionDetail(
  condition: string | undefined,
  context: WorkflowExpressionContext,
): WorkflowConditionEvaluation {
  if (!condition || condition.trim().length === 0) {
    return { ok: true }
  }

  // Exact single-template conditions resolve to the raw value (any type).
  const trimmedCondition = condition.trim()
  if (/^\{\{[^{}]*\}\}$/.test(trimmedCondition)) {
    const resolved = resolveWorkflowTemplateValue(trimmedCondition, context)
    if (typeof resolved !== 'string') {
      return { ok: Boolean(resolved), observed: resolved, expected: true }
    }
    return evaluateLeaf(resolved.trim())
  }

  const { expression, values } = extractTemplatePlaceholders(
    trimmedCondition,
    context,
  )
  // Compound boolean expressions return only ok; observed/expected are
  // meaningful for single-leaf comparisons.
  if (hasTopLevelBoolean(expression)) {
    return { ok: evaluateBooleanExpressionWithValues(expression, values) }
  }

  return evaluateLeafWithValues(expression, values)
}
