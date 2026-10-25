import { describe, expect, test } from 'bun:test'
import {
  allWorkflowNodesFinished,
  blockedWorkflowNodeToSkip,
  downstreamWorkflowNodeIds,
  readyWorkflowNodes,
  routeMatchesStatus,
} from './scheduler.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNodeRunSnapshot,
} from './types.js'

function nodeRun(
  nodeId: string,
  status: MatOSWorkflowNodeRunSnapshot['status'],
  output?: unknown,
): MatOSWorkflowNodeRunSnapshot {
  return {
    nodeId,
    status,
    attempts: 1,
    updatedAt: '2026-05-31T00:00:00.000Z',
    output,
  }
}

function fixtureDefinition(): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'scheduler',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes: [
      { id: 'a', type: 'exec', dependsOn: [], command: 'true' },
      { id: 'b', type: 'exec', dependsOn: [], command: 'true' },
      {
        id: 'c',
        type: 'exec',
        dependsOn: ['a'],
        command: 'true',
        incomingEdges: [
          {
            from: 'a',
            to: 'c',
            condition: '{{ nodes.a.outputs.ok }} == true',
          },
        ],
      },
      { id: 'd', type: 'exec', dependsOn: ['c'], command: 'true' },
    ],
  }
}

describe('MatOS workflow scheduler', () => {
  test('computes deterministic ready sets in graph order', () => {
    const ready = readyWorkflowNodes({
      definition: fixtureDefinition(),
      nodeRuns: new Map(),
      parameters: {},
    })

    expect(ready.map(node => node.id)).toEqual(['a', 'b'])
  })

  test('identifies skipped conditional branches and downstream nodes', () => {
    const definition = fixtureDefinition()
    const nodeRuns = new Map([
      ['a', nodeRun('a', 'completed', { ok: false })],
      ['b', nodeRun('b', 'completed')],
    ])

    expect(
      blockedWorkflowNodeToSkip({ definition, nodeRuns, parameters: {} })?.id,
    ).toBe('c')
    expect(downstreamWorkflowNodeIds(definition, 'c')).toEqual(['d'])
  })

  test('treats completed skipped and cancelled nodes as finished', () => {
    const definition = fixtureDefinition()
    const nodeRuns = new Map([
      ['a', nodeRun('a', 'completed')],
      ['b', nodeRun('b', 'completed')],
      ['c', nodeRun('c', 'skipped')],
      ['d', nodeRun('d', 'cancelled')],
    ])

    expect(allWorkflowNodesFinished(definition, nodeRuns)).toBe(true)
  })

  test('routes failed dependencies only through explicit failure edges', () => {
    const definition: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'failure-routing',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'submit', type: 'exec', dependsOn: [] },
        {
          id: 'recover',
          type: 'exec',
          dependsOn: ['submit'],
          incomingEdges: [
            { from: 'submit', to: 'recover', route: 'failure' },
          ],
        },
        {
          id: 'success_report',
          type: 'exec',
          dependsOn: ['submit'],
          incomingEdges: [
            { from: 'submit', to: 'success_report', route: 'success' },
          ],
        },
        {
          id: 'audit',
          type: 'exec',
          dependsOn: ['submit'],
          incomingEdges: [
            { from: 'submit', to: 'audit', route: 'always' },
          ],
        },
      ],
    }
    const nodeRuns = new Map<string, MatOSWorkflowNodeRunSnapshot>([
      [
        'submit',
        {
          nodeId: 'submit',
          status: 'failed',
          attempts: 1,
          updatedAt: '2026-05-31T00:00:00.000Z',
          error: { message: 'external tool failed' },
        },
      ],
    ])

    expect(
      readyWorkflowNodes({
        definition,
        nodeRuns,
        parameters: {},
      }).map(node => node.id),
    ).toEqual(['recover', 'audit'])
    expect(
      blockedWorkflowNodeToSkip({
        definition,
        nodeRuns,
        parameters: {},
      })?.id,
    ).toBe('success_report')
  })
})

describe('workflow route normalization', () => {
  test('normalizes whitespace and case in agent-authored route labels', () => {
    expect(routeMatchesStatus(' Success ', 'completed')).toBe(true)
    expect(routeMatchesStatus('FAILURE', 'failed')).toBe(true)
    expect(routeMatchesStatus(' always ', 'completed')).toBe(true)
  })
})
