import { useState } from 'react';
import {
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useT } from '../i18n';
import { Icon } from './Icon';
import {
  formatWorkflowDuration,
  type WorkflowRunNodeSummary,
} from './matos-workflow-client';
import type { CanvasEdge, WorkflowNodeRecord } from './workflow-model';
import { workflowNodeTypeMeta } from './workflow-node-meta';
import {
  workflowStatusIcon,
  workflowStatusLabelKey,
} from './workflow-run-panel';

export interface WorkflowCanvasNodeData extends Record<string, unknown> {
  record: WorkflowNodeRecord;
  accent: string;
  runNode?: WorkflowRunNodeSummary;
  editable?: boolean;
  showStatusLabel?: boolean;
  approvalLabel?: string | null;
  onCommitLabel?: (nodeId: string, label: string) => void;
}

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, 'matosNode'>;

function nodeSubtitle(record: WorkflowNodeRecord): string {
  if (typeof record.role === 'string' && record.role) return record.role;
  if (typeof record.workflow === 'string' && record.workflow) return record.workflow;
  if (typeof record.operation === 'string' && record.operation) return record.operation;
  if (typeof record.command === 'string' && record.command) {
    return record.command.split('\n')[0]?.slice(0, 60) ?? '';
  }
  if (typeof record.description === 'string') return record.description.slice(0, 60);
  return '';
}

export function MatosWorkflowNode({ id, data, selected }: NodeProps<WorkflowCanvasNode>) {
  const t = useT();
  const record = data.record;
  const meta = workflowNodeTypeMeta(record.type);
  const subtitle = nodeSubtitle(record);
  const title = typeof record.label === 'string' && record.label.trim() ? record.label : record.id;
  const [editing, setEditing] = useState(false);
  const runNode = data.runNode;
  const runStatus = runNode?.status?.toLowerCase();
  const runLabel = runStatus ? t(workflowStatusLabelKey(runStatus) as never) : null;
  const canEdit = data.editable !== false && typeof data.onCommitLabel === 'function';

  return (
    <div
      className={`wf-node${selected ? ' is-selected' : ''}${runStatus ? ` run-${runStatus}` : ''}`}
      style={{ ['--wf-node-accent' as string]: data.accent }}
      data-node-type={record.type}
    >
      <Handle type="target" position={Position.Left} className="wf-node-handle" />
      <div className="wf-node-head">
        <span className="wf-node-icon" aria-hidden>
          <Icon name={meta.icon} size={11} />
        </span>
        <span className="wf-node-type">{record.type}</span>
        {runStatus && runLabel ? (
          <span className={`wf-node-run-chip is-${runStatus}`} title={runLabel}>
            <Icon name={workflowStatusIcon(runStatus)} size={10} />
            {data.showStatusLabel ? <span>{runLabel}</span> : null}
            {runNode?.durationMs != null && runStatus !== 'pending' ? (
              <span className="wf-node-run-duration">
                {formatWorkflowDuration(runNode.durationMs)}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {editing && canEdit ? (
        <input
          className="wf-node-title-input nodrag"
          defaultValue={typeof record.label === 'string' ? record.label : record.id}
          autoFocus
          onFocus={(event) => event.target.select()}
          onBlur={(event) => {
            setEditing(false);
            data.onCommitLabel?.(id, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') {
              (event.target as HTMLInputElement).value = title;
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      ) : (
        <div
          className={`wf-node-id${canEdit ? '' : ' is-readonly'}`}
          onDoubleClick={canEdit ? () => setEditing(true) : undefined}
          title={record.id}
        >
          {title}
        </div>
      )}
      {subtitle ? <div className="wf-node-subtitle">{subtitle}</div> : null}
      {data.approvalLabel ? (
        <div className="wf-node-approval">
          <Icon name="shield" size={10} />
          {data.approvalLabel}
        </div>
      ) : null}
      {runStatus === 'failed' && runNode?.error ? (
        <div className="wf-node-run-error" title={runNode.error}>
          {runNode.error}
        </div>
      ) : null}
      {runStatus === 'running' ? <div className="wf-node-run-progress" aria-hidden /> : null}
      <Handle type="source" position={Position.Right} className="wf-node-handle" />
    </div>
  );
}

export const WORKFLOW_CANVAS_NODE_TYPES = { matosNode: MatosWorkflowNode };

export function workflowCanvasEdgeKey(edge: Pick<CanvasEdge, 'from' | 'to'>): string {
  return `${edge.from}\u0000${edge.to}`;
}

export function decorateWorkflowCanvasEdges(
  edges: CanvasEdge[],
  runNodeMap: ReadonlyMap<string, WorkflowRunNodeSummary>,
  selectedEdgeId: string | null = null,
): Edge[] {
  const doneStates = new Set(['completed', 'succeeded', 'skipped']);
  const activeStates = new Set(['running', 'waiting', 'waiting_input', 'waiting_approval']);
  const statusOf = (nodeId: string): string =>
    runNodeMap.get(nodeId)?.status.toLowerCase() ?? '';
  const hasRun = runNodeMap.size > 0;

  return edges.map((edge) => {
    const id = workflowCanvasEdgeKey(edge);
    let runClass = '';
    let animated = false;
    if (hasRun) {
      const fromStatus = statusOf(edge.from);
      const toStatus = statusOf(edge.to);
      const fromDone = doneStates.has(fromStatus);
      if (fromDone && activeStates.has(toStatus)) {
        runClass = 'wf-edge-active';
        animated = true;
      } else if (fromDone && doneStates.has(toStatus)) {
        runClass = 'wf-edge-done';
      } else if (fromDone && toStatus === 'failed') {
        runClass = 'wf-edge-to-failed';
      }
    }
    const classNames = [
      edge.record?.route === 'failure' ? 'wf-edge-failure' : '',
      id === selectedEdgeId ? 'wf-edge-selected' : '',
      runClass,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      id,
      source: edge.from,
      target: edge.to,
      animated,
      label: edge.record?.condition ? String(edge.record.condition) : undefined,
      className: classNames || undefined,
    };
  });
}
