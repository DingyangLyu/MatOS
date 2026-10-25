// Inspector "Run" tab: one node's latest run record — status, attempts,
// timing, error, stdout/stderr, and the structured output payload. Fetched
// on demand from the daemon's per-node detail route so the poll loop stays
// light; refetches when the node's live status/attempt count changes.

import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import {
  fetchWorkflowRunNodeDetail,
  formatWorkflowDuration,
  type WorkflowRunNodeDetail,
  type WorkflowRunNodeSummary,
} from './matos-workflow-client';
import { workflowStatusIcon, workflowStatusLabelKey } from './workflow-run-panel';

interface Props {
  projectId?: string;
  runId: string | null;
  nodeId: string;
  /** Live poll snapshot for this node (drives refetch + quick summary). */
  liveNode: WorkflowRunNodeSummary | null;
}

/** Split `{ stdout, stderr, ...rest }` so logs render as text, rest as JSON. */
function splitOutput(output: unknown): {
  stdout: string | null;
  stderr: string | null;
  rest: unknown;
} {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    const stdout = typeof record.stdout === 'string' && record.stdout.trim() ? record.stdout : null;
    const stderr = typeof record.stderr === 'string' && record.stderr.trim() ? record.stderr : null;
    if (stdout !== null || stderr !== null) {
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === 'stdout' || key === 'stderr') continue;
        rest[key] = value;
      }
      return { stdout, stderr, rest: Object.keys(rest).length > 0 ? rest : null };
    }
  }
  return { stdout: null, stderr: null, rest: output ?? null };
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function WorkflowNodeRunTab({ runId, nodeId, liveNode, projectId }: Props) {
  const t = useT();
  const [detail, setDetail] = useState<WorkflowRunNodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Refetch when the node advances (status flip or another attempt) or on
  // manual refresh.
  const liveKey = liveNode ? `${liveNode.status}:${liveNode.attempts ?? 0}` : 'none';
  const unstarted = liveNode?.status === 'pending' && !liveNode.startedAt && !liveNode.attempts;
  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!runId || liveKey === 'none' || unstarted) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const poll = async () => {
      let retry = liveKey.startsWith('running:');
      try {
        const next = await (projectId ? fetchWorkflowRunNodeDetail(runId, nodeId, { projectId }) : fetchWorkflowRunNodeDetail(runId, nodeId));
        if (!cancelled) {
          setDetail(next);
          setError(null);
        }
      } catch (err) {
        retry = true;
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled && retry) timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, nodeId, liveKey, refreshTick, unstarted, projectId]);

  const output = useMemo(() => splitOutput(detail?.output), [detail]);

  if (!runId || !liveNode) {
    return <p className="wf-inspector-hint">{t('workflow.runTab.empty')}</p>;
  }

  const status = liveNode.status.toLowerCase();
  const attempts = liveNode.attempts;
  const durationMs = liveNode.durationMs;

  return (
    <div className="wf-node-run-tab">
      <div className="wf-node-run-facts">
        <span className={`wf-run-badge is-${status}`}>
          <Icon name={workflowStatusIcon(status)} size={11} />
          {t(workflowStatusLabelKey(status) as never)}
        </span>
        {durationMs != null ? (
          <span className="wf-run-meta">
            <Icon name="clock" size={11} /> {formatWorkflowDuration(durationMs)}
          </span>
        ) : null}
        {attempts != null && attempts > 0 ? (
          <span className="wf-run-meta">
            {t('workflow.runTab.attempts')}: {attempts}
          </span>
        ) : null}
        <span className="wf-run-panel-spacer" />
        <button
          type="button"
          className="wf-btn wf-btn-icon wf-btn-sm"
          title={t('workflow.runTab.refresh')}
          aria-label={t('workflow.runTab.refresh')}
          onClick={() => setRefreshTick((tick) => tick + 1)}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {loading && !detail ? (
        <p className="wf-inspector-hint">{t('workflow.runTab.loading')}</p>
      ) : null}
      {unstarted ? <p className="wf-inspector-hint">{t('workflow.nodeNotStarted')}</p> : null}
      {error ? <p className="wf-node-run-error-text">{error}</p> : null}
      {detail?.error != null ? (
        <div className="wf-node-run-section">
          <span className="wf-node-run-section-label is-error">
            <Icon name="alert-triangle" size={11} /> {t('workflow.runTab.error')}
          </span>
          <pre className="wf-node-run-pre is-error">
            {typeof detail.error === 'string' ? detail.error : prettyJson(detail.error)}
          </pre>
        </div>
      ) : null}
      {output.stdout ? (
        <div className="wf-node-run-section">
          <span className="wf-node-run-section-label">
            <Icon name="terminal" size={11} /> stdout
          </span>
          <pre className="wf-node-run-pre">{output.stdout}</pre>
        </div>
      ) : null}
      {output.stderr ? (
        <div className="wf-node-run-section">
          <span className="wf-node-run-section-label">
            <Icon name="terminal" size={11} /> stderr
          </span>
          <pre className="wf-node-run-pre is-error">{output.stderr}</pre>
        </div>
      ) : null}
      {output.rest != null ? (
        <div className="wf-node-run-section">
          <span className="wf-node-run-section-label">
            <Icon name="braces" size={11} /> {t('workflow.runTab.output')}
          </span>
          <pre className="wf-node-run-pre">{prettyJson(output.rest)}</pre>
        </div>
      ) : null}
    </div>
  );
}
