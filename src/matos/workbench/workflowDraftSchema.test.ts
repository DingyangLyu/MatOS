import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import { normalizeWorkflowNodeContract } from '../workflows/workflowContracts.js'
import {
  definitionFromCozeCanvas,
  workflowDefinitionToDraftSchema,
} from './workflowDraftSchema.js'
import { paramsFromCozeFields } from './workflowDraftCanvasParse.js'
import type { MatOSWorkbenchWorkflowDraftIssue } from './types.js'

function semanticDefinition(): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'semantic workflow',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [
      {
        id: 'approve',
        type: 'approval_gate',
        dependsOn: [],
        prompt: 'Approve compute.',
      },
      {
        id: 'relax',
        type: 'compute',
        dependsOn: ['approve'],
        backend: 'hpc-queue',
        operation: 'submit',
        input: { yamlPath: '{{ parameters.yamlPath }}' },
        outputContract: {
          taskId: { type: 'string' },
          artifacts: { type: 'list' },
        },
      },
      {
        id: 'validate',
        type: 'validate',
        dependsOn: ['relax'],
        checks: [{ type: 'file_exists', path: 'OUTCAR' }],
      },
    ],
    edges: [
      { from: 'approve', to: 'relax' },
      { from: 'relax', to: 'validate' },
    ],
    outputs: {},
  }
}

describe('workflow draft schema manifest bridge', () => {
  test('projects semantic MatOS nodes into Coze nodes with manifest runtime metadata', () => {
    const schema = workflowDefinitionToDraftSchema(semanticDefinition())
    const nodes = schema.nodes as Array<Record<string, unknown>>
    const byId = new Map(nodes.map(node => [String(node.id), node]))

    expect(byId.get('approve')).toMatchObject({
      type: '18',
      data: {
        matos: {
          type: 'approval_gate',
          runtimeType: 'human',
          targetType: 'approval_gate',
        },
      },
    })
    expect(byId.get('relax')).toMatchObject({
      type: '4',
      data: {
        nodeMeta: { subTitle: 'Compute Job' },
        matos: {
          type: 'compute',
          runtimeType: 'backend',
          targetType: 'compute',
          outputContract: {
            artifacts: { type: 'list' },
          },
        },
      },
    })
    expect(byId.get('validate')).toMatchObject({
      type: '8',
      data: {
        matos: {
          type: 'validate',
          runtimeType: 'guard',
          targetType: 'validate',
        },
      },
    })
  })

  test('recovers precise semantic node type from current definition when Coze strips matos type', () => {
    const current = semanticDefinition()
    const schema = workflowDefinitionToDraftSchema(current)
    const nodes = schema.nodes as Array<Record<string, unknown>>
    const stripped = {
      ...schema,
      nodes: nodes.map(node =>
        node.id === 'relax'
          ? {
              ...node,
              data: {
                ...(node.data as Record<string, unknown>),
                matos: {
                  id: 'relax',
                  dependsOn: ['approve'],
                },
              },
            }
          : node,
      ),
    }
    const issues: MatOSWorkbenchWorkflowDraftIssue[] = []
    const { definition } = definitionFromCozeCanvas({ schema_json: stripped }, issues, current)

    expect(issues).toEqual([])
    expect(definition.nodes.find(node => node.id === 'relax')).toMatchObject({
      id: 'relax',
      type: 'compute',
      backend: 'hpc-queue',
      operation: 'submit',
      input: { yamlPath: '{{ parameters.yamlPath }}' },
    })
  })

  test('round-trips Coze field aliases without leaking UI-only types into runtime contracts', () => {
    const params = paramsFromCozeFields(
      [
        { name: 'count', type: 'integer', required: true, default: '3' },
        { name: 'temperatures', type: 'list', required: false },
      ],
      {
        currentSpecs: {
          count: { type: 'integer', required: true, default: 3, unit: 'steps' },
        },
      },
    )

    expect(params.count).toEqual({ type: 'integer', required: true, default: 3, unit: 'steps' })
    expect(params.temperatures).toMatchObject({ type: 'array', required: false })

    const contract = normalizeWorkflowNodeContract({
      id: 'parse',
      type: 'exec',
      dependsOn: [],
      command: 'printf ok',
      inputContract: {
        count: { type: 'integer' },
        temperatures: { type: 'list' },
        cutoff: { type: 'float' },
      },
    })
    expect(contract.inputs).toMatchObject({
      count: { type: 'number' },
      temperatures: { type: 'array' },
      cutoff: { type: 'number' },
    })
  })
})
