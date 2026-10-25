import { describe, expect, it } from 'vitest';
import {
  assetTypeHue,
  buildAssetGraph,
  isLabAsset,
  lineageSubgraph,
  nodeRadius,
  pickGraphNode,
  runClusterLayout,
  unversionedRef,
  type AssetGraphInput,
} from '../../src/components/asset-graph-model';

function catalog(): AssetGraphInput[] {
  return [
    { ref: 'role:compute', id: 'compute', type: 'role', name: 'Compute', dependencies: ['skill:vasp@0.1.0', 'tool:runner', 'knowledge:mp'] },
    { ref: 'skill:vasp', id: 'vasp', type: 'skill', name: 'VASP', dependencies: ['tool:runner@0.2.0'] },
    { ref: 'tool:runner', id: 'runner', type: 'tool', name: 'Runner', dependencies: [] },
    { ref: 'knowledge:mp', id: 'mp', type: 'knowledge', name: 'MP DB', dependencies: [] },
    { ref: 'workflow:relax', id: 'relax', type: 'workflow', name: 'Relax', dependencies: ['role:compute'] },
    // Dangling dependency: not in the catalog, must not create an edge.
    { ref: 'skill:orphan', id: 'orphan', type: 'skill', name: 'Orphan', dependencies: ['tool:not-installed'] },
  ];
}

describe('asset graph model', () => {
  it('strips version suffixes when resolving dependency refs', () => {
    expect(unversionedRef('tool:runner@0.2.0')).toBe('tool:runner');
    expect(unversionedRef('tool:runner')).toBe('tool:runner');
    expect(unversionedRef('role:materials-planner@0.1.0')).toBe('role:materials-planner');
  });

  it('builds nodes and bidirectional edges, skipping dangling refs', () => {
    const graph = buildAssetGraph(catalog());
    expect(graph.nodes.size).toBe(6);
    // role:compute -> skill:vasp resolved through the versioned ref.
    expect(graph.nodes.get('role:compute')?.dependsOn).toContain('skill:vasp');
    expect(graph.nodes.get('skill:vasp')?.dependedBy).toContain('role:compute');
    // Dangling target produced no edge.
    expect(graph.nodes.get('skill:orphan')?.dependsOn).toEqual([]);
    // Degree counts both directions: compute has 3 out + 1 in (workflow).
    expect(graph.nodes.get('role:compute')?.degree).toBe(4);
    expect(graph.edges).toHaveLength(5);
    expect(graph.types).toEqual(['knowledge', 'role', 'skill', 'tool', 'workflow']);
  });

  it('extracts depth-tagged lineage in both directions', () => {
    const graph = buildAssetGraph(catalog());
    const lineage = lineageSubgraph(graph, 'skill:vasp');
    expect(lineage).not.toBeNull();
    // Upstream: what vasp uses (runner at depth 1).
    expect(lineage!.upstream.get('tool:runner')).toBe(1);
    // Downstream: compute uses vasp (depth 1), relax uses compute (depth 2).
    expect(lineage!.downstream.get('role:compute')).toBe(1);
    expect(lineage!.downstream.get('workflow:relax')).toBe(2);
    expect(lineage!.members.has('skill:vasp')).toBe(true);
    expect(lineage!.members.has('knowledge:mp')).toBe(false);
    expect(lineageSubgraph(graph, 'missing:ref')).toBeNull();
  });

  it('scales node radius with degree and keeps type hues stable', () => {
    const graph = buildAssetGraph(catalog());
    const hub = graph.nodes.get('role:compute')!;
    const leaf = graph.nodes.get('knowledge:mp')!;
    expect(nodeRadius(hub)).toBeGreaterThan(nodeRadius(leaf));
    expect(assetTypeHue('role')).toBe(145);
    // Newly bridged product types have fixed hue slots too.
    expect(assetTypeHue('benchmark')).toBe(55);
    expect(assetTypeHue('runtime')).toBe(232);
    expect(assetTypeHue('unknown-type')).toBe(assetTypeHue('unknown-type'));
  });

  it('flags lab / physical-world assets by tag', () => {
    expect(isLabAsset({ tags: ['instrument', 'xrd'] })).toBe(true);
    expect(isLabAsset({ tags: ['World-Interface'] })).toBe(true);
    expect(isLabAsset({ tags: ['materials', 'vasp'] })).toBe(false);
    expect(isLabAsset({ tags: [] })).toBe(false);
  });
});

// Registry-shaped catalog: 7 type families x 40 assets with chain
// dependencies inside each family plus heavy cross-family hubs (every skill
// -> one tool, every workflow -> one role + one skill), mirroring the real
// catalog shape.
function denseCatalog(): AssetGraphInput[] {
  const types = ['role', 'skill', 'tool', 'knowledge', 'workflow', 'mcp', 'data'];
  const assets: AssetGraphInput[] = [];
  for (const type of types) {
    for (let i = 0; i < 40; i++) {
      const deps: string[] = [];
      if (i > 0 && i % 4 !== 0) deps.push(`${type}:${type}-${i - 1}`);
      if (type === 'skill') deps.push('tool:tool-0');
      if (type === 'workflow') {
        deps.push('role:role-0');
        deps.push(`skill:skill-${i}`);
      }
      if (type === 'role') deps.push('knowledge:knowledge-0');
      if (type === 'mcp') deps.push('tool:tool-1');
      assets.push({
        ref: `${type}:${type}-${i}`,
        id: `${type}-${i}`,
        type,
        name: `${type} ${i}`,
        packId: `pack-${type}-${Math.floor(i / 10)}`,
        dependencies: deps,
      });
    }
  }
  return assets;
}

describe('cluster layout', () => {
  it('is deterministic and places every node inside its own type cluster', () => {
    const graph = buildAssetGraph(denseCatalog());
    const a = runClusterLayout(graph);
    const b = runClusterLayout(graph);
    expect(a.points.size).toBe(graph.nodes.size);
    expect(a.size).toBe(b.size);
    const clusterByType = new Map(a.clusters.map((c) => [c.type, c]));
    expect(clusterByType.size).toBe(graph.types.length);
    for (const [ref, p] of a.points) {
      // Same input, same geometry.
      expect(b.points.get(ref)).toEqual(p);
      // Node sits inside (or on) its cluster halo.
      const node = graph.nodes.get(ref)!;
      const cluster = clusterByType.get(node.type)!;
      expect(Math.hypot(p.x - cluster.cx, p.y - cluster.cy)).toBeLessThanOrEqual(cluster.r + 0.5);
      // And inside the world extent.
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(a.size);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(a.size);
    }
  });

  it('keeps clusters apart and nodes overlap-free', () => {
    const graph = buildAssetGraph(denseCatalog());
    const layout = runClusterLayout(graph);
    // Cluster halos never intersect.
    for (let i = 0; i < layout.clusters.length; i++) {
      for (let j = i + 1; j < layout.clusters.length; j++) {
        const a = layout.clusters[i]!;
        const b = layout.clusters[j]!;
        expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThan(a.r + b.r);
      }
    }
    // No two nodes sit on top of each other.
    const pts = [...layout.points.values()];
    let minNearest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d < minNearest) minNearest = d;
      }
    }
    expect(minNearest).toBeGreaterThan(7);
  });

  it('seats the most-connected asset at the core of its cluster', () => {
    const graph = buildAssetGraph(denseCatalog());
    const layout = runClusterLayout(graph);
    const toolCluster = layout.clusters.find((c) => c.type === 'tool')!;
    const tools = [...graph.nodes.values()].filter((n) => n.type === 'tool');
    const hub = tools.reduce((best, n) => (n.degree > best.degree ? n : best));
    // The catalog's tool hub carries dozens of links (skills/mcps fan in).
    expect(hub.degree).toBeGreaterThan(30);
    const hubPoint = layout.points.get(hub.ref)!;
    const hubDist = Math.hypot(hubPoint.x - toolCluster.cx, hubPoint.y - toolCluster.cy);
    for (const node of tools) {
      if (node.ref === hub.ref) continue;
      const p = layout.points.get(node.ref)!;
      expect(hubDist).toBeLessThanOrEqual(Math.hypot(p.x - toolCluster.cx, p.y - toolCluster.cy));
    }
  });

  it('handles tiny and empty registries', () => {
    const empty = runClusterLayout(buildAssetGraph([]));
    expect(empty.points.size).toBe(0);
    expect(empty.clusters).toEqual([]);
    const single = runClusterLayout(
      buildAssetGraph([{ ref: 'tool:x', id: 'x', type: 'tool', name: 'X' }]),
    );
    expect(single.points.size).toBe(1);
    expect(single.clusters).toHaveLength(1);
    const p = single.points.get('tool:x')!;
    expect(p.x).toBeCloseTo(single.size / 2);
    expect(p.y).toBeCloseTo(single.size / 2);
  });
});

describe('pickGraphNode', () => {
  it('picks the node under the pointer and prefers the nearest center', () => {
    const graph = buildAssetGraph(catalog());
    const layout = runClusterLayout(graph);
    const target = graph.nodes.get('role:compute')!;
    const p = layout.points.get(target.ref)!;
    expect(pickGraphNode(graph, layout.points, p.x + 1, p.y - 1)?.ref).toBe(target.ref);
    // Far away from every node: nothing picked.
    expect(pickGraphNode(graph, layout.points, -500, -500)).toBeNull();
    // Slack extends the hit area for zoomed-out pointers.
    const r = nodeRadius(target);
    expect(pickGraphNode(graph, layout.points, p.x + r + 6, p.y, 8)?.ref).toBe(target.ref);
    expect(pickGraphNode(graph, layout.points, p.x + r + 6, p.y, 0.5)).toBeNull();
  });
});
