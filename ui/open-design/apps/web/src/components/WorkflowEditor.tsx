import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useT } from '../i18n';
import { writeProjectTextFileDetailed } from '../providers/registry';
import { mergeWorkflowDocuments, readWorkflowFile, WorkflowDocumentConflict } from './workflow-document';
import { navigate } from '../router';
import { parseWorkflowParameters, WorkflowBindings, WorkflowChecks, WorkflowRunParameters, WorkflowSettings } from './WorkflowForms';
import styles from './WorkflowEditor.module.css';
import type { ProjectFile } from '../types';
import { Icon, type IconName } from './Icon';
import {
  canvasJsonToWorkflowText,
  dependenciesFromAssetJson,
  groupDependencies,
  workflowTextToCanvasJson,
} from './asset-editors';
import {
  applyCanvasEdgesToDefinition,
  autoLayoutPositions,
  canvasEdgesFromDefinition,
  duplicateWorkflowNode,
  emptyWorkflowDefinition,
  parseWorkflowDocument,
  removeWorkflowNode,
  renameWorkflowNode,
  serializeWorkflowDocument,
  uniqueWorkflowNodeId,
  workflowFallbackName,
  WORKFLOW_NODE_TYPES,
  type CanvasEdge,
  type WorkflowDefinitionRecord,
  type WorkflowNodeRecord,
} from './workflow-model';
import {
  controlWorkflowRun,
  fetchWorkflowRunEvents,
  fetchWorkflowRuns,
  fetchWorkflowRunStatus,
  isTerminalWorkflowStatus,
  publishWorkflowDefinition,
  preflightWorkflowRef,
  runWorkflowRef,
  validateWorkflowDefinition,
  type WorkflowControlAction,
  type WorkflowRunEventSummary,
  type WorkflowRunListRow,
  type WorkflowRunNodeSummary,
  type WorkflowRunSummary,
  type WorkflowValidationResult,
} from './matos-workflow-client';
import { workflowNodeTypeMeta } from './workflow-node-meta';
import { WorkflowRunPanel } from './workflow-run-panel';
import { WorkflowNodeRunTab } from './workflow-node-run-tab';
import {
  WORKFLOW_CANVAS_NODE_TYPES,
  decorateWorkflowCanvasEdges,
  workflowCanvasEdgeKey,
  type WorkflowCanvasNode,
} from './workflow-canvas-node';

const WORKFLOW_AUTOSAVE_DELAY_MS = 800;
const WORKFLOW_RUN_POLL_MS = 1500;
const HISTORY_LIMIT = 60;

// Palette order for the add-node menu: everyday nodes first, advanced last.
const ADD_MENU_TYPES: string[] = [
  'agent',
  'exec',
  'compute',
  'validate',
  'guard',
  'human',
  'approval_gate',
  'subworkflow',
  'map',
  'loop',
  'dynamic',
  'backend',
];

// Preset swatches offered in the inspector color row (plus free pick).
const ACCENT_PRESETS = [
  '#c96442',
  '#5b8def',
  '#8b5bef',
  '#2f9e6e',
  '#d9822b',
  '#d94f70',
  '#3aa6b9',
  '#7a7a8c',
];

function typeMeta(type: string): { accent: string; icon: IconName; titleKey: string } {
  return workflowNodeTypeMeta(type);
}

function isKnownNodeType(type: string): type is (typeof WORKFLOW_NODE_TYPES)[number] {
  return (WORKFLOW_NODE_TYPES as readonly string[]).includes(type);
}

/** Slim labeled divider that groups inspector fields into scannable zones. */
function InspectorSection({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className="wf-section" role="presentation">
      <span className="wf-section__icon" aria-hidden>
        <Icon name={icon} size={11} />
      </span>
      <span className="wf-section__label">{label}</span>
      <span className="wf-section__rule" aria-hidden />
    </div>
  );
}

/**
 * exec-node extras: argv lines and env key/value rows. Uses the same
 * defaultValue + onBlur commit style as the other inspector fields so
 * keystrokes do not flood the undo history.
 */
function ExecArgsEnvFields({
  node,
  onPatch,
}: {
  node: WorkflowNodeRecord;
  onPatch: (patch: Partial<WorkflowNodeRecord>) => void;
}) {
  const t = useT();
  const args = Array.isArray(node.args)
    ? node.args.map((value) => (typeof value === 'string' ? value : String(value ?? '')))
    : [];
  const env: Array<[string, string]> =
    node.env && typeof node.env === 'object' && !Array.isArray(node.env)
      ? Object.entries(node.env as Record<string, unknown>).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : String(value ?? ''),
        ])
      : [];

  const commitEnv = (entries: Array<[string, string]>) => {
    const filtered = entries.filter(([key]) => key.trim() !== '');
    onPatch({ env: filtered.length > 0 ? Object.fromEntries(filtered) : undefined });
  };

  return (
    <>
      <label className="wf-field">
        <span>
          <Icon name="braces" size={11} /> {t('workflow.argsField')}
        </span>
        <textarea
          key={`args:${node.id}`}
          rows={Math.min(6, Math.max(2, args.length + 1))}
          defaultValue={args.join('\n')}
          placeholder={t('workflow.argsHint')}
          spellCheck={false}
          onBlur={(event) => {
            const lines = event.target.value.split('\n').filter((line, index, all) => {
              // keep interior blank lines, drop trailing blanks
              return line.trim() !== '' || index < all.length - 1;
            });
            onPatch({ args: lines.length > 0 ? lines : undefined });
          }}
        />
      </label>
      <div className="wf-field">
        <span>
          <Icon name="variable" size={11} /> {t('workflow.envField')}
        </span>
        <div className="wf-kv">
          {env.map(([key, value], index) => (
            <div key={`${node.id}:${index}`} className="wf-kv__row">
              <input
                className="wf-kv__key"
                defaultValue={key}
                placeholder={t('workflow.envKey')}
                aria-label={t('workflow.envKey')}
                spellCheck={false}
                onBlur={(event) => {
                  const nextKey = event.target.value.trim();
                  commitEnv(
                    env.map((pair, i) => (i === index ? [nextKey, pair[1]] : pair) as [string, string]),
                  );
                }}
              />
              <input
                className="wf-kv__value"
                defaultValue={value}
                placeholder={t('workflow.envValue')}
                aria-label={t('workflow.envValue')}
                spellCheck={false}
                onBlur={(event) => {
                  commitEnv(
                    env.map((pair, i) =>
                      (i === index ? [pair[0], event.target.value] : pair) as [string, string],
                    ),
                  );
                }}
              />
              <button
                type="button"
                className="wf-kv__remove"
                aria-label={t('common.delete')}
                title={t('common.delete')}
                onClick={() => commitEnv(env.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="wf-kv__add"
            onClick={() => {
              let n = env.length + 1;
              while (env.some(([key]) => key === `VAR_${n}`)) n += 1;
              commitEnv([...env, [`VAR_${n}`, '']]);
            }}
          >
            <Icon name="plus" size={11} /> {t('workflow.addEnv')}
          </button>
        </div>
      </div>
    </>
  );
}


function workflowSourceKey(projectId: string, file: Pick<ProjectFile, 'name' | 'path' | 'size' | 'mtime'>): string {
  return `${projectId}:${file.path ?? file.name}:${file.size}:${file.mtime}`;
}

interface WorkflowEditorState {
  definition: WorkflowDefinitionRecord;
  edges: CanvasEdge[];
  positions: Record<string, { x: number; y: number }>;
  styles: Record<string, { accent?: string }>;
  parseError: string | null;
}

function editorStateFromText(text: string, fallbackName: string): WorkflowEditorState {
  const { definition, parseError } = parseWorkflowDocument(text, fallbackName);
  const edges = canvasEdgesFromDefinition(definition);
  const stored = definition.canvas?.nodes ?? {};
  const missing = definition.nodes.filter((node) => !stored[node.id]);
  const fallback = missing.length > 0 ? autoLayoutPositions(definition.nodes, edges) : {};
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of definition.nodes) {
    positions[node.id] = stored[node.id] ?? fallback[node.id] ?? { x: 60, y: 60 };
  }
  return { definition, edges, positions, styles: { ...(definition.canvas?.styles ?? {}) }, parseError };
}

function serializeEditorState(state: WorkflowEditorState): string {
  const withEdges = applyCanvasEdgesToDefinition(state.definition, state.edges);
  const definition: WorkflowDefinitionRecord = {
    ...withEdges,
    canvas: {
      ...(withEdges.canvas ?? {}),
      nodes: { ...state.positions },
      styles: { ...state.styles },
    },
  };
  return serializeWorkflowDocument(definition);
}

// --- role asset mounts summary (agent-node inspector) -----------------------

interface RoleMountsSummary {
  groups: Array<[string, string[]]>;
  error: boolean;
}

const roleMountsCache = new Map<string, RoleMountsSummary>();

function useRoleMounts(roleRef: string | null): RoleMountsSummary | null {
  const [summary, setSummary] = useState<RoleMountsSummary | null>(null);
  useEffect(() => {
    if (!roleRef) {
      setSummary(null);
      return;
    }
    const ref = roleRef.replace(/@.*$/, '');
    const cached = roleMountsCache.get(ref);
    if (cached) {
      setSummary(cached);
      return;
    }
    let cancelled = false;
    setSummary(null);
    void (async () => {
      try {
        const resp = await fetch(`/api/matos/assets/${encodeURIComponent(ref)}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(String(resp.status));
        const payload = (await resp.json()) as {
          files?: Array<{ name: string; content: string }>;
        };
        const assetJson = payload.files?.find((file) => file.name === 'asset.json');
        const deps = assetJson ? dependenciesFromAssetJson(assetJson.content) : [];
        const groups: Array<[string, string[]]> = [...groupDependencies(deps).entries()].filter(
          ([, refs]) => refs.length > 0,
        );
        const next = { groups, error: false };
        roleMountsCache.set(ref, next);
        if (!cancelled) setSummary(next);
      } catch {
        const next = { groups: [], error: true };
        if (!cancelled) setSummary(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleRef]);
  return summary;
}

function RoleMountsPanel({ roleRef }: { roleRef: string }) {
  const t = useT();
  const summary = useRoleMounts(roleRef);
  const cleanRef = roleRef.replace(/@.*$/, '');
  return (
    <div className="wf-role-mounts">
      <div className="wf-role-mounts-head">
        <span>{t('workflow.roleAssets')}</span>
        <a
          className="wf-role-mounts-link"
          href={`/assets/${encodeURIComponent(cleanRef)}`}
          target="_blank"
          rel="noreferrer"
        >
          {t('workflow.editRoleInAssets')}
          <Icon name="external-link" size={11} />
        </a>
      </div>
      {summary === null ? (
        <div className="wf-role-mounts-empty">…</div>
      ) : summary.error || summary.groups.length === 0 ? (
        <div className="wf-role-mounts-empty">{t('workflow.roleAssetsEmpty')}</div>
      ) : (
        summary.groups.map(([type, refs]) => (
          <div key={type} className="wf-role-mounts-group">
            <span className="wf-role-mounts-type">{type}</span>
            <span className="wf-role-mounts-chips">
              {refs.map((dep) => (
                <code key={dep}>{dep.replace(/^[a-z]+:/, '').replace(/@.*$/, '')}</code>
              ))}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// --- main editor -------------------------------------------------------------

interface CoreProps {
  projectId?: string;
  /** Stable identity for the edited document (drives reload effects). */
  docKey: string;
  /** Filename-ish label shown in the toolbar. */
  fileLabel: string;
  /** Workflow name fallback when the document has none. */
  fallbackName: string;
  /**
   * Changes when the backing document changed externally (agent edit); the
   * editor reloads unless local edits are pending.
   */
  sourceKey: string;
  loadText: () => Promise<string>;
  saveText: (text: string, expectedText?: string) => Promise<void>;
  /** Role asset refs offered in the agent-node inspector picker. */
  roleOptions?: string[];
  onSaved?: () => Promise<void> | void;
  focusMode?: boolean;
  onFocusModeChange?: (next: boolean) => void;
}

interface Props {
  projectId: string;
  file: ProjectFile;
  roleOptions?: string[];
  onSaved?: () => Promise<void> | void;
  focusMode?: boolean;
  onFocusModeChange?: (next: boolean) => void;
}

/** Project-file mode: the workspace tab editing `*.workflow.json|yaml` files.
 *  YAML definitions (asset entry files, agent-authored `workflow.yaml`) are
 *  translated to canvas JSON on load and re-emitted as YAML on save through
 *  the same converters the Assets workbench uses, so the canvas core stays
 *  JSON-only. */
export function WorkflowEditor({
  projectId, file, roleOptions = [], onSaved, focusMode, onFocusModeChange,
}: Props) {
  const revisions = useMemo(() => new Map<string, string>(), [projectId, file.name]);
  const loadText = useCallback(
    async () => {
      const raw = await readWorkflowFile(projectId, file.name);
      const text = workflowTextToCanvasJson(raw.text, file.name);
      revisions.set(text, raw.revision);
      return text;
    },
    [projectId, file.name, revisions],
  );
  const saveText = useCallback(
    async (text: string, expectedText?: string) => {
      const expectedEtag = expectedText === undefined ? undefined : revisions.get(expectedText);
      if (!expectedEtag) throw new Error('File revision is unavailable');
      const result = await writeProjectTextFileDetailed(projectId, file.name, canvasJsonToWorkflowText(text, file.name), { expectedEtag });
      if (!result.ok) {
        if (result.status === 409) throw new WorkflowDocumentConflict(result.message);
        throw new Error(result.message);
      }
      if (result.file.etag) revisions.set(text, result.file.etag);
    },
    [projectId, file.name, revisions],
  );
  return (
    <WorkflowEditorCore
      key={`${projectId}:${file.name}`}
      projectId={projectId}
      docKey={`${projectId}:${file.name}`}
      fileLabel={file.name}
      fallbackName={workflowFallbackName(file.name)}
      sourceKey={workflowSourceKey(projectId, file)}
      loadText={loadText}
      saveText={saveText}
      roleOptions={roleOptions}
      onSaved={onSaved}
      focusMode={focusMode}
      onFocusModeChange={onFocusModeChange}
    />
  );
}

/**
 * Source-agnostic canvas core. Also mounted by the MatOS Assets workbench to
 * edit workflow *asset* definitions through the daemon's asset bridge.
 */
export function WorkflowEditorCore({
  projectId,
  docKey,
  fileLabel,
  fallbackName,
  sourceKey,
  loadText,
  saveText,
  roleOptions = [],
  onSaved,
  focusMode = false,
  onFocusModeChange,
}: CoreProps) {
  const t = useT();
  const scopeArgs = useMemo<[] | [{ projectId: string }]>(() => projectId ? [{ projectId }] : [], [projectId]);
  const [state, setState] = useState<WorkflowEditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [incomingText, setIncomingText] = useState<string | null>(null);
  const incomingRef = useRef<string | null>(null);
  const [documentRevision, setDocumentRevision] = useState(0);
  const inFlightSave = useRef<Promise<boolean> | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [canvasView, setCanvasView] = useState<'graph' | 'steps'>('graph');
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 520px)').matches) setCanvasView('steps');
  }, []);
  const launchBusyRef = useRef(false);
  const launchedDefinitionRef = useRef<string | null>(null);
  const pendingInputRef = useRef<EventTarget | null>(null);
  const [invalidNodeDrafts, setInvalidNodeDrafts] = useState<Record<string, { text: string; error: string }>>({});
  const invalidNodeDraftsRef = useRef(invalidNodeDrafts);
  const updateInvalidNodeDraft = useCallback((id: string, draft?: { text: string; error: string }) => {
    const next = { ...invalidNodeDraftsRef.current };
    if (draft) next[id] = draft;
    else delete next[id];
    invalidNodeDraftsRef.current = next;
    setInvalidNodeDrafts(next);
  }, []);
  useEffect(() => {
    pendingInputRef.current = null;
    invalidNodeDraftsRef.current = {};
    setInvalidNodeDrafts({});
  }, [documentRevision]);

  const stateRef = useRef<WorkflowEditorState | null>(null);
  stateRef.current = state;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const loadedSourceKeyRef = useRef<string | null>(null);
  const lastSavedTextRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const historyRef = useRef<{ past: WorkflowEditorState[]; future: WorkflowEditorState[] }>({
    past: [],
    future: [],
  });
  const draggingRef = useRef(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  const performSave = useCallback(async (): Promise<boolean> => {
    if (inFlightSave.current) {
      if (!(await inFlightSave.current)) return false;
      return performSaveRef.current();
    }
    const current = stateRef.current;
    if (!current || current.parseError || incomingRef.current !== null || pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length) return false;
    const text = serializeEditorState(current);
    if (text === lastSavedTextRef.current) {
      const currentAfterSave = stateRef.current;
      const hasNewerEdits = !!pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length > 0 || !currentAfterSave || serializeEditorState(currentAfterSave) !== text;
      setDirty(hasNewerEdits);
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const pending = (async () => { try {
      await saveText(text, lastSavedTextRef.current ?? undefined);
      lastSavedTextRef.current = text;
      const currentAfterSave = stateRef.current;
      const hasNewerEdits = !!pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length > 0 || !currentAfterSave || serializeEditorState(currentAfterSave) !== text;
      setDirty(hasNewerEdits);
      setSavedAt(Date.now());
      void Promise.resolve(onSaved?.()).catch(() => undefined);
      if (hasNewerEdits) setTimeout(() => void performSaveRef.current(), WORKFLOW_AUTOSAVE_DELAY_MS);
      return !hasNewerEdits && incomingRef.current === null;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      if (err instanceof WorkflowDocumentConflict) {
        try {
          const remote = await loadText();
          incomingRef.current = remote;
          setIncomingText(remote);
        } catch { /* Preserve local edits when the conflict cannot be read. */ }
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    } })();
    inFlightSave.current = pending;
    try { return await pending; } finally { inFlightSave.current = null; }
  }, [saveText, onSaved, loadText]);

  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  const queueAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void performSaveRef.current();
    }, WORKFLOW_AUTOSAVE_DELAY_MS);
  }, []);

  // Flush pending edits when the tab unmounts or the page hides.
  useEffect(() => {
    const flush = () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (dirtyRef.current) void performSaveRef.current();
    };
    window.addEventListener('pagehide', flush);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current || pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length) {
        event.preventDefault();
        event.returnValue = '';
      }
      flush();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', beforeUnload);
      flush();
    };
  }, []);

  // Load the document, and reload when the on-disk file changes under us
  // (agent edits arrive through the daemon file watcher → new mtime/size →
  // new sourceKey). Local dirty state wins over external changes.
  useEffect(() => {
    if (loadedSourceKeyRef.current === sourceKey) return;
    let cancelled = false;
    setLoading(stateRef.current === null);
    void (async () => {
      try {
        const text = (await loadText()) ?? '';
        if (cancelled) return;
        loadedSourceKeyRef.current = sourceKey;
        // Our own save bumps mtime; skip the no-op reload so selection and
        // in-progress inspector edits survive.
        if (lastSavedTextRef.current !== null && text === lastSavedTextRef.current) {
          setLoading(false);
          return;
        }
        if (stateRef.current && !stateRef.current.parseError && lastSavedTextRef.current !== null) {
          incomingRef.current = text;
          setIncomingText(text);
          setLoading(false);
          return;
        }
        lastSavedTextRef.current = text;
        setState(editorStateFromText(text, fallbackName));
        setDocumentRevision((value) => value + 1);
        historyRef.current = { past: [], future: [] };
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.warn('[WorkflowEditor] load failed', docKey, err);
        if (stateRef.current) {
          setSaveError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          return;
        }
        setState({
          definition: emptyWorkflowDefinition(fallbackName),
          edges: [],
          positions: {},
          styles: {},
          parseError: err instanceof Error ? err.message : String(err),
        });
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docKey, loadText, sourceKey, fallbackName]);

  const resolveIncoming = (choice: 'remote' | 'local' | 'merge') => {
    const remote = incomingRef.current;
    const current = stateRef.current;
    if (remote === null || !current || savingRef.current) return;
    if (choice !== 'remote' && (pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length)) return;
    let text = choice === 'remote' ? remote : serializeEditorState(current);
    if (choice === 'merge') {
      try {
        const result = mergeWorkflowDocuments(lastSavedTextRef.current ?? '{}', text, remote);
        if (result.conflicts.length) {
          setSaveError(t('workflow.mergeConflict', { paths: result.conflicts.join(', ') }));
          return;
        }
        text = result.text;
      } catch (error) {
        setSaveError(String(error));
        return;
      }
    }
    lastSavedTextRef.current = remote;
    incomingRef.current = null;
    setIncomingText(null);
    setState(editorStateFromText(text, fallbackName));
    setDocumentRevision((value) => value + 1);
    historyRef.current = { past: [], future: [] };
    setSaveError(null);
    setDirty(choice !== 'remote');
    if (choice !== 'remote') queueAutosave();
  };

  const pushHistory = useCallback((snapshot: WorkflowEditorState) => {
    const history = historyRef.current;
    history.past.push(snapshot);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  const mutate = useCallback(
    (updater: (current: WorkflowEditorState) => WorkflowEditorState, options?: { history?: boolean }) => {
      const current = stateRef.current;
      if (!current || current.parseError) return;
      const next = updater(current);
      if (next !== current && options?.history !== false) pushHistory(current);
      stateRef.current = next;
      setState(next);
      setDirty(true);
      dirtyRef.current = true;
      queueAutosave();
    },
    [queueAutosave, pushHistory],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    setState((current) => {
      if (current) history.future.push(current);
      return previous;
    });
    setHistoryVersion((v) => v + 1);
    setDocumentRevision((v) => v + 1);
    setDirty(true);
    queueAutosave();
  }, [queueAutosave]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next) return;
    setState((current) => {
      if (current) history.past.push(current);
      return next;
    });
    setHistoryVersion((v) => v + 1);
    setDocumentRevision((v) => v + 1);
    setDirty(true);
    queueAutosave();
  }, [queueAutosave]);

  // --- run controls state (declared early: node decoration reads runSummary) --
  const [runPhase, setRunPhase] = useState<
    'idle' | 'validating' | 'publishing' | 'running' | 'polling'
  >('idle');
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [runSummary, setRunSummary] = useState<WorkflowRunSummary | null>(null);
  const [runEvents, setRunEvents] = useState<WorkflowRunEventSummary[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [runPollError, setRunPollError] = useState<string | null>(null);
  const pollFailures = useRef(0);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  // Re-arm signal for the run poll loop (see the polling effect below).
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    setRunPollError(null);
    pollFailures.current = 0;
  }, [runSummary?.runId]);
  // Recent-runs picker: attach the run panel to a run started elsewhere
  // (agent tool, CLI, trigger) or re-attach after a page reload.
  const [recentRunsOpen, setRecentRunsOpen] = useState(false);
  const [recentRuns, setRecentRuns] = useState<WorkflowRunListRow[] | null>(null);
  const [recentRunsError, setRecentRunsError] = useState<string | null>(null);
  const runBusy = runPhase !== 'idle';
  // Inspector tab; "run" survives node switches so users can walk the graph
  // reading each node's run record.
  const [inspectorTab, setInspectorTab] = useState<'config' | 'json' | 'run'>('config');
  const nodeJsonError = selectedNodeId ? invalidNodeDrafts[selectedNodeId]?.error : undefined;

  const commitNodeLabel = useCallback(
    (nodeId: string, labelRaw: string) => {
      const label = labelRaw.trim();
      mutate((current) => ({
        ...current,
        definition: {
          ...current.definition,
          nodes: current.definition.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const next = { ...node };
            if (label && label !== node.id) next.label = label;
            else delete next.label;
            return next;
          }),
        },
      }));
    },
    [mutate],
  );

  const runNodeMap = useMemo(() => {
    const map = new Map<string, WorkflowRunNodeSummary>();
    const sameDefinition = state && launchedDefinitionRef.current === serializeEditorState(state);
    for (const node of sameDefinition ? runSummary?.nodes ?? [] : []) {
      if (node.nodeId) map.set(node.nodeId, node);
    }
    return map;
  }, [runSummary, state]);

  const accentFor = useCallback(
    (record: WorkflowNodeRecord): string => {
      const custom = state?.styles[record.id]?.accent;
      return custom && custom.trim() ? custom : typeMeta(record.type).accent;
    },
    [state],
  );

  const flowNodes = useMemo<WorkflowCanvasNode[]>(() => {
    if (!state) return [];
    return state.definition.nodes.map((record) => ({
      id: record.id,
      type: 'matosNode' as const,
      position: state.positions[record.id] ?? { x: 60, y: 60 },
      selected: record.id === selectedNodeId,
      data: {
        record,
        accent: accentFor(record),
        runNode: runNodeMap.get(record.id),
        onCommitLabel: commitNodeLabel,
      },
    }));
  }, [state, selectedNodeId, accentFor, runNodeMap, commitNodeLabel]);

  const flowEdges = useMemo<Edge[]>(
    () => state ? decorateWorkflowCanvasEdges(state.edges, runNodeMap, selectedEdgeId) : [],
    [state, selectedEdgeId, runNodeMap],
  );

  const handleNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    let structural = false;
    for (const change of changes) {
      if (change.type === 'select') {
        setSelectedNodeId((current) => {
          if (change.selected) return change.id;
          return current === change.id ? null : current;
        });
        if (change.selected) setSelectedEdgeId(null);
      }
    }
    // Snapshot once at drag start so undo restores the pre-drag layout.
    const dragStart = changes.some(
      (change) => change.type === 'position' && change.dragging === true,
    );
    if (dragStart && !draggingRef.current && stateRef.current) {
      draggingRef.current = true;
      const snapshot = stateRef.current;
      historyRef.current.past.push(snapshot);
      if (historyRef.current.past.length > HISTORY_LIMIT) historyRef.current.past.shift();
      historyRef.current.future = [];
      setHistoryVersion((v) => v + 1);
    }
    if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
      draggingRef.current = false;
    }
    setState((current) => {
      if (!current) return current;
      let next = current;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next = {
            ...next,
            positions: { ...next.positions, [change.id]: { x: change.position.x, y: change.position.y } },
          };
          structural = true;
        } else if (change.type === 'remove') {
          next = {
            ...next,
            definition: removeWorkflowNode(next.definition, change.id),
            edges: next.edges.filter((edge) => edge.from !== change.id && edge.to !== change.id),
          };
          const positions = { ...next.positions };
          delete positions[change.id];
          const styles = { ...next.styles };
          delete styles[change.id];
          next = { ...next, positions, styles };
          structural = true;
        }
      }
      return next;
    });
    if (structural) {
      setDirty(true);
      queueAutosave();
    }
  }, [queueAutosave]);

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const removed = new Set(
      changes.filter((change) => change.type === 'remove').map((change) => change.id),
    );
    if (removed.size === 0) return;
    setSelectedEdgeId((current) => (current && removed.has(current) ? null : current));
    mutate((current) => ({
      ...current,
      edges: current.edges.filter((edge) => !removed.has(workflowCanvasEdgeKey(edge))),
    }));
  }, [mutate]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    mutate((current) => {
      const key = `${connection.source}\u0000${connection.target}`;
      if (current.edges.some((edge) => workflowCanvasEdgeKey(edge) === key)) return current;
      return {
        ...current,
        edges: [...current.edges, { from: connection.source, to: connection.target, explicit: false }],
      };
    });
  }, [mutate]);

  const addNode = useCallback((nodeType: string) => {
    setAddMenuOpen(false);
    let createdId = '';
    mutate((current) => {
      const id = uniqueWorkflowNodeId(current.definition, nodeType);
      createdId = id;
      const record: WorkflowNodeRecord = {
        id,
        type: nodeType,
        dependsOn: [],
        ...(nodeType === 'agent' || nodeType === 'dynamic' ? { role: '', prompt: '' } : {}),
        ...(nodeType === 'exec' ? { command: '' } : {}),
      };
      const maxX = Object.values(current.positions).reduce((acc, pos) => Math.max(acc, pos.x), 0);
      return {
        ...current,
        definition: { ...current.definition, nodes: [...current.definition.nodes, record] },
        positions: { ...current.positions, [id]: { x: maxX + 300, y: 60 } },
      };
    });
    if (createdId) {
      setSelectedNodeId(createdId);
      setSelectedEdgeId(null);
    }
  }, [mutate]);

  // Close the add menu on outside pointer/Escape.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as globalThis.Node)) {
        setAddMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenuOpen]);

  const updateSelectedNode = useCallback((patch: Partial<WorkflowNodeRecord>) => {
    if (!selectedNodeId) return;
    mutate((current) => ({
      ...current,
      definition: {
        ...current.definition,
        nodes: current.definition.nodes.map((node) => {
          if (node.id !== selectedNodeId) return node;
          const next = { ...node };
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete next[key];
            else next[key] = value;
          }
          return next;
        }),
      },
    }));
  }, [mutate, selectedNodeId]);

  // JSON tab commit: replace the whole node record. The id is pinned (rename
  // lives in the Config tab so wiring/positions/styles stay consistent), and
  // dependsOn edits are mirrored into the canvas edge list, which is the
  // authoritative wiring source at save time.
  const applySelectedNodeJson = useCallback(
    (raw: string) => {
      if (!selectedNodeId) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        updateInvalidNodeDraft(selectedNodeId, { text: raw, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        updateInvalidNodeDraft(selectedNodeId, { text: raw, error: 'node definition must be a JSON object' });
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.type !== 'string' || !record.type.trim()) {
        updateInvalidNodeDraft(selectedNodeId, { text: raw, error: 'node type is required' });
        return;
      }
      const knownIds = new Set(stateRef.current?.definition.nodes.map((node) => node.id));
      if (record.dependsOn !== undefined && (!Array.isArray(record.dependsOn) || record.dependsOn.some((dep) => typeof dep !== 'string' || dep === selectedNodeId || !knownIds.has(dep)))) {
        updateInvalidNodeDraft(selectedNodeId, { text: raw, error: 'dependsOn must reference other nodes in this workflow' });
        return;
      }
      const dependsOn = Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dep): dep is string => typeof dep === 'string')
        : [];
      const nextNode: WorkflowNodeRecord = {
        ...record,
        id: selectedNodeId,
        type: record.type.trim(),
        dependsOn,
      } as WorkflowNodeRecord;
      updateInvalidNodeDraft(selectedNodeId);
      mutate((current) => {
        const known = new Set(current.definition.nodes.map((node) => node.id));
        const nextDeps = dependsOn.filter((dep) => known.has(dep) && dep !== selectedNodeId);
        const keptEdges = current.edges.filter(
          (edge) => edge.to !== selectedNodeId || nextDeps.includes(edge.from),
        );
        const existingFrom = new Set(
          keptEdges.filter((edge) => edge.to === selectedNodeId).map((edge) => edge.from),
        );
        const addedEdges = nextDeps
          .filter((dep) => !existingFrom.has(dep))
          .map((dep) => ({ from: dep, to: selectedNodeId, explicit: false }));
        return {
          ...current,
          definition: {
            ...current.definition,
            nodes: current.definition.nodes.map((node) =>
              node.id === selectedNodeId ? { ...nextNode, dependsOn: nextDeps } : node,
            ),
          },
          edges: [...keptEdges, ...addedEdges],
        };
      });
    },
    [mutate, selectedNodeId, updateInvalidNodeDraft],
  );

  const renameSelectedNode = useCallback((nextIdRaw: string) => {
    if (!selectedNodeId) return;
    const nextId = nextIdRaw.trim();
    if (!nextId || nextId === selectedNodeId) return;
    mutate((current) => {
      if (current.definition.nodes.some((node) => node.id === nextId)) return current;
      const positions = { ...current.positions };
      if (positions[selectedNodeId]) {
        positions[nextId] = positions[selectedNodeId];
        delete positions[selectedNodeId];
      }
      const styles = { ...current.styles };
      if (styles[selectedNodeId]) {
        styles[nextId] = styles[selectedNodeId];
        delete styles[selectedNodeId];
      }
      return {
        ...current,
        definition: renameWorkflowNode(current.definition, selectedNodeId, nextId),
        edges: current.edges.map((edge) => ({
          ...edge,
          from: edge.from === selectedNodeId ? nextId : edge.from,
          to: edge.to === selectedNodeId ? nextId : edge.to,
        })),
        positions,
        styles,
      };
    });
    setSelectedNodeId(nextId);
  }, [mutate, selectedNodeId]);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    updateInvalidNodeDraft(selectedNodeId);
    mutate((current) => {
      const positions = { ...current.positions };
      delete positions[selectedNodeId];
      const styles = { ...current.styles };
      delete styles[selectedNodeId];
      return {
        ...current,
        definition: removeWorkflowNode(current.definition, selectedNodeId),
        edges: current.edges.filter((edge) => edge.from !== selectedNodeId && edge.to !== selectedNodeId),
        positions,
        styles,
      };
    });
    setSelectedNodeId(null);
  }, [mutate, selectedNodeId, updateInvalidNodeDraft]);

  const duplicateSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    let createdId = '';
    mutate((current) => {
      const result = duplicateWorkflowNode(current.definition, selectedNodeId);
      if (!result) return current;
      createdId = result.newId;
      const sourcePos = current.positions[selectedNodeId] ?? { x: 60, y: 60 };
      const styles = { ...current.styles };
      if (styles[selectedNodeId]) styles[createdId] = { ...styles[selectedNodeId] };
      return {
        ...current,
        definition: result.definition,
        positions: {
          ...current.positions,
          [createdId]: { x: sourcePos.x + 40, y: sourcePos.y + 90 },
        },
        styles,
      };
    });
    if (createdId) setSelectedNodeId(createdId);
  }, [mutate, selectedNodeId]);

  const setSelectedNodeAccent = useCallback((accent: string | null) => {
    if (!selectedNodeId) return;
    mutate((current) => {
      const styles = { ...current.styles };
      if (accent) styles[selectedNodeId] = { ...(styles[selectedNodeId] ?? {}), accent };
      else delete styles[selectedNodeId];
      return { ...current, styles };
    });
  }, [mutate, selectedNodeId]);

  const applyAutoLayout = useCallback(() => {
    mutate((current) => ({
      ...current,
      positions: autoLayoutPositions(current.definition.nodes, current.edges),
    }));
  }, [mutate]);

  const renameWorkflow = useCallback((nameRaw: string) => {
    setEditingName(false);
    const name = nameRaw.trim();
    mutate((current) => {
      if (!name || name === current.definition.name) return current;
      return { ...current, definition: { ...current.definition, name } };
    });
  }, [mutate]);

  const updateSelectedEdge = useCallback(
    (patch: { condition?: string; route?: string }) => {
      if (!selectedEdgeId) return;
      mutate((current) => ({
        ...current,
        edges: current.edges.map((edge) => {
          if (workflowCanvasEdgeKey(edge) !== selectedEdgeId) return edge;
          const record = { ...(edge.record ?? { from: edge.from, to: edge.to }) };
          if (patch.condition !== undefined) {
            if (patch.condition.trim()) record.condition = patch.condition.trim();
            else delete record.condition;
          }
          if (patch.route !== undefined) {
            if (patch.route === 'success' || patch.route === 'failure' || patch.route === 'always') {
              record.route = patch.route;
            } else {
              delete record.route;
            }
          }
          const explicit = Boolean(record.condition || record.route);
          return { ...edge, explicit, record: explicit ? record : undefined };
        }),
      }));
    },
    [mutate, selectedEdgeId],
  );

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    mutate((current) => ({
      ...current,
      edges: current.edges.filter((edge) => workflowCanvasEdgeKey(edge) !== selectedEdgeId),
    }));
    setSelectedEdgeId(null);
  }, [mutate, selectedEdgeId]);

  // Keyboard shortcuts: undo/redo/duplicate. Skip when typing in fields.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key.toLowerCase() === 'd' && selectedNodeId) {
        event.preventDefault();
        duplicateSelectedNode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateSelectedNode, selectedNodeId]);

  const selectedNode = useMemo(
    () => state?.definition.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [state, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => state?.edges.find((edge) => workflowCanvasEdgeKey(edge) === selectedEdgeId) ?? null,
    [state, selectedEdgeId],
  );

  const buildDefinition = useCallback((): unknown | null => {
    const current = stateRef.current;
    if (!current || current.parseError || pendingInputRef.current || Object.keys(invalidNodeDraftsRef.current).length) return null;
    try {
      return JSON.parse(serializeEditorState(current));
    } catch {
      return null;
    }
  }, []);

  // The bridge label keys the daemon's deterministic per-canvas draft, so it
  // must be unique per document — docKey carries the project/asset prefix,
  // while fileLabel (`demo.workflow.json`) can repeat across projects.
  const handleValidate = useCallback(async () => {
    const definition = buildDefinition();
    if (!definition) return;
    setRunPhase('validating');
    setRunError(null);
    setRunSummary(null);
    try {
      setValidation(await validateWorkflowDefinition(definition, docKey, ...scopeArgs));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunPhase('idle');
    }
  }, [buildDefinition, docKey, scopeArgs]);

  const handlePublishAndRun = useCallback(async (parameters: Record<string, unknown>) => {
    if (launchBusyRef.current) return;
    launchBusyRef.current = true;
    // Persist the canvas first so the on-disk file matches what we run.
    if (!(await performSaveRef.current())) { launchBusyRef.current = false; return; }
    const definition = buildDefinition();
    if (!definition || incomingRef.current !== null || stateRef.current?.parseError) { launchBusyRef.current = false; return; }
    launchedDefinitionRef.current = serializeEditorState(stateRef.current!);
    setRunError(null);
    setRunSummary(null);
    setRunEvents([]);
    setRunPhase('publishing');
    try {
      const { validation: verdict, published } = await publishWorkflowDefinition({
        definition,
        label: docKey,
      }, ...scopeArgs);
      setValidation(verdict);
      if (!verdict.ok || !published?.workflowRef) {
        setRunPhase('idle');
        if (verdict.ok && !published?.workflowRef) {
          setRunError('Publish did not return a workflow ref');
        }
        return;
      }
      const preflight = await preflightWorkflowRef(published.workflowRef, parameters, ...scopeArgs);
      if (!preflight.runnable) {
        setRunError(`${t('workflow.preflightBlocked')}: ${preflight.issues.map((issue) => issue.message).join('; ')}`);
        setRunPhase('idle');
        return;
      }
      // The daemon starts the run detached, so this returns as soon as the
      // run exists and the poll loop below streams live node progress.
      setRunPhase('running');
      const run = await runWorkflowRef(published.workflowRef, parameters, ...scopeArgs);
      setRunSummary(run);
      setRunSetupOpen(false);
      setRunPhase(run.runId && !isTerminalWorkflowStatus(run.status) ? 'polling' : 'idle');
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setRunPhase('idle');
    } finally {
      launchBusyRef.current = false;
    }
  }, [buildDefinition, docKey, t, scopeArgs]);

  // Poll the launched run (view + event feed) until it reaches a terminal
  // state. The effect re-arms itself through pollTick (bumped after each
  // completed tick) instead of depending on the runSummary object: with
  // runSummary in the dependency array, every setRunSummary immediately
  // cancelled its own in-flight tick, so the events fetch (behind the
  // cancelled guard) lost the race on most ticks and the event feed froze;
  // and the unguarded terminal setRunPhase('idle') could kill the poll loop
  // of a *newly attached* run when the previous run's slow tick landed late.
  // All state writes now sit behind a single cancelled check placed after
  // every await.
  useEffect(() => {
    if (runPhase !== 'polling') return;
    const runId = runSummary?.runId;
    if (!runId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        let next: WorkflowRunSummary | null = null;
        let events: WorkflowRunEventSummary[] | null = null;
        let error: string | null = null;
        let eventError: string | null = null;
        try {
          next = await fetchWorkflowRunStatus(runId, ...scopeArgs);
          try {
            events = await (projectId ? fetchWorkflowRunEvents(runId, 200, { projectId }) : fetchWorkflowRunEvents(runId));
          } catch (err) {
            eventError = err instanceof Error ? err.message : String(err);
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (cancelled) return;
        if (error !== null) {
          setRunPollError(error);
          pollFailures.current += 1;
          setPollTick((tick) => tick + 1);
          return;
        }
        setRunPollError(eventError);
        pollFailures.current = eventError ? pollFailures.current + 1 : 0;
        if (next) {
          setRunError(null);
          setRunSummary(next);
          if (events) setRunEvents(events);
          if (isTerminalWorkflowStatus(next.status)) {
            setRunPhase('idle');
          } else {
            setPollTick((tick) => tick + 1);
          }
        }
      })();
    }, Math.min(30_000, WORKFLOW_RUN_POLL_MS * 2 ** Math.min(pollFailures.current, 5)));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runPhase, runSummary?.runId, pollTick, scopeArgs, projectId]);

  // Run lifecycle controls (cancel/pause/resume/retry/skip/approve/deny),
  // each resolving to a fresh run view. Resume/retry restart the poll loop.
  const handleRunControl = useCallback(
    (
      action: WorkflowControlAction,
      options?: { nodeId?: string; message?: string; reason?: string; fingerprint?: string },
    ) => {
      const runId = runSummary?.runId;
      if (!runId || controlBusy) return;
      setControlBusy(action);
      void (async () => {
        try {
          const next = await controlWorkflowRun(runId, action, options, ...scopeArgs);
          setRunSummary(next);
          setRunError(null);
          if (!isTerminalWorkflowStatus(next.status)) setRunPhase('polling');
        } catch (err) {
          setRunError(err instanceof Error ? err.message : String(err));
        } finally {
          setControlBusy(null);
        }
      })();
    },
    [runSummary?.runId, controlBusy, scopeArgs],
  );

  const dismissRun = useCallback(() => {
    setRunSummary(null);
    setRunEvents([]);
    setRunPhase('idle');
  }, []);

  const toggleRecentRuns = useCallback(() => {
    setRecentRunsOpen((open) => {
      const next = !open;
      if (next) {
        setRecentRuns(null);
        setRecentRunsError(null);
        void (projectId ? fetchWorkflowRuns(undefined, { projectId }) : fetchWorkflowRuns())
          .then((rows) => setRecentRuns(rows))
          .catch((err) =>
            setRecentRunsError(err instanceof Error ? err.message : String(err)),
          );
      }
      return next;
    });
  }, [projectId]);

  // Attach the run panel to an existing run: one status fetch seeds the
  // summary, then the normal poll loop takes over exactly as if this canvas
  // had launched the run itself.
  const attachRun = useCallback((runId: string) => {
    if (!projectId) {
      navigate({ kind: 'home', view: 'workflows', workflowRunId: runId });
      return;
    }
    setRecentRunsOpen(false);
    setRunError(null);
    setRunPollError(null);
    pollFailures.current = 0;
    setRunEvents([]);
    setRunPhase('running');
    void (async () => {
      try {
        const run = await fetchWorkflowRunStatus(runId, { projectId });
        setRunSummary(run);
        setRunPhase(!isTerminalWorkflowStatus(run.status) ? 'polling' : 'idle');
        try {
          setRunEvents(await fetchWorkflowRunEvents(runId, 200, { projectId }));
        } catch (err) {
          setRunPollError(err instanceof Error ? err.message : String(err));
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
        setRunPhase('idle');
      }
    })();
  }, [projectId]);

  const focusRunNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setInspectorTab('run');
  }, []);

  if (loading && !state) {
    return <div className="viewer-empty">{t('workflow.loading')}</div>;
  }
  if (!state) return null;

  const statusLabel = saving
    ? t('workflow.saving')
    : dirty
      ? t('workflow.unsaved')
      : savedAt
        ? t('workflow.saved')
        : '';

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  void historyVersion;

  const selectedAccent = selectedNodeId ? state.styles[selectedNodeId]?.accent ?? null : null;
  const roleValue =
    selectedNode && typeof selectedNode.role === 'string' ? selectedNode.role : '';
  const roleInOptions = roleValue === '' || roleOptions.includes(roleValue);
  const defaultDefinitions = Object.fromEntries(Object.entries(state.definition.parameters).filter(([, spec]) => spec && typeof spec === 'object' && 'default' in spec));
  const invalidFields = [...Object.keys(invalidNodeDrafts), ...Object.keys(parseWorkflowParameters(defaultDefinitions, {}).errors)];
  const invalidDraft = invalidFields.length > 0;

  return (
    <div className={`workflow-editor ${styles.editor}`} data-testid="workflow-editor" onInputCapture={(event) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('.wf-run-setup, .wf-run-panel, .wf-node-run-tab')) return;
      pendingInputRef.current = event.target;
      dirtyRef.current = true;
      setDirty(true);
    }} onBlur={(event) => {
      if (pendingInputRef.current !== event.target) return;
      pendingInputRef.current = null;
      queueAutosave();
    }}>
      <div className="wf-toolbar">
        <div className="wf-toolbar-title">
          {editingName ? (
            <input
              className="wf-name-input"
              defaultValue={state.definition.name}
              autoFocus
              aria-label={t('workflow.renameWorkflow')}
              onFocus={(event) => event.target.select()}
              onBlur={(event) => renameWorkflow(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                if (event.key === 'Escape') {
                  (event.target as HTMLInputElement).value = state.definition.name;
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="wf-toolbar-name"
              title={`${state.definition.name} — ${t('workflow.renameWorkflow')}`}
              onClick={() => setEditingName(true)}
            >
              <span className="wf-toolbar-name-text">{state.definition.name}</span>
              <Icon name="pencil" size={11} />
            </button>
          )}
          <span className="wf-toolbar-file" title={fileLabel}>{fileLabel}</span>
        </div>
        <div className="wf-toolbar-actions">
          <button className="wf-btn wf-btn-icon" title={t('workflow.settings')} aria-label={t('workflow.settings')} onClick={() => { setSettingsOpen(!settingsOpen); setSelectedNodeId(null); setSelectedEdgeId(null); }}><Icon name="sliders" size={14} /></button>
          {onFocusModeChange ? (
            <button
              className="wf-btn wf-btn-icon"
              title={t(focusMode ? 'workspace.showChat' : 'workspace.focusMode')}
              aria-label={t(focusMode ? 'workspace.showChat' : 'workspace.focusMode')}
              aria-pressed={focusMode}
              data-testid="workflow-focus-toggle"
              onClick={() => onFocusModeChange(!focusMode)}
            >
              <Icon name={focusMode ? 'minimize' : 'maximize'} size={14} />
            </button>
          ) : null}
          <button className="wf-btn wf-btn-icon" title={t('workflow.board')} aria-label={t('workflow.board')} onClick={() => navigate({ kind: 'home', view: 'workflows', ...(projectId ? { workflowProjectId: projectId } : {}), ...(runSummary?.runId ? { workflowRunId: runSummary.runId } : {}) })}><Icon name="gauge" size={14} /></button>
          <div className="wf-add" ref={addMenuRef}>
            <button
              type="button"
              className="wf-btn"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Icon name="plus" size={12} />
              {t('workflow.addNode')}
            </button>
            {addMenuOpen ? (
              <div className="wf-add-menu" role="menu">
                {ADD_MENU_TYPES.filter((type) => (WORKFLOW_NODE_TYPES as readonly string[]).includes(type)).map(
                  (type) => {
                    const meta = typeMeta(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        role="menuitem"
                        className="wf-add-item"
                        onClick={() => addNode(type)}
                      >
                        <span className="wf-add-icon" style={{ ['--wf-node-accent' as string]: meta.accent }}>
                          <Icon name={meta.icon} size={13} />
                        </span>
                        <span className="wf-add-text">
                          <span className="wf-add-title">{t(meta.titleKey as never)}</span>
                          <span className="wf-add-type">{type}</span>
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="wf-btn wf-btn-icon"
            title={t('workflow.autoLayout')}
            aria-label={t('workflow.autoLayout')}
            onClick={applyAutoLayout}
            disabled={state.definition.nodes.length === 0}
          >
            <Icon name="layout" size={13} />
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-icon"
            title={t('workflow.undo')}
            aria-label={t('workflow.undo')}
            onClick={undo}
            disabled={!canUndo}
          >
            <Icon name="arrow-left" size={13} />
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-icon wf-btn-redo"
            title={t('workflow.redo')}
            aria-label={t('workflow.redo')}
            onClick={redo}
            disabled={!canRedo}
          >
            <Icon name="arrow-left" size={13} />
          </button>
          <span
            className={`wf-save-status${dirty ? ' is-dirty' : ''}`}
            title={saveError ?? undefined}
          >
            {saveError ?? statusLabel}
          </span>
          <button
            type="button"
            className="wf-btn"
            onClick={() => void performSave()}
            disabled={saving || !dirty || incomingText !== null || !!state.parseError || Object.keys(invalidNodeDrafts).length > 0}
          >
            {t('workflow.saveNow')}
          </button>
          <button
            type="button"
            className="wf-btn"
            onClick={() => void handleValidate()}
            disabled={runBusy || state.definition.nodes.length === 0 || !!state.parseError}
          >
            {runPhase === 'validating' ? t('workflow.validating') : t('workflow.validate')}
          </button>
          <div className="wf-runs-picker">
            <button
              type="button"
              className="wf-btn"
              title={t('workflow.attachRun')}
              onClick={toggleRecentRuns}
            >
              <Icon name="clock" size={12} />
              {t('workflow.attachRun')}
            </button>
            {recentRunsOpen ? (
              <div className="wf-runs-menu" data-testid="workflow-runs-menu">
                {recentRunsError ? (
                  <div className="wf-runs-menu-empty">{recentRunsError}</div>
                ) : recentRuns === null ? (
                  <div className="wf-runs-menu-empty">…</div>
                ) : recentRuns.length === 0 ? (
                  <div className="wf-runs-menu-empty">{t('workflow.attachRunEmpty')}</div>
                ) : (
                  recentRuns.slice(0, 15).map((row) => (
                    <button
                      key={row.runId}
                      type="button"
                      className="wf-runs-menu-item"
                      onClick={() => attachRun(row.runId)}
                    >
                      <span className={`wf-run-badge is-${row.status.toLowerCase()}`}>
                        {row.status}
                      </span>
                      <span className="wf-runs-menu-ref">
                        {row.workflowRef ?? row.runId}
                      </span>
                      <code className="wf-runs-menu-id">{row.runId.slice(0, 12)}…</code>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={() => setRunSetupOpen((open) => !open)}
            disabled={runBusy || state.definition.nodes.length === 0 || incomingText !== null || !!state.parseError || invalidDraft}
          >
            <Icon name="play" size={12} />
            {runPhase === 'publishing'
              ? t('workflow.publishing')
              : runPhase === 'running' || runPhase === 'polling'
                ? t('workflow.running')
                : t('workflow.run')}
          </button>
        </div>
      </div>
      {invalidDraft ? <p className="wf-run-error" role="alert">{t('workflow.invalidDraft', { names: invalidFields.join(', ') })}</p> : null}
      {runSetupOpen ? <WorkflowRunParameters definition={state.definition} busy={runBusy || saving || incomingText !== null || !!state.parseError || invalidDraft} onRun={(parameters) => void handlePublishAndRun(parameters)} onCancel={() => setRunSetupOpen(false)} /> : null}
      {incomingText !== null ? (
        <section className="wf-conflict" role="alert" data-testid="workflow-conflict">
          <strong>{t('workflow.conflict')}</strong>
          <details>
            <summary>{t('workflow.localVersion')} / {t('workflow.remoteVersion')}</summary>
            <div className="wf-conflict-diff">
              <div><b>{t('workflow.localVersion')}</b><pre>{serializeEditorState(state)}</pre></div>
              <div><b>{t('workflow.remoteVersion')}</b><pre>{incomingText}</pre></div>
            </div>
          </details>
          <div className="wf-conflict-actions">
            <button className="wf-btn" disabled={saving || Object.keys(invalidNodeDrafts).length > 0} onClick={() => resolveIncoming('merge')}>{t('workflow.merge')}</button>
            <button className="wf-btn" disabled={saving} onClick={() => resolveIncoming('remote')}>{t('workflow.useRemote')}</button>
            <button className="wf-btn" disabled={saving || Object.keys(invalidNodeDrafts).length > 0} onClick={() => resolveIncoming('local')}>{t('workflow.keepLocal')}</button>
          </div>
        </section>
      ) : null}
      {runError || runPollError || (validation && !runSummary) ? (
        <div className="wf-run-strip" data-testid="workflow-run-strip">
          {runError ? <div className="wf-run-error">{runError}</div> : null}
          {runPollError ? <div className="wf-run-error" role="alert">{runPollError}</div> : null}
          {validation && !validation.ok ? (
            <div className="wf-run-invalid">
              <span className="wf-run-badge is-invalid">{t('workflow.invalid')}</span>
              {(validation.errors.length > 0
                ? validation.errors
                : validation.diagnostics
              )
                .slice(0, 6)
                .map((entry, index) => (
                  <span key={`${entry.code}:${index}`} className="wf-run-diagnostic">
                    {entry.message}
                  </span>
                ))}
            </div>
          ) : null}
          {validation && validation.ok && !runSummary ? (
            <div className="wf-run-ok">
              <span className="wf-run-badge is-ok">{t('workflow.valid')}</span>
              {typeof validation.nodeCount === 'number' ? (
                <span className="wf-run-meta">{validation.nodeCount} nodes</span>
              ) : null}
              {validation.risk ? <span className="wf-run-meta">{validation.risk} risk</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {state.parseError ? (
        <div className="wf-parse-error">{t('workflow.parseError')}: {state.parseError}</div>
      ) : null}
      <div className="wf-body">
        <div className="wf-view-tabs" role="tablist">
          {(['graph', 'steps'] as const).map((view) => <button key={view} className="wf-btn" role="tab" aria-selected={canvasView === view} onClick={() => setCanvasView(view)}><Icon name={view === 'graph' ? 'workflow' : 'kanban'} size={13} />{t(`workflow.${view}`)}</button>)}
        </div>
        {canvasView === 'steps' ? <div className="wf-step-list">{flowNodes.map((node, index) => <button className={`wf-step-row${selectedNodeId === node.id ? ' is-selected' : ''}`} key={node.id} onClick={() => { setSelectedNodeId(node.id); setSettingsOpen(false); }}><span>{String(index + 1).padStart(2, '0')}</span><Icon name={typeMeta(node.data.record.type).icon} size={16} /><b>{String(node.data.record.label ?? node.id)}</b><small>{node.data.record.type}</small><Icon name="chevron-right" size={14} /></button>)}</div> : null}
        {canvasView === 'graph' ? <div className="wf-canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={WORKFLOW_CANVAS_NODE_TYPES}
            onNodesChange={handleNodesChange}
            onNodeClick={() => setSettingsOpen(false)}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            snapToGrid
            snapGrid={[12, 12]}
            zoomOnDoubleClick={false}
            minZoom={0.2}
            maxZoom={2}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => {
                const data = node.data as WorkflowCanvasNode['data'] | undefined;
                return data?.accent ?? 'var(--border, #444)';
              }}
            />
            <Controls showInteractive={false} />
          </ReactFlow>
          {state.definition.nodes.length === 0 ? (
            <div className="wf-empty-hint">
              <span>{t('workflow.emptyHint')}</span>
              <div className="wf-empty-actions">
                <button type="button" className="wf-btn" onClick={() => addNode('agent')}>
                  <Icon name="sparkles" size={12} />
                  {t('workflow.typeTitle.agent')}
                </button>
                <button type="button" className="wf-btn" onClick={() => addNode('exec')}>
                  <Icon name="terminal" size={12} />
                  {t('workflow.typeTitle.exec')}
                </button>
              </div>
            </div>
          ) : null}
        </div> : null}
        {settingsOpen ? <div className="wf-inspector" data-testid="workflow-settings">
          <div className="wf-inspector-head"><b>{t('workflow.settings')}</b><button className="wf-btn wf-btn-icon" aria-label={t('workflow.close')} onClick={() => setSettingsOpen(false)}><Icon name="close" size={14} /></button></div>
          <WorkflowSettings key={documentRevision} definition={state.definition} onChange={(patch) => mutate((current) => ({ ...current, definition: { ...current.definition, ...patch } }))} />
        </div> : null}
        {selectedNode && !settingsOpen ? (
          <div key={`${selectedNode.id}:${documentRevision}`} className="wf-inspector" data-testid="workflow-inspector">
            <div className="wf-inspector-head">
              <span
                className="wf-inspector-icon"
                style={{ ['--wf-node-accent' as string]: accentFor(selectedNode) }}
              >
                <Icon name={typeMeta(selectedNode.type).icon} size={14} />
              </span>
              <div className="wf-inspector-title">{t(typeMeta(selectedNode.type).titleKey as never)}</div>
              <button type="button" className="wf-btn wf-btn-icon" title={t('workflow.close')} aria-label={t('workflow.close')} onClick={() => setSelectedNodeId(null)}><Icon name="close" size={14} /></button>
              <button
                type="button"
                className="wf-btn wf-btn-icon"
                title={t('workflow.duplicateNode')}
                aria-label={t('workflow.duplicateNode')}
                onClick={duplicateSelectedNode}
              >
                <Icon name="copy" size={13} />
              </button>
            </div>
            {isKnownNodeType(selectedNode.type) ? (
              <p className="wf-inspector-desc">
                {t(`workflow.typeDesc.${selectedNode.type}` as never)}
              </p>
            ) : null}
            <div className="wf-inspector-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'config'}
                className={`wf-inspector-tab${inspectorTab === 'config' ? ' is-active' : ''}`}
                onClick={() => setInspectorTab('config')}
              >
                <Icon name="sliders" size={11} /> {t('workflow.tabConfig')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'json'}
                className={`wf-inspector-tab${inspectorTab === 'json' ? ' is-active' : ''}`}
                onClick={() => setInspectorTab('json')}
              >
                <Icon name="braces" size={11} /> {t('workflow.tabJson')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'run'}
                className={`wf-inspector-tab${inspectorTab === 'run' ? ' is-active' : ''}`}
                onClick={() => setInspectorTab('run')}
              >
                <Icon name="play" size={11} /> {t('workflow.tabRun')}
                {runNodeMap.get(selectedNode.id) ? (
                  <span
                    className={`wf-inspector-tab-dot is-${runNodeMap
                      .get(selectedNode.id)!
                      .status.toLowerCase()}`}
                  />
                ) : null}
              </button>
            </div>
            {inspectorTab === 'json' ? (
              <div className="wf-node-json">
                <p className="wf-inspector-hint">{t('workflow.jsonHint')}</p>
                <textarea
                  key={`json:${selectedNode.id}:${historyVersion}`}
                  className="wf-node-json-editor"
                  rows={22}
                  spellCheck={false}
                  defaultValue={invalidNodeDrafts[selectedNode.id]?.text ?? JSON.stringify(selectedNode, null, 2)}
                  onBlur={(event) => applySelectedNodeJson(event.target.value)}
                />
                {nodeJsonError ? (
                  <p className="wf-node-run-error-text">
                    {t('workflow.jsonInvalid', { message: nodeJsonError })}
                  </p>
                ) : null}
              </div>
            ) : null}
            {inspectorTab === 'run' ? (
              <WorkflowNodeRunTab
                projectId={projectId}
                // Remount on node/run switch: without this the previous
                // node's fetched detail stays on screen until the new
                // request lands, attributing stale output to the new node.
                key={`${runSummary?.runId ?? 'none'}:${selectedNode.id}`}
                runId={runSummary?.runId ?? null}
                nodeId={selectedNode.id}
                liveNode={runNodeMap.get(selectedNode.id) ?? null}
              />
            ) : null}
            {inspectorTab === 'config' ? (
              <>
            {isKnownNodeType(selectedNode.type) ? (
              <InspectorSection
                icon={typeMeta(selectedNode.type).icon}
                label={t('workflow.sectionBehavior')}
              />
            ) : null}
            {selectedNode.type === 'agent' || selectedNode.type === 'dynamic' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.roleRef')}</span>
                  {roleOptions.length > 0 && roleInOptions ? (
                    <select
                      value={roleValue}
                      onChange={(event) => updateSelectedNode({ role: event.target.value || undefined })}
                    >
                      <option value="">—</option>
                      {roleOptions.map((role) => (
                        <option key={role} value={role}>{role.replace(/^role:/, '')}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      key={`role:${selectedNode.id}`}
                      defaultValue={roleValue}
                      list="wf-role-options"
                      placeholder="role:compute"
                      onBlur={(event) => updateSelectedNode({ role: event.target.value || undefined })}
                    />
                  )}
                  <datalist id="wf-role-options">
                    {roleOptions.map((role) => (
                      <option key={role} value={role} />
                    ))}
                  </datalist>
                </label>
                {roleValue ? <RoleMountsPanel roleRef={roleValue} /> : null}
                <label className="wf-field">
                  <span>{t('workflow.prompt')}</span>
                  <textarea
                    key={`prompt:${selectedNode.id}`}
                    rows={6}
                    defaultValue={typeof selectedNode.prompt === 'string' ? selectedNode.prompt : ''}
                    onBlur={(event) => updateSelectedNode({ prompt: event.target.value })}
                  />
                </label>
              </>
            ) : null}
            {selectedNode.type === 'compute' || selectedNode.type === 'backend' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.backendField')}</span>
                  <input
                    key={`backend:${selectedNode.id}`}
                    defaultValue={typeof selectedNode.backend === 'string' ? selectedNode.backend : ''}
                    placeholder="local"
                    onBlur={(event) => updateSelectedNode({ backend: event.target.value || undefined })}
                  />
                </label>
                <label className="wf-field">
                  <span>{t('workflow.operation')}</span>
                  <input
                    key={`operation:${selectedNode.id}`}
                    defaultValue={typeof selectedNode.operation === 'string' ? selectedNode.operation : ''}
                    onBlur={(event) => updateSelectedNode({ operation: event.target.value || undefined })}
                  />
                </label>
              </>
            ) : null}
            {selectedNode.type === 'exec' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.command')}</span>
                  <textarea
                    key={`command:${selectedNode.id}`}
                    rows={6}
                    defaultValue={typeof selectedNode.command === 'string' ? selectedNode.command : ''}
                    onBlur={(event) => updateSelectedNode({ command: event.target.value })}
                  />
                </label>
                <label className="wf-field">
                  <span>{t('workflow.cwd')}</span>
                  <input
                    key={`cwd:${selectedNode.id}`}
                    defaultValue={typeof selectedNode.cwd === 'string' ? selectedNode.cwd : ''}
                    onBlur={(event) => updateSelectedNode({ cwd: event.target.value || undefined })}
                  />
                </label>
                <label className="wf-field">
                  <span>{t('workflow.timeoutMs')}</span>
                  <input
                    key={`timeout:${selectedNode.id}`}
                    type="number"
                    min={0}
                    defaultValue={typeof selectedNode.timeoutMs === 'number' ? selectedNode.timeoutMs : ''}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      updateSelectedNode({
                        timeoutMs: Number.isFinite(value) && value > 0 ? value : undefined,
                      });
                    }}
                  />
                </label>
                <ExecArgsEnvFields node={selectedNode} onPatch={updateSelectedNode} />
              </>
            ) : null}
            {selectedNode.type === 'validate' || selectedNode.type === 'guard' ? (
              <WorkflowChecks node={selectedNode} onChange={(checks) => updateSelectedNode({ checks })} />
            ) : null}
            {selectedNode.type === 'human' || selectedNode.type === 'approval_gate' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.prompt')}</span>
                  <textarea
                    key={`prompt:${selectedNode.id}`}
                    rows={5}
                    defaultValue={typeof selectedNode.prompt === 'string' ? selectedNode.prompt : ''}
                    onBlur={(event) => updateSelectedNode({ prompt: event.target.value })}
                  />
                </label>
                {selectedNode.responseSchema ? (
                  <p className="wf-inspector-hint">
                    <Icon name="braces" size={11} /> {t('workflow.hasResponseSchema')}
                  </p>
                ) : null}
              </>
            ) : null}
            {selectedNode.type === 'subworkflow' || selectedNode.type === 'map' || selectedNode.type === 'loop' ? (
              <label className="wf-field">
                <span>{t('workflow.subworkflowRef')}</span>
                <input
                  key={`workflow:${selectedNode.id}`}
                  defaultValue={typeof selectedNode.workflow === 'string' ? selectedNode.workflow : ''}
                  placeholder="workflow:my-workflow"
                  onBlur={(event) => updateSelectedNode({ workflow: event.target.value || undefined })}
                />
              </label>
            ) : null}
            {selectedNode.type === 'map' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.itemsExpr')}</span>
                  <input
                    key={`items:${selectedNode.id}`}
                    defaultValue={typeof selectedNode.items === 'string' ? selectedNode.items : ''}
                    placeholder="{{parameters.samples}}"
                    onBlur={(event) => updateSelectedNode({ items: event.target.value || undefined })}
                  />
                </label>
                <label className="wf-field">
                  <span>{t('workflow.maxParallel')}</span>
                  <input
                    key={`maxParallel:${selectedNode.id}`}
                    type="number"
                    min={1}
                    defaultValue={typeof selectedNode.maxParallel === 'number' ? selectedNode.maxParallel : ''}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      updateSelectedNode({
                        maxParallel: Number.isFinite(value) && value > 0 ? value : undefined,
                      });
                    }}
                  />
                </label>
              </>
            ) : null}
            {selectedNode.type === 'loop' ? (
              <>
                <label className="wf-field">
                  <span>{t('workflow.maxIterations')}</span>
                  <input
                    key={`maxIterations:${selectedNode.id}`}
                    type="number"
                    min={1}
                    defaultValue={
                      typeof selectedNode.maxIterations === 'number' ? selectedNode.maxIterations : ''
                    }
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      updateSelectedNode({
                        maxIterations: Number.isFinite(value) && value > 0 ? value : undefined,
                      });
                    }}
                  />
                </label>
                <label className="wf-field">
                  <span>{t('workflow.untilCond')}</span>
                  <input
                    key={`until:${selectedNode.id}`}
                    defaultValue={typeof selectedNode.until === 'string' ? selectedNode.until : ''}
                    onBlur={(event) => updateSelectedNode({ until: event.target.value || undefined })}
                  />
                </label>
              </>
            ) : null}
            {['compute', 'backend', 'subworkflow', 'map', 'loop'].includes(selectedNode.type) ? <>
              <InspectorSection icon="variable" label={t('workflow.inputs')} />
              <WorkflowBindings values={(selectedNode.type === 'compute' || selectedNode.type === 'backend' ? selectedNode.input ?? selectedNode.toolInput ?? selectedNode.inputs : selectedNode.parameters) as Record<string, unknown> ?? {}} definition={applyCanvasEdgesToDefinition(state.definition, state.edges)} nodeId={selectedNode.id} onChange={(value) => updateSelectedNode({ [selectedNode.type === 'compute' || selectedNode.type === 'backend' ? 'input' : 'parameters']: value })} />
            </> : null}
            <details className="wf-advanced"><summary>{t('workflow.advanced')}</summary>
            <InspectorSection icon="info" label={t('workflow.sectionIdentity')} />
            <label className="wf-field">
              <span>{t('workflow.label')}</span>
              <input
                key={`label:${selectedNode.id}`}
                defaultValue={typeof selectedNode.label === 'string' ? selectedNode.label : ''}
                placeholder={selectedNode.id}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  updateSelectedNode({ label: value && value !== selectedNode.id ? value : undefined });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
              />
            </label>
            <label className="wf-field">
              <span>{t('workflow.nodeId')}</span>
              <input
                key={`id:${selectedNode.id}`}
                defaultValue={selectedNode.id}
                onBlur={(event) => renameSelectedNode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
              />
            </label>
            <label className="wf-field">
              <span>{t('workflow.nodeType')}</span>
              <select
                value={selectedNode.type}
                onChange={(event) => updateSelectedNode({ type: event.target.value })}
              >
                {WORKFLOW_NODE_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
                {!WORKFLOW_NODE_TYPES.includes(selectedNode.type as never) ? (
                  <option value={selectedNode.type}>{selectedNode.type}</option>
                ) : null}
              </select>
            </label>
            <label className="wf-field">
              <span>{t('workflow.description')}</span>
              <input
                key={`desc:${selectedNode.id}`}
                defaultValue={typeof selectedNode.description === 'string' ? selectedNode.description : ''}
                onBlur={(event) => updateSelectedNode({ description: event.target.value || undefined })}
              />
            </label>
            <InspectorSection icon="draw" label={t('workflow.sectionAppearance')} />
            <div className="wf-field">
              <span>{t('workflow.color')}</span>
              <div className="wf-color-row">
                <button
                  type="button"
                  className={`wf-color-auto${selectedAccent ? '' : ' is-active'}`}
                  title={t('workflow.colorAuto')}
                  onClick={() => setSelectedNodeAccent(null)}
                >
                  {t('workflow.colorAuto')}
                </button>
                {ACCENT_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`wf-color-swatch${selectedAccent === color ? ' is-active' : ''}`}
                    style={{ background: color }}
                    aria-label={color}
                    onClick={() => setSelectedNodeAccent(color)}
                  />
                ))}
                <input
                  type="color"
                  className="wf-color-custom"
                  value={selectedAccent ?? '#888888'}
                  title={t('workflow.color')}
                  onChange={(event) => setSelectedNodeAccent(event.target.value)}
                />
              </div>
            </div>
            </details>
            <InspectorSection icon="link" label={t('workflow.sectionConnections')} />
            <div className="wf-field">
              <span>
                <Icon name="arrow-left" size={11} /> {t('workflow.dependsOn')}
              </span>
              <div className="wf-depends">
                {state.edges.filter((edge) => edge.to === selectedNode.id).length === 0 ? (
                  <span className="wf-depends__none">{t('workflow.noConnections')}</span>
                ) : (
                  state.edges
                    .filter((edge) => edge.to === selectedNode.id)
                    .map((edge) => <code key={workflowCanvasEdgeKey(edge)}>{edge.from}</code>)
                )}
              </div>
            </div>
            <div className="wf-field">
              <span>
                <Icon name="arrow-up" size={11} /> {t('workflow.outgoingField')}
              </span>
              <div className="wf-depends">
                {state.edges.filter((edge) => edge.from === selectedNode.id).length === 0 ? (
                  <span className="wf-depends__none">{t('workflow.noConnections')}</span>
                ) : (
                  state.edges
                    .filter((edge) => edge.from === selectedNode.id)
                    .map((edge) => <code key={workflowCanvasEdgeKey(edge)}>{edge.to}</code>)
                )}
              </div>
            </div>
            <button type="button" className="wf-btn wf-btn-danger" onClick={deleteSelectedNode}>
              <Icon name="trash" size={12} /> {t('workflow.deleteNode')}
            </button>
              </>
            ) : null}
          </div>
        ) : selectedEdge ? (
          <div className="wf-inspector" data-testid="workflow-edge-inspector">
            <div className="wf-inspector-head">
              <span className="wf-inspector-icon">
                <Icon name="fork" size={14} />
              </span>
              <div className="wf-inspector-title">{t('workflow.edgeTitle')}</div>
            </div>
            <p className="wf-inspector-desc">{t('workflow.edgeDesc')}</p>
            <div className="wf-field">
              <span>{t('workflow.dependsOn')}</span>
              <div className="wf-depends">
                <code>{selectedEdge.from}</code>
                <span className="wf-edge-arrow">→</span>
                <code>{selectedEdge.to}</code>
              </div>
            </div>
            <label className="wf-field">
              <span>{t('workflow.edgeRoute')}</span>
              <select
                value={selectedEdge.record?.route ?? ''}
                onChange={(event) => updateSelectedEdge({ route: event.target.value })}
              >
                <option value="">{t('workflow.routeAlways')}</option>
                <option value="success">{t('workflow.routeSuccess')}</option>
                <option value="failure">{t('workflow.routeFailure')}</option>
              </select>
            </label>
            <label className="wf-field">
              <span>{t('workflow.edgeCondition')}</span>
              <input
                key={selectedEdgeId ?? 'edge'}
                defaultValue={selectedEdge.record?.condition ? String(selectedEdge.record.condition) : ''}
                placeholder={t('workflow.edgeConditionHint')}
                onBlur={(event) => updateSelectedEdge({ condition: event.target.value })}
              />
            </label>
            <button type="button" className="wf-btn wf-btn-danger" onClick={deleteSelectedEdge}>
              <Icon name="trash" size={12} /> {t('workflow.deleteEdge')}
            </button>
          </div>
        ) : null}
      </div>
      {runSummary ? (
        <WorkflowRunPanel
          run={runSummary}
          events={runEvents}
          busyAction={controlBusy}
          onControl={handleRunControl}
          onSelectNode={focusRunNode}
          onClose={dismissRun}
        />
      ) : null}
    </div>
  );
}
