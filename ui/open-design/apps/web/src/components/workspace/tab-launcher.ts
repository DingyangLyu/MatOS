import type { IconName } from '../Icon';
import type { Dict } from '../../i18n/types';

// ---------------------------------------------------------------------------
// Extensible workspace "+" launcher registry.
//
// The launcher dropdown anchored to the tab strip's "+" button is the single
// place where new *kinds* of working surfaces are created. Opening an existing
// file is built into the menu directly (it is the common case and needs the
// project file list), but every other "create a new tab" affordance —
// Terminal (Stage 3) and the external Browser worktree — registers exactly ONE
// LauncherAction here. Adding a tab kind is therefore a two-line change:
// register an action below, and add a render branch in the `.ws-body` switch
// of `FileWorkspace.tsx`.
//
// Keep this module tiny and dependency-light. It owns *what can be created*,
// not *how it is rendered* — the dropdown (`TabLauncherMenu.tsx`) renders the
// actions and the file results; `FileWorkspace.tsx` supplies the context.
// ---------------------------------------------------------------------------

/** Everything an action needs to spin up (and focus) a new workspace tab. */
export interface LauncherContext {
  /** The project the workspace is currently scoped to. */
  projectId: string;
  /**
   * Focus an already-open or freshly-created tab by id. Most "create new"
   * actions will create their backing resource first (a conversation, a PTY
   * session, …) and then call this with the resulting `chat:<id>` /
   * `terminal:<id>` tab id.
   */
  openTab: (tabId: string) => void;
  /**
   * Spawn a new PTY session for the project and resolve its terminal id. Backs
   * the "New Terminal" action. Returns null when the daemon could not start the
   * session (e.g. node-pty not compiled), so the action no-ops.
   */
  createTerminal?: () => Promise<string | null>;
  /** Create a new MatOS workflow definition in the current Design Files directory. */
  createWorkflow?: () => void;
  /**
   * Open a MatterViz materials-visualization tab. Synchronous — the viewer tab
   * needs no daemon round-trip and picks its structure file in-tab — so it
   * returns void and creates/focuses the tab itself.
   */
  createMaterialsViewer?: () => void;
  /** Create a new Markdown document in the current Design Files directory. */
  createDocument?: () => void;
  /** Open the Design Files upload picker. */
  uploadDesignFiles?: () => void;
}

export interface LauncherAction {
  /** Stable id, also used as the React key in the menu. */
  id: string;
  /** Icon shown to the left of the label; any name from the shared icon set. */
  iconName: IconName;
  /** i18n key for the action label (e.g. workspace.newTerminal). */
  labelKey: keyof Dict;
  /** Optional i18n key for a secondary description line. */
  descriptionKey?: keyof Dict;
  /** Invoked when the user picks the action; the menu closes afterwards. */
  run: (ctx: LauncherContext) => void;
}

// MatOS ships the in-browser project terminal: it gives gateway users a
// lightweight CLI surface (including on mobile) without opening the full
// OpenVSCode workspace. The PTY runs in the per-user daemon, so scope
// isolation matches every other project surface.
const ENABLE_TERMINAL_WORKSPACE_ENTRYPOINT = true;

/**
 * Build the list of "create new" actions for the current context.
 *
 * Each tab kind contributes exactly one action. Stage 3 adds "New Terminal":
 * it spawns a PTY session and opens it as a `terminal:<id>` tab.
 */
export function buildLauncherActions(ctx: LauncherContext): LauncherAction[] {
  const actions: LauncherAction[] = [];
  if (ENABLE_TERMINAL_WORKSPACE_ENTRYPOINT && ctx.createTerminal) {
    actions.push({
      id: 'new-terminal',
      iconName: 'terminal',
      labelKey: 'workspace.newTerminal',
      descriptionKey: 'workspace.newTerminalDescription',
      run: (runCtx) => {
        void runCtx.createTerminal?.().then((terminalId) => {
          if (terminalId) runCtx.openTab(`terminal:${terminalId}`);
        });
      },
    });
  }
  if (ctx.createWorkflow) {
    actions.push({
      id: 'new-workflow',
      iconName: 'fork',
      labelKey: 'designFiles.newWorkflow',
      descriptionKey: 'workspace.newWorkflowDescription',
      run: (runCtx) => {
        runCtx.createWorkflow?.();
      },
    });
  }
  if (ctx.createMaterialsViewer) {
    actions.push({
      id: 'new-materials-viewer',
      iconName: 'atom',
      labelKey: 'workspace.newMaterialsViewer',
      descriptionKey: 'workspace.newMaterialsViewerDescription',
      run: (runCtx) => {
        runCtx.createMaterialsViewer?.();
      },
    });
  }
  if (ctx.createDocument) {
    actions.push({
      id: 'create-document',
      iconName: 'file',
      labelKey: 'designFiles.paste.label',
      descriptionKey: 'designFiles.paste.title',
      run: (runCtx) => {
        runCtx.createDocument?.();
      },
    });
  }
  if (ctx.uploadDesignFiles) {
    actions.push({
      id: 'upload-design-files',
      iconName: 'upload',
      labelKey: 'designFiles.upload.label',
      descriptionKey: 'designFiles.upload.title',
      run: (runCtx) => {
        runCtx.uploadDesignFiles?.();
      },
    });
  }
  return actions;
}
