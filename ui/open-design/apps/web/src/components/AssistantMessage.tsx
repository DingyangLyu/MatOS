import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolCard } from "./ToolCard";
import { FileOpsSummary } from "./FileOpsSummary";
import {
  renderMarkdown,
  type MarkdownLinkClickHandler,
} from "../runtime/markdown";
import { asInProjectFilePath } from "../runtime/in-project-link";
import { extractKnownProjectFileRefs, lineContainsFileReference } from "../runtime/project-file-references";
import { projectDownloadUrl } from "../providers/registry";
import { MarkdownExportMenu } from './MarkdownExportMenu';
import {
  splitOnQuestionForms,
  stripTrailingOpenQuestionForm,
  type QuestionForm,
} from "../artifacts/question-form";
import type { ChatSessionMode } from "@open-design/contracts";
import { parseSubmittedAnswers } from "./QuestionForm";
import { splitStreamingArtifact, stripArtifact, stripRecoveredHtmlFallbackForDisplay } from "../artifacts/strip";
import { Icon } from "./Icon";
import { NextStepActions, type NextStepActionsVariant } from "./NextStepActions";
import type { DesignToolboxActionId } from "../runtime/design-toolbox";
import { copyToClipboard } from "../lib/copy-to-clipboard";
import { useT } from "../i18n";
import {
  deriveFileOps,
  filterUserVisibleFileEvents,
  type FileOpEntry,
} from "../runtime/file-ops";
import { dedupeToolUsesById } from "../runtime/tool-events";
import {
  isTodoWriteToolName,
  unfinishedTodosFromEvents,
  type TodoItem,
} from "../runtime/todos";
import type { Dict } from "../i18n/types";
import { agentDisplayName, agentIconId, exactAgentDisplayName } from "../utils/agentLabels";
import { AgentIcon } from "./AgentIcon";
import {
  filterImplicitProducedFiles,
  filterUserVisibleProjectFiles,
} from "../produced-files";
import type {
  AgentEvent,
  ChatMessage,
  ChatMessageFeedbackChange,
  ChatMessageFeedbackRating,
  ChatMessageFeedbackReasonCode,
  ProjectFile,
  ProjectMetadata,
  SkillSummary,
} from "../types";

type TranslateFn = (
  key: keyof Dict,
  vars?: Record<string, string | number>
) => string;

export type QuestionFormOpenRequest = {
  form: QuestionForm;
  messageId: string;
  submittedAnswers?: Record<string, string | string[]>;
};

// The large terminal-turn card duplicates actions already available from the
// composer/toolbox and permanently consumes scarce vertical space in chat.
// Keep its implementation available for non-chat reuse, but do not mount it
// under assistant messages.
const CHAT_NEXT_STEP_ACTIONS_ENABLED = false;

interface ActionNotice {
  message: string;
  url?: string;
}

function buildActionNotice(message: string, url?: string): ActionNotice {
  const trimmedMessage = message.trim();
  const trimmedUrl = url?.trim();
  if (!trimmedUrl) return { message: trimmedMessage };
  const normalizedMessage = trimmedMessage.replace(
    new RegExp(`\\s*${escapeRegExp(trimmedUrl)}\\s*$`),
    "",
  );
  return { message: normalizedMessage.trim() || trimmedUrl, url: trimmedUrl };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ActionNoticeView({ notice }: { notice: ActionNotice | null }) {
  if (!notice) return null;
  return (
    <>
      <span>{notice.message}</span>
      {notice.url ? (
        <>
          {" "}
          <a href={notice.url} target="_blank" rel="noreferrer">
            {notice.url}
          </a>
        </>
      ) : null}
    </>
  );
}

interface Props {
  message: ChatMessage;
  streaming: boolean;
  // Live-only streaming tool-input partials keyed by tool-use id (raw,
  // mid-token JSON accumulated from `input_json_delta`). Used to render an
  // in-flight Write/Edit's code in real time before the full `tool_use`
  // arrives. Never persisted.
  liveToolInput?: Record<string, { name: string; text: string; seq?: number }>;
  // ChatPane renders the canonical conversation-level TodoWrite card as its
  // own row, while this message strips TodoWrite tool groups to avoid a
  // duplicate per-message card.
  showConversationTodoCard?: boolean;
  conversationTodoInput?: unknown | null;
  projectId?: string | null;
  conversationId?: string | null;
  projectFiles?: ProjectFile[];
  projectMetadata?: ProjectMetadata;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
  // True only for the most recent assistant message.
  isLast?: boolean;
  // Assistant message id whose run-failure error is rendered as ChatPane's
  // top-level error card; that message's per-message error pill is suppressed
  // to avoid duplication. Other messages keep their error pill.
  errorCardOwnerId?: string | null;
  // The user message that immediately follows this assistant turn, if any.
  // Kept for ChatPane compatibility; chat-side question forms now always
  // render as a compact Questions banner.
  nextUserContent?: string;
  // Open the right-hand Questions tab. The active discovery form renders
  // there (Claude-Design style) instead of inline; this assistant message
  // shows a banner that focuses the tab on click.
  onOpenQuestions?: (request?: QuestionFormOpenRequest) => void;
  onContinueRemainingTasks?: (todos: TodoItem[]) => void;
  onForkFromMessage?: () => void;
  forking?: boolean;
  onFeedback?: (change: ChatMessageFeedbackChange) => void;
  suppressDirectionForms?: boolean;
  // "Next step" affordance handlers, surfaced under the latest settled
  // assistant message. Omitting them hides the affordance entirely (e.g. in
  // tests that don't wire chat send).
  // Featured design-toolbox follow-up rows on the "next step" card. Seeding the
  // composer with an action / opening the toolbox both route through the
  // composer; see ChatPane's composer ref wiring.
  onToolboxAction?: (id: DesignToolboxActionId) => void;
  onNextStepPromptAction?: (
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => void;
  onPickSkill?: (skillId: string) => void;
  onArtifactDownload?: (fileName: string) => void;
  nextStepSkills?: SkillSummary[];
  toolboxSkillNames?: Partial<Record<DesignToolboxActionId, string | null>>;
  nextStepVariant?: NextStepActionsVariant;
}

// Props compared by reference to decide whether a memoized AssistantMessage can
// skip re-rendering. The interaction callbacks (onContinueRemainingTasks,
// onForkFromMessage, onFeedback, and next-step actions) are DELIBERATELY
// excluded: ChatPane re-creates them per render, but routes them through a ref
// so their behavior is reference-stable — comparing them would defeat the memo
// on every streamed frame. `isLast` is compared, which captures the only state
// transition those callbacks' presence depends on. The remaining context props
// (projectFiles, the Set props, handlers) come from ProjectView as stable
// useState/useMemo/useCallback values, so reference comparison is correct and
// cheap.
const ASSISTANT_MESSAGE_COMPARED_PROPS: Array<keyof Props> = [
  'message',
  'streaming',
  'showConversationTodoCard',
  'conversationTodoInput',
  'projectId',
  'conversationId',
  'projectFiles',
  'projectMetadata',
  'projectFileNames',
  'onRequestOpenFile',
  'isLast',
  'errorCardOwnerId',
  'nextUserContent',
  'forking',
  'suppressDirectionForms',
  // Memoized + stable from ChatPane; compared so a late skill-list load
  // refreshes the featured next-step rows' `@skill` hover detail and the
  // More → Design toolbox global resources.
  'toolboxSkillNames',
  'nextStepSkills',
  'nextStepVariant',
  // Live streaming tool input changes identity on every `tool_input_delta`.
  // ChatPane passes it only to the streaming row (undefined elsewhere), so
  // comparing it re-renders just that row as the card grows — without it the
  // memo swallows the deltas and the card only updates on the final tool_use.
  'liveToolInput',
];

function areAssistantMessagePropsEqual(prev: Props, next: Props): boolean {
  for (const key of ASSISTANT_MESSAGE_COMPARED_PROPS) {
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

/**
 * Memoized so a streamed frame only re-renders the ONE assistant message whose
 * `message` object changed identity (the streaming turn), not all N messages in
 * the conversation. See `areAssistantMessagePropsEqual` for the comparison.
 */
export const AssistantMessage = memo(AssistantMessageImpl, areAssistantMessagePropsEqual);

/**
 * Renders an assistant message as an interleaved flow of:
 *   - prose blocks (consecutive `text` events merged)
 *   - thinking blocks (collapsible)
 *   - grouped tool action cards — runs of consecutive same-name tools
 *     collapse into a single pill ("Editing ×3, Done") that expands to show
 *     the individual tool cards. Mirrors the chat surface in screenshot 9.
 *   - status pills
 */
function AssistantMessageImpl({
  message,
  streaming,
  liveToolInput,
  showConversationTodoCard = false,
  conversationTodoInput = null,
  projectId = null,
  conversationId = null,
  projectFiles = [],
  projectMetadata,
  projectFileNames,
  onRequestOpenFile,
  isLast,
  errorCardOwnerId = null,
  nextUserContent,
  onOpenQuestions,
  onContinueRemainingTasks,
  onForkFromMessage,
  forking = false,
  onFeedback,
  suppressDirectionForms = false,
  onToolboxAction,
  onNextStepPromptAction,
  onPickSkill,
  onArtifactDownload,
  nextStepSkills,
  toolboxSkillNames,
  nextStepVariant = 'default',
}: Props) {
  const t = useT();
  const events =
    (message.events?.length ?? 0) > 0
      ? message.events!
      : message.content.trim()
        ? ([{ kind: "text", text: message.content }] satisfies AgentEvent[])
        : [];
  const displayEvents = useMemo(() => dedupeToolUsesById(events), [events]);
  // ChatPane renders the canonical TodoWrite card as a standalone chat row, so
  // we strip TodoWrite tool-groups out of the per-message flow to avoid the
  // same task list rendering twice.
  const settledUseIds = useMemo(
    () => new Set(displayEvents.filter((e) => e.kind === "tool_use").map((e) => e.id)),
    [displayEvents],
  );
  // Live code boxes (Write/Edit streaming) append after everything else.
  const liveCodeBlocks = useMemo<Block[]>(() => {
    if (!streaming || !liveToolInput) return [];
    const out: Block[] = [];
    for (const [id, entry] of Object.entries(liveToolInput)) {
      if (settledUseIds.has(id)) continue;
      if (!isLiveCodeToolName(entry.name)) continue;
      out.push({ kind: "live-tool", id, name: entry.name, raw: entry.text });
    }
    return out;
  }, [streaming, liveToolInput, settledUseIds]);
  // Compose the block list, then run the strip/suppress pipeline once.
  const visibleDisplayEvents = useMemo(
    () => filterUserVisibleFileEvents(displayEvents),
    [displayEvents],
  );
  const blocks = useMemo(() => {
    const rawBlocks = [...buildBlocks(visibleDisplayEvents), ...liveCodeBlocks];
    return placeConversationTodoCard(
      stripEmptyThinkingBlocks(suppressDuplicateQuestionForms(rawBlocks)),
      {
        show: showConversationTodoCard,
        input: conversationTodoInput,
      },
    );
  }, [visibleDisplayEvents, liveCodeBlocks, showConversationTodoCard, conversationTodoInput]);
  const fileOps = useMemo(() => deriveFileOps(visibleDisplayEvents), [visibleDisplayEvents]);
  const produced = message.producedFiles ?? [];
  const displayedProduced = useMemo(
    () => {
      const linkedFiles = recoverLinkedProjectFilesFromContent(
        message.content,
        projectFiles,
        projectId,
        message,
      );
      const baseFiles =
        produced.length > 0
          ? produced
          : inferProducedFilesFromTurn({
              message,
              projectFiles,
              blocks,
              fileOps,
              streaming,
            });
      return mergeProjectFiles(baseFiles, linkedFiles);
    },
    [blocks, fileOps, message, produced, projectFiles, projectId, streaming],
  );
  const turnFileOps = useMemo(
    () => mergeProducedFilesIntoFileOps(fileOps, displayedProduced),
    [displayedProduced, fileOps],
  );
  // The single artifact the "next step" affordance anchors to: prefer the HTML
  // produced by THIS turn; if the final turn emitted none (a summary / continue
  // message) fall back to the most recently modified HTML in the project so
  // Share / Download still target the deliverable the user just made.
  const nextStepArtifactName = useMemo(
    () => pickPreviewableArtifact(displayedProduced) ?? pickLatestPreviewableArtifact(projectFiles),
    [displayedProduced, projectFiles],
  );
  const planNextStepName = useMemo(
    () => pickPlanDocument(displayedProduced) ?? pickLatestPlanDocument(projectFiles),
    [displayedProduced, projectFiles],
  );
  const isPlanNextStep = nextStepVariant === 'plan' || message.sessionMode === 'plan';
  const nextStepFileName = isPlanNextStep
    ? (planNextStepName ?? nextStepArtifactName)
    : nextStepArtifactName;
  const usage = events.find((e) => e.kind === "usage") as
    | Extract<AgentEvent, { kind: "usage" }>
    | undefined;
  const roleName = assistantRoleName(message, t);
  const roleIconId = agentIconId(message.agentId, message.agentName);
  const hasEmptyResponse = events.some(
    (e) => e.kind === "status" && e.label === "empty_response"
  );
  const unfinishedTodos = streaming ? [] : unfinishedTodosFromEvents(events);
  const runSucceeded =
    !streaming &&
    (
      message.runStatus === "succeeded" ||
      (!message.runStatus && !!message.endedAt)
    );
  const runTerminal =
    !streaming &&
    (
      (message.runStatus ? isTerminalRunStatus(message.runStatus) : false) ||
      (!message.runStatus && !!message.endedAt)
    );
  const canContinueTodos =
    !streaming &&
    !!isLast &&
    unfinishedTodos.length > 0 &&
    !!onContinueRemainingTasks;
  const canFork = !streaming && !!onForkFromMessage;
  const copyMarkdown = message.content.trim().length > 0 ? message.content : undefined;
  const showFeedback =
    !!onFeedback &&
    isFeedbackEligible({
      streaming,
      message,
      hasEmptyResponse,
      hasUnfinishedTodos: unfinishedTodos.length > 0,
    });
  const showCompletionRow =
    showFeedback ||
    streaming ||
    !!message.startedAt ||
    !!message.endedAt ||
    !!usage ||
    unfinishedTodos.length > 0 ||
    hasEmptyResponse ||
    !!copyMarkdown ||
    canFork;
  const effectiveNextStepVariant: NextStepActionsVariant =
    nextStepVariant === 'default' && (!runSucceeded || !nextStepArtifactName)
      ? 'project-incomplete'
      : nextStepVariant;
  const hasNextStepPrimary =
    effectiveNextStepVariant === 'plan'
      ? !!onNextStepPromptAction
      : effectiveNextStepVariant === 'project-incomplete'
        ? !!onNextStepPromptAction ||
          !!onToolboxAction ||
          (!!nextStepArtifactName && !!onArtifactDownload)
        : false;
  const showNextStepActions =
    CHAT_NEXT_STEP_ACTIONS_ENABLED &&
    !streaming &&
    runTerminal &&
    !!isLast &&
    hasNextStepPrimary;
  // Pre-output vs working: before any real content (text / thinking / tools /
  // files) the footer shimmers "Preparing…"; the moment content lands it
  // flips to "Working". The elapsed clock stays anchored to the persisted run
  // start so switching project tabs or remounting the message cannot restart it.
  const hasContent = blocks.some((b) => b.kind !== "status") || turnFileOps.length > 0;
  const preparing = streaming && !hasContent;
  const preparingStatus =
    preparing && events.some((e) => e.kind === "status" && e.label === "provider_busy")
      ? "provider_busy"
      : preparing && events.some((e) => e.kind === "status" && e.label === "thinking")
        ? "thinking"
        : "preparing";

  // Index of the trailing text block — the streaming caret rides the end of
  // the last prose block so it tracks the final character as tokens arrive.
  let lastTextBlockIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === "text") {
      lastTextBlockIndex = i;
      break;
    }
  }

  return (
    <div className="msg assistant">
      <div className="role">
        <AgentIcon id={roleIconId} size={20} className="role-agent-icon" />
        <span className="role-name">{roleName}</span>
        {typeof message.roleRef === 'string' && message.roleRef.startsWith('role:') ? (
          // MatOS member attribution: which role ("department member")
          // produced this turn — the group-chat identity marker.
          <span className="role-matos-chip" title={message.roleRef}>
            {message.roleRef.replace(/^role:/, '')}
          </span>
        ) : null}
      </div>
      <div className="assistant-flow">
        {blocks.map((b, i) => {
          if (b.kind === "text")
            return (
              <ProseBlock
                key={i}
                text={b.text}
                hideRecoveredHtmlFallback={(message.agentId === "grok-build" || message.agentId === "claude") && !streaming}
                assistantMessageId={message.id}
                isLastAssistant={!!isLast}
                streaming={streaming}
                showStreamCursor={streaming && i === lastTextBlockIndex}
                nextUserContent={nextUserContent}
                suppressDirectionForms={suppressDirectionForms}
                onOpenQuestions={onOpenQuestions}
                projectId={projectId}
                conversationId={conversationId}
                runId={message.runId ?? null}
                projectFileNames={projectFileNames}
                onRequestOpenFile={onRequestOpenFile}
              />
            );
          if (b.kind === "thinking")
            // Thinking is only "in progress" while this is the trailing block.
            // Once any block (prose / tools) lands after it, the model has
            // moved past thinking, so the block flips to its finished state.
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                streaming={streaming && i === blocks.length - 1}
              />
            );
          if (b.kind === "tool-group") {
            return (
              <ToolGroupCard
                key={i}
                items={b.items}
                runStreaming={streaming}
                runSucceeded={runSucceeded}
                projectFileNames={projectFileNames}
                onRequestOpenFile={onRequestOpenFile}
              />
            );
          }
          if (b.kind === "live-tool") {
            return <LiveCodeBox key={b.id} name={b.name} raw={b.raw} />;
          }
          if (b.kind === "status") {
            // Suppress this message's gray error pill ONLY when ChatPane is
            // rendering the top-level error card for it (the last failed run).
            // Other failed turns — older history, or once a follow-up makes
            // this no longer the last assistant message — keep their pill so
            // the error detail still survives reload / history review.
            if (b.label === "error" && message.id === errorCardOwnerId) return null;
            // The pre-output "initializing" status is surfaced by the footer's
            // shimmering "Preparing…" label instead of its own pill.
            if (b.label === "initializing") return null;
            // Retry state is likewise owned by the footer, where it replaces
            // the ambiguous Preparing label with a localized busy message.
            if (b.label === "provider_busy") return null;
            return <StatusPill key={i} label={b.label} detail={b.detail} />;
          }
          return null;
        })}
        {turnFileOps.length > 0 ? (
          <FileOpsSummary
            entries={turnFileOps}
            streaming={streaming}
            projectFileNames={projectFileNames}
            onRequestOpenFile={onRequestOpenFile}
          />
        ) : null}
        {!streaming && turnFileOps.length === 0 && displayedProduced.length > 0 && projectId ? (
          <ProducedFiles
            files={displayedProduced}
            projectId={projectId}
            onRequestOpenFile={onRequestOpenFile}
          />
        ) : null}
        {!streaming && unfinishedTodos.length > 0 ? (
          <UnfinishedTodosPanel
            todos={unfinishedTodos}
            canContinue={canContinueTodos}
            onContinue={() => onContinueRemainingTasks?.(unfinishedTodos)}
          />
        ) : null}
        {showCompletionRow ? (
          <div className="assistant-completion-row">
            {showFeedback ? (
              <AssistantFeedback
                feedback={message.feedback}
                onFeedback={onFeedback}
                projectId={projectId}
                conversationId={conversationId}
                runId={message.runId ?? null}
                assistantMessageId={message.id}
                footerProps={{
                  streaming,
                  canceled: message.runStatus === 'canceled',
                  startedAt: message.startedAt,
                  endedAt: message.endedAt,
                  usage,
                  hasUnfinishedTodos: unfinishedTodos.length > 0,
                  hasEmptyResponse,
                  preparing,
                  preparingStatus,
                  copyMarkdown,
                  exportProjectId: projectId ?? undefined,
                  onFork: canFork ? onForkFromMessage : undefined,
                  forking,
                  forceVisible: true,
                  isLast: !!isLast,
                }}
              />
            ) : (
              <AssistantFooter
                streaming={streaming}
                canceled={message.runStatus === 'canceled'}
                startedAt={message.startedAt}
                endedAt={message.endedAt}
                usage={usage}
                hasUnfinishedTodos={unfinishedTodos.length > 0}
                hasEmptyResponse={hasEmptyResponse}
                preparing={preparing}
                preparingStatus={preparingStatus}
                copyMarkdown={copyMarkdown}
                exportProjectId={projectId ?? undefined}
                onFork={canFork ? onForkFromMessage : undefined}
                forking={forking}
                isLast={!!isLast}
              />
            )}
          </div>
        ) : null}
        {showNextStepActions ? (
          <NextStepActions
            fileName={isLast ? nextStepFileName : null}
            planFileName={isLast ? planNextStepName : null}
            artifactFileName={isLast ? nextStepArtifactName : null}
            onToolboxAction={isLast ? onToolboxAction : undefined}
            onPromptAction={isLast ? onNextStepPromptAction : undefined}
            onPickSkill={isLast ? onPickSkill : undefined}
            onDownload={isLast && nextStepFileName ? onArtifactDownload : undefined}
            skills={isLast ? nextStepSkills : undefined}
            toolboxSkillNames={isLast ? toolboxSkillNames : undefined}
            variant={effectiveNextStepVariant}
          />
        ) : null}
      </div>
    </div>
  );
}

// Return the name of the first previewable HTML artifact among the produced
// files, or null if this turn produced no shareable/polishable preview. Only
// HTML files drive the preview workspace's Share/Export menu and the
// visual-polish loop, so the "next step" affordance keys off them.
function isPreviewableHtml(f: ProjectFile): boolean {
  return f.kind === "html" || /\.html?$/i.test(f.name);
}

function pickPreviewableArtifact(files: ProjectFile[]): string | null {
  const html = files.find(isPreviewableHtml);
  return html ? html.name : null;
}

// Fallback for when the card-bearing turn produced no HTML itself: pick the
// most recently modified HTML in the project (the deliverable the user just
// made / is looking at) rather than whichever HTML happens to be first, which
// would attach Share/Download to an arbitrary file in a multi-artifact project.
function pickLatestPreviewableArtifact(files: ProjectFile[]): string | null {
  let latest: ProjectFile | null = null;
  for (const f of files) {
    if (!isPreviewableHtml(f)) continue;
    if (!latest || (f.mtime ?? 0) > (latest.mtime ?? 0)) latest = f;
  }
  return latest ? latest.name : null;
}

const PLAN_DOCUMENT_EXCLUDES = new Set(['design.md', 'brand-system.md']);

function isPlanDocument(f: ProjectFile): boolean {
  const name = f.name.toLowerCase();
  if (!/\.mdx?$/.test(name)) return false;
  const basename = name.split('/').pop() ?? name;
  return !PLAN_DOCUMENT_EXCLUDES.has(basename);
}

function pickPlanDocument(files: ProjectFile[]): string | null {
  const doc = files.find(isPlanDocument);
  return doc ? doc.name : null;
}

export function pickLatestPlanDocument(files: ProjectFile[]): string | null {
  let latest: ProjectFile | null = null;
  for (const f of files) {
    if (!isPlanDocument(f)) continue;
    if (!latest || (f.mtime ?? 0) > (latest.mtime ?? 0)) latest = f;
  }
  return latest ? latest.name : null;
}

function inferProducedFilesFromTurn({
  message,
  projectFiles,
  blocks,
  fileOps,
  streaming,
}: {
  message: ChatMessage;
  projectFiles: ProjectFile[];
  blocks: Block[];
  fileOps: FileOpEntry[];
  streaming: boolean;
}): ProjectFile[] {
  if (streaming || message.role !== "assistant") return [];
  if (message.runStatus !== "succeeded") return [];
  if (!message.startedAt || !message.endedAt) return [];
  if (blocks.some((block) => block.kind === "text" || block.kind === "tool-group")) return [];
  if (fileOps.length > 0) return [];
  const start = message.startedAt - 1_000;
  const end = message.endedAt + 60_000;
  return filterImplicitProducedFiles(
    projectFiles.filter((file) => {
      if (file.type === "dir") return false;
      if (!file.name || file.name.startsWith(".")) return false;
      if (file.name.includes("/.")) return false;
      return file.mtime >= start && file.mtime <= end;
    }),
  ).sort((a, b) => b.mtime - a.mtime);
}

function mergeProducedFilesIntoFileOps(
  fileOps: FileOpEntry[],
  produced: ProjectFile[],
): FileOpEntry[] {
  if (produced.length === 0) return fileOps;
  const seen = new Set<string>();
  for (const entry of fileOps) {
    seen.add(normalizeTouchedPath(entry.path));
    seen.add(normalizeTouchedPath(entry.fullPath));
  }

  const merged = [...fileOps];
  for (const file of produced) {
    const fullPath = file.path || file.name;
    const path = file.name || fullPath;
    if (!path || seen.has(normalizeTouchedPath(path)) || seen.has(normalizeTouchedPath(fullPath))) {
      continue;
    }
    seen.add(normalizeTouchedPath(path));
    seen.add(normalizeTouchedPath(fullPath));
    merged.push({
      path,
      fullPath,
      ops: ["write"],
      opCounts: { read: 0, write: 1, edit: 0, delete: 0 },
      total: 1,
      status: "done",
    });
  }
  return merged;
}

function normalizeTouchedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function recoverLinkedProjectFilesFromContent(
  content: string,
  projectFiles: ProjectFile[],
  projectId?: string | null,
  message?: ChatMessage,
): ProjectFile[] {
  if (!content || projectFiles.length === 0) return [];
  const projectFileNames = new Set<string>();
  const byPath = new Map<string, ProjectFile>();
  const basenameFiles = new Map<string, ProjectFile | null>();
  for (const file of projectFiles) {
    if (file.type === "dir") continue;
    for (const value of [file.name, file.path, file.localPath]) {
      if (!value) continue;
      const normalized = normalizeTouchedPath(value);
      projectFileNames.add(normalized);
      byPath.set(normalized, file);
      const basename = normalized.split("/").filter(Boolean).pop();
      if (basename && basename !== normalized) {
        basenameFiles.set(
          basename,
          basenameFiles.has(basename) ? null : file,
        );
      }
    }
  }
  for (const [basename, file] of basenameFiles) {
    if (!file) continue;
    projectFileNames.add(basename);
    byPath.set(basename, file);
  }
  if (projectFileNames.size === 0) return [];

  const recovered = new Map<string, ProjectFile>();
  for (const href of extractContentFileReferences(content, projectFileNames)) {
    const filePath = asInProjectFilePath(href, projectFileNames, projectId);
    if (!filePath) continue;
    const file = byPath.get(normalizeTouchedPath(filePath));
    if (!file) continue;
    if (!shouldRecoverReferencedFile(content, href, file, message)) continue;
    recovered.set(file.path || file.name, file);
  }
  return Array.from(recovered.values());
}

function extractContentFileReferences(
  content: string,
  projectFileNames: ReadonlySet<string>,
): string[] {
  const refs = new Set<string>();
  for (const href of extractMarkdownLinkHrefs(content)) refs.add(href);
  for (const ref of extractInlineCodeFileRefs(content)) refs.add(ref);
  for (const ref of extractKnownProjectFileRefs(content, projectFileNames)) refs.add(ref);
  return Array.from(refs);
}

function extractInlineCodeFileRefs(content: string): string[] {
  const refs: string[] = [];
  const codePattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(content)) !== null) {
    const raw = match[1]?.trim();
    if (raw && looksLikeFileReference(raw)) refs.push(raw);
  }
  return refs;
}

function shouldRecoverReferencedFile(
  content: string,
  rawRef: string,
  file: ProjectFile,
  message?: ChatMessage,
): boolean {
  if (isFileMtimeInsideRun(file, message)) return true;
  return contentHasOutputHintForFile(content, rawRef, file);
}

function isFileMtimeInsideRun(file: ProjectFile, message?: ChatMessage): boolean {
  if (!message?.startedAt || !message.endedAt) return false;
  const start = message.startedAt - 1_000;
  const end = message.endedAt + 60_000;
  return file.mtime >= start && file.mtime <= end;
}

function contentHasOutputHintForFile(
  content: string,
  rawRef: string,
  file: ProjectFile,
): boolean {
  const refs = [
    rawRef,
    file.name,
    file.path,
    file.localPath,
    file.name.split("/").filter(Boolean).pop(),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return content.split(/\r?\n/).some((line) => {
    if (!lineHasOutputFileHint(line)) return false;
    return refs.some((ref) => lineContainsFileReference(line, normalizeTouchedPath(ref)));
  });
}

function lineHasOutputFileHint(line: string): boolean {
  return /(?:\b(?:add(?:ed)?|built|chang(?:e|ed)|creat(?:e|ed)|deliverable|edit(?:ed)?|file(?:s)?|generat(?:e|ed)|modif(?:y|ied)|output|produc(?:e|ed)|sav(?:e|ed)|updat(?:e|ed)|writ(?:e|ten|ing)|wrote)\b|产物|创建|生成|交付|输出|保存|文件|新增|更新|修改|完成|已创建|已生成|已写入|写入)/i.test(line);
}

function looksLikeFileReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  return /(?:^|[/\\])[^/\\]+\.[a-z0-9]{1,12}(?:[#?].*)?$/i.test(trimmed);
}

function extractMarkdownLinkHrefs(content: string): string[] {
  const hrefs: string[] = [];
  const linkPattern = /(!?)\[[^\]\n]*\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(content)) !== null) {
    if (match[1] === "!") continue;
    const href = normalizeMarkdownHref(match[2] ?? "");
    if (href) hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end > 1 ? trimmed.slice(1, end).trim() : null;
  }
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(trimmed);
  return (titled?.[1] ?? trimmed).trim() || null;
}

function mergeProjectFiles(
  first: ProjectFile[],
  second: ProjectFile[],
): ProjectFile[] {
  const visible = filterUserVisibleProjectFiles([...first, ...second]);
  if (visible.length <= 1) return visible;
  const seen = new Set<string>();
  const merged: ProjectFile[] = [];
  for (const file of visible) {
    const key = normalizeTouchedPath(file.path || file.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

// A run that reached a terminal state — succeeded, failed, or canceled — has a
// settled assistant turn worth rating. Only queued/running turns are still in
// flight, so they have no outcome to give feedback on yet. Feedback used to be
// gated on success alone, which silently dropped the thumbs row on failed and
// canceled turns even though those are exactly the outcomes a user most wants
// to thumbs-down.
function isTerminalRunStatus(
  status: NonNullable<ChatMessage["runStatus"]>
): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function isFeedbackEligible({
  streaming,
  message,
  hasEmptyResponse,
  hasUnfinishedTodos,
}: {
  streaming: boolean;
  message: ChatMessage;
  hasEmptyResponse: boolean;
  hasUnfinishedTodos: boolean;
}): boolean {
  if (streaming || hasEmptyResponse || hasUnfinishedTodos) return false;
  if (message.runStatus) return isTerminalRunStatus(message.runStatus);
  return !!message.endedAt;
}

// The agent name without the trailing model id — the role header shows the
// brand logo + name only, so the `· model` suffix is dropped there.
export function assistantRoleName(
  message: ChatMessage,
  t: TranslateFn
): string {
  const fromName = message.agentName?.trim();
  if (fromName) {
    const base = fromName.split(" · ")[0]?.trim() || fromName;
    return exactAgentDisplayName(base) ?? base;
  }
  const fromId = agentDisplayName(message.agentId);
  if (fromId) return fromId;
  const starting = message.events?.find(
    (e) => e.kind === "status" && e.label === "starting" && e.detail
  ) as Extract<AgentEvent, { kind: "status" }> | undefined;
  return agentDisplayName(starting?.detail) ?? t("assistant.role");
}

export function assistantRoleLabel(
  message: ChatMessage,
  t: TranslateFn
): string {
  const model = assistantModelDetail(message);
  const fromName = message.agentName?.trim();
  if (fromName)
    return appendRoleModel(exactAgentDisplayName(fromName) ?? fromName, model);
  const fromId = agentDisplayName(message.agentId);
  if (fromId) return appendRoleModel(fromId, model);
  const starting = message.events?.find(
    (e) => e.kind === "status" && e.label === "starting" && e.detail
  ) as Extract<AgentEvent, { kind: "status" }> | undefined;
  return appendRoleModel(
    agentDisplayName(starting?.detail) ?? t("assistant.role"),
    model
  );
}

function assistantModelDetail(message: ChatMessage): string | null {
  const initializing = message.events?.find(
    (e) => e.kind === "status" && e.label === "initializing" && e.detail
  ) as Extract<AgentEvent, { kind: "status" }> | undefined;
  const detail = initializing?.detail?.trim();
  if (!detail || detail === "default") return null;
  return detail;
}


function appendRoleModel(label: string, model: string | null): string {
  if (!model || label.includes(" · ")) return label;
  return `${label} · ${model}`;
}

interface AssistantFooterProps {
  streaming: boolean;
  canceled?: boolean;
  startedAt: number | undefined;
  endedAt: number | undefined;
  usage: Extract<AgentEvent, { kind: "usage" }> | undefined;
  hasUnfinishedTodos: boolean;
  hasEmptyResponse: boolean;
  // Pre-output phase: streaming but nothing rendered yet. The label shimmers
  // "Preparing…"; once content lands it flips to "Working".
  preparing?: boolean;
  preparingStatus?: "preparing" | "thinking" | "provider_busy";
  copyMarkdown?: string;
  exportProjectId?: string;
  onFork?: () => void;
  forking?: boolean;
  feedbackControls?: ReactNode;
  forceVisible?: boolean;
  // The most recent assistant reply keeps its footer permanently visible
  // (not hover-gated), matching Lobe Chat's persistent last-message footer.
  isLast?: boolean;
}

function AssistantFooter({
  streaming,
  canceled = false,
  startedAt,
  endedAt,
  usage,
  hasUnfinishedTodos,
  hasEmptyResponse,
  preparing = false,
  preparingStatus = "preparing",
  copyMarkdown,
  exportProjectId,
  onFork,
  forking = false,
  feedbackControls,
  forceVisible = false,
  isLast = false,
}: AssistantFooterProps) {
  const t = useT();
  const elapsed = useLiveElapsed(streaming, startedAt, endedAt, usage?.durationMs);
  const formattedCost =
    typeof usage?.costUsd === "number" &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd > 0
      ? usage.costUsd.toFixed(4)
      : "";
  const costLabel = formattedCost && formattedCost !== "0.0000" ? ` · $${formattedCost}` : "";
  if (
    !forceVisible &&
    !streaming &&
    !canceled &&
    !elapsed &&
    !usage &&
    !hasUnfinishedTodos &&
    !hasEmptyResponse &&
    !copyMarkdown &&
    !onFork
  )
    return null;
  return (
    <div
      className="assistant-footer"
      data-unfinished={hasUnfinishedTodos ? "true" : "false"}
      data-streaming={streaming ? "true" : "false"}
      data-last={isLast ? "true" : "false"}
    >
      <span className="dot" data-active={streaming ? "true" : "false"} />
      <span className={`assistant-label${streaming && preparing ? " shimmer-text shimmer-prepare" : ""}`}>
        {streaming
          ? preparing
            ? preparingStatus === "provider_busy"
              ? t("assistant.statusProviderBusy")
              : preparingStatus === "thinking"
                ? t("assistant.statusThinking")
                : t("assistant.statusPreparing")
            : t("assistant.workingLabel")
          : canceled
          ? t("designs.status.canceled")
          : hasEmptyResponse
          ? t("assistant.emptyResponseLabel")
          : hasUnfinishedTodos
          ? t("assistant.unfinishedLabel")
          : t("assistant.doneLabel")}
      </span>
      <span className="assistant-stats">
        {elapsed}
        {usage?.outputTokens != null
          ? ` · ${t("assistant.outTokens", { n: usage.outputTokens })}`
          : ""}
        {costLabel}
      </span>
      {copyMarkdown || onFork || feedbackControls ? (
        <span className="assistant-footer-controls">
          {copyMarkdown ? <AssistantMarkdownCopyButton markdown={copyMarkdown} /> : null}
          {copyMarkdown ? <MarkdownExportMenu markdown={copyMarkdown} title="MatOS" projectId={exportProjectId} disabled={streaming} /> : null}
          {onFork ? (
            <AssistantForkButton
              disabled={forking}
              onFork={onFork}
            />
          ) : null}
          {feedbackControls}
        </span>
      ) : null}
    </div>
  );
}

function AssistantForkButton({
  disabled,
  onFork,
}: {
  disabled: boolean;
  onFork: () => void;
}) {
  const t = useT();
  const label = disabled
    ? t("assistant.forkingConversation")
    : t("assistant.forkConversation");
  return (
    <button
      type="button"
      className="assistant-copy-button od-tooltip"
      disabled={disabled}
      data-testid="assistant-fork-button"
      data-tooltip={label}
      data-tooltip-placement="top"
      onClick={onFork}
      aria-label={label}
      title={label}
    >
      <Icon name={disabled ? "spinner" : "fork"} size={13} />
    </button>
  );
}

function AssistantMarkdownCopyButton({ markdown }: { markdown: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const ok = await copyToClipboard(markdown);
    if (!ok) return;
    setCopied(true);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = undefined;
    }, 2000);
  }

  const label = copied ? t("chat.copyDone") : t("assistant.copyMarkdown");
  return (
    <button
      type="button"
      className="assistant-copy-button od-tooltip"
      data-testid="assistant-copy-markdown"
      data-copied={copied ? "true" : "false"}
      data-tooltip={label}
      data-tooltip-placement="top"
      onClick={() => {
        void handleCopy();
      }}
      aria-label={label}
      title={label}
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
}

function AssistantFeedback({
  feedback,
  onFeedback,
  footerProps,
  projectId,
  conversationId,
  runId,
  assistantMessageId,
}: {
  feedback: ChatMessage["feedback"];
  onFeedback: (change: ChatMessageFeedbackChange) => void;
  footerProps: AssistantFooterProps;
  projectId: string | null;
  conversationId: string | null;
  runId: string | null;
  assistantMessageId: string;
}) {
  const t = useT();
  const [burstKey, setBurstKey] = useState(0);
  const [reasonRating, setReasonRating] =
    useState<ChatMessageFeedbackRating | null>(null);
  const reasonsRef = useRef<HTMLDivElement | null>(null);
  const [draftReasonCodes, setDraftReasonCodes] = useState<
    Set<ChatMessageFeedbackReasonCode>
  >(() => new Set());
  const [customReason, setCustomReason] = useState("");
  const selected = feedback?.rating;
  useEffect(() => {
    if (selected) return;
    setReasonRating(null);
  }, [selected]);
  useEffect(() => {
    if (!reasonRating) return;
    reasonsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [reasonRating]);
  const toggleFeedback = (rating: ChatMessageFeedbackRating) => {
    const nextRating = selected === rating ? null : rating;
    if (nextRating === "positive") setBurstKey((key) => key + 1);
    setDraftReasonCodes(new Set());
    setCustomReason("");
    setReasonRating(nextRating);
    onFeedback(nextRating ? { rating: nextRating } : null);
  };
  const toggleReasonCode = (code: ChatMessageFeedbackReasonCode) => {
    const next = new Set(draftReasonCodes);
    if (next.has(code)) {
      next.delete(code);
      if (code === "other") setCustomReason("");
    } else {
      next.add(code);
    }
    setDraftReasonCodes(next);
  };
  const submitReasons = () => {
    if (!reasonRating) return;
    const trimmedCustomReason = customReason.trim();
    const reasonCodes = [...draftReasonCodes];
    onFeedback({
      rating: reasonRating,
      reasonCodes,
      customReason:
        draftReasonCodes.has("other") && trimmedCustomReason
          ? trimmedCustomReason
          : undefined,
      reasonsSubmittedAt: Date.now(),
    });
    setReasonRating(null);
  };
  const reasonOptions = reasonRating
    ? feedbackReasonOptions(reasonRating, t)
    : [];
  const reasonEmoji = reasonRating === "positive" ? "😊" : "😔";
  const showOtherInput = draftReasonCodes.has("other");
  const canSubmit =
    draftReasonCodes.size > 0 || (showOtherInput && customReason.trim().length > 0);
  const controls = (
    <span
      className="assistant-feedback"
      role="group"
      aria-label={t("assistant.feedbackPrompt")}
    >
      <button
        type="button"
        className="assistant-feedback-button od-tooltip"
        data-testid="assistant-feedback-positive"
        data-selected={selected === "positive" ? "true" : "false"}
        data-tooltip={t("assistant.feedbackPositive")}
        data-tooltip-placement="top"
        aria-pressed={selected === "positive"}
        aria-label={t("assistant.feedbackPositive")}
        title={t("assistant.feedbackPositive")}
        onClick={() => toggleFeedback("positive")}
      >
        <Icon name="thumbs-up" size={13} />
        {burstKey > 0 ? (
          <span
            key={burstKey}
            className="assistant-feedback-burst"
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="assistant-feedback-button od-tooltip"
        data-testid="assistant-feedback-negative"
        data-selected={selected === "negative" ? "true" : "false"}
        data-tooltip={t("assistant.feedbackNegative")}
        data-tooltip-placement="top"
        aria-pressed={selected === "negative"}
        aria-label={t("assistant.feedbackNegative")}
        title={t("assistant.feedbackNegative")}
        onClick={() => toggleFeedback("negative")}
      >
        <Icon name="thumbs-down" size={13} />
      </button>
    </span>
  );
  return (
    <div className="assistant-feedback-wrap">
      <AssistantFooter {...footerProps} feedbackControls={controls} />
      {reasonRating ? (
        <div className="assistant-feedback-reasons" ref={reasonsRef}>
          <div className="assistant-feedback-reason-title">
            <span>{t("assistant.feedbackReasonTitle")}</span>
            <span className="assistant-feedback-reason-emoji" aria-hidden="true">
              {reasonEmoji}
            </span>
          </div>
          <div className="assistant-feedback-reason-options">
            {reasonOptions.map((option) => (
              <label
                key={option.code}
                className="assistant-feedback-reason-option"
                data-selected={draftReasonCodes.has(option.code) ? "true" : "false"}
              >
                <input
                  type="checkbox"
                  checked={draftReasonCodes.has(option.code)}
                  onChange={() => toggleReasonCode(option.code)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {showOtherInput ? (
            <textarea
              className="assistant-feedback-custom"
              value={customReason}
              placeholder={t("assistant.feedbackReasonPlaceholder")}
              rows={2}
              onChange={(event) => setCustomReason(event.target.value)}
            />
          ) : null}
          {/* MatOS has no public Discord community, so the upstream Open
              Design Discord invite notes are intentionally not rendered.
              Feedback details flow through the in-product feedback page. */}
          <div className="assistant-feedback-actions">
            <button
              type="button"
              className="assistant-feedback-submit"
              disabled={!canSubmit}
              onClick={submitReasons}
            >
              {t("assistant.feedbackReasonSubmit")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function feedbackReasonOptions(
  rating: ChatMessageFeedbackRating,
  t: TranslateFn,
): Array<{ code: ChatMessageFeedbackReasonCode; label: string }> {
  const codes: ChatMessageFeedbackReasonCode[] =
    rating === "positive"
      ? [
          "matched_request",
          "strong_visual",
          "useful_structure",
          "easy_to_continue",
          "other",
        ]
      : [
          "missed_request",
          "weak_visual",
          "incomplete_output",
          "hard_to_use",
          "other",
        ];
  return codes.map((code) => ({ code, label: feedbackReasonLabel(code, t) }));
}

function feedbackReasonLabel(
  code: ChatMessageFeedbackReasonCode,
  t: TranslateFn,
): string {
  switch (code) {
    case "matched_request":
      return t("assistant.feedbackReasonPositiveMatched");
    case "strong_visual":
      return t("assistant.feedbackReasonPositiveVisual");
    case "useful_structure":
      return t("assistant.feedbackReasonPositiveUseful");
    case "easy_to_continue":
      return t("assistant.feedbackReasonPositiveEasy");
    case "missed_request":
      return t("assistant.feedbackReasonNegativeMissed");
    case "weak_visual":
      return t("assistant.feedbackReasonNegativeVisual");
    case "incomplete_output":
      return t("assistant.feedbackReasonNegativeIncomplete");
    case "hard_to_use":
      return t("assistant.feedbackReasonNegativeHard");
    case "other":
      return t("assistant.feedbackReasonOther");
  }
  return code;
}

function UnfinishedTodosPanel({
  todos,
  canContinue,
  onContinue,
}: {
  todos: TodoItem[];
  canContinue: boolean;
  onContinue: () => void;
}) {
  const t = useT();
  const visible = todos.slice(0, 3);
  const hiddenCount = todos.length - visible.length;
  return (
    <div className="unfinished-todos">
      <div className="unfinished-todos-head">
        <span className="unfinished-todos-title">
          {t("assistant.unfinishedSummary", { n: todos.length })}
        </span>
        {canContinue ? (
          <button
            type="button"
            className="unfinished-todos-continue"
            onClick={onContinue}
          >
            {t("assistant.continueRemaining")}
          </button>
        ) : null}
      </div>
      <ul className="unfinished-todos-list">
        {visible.map((todo, i) => (
          <li key={`${todo.status}-${todo.content}-${i}`}>
            {todo.status === "in_progress" && todo.activeForm
              ? todo.activeForm
              : todo.content}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <div className="unfinished-todos-more">
          {t("assistant.unfinishedMore", { n: hiddenCount })}
        </div>
      ) : null}
    </div>
  );
}

function ProducedFiles({
  files,
  projectId,
  onRequestOpenFile,
}: {
  files: ProjectFile[];
  projectId: string;
  onRequestOpenFile?: (name: string) => void;
}) {
  const t = useT();
  return (
    <div className="produced-files">
      <div className="produced-files-label">{t("assistant.producedFiles")}</div>
      <div className="produced-files-list">
        {files.map((f) => (
          <div key={f.name} className="produced-file">
            <span className="produced-file-icon" aria-hidden>
              <Icon name={kindIconName(f.kind)} size={14} />
            </span>
            <span className="produced-file-name" title={f.name}>
              {f.name}
            </span>
            <span className="produced-file-size">{humanBytes(f.size)}</span>
            <div className="produced-file-actions">
              {onRequestOpenFile ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onRequestOpenFile(f.name)}
                >
                  {t("assistant.openFile")}
                </button>
              ) : null}
              <a
                className="ghost-link"
                href={projectDownloadUrl(projectId, f.name)}
                download={f.name}
              >
                {t("assistant.downloadFile")}
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function kindIconName(
  kind: ProjectFile["kind"]
): "file-code" | "image" | "pencil" | "file" {
  if (kind === "html") return "file-code";
  if (kind === "image") return "image";
  if (kind === "code") return "file-code";
  return "file";
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}


function ProseBlock({
  text,
  hideRecoveredHtmlFallback,
  assistantMessageId,
  isLastAssistant,
  streaming,
  showStreamCursor,
  nextUserContent,
  suppressDirectionForms,
  onOpenQuestions,
  projectId,
  conversationId,
  runId,
  projectFileNames,
  onRequestOpenFile,
}: {
  text: string;
  hideRecoveredHtmlFallback?: boolean;
  assistantMessageId: string;
  isLastAssistant: boolean;
  streaming: boolean;
  showStreamCursor?: boolean;
  nextUserContent?: string;
  suppressDirectionForms: boolean;
  projectId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  projectFileNames?: Set<string>;
  onOpenQuestions?: (request?: QuestionFormOpenRequest) => void;
  onRequestOpenFile?: (name: string) => void;
}) {
  const t = useT();
  const cleaned = useMemo(() => {
    const stripped = stripArtifact(text);
    return hideRecoveredHtmlFallback ? stripRecoveredHtmlFallbackForDisplay(stripped, text) : stripped;
  }, [hideRecoveredHtmlFallback, text]);
  // While the latest turn is still streaming a not-yet-closed question-form,
  // drop the partial `<question-form>{…` markup from the prose so the chat
  // doesn't flash raw JSON; we surface a banner for it instead. The actual
  // form streams into the right-hand Questions tab.
  const { text: visibleText, hadOpenForm } = useMemo(() => {
    if (!(isLastAssistant && streaming)) return { text: cleaned, hadOpenForm: false };
    const form = stripTrailingOpenQuestionForm(cleaned);
    return { text: form.text, hadOpenForm: form.hadOpenForm };
  }, [cleaned, isLastAssistant, streaming]);
  // While an `<artifact type="text/html">` is still streaming (no closing tag
  // yet), surface its body in a live code panel instead of leaking the raw
  // tag + half-written HTML as Markdown text. Once it closes, stripArtifact
  // removes it and the file/preview panel takes over — so this only fires
  // mid-stream.
  const { head, live } = useMemo(
    () => (streaming ? splitStreamingArtifact(visibleText) : { head: visibleText, live: null }),
    [visibleText, streaming]
  );
  const segments = useMemo(() => splitOnQuestionForms(head), [head]);
  // Route relative file-link clicks (`template.html`, `subdir/hero.html`)
  // through the workspace tab opener. Without this, Electron's window-open
  // handler creates a new app window whose relative href can't resolve, and
  // the user lands on the home screen — the file is never previewed.
  const onLinkClick = useMemo<MarkdownLinkClickHandler | undefined>(() => {
    if (!onRequestOpenFile) return undefined;
    return (href, event) => {
      const path = asInProjectFilePath(href, projectFileNames, projectId);
      if (!path) return;
      event.preventDefault();
      onRequestOpenFile(path);
    };
  }, [onRequestOpenFile, projectFileNames, projectId]);
  // Each text segment is further split on `<system-reminder>` blocks (so those
  // render as their own collapsible chip instead of raw markup).
  type Renderable =
    | { key: string; kind: "text"; text: string }
    | { key: string; kind: "reminder"; text: string }
    | { key: string; kind: "form"; form: QuestionForm }
    | { key: string; kind: "suppressed-direction" };
  const renderable = segments.flatMap((seg, idx): Renderable[] => {
    if (seg.kind === "form") {
      if (suppressDirectionForms && isDirectionForm(seg.form)) {
        return [{ key: `f-${idx}`, kind: "suppressed-direction" }];
      }
      return [{ key: `f-${idx}`, kind: "form", form: seg.form }];
    }
    if (seg.text.trim().length === 0) return [];
    return splitSystemReminders(seg.text).map((s, j) => ({
      key: `t-${idx}-${j}`,
      kind: s.kind,
      text: s.text,
    }));
  });
  if (renderable.length === 0 && !live) return null;
  return (
    <div className="prose-block" data-stream-cursor={showStreamCursor && !live ? "true" : undefined}>
      {renderable.map((seg) => {
        if (seg.kind === "reminder") {
          return <SystemReminderBlock key={seg.key} text={seg.text} variant="injection" />;
        }
        if (seg.kind === "text") {
          return (
            <Fragment key={seg.key}>
              {renderMarkdown(seg.text, { onLinkClick })}
            </Fragment>
          );
        }
        if (seg.kind === "suppressed-direction") {
          return (
            <div key={seg.key} className="status-pill">
              <span className="status-label">
                Active design system selected. Visual direction is already locked.
              </span>
            </div>
          );
        }
        return (
          <FormBlock
            key={seg.key}
            form={seg.form}
            assistantMessageId={assistantMessageId}
            nextUserContent={nextUserContent}
            onOpenQuestions={onOpenQuestions}
          />
        );
      })}
      {live ? (
        <StreamingCodeCard
          titleLabel={t("tool.write")}
          metaLabel={live.title || live.identifier || undefined}
          code={live.content}
        />
      ) : null}
      {hadOpenForm ? <QuestionsBanner onOpen={onOpenQuestions} /> : null}
    </div>
  );
}

// Chat-side banner that points to the right-hand Questions tab where discovery
// forms live. The chat column always stays compact: no inline form preview,
// answered or not.
function QuestionsBanner({
  onOpen,
  answered = false,
}: {
  onOpen?: () => void;
  answered?: boolean;
}) {
  const t = useT();
  // Once the form has been answered there is nothing left to open, so the
  // banner becomes a non-interactive "done" marker: no chevron affordance, no
  // click target, muted styling.
  return (
    <button
      type="button"
      className={`questions-banner${answered ? " questions-banner-answered" : ""}`}
      data-testid="questions-banner"
      data-answered={answered ? "true" : undefined}
      disabled={answered}
      onClick={answered ? undefined : () => onOpen?.()}
    >
      <span className="questions-banner-icon" aria-hidden>
        <Icon name={answered ? "check" : "help-circle"} size={15} />
      </span>
      <span className="questions-banner-label">
        {answered ? t("questions.bannerAnswered") : t("questions.banner")}
      </span>
      {answered ? null : (
        <span className="questions-banner-cta" aria-hidden>
          <Icon name="chevron-right" size={14} />
        </span>
      )}
    </button>
  );
}

function isDirectionForm(form: QuestionForm): boolean {
  if (form.id.toLowerCase() === "direction") return true;
  if (form.title.toLowerCase().includes("visual direction")) return true;
  return form.questions.some((q) => q.type === "direction-cards");
}

function FormBlock({
  form,
  assistantMessageId,
  nextUserContent,
  onOpenQuestions,
}: {
  form: QuestionForm;
  assistantMessageId: string;
  nextUserContent?: string;
  onOpenQuestions?: (request?: QuestionFormOpenRequest) => void;
}) {
  // A "[form answers …]" reply parked right after this message means the form
  // was already submitted; the banner then renders as an answered/done state.
  const submittedFromHistory = useMemo(
    () => (nextUserContent ? parseSubmittedAnswers(form, nextUserContent) : null),
    [form, nextUserContent],
  );
  return (
    <QuestionsBanner
      answered={submittedFromHistory != null}
      onOpen={() => {
        onOpenQuestions?.({
          form,
          messageId: assistantMessageId,
          submittedAnswers: submittedFromHistory ?? undefined,
        });
      }}
    />
  );
}

function SystemReminderBlock({
  text,
  variant = "trusted",
}: {
  text: string;
  // "injection" — model-echoed <system-reminder> tag (prompt injection risk): amber warning chip.
  // "trusted"   — reserved for harness-sourced reminders; no current call sites use this default.
  variant?: "trusted" | "injection";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const preview = trimmed.split("\n")[0]?.slice(0, 120) ?? "";
  const isInjection = variant === "injection";
  return (
    <div className={`system-reminder-block${isInjection ? " injection" : ""}`}>
      <button
        className="system-reminder-toggle"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="system-reminder-icon" aria-hidden>
          <Icon name={isInjection ? "alert-triangle" : "settings"} size={12} />
        </span>
        <span className="system-reminder-label">
          {isInjection
            ? t("assistant.possiblePromptInjection")
            : t("assistant.systemReminder")}
        </span>
        <span className="system-reminder-preview">
          {open ? "" : preview}
          {!open && trimmed.length > preview.length ? "…" : ""}
        </span>
        <span className="system-reminder-chev">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
        </span>
      </button>
      {open ? <pre className="system-reminder-body">{trimmed}</pre> : null}
    </div>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const isThinking = streaming === true;
  // Thinking events carry no server timestamps, so the "用时 X 秒" duration is
  // measured client-side: stamp the start when streaming begins and freeze the
  // elapsed once it ends. Blocks restored from history never stream, so they
  // fall back to the plain "已深度思考" label with no seconds.
  const startRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  useEffect(() => {
    if (isThinking) {
      if (startRef.current === null) startRef.current = Date.now();
      setElapsedSec(null);
    } else if (startRef.current !== null) {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
      startRef.current = null;
    }
  }, [isThinking]);
  const label = isThinking
    ? t("assistant.thinking")
    : elapsedSec != null
      ? t("assistant.thoughtFor", { s: elapsedSec })
      : t("assistant.thought");
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setOpen((o) => !o)}>
        <span className={`thinking-status${isThinking ? ' op-status-running' : open ? ' thinking-status-active' : ''}`} aria-hidden>
          {isThinking
            ? <Icon name="spinner" size={14} />
            : <Icon name="sparkles" size={14} />
          }
        </span>
        <span className={`thinking-label${isThinking ? ' shimmer-text' : ''}`}>
          {label}
        </span>
        <span className="thinking-chev">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
        </span>
      </button>
      <div className={`accordion-collapsible${open ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <div className="thinking-body">{renderMarkdown(text)}</div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  label,
  detail,
}: {
  label: string;
  detail?: string | undefined;
}) {
  const variant =
    label === "error" ? "error" : label === "warning" ? "warning" : undefined;
  return (
    <div
      className={`status-pill${variant ? ` is-${variant}` : ""}`}
      data-status={label}
    >
      <span className="status-label">{label}</span>
      {detail ? <span className="status-detail">{renderStatusDetail(detail)}</span> : null}
    </div>
  );
}

function renderStatusDetail(detail: string): ReactNode {
  const segments: ReactNode[] = [];
  const urlRe = /(https?:\/\/[^\s)<>"}\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = urlRe.exec(detail))) {
    if (match.index > lastIndex) {
      segments.push(detail.slice(lastIndex, match.index));
    }
    const [href, suffix] = splitStatusDetailUrlPunctuation(match[1]!);
    segments.push(
      <a
        key={`url-${key++}`}
        className="md-link md-link-bare"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
      >
        {href}
      </a>,
    );
    if (suffix) segments.push(suffix);
    lastIndex = urlRe.lastIndex;
  }

  if (lastIndex < detail.length) {
    segments.push(detail.slice(lastIndex));
  }

  return <>{segments}</>;
}

function splitStatusDetailUrlPunctuation(url: string): [string, string] {
  const match = /([.,!?;:，。！？；：、'"」』】》〉）}\]]+)$/.exec(url);
  if (!match?.[1]) return [url, ''];
  const trimmed = url.slice(0, -match[1].length);
  return trimmed ? [trimmed, match[1]] : [url, ''];
}

interface ToolItem {
  use: Extract<AgentEvent, { kind: "tool_use" }>;
  result?: Extract<AgentEvent, { kind: "tool_result" }>;
}

// Snapshot tools (the call IS the state, later calls supersede earlier
// ones) and tools the model retries verbatim under headless-mode errors
// are noisy when stacked. Collapse identical-input neighbors to the most
// recent. Currently:
//   - TodoWrite / todowrite: the input replaces the previous list, so the
//     latest call is the only one worth showing; older identical or
//     superseded snapshots are pure duplication.
// Other tool names pass through untouched.
const SNAPSHOT_TOOL_NAMES = new Set([
  "TodoWrite",
  "todowrite",
  "todo_write",
  "update_plan",
]);

function dedupeSnapshotToolRetries(items: ToolItem[]): ToolItem[] {
  if (items.length <= 1) return items;
  const allSnapshot = items.every((it) => SNAPSHOT_TOOL_NAMES.has(it.use.name));
  if (!allSnapshot) return items;
  // For TodoWrite specifically, the LATEST call always wins regardless of
  // input — it is a state replace, not an append. The cheap unifying
  // behavior: keep the last item per `(name, JSON.stringify(input))` key;
  // for TodoWrite a single name+input is the snapshot identity.
  const lastByKey = new Map<string, ToolItem>();
  for (const it of items) {
    let key: string;
    try {
      key = `${it.use.name}:${JSON.stringify(it.use.input)}`;
    } catch {
      key = it.use.id;
    }
    lastByKey.set(key, it);
  }
  // For TodoWrite groups, additionally collapse to just the most recent
  // item overall (a later call supersedes an earlier one even when inputs
  // differ). We detect by checking whether all items share a TodoWrite
  // name after the input-key dedupe above.
  const collapsed = Array.from(lastByKey.values());
  const allTodoWrite = collapsed.every((it) => isTodoWriteToolName(it.use.name));
  if (allTodoWrite && collapsed.length > 1) {
    return [collapsed[collapsed.length - 1]!];
  }
  return collapsed;
}

// Tools whose streaming JSON input is worth previewing as live code. Other
// tools (Bash, Grep, TodoWrite, …) stream JSON too but a code panel for them
// would be noise.
const LIVE_CODE_TOOL_NAMES = new Set([
  "Write",
  "write",
  "Edit",
  "edit",
  "MultiEdit",
  "multiedit",
  "NotebookEdit",
]);

function isLiveCodeToolName(name: string): boolean {
  return LIVE_CODE_TOOL_NAMES.has(name);
}

// Pull the (possibly still-streaming) value of a top-level JSON string field
// out of a raw, not-yet-closed JSON fragment. Returns the decoded text up to
// wherever the stream currently ends — an unterminated escape or \u sequence
// at the tail is dropped rather than throwing. Returns null when the field /
// its opening quote hasn't arrived yet. Good enough for a live preview; the
// authoritative value comes from the parsed `tool_use.input` once complete.
function extractStreamingJsonString(raw: string, field: string): string | null {
  const marker = `"${field}"`;
  const mi = raw.indexOf(marker);
  if (mi === -1) return null;
  let i = mi + marker.length;
  // Advance to the value's opening quote, past the `:` and any whitespace.
  while (i < raw.length && raw[i] !== '"') i++;
  if (i >= raw.length) return null;
  i++; // step past the opening quote
  let out = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // incomplete escape at the streaming tail
      switch (next) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "u": {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4) return out; // incomplete \u escape at the tail
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') break; // closing quote → value complete
    out += ch;
    i++;
  }
  return out;
}

// Presentational in-flight code panel: a boxed header (spinner + shimmer
// title + optional meta) over a monospace body with a typing caret. Plain
// monospace on purpose — shiki highlighting is async and would thrash on
// every streamed delta; the finished, highlighted view is taken over by the
// normal card once the write/artifact completes. Shared by the tool-call
// path (LiveCodeBox) and the streaming-artifact path (ProseBlock).
function StreamingCodeCard({
  titleLabel,
  metaLabel,
  code,
}: {
  titleLabel: string;
  metaLabel?: string;
  code: string;
}) {
  const preRef = useRef<HTMLPreElement | null>(null);
  // Keep the latest streamed line in view as code grows.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [code]);
  return (
    <div className="op-card op-file live-code-box">
      <div className="op-card-head live-code-head">
        <span className="action-card-status op-status-running" aria-hidden>
          <Icon name="spinner" size={14} />
        </span>
        <span className="op-title shimmer-text">{titleLabel}</span>
        {metaLabel ? <span className="op-meta">{metaLabel}</span> : null}
      </div>
      {code ? (
        <pre className="live-code-pre" ref={preRef}>
          <code>
            {code}
            <span className="live-code-caret" aria-hidden />
          </code>
        </pre>
      ) : null}
    </div>
  );
}

// In-flight code panel rendered from a tool call whose JSON input is still
// streaming. The finished view is taken over by the normal tool card once
// `tool_use` lands.
function LiveCodeBox({ name, raw }: { name: string; raw: string }) {
  const t = useT();
  const file =
    extractStreamingJsonString(raw, "file_path") ??
    extractStreamingJsonString(raw, "filePath") ??
    extractStreamingJsonString(raw, "path") ??
    "";
  const baseName = file ? file.split("/").pop() ?? file : "";
  const code =
    extractStreamingJsonString(raw, "content") ??
    extractStreamingJsonString(raw, "new_string") ??
    "";
  const isEdit = /edit/i.test(name);
  return (
    <StreamingCodeCard
      titleLabel={isEdit ? t("tool.edit") : t("tool.write")}
      metaLabel={baseName || undefined}
      code={code}
    />
  );
}

function ToolGroupCard({
  items,
  runStreaming,
  runSucceeded,
  projectFileNames,
  onRequestOpenFile,
}: {
  items: ToolItem[];
  runStreaming: boolean;
  runSucceeded: boolean;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);

  // Snapshot-style tools (TodoWrite and friends) replace their whole state on
  // each call, so a turn that wrote the list several times would otherwise
  // render a stack of superseded cards. Collapse those retries to the latest
  // snapshot; every other tool passes through untouched.
  items = dedupeSnapshotToolRetries(items);

  // A run of one tool collapses to that tool's card directly so we don't
  // wrap a single child in a redundant disclosure.
  if (items.length === 1) {
    return (
      <ToolCard
        use={items[0]!.use}
        result={items[0]!.result}
        runStreaming={runStreaming}
        runSucceeded={runSucceeded}
        projectFileNames={projectFileNames}
        onRequestOpenFile={onRequestOpenFile}
      />
    );
  }

  const summary = summarizeGroup(items, t, runStreaming, runSucceeded);
  const running = runStreaming && items.some((it) => !it.result);
  const hasError = items.some((it) => it.result?.isError);
  return (
    <div className="action-card">
      <button
        type="button"
        className={`action-card-toggle ${running ? "running" : ""}`}
        onClick={() => { setDetailsMounted(true); setOpen((o) => !o); }}
        aria-expanded={open}
      >
        <span className={`action-card-status ${running ? 'op-status-running' : hasError ? 'op-status-error' : 'op-status-ok'}`} aria-hidden>
          {running
            ? <Icon name="spinner" size={14} />
            : hasError
            ? <Icon name="close" size={14} />
            : <Icon name="check" size={14} />
          }
        </span>
        <span className={`summary${running ? ' shimmer-text' : ''}`}>
          {summary.label}
        </span>
        <span className="chev" aria-hidden>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
        </span>
      </button>
      <div className={`accordion-collapsible${open ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <div className="action-card-body">
            {detailsMounted ? items.map((it, i) => (
              <ToolCard
                key={i}
                use={it.use}
                result={it.result}
                runStreaming={runStreaming}
                runSucceeded={runSucceeded}
                projectFileNames={projectFileNames}
                onRequestOpenFile={onRequestOpenFile}
              />
            )) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function summarizeGroup(
  items: ToolItem[],
  t: (k: keyof Dict, vars?: Record<string, string | number>) => string,
  runStreaming: boolean,
  runSucceeded: boolean
): { label: string; icon: string } {
  // All items share a tool family because the grouper only merges by name.
  const name = items[0]?.use.name ?? "";
  const family = toolFamily(name);
  const icon = familyIcon(family);
  const verbs = items.map((it) =>
    verbForState(it, t, runStreaming, runSucceeded)
  );
  // Roll the verbs into a comma-list with deduplicated last-state. So three
  // edits whose results are all 'Done' render as "Editing ×3, Done"; mixed
  // states render as "Editing, Reading, Done".
  const head = countLabel(family, items.length, t);
  const tail = lastStateLabel(verbs, t);
  return { label: tail ? `${head}, ${tail}` : head, icon };
}

function toolFamily(name: string): string {
  if (name === "Edit" || name === "str_replace_edit") return "edit";
  if (name === "Write" || name === "write" || name === "create_file") return "write";
  if (name === "Read" || name === "read_file") return "read";
  if (name === "Glob" || name === "list_files") return "glob";
  if (name === "Grep") return "grep";
  if (name === "Bash") return "bash";
  if (isTodoWriteToolName(name)) return "todo";
  if (name === "WebFetch" || name === "web_fetch") return "fetch";
  if (name === "WebSearch" || name === "web_search") return "search";
  return name.toLowerCase();
}

function familyIcon(family: string): string {
  if (family === "edit") return "✎";
  if (family === "write") return "+";
  if (family === "read") return "↗";
  if (family === "glob" || family === "grep" || family === "search") return "⌕";
  if (family === "bash") return "$";
  if (family === "todo") return "☐";
  if (family === "fetch") return "↬";
  return "·";
}

function countLabel(
  family: string,
  n: number,
  t: (k: keyof Dict) => string
): string {
  const verb =
    family === "edit"
      ? t("assistant.verbEditing")
      : family === "write"
      ? t("assistant.verbWriting")
      : family === "read"
      ? t("assistant.verbReading")
      : family === "glob" || family === "grep" || family === "search"
      ? t("assistant.verbSearching")
      : family === "bash"
      ? t("assistant.verbRunning")
      : family === "todo"
      ? t("assistant.verbTodos")
      : family === "fetch"
      ? t("assistant.verbFetching")
      : t("assistant.verbCalling");
  return n > 1 ? `${verb} ×${n}` : verb;
}

function verbForState(
  it: ToolItem,
  t: (k: keyof Dict) => string,
  runStreaming = false,
  runSucceeded = false
): string {
  if (!it.result && runStreaming) return t("assistant.verbRunning");
  if (!it.result && !runSucceeded) return t("tool.error");
  if (it.result?.isError) return t("tool.error");
  return t("tool.done");
}

function lastStateLabel(verbs: string[], t: (k: keyof Dict) => string): string {
  const set = new Set(verbs);
  if (set.size === 1) return verbs[verbs.length - 1] ?? "";
  // Mixed states: surface error first, else running, else any.
  if (set.has(t("tool.error"))) return t("tool.error");
  if (set.has(t("assistant.verbRunning"))) return t("assistant.verbRunning");
  return verbs[verbs.length - 1] ?? "";
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-group"; items: ToolItem[] }
  | { kind: "live-tool"; id: string; name: string; raw: string }
  | { kind: "status"; label: string; detail?: string | undefined };

/**
 * Walk the event stream and build the rendering layout list. We additionally
 * collapse runs of consecutive tool_uses sharing the same tool family into a
 * single tool-group block so the chat surface stays compact during chains
 * of edits / reads.
 */
function placeConversationTodoCard(
  blocks: Block[],
  options: { show: boolean; input: unknown | null },
): Block[] {
  let placed = false;
  return blocks.flatMap((block): Block[] => {
    if (block.kind !== "tool-group") return [block];
    if (!block.items.every((it) => isTodoWriteToolName(it.use.name))) return [block];
    if (!options.show || placed) return [];
    placed = true;
    const item = block.items[0];
    if (!item || options.input == null) return [block];
    return [{
      ...block,
      items: [{
        ...item,
        use: {
          ...item.use,
          input: options.input,
        },
      }],
    }];
  });
}

function stripEmptyThinkingBlocks(blocks: Block[]): Block[] {
  return blocks.filter((block) => {
    if (block.kind !== "thinking") return true;
    return block.text.trim().length > 0;
  });
}

// The prompt asks for one discovery form and then a stop, but LLMs can still
// emit a tailored discovery form followed by the default Quick brief in the
// same assistant turn. Keep the first form for each id and drop later repeats.
function suppressDuplicateQuestionForms(blocks: Block[]): Block[] {
  const seenFormIds = new Set<string>();
  return blocks.map((block) => {
    if (block.kind !== "text") return block;
    const segments = splitOnQuestionForms(block.text);
    let changed = false;
    const nextText = segments
      .map((segment) => {
        if (segment.kind === "text") return segment.text;
        const formKey = segment.form.id.trim().toLowerCase();
        if (seenFormIds.has(formKey)) {
          changed = true;
          return "";
        }
        seenFormIds.add(formKey);
        return segment.raw;
      })
      .join("");
    return changed ? { ...block, text: nextText } : block;
  });
}

function buildBlocks(events: AgentEvent[]): Block[] {
  const out: Block[] = [];
  const resultByToolId = new Map<
    string,
    Extract<AgentEvent, { kind: "tool_result" }>
  >();
  for (const ev of events) {
    if (ev.kind === "tool_result") resultByToolId.set(ev.toolUseId, ev);
  }
  for (const ev of events) {
    if (ev.kind === "text") {
      const last = out[out.length - 1];
      if (last && last.kind === "text") last.text += ev.text;
      else out.push({ kind: "text", text: ev.text });
      continue;
    }
    if (ev.kind === "thinking") {
      const last = out[out.length - 1];
      if (last && last.kind === "thinking") last.text += ev.text;
      else out.push({ kind: "thinking", text: ev.text });
      continue;
    }
    if (ev.kind === "tool_use") {
      const result = resultByToolId.get(ev.id);
      const item: ToolItem = result ? { use: ev, result } : { use: ev };
      const last = out[out.length - 1];
      const fam = toolFamily(ev.name);
      if (
        last &&
        last.kind === "tool-group" &&
        toolFamily(last.items[last.items.length - 1]!.use.name) === fam
      ) {
        last.items.push(item);
      } else {
        out.push({ kind: "tool-group", items: [item] });
      }
      continue;
    }
    if (ev.kind === "tool_result") continue;
    if (ev.kind === "status") {
      if (
        ev.label === "streaming" ||
        ev.label === "starting" ||
        ev.label === "running" ||
        ev.label === "requesting" ||
        ev.label === "thinking" ||
        ev.label === "compacting" ||
        ev.label === "empty_response"
      )
        continue;
      const last = out[out.length - 1];
      if (last && last.kind === "status" && last.label === ev.label) {
        // Update detail to the latest value rather than skip. When an agent
        // emits multiple status events with the same label (notably
        // `label: 'model'` — fired once after `session/new` with the agent's
        // initial default, then again after the explicit model-selection
        // call completes), the badge UI must reflect the most recent detail,
        // not the first one. Without this update the post-selection model
        // (e.g. `claude-opus-4-7-high`) is silently replaced in the badge
        // by the stale initial default (`swe-1-6-fast`).
        last.detail = ev.detail;
        continue;
      }
      out.push({ kind: "status", label: ev.label, detail: ev.detail });
      continue;
    }
  }
  return out;
}

// Split prose into alternating plain-text and `<system-reminder>` segments.
// Claude Code injects `<system-reminder>...</system-reminder>` blocks into the
// agent's input (context hints, tool reminders, etc.); the model occasionally
// echoes those tags into its response. Rendering the raw markup as prose
// looks broken — surface them as their own collapsible block, and strip stray
// orphan open/close tags from the surrounding text.
type ProseSegment = { kind: "text" | "reminder"; text: string };

function splitSystemReminders(input: string): ProseSegment[] {
  const re = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
  const out: ProseSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", text: input.slice(lastIndex, m.index) });
    }
    out.push({ kind: "reminder", text: m[1] ?? "" });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < input.length) {
    out.push({ kind: "text", text: input.slice(lastIndex) });
  }
  // Drop any orphan tags that survived (open without close, or vice versa)
  // and discard text segments that became empty after stripping.
  return out
    .map((seg) =>
      seg.kind === "text"
        ? { ...seg, text: seg.text.replace(/<\/?system-reminder>/g, "") }
        : seg
    )
    .filter((seg) => seg.kind === "reminder" || seg.text.trim().length > 0);
}

function useLiveElapsed(
  streaming: boolean,
  startedAt: number | undefined,
  endedAt: number | undefined,
  fixedDurationMs: number | undefined,
): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [streaming]);
  if (!streaming && endedAt === undefined && typeof fixedDurationMs === "number") {
    return formatElapsedMs(fixedDurationMs);
  }
  if (!startedAt || (!streaming && endedAt === undefined)) return "";
  const end = streaming ? now : endedAt;
  const ms = Math.max(0, (end ?? now) - startedAt);
  return formatElapsedMs(ms);
}

function formatElapsedMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
