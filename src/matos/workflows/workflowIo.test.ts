import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowDefinition } from './types.js'
import {
  buildWorkflowRunIoProtocol,
  buildWorkflowRunPreflight,
  workflowIoDigest,
} from './workflowIo.js'

function workflowFixture(
  nodes: MatOSWorkflowDefinition['nodes'],
): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'io-fixture',
    parameters: {
      structure: {
        type: 'path',
        required: true,
        description: 'Workspace-visible structure path.',
      },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes,
  }
}

describe('MatOS workflow IO protocol', () => {
  test('projects direct compute nodes as external backend side effects', () => {
    const io = buildWorkflowRunIoProtocol(
      workflowFixture([
        {
          id: 'submit',
          type: 'compute',
          dependsOn: [],
          backend: 'hpc-queue',
          operation: 'submit',
          inputContract: {
            yamlPath: { type: 'string', required: true },
          },
          artifactContract: {
            stdout: { path: 'stdout.log', kind: 'log' },
          },
        },
      ]),
    )

    expect(io.parameterContract.structure).toMatchObject({
      type: 'path',
      required: true,
    })
    expect(io.nodes[0]).toMatchObject({
      nodeId: 'submit',
      type: 'compute',
      runtimeType: 'backend',
      targetType: 'compute',
      sideEffectClass: 'external_backend',
      missingRequiredInputKeys: ['yamlPath'],
      artifacts: {
        stdout: { id: 'stdout', path: 'stdout.log', kind: 'log' },
      },
    })
    expect(io.artifactContracts).toEqual([
      {
        nodeId: 'submit',
        artifactId: 'stdout',
        contract: { id: 'stdout', path: 'stdout.log', kind: 'log' },
      },
    ])
  })

  test('reports run preflight prompts from native validation and intake state', () => {
    const preflight = buildWorkflowRunPreflight({
      definition: workflowFixture([
        {
          id: 'prepare',
          type: 'exec',
          dependsOn: [],
          command: 'true',
          inputContract: {
            structure: { type: 'string', required: true },
          },
        },
      ]),
      missingRequiredParameters: ['structure'],
    })

    expect(preflight.canRun).toBe(false)
    expect(preflight.missingRequiredParameters).toEqual(['structure'])
    expect(preflight.missingNodeInputs).toEqual([
      {
        nodeId: 'prepare',
        key: 'structure',
        severity: 'warning',
        reason: 'Required node input contract has no explicit binding in the workflow definition.',
      },
    ])
    expect(preflight.prompts.map(prompt => prompt.kind)).toEqual([
      'missing_parameter',
      'missing_node_input',
    ])
  })

  test('hashes IO payloads with stable key ordering', () => {
    expect(workflowIoDigest({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(
      workflowIoDigest({ a: [1, { c: 3, d: 4 }], b: 2 }),
    )
    expect(workflowIoDigest(undefined)).toBe(workflowIoDigest(null))
  })
})
