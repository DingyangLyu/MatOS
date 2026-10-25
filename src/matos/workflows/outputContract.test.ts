import { describe, expect, test } from 'bun:test'
import {
  parseStructuredWorkflowResult,
  validateWorkflowNodeOutputContract,
  validateWorkflowOutputSchemaDefinition,
} from './outputContract.js'
import type { MatOSWorkflowNode } from './types.js'

describe('MatOS workflow output contracts', () => {
  const agentNode = {
    id: 'plan_research',
    type: 'agent',
    dependsOn: [],
    role: 'role:deep-research',
    prompt: 'Return JSON.',
    outputSchema: {
      type: 'object',
      required: ['stage', 'sections'],
      properties: {
        stage: { type: 'string' },
        sections: { type: 'array', items: { type: 'string' } },
      },
    },
  } satisfies MatOSWorkflowNode

  test('parses bare and fenced JSON from agent final text', () => {
    expect(parseStructuredWorkflowResult('{"stage":"plan","sections":["a"]}')).toEqual({
      stage: 'plan',
      sections: ['a'],
    })

    expect(
      parseStructuredWorkflowResult(
        'Here is the compact object:\n```json\n{"stage":"plan","sections":["a"]}\n```',
      ),
    ).toEqual({ stage: 'plan', sections: ['a'] })
  })

  test('repairs only missing trailing JSON structural delimiters', () => {
    expect(
      parseStructuredWorkflowResult(
        '{"coveredGap":"VFT response","sourceUrls":["https://example.test/paper"]',
      ),
    ).toEqual({
      coveredGap: 'VFT response',
      sourceUrls: ['https://example.test/paper'],
    })
    expect(parseStructuredWorkflowResult('{"stage":"plan","sections":["a"')).toEqual({
      stage: 'plan',
      sections: ['a'],
    })
  })

  test('does not guess truncated strings or mismatched JSON', () => {
    expect(parseStructuredWorkflowResult('{"stage":"pla')).toBeUndefined()
    expect(parseStructuredWorkflowResult('{"stage":[1,2}')).toBeUndefined()
  })

  test('validates workflow output schema definitions with Ajv diagnostics', () => {
    expect(validateWorkflowOutputSchemaDefinition(agentNode.outputSchema).ok).toBe(
      true,
    )

    const invalid = validateWorkflowOutputSchemaDefinition({
      type: 'object',
      properties: [],
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join('\n')).toContain('properties')
  })

  test('accepts agent output that satisfies the declared schema', () => {
    const result = validateWorkflowNodeOutputContract(agentNode, {
      structured: { stage: 'plan', sections: ['overview'] },
    })

    expect(result).toEqual({ ok: true, errors: [] })
  })

  test('rejects agent output that misses required structured fields', () => {
    const result = validateWorkflowNodeOutputContract(agentNode, {
      structured: { stage: 'plan' },
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('sections')
  })

  test('rejects missing structured JSON when outputSchema is declared', () => {
    const result = validateWorkflowNodeOutputContract(agentNode, {
      result: 'plain text',
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain(
      'requires structured JSON output',
    )
  })
})
