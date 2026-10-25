// Asset relationship graph model — pure functions only (no React, no DOM).
//
// Builds the dependency graph from the bridge's asset catalog rows, extracts
// lineage subgraphs (upstream dependency closure + downstream dependents),
// and computes a deterministic cluster layout for the SVG relationship map:
// every asset type forms a round cluster (the largest type sits in the
// middle, the rest ring around it), nodes fill each cluster along a
// phyllotaxis spiral with hubs at the cluster core, and dependency edges are
// drawn between the actual node positions so cross-type relationships read
// as filaments between clusters. Everything is seeded/deterministic so tests
// can assert real geometry and re-renders never reshuffle the map.

export interface AssetGraphInput {
  ref: string;
  id: string;
  type: string;
  name: string;
  version?: string | null;
  packId?: string | null;
  status?: string | null;
  tags?: string[];
  dependencies?: string[];
}

export interface AssetGraphNode {
  ref: string;
  id: string;
  type: string;
  name: string;
  version: string | null;
  packId: string | null;
  status: string | null;
  tags: string[];
  /** Outgoing dependency refs resolved to catalog nodes. */
  dependsOn: string[];
  /** Incoming edges: nodes that depend on this one. */
  dependedBy: string[];
  /** Total degree used for visual sizing. */
  degree: number;
}

export interface AssetGraphEdge {
  from: string;
  to: string;
}

export interface AssetGraph {
  nodes: Map<string, AssetGraphNode>;
  edges: AssetGraphEdge[];
  types: string[];
}

// `dependencies` entries are canonical refs like `tool:vasp-runner@0.1.0` or
// unversioned `tool:vasp-runner`. Catalog nodes key by unversioned ref, so
// strip the version suffix when resolving edges.
export function unversionedRef(ref: string): string {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return ref;
  return ref.slice(0, at);
}

export function buildAssetGraph(assets: AssetGraphInput[]): AssetGraph {
  const nodes = new Map<string, AssetGraphNode>();
  for (const asset of assets) {
    if (!asset.ref || nodes.has(asset.ref)) continue;
    nodes.set(asset.ref, {
      ref: asset.ref,
      id: asset.id,
      type: asset.type,
      name: asset.name || asset.id,
      version: asset.version ?? null,
      packId: asset.packId ?? null,
      status: asset.status ?? null,
      tags: asset.tags ?? [],
      dependsOn: [],
      dependedBy: [],
      degree: 0,
    });
  }
  const edges: AssetGraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const asset of assets) {
    const from = nodes.get(asset.ref);
    if (!from) continue;
    for (const dep of asset.dependencies ?? []) {
      const target = unversionedRef(dep);
      const to = nodes.get(target);
      if (!to || to.ref === from.ref) continue;
      const key = `${from.ref}\u0000${to.ref}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from: from.ref, to: to.ref });
      from.dependsOn.push(to.ref);
      to.dependedBy.push(from.ref);
    }
  }
  for (const node of nodes.values()) {
    node.degree = node.dependsOn.length + node.dependedBy.length;
  }
  const types = [...new Set([...nodes.values()].map((n) => n.type))].sort();
  return { nodes, edges, types };
}

export interface AssetLineage {
  focus: string;
  /** Refs reachable by following dependencies out of the focus (what it uses). */
  upstream: Map<string, number>;
  /** Refs reachable by following dependents into the focus (what uses it). */
  downstream: Map<string, number>;
  /** All member refs including the focus. */
  members: Set<string>;
}

// Depth-tagged BFS in both directions. Depth is preserved so the inspector
// can show "direct" vs "transitive" tiers and the renderer can fade by hop.
export function lineageSubgraph(
  graph: AssetGraph,
  focusRef: string,
  maxDepth = 6,
): AssetLineage | null {
  const focus = graph.nodes.get(focusRef);
  if (!focus) return null;
  const walk = (start: string, next: (n: AssetGraphNode) => string[]): Map<string, number> => {
    const depths = new Map<string, number>();
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      depth += 1;
      const upcoming: string[] = [];
      for (const ref of frontier) {
        const node = graph.nodes.get(ref);
        if (!node) continue;
        for (const neighbor of next(node)) {
          if (neighbor === start || depths.has(neighbor)) continue;
          depths.set(neighbor, depth);
          upcoming.push(neighbor);
        }
      }
      frontier = upcoming;
    }
    return depths;
  };
  const upstream = walk(focusRef, (n) => n.dependsOn);
  const downstream = walk(focusRef, (n) => n.dependedBy);
  const members = new Set<string>([focusRef, ...upstream.keys(), ...downstream.keys()]);
  return { focus: focusRef, upstream, downstream, members };
}

// ---------------------------------------------------------------------------
// Cluster layout
// ---------------------------------------------------------------------------

export interface GraphLayoutPoint {
  x: number;
  y: number;
}

export interface GraphCluster {
  type: string;
  cx: number;
  cy: number;
  /** Halo radius that encloses every member node (with padding). */
  r: number;
  count: number;
}

export interface AssetGraphLayout {
  points: Map<string, GraphLayoutPoint>;
  clusters: GraphCluster[];
  /** Content extent (square world, origin at 0,0). */
  size: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Distance between phyllotaxis rings inside a cluster. */
const NODE_SPACING = 24;
/** Breathing room added around a cluster's node field for the halo. */
const CLUSTER_PADDING = 30;
/** Gap kept between neighboring cluster halos. */
const CLUSTER_GAP = 56;

function hashString(value: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h = (h ^ value.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic per-string jitter in [0, 1). */
function hash01(value: string): number {
  return hashString(value) / 0x100000000;
}

function clusterFieldRadius(count: number): number {
  return count <= 1 ? 0 : NODE_SPACING * Math.sqrt(count + 0.7);
}

/**
 * Deterministic cluster layout: the most-populated type sits at the world
 * center, every other type becomes a satellite cluster on a ring around it
 * (angular slots proportional to cluster size so big neighbors do not
 * collide). Inside a cluster, members sort hubs-first and fill the disc
 * along a golden-angle spiral, so the core of each cluster is its most
 * connected asset. No physics: dependency edges are drawn between final
 * positions, which keeps the layout stable, fast, and overlap-free.
 */
export function runClusterLayout(graph: AssetGraph): AssetGraphLayout {
  const points = new Map<string, GraphLayoutPoint>();
  const clusters: GraphCluster[] = [];
  const byType = new Map<string, AssetGraphNode[]>();
  for (const node of graph.nodes.values()) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }
  if (byType.size === 0) {
    return { points, clusters, size: 400 };
  }
  const ordered = [...byType.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const radii = ordered.map(([, members]) => clusterFieldRadius(members.length) + CLUSTER_PADDING);
  const center = ordered[0]!;
  const centerR = radii[0]!;
  const satellites = ordered.slice(1);
  const satelliteRadii = radii.slice(1);

  // Ring radius: far enough that the largest satellite clears the center
  // cluster, AND long enough that all satellite arcs fit the circumference.
  const maxSatelliteR = satelliteRadii.length > 0 ? Math.max(...satelliteRadii) : 0;
  const arcs = satelliteRadii.map((r) => 2 * r + CLUSTER_GAP);
  const totalArc = arcs.reduce((sum, arc) => sum + arc, 0);
  const ringRadius = satellites.length === 0
    ? 0
    : Math.max(centerR + CLUSTER_GAP + maxSatelliteR, totalArc / (2 * Math.PI)) * 1.06;

  const worldRadius = ringRadius + maxSatelliteR + CLUSTER_GAP;
  const size = Math.max(400, Math.ceil((worldRadius || centerR + CLUSTER_GAP) * 2));
  const cx = size / 2;
  const cy = size / 2;

  const placeCluster = (
    type: string,
    members: AssetGraphNode[],
    clusterX: number,
    clusterY: number,
    haloR: number,
  ) => {
    // Hubs first so the spiral seats them at the cluster core; pack then ref
    // keeps siblings adjacent and the order fully deterministic.
    const sorted = [...members].sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      const pa = a.packId ?? a.ref;
      const pb = b.packId ?? b.ref;
      return pa === pb ? a.ref.localeCompare(b.ref) : pa.localeCompare(pb);
    });
    const spin = hash01(type) * Math.PI * 2;
    for (let k = 0; k < sorted.length; k++) {
      const node = sorted[k]!;
      if (sorted.length === 1) {
        points.set(node.ref, { x: clusterX, y: clusterY });
        continue;
      }
      // Radial jitter keeps rings from reading as perfect circles without
      // ever pushing a node outside its cluster halo.
      const wobble = 1 + (hash01(node.ref) - 0.5) * 0.14;
      const radius = NODE_SPACING * Math.sqrt(k + 0.7) * wobble;
      const angle = spin + k * GOLDEN_ANGLE;
      points.set(node.ref, {
        x: clusterX + Math.cos(angle) * radius,
        y: clusterY + Math.sin(angle) * radius,
      });
    }
    clusters.push({ type, cx: clusterX, cy: clusterY, r: haloR, count: members.length });
  };

  placeCluster(center[0], center[1], cx, cy, centerR);

  let arcCursor = 0;
  for (let i = 0; i < satellites.length; i++) {
    const [type, members] = satellites[i]!;
    const arc = arcs[i]!;
    const theta = totalArc === 0
      ? 0
      : ((arcCursor + arc / 2) / totalArc) * Math.PI * 2 - Math.PI / 2;
    arcCursor += arc;
    placeCluster(
      type,
      members,
      cx + Math.cos(theta) * ringRadius,
      cy + Math.sin(theta) * ringRadius,
      satelliteRadii[i]!,
    );
  }

  return { points, clusters, size };
}

/** Node radius from connectivity: quiet leaves stay small, hubs grow. */
export function nodeRadius(node: AssetGraphNode): number {
  return 4 + Math.min(9, Math.log2(1 + node.degree) * 2.1);
}

/**
 * Pick the node whose disc (plus slack) is under a world-space pointer.
 * Prefers the nearest center when discs overlap.
 */
export function pickGraphNode(
  graph: AssetGraph,
  points: Map<string, GraphLayoutPoint>,
  wx: number,
  wy: number,
  slack = 4,
): AssetGraphNode | null {
  let best: AssetGraphNode | null = null;
  let bestD2 = Infinity;
  for (const node of graph.nodes.values()) {
    const p = points.get(node.ref);
    if (!p) continue;
    const r = nodeRadius(node) + slack;
    const dx = p.x - wx;
    const dy = p.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bestD2) {
      best = node;
      bestD2 = d2;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Type identity
// ---------------------------------------------------------------------------

/**
 * Stable per-type hue so clusters read as consistent color families across
 * sessions. Every product-facing registry type gets a fixed slot; unknown
 * future types fall back to a name hash.
 */
export const ASSET_TYPE_HUES: Record<string, number> = {
  knowledge: 210,
  data: 185,
  tool: 38,
  mcp: 24,
  skill: 268,
  role: 145,
  workflow: 325,
  benchmark: 55,
  'benchmark-suite': 62,
  evaluation: 95,
  runtime: 232,
};

export function assetTypeHue(type: string): number {
  return ASSET_TYPE_HUES[type] ?? (hashString(type) % 360);
}

/** Tags that mark physical-world / laboratory assets (instrument drivers,
 * measurement SOPs, adapter contracts). Used for the lab lens badge. */
const LAB_TAGS = new Set(['instrument', 'lab', 'world-interface']);

export function isLabAsset(node: Pick<AssetGraphNode, 'tags'>): boolean {
  return node.tags.some((tag) => LAB_TAGS.has(tag.toLowerCase()));
}
