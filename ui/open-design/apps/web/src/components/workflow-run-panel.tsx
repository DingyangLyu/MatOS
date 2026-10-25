// Live run panel docked under the workflow canvas. Renders the node timeline
// (status, duration, attempts, errors), the run event feed, run outputs, and
// the lifecycle controls (pause/resume/cancel, per-node retry/skip,
// approve/deny). Pure presentation over the daemon poll data — all state
// transitions go back through the parent's control callback, which maps 1:1
// onto `matos workflow ...` CLI verbs.

import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';
import {
  formatWorkflowDuration,
  isTerminalWorkflowStatus,
  type WorkflowControlAction,
  type WorkflowRunEventSummary,
  type WorkflowRunSummary,
} from './matos-workflow-client';

/** Canvas + panel share one icon per node/run status. */
export function workflowStatusIcon(status: string): IconName {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return 'check';
    case 'failed':
    case 'error':
      return 'alert-triangle';
    case 'running':
      return 'spinner';
    case 'waiting':
    case 'waiting_input':
    case 'waiting_approval':
      return 'clock';
    case 'paused':
      return 'stop';
    case 'cancelled':
    case 'canceled':
      return 'close';
    case 'skipped':
      return 'chevron-right';
    default:
      return 'clock';
  }
}

/** i18n key for a runtime status word (falls back to the raw status). */
export function workflowStatusLabelKey(status: string): string {
  const normalized = status.toLowerCase();
  const known = new Set([
    'pending',
    'created',
    'running',
    'completed',
    'failed',
    'skipped',
    'waiting',
    'waiting_input',
    'waiting_approval',
    'cancelled',
    'paused',
  ]);
  return known.has(normalized) ? `workflow.status.${normalized}` : status;
}

/**
 * Inline reply form for a `human`/`dynamic` node parked in `waiting_input`.
 * The native run cannot advance until `matos workflow respond` delivers a
 * message, so the panel must offer the input (approve/deny only covers
 * `waiting_approval`). Free text is passed through as the response message.
 */
function WorkflowRespondForm({
  nodeId,
  busy,
  onControl,
}: {
  nodeId: string;
  busy: boolean;
  onControl: Props['onControl'];
}) {
  const t = useT();
  const [message, setMessage] = useState('');
  return (
    <form
      className="wf-run-respond"
      data-testid={`workflow-respond-${nodeId}`}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = message.trim();
        if (!trimmed) return;
        onControl('respond', { nodeId, message: trimmed });
      }}
    >
      <input
        value={message}
        placeholder={t('workflow.runPanel.respondPlaceholder')}
        aria-label={t('workflow.runPanel.respondPlaceholder')}
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
      />
      <button type="submit" className="wf-btn wf-btn-sm" disabled={busy || !message.trim()}>
        <Icon name="send" size={11} /> {t('workflow.runPanel.respond')}
      </button>
    </form>
  );
}

function eventTime(timestamp: string | null): string {
  if (!timestamp) return '';
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** `workflow.node.started` -> `node.started` (drop the shared prefix). */
function eventTypeLabel(type: string): string {
  return type.replace(/^workflow\./, '');
}

interface Props {
  run: WorkflowRunSummary;
  events: WorkflowRunEventSummary[];
  /** Control action currently in flight (disables the buttons). */
  busyAction: string | null;
  onControl: (
    action: WorkflowControlAction,
    options?: { nodeId?: string; message?: string; reason?: string; fingerprint?: string },
  ) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

export function WorkflowRunPanel({ run, events, busyAction, onControl, onSelectNode, onClose }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [section, setSection] = useState<'events' | 'outputs'>('events');

  const status = (run.status ?? 'pending').toLowerCase();
  const terminal = isTerminalWorkflowStatus(status);
  const running = status === 'running' || status === 'created' || status === 'pending';
  const paused = status === 'paused';
  const approvalByNode = useMemo(() => {
    const map = new Map<string, { fingerprint: string | null }>();
    for (const approval of run.pendingApprovals) {
      map.set(approval.nodeId, { fingerprint: approval.fingerprint });
    }
    return map;
  }, [run.pendingApprovals]);

  const completedCount = run.nodes.filter((node) =>
    ['completed', 'succeeded', 'skipped'].includes(node.status.toLowerCase()),
  ).length;

  const reversedEvents = useMemo(() => [...events].reverse(), [events]);
  const hasOutputs = run.outputs && Object.keys(run.outputs).length > 0;

  return (
    <div className={`wf-run-panel${collapsed ? ' is-collapsed' : ''}`} data-testid="workflow-run-panel">
      <div className="wf-run-panel-head">
        <button
          type="button"
          className="wf-run-panel-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <span className={`wf-run-badge is-${status}`}>
          <Icon name={workflowStatusIcon(status)} size={11} />
          {t(workflowStatusLabelKey(status) as never)}
        </span>
        {run.runId ? <code className="wf-run-panel-id">{run.runId}</code> : null}
        <span className="wf-run-panel-progress">
          {completedCount}/{run.nodes.length || '?'}
        </span>
        {run.budget?.totalTokens ? (
          <span className="wf-run-meta" title="tokens">
            <Icon name="gauge" size={11} /> {run.budget.totalTokens.toLocaleString()} tok
          </span>
        ) : null}
        {run.budget?.totalCostUsd ? (
          <span className="wf-run-meta">${run.budget.totalCostUsd.toFixed(4)}</span>
        ) : null}
        {run.budget?.elapsedWallTimeMs ? (
          <span className="wf-run-meta">
            <Icon name="clock" size={11} /> {formatWorkflowDuration(run.budget.elapsedWallTimeMs)}
          </span>
        ) : null}
        <span className="wf-run-panel-spacer" />
        {running ? (
          <button
            type="button"
            className="wf-btn wf-btn-sm"
            disabled={busyAction !== null}
            onClick={() => onControl('pause')}
          >
            <Icon name="stop" size={11} /> {t('workflow.runPanel.pause')}
          </button>
        ) : null}
        {paused ? (
          <button
            type="button"
            className="wf-btn wf-btn-sm"
            disabled={busyAction !== null}
            onClick={() => onControl('resume')}
          >
            <Icon name="play" size={11} /> {t('workflow.runPanel.resume')}
          </button>
        ) : null}
        {!terminal ? (
          <button
            type="button"
            className="wf-btn wf-btn-sm wf-btn-danger"
            disabled={busyAction !== null}
            onClick={() => onControl('cancel')}
          >
            <Icon name="close" size={11} /> {t('workflow.runPanel.cancel')}
          </button>
        ) : null}
        <button
          type="button"
          className="wf-btn wf-btn-icon wf-btn-sm"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {!collapsed ? (
        <div className="wf-run-panel-body">
          <div className="wf-run-panel-nodes">
            {run.nodes.length === 0 ? (
              <div className="wf-run-panel-empty">{t('workflow.runPanel.empty')}</div>
            ) : (
              run.nodes.map((node) => {
                const nodeStatus = node.status.toLowerCase();
                const approval = approvalByNode.get(node.nodeId);
                const waitingInput =
                  nodeStatus === 'waiting_input' ||
                  (run.waitingNodeId === node.nodeId && status === 'waiting_input');
                const waitingHuman =
                  run.waitingNodeId === node.nodeId ||
                  nodeStatus === 'waiting' ||
                  nodeStatus === 'waiting_approval';
                return (
                  <div key={node.nodeId} className="wf-run-panel-node-group">
                  <div
                    className={`wf-run-panel-node is-${nodeStatus}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectNode(node.nodeId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelectNode(node.nodeId);
                    }}
                  >
                    <span className={`wf-run-node-icon is-${nodeStatus}`}>
                      <Icon name={workflowStatusIcon(nodeStatus)} size={11} />
                    </span>
                    <code className="wf-run-node-id">{node.nodeId}</code>
                    <span className="wf-run-node-status">
                      {t(workflowStatusLabelKey(nodeStatus) as never)}
                    </span>
                    {node.durationMs != null ? (
                      <span className="wf-run-node-duration">
                        {formatWorkflowDuration(node.durationMs)}
                      </span>
                    ) : null}
                    {node.attempts != null && node.attempts > 1 ? (
                      <span className="wf-run-node-attempts">×{node.attempts}</span>
                    ) : null}
                    {node.error ? (
                      <span className="wf-run-node-error" title={node.error}>
                        {node.error}
                      </span>
                    ) : null}
                    <span className="wf-run-panel-spacer" />
                    {approval ? (
                      <>
                        <button
                          type="button"
                          className="wf-btn wf-btn-sm"
                          disabled={busyAction !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            onControl('approve', {
                              nodeId: node.nodeId,
                              ...(approval.fingerprint ? { fingerprint: approval.fingerprint } : {}),
                            });
                          }}
                        >
                          <Icon name="thumbs-up" size={11} /> {t('workflow.runPanel.approve')}
                        </button>
                        <button
                          type="button"
                          className="wf-btn wf-btn-sm wf-btn-danger"
                          disabled={busyAction !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            onControl('deny', { nodeId: node.nodeId });
                          }}
                        >
                          <Icon name="thumbs-down" size={11} /> {t('workflow.runPanel.deny')}
                        </button>
                      </>
                    ) : waitingHuman && !waitingInput && nodeStatus !== 'waiting_approval' ? (
                      <span className="wf-run-node-waiting">
                        {t('workflow.runPanel.waitingApproval')}
                      </span>
                    ) : null}
                    {nodeStatus === 'failed' ? (
                      <>
                        <button
                          type="button"
                          className="wf-btn wf-btn-sm"
                          disabled={busyAction !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            onControl('retry-node', { nodeId: node.nodeId });
                          }}
                        >
                          <Icon name="refresh" size={11} /> {t('workflow.runPanel.retryNode')}
                        </button>
                        <button
                          type="button"
                          className="wf-btn wf-btn-sm"
                          disabled={busyAction !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            onControl('skip-node', { nodeId: node.nodeId });
                          }}
                        >
                          <Icon name="chevron-right" size={11} /> {t('workflow.runPanel.skipNode')}
                        </button>
                      </>
                    ) : null}
                  </div>
                  {waitingInput ? (
                    <WorkflowRespondForm
                      nodeId={node.nodeId}
                      busy={busyAction !== null}
                      onControl={onControl}
                    />
                  ) : null}
                  </div>
                );
              })
            )}
          </div>
          <div className="wf-run-panel-side">
            <div className="wf-run-panel-side-tabs">
              <button
                type="button"
                className={`wf-run-panel-side-tab${section === 'events' ? ' is-active' : ''}`}
                onClick={() => setSection('events')}
              >
                {t('workflow.runPanel.events')}
              </button>
              {hasOutputs ? (
                <button
                  type="button"
                  className={`wf-run-panel-side-tab${section === 'outputs' ? ' is-active' : ''}`}
                  onClick={() => setSection('outputs')}
                >
                  {t('workflow.runPanel.outputs')}
                </button>
              ) : null}
            </div>
            {section === 'outputs' && hasOutputs ? (
              <pre className="wf-run-panel-outputs">{JSON.stringify(run.outputs, null, 2)}</pre>
            ) : (
              <div className="wf-run-panel-events">
                {reversedEvents.length === 0 ? (
                  <div className="wf-run-panel-empty">{t('workflow.runPanel.noEvents')}</div>
                ) : (
                  reversedEvents.map((event, index) => (
                    <div key={event.id ?? `${event.type}:${index}`} className="wf-run-panel-event">
                      <span className="wf-run-event-time">{eventTime(event.timestamp)}</span>
                      <span className="wf-run-event-type">{eventTypeLabel(event.type)}</span>
                      {event.nodeId ? (
                        <button
                          type="button"
                          className="wf-run-event-node"
                          onClick={() => onSelectNode(event.nodeId as string)}
                        >
                          {event.nodeId}
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
