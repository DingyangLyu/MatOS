export interface RunContextSelection {
  skillIds?: string[];
  mcpServerIds?: string[];
  workspaceItems?: WorkspaceContextItem[];
}

export type WorkspaceContextKind =
  | 'design-files'
  | 'file'
  | 'folder'
  | 'project'
  | 'local-code'
  | 'browser'
  | 'terminal'
  | 'side-chat';

export interface WorkspaceContextItem {
  id: string;
  kind: WorkspaceContextKind;
  label: string;
  tabId?: string;
  path?: string;
  absolutePath?: string;
  url?: string;
  title?: string;
}

export interface ProjectContextMcpServerRef {
  id: string;
  label?: string;
  transport?: string;
  url?: string;
  command?: string;
}
