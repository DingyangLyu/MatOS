// Card mini-map layout: layered depth → column, barycenter-ordered rows,
// bounded viewBox for tiny graphs, and edge anchor points on pill borders.

import { describe, expect, it } from 'vitest';
import {
  layoutWorkflowPreview,
  truncateMiniMapLabel,
  MINIMAP_NODE_HEIGHT,
  MINIMAP_NODE_WIDTH,
} from '../../src/components/workflow-minimap-model';

const node = (id: string, type = 'exec') => ({ id, type, label: id });

describe('layoutWorkflowPreview', () => {
  it('places a linear pipeline left-to-right on one row', () => {
    const layout = layoutWorkflowPreview(
      [node('plan', 'agent'), node('run'), node('check', 'guard')],
      [
        { from: 'plan', to: 'run' },
        { from: 'run', to: 'check' },
      ],
    );
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const plan = byId.get('plan')!;
    const run = byId.get('run')!;
    const check = byId.get('check')!;
    // Columns advance with depth; rows stay identical for a straight chain.
    expect(plan.x).toBeLessThan(run.x);
    expect(run.x).toBeLessThan(check.x);
    expect(plan.y).toBe(run.y);
    expect(run.y).toBe(check.y);
  });

  it('fans a diamond into a two-row middle layer and centers it', () => {
    const layout = layoutWorkflowPreview(
      [node('a'), node('b'), node('c'), node('d')],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    );
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get('b')!.x).toBe(byId.get('c')!.x);
    expect(byId.get('b')!.y).not.toBe(byId.get('c')!.y);
    // Single-node layers sit vertically centered against the tallest layer.
    const mid = (byId.get('b')!.y + byId.get('c')!.y) / 2;
    expect(Math.abs(byId.get('a')!.y - mid)).toBeLessThan(1);
  });

  it('anchors edges on the pill borders', () => {
    const layout = layoutWorkflowPreview([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const edge = layout.edges[0]!;
    expect(edge.x1).toBe(byId.get('a')!.x + MINIMAP_NODE_WIDTH);
    expect(edge.y1).toBe(byId.get('a')!.y + MINIMAP_NODE_HEIGHT / 2);
    expect(edge.x2).toBe(byId.get('b')!.x);
  });

  it('bounds the viewBox for tiny graphs and survives cycles', () => {
    const tiny = layoutWorkflowPreview([node('only')], []);
    expect(tiny.width).toBeGreaterThanOrEqual(330);
    expect(tiny.height).toBeGreaterThanOrEqual(132);

    const cyclic = layoutWorkflowPreview(
      [node('a'), node('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(cyclic.nodes).toHaveLength(2);
    expect(cyclic.edges).toHaveLength(2);
  });

  it('drops edges pointing at unknown nodes', () => {
    const layout = layoutWorkflowPreview([node('a')], [{ from: 'a', to: 'ghost' }]);
    expect(layout.edges).toHaveLength(0);
  });

  it('folds a long preview into bounded columns without losing nodes or edges', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`));
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id }));
    const layout = layoutWorkflowPreview(nodes, edges, 3);
    expect(new Set(layout.nodes.map(n => n.x)).size).toBe(3);
    expect(new Set(layout.nodes.map(n => n.y)).size).toBe(3);
    expect(layout.width).toBeLessThan(500);
    expect(layout.height).toBeLessThan(250);
    expect(layout.edges).toHaveLength(8);
    for (const n of layout.nodes) {
      expect(n.x + MINIMAP_NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(n.y + MINIMAP_NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe('truncateMiniMapLabel', () => {
  it('keeps short labels and ellipsizes long ones', () => {
    expect(truncateMiniMapLabel('plan')).toBe('plan');
    expect(truncateMiniMapLabel('generate_candidate_structures')).toBe('generate_candi…');
    expect(truncateMiniMapLabel('generate_candidate_structures')).toHaveLength(15);
  });
});
