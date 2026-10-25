// Asset relationship map — SVG renderer over the pure cluster-graph model.
//
// Replaces the old deep-space canvas galaxy with a light, product-styled
// relationship graph that lives on the same workbench surface as the rest of
// the app: every asset type is a soft pastel cluster bubble, assets are
// cartoon nodes (colored disc + shine + sticker label), and dependencies are
// rounded filaments between the actual nodes. Hovering highlights a node's
// direct neighborhood; clicking focuses its full lineage (upstream deps warm,
// downstream dependents cool, everything else fades behind a scrim) with a
// side panel that lists the lineage by hop and jumps into the detail editor.
// Lab / physical-world assets (instrument drivers, measurement SOPs) carry a
// dashed accent ring so laboratory assets stay visible across type clusters.
//
// All geometry lives in `asset-graph-model.ts` (tested, deterministic); this
// file owns only SVG composition and interaction state. The heavy layers
// (halos/edges/nodes) are memoized on the layout, so pan/zoom only updates a
// transform and hover/focus only re-renders the small highlight overlay.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import {
  assetTypeHue,
  buildAssetGraph,
  isLabAsset,
  lineageSubgraph,
  nodeRadius,
  pickGraphNode,
  runClusterLayout,
  type AssetGraph,
  type AssetGraphInput,
  type AssetGraphNode,
  type AssetGraphLayout,
  type AssetLineage,
} from './asset-graph-model';

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
/** Hubs with at least this many links get an always-on sticker label. */
const HUB_LABEL_DEGREE = 12;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface HoverState {
  ref: string;
  clientX: number;
  clientY: number;
}

function nodeFill(type: string): string {
  return `hsl(${assetTypeHue(type)}, 70%, 64%)`;
}

function nodeStroke(type: string): string {
  return `hsl(${assetTypeHue(type)}, 52%, 42%)`;
}

function haloFill(type: string): string {
  return `hsla(${assetTypeHue(type)}, 68%, 55%, 0.08)`;
}

function haloStroke(type: string): string {
  return `hsla(${assetTypeHue(type)}, 55%, 48%, 0.30)`;
}

function edgeStroke(type: string, alpha: number): string {
  return `hsla(${assetTypeHue(type)}, 45%, 48%, ${alpha})`;
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  // Gentle quadratic bow: parallel dependencies fan out instead of stacking
  // into one straight busy line.
  const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.1;
  const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.1;
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

function CartoonNode({
  node,
  x,
  y,
  ringColor,
  ringWidth,
  labeled,
}: {
  node: AssetGraphNode;
  x: number;
  y: number;
  ringColor?: string;
  ringWidth?: number;
  labeled?: boolean;
}) {
  const r = nodeRadius(node);
  return (
    <g>
      {ringColor ? (
        <circle
          cx={x}
          cy={y}
          r={r + 3.5}
          fill="none"
          stroke={ringColor}
          strokeWidth={ringWidth ?? 2}
        />
      ) : null}
      {isLabAsset(node) ? (
        <circle
          className="assets-graph__lab-ring"
          cx={x}
          cy={y}
          r={r + 6.5}
          fill="none"
          strokeWidth={1.4}
          strokeDasharray="3 3"
        />
      ) : null}
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={nodeFill(node.type)}
        stroke={nodeStroke(node.type)}
        strokeWidth={1.4}
      />
      <circle
        cx={x - r * 0.3}
        cy={y - r * 0.34}
        r={Math.max(1.1, r * 0.3)}
        fill="rgba(255, 255, 255, 0.55)"
      />
      {labeled ? (
        <text className="assets-graph__node-label" x={x + r + 5} y={y + 3.5}>
          {node.name}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Static map layers (cluster halos + labels, dependency filaments, cartoon
 * nodes). Memoized on the graph/layout identity so pan, zoom, hover, and
 * focus never pay for re-rendering the ~1000-element base scene.
 */
const BaseLayers = memo(function BaseLayers({
  graph,
  layout,
}: {
  graph: AssetGraph;
  layout: AssetGraphLayout;
}) {
  const nodes: ReactElement[] = [];
  for (const node of graph.nodes.values()) {
    const p = layout.points.get(node.ref);
    if (!p) continue;
    nodes.push(
      <CartoonNode
        key={node.ref}
        node={node}
        x={p.x}
        y={p.y}
        labeled={node.degree >= HUB_LABEL_DEGREE}
      />,
    );
  }
  return (
    <>
      <g>
        {layout.clusters.map((cluster) => (
          <g key={cluster.type}>
            <circle
              cx={cluster.cx}
              cy={cluster.cy}
              r={cluster.r}
              fill={haloFill(cluster.type)}
              stroke={haloStroke(cluster.type)}
              strokeWidth={1.2}
              strokeDasharray="1 7"
              strokeLinecap="round"
            />
            <g
              className="assets-graph__cluster-label"
              transform={`translate(${cluster.cx}, ${cluster.cy - cluster.r - 12})`}
            >
              <circle cx={0} cy={-4} r={4.5} fill={nodeFill(cluster.type)} stroke={nodeStroke(cluster.type)} strokeWidth={1} />
              <text x={9} y={0}>
                {cluster.type}
                <tspan className="assets-graph__cluster-count"> · {cluster.count}</tspan>
              </text>
            </g>
          </g>
        ))}
      </g>
      <g>
        {graph.edges.map((edge) => {
          const a = layout.points.get(edge.from);
          const b = layout.points.get(edge.to);
          if (!a || !b) return null;
          const fromType = graph.nodes.get(edge.from)!.type;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={edgePath(a, b)}
              fill="none"
              stroke={edgeStroke(fromType, 0.16)}
              strokeWidth={1.1}
              strokeLinecap="round"
            />
          );
        })}
      </g>
      <g>{nodes}</g>
    </>
  );
});

export function AssetGraphView({
  assets,
  onOpenAsset,
}: {
  assets: AssetGraphInput[];
  onOpenAsset: (ref: string) => void;
}) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const graph = useMemo(() => buildAssetGraph(assets), [assets]);
  const layout = useMemo(() => runClusterLayout(graph), [graph]);
  const lineage: AssetLineage | null = useMemo(
    () => (focusRef ? lineageSubgraph(graph, focusRef) : null),
    [graph, focusRef],
  );
  const labCount = useMemo(
    () => [...graph.nodes.values()].filter((node) => isLabAsset(node)).length,
    [graph],
  );

  // Fit the cluster bounds (halos + label chips) into the stage.
  const fitCamera = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const { clientWidth: w, clientHeight: h } = stage;
    if (w === 0 || h === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const cluster of layout.clusters) {
      minX = Math.min(minX, cluster.cx - cluster.r);
      minY = Math.min(minY, cluster.cy - cluster.r - 34);
      maxX = Math.max(maxX, cluster.cx + cluster.r);
      maxY = Math.max(maxY, cluster.cy + cluster.r);
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = layout.size;
      maxY = layout.size;
    }
    const pad = 28;
    const bw = Math.max(1, maxX - minX + pad * 2);
    const bh = Math.max(1, maxY - minY + pad * 2);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(w / bw, h / bh)));
    setCamera({
      scale,
      x: (w - bw * scale) / 2 - (minX - pad) * scale,
      y: (h - bh * scale) / 2 - (minY - pad) * scale,
    });
  }, [layout]);

  useEffect(() => {
    fitCamera();
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(fitCamera);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitCamera]);

  const stagePoint = (event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect
      ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
      : { x: 0, y: 0 };
  };

  const pickAt = useCallback(
    (px: number, py: number): AssetGraphNode | null => {
      const cam = cameraRef.current;
      const wx = (px - cam.x) / cam.scale;
      const wy = (py - cam.y) / cam.scale;
      return pickGraphNode(graph, layout.points, wx, wy, 3 + 5 / cam.scale);
    },
    [graph, layout],
  );

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setCamera((cam) => {
      const stage = stageRef.current;
      const px = cx ?? (stage ? stage.clientWidth / 2 : 0);
      const py = cy ?? (stage ? stage.clientHeight / 2 : 0);
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
      const k = nextScale / cam.scale;
      return {
        scale: nextScale,
        x: px - (px - cam.x) * k,
        y: py - (py - cam.y) * k,
      };
    });
  }, []);

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault();
      const { x, y } = stagePoint(event);
      zoomBy(Math.exp(-event.deltaY * 0.0016), x, y);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        drag.x = event.clientX;
        drag.y = event.clientY;
        setCamera((cam) => ({ ...cam, x: cam.x + dx, y: cam.y + dy }));
        return;
      }
      const { x, y } = stagePoint(event);
      const node = pickAt(x, y);
      setHover((current) => {
        if (!node) return current === null ? current : null;
        if (current?.ref === node.ref
          && Math.abs(current.clientX - event.clientX) < 8
          && Math.abs(current.clientY - event.clientY) < 8) {
          return current;
        }
        return { ref: node.ref, clientX: event.clientX, clientY: event.clientY };
      });
    },
    [pickAt],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.moved) return;
      const { x, y } = stagePoint(event);
      const node = pickAt(x, y);
      setFocusRef((current) => {
        if (!node) return null;
        return current === node.ref ? null : node.ref;
      });
    },
    [pickAt],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusRef(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hoverNode = hover ? graph.nodes.get(hover.ref) ?? null : null;
  const focusNode = focusRef ? graph.nodes.get(focusRef) ?? null : null;

  // Highlight overlay: lineage focus wins; otherwise the hovered node's
  // direct neighborhood. Small element counts, so re-rendering it per
  // hover/focus change stays cheap.
  const highlight = useMemo(() => {
    if (lineage) {
      const edges = graph.edges.filter(
        (edge) => lineage.members.has(edge.from) && lineage.members.has(edge.to),
      );
      return { members: lineage.members, edges, lineage };
    }
    if (hoverNode) {
      const members = new Set([hoverNode.ref, ...hoverNode.dependsOn, ...hoverNode.dependedBy]);
      const edges = graph.edges.filter(
        (edge) =>
          (edge.from === hoverNode.ref || edge.to === hoverNode.ref) &&
          members.has(edge.from) &&
          members.has(edge.to),
      );
      return { members, edges, lineage: null };
    }
    return null;
  }, [graph, lineage, hoverNode]);

  const highlightLayer = useMemo(() => {
    if (!highlight) return null;
    const focus = highlight.lineage?.focus ?? hoverNode?.ref ?? null;
    const upstream = highlight.lineage?.upstream;
    const downstream = highlight.lineage?.downstream;
    const strokeFor = (edge: { from: string; to: string }): string => {
      if (!highlight.lineage) {
        return edgeStroke(graph.nodes.get(edge.from)!.type, 0.55);
      }
      // Warm = the focus's dependency side, cool = its dependents' side
      // (matching the sidebar tier headers). Edges touching the focus take
      // the side of their far endpoint.
      const involvesFocus = edge.from === focus || edge.to === focus;
      const upSide = involvesFocus
        ? upstream?.has(edge.from === focus ? edge.to : edge.from)
        : upstream?.has(edge.from) && upstream?.has(edge.to);
      const downSide = involvesFocus
        ? downstream?.has(edge.from === focus ? edge.to : edge.from)
        : downstream?.has(edge.from) && downstream?.has(edge.to);
      if (upSide) return 'hsla(28, 82%, 50%, 0.6)';
      if (downSide) return 'hsla(200, 82%, 42%, 0.6)';
      return 'hsla(220, 10%, 50%, 0.45)';
    };
    // Sticker labels stay readable: cap them to the focus neighborhood size.
    const labelBudget = 48;
    let labelsUsed = 0;
    const nodes: ReactElement[] = [];
    for (const ref of highlight.members) {
      const node = graph.nodes.get(ref);
      const p = layout.points.get(ref);
      if (!node || !p) continue;
      const isFocus = ref === focus;
      const ring = isFocus
        ? 'var(--accent, #c96442)'
        : upstream?.has(ref)
          ? 'hsla(28, 82%, 50%, 0.85)'
          : downstream?.has(ref)
            ? 'hsla(200, 82%, 42%, 0.85)'
            : nodeStroke(node.type);
      const labeled = isFocus || labelsUsed < labelBudget;
      if (labeled && !isFocus) labelsUsed += 1;
      nodes.push(
        <CartoonNode
          key={ref}
          node={node}
          x={p.x}
          y={p.y}
          ringColor={ring}
          ringWidth={isFocus ? 2.6 : 1.6}
          labeled={labeled}
        />,
      );
    }
    return (
      <g>
        <rect
          className="assets-graph__scrim"
          x={-layout.size}
          y={-layout.size}
          width={layout.size * 3}
          height={layout.size * 3}
        />
        <g>
          {highlight.edges.map((edge) => {
            const a = layout.points.get(edge.from);
            const b = layout.points.get(edge.to);
            if (!a || !b) return null;
            return (
              <path
                key={`hl:${edge.from}->${edge.to}`}
                d={edgePath(a, b)}
                fill="none"
                stroke={strokeFor(edge)}
                strokeWidth={1.6}
                strokeLinecap="round"
              />
            );
          })}
        </g>
        <g>{nodes}</g>
      </g>
    );
  }, [highlight, graph, layout, hoverNode]);

  return (
    <div className="assets-graph" data-testid="assets-graph">
      <div className="assets-graph__stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className={`assets-graph__svg${hoverNode ? ' is-node-hover' : ''}`}
          data-testid="assets-graph-svg"
          role="img"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            dragRef.current = null;
            setHover(null);
          }}
        >
          <defs>
            <pattern
              id="assets-graph-dots"
              width={26}
              height={26}
              patternUnits="userSpaceOnUse"
              patternTransform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}
            >
              <circle className="assets-graph__dot" cx={1.2} cy={1.2} r={1.2} />
            </pattern>
          </defs>
          <rect className="assets-graph__paper" width="100%" height="100%" fill="url(#assets-graph-dots)" />
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
            <BaseLayers graph={graph} layout={layout} />
            {highlightLayer}
          </g>
        </svg>

        <p className="assets-graph__hint">{t('assets.galaxy.hint')}</p>

        <div className="assets-graph__controls">
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.35)}>
            <Icon name="zoom-in" size={14} />
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.35)}>
            <Icon name="zoom-out" size={14} />
          </button>
          <button type="button" aria-label="Fit view" onClick={fitCamera}>
            <Icon name="maximize" size={14} />
          </button>
        </div>

        {labCount > 0 ? (
          <div className="assets-graph__legend" aria-hidden="true">
            <span className="assets-graph__legend-lab">
              <span className="assets-graph__legend-lab-ring" />
              Lab · {labCount}
            </span>
          </div>
        ) : null}

        {hoverNode && !dragRef.current ? (
          <div
            className="assets-graph__tooltip"
            style={{ left: hover!.clientX + 14, top: hover!.clientY + 12 }}
          >
            <strong>{hoverNode.name}</strong>
            <span>
              {hoverNode.type}
              {hoverNode.version ? ` · v${hoverNode.version}` : ''}
              {isLabAsset(hoverNode) ? ' · lab' : ''}
            </span>
            <span>
              ↑ {hoverNode.dependsOn.length} · ↓ {hoverNode.dependedBy.length}
            </span>
          </div>
        ) : null}
      </div>

      {focusNode && lineage ? (
        <aside className="assets-graph__lineage" data-testid="assets-graph-lineage">
          <div className="assets-graph__lineage-head">
            <span
              className="assets-graph__legend-dot"
              style={{ background: nodeFill(focusNode.type) }}
            />
            <div className="assets-graph__lineage-title">
              <strong>{focusNode.name}</strong>
              <span>
                {focusNode.type}
                {focusNode.version ? ` · v${focusNode.version}` : ''}
                {isLabAsset(focusNode) ? ' · lab' : ''}
              </span>
            </div>
            <button
              type="button"
              className="assets-graph__lineage-close"
              onClick={() => setFocusRef(null)}
              title={t('assets.galaxy.clearFocus')}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <button
            type="button"
            className="assets-graph__open-detail"
            onClick={() => onOpenAsset(focusNode.ref)}
          >
            <Icon name="edit" size={13} />
            {t('assets.galaxy.openDetail')}
          </button>
          <LineageTierList
            titleKey="assets.galaxy.upstream"
            tone="upstream"
            tiers={lineage.upstream}
            graph={graph}
            onOpenAsset={onOpenAsset}
            onFocus={setFocusRef}
          />
          <LineageTierList
            titleKey="assets.galaxy.downstream"
            tone="downstream"
            tiers={lineage.downstream}
            graph={graph}
            onOpenAsset={onOpenAsset}
            onFocus={setFocusRef}
          />
        </aside>
      ) : null}
    </div>
  );
}

function LineageTierList({
  titleKey,
  tone,
  tiers,
  graph,
  onOpenAsset,
  onFocus,
}: {
  titleKey: 'assets.galaxy.upstream' | 'assets.galaxy.downstream';
  tone: 'upstream' | 'downstream';
  tiers: Map<string, number>;
  graph: AssetGraph;
  onOpenAsset: (ref: string) => void;
  onFocus: (ref: string) => void;
}) {
  const t = useT();
  const byDepth = useMemo(() => {
    const grouped = new Map<number, AssetGraphNode[]>();
    for (const [ref, depth] of tiers) {
      const node = graph.nodes.get(ref);
      if (!node) continue;
      const list = grouped.get(depth) ?? [];
      list.push(node);
      grouped.set(depth, list);
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [tiers, graph]);

  return (
    <div className={`assets-graph__tier assets-graph__tier--${tone}`}>
      <h4>
        {t(titleKey)}
        <span className="assets-graph__tier-count">{tiers.size}</span>
      </h4>
      {byDepth.length === 0 ? (
        <p className="assets-graph__tier-empty">{t('assets.galaxy.none')}</p>
      ) : (
        byDepth.map(([depth, nodes]) => (
          <div key={depth} className="assets-graph__tier-group">
            <span className="assets-graph__tier-depth">
              {depth === 1 ? t('assets.galaxy.direct') : t('assets.galaxy.hop', { depth })}
            </span>
            <ul>
              {nodes.map((node) => (
                <li key={node.ref}>
                  <button
                    type="button"
                    className="assets-graph__tier-node"
                    onClick={() => onFocus(node.ref)}
                    onDoubleClick={() => onOpenAsset(node.ref)}
                    title={`${node.ref} — ${t('assets.galaxy.openDetailHint')}`}
                  >
                    <span
                      className="assets-graph__legend-dot"
                      style={{ background: nodeFill(node.type) }}
                    />
                    <span className="assets-graph__tier-name">{node.name}</span>
                    <span className="assets-graph__tier-type">{node.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
