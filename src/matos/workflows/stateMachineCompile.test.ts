import { describe, expect, test } from 'bun:test'
import { parseWorkflowDefinition } from './schema.js'
import { workflowExecutionModel, transitionId } from './stateMachineTypes.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import { compileMatOSWorkflowDefinition } from './workflowCompile.js'

describe('MatOS state-machine workflow compile model', () => {
  test('parses explicit transition edges without adding DAG dependencies', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'cyclic-review',
        policy: {
          executionModel: 'state_machine',
          stateMachine: {
            initialNodeId: 'draft',
            maxTransitions: 6,
          },
        },
        nodes: {
          draft: { type: 'exec', command: 'printf draft' },
          review: {
            type: 'guard',
            checks: [{ type: 'expression', value: 'true' }],
          },
        },
        transitions: [
          {
            id: 'draft_to_review',
            from: 'draft',
            to: 'review',
            route: 'success',
          },
          {
            id: 'review_to_draft',
            from: 'review',
            to: 'draft',
            route: 'failure',
            maxTraversals: 3,
          },
        ],
      }),
      { sourcePath: 'workflow.json' },
    )

    expect(workflowExecutionModel(definition)).toBe('state_machine')
    expect(definition.nodes.find(node => node.id === 'draft')?.dependsOn).toEqual([])
    expect(definition.transitions?.map(transitionId)).toEqual([
      'draft_to_review',
      'review_to_draft',
    ])
  })

  test('requires bounded transition policy for state-machine workflows', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'bad-state-machine',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'a', maxTransitions: 0 },
      },
      outputs: {},
      nodes: [{ id: 'a', type: 'exec', dependsOn: [], command: 'printf a' }],
      transitions: [{ id: 'self', from: 'a', to: 'a' }],
    })

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'State-machine workflow requires maxTransitions greater than or equal to 1',
          path: 'policy.stateMachine.maxTransitions',
        }),
      ]),
    )
  })

  test('allows explicit bounded state-machine transition cycles', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'bounded-state-machine',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'draft', maxTransitions: 4 },
      },
      outputs: {},
      nodes: [
        { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
        {
          id: 'review',
          type: 'guard',
          dependsOn: [],
          checks: [{ type: 'expression', value: 'true' }],
        },
      ],
      transitions: [
        { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
        {
          id: 'review_to_draft',
          from: 'review',
          to: 'draft',
          route: 'failure',
          maxTraversals: 2,
        },
      ],
    })

    expect(validation).toEqual({ ok: true, errors: [] })
  })

  test('exposes state-machine execution metadata in compile views', () => {
    const compiled = compileMatOSWorkflowDefinition({
      schemaVersion: 1,
      name: 'compiled-state-machine',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'draft', maxTransitions: 2 },
      },
      outputs: {},
      nodes: [
        { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
        { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
      ],
      transitions: [
        { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
      ],
    })

    expect(compiled.metadata.executionModel).toBe('state_machine')
    expect(compiled.metadata.transitionCount).toBe(1)
  })
})
