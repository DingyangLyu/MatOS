export interface MatOSWorkflowPreview {
  ref: string;
  canonicalKey?: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{ from: string; to: string }>;
}

export interface WorkflowValidationDiagnostic {
  severity: string;
  code: string;
  message: string;
  nodeId: string | null;
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: Array<{ code: string; message: string }>;
  diagnostics: WorkflowValidationDiagnostic[];
  workflowRef: string | null;
  nodeCount: number | null;
  risk: string | null;
}

export interface WorkflowRunNodeSummary {
  nodeId: string;
  status: string;
  attempts: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface WorkflowRunBudgetSummary {
  totalTokens: number | null;
  totalCostUsd: number | null;
  wallTimeMs: number | null;
  elapsedWallTimeMs: number | null;
  agentCalls: number | null;
  toolCalls: number | null;
}

export interface WorkflowRunApprovalSummary {
  nodeId: string;
  status: string;
  fingerprint: string | null;
  requestedAt: string | null;
}

export interface WorkflowRunSummary {
  runId: string | null;
  status: string | null;
  waitingNodeId: string | null;
  nodes: WorkflowRunNodeSummary[];
  activeNodeIds: string[];
  pendingApprovals: WorkflowRunApprovalSummary[];
  budget: WorkflowRunBudgetSummary | null;
  outputs: Record<string, unknown> | null;
  detached?: boolean;
  workflowRef?: string | null;
  workflowName?: string | null;
  graph?: WorkflowRunGraph;
}

export interface WorkflowRunEventSummary {
  id: string | null;
  timestamp: string | null;
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
}

export interface WorkflowRunNodeDetail {
  nodeId: string;
  status: string;
  attempts: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  output: unknown;
  error: unknown;
}

export interface WorkflowPublishSummary {
  assetKey: string | null;
  workflowRef: string | null;
}

export interface WorkflowForkSummary {
  draftId: string;
  definition: Record<string, unknown>;
}

export interface WorkflowRunListRow {
  runId: string;
  workflowRef: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  waitingNodeId: string | null;
}

export interface WorkflowRunGraph {
  nodes: Array<{ id: string; label?: string; type: string; dependsOn: string[] }>;
  edges: Array<{ from: string; to: string; route?: string; condition?: string }>;
}

export interface WorkflowPreflight {
  runnable: boolean;
  issues: Array<{ code: string; severity: string; message: string; nodeId?: string }>;
}

export type WorkflowControlAction =
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'retry-node'
  | 'skip-node'
  | 'approve'
  | 'deny'
  | 'respond';
