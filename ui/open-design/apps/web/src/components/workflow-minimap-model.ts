// Layout model for the workflow card mini-maps (Home asset gallery tiles).
//
// Same layered idea as the Workflow Studio fallback layout — topological
// depth becomes the column, order within a layer becomes the row — but sized
// for a ~360×190 card frame and with a cheap barycenter pass (rows follow
// the average parent row) so typical pipeline DAGs render with few
// crossings. Pure data → data, no React/DOM, so tests can cover it directly.

export interface WorkflowPreviewNode {
  id: string;
  type: string;
  label: string;
}

export interface WorkflowPreviewEdge {
  from: string;
  to: string;
}

export type { MatOSWorkflowPreview as WorkflowPreviewGraph } from '@open-design/contracts';

export const MINIMAP_NODE_WIDTH = 108;
export const MINIMAP_NODE_HEIGHT = 26;
const COLUMN_GAP = 46;
const ROW_GAP = 14;
const PADDING = 12;
// Bound the upscale of tiny graphs (a 2-node flow should not fill the frame
// with giant pills): pad the viewBox up to a minimum design size instead.
const MIN_VIEW_WIDTH = 330;
const MIN_VIEW_HEIGHT = 132;

export interface MiniMapPlacedNode extends WorkflowPreviewNode {
  x: number;
  y: number;
}

export interface MiniMapPlacedEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MiniMapLayout {
  width: number;
  height: number;
  nodes: MiniMapPlacedNode[];
  edges: MiniMapPlacedEdge[];
}

export function layoutWorkflowPreview(
  nodes: WorkflowPreviewNode[],
  edges: WorkflowPreviewEdge[],
  maxColumns = Number.POSITIVE_INFINITY,
): MiniMapLayout {
  const ids = new Set(nodes.map((node) => node.id));
  const parents = new Map<string, string[]>();
  for (const node of nodes) parents.set(node.id, []);
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) parents.get(edge.to)!.push(edge.from);
  }

  // Longest-path depth; cycles fall back to depth 0 at the revisit point.
  const depths = new Map<string, number>();
  const depthOf = (id: string, trail: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 0;
    trail.add(id);
    const sources = parents.get(id) ?? [];
    const depth =
      sources.length === 0 ? 0 : Math.max(...sources.map((p) => depthOf(p, trail))) + 1;
    trail.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node.id, new Set());

  // Group by depth, then order each layer by the mean row of its parents
  // (parents always live in shallower layers, so their rows are final).
  const layers = new Map<number, WorkflowPreviewNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const layer = layers.get(depth) ?? [];
    layer.push(node);
    layers.set(depth, layer);
  }
  const rows = new Map<string, number>();
  const orderedDepths = [...layers.keys()].sort((a, b) => a - b);
  let maxRows = 0;
  for (const depth of orderedDepths) {
    const layer = layers.get(depth)!;
    const keyed = layer.map((node, index) => {
      const parentRows = (parents.get(node.id) ?? [])
        .map((p) => rows.get(p))
        .filter((row): row is number => row !== undefined);
      const barycenter =
        parentRows.length > 0
          ? parentRows.reduce((sum, row) => sum + row, 0) / parentRows.length
          : index;
      return { node, barycenter, index };
    });
    keyed.sort((a, b) => a.barycenter - b.barycenter || a.index - b.index);
    keyed.forEach((entry, row) => rows.set(entry.node.id, row));
    maxRows = Math.max(maxRows, layer.length);
  }

  const depthCount = orderedDepths.length > 0 ? Math.max(...orderedDepths) + 1 : 0;
  const columns = Math.max(1, Math.min(depthCount, maxColumns));
  const bandRows = new Map<number, number>();
  for (const depth of orderedDepths) {
    const band = Math.floor(depth / columns);
    bandRows.set(band, Math.max(bandRows.get(band) ?? 0, layers.get(depth)!.length));
  }
  const bandTops = new Map<number, number>();
  let bandHeight = 0;
  for (const [band, count] of bandRows) {
    bandTops.set(band, bandHeight);
    bandHeight += count * MINIMAP_NODE_HEIGHT + Math.max(0, count - 1) * ROW_GAP + 38;
  }
  const contentWidth =
    PADDING * 2 + columns * MINIMAP_NODE_WIDTH + Math.max(0, columns - 1) * COLUMN_GAP;
  const contentHeight =
    PADDING * 2 + Math.max(0, bandHeight - 38);
  const width = Math.max(contentWidth, MIN_VIEW_WIDTH);
  const height = Math.max(contentHeight, MIN_VIEW_HEIGHT);
  const offsetX = (width - contentWidth) / 2 + PADDING;

  // Center each layer vertically inside the tallest layer's band.
  const layerHeight = (count: number) =>
    count * MINIMAP_NODE_HEIGHT + Math.max(0, count - 1) * ROW_GAP;
  const placed = new Map<string, MiniMapPlacedNode>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const row = rows.get(node.id) ?? 0;
    const layerCount = layers.get(depth)?.length ?? 1;
    const band = Math.floor(depth / columns);
    const layerTop = (height - contentHeight) / 2 + PADDING + (bandTops.get(band) ?? 0)
      + (layerHeight(bandRows.get(band) ?? maxRows) - layerHeight(layerCount)) / 2;
    placed.set(node.id, {
      ...node,
      x: offsetX + (depth % columns) * (MINIMAP_NODE_WIDTH + COLUMN_GAP),
      y: layerTop + row * (MINIMAP_NODE_HEIGHT + ROW_GAP),
    });
  }

  const placedEdges: MiniMapPlacedEdge[] = [];
  for (const edge of edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    placedEdges.push({
      from: edge.from,
      to: edge.to,
      x1: from.x + MINIMAP_NODE_WIDTH,
      y1: from.y + MINIMAP_NODE_HEIGHT / 2,
      x2: to.x,
      y2: to.y + MINIMAP_NODE_HEIGHT / 2,
    });
  }

  return { width, height, nodes: [...placed.values()], edges: placedEdges };
}

/** Fit a label into the mini pill; SVG text has no CSS ellipsis. */
export function truncateMiniMapLabel(label: string, max = 15): string {
  const clean = label.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`;
}
