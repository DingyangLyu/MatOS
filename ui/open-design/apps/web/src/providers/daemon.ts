/**
 * Daemon provider — fetch-based SSE client for /api/runs. The daemon can
 * emit three event streams depending on the agent's streamFormat:
 *   - 'agent'   : typed events emitted by Claude Code's stream-json parser
 *                 (status, text_delta, thinking_delta, tool_use, tool_result,
 *                 usage, raw). We forward these to the UI as AgentEvent items.
 *   - 'stdout'  : plain chunks from other CLIs. We wrap them in a single
 *                 rolling 'text' event.
 *   - 'stderr'  : incidental stderr. Shown only when the process exits
 *                 non-zero (tail appended to the error message).
 */
import type { AgentEvent, ChatCommentAttachment, ChatMessage } from '../types';
import type {
  ChatGroupContext,
  ChatRunCreateResponse,
  ChatRunListResponse,
  ChatRunStatus,
  ChatRunStatusResponse,
  ChatRequest,
  ChatSessionMode,
  ChatSseEvent,
  ChatSseStartPayload,
  DaemonAgentPayload,
  ResearchOptions,
  RunContextSelection,
  SseErrorPayload,
} from '@open-design/contracts';
export interface StreamHandlers {
  onDelta: (textDelta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}
import { watchDaemonRunTerminal } from './daemon-run-watch';

/**
 * Returns the front-end carrier that's about to send this request:
 * - 'desktop' when running inside the Electron shell
 * - 'web' when running in a regular browser
 * - 'unknown' in non-browser test environments (jsdom without a UA)
 *
 * The daemon uses this to label the run's client type. Cheap, called once
 * per run so caching isn't worth the complexity.
 */
function detectClientType(): 'desktop' | 'web' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent ?? '';
  if (ua.includes('Electron/')) return 'desktop';
  if (ua) return 'web';
  return 'unknown';
}
import { parseSseFrame } from './sse';
import {
  buildGroupContextHeader,
  buildGroupHistoryCompactionNotice,
  formatReplyQuote,
  formatTurnFileReferences,
} from '@open-design/contracts';
import {
  findByRoleRef,
  projectRoleRefsFromMetadata,
  resolveProjectRoleSelection,
  roleRefIdentity,
} from '../utils/roleRefs';
import {
  summarizeArtifactsForTranscript,
  type PersistedArtifactFileRef,
} from '../artifacts/strip';

const MAX_TRANSCRIPT_MESSAGE_CHARS = 12_000;
const MAX_TRANSCRIPT_TOTAL_CHARS = 64_000;
const MAX_TRANSCRIPT_MESSAGES = 40;
const LARGE_TOOL_RESULT_CHARS = 8_000;
const HIGH_INPUT_TOKEN_WARNING_THRESHOLD = 200_000;

export function latestUserPromptFromHistory(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

export function latestUserMessageIdFromHistory(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === 'user' && message.id) return message.id;
  }
  return null;
}

function truncateForTranscript(content: string): string {
  if (content.length <= MAX_TRANSCRIPT_MESSAGE_CHARS) return content;
  const omitted = content.length - MAX_TRANSCRIPT_MESSAGE_CHARS;
  return `${content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS)}\n\n[MatOS truncated ${omitted} chars from this prior message before sending it to the agent. Full content remains in persisted history.]`;
}

function escapeTranscriptRoleDelimiters(content: string): string {
  return content.replace(/^(## (?:user|assistant)[ \t]*)(\r?)$/gm, '\\$1$2');
}

function compactInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function buildPriorRunContextWarning(history: ChatMessage[]): string | null {
  let highestInputTokens = 0;
  let largeToolResults = 0;
  let sawAgentBrowserCoreDump = false;

  for (const message of history) {
    for (const event of message.events ?? []) {
      if (event.kind === 'usage' && typeof event.inputTokens === 'number') {
        highestInputTokens = Math.max(highestInputTokens, event.inputTokens);
      }
      if (event.kind === 'tool_result') {
        if (event.content.length > LARGE_TOOL_RESULT_CHARS) largeToolResults += 1;
        if (
          event.content.includes('agent-browser skills get core') ||
          event.content.includes('Agent Browser Core') ||
          event.content.includes('name: core')
        ) {
          sawAgentBrowserCoreDump = true;
        }
      }
      if (event.kind === 'tool_use') {
        const input = compactInput(event.input);
        if (input.includes('agent-browser skills get core')) {
          sawAgentBrowserCoreDump = true;
        }
      }
    }
  }

  const notes: string[] = [];
  if (highestInputTokens >= HIGH_INPUT_TOKEN_WARNING_THRESHOLD) {
    notes.push(`a previous run reported ${highestInputTokens} input tokens`);
  }
  if (largeToolResults > 0) {
    notes.push(`${largeToolResults} large prior tool result${largeToolResults === 1 ? '' : 's'} exist only in persisted event history`);
  }
  if (sawAgentBrowserCoreDump) {
    notes.push('agent-browser documentation output was seen earlier; do not replay it into this turn');
  }
  if (notes.length === 0) return null;

  return [
    '## context warning',
    `MatOS detected ${notes.join(', ')}.`,
    'Keep this turn compact: summarize prior tool output, read large references from temp files, and quote only task-relevant lines.',
  ].join('\n');
}

function scopeHistoryToAgent(history: ChatMessage[], targetAgentId?: string): ChatMessage[] {
  if (!targetAgentId) return history;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (
      message?.role === 'assistant' &&
      message.agentId &&
      !isSameTranscriptAgentFamily(message.agentId, targetAgentId)
    ) {
      return history.slice(i + 1);
    }
  }
  return history;
}

function isSameTranscriptAgentFamily(agentId: string, targetAgentId: string): boolean {
  return agentId === targetAgentId;
}

// Strip OD-specific markup that the agent emitted on a prior turn but
// that the model would otherwise pattern-match as a template to echo.
// Today this is `<question-form>` blocks (and the `<ask-question>` alias the
// UI parser and the daemon open-tag matcher both accept) and the ```json
// fenced schemas
// some models (GPT-OSS-120B Medium, Gemini 3.5 Flash) emit alongside
// them — leaving those literal in the transcript causes weak/medium
// plain-stream models to re-emit an identical form on the user's
// follow-up turn, looking like the discovery form loop never breaks
// (see PR #3157 form-loop investigation). If we only scrubbed the canonical
// tag, an alias-form turn would replay verbatim and re-trigger that loop.
//
// User content is preserved verbatim — a user message that legitimately
// quotes `<question-form>` (e.g. discussing the markup with the agent)
// must not be mangled.
export function sanitizePriorAssistantTurnForTranscript(
  content: string,
  persistedArtifactFiles: ReadonlyArray<PersistedArtifactFileRef> = [],
): string {
  let sanitized = content.replace(
    // `\1` backreference keeps the open/close tag names matched so we never
    // splice across a `<question-form>…</ask-question>` mismatch.
    /<(question-form|ask-question)\b[^>]*>[\s\S]*?<\/\1>/g,
    '[question-form was emitted here on a prior turn; the user already answered, see their reply below.]',
  );
  // Strip ```json (or plain ```) fenced blocks whose body matches the
  // form schema shape — `"questions": [` is the strongest tell. A
  // generic JSON snippet without that key (e.g. an API response the
  // agent shared) is left intact.
  sanitized = sanitized.replace(
    /```(?:json)?\s*\n([\s\S]*?)\n```/g,
    (match, body: string) => {
      if (/"questions"\s*:\s*\[/.test(body)) {
        return '[form schema was echoed here on a prior turn; stripped to avoid a loop.]';
      }
      return match;
    },
  );
  // Replace prior-turn `<artifact>` HTML with a one-line summary — but ONLY
  // for artifacts whose save to the project files is confirmed by the
  // message's producedFiles record. persistArtifact has refusal and
  // write-failure branches; on those paths the transcript copy is the only
  // surviving artifact body, so an unconfirmed block stays verbatim (the
  // 12K truncation below still bounds it) and a follow-up turn can repair it.
  // For confirmed saves the agent reads/edits the file from disk, never from
  // this transcript copy, so re-sending the whole document each turn is pure
  // waste — the summary keeps identifier/title/type plus the saved file name.
  // Runs before truncateForTranscript so the summarized message no longer
  // trips the 12K cap. Uses markdown-aware detection so a literal
  // `<artifact>` recited in a code fence survives.
  sanitized = summarizeArtifactsForTranscript(sanitized, persistedArtifactFiles);
  return sanitized;
}

// producedFiles → the persistence evidence summarizeArtifactsForTranscript
// matches artifact blocks against. producedFiles is the whole per-turn file
// diff — tool-written files included — so a name collision with an unrelated
// same-turn file must not count as proof the <artifact> body was saved. Only
// artifact-originated saves qualify: persistArtifact always writes an explicit
// (non-inferred) manifest, whereas tool-written files surface with no manifest
// or a daemon-inferred one (`metadata.inferred === true`). Within that
// narrowed set, the manifest identifier is the strongest link (it survives
// `-2`/`-3` collision renames); the file name is the fallback for artifact
// saves whose manifest predates identifier metadata.
function persistedArtifactFilesOf(message: ChatMessage): PersistedArtifactFileRef[] {
  return (message.producedFiles ?? [])
    .filter((file) => file.artifactManifest && file.artifactManifest.metadata?.inferred !== true)
    .map((file) => {
      const identifier = file.artifactManifest?.metadata?.identifier;
      return {
        name: file.name,
        identifier: typeof identifier === 'string' && identifier ? identifier : undefined,
      };
    });
}

// MatOS group chat grammar (roster header, @-mention parsing, handoff/relay
// parsing, dispatch bounds) is shared with the daemon through the contracts
// package: the daemon owns durable fan-out/relay continuation, so both sides
// MUST agree on what counts as a mention or a handoff line. Re-exported here
// so existing web imports keep working.
export {
  buildGroupContextHeader,
  GROUP_DISPATCH_MAX_TARGETS,
  GROUP_RELAY_MAX_HOPS,
  parseGroupRelayTarget,
  parseGroupRelayTargets,
  parseUserGroupMentions,
} from '@open-design/contracts';
export type { ChatGroupContext } from '@open-design/contracts';

/** Display name for a message's member attribution, or null when unknown. */
function groupMemberNameFor(
  roleRef: string | null | undefined,
  ctx: ChatGroupContext,
): string | null {
  if (typeof roleRef !== 'string' || !roleRef.startsWith('role:')) return null;
  // Version-agnostic: historical turns may be attributed to an older pinned
  // role version than the current roster carries.
  const member = findByRoleRef(ctx.members, roleRef);
  return member ? member.name : roleRefIdentity(roleRef).replace(/^role:/, '');
}

export function buildDaemonTranscript(
  history: ChatMessage[],
  targetAgentId?: string,
  groupContext?: ChatGroupContext,
): string {
  // System rows are operational notices for the human (dispatch feedback,
  // imported timeline system events) — never part of the agent's prompt.
  // The daemon's durable-task transcript builder applies the same filter.
  const scopedHistory = scopeHistoryToAgent(history, targetAgentId)
    .filter((message) => message.role !== 'system');
  const selectedHistory: ChatMessage[] = [];
  let selectedChars = 0;
  for (const message of [...scopedHistory].reverse()) {
    const estimated = Math.min(message.content.length, MAX_TRANSCRIPT_MESSAGE_CHARS) + 96;
    if (
      selectedHistory.length > 0 &&
      (selectedHistory.length >= MAX_TRANSCRIPT_MESSAGES || selectedChars + estimated > MAX_TRANSCRIPT_TOTAL_CHARS)
    ) {
      break;
    }
    selectedHistory.push(message);
    selectedChars += estimated;
  }
  selectedHistory.reverse();
  const omittedMessageCount = Math.max(0, scopedHistory.length - selectedHistory.length);
  const transcript = selectedHistory
    .map((m) => {
      const trimmed = m.content.trim();
      const sanitized =
        m.role === 'assistant'
          ? sanitizePriorAssistantTurnForTranscript(trimmed, persistedArtifactFilesOf(m))
          : trimmed;
      // Group chat: attribute each turn to its member so every agent can see
      // who said what. Plain conversations keep the bare `## role` headers.
      let header = `## ${m.role}`;
      if (groupContext) {
        const memberName = groupMemberNameFor(m.roleRef, groupContext);
        if (memberName && m.role === 'assistant') header = `## assistant (member: ${memberName})`;
        else if (memberName && m.role === 'user') header = `## user (@${memberName})`;
      } else if (m.groupTask) {
        // Member DM: rows the daemon mirrored from a group chat read as the
        // member's own work ledger, labeled with their provenance so a later
        // DM turn knows these tasks happened in the group, not in this DM.
        const title = (m.groupTask.sourceConversationTitle ?? '').replace(/\s+/g, ' ').trim();
        const source = title ? `group chat "${title}"` : 'a group chat';
        header =
          m.role === 'assistant'
            ? `## assistant (your work record from ${source})`
            : `## user (task dispatched to you in ${source})`;
      }
      // Quote-reply anchor (which message this turn replies to) renders
      // directly under the header; group dispatch stubs carry it so agents
      // and readers know the exact source turn. Factual provenance, so it
      // renders wherever present.
      const replyQuote = m.replyTo ? formatReplyQuote(m.replyTo) : '';
      // Group turns (and mirrored work-ledger rows) annotate their file
      // provenance so a member can find teammates' outputs and the user's
      // attached inputs by path. Plain single-role chats stay unannotated —
      // their prompts are unchanged by the group file mechanism.
      const fileReferences = groupContext || m.groupTask
        ? formatTurnFileReferences({
            attachments: m.attachments ?? null,
            producedFiles: m.producedFiles ?? null,
          })
        : '';
      return `${header}${replyQuote ? `\n${replyQuote}` : ''}\n${
        escapeTranscriptRoleDelimiters(truncateForTranscript(sanitized))
      }${fileReferences ? `\n${fileReferences}` : ''}`;
    })
    .join('\n\n');
  const warning = buildPriorRunContextWarning(selectedHistory);
  // Group runs get the shared compaction notice that also names the
  // project-local native timeline file — the agent's "scroll up" path.
  // Plain chats keep the original shorter wording.
  const compactionNotice = omittedMessageCount > 0
    ? groupContext
      ? buildGroupHistoryCompactionNotice({ omittedCount: omittedMessageCount })
      : `## Earlier project history compacted\n${omittedMessageCount} older message(s) remain in persisted project history. Retrieve them only when the current task requires them.`
    : '';
  const parts = [
    ...(groupContext ? [buildGroupContextHeader(groupContext)] : []),
    ...(compactionNotice ? [compactionNotice] : []),
    ...(warning ? [warning] : []),
    transcript,
  ];
  return parts.join('\n\n');
}

export interface DaemonStreamHandlers extends StreamHandlers {
  onAgentEvent: (ev: AgentEvent) => void;
  /**
   * Live-only incremental tool-input fragment (Claude `input_json_delta`).
   * Kept off `AgentEvent`/`PersistedAgentEvent` because it is ephemeral and
   * never persisted — consumers accumulate by tool-use `id` for real-time
   * display and discard once the full `tool_use` event arrives. `name` is the
   * tool name so the UI can gate the live preview to code-writing tools.
   */
  onToolInputDelta?: (id: string, name: string, delta: string) => void;
}

export interface DaemonStreamOptions {
  agentId: string;
  history: ChatMessage[];
  /** Legacy field accepted by older tests/callers. Daemon-owned prompt composition ignores it. */
  systemPrompt?: string;
  /** Stops the current browser-side SSE subscription. The daemon run continues. */
  signal: AbortSignal;
  /** Explicit user cancellation signal. This maps to POST /api/runs/:id/cancel. */
  cancelSignal?: AbortSignal;
  handlers: DaemonStreamHandlers;
  // The active project's id. When supplied, the daemon spawns the agent
  // with cwd = the project folder so its file tools target the right
  // workspace.
  projectId?: string | null;
  // Last-rendered MatOS project roster. The shared run boundary refreshes it
  // from project authority before dispatch and uses this value only as a
  // transport-failure fallback.
  projectRoleRefs?: readonly string[];
  conversationId?: string | null;
  sessionMode?: ChatSessionMode;
  assistantMessageId?: string | null;
  clientRequestId?: string | null;
  skillId?: string | null;
  // Per-turn skill ids picked via the composer's @-mention popover. These
  // are layered onto the system prompt for this run only and do not
  // change the project's persistent `skillId`.
  skillIds?: string[];
  // Project-relative paths the user has staged for this turn. The
  // daemon resolves them inside the project folder, validates they
  // exist, and stitches them into the user message as `@<path>` hints.
  attachments?: string[];
  commentAttachments?: ChatCommentAttachment[];
  // Per-CLI model + reasoning the user picked in the model menu. Both are
  // optional; the daemon validates them against the agent's declared
  // options and falls back to the CLI default when missing.
  model?: string | null;
  reasoning?: string | null;
  // Provider LLM override (web `/model` picker). MatOS repurposes `model`
  // as the role ref, so the actual LLM pick travels on its own field and
  // reaches the CLI as `--model <id>`.
  providerModel?: string | null;
  /** Native MatOS asset refs persistently selected on the project. */
  assetRefs?: string[];
  // MatOS group chat: roster + addressed member for this turn. Shapes the
  // transcript (roster header + member-attributed turns) only; the run itself
  // still executes one native `matos --role` process for the addressed member.
  groupContext?: ChatGroupContext;
  research?: ResearchOptions;
  context?: RunContextSelection;
  titleGeneration?: { enabled?: boolean };
  locale?: string;
  initialLastEventId?: string | null;
  onRunCreated?: (runId: string) => void;
  onRunStatus?: (status: ChatRunStatus) => void;
  onRunEventId?: (eventId: string) => void;
  dsEnrichment?: boolean;
}

export interface DaemonReattachOptions {
  runId: string;
  signal: AbortSignal;
  cancelSignal?: AbortSignal;
  handlers: DaemonStreamHandlers;
  initialLastEventId?: string | null;
  onRunStatus?: (status: ChatRunStatus) => void;
  onRunEventId?: (eventId: string) => void;
}

export const RUNS_CHANGED_EVENT = 'open-design:runs-changed';
export const GENERIC_DAEMON_DISCONNECT_MESSAGE =
  'daemon stream disconnected before run completed';
export const GENERIC_DAEMON_DISCONNECT_CODE = 'DAEMON_STREAM_DISCONNECTED';
export const DAEMON_RUN_INTERRUPTED_MESSAGE =
  'MatOS workspace restarted before this response completed. Earlier tool results were preserved; continue or retry the conversation.';
export const DAEMON_RUN_INTERRUPTED_CODE = 'RUN_INTERRUPTED_BY_DAEMON_RESTART';

const DAEMON_SSE_MAX_RECONNECTS = 5;
const DAEMON_SSE_RECONNECT_BASE_DELAY_MS = 250;

function isRetryableDaemonStreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function waitForDaemonStreamReconnect(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const delayMs = Math.min(
    DAEMON_SSE_RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
    2_000,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createGenericDaemonDisconnectError(): Error & { code: string } {
  const error = new Error(GENERIC_DAEMON_DISCONNECT_MESSAGE) as Error & { code: string };
  error.code = GENERIC_DAEMON_DISCONNECT_CODE;
  return error;
}

export function createDaemonRunInterruptedError(): Error & { code: string } {
  const error = new Error(DAEMON_RUN_INTERRUPTED_MESSAGE) as Error & { code: string };
  error.code = DAEMON_RUN_INTERRUPTED_CODE;
  return error;
}

function notifyRunsChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
}

function daemonSseErrorMessage(data: SseErrorPayload): string {
  const formattedOpenCodeError = formatOpenCodeSessionError(data.error?.details);
  if (formattedOpenCodeError) return formattedOpenCodeError;

  const message = String(data.error?.message ?? data.message ?? 'daemon error');
  const legacyOpenCodeError = formatLegacyOpenCodeSessionError(message);
  if (legacyOpenCodeError) return legacyOpenCodeError;

  const detail =
    data.error?.details &&
    typeof data.error.details === 'object' &&
    !Array.isArray(data.error.details) &&
    typeof data.error.details.detail === 'string'
      ? data.error.details.detail
      : null;
  if (!detail || detail === message || message.includes(detail)) return message;
  return `${message}\n${detail}`;
}

function daemonSseError(data: SseErrorPayload): Error {
  const error = new Error(daemonSseErrorMessage(data)) as Error & {
    code?: string;
    details?: unknown;
  };
  if (data.error?.code) error.code = data.error.code;
  if (data.error?.details !== undefined) error.details = data.error.details;
  return error;
}

function shouldSuppressLifecycleExitFallback(
  agentId: string | undefined,
  exitCode: number | null,
  exitSignal: string | null,
  stderrTail: string,
): boolean {
  if (exitCode !== 130 || exitSignal) return false;
  const normalizedStderr = stderrTail.toLowerCase();
  return (
    normalizedStderr.includes('opencode server listening') ||
    normalizedStderr.includes('opencode_server_password')
  );
}

const AMR_OPENCODE_INCOMPLETE_MESSAGE =
  'MatOS started, but the run did not complete. Please retry or check the run details for the session stream error.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBooleanField(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

interface OpenCodeSessionErrorDetails {
  source: string | null;
  code: string | null;
  message: string | null;
  statusCode: number | null;
  retryable: boolean | null;
  suggestion: string | null;
  responseBodyPreview: string | null;
}

function inferOpenCodeRetryable(statusCode: number | null): boolean | null {
  if (statusCode === null) return null;
  return statusCode === 429 || statusCode >= 500;
}

function normalizeOpenCodeSessionErrorDetails(value: unknown): OpenCodeSessionErrorDetails | null {
  if (!isRecord(value) || value.kind !== 'opencode_session_error') return null;
  const statusCode = readNumberField(value, 'statusCode');
  return {
    source: readStringField(value, 'source'),
    code: readStringField(value, 'code'),
    message: readStringField(value, 'message'),
    statusCode,
    retryable: readBooleanField(value, 'retryable') ?? inferOpenCodeRetryable(statusCode),
    suggestion: readStringField(value, 'suggestion'),
    responseBodyPreview: readStringField(value, 'responseBodyPreview'),
  };
}

function linkErrorMessageFromResponseBodyPreview(preview: string | null): string | null {
  if (!preview) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(preview);
  } catch {
    return null;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  return readStringField(error, 'message');
}

function retryExhaustedMessage(details: OpenCodeSessionErrorDetails): string | null {
  const linkMessage = linkErrorMessageFromResponseBodyPreview(details.responseBodyPreview);
  if (!linkMessage) return null;
  const retryMatch = linkMessage.match(/\bRetried the upstream request\s+(\d+)\s+times\b/i);
  if (!retryMatch) return null;
  const retryCount = retryMatch[1];
  return [
    'The upstream model service is temporarily unavailable.',
    '',
    `We already retried ${retryCount} times, but the request still failed. Please retry later or switch to another model.`,
  ].join('\n');
}

function formatOpenCodeSessionError(value: unknown): string | null {
  const details = normalizeOpenCodeSessionErrorDetails(value);
  if (!details) return null;
  const statusCode = details.statusCode;
  const message = details.message;
  if (details.source === 'opencode' && details.code === 'ROLE_MARKER_HALLUCINATION') {
    return message;
  }
  if (statusCode === 404) {
    return 'The model service returned 404 Not Found for the configured runtime endpoint. Check the MatOS link URL or model route.';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'MatOS authentication failed. Please sign in again or refresh the runtime key.';
  }
  if (statusCode === 429) {
    return 'The model service rejected the request due to quota or rate limits. Retry later or check quota and rate limits.';
  }
  if (typeof statusCode === 'number' && statusCode >= 500) {
    const exhaustedMessage = retryExhaustedMessage(details);
    if (exhaustedMessage) return exhaustedMessage;
    return 'The upstream model provider returned a temporary error. Please retry or switch models.';
  }
  const base = message ? `OpenCode session failed: ${message}` : 'OpenCode session failed.';
  return details.suggestion ? `${base}\n${details.suggestion}` : base;
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function legacyOpenCodeSessionErrorDetails(text: string): OpenCodeSessionErrorDetails | null {
  const marker = 'opencode session error:';
  const markerIndex = text.toLowerCase().indexOf(marker);
  if (markerIndex === -1) return null;
  const jsonStart = text.indexOf('{', markerIndex + marker.length);
  if (jsonStart === -1) return null;
  const jsonText = extractBalancedJsonObject(text, jsonStart);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const error = isRecord(parsed.error) ? parsed.error : null;
  const data = isRecord(error?.data) ? error.data : null;
  const statusCode = readNumberField(data, 'statusCode');
  const retryable = readBooleanField(data, 'isRetryable') ?? inferOpenCodeRetryable(statusCode);
  return {
    source: null,
    code: null,
    message: readStringField(data, 'message') ?? readStringField(error, 'message'),
    statusCode,
    retryable,
    suggestion: null,
    responseBodyPreview: readStringField(data, 'responseBodyPreview') ?? readStringField(data, 'responseBody'),
  };
}

function formatLegacyOpenCodeSessionError(text: string): string | null {
  const details = legacyOpenCodeSessionErrorDetails(text);
  if (!details) return null;
  return formatOpenCodeSessionError({
    kind: 'opencode_session_error',
    ...details,
  });
}

function isAmrOpenCodeExitFallback(agentId: string | undefined, stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes('opencode server listening') || normalized.includes('opencode session error:');
}

function isAmrOpenCodeBootstrapLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^AMR run id:\s*\S+/i.test(trimmed) ||
    /^Performing one time database migration/i.test(trimmed) ||
    /^sqlite-migration:done$/i.test(trimmed) ||
    /^Database migration complete\.?$/i.test(trimmed) ||
    /^Warning:\s*OPENCODE_SERVER_PASSWORD is not set/i.test(trimmed) ||
    /^opencode server listening on http:\/\/127\.0\.0\.1:\d+/i.test(trimmed)
  );
}

function cleanAmrOpenCodeStderrFallback(agentId: string | undefined, stderr: string): string {
  if (!isAmrOpenCodeExitFallback(agentId, stderr)) return stderr.trim();
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !isAmrOpenCodeBootstrapLine(line))
    .join('\n')
    .trim();
}

async function resolveDaemonRunModel(input: {
  agentId: string;
  projectId?: string | null;
  projectRoleRefs?: readonly string[];
  requestedModel?: string | null;
  groupContext?: ChatGroupContext;
  signal: AbortSignal;
}): Promise<string | null> {
  if (input.agentId !== 'matos' || !input.projectId) return input.requestedModel ?? null;

  let members = projectRoleRefsFromMetadata({ members: input.projectRoleRefs ?? [] });
  if (!input.signal.aborted) {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(input.projectId)}`, {
        signal: input.signal,
      });
      if (response.ok) {
        const payload = await response.json() as { project?: { metadata?: unknown } };
        members = projectRoleRefsFromMetadata(payload.project?.metadata);
      }
    } catch {
      // The native project-membership check remains authoritative. If this
      // defensive lookup is unavailable, preserve the request and let the
      // daemon return its structured fail-closed error.
    }
  }

  return resolveProjectRoleSelection(members, [
    input.groupContext?.respondingRef,
    input.requestedModel,
  ]);
}

export async function streamViaDaemon({
  agentId,
  history,
  signal,
  cancelSignal,
  handlers,
  projectId,
  projectRoleRefs,
  conversationId,
  sessionMode,
  assistantMessageId,
  clientRequestId,
  skillId,
  skillIds,
  attachments,
  commentAttachments,
  model,
  reasoning,
  providerModel,
  assetRefs,
  groupContext,
  research,
  context,
  titleGeneration,
  locale,
  initialLastEventId,
  onRunCreated,
  onRunStatus,
  onRunEventId,
  dsEnrichment,
}: DaemonStreamOptions): Promise<void> {
  const emitRunStatus = (status: ChatRunStatus) => {
    onRunStatus?.(status);
    notifyRunsChanged();
  };
  // Local CLIs are single-turn print-mode programs, so we collapse the whole
  // chat into one string. If this becomes too noisy for long histories, the
  // fix is to only include the final user turn.
  const transcript = buildDaemonTranscript(history, agentId, groupContext);
  const resolvedModel = await resolveDaemonRunModel({
    agentId,
    projectId,
    projectRoleRefs,
    requestedModel: model,
    groupContext,
    signal,
  });
  if (signal.aborted) return;
  const request: ChatRequest = {
    agentId,
    message: transcript,
    currentPrompt: latestUserPromptFromHistory(history),
    projectId: projectId ?? null,
    conversationId: conversationId ?? null,
    sessionMode,
    userMessageId: latestUserMessageIdFromHistory(history),
    assistantMessageId: assistantMessageId ?? null,
    clientRequestId: clientRequestId ?? null,
    skillId: skillId ?? null,
    skillIds: Array.isArray(skillIds) ? skillIds : [],
    attachments: attachments ?? [],
    commentAttachments: commentAttachments ?? [],
    model: resolvedModel,
    reasoning: reasoning ?? null,
    ...(providerModel ? { providerModel } : {}),
    ...(Array.isArray(assetRefs) && assetRefs.length > 0 ? { assetRefs } : {}),
    locale,
    ...(context ? { context } : {}),
    ...(research ? { research } : {}),
    ...(titleGeneration?.enabled ? { titleGeneration: { enabled: true } } : {}),
    ...(dsEnrichment ? { dsEnrichment } : {}),
  };
  const body = JSON.stringify(request);

  try {
    const createResp = await fetch('/api/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Tells the daemon which front-end carrier started the run.
        // The daemon falls back to a User-Agent sniff when this header is
        // absent (e.g. third-party clients), so omitting it in tests is OK.
        'X-OD-Client': detectClientType(),
      },
      body,
    });

    if (!createResp.ok) {
      const text = await createResp.text().catch(() => '');
      emitRunStatus('failed');
      handlers.onError(new Error(`daemon ${createResp.status}: ${text || 'no body'}`));
      return;
    }

    const created = (await createResp.json()) as ChatRunCreateResponse;
    const runId = created.runId;
    onRunCreated?.(runId);
    notifyRunsChanged();
    emitRunStatus('queued');
    await consumeDaemonRun({
      agentId,
      runId,
      signal,
      cancelSignal,
      handlers,
      initialLastEventId,
      onRunStatus: emitRunStatus,
      onRunEventId,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    emitRunStatus('failed');
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function reattachDaemonRun(options: DaemonReattachOptions): Promise<void> {
  await consumeDaemonRun({
    ...options,
    onRunStatus: (status) => {
      options.onRunStatus?.(status);
      notifyRunsChanged();
    },
  });
}

export async function fetchChatRunStatus(runId: string, signal?: AbortSignal): Promise<ChatRunStatusResponse | null> {
  const controller = signal ? undefined : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 5_000) : undefined;
  try {
    const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
      signal: signal ?? controller?.signal,
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ChatRunStatusResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listActiveChatRuns(
  projectId: string,
  conversationId: string,
): Promise<ChatRunStatusResponse[]> {
  try {
    const qs = new URLSearchParams({ projectId, conversationId, status: 'active' });
    const resp = await fetch(`/api/runs?${qs.toString()}`);
    if (!resp.ok) return [];
    const body = (await resp.json()) as ChatRunListResponse;
    return body.runs ?? [];
  } catch {
    return [];
  }
}

export async function listProjectRuns(): Promise<ChatRunStatusResponse[]> {
  try {
    const resp = await fetch('/api/runs');
    if (!resp.ok) return [];
    const body = (await resp.json()) as ChatRunListResponse;
    return body.runs ?? [];
  } catch {
    return [];
  }
}

async function consumeDaemonRun({
  agentId,
  runId,
  signal,
  cancelSignal,
  handlers,
  initialLastEventId,
  onRunStatus,
  onRunEventId,
}: DaemonReattachOptions & { agentId?: string }): Promise<void> {
  let acc = '';
  let stderrBuf = '';
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let endStatus: ChatRunStatus | null = null;
  let pendingStructuredError: Error | null = null;
  // Tracks whether the server explicitly declared `status: 'succeeded'` in
  // the SSE end payload (or via the fallback run-status fetch). Distinct
  // from `endStatus === 'succeeded'`, which can be a local fallback when
  // the SSE end event omits or sends an invalid `status` field. Only the
  // explicit declaration is allowed to bypass the exit-code/signal safety
  // net below — a missing-status fallback keeps the old behavior so a
  // failure response with `{code:1}` or `{code:null,signal:"SIGTERM"}` and
  // no `status` field still surfaces an error banner.
  let serverDeclaredSuccess = false;
  // Set when the daemon reports this terminal failure can be recovered by
  // resuming the agent's CLI session (transient upstream drop / inactivity on
  // a session-resuming runtime). Carried onto the surfaced error so the chat
  // can offer a Continue affordance. See ChatRunStatusResponse.resumable.
  let endResumable = false;
  let lastEventId: string | null = initialLastEventId ?? null;
  let canceled = false;
  let closeConnection: (() => void) | undefined;
  const cancelRun = () => {
    if (canceled) return;
    canceled = true;
    void fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => {});
  };

  cancelSignal?.addEventListener('abort', cancelRun, { once: true });
  try {
    if (cancelSignal?.aborted) {
      cancelRun();
      return;
    }

    for (let reconnects = 0; endStatus === null && reconnects < DAEMON_SSE_MAX_RECONNECTS;) {
      closeConnection?.();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const connection = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let terminalRecoveryRequested = false;
      const discardReader = () => {
        const current = reader;
        reader = undefined;
        if (current) {
          void current.cancel().catch(() => {}).finally(() => {
            try { current.releaseLock?.(); } catch {}
          });
        }
      };
      const detach = () => {
        connection.abort();
        discardReader();
      };
      signal.addEventListener('abort', detach, { once: true });
      const watch = watchDaemonRunTerminal({
        probe: probeSignal => fetchChatRunStatus(runId, probeSignal),
        reconnect: () => {
          terminalRecoveryRequested = true;
          detach();
        },
      });
      closeConnection = () => {
        watch.stop();
        signal.removeEventListener('abort', detach);
        detach();
      };
      const qs = lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : '';
      let resp: Response;
      try {
        resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/events${qs}`, {
          method: 'GET',
          signal: connection.signal,
        });
      } catch (err) {
        if (signal.aborted || ((err as Error).name === 'AbortError' && !terminalRecoveryRequested)) throw err;
        reconnects += 1;
        if (reconnects < DAEMON_SSE_MAX_RECONNECTS) {
          await waitForDaemonStreamReconnect(reconnects, signal);
        }
        continue;
      }

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        // A workspace/gateway restart can briefly return nginx 502 while the
        // run continues inside the daemon. Treat retryable HTTP responses the
        // same as a dropped SSE socket and resume from lastEventId. Surfacing
        // the HTML body here permanently marks a run failed even when its
        // authoritative status later becomes succeeded.
        if (isRetryableDaemonStreamStatus(resp.status)) {
          reconnects += 1;
          if (reconnects < DAEMON_SSE_MAX_RECONNECTS) {
            await waitForDaemonStreamReconnect(reconnects, signal);
          }
          continue;
        }
        // A run id returned by this daemon existed. A later 404 on the same
        // stream most commonly means the workspace daemon restarted and lost
        // its old in-memory Map. New daemons recover the durable events.jsonl;
        // this compatibility path keeps older deployments from exposing the
        // raw {NOT_FOUND, run not found} payload as if the user's task failed.
        if (resp.status === 404) {
          onRunStatus?.('failed');
          handlers.onError(createDaemonRunInterruptedError());
          return;
        }
        handlers.onError(new Error(`daemon ${resp.status}: ${text || 'no body'}`));
        return;
      }

      const streamReader = resp.body.getReader();
      reader = streamReader;
      const decoder = new TextDecoder();
      let buf = '';
      let sawStreamProgress = false;

      readStream: while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await streamReader.read();
        } catch (err) {
          // Only catch reader.read() failures — a broken SSE connection
          // (tab backgrounded, proxy idle timeout, network drop). Parsing
          // and handler invocations stay OUTSIDE this catch so local
          // processing bugs surface through the existing outer error path.
          if (signal.aborted || ((err as Error).name === 'AbortError' && !terminalRecoveryRequested)) throw err;
          discardReader();
          break;
        }
        const { value, done } = readResult;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.kind === 'comment') {
            sawStreamProgress = true;
            continue;
          }
          if (parsed.kind !== 'event') continue;
          // Replayed cursors must not duplicate text or revive a finished run.
          // A terminal replay is still meaningful when reattaching after its id.
          if (parsed.event !== 'end' && parsed.id && lastEventId &&
            (parsed.id === lastEventId ||
              (/^\d+$/.test(parsed.id) && /^\d+$/.test(lastEventId) && BigInt(parsed.id) <= BigInt(lastEventId)))) {
            continue;
          }
          sawStreamProgress = true;
          watch.progress();
          if (parsed.id) {
            lastEventId = parsed.id;
            onRunEventId?.(parsed.id);
          }

          const event = parsed as unknown as ChatSseEvent;

          if (event.event === 'stdout') {
            const chunk = String(event.data.chunk ?? '');
            acc += chunk;
            handlers.onDelta(chunk);
            handlers.onAgentEvent({ kind: 'text', text: chunk });
            continue;
          }

          if (event.event === 'stderr') {
            stderrBuf += event.data.chunk ?? '';
            continue;
          }

          if (event.event === 'agent') {
            if (event.data.type === 'tool_input_delta') {
              if (
                typeof event.data.id === 'string' &&
                typeof event.data.name === 'string' &&
                typeof event.data.delta === 'string'
              ) {
                handlers.onToolInputDelta?.(event.data.id, event.data.name, event.data.delta);
              }
              continue;
            }
            const translated = translateAgentEvent(event.data);
            if (!translated) continue;
            if (translated.kind === 'text') {
              acc += translated.text;
              handlers.onDelta(translated.text);
            }
            handlers.onAgentEvent(translated);
            continue;
          }

          if (event.event === 'start') {
            const data = event.data as ChatSseStartPayload;
            onRunStatus?.('running');
            handlers.onAgentEvent({
              kind: 'status',
              label: 'starting',
              detail: typeof data.bin === 'string' ? data.bin : undefined,
            });
            continue;
          }

          if (event.event === 'error') {
            const data = event.data as SseErrorPayload;
            const structuredError = daemonSseError(data);
            pendingStructuredError = structuredError;
            // The daemon emits this error frame from the child-close handler
            // BEFORE `finishWithRetryDecision()` runs, so a transient failure it
            // can recover via a same-run retry is reported here first and only
            // resolved later. `run.resumable` is also computed at that same
            // finalize step. Read the run status ONCE to classify, and let the
            // SSE `end` frame (always emitted on terminal) resolve in-flight
            // runs — this has no timeout, so even a slow retry is handled:
            //  - failed / canceled    -> surface the error now, with the
            //    finalized `resumable` bit (set just before status flips to
            //    failed, so a `failed` read already has it);
            //  - status unreachable   -> surface the structured error (safe
            //    default; never drop a real failure);
            //  - succeeded (recovered) or still running/queued (retry in
            //    flight) -> do NOT surface; keep consuming so the stream's
            //    `end` frame resolves it (succeeded -> onDone; failed ->
            //    the failure path below, carrying `end`'s resumable bit).
            const status = await fetchChatRunStatus(runId).catch(() => null);
            if (status && (status.status === 'failed' || status.status === 'canceled')) {
              onRunStatus?.('failed');
              handlers.onError(
                markErrorResumable(structuredError, status.resumable === true),
              );
              return;
            }
            if (!status) {
              onRunStatus?.('failed');
              handlers.onError(structuredError);
              return;
            }
            continue;
          }

          if (event.event === 'end') {
            exitCode = typeof event.data.code === 'number' ? event.data.code : null;
            exitSignal = typeof event.data.signal === 'string' ? event.data.signal : null;
            if (event.data.resumable === true) endResumable = true;
            // `serverDeclaredSuccess` records whether the server explicitly
            // set `status: 'succeeded'` in the end payload — the local
            // `'succeeded'` fallback below does not count and must keep
            // hitting the exit-code/signal safety net later.
            serverDeclaredSuccess = event.data.status === 'succeeded';
            endStatus = isChatRunStatus(event.data.status) ? event.data.status : 'succeeded';
            onRunStatus?.(endStatus);
            break readStream;
          }
        }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      reconnects = sawStreamProgress ? 0 : reconnects + 1;
    }
    closeConnection?.();

    if (endStatus === null) {
      const status = await fetchChatRunStatus(runId);
      if (status && isChatRunStatus(status.status) && status.status !== 'queued' && status.status !== 'running') {
        endStatus = status.status;
        exitCode = status.exitCode ?? null;
        exitSignal = status.signal ?? null;
        // Fallback REST path: `status.status` is explicitly declared by the
        // daemon's run record (it passed `isChatRunStatus()` above), so an
        // explicit `'succeeded'` here is just as authoritative as the SSE
        // end-event success.
        serverDeclaredSuccess = status.status === 'succeeded';
        if (status.resumable === true) endResumable = true;
        onRunStatus?.(endStatus);
      } else {
        onRunStatus?.('failed');
        handlers.onError(createGenericDaemonDisconnectError());
        return;
      }
    }

    if (endStatus === 'canceled') {
      handlers.onDone(acc);
      return;
    }

    // Trust the server's authoritative success declaration. When the server
    // explicitly sets `status: 'succeeded'` (either in the SSE end payload
    // or via the fallback run-status fetch), the run completed cleanly even
    // if the underlying process exited via a signal — some agents (e.g.
    // ACP agents like Devin for Terminal) intentionally exit via SIGTERM
    // after a clean prompt completion because they don't shut down on
    // `stdin.end()`. The signal/non-zero-code safety net is bypassed only
    // for that explicit declaration; a missing/invalid `status` from a
    // compatible or older daemon still falls back to `endStatus =
    // 'succeeded'` for the run-status surface but must keep the safety net
    // intact so a real failure response like `{code:1}` or
    // `{code:null,signal:"SIGTERM"}` without `status` still surfaces an
    // error banner.
    const looksLikeFailure =
      endStatus === 'failed' ||
      (!serverDeclaredSuccess &&
        (exitSignal || (exitCode !== null && exitCode !== 0)));
    if (looksLikeFailure) {
      if (pendingStructuredError) {
        handlers.onError(markErrorResumable(pendingStructuredError, endResumable));
        return;
      }
      // A terminal reattach whose cursor already passed the error record can
      // receive only the final `end` event. Recover the structured reason from
      // the authoritative status body instead of degrading to "exit code 1".
      const terminalStatus = await fetchChatRunStatus(runId);
      if (terminalStatus?.error) {
        const statusError = new Error(terminalStatus.error) as Error & { code?: string };
        if (terminalStatus.errorCode) statusError.code = terminalStatus.errorCode;
        handlers.onError(
          markErrorResumable(
            statusError,
            endResumable || terminalStatus.resumable === true,
          ),
        );
        return;
      }
      if (shouldSuppressLifecycleExitFallback(agentId, exitCode, exitSignal, stderrBuf)) {
        handlers.onDone(acc);
        return;
      }
      const cleanedStderr = cleanAmrOpenCodeStderrFallback(agentId, stderrBuf);
      const formattedOpenCodeError = formatLegacyOpenCodeSessionError(cleanedStderr);
      const tail = (formattedOpenCodeError ?? cleanedStderr).trim().slice(-400);
      const fallbackTail =
        tail || (isAmrOpenCodeExitFallback(agentId, stderrBuf) ? AMR_OPENCODE_INCOMPLETE_MESSAGE : '');
      handlers.onError(
        markErrorResumable(
          new Error(`agent exited with ${exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`}${fallbackTail ? `\n${fallbackTail}` : ''}`),
          endResumable,
        ),
      );
      return;
    }
    handlers.onDone(acc);
  } finally {
    closeConnection?.();
    cancelSignal?.removeEventListener('abort', cancelRun);
  }
}

function isChatRunStatus(value: unknown): value is ChatRunStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'canceled';
}

/** Tag an error surfaced to the chat with whether the failed run can be
 *  resumed (continued from its existing CLI session). Only stamps the property
 *  when true so non-resumable failures stay undefined. */
function markErrorResumable(err: Error, resumable: boolean): Error {
  if (resumable) (err as Error & { resumable?: boolean }).resumable = true;
  return err;
}

function normalizeToolInput(input: unknown): unknown {
  if (input == null || typeof input !== 'object') return input;
  const obj = input as Record<string, unknown>;
  if ('filePath' in obj && typeof obj.filePath === 'string') {
    return { ...obj, file_path: obj.filePath };
  }
  return input;
}

const TRANSIENT_ACP_STATUS_LABELS = new Set([
  'waiting_for_first_output',
  'tool_call',
  'tool_call_update',
  'session_update',
]);

function normalizeAgentStatusLabel(label: string): string {
  return TRANSIENT_ACP_STATUS_LABELS.has(label) ? 'running' : label;
}

// Translate a raw `agent` SSE payload (what apps/daemon/src/claude-stream.ts emits)
// into the UI's AgentEvent union. Keep this liberal — unknown types just
// return null so the UI ignores them instead of rendering garbage.
function translateAgentEvent(data: DaemonAgentPayload): AgentEvent | null {
  const t = data.type;
  if (t === 'status' && typeof data.label === 'string') {
    return {
      kind: 'status',
      label: normalizeAgentStatusLabel(data.label),
      detail:
        typeof data.detail === 'string'
          ? data.detail
          : typeof data.model === 'string'
          ? data.model
          : typeof data.ttftMs === 'number'
            ? `first token in ${Math.round((data.ttftMs as number) / 100) / 10}s`
            : undefined,
    };
  }
  if (t === 'text_delta' && typeof data.delta === 'string') {
    return { kind: 'text', text: data.delta };
  }
  if (t === 'conversation_title' && typeof data.title === 'string') {
    return { kind: 'conversation_title', title: data.title };
  }
  if (t === 'thinking_delta' && typeof data.delta === 'string') {
    return { kind: 'thinking', text: data.delta };
  }
  if (t === 'thinking_start') {
    return { kind: 'status', label: 'thinking' };
  }
  if (t === 'tool_use' && typeof data.id === 'string' && typeof data.name === 'string') {
    return { kind: 'tool_use', id: data.id, name: data.name, input: normalizeToolInput(data.input) };
  }
  if (t === 'tool_result' && typeof data.toolUseId === 'string') {
    return {
      kind: 'tool_result',
      toolUseId: data.toolUseId,
      content: String(data.content ?? ''),
      isError: Boolean(data.isError),
    };
  }
  if (t === 'usage') {
    const usage = (data.usage ?? {}) as Record<string, number>;
    return {
      kind: 'usage',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd: typeof data.costUsd === 'number' ? data.costUsd : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    };
  }
  if (t === 'fabricated_role_marker' && typeof data.marker === 'string') {
    return {
      kind: 'status',
      label: 'warning',
      detail: `Model emitted fabricated role marker ("${data.marker}"). Response was truncated to prevent unauthorized instruction injection.`,
    };
  }
  if (t === 'tool_loop' && typeof data.toolName === 'string') {
    const toolName = data.toolName;
    const count = typeof data.count === 'number' ? data.count : 0;
    const detail =
      data.action === 'halt'
        ? `Run stopped: the agent repeated a failing ${toolName} call ${count}× without progress. Re-check the actual target before retrying.`
        : `Heads up — the agent has repeated a failing ${toolName} call ${count}× and may be stuck.`;
    return { kind: 'status', label: 'warning', detail };
  }
  if (t === 'raw' && typeof data.line === 'string') {
    return { kind: 'raw', line: data.line };
  }
  return null;
}
