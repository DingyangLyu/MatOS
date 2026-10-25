import type {
  AgentInfo,
  AgentDiagnostic,
  AgentFixIntent,
  AgentCliEnvPrefs,
  AgentCliEnvIntentPrefs,
  AgentModelPrefs,
  AgentTestRequest,
  AppVersionInfo,
  AppVersionResponse,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessageFeedback,
  ChatMessageFeedbackRating,
  ChatMessageFeedbackReasonCode,
  ChatMessage,
  ConnectionTestKind,
  ConnectionTestResponse,
  Conversation,
  PersistedAgentEvent,
  Project,
  ProjectLocationPrefs,
  ProjectPlatform,
  ProjectBrowserWorkspaceTab,
  ProjectTabsState,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFolder,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  RenameProjectFileResponse,
  SkillDetail,
  SkillSummary,
  InstallInput,
  InstallSkillResponse,
  UninstallResponse,
} from '@open-design/contracts';

export type {
  ChatCommentSelectionKind,
  ProjectLocation,
  PreviewCommentMember,
  PreviewAnnotationStyle,
  PreviewCommentSelectionKind,
  PreviewVisualMarkKind,
} from '@open-design/contracts';

// Side Chat tab convention. A `chat:<conversationId>` tab mounts a secondary
// ChatPane bound to that conversation (Stage 2),  The conversation is a normal conversation, so it also shows up in the
// header ConversationsMenu.
export type SideChatTabId = `chat:${string}`;

export function isSideChatTabId(tabId: string): tabId is SideChatTabId {
  return tabId.startsWith('chat:') && tabId.length > 'chat:'.length;
}

export function conversationIdFromSideChatTabId(tabId: SideChatTabId): string {
  return tabId.slice('chat:'.length);
}

// Terminal tab convention. A `terminal:<terminalId>` tab mounts an xterm.js
// surface bound to a daemon PTY session (Stage 3), mirroring the `chat:` scheme above. The terminal id is the session id returned by
// `POST /api/projects/:id/terminals`.
export type TerminalTabId = `terminal:${string}`;

export function isTerminalTabId(tabId: string): tabId is TerminalTabId {
  return tabId.startsWith('terminal:') && tabId.length > 'terminal:'.length;
}

export function terminalIdFromTabId(tabId: TerminalTabId): string {
  return tabId.slice('terminal:'.length);
}

// Materials viewer tab convention. A `matterviz:<n>` tab mounts the MatterViz
// materials-visualization surface (`MaterialsViewerTab`), mirroring the
// `terminal:` / `chat:` schemes above. Unlike a plain structure file
// opened from the tree — which the FileViewer already renders in 3D — this is a
// standalone visualization workbench: it lets the user pick any structure /
// trajectory file in the project (or upload one) and swap between them without
// leaving the tab. The `<n>` suffix is a per-workspace sequence so multiple
// viewers can coexist; it carries no file binding (the chosen file lives in the
// tab's own state).
export type MatterVizTabId = `matterviz:${string}`;

export function matterVizTabId(sequence: number | string): MatterVizTabId {
  return `matterviz:${sequence}`;
}

export function isMatterVizTabId(tabId: string): tabId is MatterVizTabId {
  return tabId.startsWith('matterviz:') && tabId.length > 'matterviz:'.length;
}

export interface MediaProviderCredentials {
  apiKey: string;
  baseUrl: string;
  model?: string;
  apiKeyConfigured?: boolean;
  apiKeyTail?: string;
  source?: string;
}

// Per-CLI model + reasoning the user picked in the model menu. Each agent
// keeps its own slot so flipping between Codex and Gemini doesn't reset the
// other one's choice. Missing entries fall back to the agent's first
// declared model (`'default'` — let the CLI pick).
export type AgentModelChoice = AgentModelPrefs;
export type AgentCliEnvConfig = AgentCliEnvPrefs;
export type AgentCliEnvIntentConfig = AgentCliEnvIntentPrefs;

export type AppTheme = 'system' | 'light' | 'dark';

export interface NotificationsConfig {
  // Master switch for the completion sound. Default false — first-run users
  // hear nothing until they opt in.
  soundEnabled: boolean;
  // Sound id played when a turn ends with `runStatus === 'succeeded'`.
  successSoundId: string;
  // Sound id played when a turn ends with `runStatus === 'failed'`.
  failureSoundId: string;
  // Master switch for the browser Notification API banner. Default false.
  desktopEnabled: boolean;
}


export interface AppConfig {
  agentId: string | null;
  skillId: string | null;
  theme?: AppTheme;
  accentColor?: string;
  // True once the user has been through the welcome onboarding modal at
  // least once (saved or skipped). Bootstrap skips the auto-popup when
  // this is set so refreshing the page doesn't re-prompt.
  onboardingCompleted?: boolean;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  // Per-CLI model picker state, keyed by agent id (e.g. `gemini`, `codex`).
  // Pre-existing configs without this field fall through to the agent's
  // declared default.
  agentModels?: Record<string, AgentModelChoice>;
  // Per-agent non-secret CLI config locations injected into detection and runs.
  agentCliEnv?: AgentCliEnvConfig;
  // Per-agent marker that says an API key was saved as an explicit Local CLI
  // environment override, not as an older proxy-only credential.
  agentCliEnvIntent?: AgentCliEnvIntentConfig;
  // Optional task-completion sound + browser notification settings. Older
  // configs that pre-date the feature land at `undefined`, which the loader
  // normalizes to a safe default (everything off).
  notifications?: NotificationsConfig;
  // IDs of skills the user has explicitly disabled.
  disabledSkills?: string[];
  customInstructions?: string;
  projectLocations?: ProjectLocationPrefs[];
  defaultProjectLocationId?: string | null;
}

export type AgentEvent = PersistedAgentEvent;

export type ChatMessageFeedbackChange =
  | ({
      rating: ChatMessageFeedbackRating;
    } & Partial<
      Pick<
        ChatMessageFeedback,
        'reasonCodes' | 'customReason' | 'reasonsSubmittedAt'
      >
    >)
  | null;

export type {
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
  ChatMessageFeedbackRating,
  ChatMessageFeedbackReasonCode,
};

export type {
  ProjectBrowserWorkspaceTab,
};

export interface Artifact {
  identifier: string;
  artifactType?: string;
  title: string;
  html: string;
  savedUrl?: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
}

export type Surface = 'web' | 'image' | 'video' | 'audio';

export type {
  AgentInfo,
  AgentDiagnostic,
  AgentFixIntent,
  AgentTestRequest,
  AppVersionInfo,
  AppVersionResponse,
  ConnectionTestKind,
  ConnectionTestResponse,
  Conversation,
  Project,
  ProjectPlatform,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFolder,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  RenameProjectFileResponse,
  SkillDetail,
  SkillSummary,
  InstallInput,
  InstallSkillResponse,
  UninstallResponse,
};

export type OpenTabsState = ProjectTabsState;
