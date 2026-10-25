// Read-only SVG mini flowchart for workflow asset cards.
//
// Draws the DAG skeleton served by `/api/matos/workflow-previews` with the
// same per-node-type accents as the Workflow Studio canvas, but as plain
// SVG — no React Flow, so the Home gallery chunk stays light. The graph is
// purely decorative/preview: no pan/zoom, clicks fall through to the card.

import { useMemo } from 'react';
import { workflowNodeTypeMeta } from './workflow-node-meta';
import {
  layoutWorkflowPreview,
  truncateMiniMapLabel,
  MINIMAP_NODE_HEIGHT,
  MINIMAP_NODE_WIDTH,
  type WorkflowPreviewGraph,
} from './workflow-minimap-model';

interface Props {
  preview: WorkflowPreviewGraph;
  compact?: boolean;
}

export function WorkflowMiniMap({ preview, compact = false }: Props) {
  const layout = useMemo(
    () => layoutWorkflowPreview(compact ? preview.nodes.slice(0, 9) : preview.nodes, preview.edges, compact ? 3 : undefined),
    [preview, compact],
  );
  if (layout.nodes.length === 0) return null;
  return (
    <svg
      className="wf-minimap"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-hidden
      data-testid="wf-minimap"
    >
      <g className="wf-minimap__edges">
        {layout.edges.map((edge) => {
          const bend = Math.max(18, (edge.x2 - edge.x1) / 2);
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className="wf-minimap__edge"
              d={compact && edge.x2 < edge.x1 && edge.y2 > edge.y1
                ? `M ${edge.x1} ${edge.y1} H ${edge.x1 + 10} V ${(edge.y1 + edge.y2) / 2} H ${edge.x2 - 10} V ${edge.y2} H ${edge.x2}`
                : `M ${edge.x1} ${edge.y1} C ${edge.x1 + bend} ${edge.y1}, ${edge.x2 - bend} ${edge.y2}, ${edge.x2} ${edge.y2}`}
            />
          );
        })}
      </g>
      <g>
        {layout.nodes.map((node) => {
          const meta = workflowNodeTypeMeta(node.type);
          return (
            <g
              key={node.id}
              className="wf-minimap__node"
              transform={`translate(${node.x}, ${node.y})`}
              style={{ ['--wf-mini-accent' as string]: meta.accent }}
              data-node-type={node.type}
            >
              <rect
                className="wf-minimap__pill"
                width={MINIMAP_NODE_WIDTH}
                height={MINIMAP_NODE_HEIGHT}
                rx={8}
              />
              <circle
                className="wf-minimap__dot"
                cx={11}
                cy={MINIMAP_NODE_HEIGHT / 2}
                r={3.2}
              />
              <text
                className="wf-minimap__label"
                x={20}
                y={MINIMAP_NODE_HEIGHT / 2}
                dominantBaseline="central"
              >
                {truncateMiniMapLabel(node.label)}
              </text>
              <title>{`${node.label} · ${node.type}`}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
