/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'
import {
  budgetEstimateWarnings,
  validateWorkflowDefinition,
  type WorkflowDefinitionValidationOptions,
} from './validateWorkflow.js'

/**
 * Tests for the workflow definition validator. The validator is the gatekeeper
 * for every workflow asset before it can run; these tests lock the load-bearing
 * contracts that, if silently changed, would let broken or unsafe workflows
 * reach the runtime. No mocks, no fake providers — the validator is pure
 * deterministic logic over the definition.
 */

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function baseNode(overrides: Partial<MatOSWorkflowNode>): MatOSWorkflowNode {
  return {
    id: 'n1',
    type: 'exec',
    command: 'echo hi',
    dependsOn: [],
    ...overrides,
  } as MatOSWorkflowNode
}

function baseDefinition(
  nodes: MatOSWorkflowNode[],
  overrides: Partial<MatOSWorkflowDefinition> = {},
): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'test-workflow',
    parameters: {},
    policy: {},
    nodes,
    outputs: {},
    ...overrides,
  }
}

function validate(
  definition: MatOSWorkflowDefinition,
  options: WorkflowDefinitionValidationOptions = {},
) {
  return validateWorkflowDefinition(definition, options)
}

/** Returns just the codes for a cleaner assertion surface. */
function codes(result: { errors: { code: string }[] }): string[] {
  return result.errors.map(e => e.code)
}

function warningsOf(
  result: { warnings?: { code: string }[] },
): string[] {
  return (result.warnings ?? []).map(w => w.code)
}

/** A definition with a single valid exec node — the baseline "should pass". */
function validDefinition(): MatOSWorkflowDefinition {
  return baseDefinition([baseNode({})])
}

// ---------------------------------------------------------------------------
// A. Top-level / structural contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: structural', () => {
  test('a minimal valid definition passes', () => {
    const result = validate(validDefinition())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('missing name is rejected', () => {
    const result = validate(baseDefinition([baseNode({})], { name: '' }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('missing_field')
    expect(result.errors.some(e => e.path === 'name')).toBe(true)
  })

  test('whitespace-only name is rejected', () => {
    const result = validate(baseDefinition([baseNode({})], { name: '   ' }))
    expect(codes(result)).toContain('missing_field')
  })

  test('node without id is rejected with missing_field and skipped', () => {
    const node = baseNode({}) as Partial<MatOSWorkflowNode>
    delete node.id
    const result = validate(baseDefinition([node as MatOSWorkflowNode]))
    expect(codes(result)).toContain('missing_field')
    // An id-less node must not crash later validation passes.
  })

  test('duplicate node ids are rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'dup' }),
        baseNode({ id: 'dup', command: 'echo two' }),
      ]),
    )
    expect(codes(result)).toContain('duplicate_node_id')
  })
})

// ---------------------------------------------------------------------------
// B. Node type contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: node types', () => {
  const runtimeTypes: MatOSWorkflowNode['type'][] = [
    'agent',
    'exec',
    'guard',
    'human',
    'backend',
    'subworkflow',
    'map',
    'loop',
    'dynamic',
  ]

  for (const type of runtimeTypes) {
    test(`runtime type "${type}" is a supported node type`, () => {
      // Each type has its own payload requirements; here we only assert the
      // *type itself* is recognized (no invalid_node_type), using a minimal
      // valid payload per type so the type gate is isolated.
      const node = minimalValidNodeForType(type)
      const result = validate(
        baseDefinition([node], { parameters: { flag: { type: 'string' }, cand: { type: 'string' } } }),
      )
      expect(codes(result)).not.toContain('invalid_node_type')
    })
  }

  test('unknown node type is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'totally_made_up' as never })]),
    )
    expect(codes(result)).toContain('invalid_node_type')
  })

  test('invalid node type skips payload validation (no spurious extra errors)', () => {
    // An unknown type should not also trip payload checks; only the type error
    // is meaningful for that node.
    const result = validate(
      baseDefinition([
        baseNode({ type: 'made_up' as never, command: undefined as never }),
      ]),
    )
    expect(codes(result)).toEqual(['invalid_node_type'])
  })

  test('target types (compute/approval_gate/validate/supernode) compile to runtime types and pass the type gate', () => {
    // compileWorkflowDefinition maps target types to runtime types before
    // validation runs. This guards the compile -> validate seam. We only
    // assert the type gate (no invalid_node_type), not full validity, since
    // some target types need more payload than others.
    const cases: Array<{ targetType: string; overrides: Partial<MatOSWorkflowNode> }> = [
      { targetType: 'compute', overrides: { backend: 'hpc-queue', operation: 'status' } },
      { targetType: 'approval_gate', overrides: { prompt: 'approve' } },
      { targetType: 'validate', overrides: {} },
      { targetType: 'supernode', overrides: { workflow: 'workflow:child@1.0.0' } },
    ]
    for (const { targetType, overrides } of cases) {
      const result = validate(baseDefinition([baseNode({ type: targetType as never, ...overrides })]))
      expect(codes(result)).not.toContain('invalid_node_type')
    }
  })
})

/** Minimal valid payload for a given runtime node type. */
function minimalValidNodeForType(
  type: MatOSWorkflowNode['type'],
): MatOSWorkflowNode {
  switch (type) {
    case 'agent':
      return baseNode({ type, role: 'role:compute', prompt: 'do work' })
    case 'exec':
      return baseNode({ type, command: 'echo hi' })
    case 'guard':
      return baseNode({
        type,
        checks: [{ type: 'expression', value: '{{ parameters.flag }}' }],
      })
    case 'human':
      return baseNode({ type })
    case 'backend':
      return baseNode({ type, backend: 'hpc-queue', operation: 'status' })
    case 'subworkflow':
      return baseNode({ type, workflow: 'workflow:child@1.0.0' })
    case 'map':
      return baseNode({
        type,
        workflow: 'workflow:child@1.0.0',
        items: ['a', 'b'],
      })
    case 'loop':
      return baseNode({
        type,
        workflow: 'workflow:child@1.0.0',
        maxIterations: 3,
      })
    case 'dynamic':
      return baseNode({ type, candidate: { id: '{{ parameters.cand }}' } })
    default:
      return baseNode({ type: type as 'exec' })
  }
}

// ---------------------------------------------------------------------------
// C. Per-type payload contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: agent payload', () => {
  test('missing role is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'agent', prompt: 'hi', role: undefined })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('missing both prompt and systemPrompt is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'agent', role: 'role:x' })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('systemPrompt alone satisfies the prompt requirement', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'agent', role: 'role:x', systemPrompt: 'sys' })]),
    )
    expect(codes(result)).not.toContain('missing_field')
  })

  test('passthroughArgs must be an array of strings', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'agent',
          role: 'role:x',
          prompt: 'hi',
          passthroughArgs: [1, 2] as unknown as string[],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })
})

describe('validateWorkflowDefinition: exec payload', () => {
  test('missing command is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'exec', command: undefined })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('args with non-string entry is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'exec', args: ['ok', 5] as unknown as string[] }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('env accepts string/number/boolean values', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'exec', env: { A: 's', B: 1, C: true } }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('env rejects object values', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'exec', env: { BAD: { nested: true } } }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('timeoutMs below 1 is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'exec', timeoutMs: 0 })]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('timeoutSeconds below 0.001 is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'exec', timeoutSeconds: 0.0001 })]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('detectKnownProcessFailures must be boolean when provided', () => {
    const result = validate(
      baseDefinition([
        baseNode({ detectKnownProcessFailures: 'no' as unknown as boolean }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })
})

describe('validateWorkflowDefinition: guard payload', () => {
  test('empty checks is rejected', () => {
    const result = validate(baseDefinition([baseNode({ type: 'guard' })]))
    expect(codes(result)).toContain('missing_field')
  })

  test('unsupported check type is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'guard', checks: [{ type: 'magic' as never }] }),
      ]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('file_exists requires path', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'guard', checks: [{ type: 'file_exists' }] })]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('grep requires path and pattern', () => {
    const noPattern = validate(
      baseDefinition([
        baseNode({ type: 'guard', checks: [{ type: 'grep', path: '/x' }] }),
      ]),
    )
    expect(codes(noPattern).some(c => c === 'invalid_node_config')).toBe(true)
    const noPath = validate(
      baseDefinition([
        baseNode({ type: 'guard', checks: [{ type: 'grep', pattern: 'p' }] }),
      ]),
    )
    expect(codes(noPath).some(c => c === 'invalid_node_config')).toBe(true)
  })

  test('regex rejects an invalid static pattern even when flags are omitted', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'guard',
          checks: [{ type: 'regex', value: 'output', pattern: '[' }],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('accepts generic artifact checks with structured repair metadata', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'guard',
          checks: [
            {
              type: 'file_size',
              path: 'result.json',
              minBytes: 2,
              failureCode: 'empty_result',
              failureMessage: 'The result artifact is empty.',
              repairHint: 'Inspect the producer before retrying.',
              retryable: true,
              sourceNodeId: 'produce_result',
            },
            {
              type: 'regex',
              value: 'energy=-1.25',
              pattern: 'energy=-?\\d+(?:\\.\\d+)?',
            },
          ],
        }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('expression requires value', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'guard', checks: [{ type: 'expression' }] })]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('numeric_range value/min/max must be finite numbers', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'guard',
          checks: [{ type: 'numeric_range', value: 'x' as never }],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('numeric_range rejects min greater than max', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'guard',
          checks: [{ type: 'numeric_range', value: 5, min: 10, max: 1 }],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('json_schema requires a valid schema', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'guard',
          checks: [{ type: 'json_schema', schema: { type: 'not-a-real-type' } }],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('a fully specified guard passes', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({
            type: 'guard',
            checks: [
              { type: 'file_exists', path: '/tmp/x' },
              { type: 'grep', path: '/tmp/x', pattern: 'ok' },
              { type: 'expression', value: '{{ parameters.flag }}' },
              { type: 'numeric_range', value: 5, min: 0, max: 10 },
              { type: 'json_schema', schema: { type: 'object' } },
            ],
          }),
        ],
        { parameters: { flag: { type: 'string' } } },
      ),
    )
    expect(result.ok).toBe(true)
  })
})

describe('validateWorkflowDefinition: backend payload', () => {
  test('missing backend is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'backend', backend: undefined })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('input/inputs/toolInput must be objects', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'backend',
          backend: 'hpc-queue',
          operation: 'status',
          input: 'not-an-object' as never,
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })
})

describe('validateWorkflowDefinition: subworkflow/map/loop payloads', () => {
  test('subworkflow requires workflow', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'subworkflow', workflow: undefined })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('map requires workflow', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'map', items: ['a'], workflow: undefined })]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('map requires items', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'map', workflow: 'workflow:c@1', items: undefined }),
      ]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('map maxParallel must be a positive integer', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'map',
          workflow: 'workflow:c@1',
          items: ['a'],
          maxParallel: 0,
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('map failureMode must be aggregate or fail_fast', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'map',
          workflow: 'workflow:c@1',
          items: ['a'],
          failureMode: 'bogus' as never,
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('loop requires workflow', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'loop', maxIterations: 2, workflow: undefined }),
      ]),
    )
    expect(codes(result)).toContain('missing_field')
  })

  test('loop requires maxIterations >= 1', () => {
    const noIter = validate(
      baseDefinition([baseNode({ type: 'loop', workflow: 'workflow:c@1' })]),
    )
    expect(codes(noIter)).toContain('missing_field')

    const zeroIter = validate(
      baseDefinition([
        baseNode({ type: 'loop', workflow: 'workflow:c@1', maxIterations: 0 }),
      ]),
    )
    expect(codes(zeroIter)).toContain('missing_field')
  })

  test('loop accepts an exact maxIterations template', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          id: 'loop1',
          type: 'loop',
          workflow: 'workflow:c@1',
          maxIterations: '{{ parameters.maxRounds }}',
        }),
      ]),
    )

    expect(result.ok).toBe(true)
  })
})

describe('validateWorkflowDefinition: human payload', () => {
  test('human with invalid responseSchema is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'human',
          responseSchema: { type: 'not-a-real-type' },
        }),
      ]),
    )
    // human reuses the json schema validator via validateJsonSchemaField.
    expect(result.ok).toBe(false)
  })

  test('human with no responseSchema passes', () => {
    const result = validate(baseDefinition([baseNode({ type: 'human' })]))
    expect(result.ok).toBe(true)
  })
})

describe('validateWorkflowDefinition: dynamic payload', () => {
  test('candidate alone satisfies the requirement', () => {
    const result = validate(
      baseDefinition([baseNode({ type: 'dynamic', candidate: { id: 'x' } })]),
    )
    expect(codes(result)).not.toContain('missing_field')
  })

  test('role + prompt satisfies the requirement', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'dynamic', role: 'role:x', prompt: 'plan' }),
      ]),
    )
    expect(codes(result)).not.toContain('missing_field')
  })

  test('neither candidate nor role+prompt is rejected', () => {
    const result = validate(baseDefinition([baseNode({ type: 'dynamic' })]))
    expect(codes(result)).toContain('missing_field')
  })
})

// ---------------------------------------------------------------------------
// D. Backend tool resolution contract (backendToolRefForNode)
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: backend tool resolution', () => {
  test('explicit tool reference resolves alongside a backend', () => {
    // backend is required on a backend node; an explicit tool is honored as the
    // resolved tool reference and must point at a real tool asset type when a
    // resolver is provided.
    const result = validate(
      baseDefinition([
        baseNode({ type: 'backend', backend: 'hpc-queue', tool: 'tool:custom-thing' }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('templated backend tool requires a static allowlist', () => {
    const missing = validate(
      baseDefinition([
        baseNode({
          type: 'backend',
          backend: 'oracle',
          tool: '{{ parameters.oracleTool }}',
        }),
      ]),
    )
    expect(codes(missing)).toContain('invalid_node_config')

    const allowed = validate(
      baseDefinition([
        baseNode({
          type: 'backend',
          backend: 'oracle',
          tool: '{{ parameters.oracleTool }}',
          toolAllowlist: ['tool:oracle-a@1.0.0', 'tool:oracle-b@1.0.0'],
        }),
      ]),
    )
    expect(allowed.ok).toBe(true)
  })

  test('templated backend tool rejects a templated or empty allowlist', () => {
    for (const toolAllowlist of [[], ['{{ parameters.oracleTool }}']]) {
      const result = validate(
        baseDefinition([
          baseNode({
            type: 'backend',
            backend: 'oracle',
            tool: '{{ parameters.oracleTool }}',
            toolAllowlist,
          }),
        ]),
      )
      expect(codes(result)).toContain('invalid_node_config')
    }
  })

  test('static or default backend tool must also belong to its allowlist', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          type: 'backend',
          backend: 'custom-scheduler',
          tool: 'tool:configured-adapter',
          toolAllowlist: ['tool:some-other-tool@1.0.0'],
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('backend names never imply a platform adapter', () => {
    for (const backend of ['local', 'hpc-queue', 'hpc-cluster', 'custom-scheduler']) {
      const result = validate(baseDefinition([baseNode({ type: 'backend', backend, operation: 'submit' })]))
      expect(codes(result)).toContain('invalid_node_config')
    }
  })

  test('an explicit tool works with an arbitrary configured backend name', () => {
    const result = validate(baseDefinition([baseNode({
      type: 'backend', backend: 'custom-scheduler', operation: 'submit',
      tool: 'tool:configured-adapter', input: {},
    })]))
    expect(result.ok).toBe(true)
  })

})

// ---------------------------------------------------------------------------
// E. Template expression contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: template expressions', () => {
  test('exact template {{ parameters.x }} lets an agent skip static role requirement', () => {
    // This is intentional: role may be resolved at runtime from a template.
    // Use a declared parameter so the reference checker also passes.
    const result = validate(
      baseDefinition(
        [
          baseNode({
            type: 'agent',
            role: '{{ parameters.roleRef }}',
            prompt: 'hi',
          }),
        ],
        { parameters: { roleRef: { type: 'string' } } },
      ),
    )
    expect(codes(result)).not.toContain('missing_field')
  })

  test('exact template lets exec skip static command requirement', () => {
    const result = validate(
      baseDefinition(
        [baseNode({ type: 'exec', command: '{{ parameters.cmd }}' })],
        { parameters: { cmd: { type: 'string' } } },
      ),
    )
    expect(codes(result)).not.toContain('missing_field')
  })

  test('inline template (a {{ x }} b) does NOT satisfy required fields', () => {
    // containsTemplate is true but exactTemplateString is false, so the field
    // is treated as a literal string, not a template reference. For command
    // this is fine (it's a string); for role it must still be non-empty.
    const result = validate(
      baseDefinition([
        baseNode({ type: 'agent', role: 'prefix {{ x }}', prompt: 'hi' }),
      ]),
    )
    // 'prefix {{ x }}' is a non-empty string, so role is satisfied as a string.
    // The point: it is NOT treated as a template that bypasses requirements,
    // and it is a valid string value, so no missing_field.
    expect(codes(result)).not.toContain('missing_field')
  })

  test('guard check fields accept exact templates that resolve to declared params', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({
            type: 'guard',
            checks: [
              { type: 'file_exists', path: '{{ parameters.filePath }}' },
              { type: 'grep', path: '{{ parameters.filePath }}', pattern: '{{ parameters.pat }}' },
            ],
          }),
        ],
        {
          parameters: {
            filePath: { type: 'string' },
            pat: { type: 'string' },
          },
        },
      ),
    )
    expect(result.ok).toBe(true)
  })

  test('bare template like {{ x }} passes payload checks but fails reference checks', () => {
    // Important seam: exactTemplateString lets a field skip *required* payload
    // validation, but the reference checker still rejects templates that don't
    // resolve to a real node output / parameter / workflow metadata.
    const result = validate(
      baseDefinition([
        baseNode({ type: 'exec', command: '{{ bare }}' }),
      ]),
    )
    expect(codes(result)).not.toContain('missing_field')
    expect(codes(result)).toContain('invalid_reference')
  })
})

// ---------------------------------------------------------------------------
// F. Policy contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: policy', () => {
  test('approvalMode bypass/ask/strict are accepted', () => {
    for (const mode of ['bypass', 'ask', 'strict'] as const) {
      const result = validate(
        baseDefinition([baseNode({})], { policy: { approvalMode: mode } }),
      )
      expect(codes(result)).not.toContain('invalid_policy')
    }
  })

  test('unsupported approvalMode is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({})], { policy: { approvalMode: 'yolo' as never } }),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('reviewedHighRiskBypass is rejected by default (trusted flag)', () => {
    const result = validate(
      baseDefinition([
        baseNode({ policy: { reviewedHighRiskBypass: true } }),
      ]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('reviewedHighRiskBypass is allowed when allowReviewedHighRiskBypass is set', () => {
    const result = validate(
      baseDefinition([baseNode({ policy: { reviewedHighRiskBypass: true } })]),
      { allowReviewedHighRiskBypass: true },
    )
    expect(codes(result)).not.toContain('invalid_policy')
  })

  test('workflow budget limit must be a non-negative finite number', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: { budget: { maxNodeAttempts: -1 } },
      }),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('workflow budget onExceeded must be fail or pause', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: { budget: { onExceeded: 'explode' as never } },
      }),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('accepts a bounded generic workflow controller policy', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: {
          controller: {
            provider: 'best-of-n',
            version: '1.0.0',
            mode: 'shadow',
            config: { n: 3, priorities: { n1: 2 } },
            seed: 7,
            bounds: {
              maxActions: 1,
              maxCandidates: 8,
              maxDepth: 2,
              maxWallTimeMs: 100,
              maxCostUsd: 0.01,
            },
            onFailure: 'pause',
          },
        },
      }),
    )
    expect(codes(result)).not.toContain('invalid_policy')
  })

  test('accepts a zero-cost controller bound supported by the runtime protocol', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: {
          controller: {
            provider: 'greedy-baseline',
            objectiveRef: 'workflow:test#ready-order',
            bounds: { maxCostUsd: 0 },
            budget: { actions: 1 },
          },
        },
      }),
    )
    expect(codes(result)).not.toContain('invalid_policy')
  })

  test('allows explicitly disabled controller policy without a provider', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: { controller: { enabled: false } },
      }),
    )
    expect(codes(result)).not.toContain('invalid_policy')
  })

  test('rejects malformed controller bounds and secret-bearing config', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: {
          controller: {
            provider: 'best-of-n',
            bounds: { maxCandidates: 0 },
            config: { nested: { api_key: 'must-not-be-stored' } },
          },
        },
      }),
    )
    expect(codes(result)).toContain('invalid_policy')
    expect(
      result.errors.some(error => error.message.includes('secret-like')),
    ).toBe(true)
  })

  test('rejects invalid controller objective and zero executable action budget', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: {
          controller: {
            provider: 'greedy-baseline',
            objectiveRef: 42 as never,
            budget: { actions: 0 },
          },
        },
      }),
    )
    expect(
      result.errors.some(
        error => error.path === 'policy.controller.objectiveRef',
      ),
    ).toBe(true)
    expect(
      result.errors.some(
        error => error.path === 'policy.controller.budget.actions',
      ),
    ).toBe(true)
  })

  test('rejects camelCase controller secret keys recursively', () => {
    const result = validate(
      baseDefinition([baseNode({})], {
        policy: {
          controller: {
            provider: 'greedy-baseline',
            config: {
              transport: { accessToken: 'must-not-be-stored' },
              clientSecret: 'also-must-not-be-stored',
            },
          },
        },
      }),
    )
    expect(codes(result)).toContain('invalid_policy')
    expect(
      result.errors.some(error => error.message.includes('accessToken')),
    ).toBe(true)
  })

  test('node budget limit must be a non-negative finite number', () => {
    const result = validate(
      baseDefinition([
        baseNode({ budget: { maxAgentCalls: -5 } as never }),
      ]),
    )
    expect(codes(result)).toContain('invalid_policy')
    expect(result.errors.some(e => e.nodeId === 'n1')).toBe(true)
  })

  test('node approval must be inherit/bypass/ask/require', () => {
    const result = validate(
      baseDefinition([baseNode({ policy: { approval: 'always' as never } })]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('node retry maxAttempts must be a positive integer', () => {
    const result = validate(
      baseDefinition([baseNode({ policy: { retry: { maxAttempts: 0 } } })]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('node retry backoffMs must be a non-negative number', () => {
    const result = validate(
      baseDefinition([baseNode({ policy: { retry: { backoffMs: -1 } } })]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('node retry retryableExitCodes must be non-negative integers', () => {
    const result = validate(
      baseDefinition([
        baseNode({ policy: { retry: { retryableExitCodes: [-1, 2] } } }),
      ]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('node retry retryableErrorPatterns must be strings', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          policy: { retry: { retryableErrorPatterns: [1] as unknown as string[] } },
        }),
      ]),
    )
    expect(codes(result)).toContain('invalid_policy')
  })
})

// ---------------------------------------------------------------------------
// G. Graph structure contracts
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: graph structure', () => {
  test('dependsOn pointing to a missing node is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ dependsOn: ['ghost'] })]),
    )
    expect(codes(result)).toContain('missing_node_dependency')
  })

  test('edge from a missing node is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ id: 'n1' })], {
        edges: [{ from: 'ghost', to: 'n1' }],
      }),
    )
    expect(codes(result)).toContain('missing_node_dependency')
  })

  test('edge to a missing node is rejected', () => {
    const result = validate(
      baseDefinition([baseNode({ id: 'n1' })], {
        edges: [{ from: 'n1', to: 'ghost' }],
      }),
    )
    expect(codes(result)).toContain('missing_node_dependency')
  })

  test('unsupported edge route is rejected', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({ id: 'a' }),
          baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] }),
        ],
        { edges: [{ from: 'a', to: 'b', route: 'maybe' as never }] },
      ),
    )
    expect(codes(result)).toContain('invalid_policy')
  })

  test('valid DAG with a diamond does not report a cycle', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'a' }),
        baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] }),
        baseNode({ id: 'c', command: 'echo c', dependsOn: ['a'] }),
        baseNode({ id: 'd', command: 'echo d', dependsOn: ['b', 'c'] }),
      ]),
    )
    expect(codes(result)).not.toContain('workflow_cycle')
  })

  test('self-dependency is a cycle', () => {
    const result = validate(
      baseDefinition([baseNode({ dependsOn: ['n1'] })]),
    )
    expect(codes(result)).toContain('workflow_cycle')
  })

  test('two-node cycle is detected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'a', dependsOn: ['b'] }),
        baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] }),
      ]),
    )
    expect(codes(result)).toContain('workflow_cycle')
  })

  test('three-node cycle is detected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'a', dependsOn: ['c'] }),
        baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] }),
        baseNode({ id: 'c', command: 'echo c', dependsOn: ['b'] }),
      ]),
    )
    expect(codes(result)).toContain('workflow_cycle')
  })

  test('state machine execution model skips DAG cycle detection', () => {
    // Cycles are legal in state machines; acyclic check is delegated to the
    // state machine module. A cyclic graph with executionModel=state_machine
    // must not produce a workflow_cycle error from validateWorkflow.
    const result = validate(
      baseDefinition(
        [baseNode({ id: 'a', dependsOn: ['b'] }), baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] })],
        {
          policy: {
            executionModel: 'state_machine',
            stateMachine: { initialNodeId: 'a', maxTransitions: 10 },
          },
        },
      ),
    )
    expect(codes(result)).not.toContain('workflow_cycle')
  })
})

// ---------------------------------------------------------------------------
// H. Budget estimate warnings
// ---------------------------------------------------------------------------

describe('budgetEstimateWarnings', () => {
  test('produces no warnings when there is no budget limit', () => {
    const warnings = budgetEstimateWarnings(validDefinition())
    expect(warningsOf({ warnings })).toEqual([])
  })

  test('workflow-level worst-case over maxNodeAttempts warns but does not error', () => {
    const definition = baseDefinition(
      [
        baseNode({ id: 'a', policy: { retry: { maxAttempts: 5 } } }),
        baseNode({ id: 'b', command: 'echo b', dependsOn: ['a'] }),
      ],
      { policy: { budget: { maxNodeAttempts: 3 } } },
    )
    // worstCase = 5 (a) + 1 (b) = 6 > 3
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toContain('budget_worst_case_attempts')

    // And the full validation still reports ok=true (warnings, not errors).
    const result = validate(definition)
    expect(result.ok).toBe(true)
  })

  test('map fan-out multiplies retry attempts in the worst-case estimate', () => {
    const definition = baseDefinition(
      [
        baseNode({
          id: 'map1',
          type: 'map',
          workflow: 'workflow:c@1',
          items: ['a', 'b', 'c'],
          policy: { retry: { maxAttempts: 2 } },
        }),
      ],
      { policy: { budget: { maxNodeAttempts: 5 } } },
    )
    // worstCase for map1 = 2 (retry) * 3 (items) = 6 > 5
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toContain('budget_worst_case_attempts')
  })

  test('loop fan-out uses maxIterations', () => {
    const definition = baseDefinition(
      [
        baseNode({
          id: 'loop1',
          type: 'loop',
          workflow: 'workflow:c@1',
          maxIterations: 4,
          policy: { retry: { maxAttempts: 2 } },
        }),
      ],
      { policy: { budget: { maxNodeAttempts: 7 } } },
    )
    // worstCase = 2 * 4 = 8 > 7
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toContain('budget_worst_case_attempts')
  })

  test('template-driven map items conservatively count as fan-out 1', () => {
    const definition = baseDefinition(
      [
        baseNode({
          id: 'map1',
          type: 'map',
          workflow: 'workflow:c@1',
          items: '{{ parameters.itemList }}',
          policy: { retry: { maxAttempts: 3 } },
        }),
      ],
      {
        parameters: { itemList: { type: 'array' } },
        policy: { budget: { maxNodeAttempts: 2 } },
      },
    )
    // items is a template, not an array -> fanOut=1, worstCase=3*1=3 > 2
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toContain('budget_worst_case_attempts')
  })

  test('node-level budget below its own retry warns with node_budget_below_retry', () => {
    const definition = baseDefinition([
      baseNode({
        id: 'n1',
        policy: { retry: { maxAttempts: 4 } },
        budget: { maxNodeAttempts: 2 } as never,
      }),
    ])
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toContain('node_budget_below_retry')
    expect(warnings.some(w => w.nodeId === 'n1')).toBe(true)
  })

  test('no warning when worst-case fits within the limit', () => {
    const definition = baseDefinition(
      [baseNode({ id: 'a' })],
      { policy: { budget: { maxNodeAttempts: 100 } } },
    )
    const warnings = budgetEstimateWarnings(definition)
    expect(warningsOf({ warnings })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// I. Asset reference contracts (assetResolver)
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: asset references', () => {
  test('resolver returning undefined reports a missing asset reference', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'agent', role: 'role:ghost', prompt: 'hi' }),
      ]),
      { assetResolver: () => undefined },
    )
    expect(codes(result)).toContain('invalid_node_config')
    expect(
      result.errors.some(e => e.message.includes('missing MatOS role asset')),
    ).toBe(true)
  })

  test('resolver returning a mismatched type reports a type mismatch', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'agent', role: 'role:real', prompt: 'hi' }),
      ]),
      { assetResolver: () => ({ type: 'tool' }) },
    )
    expect(codes(result)).toContain('invalid_node_config')
    expect(
      result.errors.some(e => e.message.includes('expected role')),
    ).toBe(true)
  })

  test('a matching resolver type passes', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'agent', role: 'role:real', prompt: 'hi' }),
      ]),
      { assetResolver: () => ({ type: 'role' }) },
    )
    expect(result.ok).toBe(true)
  })

  test('no resolver means references are not checked', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'agent', role: 'role:anything', prompt: 'hi' }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('subworkflow workflow reference is checked', () => {
    const result = validate(
      baseDefinition([
        baseNode({ type: 'subworkflow', workflow: 'workflow:child@1' }),
      ]),
      { assetResolver: () => ({ type: 'tool' }) },
    )
    expect(codes(result)).toContain('invalid_node_config')
    expect(
      result.errors.some(e => e.message.includes('expected workflow')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// J. Validation retry targets (B7)
//
// The runtime consumes `retryNodeId` on validate/guard nodes by resetting the
// target plus its downstream closure; the validator only re-runs when it is
// inside that closure. These tests lock the static guarantee that a target is
// an existing transitive ancestor (or the validator itself), because any other
// target stalls the run forever at runtime.
// ---------------------------------------------------------------------------

/** A guard/validate node with one always-satisfiable check. */
function validatorNode(overrides: Partial<MatOSWorkflowNode>): MatOSWorkflowNode {
  return baseNode({
    id: 'check',
    type: 'validate',
    command: undefined,
    recommendation: 'retry',
    policy: { retry: { maxAttempts: 2, backoffMs: 0 } },
    checks: [{ type: 'file_exists', path: '/tmp/x' }],
    ...overrides,
  })
}

describe('validateWorkflowDefinition: validation retry targets', () => {
  test('retryNodeId naming a direct dependency passes', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 'produce' }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('retryNodeId naming a transitive ancestor passes', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'root' }),
        baseNode({ id: 'mid', command: 'echo mid', dependsOn: ['root'] }),
        validatorNode({ dependsOn: ['mid'], retryNodeId: 'root' }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('retryNodeId reachable only through edges passes (post-compile dependsOn merge)', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({ id: 'produce' }),
          validatorNode({ dependsOn: [], retryNodeId: 'produce' }),
        ],
        { edges: [{ from: 'produce', to: 'check' }] },
      ),
    )
    expect(result.ok).toBe(true)
  })

  test('retryNodeId pointing at the validator itself passes (reset closure starts at the target)', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 'check' }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('retryNodeId naming a missing node is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 'ghost' }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
    const error = result.errors.find(e => e.path === 'nodes.check.retryNodeId')
    expect(error?.message).toContain('missing node "ghost"')
  })

  test('template retryNodeId is rejected because the runtime reads the field literally', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({ id: 'produce' }),
          validatorNode({
            dependsOn: ['produce'],
            retryNodeId: '{{ parameters.target }}',
          }),
        ],
        { parameters: { target: { type: 'string' } } },
      ),
    )
    const error = result.errors.find(e => e.path === 'nodes.check.retryNodeId')
    expect(error?.message).toContain('template expressions are not resolved')
  })

  test('retryNodeId naming a sibling (non-ancestor) is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        baseNode({ id: 'sibling', command: 'echo other' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 'sibling' }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
    const error = result.errors.find(e => e.path === 'nodes.check.retryNodeId')
    expect(error?.message).toContain('transitive upstream ancestor')
  })

  test('retryNodeId naming a downstream consumer is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 'after' }),
        baseNode({ id: 'after', command: 'echo after', dependsOn: ['check'] }),
      ]),
    )
    expect(codes(result)).toContain('invalid_node_config')
  })

  test('non-string retryNodeId is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNodeId: 42 as never }),
      ]),
    )
    const error = result.errors.find(e => e.path === 'nodes.check.retryNodeId')
    expect(error?.message).toContain('non-empty string')
  })

  test('the retryNode alias is validated with the same rules', () => {
    const result = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        validatorNode({ dependsOn: ['produce'], retryNode: 'ghost' }),
      ]),
    )
    const error = result.errors.find(e => e.path === 'nodes.check.retryNode')
    expect(error?.message).toContain('missing node "ghost"')
  })

  test('runtime guard nodes (type guard) are covered, non-validator nodes are not', () => {
    const guardResult = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        baseNode({
          id: 'gate',
          type: 'guard',
          command: undefined,
          dependsOn: ['produce'],
          retryNodeId: 'ghost',
          checks: [{ type: 'file_exists', path: '/tmp/x' }],
        }),
      ]),
    )
    expect(codes(guardResult)).toContain('invalid_node_config')

    // The runtime never reads retryNodeId outside the validation path, so a
    // stray field on e.g. an exec node must not fail validation.
    const execResult = validate(
      baseDefinition([
        baseNode({ id: 'produce' }),
        baseNode({
          id: 'work',
          command: 'echo hi',
          dependsOn: ['produce'],
          retryNodeId: 'ghost',
        }),
      ]),
    )
    expect(execResult.ok).toBe(true)
  })

  test('state machine workflows skip the DAG ancestor rule', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({ id: 'produce' }),
          validatorNode({ dependsOn: [], retryNodeId: 'produce' }),
        ],
        {
          policy: {
            executionModel: 'state_machine',
            stateMachine: { initialNodeId: 'produce', maxTransitions: 5 },
          },
          transitions: [{ from: 'produce', to: 'check', route: 'success' }],
        },
      ),
    )
    expect(codes(result)).not.toContain('invalid_node_config')
  })
})

// ---------------------------------------------------------------------------
// K. Direct self-recursion (BUG4, static part)
//
// A subworkflow/map/loop node must not reference the workflow it is defined
// in: every child run would re-enter the same definition without bound. Only
// the direct, statically resolvable case is caught here; transitive cycles
// and the runtime recursion-depth cap live in the runtime's child-run
// resolution.
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition: direct self-recursion', () => {
  test('subworkflow node referencing its own workflow id is rejected', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          id: 'recurse',
          type: 'subworkflow',
          command: undefined,
          workflow: 'workflow:test-workflow',
        }),
      ]),
    )
    expect(codes(result)).toContain('workflow_cycle')
    const error = result.errors.find(e => e.path === 'nodes.recurse.workflow')
    expect(error?.message).toContain('references its own workflow')
  })

  test('version-qualified and bare self-references are rejected too', () => {
    for (const workflow of ['workflow:test-workflow@0.1.0', 'test-workflow']) {
      const result = validate(
        baseDefinition([
          baseNode({
            id: 'recurse',
            type: 'subworkflow',
            command: undefined,
            workflow,
          }),
        ]),
      )
      expect(codes(result)).toContain('workflow_cycle')
    }
  })

  test('self-reference through the sanitized asset id of the name is rejected', () => {
    // Publishing derives asset ids from the name via sanitizeId, so
    // "My Test Flow" publishes as workflow:My-Test-Flow.
    const result = validate(
      baseDefinition(
        [
          baseNode({
            id: 'recurse',
            type: 'subworkflow',
            command: undefined,
            workflow: 'workflow:My-Test-Flow',
          }),
        ],
        { name: 'My Test Flow' },
      ),
    )
    expect(codes(result)).toContain('workflow_cycle')
  })

  test('map and loop nodes referencing their own workflow are rejected', () => {
    const map = validate(
      baseDefinition([
        baseNode({
          id: 'fanout',
          type: 'map',
          command: undefined,
          workflow: 'workflow:test-workflow',
          items: [1, 2],
        }),
      ]),
    )
    expect(codes(map)).toContain('workflow_cycle')

    const loop = validate(
      baseDefinition([
        baseNode({
          id: 'iterate',
          type: 'loop',
          command: undefined,
          workflow: 'workflow:test-workflow',
          maxIterations: 3,
        }),
      ]),
    )
    expect(codes(loop)).toContain('workflow_cycle')
  })

  test('a different child workflow reference passes', () => {
    const result = validate(
      baseDefinition([
        baseNode({
          id: 'child',
          type: 'subworkflow',
          command: undefined,
          workflow: 'workflow:some-other-flow@1.0.0',
        }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  test('template workflow references are left to runtime resolution', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({
            id: 'child',
            type: 'subworkflow',
            command: undefined,
            workflow: '{{ parameters.child }}',
          }),
        ],
        { parameters: { child: { type: 'string' } } },
      ),
    )
    expect(codes(result)).not.toContain('workflow_cycle')
  })

  test('state machine workflows are covered as well', () => {
    const result = validate(
      baseDefinition(
        [
          baseNode({ id: 'start' }),
          baseNode({
            id: 'recurse',
            type: 'subworkflow',
            command: undefined,
            workflow: 'workflow:test-workflow',
          }),
        ],
        {
          policy: {
            executionModel: 'state_machine',
            stateMachine: { initialNodeId: 'start', maxTransitions: 5 },
          },
          transitions: [{ from: 'start', to: 'recurse', route: 'success' }],
        },
      ),
    )
    expect(codes(result)).toContain('workflow_cycle')
  })
})
