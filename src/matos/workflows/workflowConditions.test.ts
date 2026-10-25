import { describe, expect, test } from 'bun:test'
import { evaluateWorkflowCondition } from './workflowConditions.js'
import { valueAtPath } from './workflowExpressions.js'
import { evaluateWorkflowValidationChecks } from './validationEngine.js'
import type { WorkflowExpressionContext } from './workflowExpressions.js'

const emptyContext: WorkflowExpressionContext = {
  nodeRuns: new Map(),
  parameters: {},
}

function check(condition: string): boolean {
  return evaluateWorkflowCondition(condition, emptyContext)
}

describe('workflow condition DSL', () => {
  test('preserves equality, inequality, membership, and scalar semantics', () => {
    expect(check('completed == completed')).toBe(true)
    expect(check('completed != failed')).toBe(true)
    expect(check('failed in [completed, failed]')).toBe(true)
    expect(check('missing in [completed, failed]')).toBe(false)
    expect(check('true')).toBe(true)
    expect(check('')).toBe(true)
  })

  test('supports numeric ordering comparisons', () => {
    expect(check('3 >= 2')).toBe(true)
    expect(check('2 >= 3')).toBe(false)
    expect(check('2 > 10')).toBe(false)
    expect(check('10 > 2')).toBe(true)
    expect(check('1 < 2')).toBe(true)
    expect(check('2 <= 2')).toBe(true)
  })

  test('supports logical and/or/not and parentheses', () => {
    expect(check('true && true')).toBe(true)
    expect(check('true && false')).toBe(false)
    expect(check('1 == 1 || 2 == 3')).toBe(true)
    expect(check('1 == 2 || 2 == 3')).toBe(false)
    expect(check('!false')).toBe(true)
    expect(check('!(1 == 2)')).toBe(true)
    expect(check('(1 == 1 || 1 == 2) && 3 >= 3')).toBe(true)
    expect(check('(1 == 2 || 1 == 3) && 3 >= 3')).toBe(false)
  })

  test('supports string contains and not contains checks', () => {
    expect(check('"workflow-ok stdout" contains "workflow-ok"')).toBe(true)
    expect(check('"workflow-ok stdout" contains "missing"')).toBe(false)
    expect(check('"workflow-ok stdout" not contains "missing"')).toBe(true)
    expect(check('"workflow-ok stdout" not contains "workflow-ok"')).toBe(false)
  })

  test('resolves templates before evaluating compound expressions', () => {
    const context: WorkflowExpressionContext = {
      nodeRuns: new Map(),
      parameters: { score: 0.9, ready: true },
    }
    expect(
      evaluateWorkflowCondition(
        '{{ parameters.score }} >= 0.8 && {{ parameters.ready }} == true',
        context,
      ),
    ).toBe(true)
    expect(
      evaluateWorkflowCondition(
        '{{ parameters.score }} >= 0.95 && {{ parameters.ready }} == true',
        context,
      ),
    ).toBe(false)
  })
})

describe('template value path resolution', () => {
  test('reads nested object paths', () => {
    expect(valueAtPath({ a: { b: 'x' } }, 'a.b')).toBe('x')
    expect(valueAtPath({ a: { b: 'x' } }, undefined)).toEqual({ a: { b: 'x' } })
  })

  test('indexes into arrays with dot and bracket syntax', () => {
    expect(valueAtPath({ items: ['x', 'y'] }, 'items.0')).toBe('x')
    expect(
      valueAtPath({ items: [{ name: 'a' }, { name: 'b' }] }, 'items.1.name'),
    ).toBe('b')
    expect(valueAtPath({ a: [1, 2] }, 'a[1]')).toBe(2)
    expect(valueAtPath({ items: ['x'] }, 'items.5')).toBeUndefined()
  })
})

describe('json_schema validation check', () => {
  test('passes when the value conforms to the schema', async () => {
    const result = await evaluateWorkflowValidationChecks(
      [
        {
          id: 'shape',
          type: 'json_schema',
          value: { n: 5 },
          schema: {
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
          },
        },
      ],
      { workspaceDir: '/tmp' },
    )
    expect(result.ok).toBe(true)
    expect(result.checks[0]?.ok).toBe(true)
  })

  test('fails when the value violates the schema', async () => {
    const result = await evaluateWorkflowValidationChecks(
      [
        {
          id: 'shape',
          type: 'json_schema',
          value: { n: 'not-a-number' },
          schema: {
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
          },
        },
      ],
      { workspaceDir: '/tmp' },
    )
    expect(result.ok).toBe(false)
    expect(result.checks[0]?.ok).toBe(false)
  })

  test('parses JSON-encoded string values before validating', async () => {
    const result = await evaluateWorkflowValidationChecks(
      [
        {
          id: 'shape',
          type: 'json_schema',
          value: '{"n": 7}',
          schema: { type: 'object', required: ['n'] },
        },
      ],
      { workspaceDir: '/tmp' },
    )
    expect(result.ok).toBe(true)
  })

  test('fails when no schema is provided', async () => {
    const result = await evaluateWorkflowValidationChecks(
      [{ id: 'shape', type: 'json_schema', value: { n: 1 } }],
      { workspaceDir: '/tmp' },
    )
    expect(result.ok).toBe(false)
  })
})

describe('template interpolation', () => {
  test('preserves structured values when embedded in agent strings', async () => {
    const { resolveWorkflowTemplateValue } = await import('./workflowExpressions.js')
    const context: WorkflowExpressionContext = {
      nodeRuns: new Map([
        ['agent', {
          nodeId: 'agent', status: 'completed', attempts: 1,
          updatedAt: '2026-09-05T00:00:00.000Z',
          output: { candidates: ['Li', 'Na'], score: 0.91 },
        }],
      ]),
      parameters: { constraints: { maxAtoms: 128 } },
    }
    expect(resolveWorkflowTemplateValue('plan={{ nodes.agent.outputs }}', context)).toBe('plan={"candidates":["Li","Na"],"score":0.91}')
    expect(resolveWorkflowTemplateValue('limits={{ parameters.constraints }}', context)).toBe('limits={"maxAtoms":128}')
  })
})
