import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useT } from '../../i18n';
import { buildPath, navigate } from '../../router';
import { listProjects } from '../../state/projects';
import { createMatOSAssetProject, createMatOSAssetDraftProject } from '../../matos-asset-projects';
import { writeProjectTextFileDetailed } from '../../providers/registry';
import type { ProjectFile } from '../../types';
import { Icon } from '../Icon';
import {
  autoLayoutPositions,
  emptyWorkflowDefinition,
  isWorkflowDraftFileName,
  workflowReferenceLabel as shortRef,
  type CanvasEdge,
  type WorkflowNodeRecord,
} from '../workflow-model';
import {
  WORKFLOW_CANVAS_NODE_TYPES,
  decorateWorkflowCanvasEdges,
  type WorkflowCanvasNode,
} from '../workflow-canvas-node';
import {
  WorkflowRunPanel,
  workflowStatusIcon,
  workflowStatusLabelKey,
} from '../workflow-run-panel';
import { WorkflowNodeRunTab } from '../workflow-node-run-tab';
import { workflowNodeTypeMeta } from '../workflow-node-meta';
import {
  controlWorkflowRun,
  fetchWorkflowRunEvents,
  fetchWorkflowRuns,
  fetchWorkflowRunStatus,
  forkWorkflowRun,
  isTerminalWorkflowStatus,
  type WorkflowControlAction,
  type WorkflowRunListRow,
} from '../matos-workflow-client';
import { useWorkflowPoll } from './use-workflow-poll';
import styles from './WorkflowStudio.module.css';

const attention = (status: string) =>
  ['failed', 'error', 'waiting', 'waiting_input', 'waiting_approval', 'paused'].includes(status);
const category = (status: string) =>
  attention(status.toLowerCase()) ? 'attention' : isTerminalWorkflowStatus(status) ? 'finished' : 'active';

function Status({ status }: { status: string }) {
  const t = useT();
  const key = workflowStatusLabelKey(status);
  return (
    <span className={`wf-run-badge is-${status}`}>
      <Icon name={workflowStatusIcon(status)} size={12} />
      {key.startsWith('workflow.') ? t(key as never) : status}
    </span>
  );
}

export function WorkflowsView({ runId, projectId }: { runId?: string; projectId?: string }) {
  const t = useT();
  return (
    <section className={styles.studio} data-testid="entry-view-workflows">
      <header className={`entry-section__head ${styles.header}`}>
        {runId ? (
          <button
            className="wf-btn wf-btn-icon"
            title={t('workflow.board')}
            aria-label={t('workflow.board')}
            onClick={() => navigate({ kind: 'home', view: 'workflows', ...(projectId ? { workflowProjectId: projectId } : {}) })}
          >
            <Icon name="arrow-left" size={18} />
          </button>
        ) : null}
        <h1 className="entry-section__title">{t('workflow.studio')}</h1>
        <a
          className="wf-btn"
          href={buildPath({ kind: 'home', view: 'assets', assetRef: 'workflow' })}
          onClick={(event) => {
            event.preventDefault();
            navigate({ kind: 'home', view: 'assets', assetRef: 'workflow' });
          }}
        >
          <Icon name="blocks" size={14} />
          {t('workflow.library')}
        </a>
      </header>
      {runId ? (
        <RunMonitor key={`${projectId ?? ''}:${runId}`} runId={runId} projectId={projectId} />
      ) : (
        <Dashboard key={projectId ?? ''} projectId={projectId} />
      )}
    </section>
  );
}

async function projectFiles(projectId: string, signal: AbortSignal): Promise<ProjectFile[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`Project files (${response.status})`);
  return ((await response.json()) as { files: ProjectFile[] }).files;
}

function Dashboard({ projectId }: { projectId?: string }) {
  const t = useT();
  const loadRuns = useCallback((signal: AbortSignal) => fetchWorkflowRuns(undefined, { projectId, signal }), [projectId]);
  const runs = useWorkflowPoll(loadRuns, 3_000);
  const loadProjects = useCallback(() => listProjects({ throwOnError: true }), []);
  const projects = useWorkflowPoll(loadProjects, 30_000);
  const loadFiles = useCallback(
    (signal: AbortSignal) => (projectId ? projectFiles(projectId, signal) : Promise.resolve([])),
    [projectId],
  );
  const files = useWorkflowPoll(loadFiles, 30_000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitRef = useRef(false);
  const visible = (runs.data ?? []).filter(
    (run) =>
      `${run.workflowRef ?? ''} ${run.runId}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || category(run.status) === filter),
  ).sort((a, b) => (Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0));
  const columns = [
    ['active', 'workflow.activeRuns'],
    ['attention', 'workflow.needsAttention'],
    ['finished', 'workflow.finishedRuns'],
  ] as const;
  const workflows = (files.data ?? []).filter((file) => isWorkflowDraftFileName(file.name));
  const create = async () => {
    if (!projectId || !newName.trim() || submitRef.current) return;
    submitRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const name = `workflow-${Date.now().toString(36)}.workflow.json`;
      const definition = emptyWorkflowDefinition(newName.trim());
      const result = await writeProjectTextFileDetailed(
        projectId,
        name,
        JSON.stringify(definition, null, 2),
        { expectedEtag: null },
      );
      if (!result.ok) throw new Error(result.message);
      navigate({ kind: 'project', projectId, fileName: name });
    } catch (failure) {
      setError(String(failure));
    } finally {
      submitRef.current = false;
      setBusy(false);
    }
  };
  const createProject = async () => {
    if (submitRef.current) return;
    submitRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await createMatOSAssetProject('workflow', t);
    } catch (failure) {
      setError(String(failure));
    } finally {
      submitRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.dashboard}>
      <section className={styles.documents}>
        <div className={styles.sectionHead}>
          <Icon name="folder" size={16} />
          <h2>{t('workflow.draft')}</h2>
          <select
            aria-label={t('workflow.project')}
            value={projectId ?? ''}
            onChange={(event) =>
              navigate({
                kind: 'home',
                view: 'workflows',
                ...(event.target.value ? { workflowProjectId: event.target.value } : {}),
              })
            }
          >
            <option value="">{t('workflow.workspaceRuns')}</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="wf-btn"
            disabled={busy}
            onClick={() => (projectId ? setCreating(!creating) : void createProject())}
          >
            <Icon name="plus" size={14} />
            {t('workflow.new')}
          </button>
        </div>
        {projectId && !files.error && workflows.length === 0 ? <p className={styles.draftEmpty}>
          {t(files.data === null ? 'workflow.loading' : 'workflow.noDrafts')}
        </p> : null}
        {creating ? (
          <form
            className={styles.create}
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <input
              autoFocus
              required
              value={newName}
              aria-label={t('workflow.label')}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button className="wf-btn wf-btn-primary" disabled={busy || !newName.trim()}>
              <Icon name="plus" size={14} />
              {t('workflow.new')}
            </button>
            <button className="wf-btn" type="button" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </form>
        ) : null}
        <div className={styles.fileList}>
          {projectId
            ? workflows.map((file) => (
                <a
                  key={file.name}
                  href={buildPath({ kind: 'project', projectId, fileName: file.name })}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate({ kind: 'project', projectId, fileName: file.name });
                  }}
                >
                  <Icon name="workflow" size={16} />
                  <span>{file.name}</span>
                  <Icon name="chevron-right" size={14} />
                </a>
              ))
            : null}
        </div>
        {error || projects.error || files.error ? (
          <p className={styles.error}>{error || projects.error || files.error}</p>
        ) : null}
      </section>
      <section className={styles.board}>
        <div className={styles.sectionHead}>
          <Icon name="gauge" size={16} />
          <h2>{t('workflow.board')}</h2>
          <span className={runs.error ? styles.offline : styles.live}>
            <i />
            {t(runs.error ? 'workflow.reconnecting' : runs.updatedAt ? 'workflow.live' : 'workflow.loading')}
          </span>
          <button
            className="wf-btn wf-btn-icon"
            title={t('workflow.refresh')}
            aria-label={t('workflow.refresh')}
            onClick={runs.refresh}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <div className={styles.filters}>
          <div role="tablist">
            {[['all', 'workflow.allRuns'], ...columns].map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(label as never)}{' '}
                <span>
                  {
                    (runs.data ?? []).filter(
                      (run) => value === 'all' || category(run.status) === value,
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workflow.searchRuns')}
              aria-label={t('workflow.searchRuns')}
            />
          </label>
        </div>
        {runs.error ? (
          <div className={styles.error} role="alert">
            {runs.error}
          </div>
        ) : null}
        <div className={styles.runList} data-stale={!!runs.error}>
          <div className={styles.listHead} aria-hidden>
            <span>{t('workflow.label')}</span><span>{t('workflow.runState')}</span>
            <span>{t('workflow.waitingStep')}</span><span>{t('workflow.updatedColumn')}</span><span />
          </div>
          {visible.map(run => <RunRow key={run.runId} run={run} projectId={projectId} />)}
          {!visible.length ? <p className={styles.empty}>
            {t(runs.data === null && !runs.error ? 'workflow.loading' : 'workflow.noRuns')}
          </p> : null}
        </div>
        {runs.updatedAt ? (
          <footer className={styles.updated}>
            {t('workflow.lastUpdated', { time: new Date(runs.updatedAt).toLocaleTimeString() })}
          </footer>
        ) : null}
      </section>
    </div>
  );
}

function RunRow({ run, projectId }: { run: WorkflowRunListRow; projectId?: string }) {
  const t = useT();
  const route = { kind: 'home', view: 'workflows', workflowRunId: run.runId, ...(projectId ? { workflowProjectId: projectId } : {}) } as const;
  return (
    <a
      className={styles.runRow}
      data-testid="workflow-run-row"
      href={buildPath(route)}
      onClick={(event) => {
        event.preventDefault();
        navigate(route);
      }}
    >
      <div className={styles.runName}>
        <Icon name="workflow" size={16} />
        <div><strong title={run.workflowRef ?? run.runId}>{shortRef(run.workflowRef)}</strong>
          <code title={run.runId}>{run.runId}</code></div>
      </div>
      <Status status={run.status} />
      <span className={styles.waitingStep} title={run.waitingNodeId ?? ''}>{run.waitingNodeId || '-'}</span>
      <time>{run.updatedAt ? new Date(run.updatedAt).toLocaleString() : '-'}</time>
      <span className={styles.openRun} title={t('workflow.viewRun')}><Icon name="chevron-right" size={16} /></span>
    </a>
  );
}

function RunMonitor({ runId, projectId }: { runId: string; projectId?: string }) {
  const t = useT();
  const [selection, setSelected] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<'graph' | 'steps'>('graph');
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 520px)').matches) {
      setView('steps');
      setSelected(null);
    }
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const controlEpoch = useRef(0);
  const load = useCallback(async (signal: AbortSignal) => {
    const epoch = controlEpoch.current;
    const run = await fetchWorkflowRunStatus(runId, { projectId, signal });
    if (epoch !== controlEpoch.current) throw new Error('Refreshing workflow state');
    return run;
  }, [runId, projectId]);
  const { data, error, refresh, updatedAt } = useWorkflowPoll(load);
  const loadEvents = useCallback((signal: AbortSignal) => fetchWorkflowRunEvents(runId, 200, { projectId, signal }), [runId, projectId]);
  const events = useWorkflowPoll(loadEvents, 3_000);
  const run = data;
  const selected = selection === undefined ? run?.activeNodeIds[0] ?? run?.waitingNodeId ?? run?.nodes.find(node => ['failed', 'error'].includes(node.status))?.nodeId ?? run?.nodes[0]?.nodeId ?? null : selection;
  const openDraft = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('fork'); setControlError(null);
    try {
      const { definition } = await forkWorkflowRun(runId, { projectId });
      if (projectId) {
        const fileName = `copy-${crypto.randomUUID().slice(0, 8)}.workflow.json`;
        const result = await writeProjectTextFileDetailed(projectId, fileName, JSON.stringify(definition, null, 2), { expectedEtag: null });
        if (!result.ok) throw new Error(result.message);
        navigate({ kind: 'project', projectId, fileName });
      } else {
        const draft = await createMatOSAssetDraftProject('workflow', t, { pendingPrompt: null, workflowDefinition: definition });
        navigate({ kind: 'project', projectId: draft.projectId, conversationId: draft.conversationId, fileName: draft.seedName });
      }
    } catch (failure) { setControlError(String(failure)); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || isTerminalWorkflowStatus(run.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);
  const model = useMemo(() => {
    const records: WorkflowNodeRecord[] =
      run?.graph?.nodes ??
      (run?.nodes ?? []).map((node) => ({ id: node.nodeId, type: 'unknown', dependsOn: [] }));
    const edges: CanvasEdge[] = (run?.graph?.edges ?? []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      explicit: true,
      record: {
        ...edge,
        route: edge.route === 'failure' || edge.route === 'always' ? edge.route : 'success',
      },
    }));
    const positions = autoLayoutPositions(records, edges);
    const byId = new Map((run?.nodes ?? []).map((node) => [node.nodeId, node]));
    const nodes: WorkflowCanvasNode[] = records.map((record) => ({
      id: record.id,
      type: 'matosNode',
      position: positions[record.id] ?? { x: 0, y: 0 },
      selected: selected === record.id,
      data: {
        record,
        accent: workflowNodeTypeMeta(record.type).accent,
        runNode: byId.get(record.id),
        editable: false,
        showStatusLabel: true,
      },
    }));
    const decorated = decorateWorkflowCanvasEdges(edges, byId, null).map((edge) => ({
      ...edge,
      animated: !error && run?.status === 'running' && edge.animated,
    }));
    return { nodes, edges: decorated, byId };
  }, [run, selected, error]);
  const control = async (
    action: WorkflowControlAction,
    options?: { nodeId?: string; message?: string; reason?: string; fingerprint?: string },
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setControlError(null);
    controlEpoch.current += 1;
    try {
      await controlWorkflowRun(runId, action, options, { projectId });
    } catch (failure) {
      setControlError(String(failure));
    } finally {
      busyRef.current = false;
      setBusy(null);
      controlEpoch.current += 1;
      refresh();
      events.refresh();
    }
  };
  const done =
    run?.nodes.filter((node) => ['completed', 'succeeded', 'skipped'].includes(node.status))
      .length ?? 0;
  const total = model.nodes.length;
  return (
    <section className={styles.monitor} data-stale={!!error} data-running={run?.status === 'running'} data-testid="workflow-monitor">
      <div className={styles.runHeader}>
        <div>
          <h2>{run?.workflowName ?? shortRef(run?.workflowRef ?? null)}</h2>
          <code>{runId}</code>
        </div>
        {run ? <Status status={run.status ?? 'pending'} /> : null}
        <button className="wf-btn" data-testid="workflow-edit-copy" disabled={!run || !!busy || !!error} onClick={() => void openDraft()}>
          <Icon name={busy === 'fork' ? 'spinner' : 'edit'} size={14} />{t('workflow.editCopy')}
        </button>
        <span className={styles.snapshot}>
          <Icon name="shield" size={13} />
          {t('workflow.pinnedVersion')}
        </span>
        <span className={error ? styles.offline : styles.live}>
          <i />
          {t(error ? 'workflow.reconnecting' : updatedAt ? 'workflow.live' : 'workflow.loading')}
        </span>
        <button
          className="wf-btn wf-btn-icon"
          title={t('workflow.refresh')}
          aria-label={t('workflow.refresh')}
          onClick={() => { refresh(); events.refresh(); }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {error || controlError ? (
        <div className={styles.error} role="alert">
          {controlError ?? error}
        </div>
      ) : null}
      {!run ? (
        <p className={styles.empty}>{t(error ? 'workflow.runUnavailable' : 'workflow.loading')}</p>
      ) : (
        <>
          <div className={styles.progress}>
            <progress value={done} max={total || 1} />
            <span>{t('workflow.progressCount', { done, total })}</span>
            {run.activeNodeIds.length > 0 ? <span className={styles.activeStep}>{run.activeNodeIds.join(', ')}</span> : null}
            <div role="tablist">
              {(['graph', 'steps'] as const).map((tab) => (
                <button
                  className="wf-btn"
                  key={tab}
                  role="tab"
                  aria-selected={view === tab}
                  onClick={() => setView(tab)}
                >
                  <Icon name={tab === 'graph' ? 'workflow' : 'kanban'} size={13} />
                  {t(`workflow.${tab}`)}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.runBody}>
            {view === 'graph' ? (
              <div className={styles.graph} data-testid="workflow-run-graph">
                {!run.graph ? <span className={styles.graphWarning}>{t('workflow.graphUnavailable')}</span> : null}
                <ReactFlow
                  nodes={model.nodes}
                  edges={model.edges}
                  nodeTypes={WORKFLOW_CANVAS_NODE_TYPES}
                  fitView
                  minZoom={0.15}
                  maxZoom={2}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_, node) => setSelected(node.id)}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
            ) : (
              <div className={styles.steps}>
                {model.nodes.map(({ id, data: node }, index) => {
                  const current = model.byId.get(id);
                  const seconds = current?.startedAt
                    ? Math.max(
                        0,
                        Math.floor(
                          ((current.status === 'running'
                            ? now
                            : Date.parse(current.finishedAt ?? current.startedAt)) -
                            Date.parse(current.startedAt)) /
                            1000,
                        ),
                      )
                    : null;
                  return (
                    <button key={id} className={styles.step} aria-pressed={selected === id} onClick={() => setSelected(id)}>
                      <span>{index + 1}</span>
                      <b>{node.record.label || id}</b>
                      <Status status={current?.status ?? 'pending'} />
                      <small>{seconds !== null ? `${seconds}s` : ''}</small>
                      <Icon name="chevron-right" size={14} />
                    </button>
                  );
                })}
              </div>
            )}
            {selected ? (
              <aside className={styles.detail}>
                <div>
                  <h3>{run.graph?.nodes.find(node => node.id === selected)?.label || selected}</h3>
                  <button
                    className="wf-btn wf-btn-icon"
                    title={t('workflow.close')}
                    aria-label={t('workflow.close')}
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <WorkflowNodeRunTab
                  key={`${runId}:${selected}`}
                  runId={runId}
                  projectId={projectId}
                  nodeId={selected}
                  liveNode={model.byId.get(selected) ?? null}
                />
              </aside>
            ) : null}
          </div>
          {events.error ? <div className={styles.error} role="alert">{t('workflow.eventError')}: {events.error}</div> : null}
          <WorkflowRunPanel
            run={run}
            events={events.data ?? []}
            busyAction={busy || (error ? 'offline' : null)}
            onControl={(action, options) => void control(action, options)}
            onSelectNode={setSelected}
            onClose={() => navigate({ kind: 'home', view: 'workflows', ...(projectId ? { workflowProjectId: projectId } : {}) })}
          />
        </>
      )}
      {updatedAt ? (
        <footer className={styles.updated}>
          {t('workflow.lastUpdated', { time: new Date(updatedAt).toLocaleTimeString() })}
        </footer>
      ) : null}
    </section>
  );
}
