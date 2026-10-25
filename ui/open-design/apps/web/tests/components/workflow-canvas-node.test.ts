import { describe, expect, it } from 'vitest';
import type { WorkflowRunNodeSummary } from '../../src/components/matos-workflow-client';
import {
  decorateWorkflowCanvasEdges,
  workflowCanvasEdgeKey,
} from '../../src/components/workflow-canvas-node';
import type { CanvasEdge } from '../../src/components/workflow-model';

const edges: CanvasEdge[] = [
  { from: 'prepare', to: 'run', explicit: false },
  { from: 'run', to: 'validate', explicit: false },
];

function runNode(nodeId: string, status: string): WorkflowRunNodeSummary {
  return {
    nodeId,
    status,
    attempts: 1,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
  };
}

describe('workflow canvas run decoration', () => {
  it('uses one stable edge identity across workflow surfaces', () => {
    expect(workflowCanvasEdgeKey(edges[0]!)).toBe('prepare\u0000run');
  });

  it('animates the edge entering the active node', () => {
    const runNodes = new Map([
      ['prepare', runNode('prepare', 'completed')],
      ['run', runNode('run', 'running')],
      ['validate', runNode('validate', 'pending')],
    ]);

    const decorated = decorateWorkflowCanvasEdges(edges, runNodes);

    expect(decorated[0]).toMatchObject({ animated: true, className: 'wf-edge-active' });
    expect(decorated[1]).toMatchObject({ animated: false, className: undefined });
  });

  it('animates the edge into a node waiting for human input/approval', () => {
    // Native runs park on `waiting_input` (human/dynamic nodes) and
    // `waiting_approval` — both are active states from the graph's view.
    const decorated = decorateWorkflowCanvasEdges(
      edges,
      new Map([
        ['prepare', runNode('prepare', 'completed')],
        ['run', runNode('run', 'waiting_input')],
      ]),
    );
    expect(decorated[0]).toMatchObject({ animated: true, className: 'wf-edge-active' });
  });

  it('marks completed and failed paths without animation', () => {
    const completed = decorateWorkflowCanvasEdges(
      edges,
      new Map([
        ['prepare', runNode('prepare', 'completed')],
        ['run', runNode('run', 'completed')],
        ['validate', runNode('validate', 'failed')],
      ]),
    );

    expect(completed[0]).toMatchObject({ animated: false, className: 'wf-edge-done' });
    expect(completed[1]).toMatchObject({ animated: false, className: 'wf-edge-to-failed' });
  });
});
