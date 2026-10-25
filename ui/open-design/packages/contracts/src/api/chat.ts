import type { ProjectFile } from './files';
import type { RunWorkspace } from './workspaces.js';
import type {
  PreviewCommentAttachment,
  PreviewCommentMember,
  PreviewCommentPosition,
  PreviewCommentSelectionKind,
  PreviewAnnotationStyle,
  PreviewVisualMarkKind,
} from './comments';
import type { ResearchOptions } from './research';
import type { RunContextSelection } from './context.js';
import type { McpAuthMode, McpServerConfig, McpTransport } from './mcp';

// 'system' rows are daemon-posted operational notices (e.g. group dispatch
// feedback) and native-timeline system events; they render as inline notices
// and never enter agent transcripts.
export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatSessionMode = 'design' | 'chat' | 'plan';
export type ChatCommentSelectionKind = PreviewCommentSelectionKind | 'visual';
export interface ChatRequest {
  agentId: string;
  message: string;
  /** The latest user turn only, used to build the per-turn prompt. */
  currentPrompt?: string;
  systemPrompt?: string;
  projectId?: string | null;
  conversationId?: string | null;
  sessionMode?: ChatSessionMode;
  /**
   * User message that causally owns this run. This is the ordering authority
   * for the assistant placeholder; client and daemon wall clocks may drift.
   */
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  clientRequestId?: string | null;
  skillId?: string | null;
  // Per-turn skill ids picked via the composer's @-mention popover. The
  // daemon concatenates each skill's body into the system prompt for
  // this run only — they are NOT persisted on the project. Use this to
  // assemble multiple capabilities (e.g. @web-search + @summarize) for
  // a single turn without binding the project to one of them.
  skillIds?: string[];
  attachments?: string[];
  commentAttachments?: ChatCommentAttachment[];
  model?: string | null;
  /**
   * Provider LLM override for runtimes whose `model` channel carries a
   * different concept (MatOS uses `model` for the role ref). Travels to the
   * CLI as `--model <id>`; omitted/null keeps the deployment default.
   */
  providerModel?: string | null;
  /** Scoped native MatOS identity selections for this project/run. Display
   * versions from older clients follow the accepted version. Per-run selections
   * use additionalAssetRefs or native CLI --asset; project-wide pins use native
   * assetVersionPolicy. */
  assetRefs?: string[];
  /** Explicit per-turn MatOS selections, distinct from legacy project assetRefs.
   * Project attachments are always resolved by native MatOS at run start. */
  additionalAssetRefs?: string[];
  reasoning?: string | null;
  /** UI locale selected by the client, used by prompt composition for user-visible generated UI. */
  locale?: string;
  research?: ResearchOptions;
  context?: RunContextSelection;
  /**
   * Ask the selected run agent to emit a short title for this first turn.
   * The daemon strips the title marker from visible assistant text and falls
   * back to client-side naming when the marker is absent or malformed.
   */
  titleGeneration?: {
    enabled?: boolean;
  };
  /**
   * Run-scoped tool bundle supplied by an external orchestrator.
   * These servers are made available only to the spawned agent for this run
   * and are never written into the persistent Settings MCP registry.
   */
  toolBundle?: RunScopedToolBundle;
}

export interface RunScopedMcpServerConfig extends Omit<McpServerConfig, 'enabled'> {
  /**
   * Omitted means enabled for this run. The daemon normalizes run-scoped
   * inputs through the same sanitizer as persisted MCP config, but callers
   * should not need to send persisted-settings boilerplate for disposable
   * tool bundles.
   */
  enabled?: boolean;
}

export interface RunScopedToolBundle {
  mcpServers?: RunScopedMcpServerConfig[];
}

export interface RunScopedToolBundleSummary {
  mcpServers: Array<{
    id: string;
    label?: string;
    templateId?: string;
    transport: McpTransport;
    enabled: boolean;
    authMode?: McpAuthMode;
  }>;
}

export type BrowserUseUnavailableReason = 'no-matching-browser-backend';

export type BrowserUseProbeFailureCategory =
  | 'not-probed'
  | 'registry-missing'
  | 'registry-unreadable';

export interface BrowserUseDiscoveryFacts {
  registryPath: string;
  registryExists: boolean;
  socketCount: number;
  candidateCount: number;
  staleCount: number;
  currentSessionIdPresent: boolean | null;
  probeFailureCategory: BrowserUseProbeFailureCategory;
  newestSocketAgeMs?: number;
  staleThresholdMs: number;
}

export interface BrowserUseRunState {
  requested: boolean;
  available: boolean;
  reason?: BrowserUseUnavailableReason;
  diagnostics: BrowserUseDiscoveryFacts;
}

/**
 * Minimal POST /api/runs shape accepted from MCP / SDK callers that do not
 * manage conversation state client-side. Only `projectId` is required;
 * `message` and `agentId` are optional — the daemon resolves `agentId` from
 * the saved app-config when it is omitted.
 */
export interface McpRunCreateRequest {
  projectId: string;
  message?: string;
  agentId?: string;
  skillId?: string;
  model?: string;
  toolBundle?: RunScopedToolBundle;
}

export const CHAT_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type ChatRunStatus = (typeof CHAT_RUN_STATUSES)[number];

export type ChatMessageFeedbackRating = 'positive' | 'negative';

export type ChatMessageFeedbackReasonCode =
  | 'matched_request'
  | 'strong_visual'
  | 'useful_structure'
  | 'easy_to_continue'
  | 'missed_request'
  | 'weak_visual'
  | 'incomplete_output'
  | 'hard_to_use'
  | 'other';

export interface ChatMessageFeedback {
  rating: ChatMessageFeedbackRating;
  reasonCodes?: ChatMessageFeedbackReasonCode[];
  customReason?: string;
  reasonsSubmittedAt?: number;
  createdAt: number;
  updatedAt?: number;
}

export interface ChatRunCreateResponse {
  runId: string;
  // Daemon-resolved conversation/message ids — populated for MCP /
  // SDK callers that POST /api/runs with only projectId. The web flow
  // normally sends these in already; daemon falls back to the
  // project's default conversation otherwise.
  conversationId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
}

export interface ChatRunStatusResponse {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  userMessageId?: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  status: ChatRunStatus;
  createdAt: number;
  updatedAt: number;
  cancelRequested?: boolean;
  childPid?: number | null;
  processGroupId?: number | null;
  childExited?: boolean;
  childExitObservedAt?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  errorCode?: string | null;
  /** True when this terminal failure can be recovered by resuming the agent's
   *  existing CLI session (a transient upstream drop / inactivity timeout on a
   *  session-resuming runtime), rather than only restarting from scratch. The
   *  chat uses it to offer a Continue affordance; the next turn in the same
   *  conversation resumes the persisted session. Absent/false on success,
   *  non-resumable failures, and runtimes without CLI session resume. */
  resumable?: boolean;
  /** Absolute path to the per-run JSONL event log the daemon mirrors
   *  the SSE stream to (see runs.ts `runsLogDir`). Null when the
   *  daemon was launched without event persistence configured. */
  eventsLogPath?: string | null;
  /** Present on daemon run status responses that know the effective run policy. */
  /** Run-scoped tool bundle summary with secrets and command details redacted. */
  toolBundle?: RunScopedToolBundleSummary;
  /** Prompt cache diagnostics for resume-capable runtime sessions. */
  promptCache?: {
    stablePromptHash: string;
    hit: boolean;
    missReason: 'new-session' | 'missing-stored-hash' | 'stable-prompt-changed' | null;
  };
  /** Browser Use availability for runs that requested in-app browser automation. */
  browserUse?: BrowserUseRunState;
  /** Effective storage/provenance for the workspace used by this run. */
  workspace?: RunWorkspace;
}

export interface ChatRunListResponse {
  runs: ChatRunStatusResponse[];
}

export interface ChatAttachment {
  path: string;
  name: string;
  kind: 'image' | 'file';
  size?: number;
  /**
   * User-visible attachment order for this turn. Older messages may omit it;
   * consumers should fall back to array position.
   */
  order?: number;
}

export interface ChatCommentAttachment {
  id: string;
  order: number;
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  comment: string;
  currentText: string;
  pagePosition: PreviewCommentPosition;
  htmlHint: string;
  style?: PreviewAnnotationStyle;
  selectionKind?: ChatCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  // Zero-based slide the marked element lives on, for deck artifacts. Carried
  // so the host can flip the preview to that slide when the send starts.
  slideIndex?: number;
  screenshotPath?: string;
  markKind?: PreviewVisualMarkKind;
  intent?: string;
  imageAttachments?: PreviewCommentAttachment[];
  /** `'query'` means `comment` was promoted to the message text; keep target data as context only. */
  commentContext?: 'context' | 'query';
  source?: 'saved-comment' | 'board-batch';
}

/**
 * MatOS group-task provenance stamped on messages that the daemon mirrored
 * from a project group chat into a member's DM conversation. A group turn
 * (`@Member: do X` dispatch + that member's finished assistant turn) is
 * copied into the member's DM as a work-ledger pair so the member's own
 * page shows what they were asked to do and what they produced. `source*`
 * fields point back at the originating group conversation/message so the
 * UI can offer a "jump to group chat" affordance and mirroring stays
 * idempotent.
 */
export interface ChatMessageGroupTask {
  /** Durable project task identity shared by group and DM projections. */
  taskId?: string;
  sourceProjectId: string;
  /** Group conversation the work happened in. */
  sourceConversationId: string;
  /** Group conversation title at mirror time (may be null for untitled). */
  sourceConversationTitle?: string | null;
  /** Group-side message this row mirrors. */
  sourceMessageId: string;
  /** Member (`role:<id>`) that was dispatched / produced the work. */
  memberRef: string;
  /** Member display name at mirror time (project alias when set). */
  memberName?: string;
}

/**
 * Feishu-style quote-reply provenance: which earlier message in the SAME
 * conversation this message replies to. The daemon stamps it on group
 * dispatch stubs (a fan-out stub quotes the user dispatch turn; an
 * auto-relay stub quotes the teammate reply whose handoff line created it),
 * and transcript builders render it as a bounded quote line so the
 * dispatched member knows exactly which message its task anchors to.
 * Immutable provenance — set at message creation, never edited.
 */
export interface ChatMessageReplyRef {
  /** Quoted message's id (same conversation as the replying message). */
  messageId: string;
  /** Quoted author's member ref (`role:<id>`), when the source had one. */
  roleRef?: string | null;
  /** Quoted author's display name at quote time (null = the human user). */
  authorName?: string | null;
  /** Whitespace-normalized bounded excerpt of the quoted content. */
  excerpt: string;
}

export type PersistedAgentEvent =
  // `code` carries the structured API error code for `label: 'error'`
  // status events (e.g. AGENT_AUTH_REQUIRED, RATE_LIMITED). Clients use it to
  // decide error-specific affordances such as the hosted-AMR nudge.
  | { kind: 'status'; label: string; detail?: string; code?: string }
  | { kind: 'text'; text: string }
  | { kind: 'conversation_title'; title: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | { kind: 'raw'; line: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  agentId?: string;
  agentName?: string;
  /**
   * MatOS role (`role:<id>`) that produced this assistant turn. Stamped by
   * the daemon from the run's model when roles project as models, so mixed
   * conversations can attribute each answer to its "member".
   */
  roleRef?: string | null;
  events?: PersistedAgentEvent[];
  createdAt?: number;
  /** User message this assistant response belongs to. */
  turnUserMessageId?: string | null;
  runId?: string;
  runStatus?: ChatRunStatus;
  /** True when this message's failed run can be recovered by resuming the
   *  agent's CLI session (transient upstream drop / inactivity on a
   *  session-resuming runtime). Drives the chat's Continue affordance; mirrors
   *  ChatRunStatusResponse.resumable. */
  resumable?: boolean;
  lastRunEventId?: string;
  startedAt?: number;
  endedAt?: number;
  sessionMode?: ChatSessionMode;
  runContext?: RunContextSelection;
  /**
   * Present only on DM rows the daemon mirrored from a group chat; see
   * ChatMessageGroupTask. Mirrored rows are inert work-ledger records:
   * they carry content/events/producedFiles but no live run wiring.
   */
  groupTask?: ChatMessageGroupTask;
  /** Quote-reply provenance; see ChatMessageReplyRef. */
  replyTo?: ChatMessageReplyRef;
  attachments?: ChatAttachment[];
  commentAttachments?: ChatCommentAttachment[];
  producedFiles?: ProjectFile[];
  /** Full produced-file count when the chat projection bounds the inline list. */
  producedFilesTotal?: number;
  traceObjectFiles?: ProjectFile[];
  // Diff baseline so reattach can rebuild producedFiles after reload.
  preTurnFileNames?: string[];
  preTurnFileSnapshot?: Array<Pick<ProjectFile, 'name' | 'size' | 'mtime' | 'etag'>>;
  feedback?: ChatMessageFeedback;
  /**
   * Request-only marker for the final assistant-message persistence pass.
   * The daemon does not store or return this field; it only uses it to
   * mark the final persistence pass before content and producedFiles settle.
   */
  telemetryFinalized?: boolean;
}
