// @ts-nocheck
import type {
  DesktopExportArtifactInput,
  DesktopExportArtifactResult,
  DesktopExportPdfInput,
  DesktopExportPdfResult,
  DesktopRenderSlidesInput,
  DesktopRenderSlidesResult,
} from '@open-design/sidecar-proto';
import express from 'express';
import { createChatMessageBodyParser } from './chat-message-body.js';
import multer from 'multer';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { executionProfileFromStreamFormat, type ProjectConversationCreatedSsePayload } from '@open-design/contracts';
import { composeSystemPrompt } from './prompts/system.js';
import {
  usesNativeMatOSPromptAuthority,
  usesOpenDesignRunPreparation,
} from './runtimes/matos-native-policy.js';
import { writeMatOSGlobalRulesFile } from './runtimes/matos-global-rules.js';
import {
  finalizeAssistantMessageFromRunEvents,
  runSseEventToPersistedAgentEvent,
} from './runtimes/run-message-finalize.js';
import { shouldPreserveExistingAgentSession } from './runtimes/run-recovery.js';
// Re-export at the historical location: tests and downstream references keep
// importing the persisted-event mapper from server.js after its move into
// runtimes/run-message-finalize.ts.
export { daemonAgentPayloadToPersistedAgentEvent } from './runtimes/run-message-finalize.js';
import { projectGroupDispatchHook } from './routes/project/group-dispatch-hook.js';
import { emittedRenderableQuestionForm } from './question-form-detect.js';
import { resolveProjectRoot } from './project-root.js';
import {
  resolveDaemonCliPath,
  resolveDaemonResourceDir,
  resolveDaemonResourceRoot,
  resolveDataDir,
  resolveProcessResourcesPath,
} from './daemon-paths.js';
export {
  resolveDaemonCliPath,
  resolveDaemonResourceRoot,
  resolveDataDir,
} from './daemon-paths.js';
import {
  registerStaticSpaFallback,
} from './static-spa.js';
export {
  isStaticSpaFallbackRequest,
  resolveStaticSpaFallbackPath,
} from './static-spa.js';
import {
  createCompatApiError,
  sendApiError,
} from './http/api-errors.js';
import {
  registerApiCompression,
  registerStaticDelivery,
} from './http/static-delivery.js';
export {
  createCompatApiError,
  createCompatApiErrorResponse,
} from './http/api-errors.js';
import { userFacingAgentLabel } from './user-facing-agent-label.js';
import {
  buildBrowserUseRunState,
  isBrowserUseRequested,
  renderBrowserUseUnavailablePrompt,
} from './browser-use-diagnostics.js';
import {
  UPLOAD_DIR,
  buildStreamJsonUserMessage,
  composeNativeMatOSUserInput,
  composeLiveInstructionPrompt,
  formatDesignFilesWorkspaceHint,
  formatProjectAttachmentHint,
  normalizeCommentAttachments,
  renderCommentAttachmentHint,
  resolveChatExtraAllowedDirs,
  describeStablePromptCache,
  resolveResearchCommandContract,
  resolveSafeProjectAttachments,
  resolveSafePromptImagePaths,
} from './runtimes/chat-prompt-inputs.js';
import {
  applyClaudeStreamJsonRunBookkeeping,
  assertValidRuntimeDefInactivityTimeoutMs,
  classifyChatRunCloseStatus,
  resolveChatRunInactivityTimeoutMs,
  resolveChatRunShutdownGraceMs,
} from './runtimes/chat-run-lifecycle.js';
export {
  buildStreamJsonUserMessage,
  composeLiveInstructionPrompt,
  formatDesignFilesWorkspaceHint,
  formatProjectAttachmentHint,
  normalizeCommentAttachments,
  renderCommentAttachmentHint,
  resolveChatExtraAllowedDirs,
  describeStablePromptCache,
  resolveResearchCommandContract,
  resolveSafeProjectAttachments,
  resolveSafePromptImagePaths,
} from './runtimes/chat-prompt-inputs.js';
export {
  applyClaudeStreamJsonRunBookkeeping,
  assertValidRuntimeDefInactivityTimeoutMs,
  classifyChatRunCloseStatus,
  resolveChatRunInactivityTimeoutMs,
} from './runtimes/chat-run-lifecycle.js';

export { resolveProjectRoot };
import { createCommandInvocation } from '@open-design/platform';
import { SIDECAR_ENV } from '@open-design/sidecar-proto';
import {
  checkPromptArgvBudget,
  checkWindowsCmdShimCommandLineBudget,
  checkWindowsDirectExeCommandLineBudget,
  detectAgents,
  getAgentDef,
  isKnownModel,
  openDesignMatOSTraceEnv,
  applyAgentLaunchEnv,
  resolveAgentLaunch,
  sanitizeCustomModel,
  spawnEnvForAgent,
} from './agents.js';
import { resolveModelForAgent } from './runtimes/models.js';
import { migrateLegacyDataDirSync } from './legacy-data-migrator.js';
import {
  consumedImportNonces,
  getDesktopAuthSecret,
  isDesktopAuthGateActive,
  pruneExpiredImportNonces,
  verifyDesktopImportToken,
} from './desktop-auth.js';
import { normalizeDaemonBindHost } from './daemon-startup.js';
export {
  isDesktopAuthGateActive,
  isDesktopAuthRegistered,
  resetDesktopAuthForTests,
  setDesktopAuthSecret,
  signDesktopImportToken,
  verifyDesktopImportToken,
} from './desktop-auth.js';
import { readCurrentAppVersionInfo } from './app-version.js';
import {
  findSkillById,
  listSkills,
  resolveSkillId,
} from './skills.js';
import { filterValidLinkedDirs, validateLinkedDirs } from './linked-dirs.js';
import {
  buildWindowsFolderDialogCommand,
  parseFolderDialogStdout,
  parseLinuxFolderDialogResult,
} from './native-folder-dialog.js';
import {
  applySandboxRuntimeEnv,
  ensureSandboxRuntimeDirs,
  isSandboxModeEnabled,
  resolveSandboxRuntimeConfig,
} from './sandbox-mode.js';
import { runtimeResumesSessionById } from './runtimes/types.js';
import { createClaudeStreamHandler } from './runtimes/claude-stream.js';
import { createAgentTitleMarkerStripper } from './title-marker.js';
import { createRoleMarkerGuard } from './role-marker-guard.js';
import { createToolLoopGuard, resolveToolLoopMode, type ToolLoopVerdict } from './tool-loop-guard.js';
import { classifyAgentServiceFailure } from './runtimes/auth.js';
import { subscribe as subscribeFileEvents } from './project-watchers.js';
import { createChatRunService, shouldSuppressCanceledRunOutput } from './runtimes/runs.js';
import { deriveRunErrorCode, runResultFromStatus } from './run-result.js';
import { classifyRunFailure, isResumableFailure } from './run-failure-classification.js';
import { decideSafeRunRetry } from './run-retry-policy.js';
import { countNewArtifacts } from './runtimes/run-artifacts.js';
import {
  createRunArtifactBaselines,
  diffRunArtifacts,
  snapshotProjectArtifacts,
} from './run-artifact-fs.js';
import {
  AiHtmlVersionSnapshotError,
  snapshotAiHtmlVersionsForRun,
} from './run-html-version-snapshots.js';
import {
  mergeNoProxyWithLoopbackDefaults,
  testAgentConnection,
} from './connectionTest.js';
import { buildDocumentPreview } from './document-preview.js';
import { lintArtifact, renderFindingsForAgent } from './lint-artifact.js';
import { skillCwdAliasSegment, stageActiveSkill } from './cwd-aliases.js';
import { buildDesktopArtifactExportInput, buildDesktopPdfExportInput } from './pdf-export.js';
import { searchResearch, ResearchError } from './research/index.js';
import { openBrowser } from './browser-open.js';
import {
  readMaskedConfig,
  writeConfig,
  resolveResearchApiAgentEnv,
  listConfiguredResearchApiEnvNames,
} from './integrations/provider-config.js';
import {
  buildClaudeMcpJson,
  isManagedProjectCwd,
  readMcpConfig,
} from './mcp-config.js';
import {
  resolveExternalMcpServersForRun,
} from './run-tool-bundle.js';
import { PendingAuthCache, refreshAccessToken } from './mcp-oauth.js';
import {
  isTokenExpired,
  readAllTokens,
  setToken,
} from './mcp-tokens.js';
import { agentCliEnvForAgent, readAppConfig, writeAppConfig } from './app-config.js';
import { formatLocalProjectTimestamp } from './project-timestamp.js';
import { RoutineService } from './routines.js';
import { createDiagnosticsExportHandler } from './diagnostics-export.js';
import { DIAGNOSTICS_EXPORT_PATH } from '@open-design/diagnostics';
import {
  buildBatchArchive,
  createProjectFolder,
  decodeMultipartFilename,
  deleteProjectFile,
  assertSandboxProjectRootAvailable,
  deleteProjectFolder,
  detectEntryFile,
  ensureProject,
  ensureProjectSubdir,
  isRunTouchedProjectFile,
  isSafeId,
  listFiles,
  listProjectFolders,
  mimeFor,
  parseByteRange,
  readProjectFile,
  renameProjectFile,
  renameProjectFolder,
  removeProjectDir,
  resolveProjectDir,
  SandboxImportedProjectError,
  sanitizeName,
  sanitizePath,
  searchProjectFiles,
  resolveProjectFilePath,
  writeProjectFile,
  reconcileHtmlArtifactManifest,
} from './projects.js';
import { validateArtifactManifestInput } from './artifacts/manifest.js';
import { acquireProjectWriteLock } from './project-write-lock.js';
import {
  appendMessageAgentEvents,
  appendMessageStatusEvent,
  deleteConversation,
  deletePreviewComment,
  deleteProject as dbDeleteProject,
  deleteTemplate,
  getConversation,
  getProject,
  getTemplate,
  insertConversation,
  insertProject,
  insertRoutineRun,
  insertScheduledRoutineRun,
  insertTemplate,
  findTemplateByNameAndProject,
  updateTemplate,
  listProjectsAwaitingInput,
  listConversations,
  listLatestProjectRunStatuses,
  listMessageIds,
  listMessages,
  listMessagesForChat,
  listPreviewComments,
  listProjects,
  listRoutines,
  listTabs,
  listTemplates,
  getLatestRoutineRun,
  normalizeConversationSessionMode,
  openDatabase,
  reconcileMessageTurnOrder,
  setTabs,
  updateConversation,
  updatePreviewCommentStatus,
  updateProject,
  updateRoutineRun,
  clearAgentSession,
  upsertAgentSession,
  upsertMessage,
  upsertPreviewComment,
} from './db.js';
import {
  computeIncludeStable,
  hashStableInstructions,
  isClaudeResumeFailure,
  resolveAgentResumeContext,
} from './agent-session-resume.js';
import { registerActiveContextRoutes } from './routes/active-context.js';
import {
  invalidateMatOSAssetBridgeCaches,
  registerMatOSAssetRoutes,
} from './routes/matos-assets.js';
import { registerMatOSFeedbackRoutes } from './routes/matos-feedback.js';
import { registerMatOSUserStatsRoutes } from './routes/matos-user-stats.js';
import { registerMatOSFsRoutes } from './routes/matos-fs.js';
import { registerMatOSOpsRoutes } from './routes/matos-ops.js';
import { registerMatOSEvolutionRoutes } from './routes/matos-evolution.js';
import { registerMatOSScheduleRoutes } from './routes/matos-schedules.js';
import { registerMatOSWorkflowRoutes } from './routes/matos-workflow.js';
import { registerMatOSLoginRoutes } from './routes/matos-login.js';
import { registerMatOSModelRoutes, warmMatOSModelsCache } from './routes/matos-models.js';
import { setMatOSUserEnvLoader } from './services/matos-cli.js';
import { matOSRunAdditionalAssetRefs } from './services/matos-run-assets.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerDaemonRoutes } from './routes/daemon.js';
import { registerHostToolsRoutes } from './routes/host-tools.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerResearchRoutes } from './routes/research.js';
import {
  projectDetailResolvedDir,
  registerProjectRoutes,
  registerProjectArtifactRoutes,
  registerProjectFileRoutes,
  registerProjectUploadRoutes,
} from './routes/project/index.js';
import { registerImportRoutes, registerProjectExportRoutes } from './import-export-routes.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { createTerminalService } from './terminals.js';
import { registerStaticResourceRoutes } from './routes/static-resource.js';
export { rewriteSkillAssetUrls } from './routes/static-resource.js';
import { registerRoutineRoutes, routineDbRowToContract } from './routes/routine.js';
import { getRouteRegistrationInventory, installRouteRegistrationGuard } from './route-registration-guard.js';
import { assertServerContextSatisfiesRoutes } from './route-context-contract.js';
import { CHAT_TOOL_ENDPOINTS, CHAT_TOOL_OPERATIONS, toolTokenRegistry } from './tool-tokens.js';
import {
  allowedBrowserPorts,
  configuredAllowedHosts,
  configuredAllowedOrigins,
  isAllowedBrowserOrigin,
  isLocalSameOrigin,
} from './origin-validation.js';
import { apiTokenFromEnv, isApiAuthDisabled, isApiTokenMiddlewareEnabled } from './api-token-auth.js';

/** @typedef {import('@open-design/contracts').ApiErrorCode} ApiErrorCode */
/** @typedef {import('@open-design/contracts').ApiError} ApiError */
/** @typedef {import('@open-design/contracts').ApiErrorResponse} ApiErrorResponse */
/** @typedef {import('@open-design/contracts').ChatRequest} ChatRequest */
/** @typedef {import('@open-design/contracts').ChatSseEvent} ChatSseEvent */
/** @typedef {import('@open-design/contracts').ProxyStreamRequest} ProxyStreamRequest */
/** @typedef {import('@open-design/contracts').ProxySseEvent} ProxySseEvent */
/** @typedef {import('@open-design/contracts').ProjectConversationCreatedSsePayload} ProjectConversationCreatedSsePayload */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = resolveProjectRoot(__dirname);

function isSqliteForeignKeyConstraint(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || (code === 'SQLITE_CONSTRAINT' && /FOREIGN KEY/i.test(message));
}

// Agent-session persistence races conversation deletion: a run can finish
// after its conversation (and the FK target row) is gone. Skipping is correct
// — there is nothing to resume into — and must never crash the daemon.
function safeUpsertAgentSession(db, input, context = {}) {
  if (!input?.conversationId || !getConversation(db, input.conversationId)) {
    console.warn('[agent-session] skip session persistence for missing conversation', {
      conversationId: input?.conversationId ?? null,
      agentId: input?.agentId ?? null,
      runId: context.runId ?? null,
      phase: context.phase ?? null,
    });
    return false;
  }
  try {
    upsertAgentSession(db, input);
    return true;
  } catch (error) {
    if (isSqliteForeignKeyConstraint(error)) {
      console.warn('[agent-session] skip session persistence after foreign-key constraint', {
        conversationId: input.conversationId,
        agentId: input.agentId,
        runId: context.runId ?? null,
        phase: context.phase ?? null,
      });
      return false;
    }
    throw error;
  }
}


const DAEMON_RESOURCE_ROOT = resolveDaemonResourceRoot({
  safeBases: [
    PROJECT_ROOT,
    resolveProcessResourcesPath(),
    process.env.OD_INSTALLATION_DIR,
  ],
});
// Built web app lives in `out/` — that's where Next.js writes the static
// export configured in next.config.ts. The folder name used to be `dist/`
// when this project shipped with Vite; the daemon serves whatever the
// frontend toolchain emits, no further config needed.
const STATIC_DIR = path.join(PROJECT_ROOT, 'apps', 'web', 'out');
const OD_BIN = resolveDaemonCliPath();
const OD_NODE_BIN = process.execPath;
const SKILLS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'skills',
  path.join(PROJECT_ROOT, 'skills'),
);
// Renderable templates pulled out of `skills/` by the skills/design-templates
// split (PR #955) so the EntryView Templates tab gets the large rendering
// catalogue and Settings → Skills only carries functional skills the agent
// invokes mid-task.
const DESIGN_TEMPLATES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'design-templates',
  path.join(PROJECT_ROOT, 'design-templates'),
);
// User-installed skills live under the runtime data dir so they respect
// OD_DATA_DIR overrides (test isolation, packaged runs). Defined after
// RUNTIME_DATA_DIR is resolved below.
const FRAMES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'frames',
  path.join(PROJECT_ROOT, 'assets', 'frames'),
);
const SANDBOX_MODE_ENABLED = isSandboxModeEnabled(process.env);
const RUNTIME_DATA_DIR = resolveDataDir(process.env.OD_DATA_DIR, PROJECT_ROOT, {
  requireExplicit: SANDBOX_MODE_ENABLED,
});
const SANDBOX_RUNTIME = resolveSandboxRuntimeConfig(SANDBOX_MODE_ENABLED, RUNTIME_DATA_DIR);
ensureSandboxRuntimeDirs(SANDBOX_RUNTIME);
// Canonical (realpath-resolved) form of RUNTIME_DATA_DIR for the few callers
// that compare it against a user-supplied realpath() result. On macOS, /var
// is a symlink to /private/var, so an import realpath lands in /private/var
// and would never start-with the raw RUNTIME_DATA_DIR. Keep RUNTIME_DATA_DIR
// itself as the stable, user-shaped path so OD_DATA_DIR resolution stays
// predictable; only this canonical alias is used for symlink-aware checks.
const RUNTIME_DATA_DIR_CANONICAL = (() => {
  try {
    return fs.realpathSync(RUNTIME_DATA_DIR);
  } catch {
    return RUNTIME_DATA_DIR;
  }
})();
// One-shot legacy data migration. When OD_LEGACY_DATA_DIR is set and the
// new data root is fresh (no app.sqlite), copy the 0.3.x .od/ payload
// across before SQLite opens. Synchronous on purpose: openDatabase below
// would race an async copy. See apps/daemon/src/legacy-data-migrator.ts
// and https://github.com/nexu-io/open-design/issues/710.
migrateLegacyDataDirSync({
  legacyDir: process.env.OD_LEGACY_DATA_DIR,
  dataDir: RUNTIME_DATA_DIR,
});
const ARTIFACTS_DIR = path.join(RUNTIME_DATA_DIR, 'artifacts');
const PROJECTS_DIR = path.join(RUNTIME_DATA_DIR, 'projects');
const USER_SKILLS_DIR = path.join(RUNTIME_DATA_DIR, 'skills');
// User-imported design templates mirror USER_SKILLS_DIR but are scanned
// against DESIGN_TEMPLATES_DIR rather than SKILLS_DIR so the EntryView
// Templates surface and the Settings → Skills surface stay decoupled.
const USER_DESIGN_TEMPLATES_DIR = path.join(RUNTIME_DATA_DIR, 'design-templates');
// MatOS asset bridge — extra skill roots. MatOS skill assets are plain
// SKILL.md folders (Claude Code Agent Skills compatible) that live in the
// MatOS asset packs (e.g. matos-assets/packs/matos-core/skills). Surfacing
// them as additional built-in skill roots lets the Settings → Skills UI and
// the chat run skill picker browse and compose real MatOS skills without a
// separate registry. `MATOS_SKILLS_ROOTS` (colon-separated absolute dirs)
// overrides discovery; setting it to an empty string disables the bridge.
// When unset, the daemon auto-detects the matos-core pack relative to this
// snapshot's location inside the MatOS repository (ui/open-design/..).
function resolveMatOSSkillsRoots() {
  const raw = process.env.MATOS_SKILLS_ROOTS;
  if (raw !== undefined) {
    return raw
      .split(':')
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0 && path.isAbsolute(dir) && fs.existsSync(dir));
  }
  const bundled = path.resolve(
    PROJECT_ROOT,
    '..',
    '..',
    'matos-assets',
    'packs',
    'matos-core',
    'skills',
  );
  return fs.existsSync(bundled) ? [bundled] : [];
}
const MATOS_SKILLS_ROOTS = resolveMatOSSkillsRoots();

// Multi-root tuples used everywhere the daemon resolves a skill / template
// id without knowing which surface it came from. SKILL_ROOTS drives
// Settings → Skills; DESIGN_TEMPLATE_ROOTS drives the EntryView Templates
// gallery; ALL_SKILL_LIKE_ROOTS spans both for chat run system-prompt
// composition and the routine template resolver, where stored project ids
// can resolve to either root after the split.
const SKILL_ROOTS = [USER_SKILLS_DIR, SKILLS_DIR, ...MATOS_SKILLS_ROOTS];
const DESIGN_TEMPLATE_ROOTS = [USER_DESIGN_TEMPLATES_DIR, DESIGN_TEMPLATES_DIR];
const ALL_SKILL_LIKE_ROOTS = [
  USER_SKILLS_DIR,
  USER_DESIGN_TEMPLATES_DIR,
  SKILLS_DIR,
  DESIGN_TEMPLATES_DIR,
  ...MATOS_SKILLS_ROOTS,
];
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
for (const dir of [USER_SKILLS_DIR, USER_DESIGN_TEMPLATES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
let routineService = null;

// In-memory OAuth state cache. Lives for the daemon process's lifetime.
// Maps the OAuth `state` parameter we generated in /api/mcp/oauth/start
// to the verifier + endpoint info needed to finish the exchange when the
// browser hits /api/mcp/oauth/callback.
const mcpPendingAuth = new PendingAuthCache();

/**
 * Resolve the daemon's public base URL — the origin the user's browser
 * (or the OAuth provider) reaches us at. Order of precedence:
 *
 *   1. `OD_PUBLIC_BASE_URL` env var. Cloud and packaged-electron deployments
 *      set this to the externally-routable URL (e.g. `https://app.example.com`).
 *   2. `req.protocol://req.get('host')` from the inbound request. Works in
 *      local dev and most reverse-proxy setups (Express respects
 *      `trust proxy` so X-Forwarded-* headers are honored).
 *
 * The OAuth callback URI is derived from this — it MUST be reachable from
 * the user's browser, otherwise the redirect after auth lands on
 * ERR_CONNECTION_REFUSED. Misconfiguration is loud: the OAuth provider
 * will reject `redirect_uri` mismatches.
 */
function getPublicBaseUrl(req) {
  const env = process.env.OD_PUBLIC_BASE_URL;
  if (env && /^https?:\/\//i.test(env)) {
    return env.replace(/\/+$/u, '');
  }
  const proto = req.protocol || 'http';
  const host = req.get('host');
  if (!host) return `http://localhost:${process.env.OD_PORT ?? '7456'}`;
  return `${proto}://${host}`;
}


/**
 * Refresh an expired token using the OAuth client context that the original
 * authorization-code exchange persisted alongside the token. Refresh tokens
 * are bound (RFC 6749 §6) to the client that received them, so we MUST
 * refresh against the same `tokenEndpoint` / `clientId` / `clientSecret`
 * pair — re-running discovery with a different redirect URI would risk
 * registering a new client_id that the upstream then rejects the refresh
 * for. Tokens persisted before that context was recorded can't be safely
 * refreshed; the caller treats `null` as "needs reconnect".
 */
async function refreshAndPersistToken(dataDir, serverId, current) {
  if (!current.refreshToken) return null;
  if (!current.tokenEndpoint || !current.clientId) return null;
  const tokenResp = await refreshAccessToken({
    tokenEndpoint: current.tokenEndpoint,
    clientId: current.clientId,
    clientSecret: current.clientSecret,
    refreshToken: current.refreshToken,
    scope: current.scope,
    resource: current.resourceUrl,
  });
  const next = {
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token ?? current.refreshToken,
    tokenType: tokenResp.token_type ?? 'Bearer',
    scope: tokenResp.scope ?? current.scope,
    expiresAt:
      typeof tokenResp.expires_in === 'number'
        ? Date.now() + tokenResp.expires_in * 1000
        : undefined,
    savedAt: Date.now(),
    tokenEndpoint: current.tokenEndpoint,
    clientId: current.clientId,
    clientSecret: current.clientSecret,
    authServerIssuer: current.authServerIssuer,
    redirectUri: current.redirectUri,
    resourceUrl: current.resourceUrl,
  };
  await setToken(dataDir, serverId, next);
  return next;
}

const activeChatAgentEventSinks = new Map();
const activeProjectEventSinks = new Map();
function emitChatAgentEvent(runId, payload) {
  const sink = activeChatAgentEventSinks.get(runId);
  if (!sink) return false;
  return sink(payload);
}

// Broadcast an event to every SSE subscriber currently watching the given
// project's `/api/projects/:id/events` stream. The payload's `type` field
// becomes the SSE event name (see routes/project/index.ts). Used for
// `conversation-created` events emitted by routine runs (#1361).
function emitProjectEvent(projectId, payload) {
  const sinks = activeProjectEventSinks.get(projectId);
  if (!sinks || sinks.size === 0) return false;
  for (const sink of Array.from(sinks)) {
    try {
      sink(payload);
    } catch {
      sinks.delete(sink);
    }
  }
  if (sinks.size === 0) activeProjectEventSinks.delete(projectId);
  return true;
}


// Per-run baselines of the project's artifact files, captured before the agent
// runs and diffed at run-finish to derive `artifact_count` agent-agnostically
// (see `run-artifact-fs.ts`). Keyed by run id because the run-start scope and
// the run-finished scope are different closures. The registry also
// flags runs that overlapped another run in the same cwd as `contended`; those
// must not trust the whole-tree diff (it would cross-attribute writes) and fall
// back to the per-run tool-stream count.
const runArtifactBaselines = createRunArtifactBaselines();
export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;

export function createAgentRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
  nodeBin: string = process.execPath,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = applySandboxRuntimeEnv(
    {
      ...baseEnv,
      OD_DATA_DIR: RUNTIME_DATA_DIR,
      OD_DAEMON_URL: daemonUrl,
      OD_NODE_BIN: nodeBin,
    },
    SANDBOX_RUNTIME,
  );
  const sidecarIpcPath = baseEnv[SIDECAR_ENV.IPC_PATH];
  if (typeof sidecarIpcPath === 'string' && sidecarIpcPath.length > 0) {
    env[SIDECAR_ENV.IPC_PATH] = sidecarIpcPath;
  }
  if (SANDBOX_RUNTIME.enabled) {
    const noProxy = mergeNoProxyWithLoopbackDefaults(env.NO_PROXY ?? env.no_proxy);
    if (noProxy) {
      env.NO_PROXY = noProxy;
      if (process.platform !== 'win32') env.no_proxy = noProxy;
    }
  }

  // Ensure the node binary directory is on PATH so agent sub-processes —
  // in particular npm .cmd shims on Windows that run `"node" script.js` —
  // can find the same node binary that runs the daemon even when the daemon
  // was launched with a full path to node and the directory was not on PATH.
  const nodeBinDir = path.dirname(nodeBin);
  if (nodeBinDir) {
    // On Windows, process.env spreads with the search path under 'Path' rather
    // than 'PATH'. Locate the key case-insensitively so we read and write the
    // same entry that child_process.spawn consults. If we blindly write a new
    // 'PATH' key alongside an existing 'Path', Node's case-insensitive env
    // de-duplication on Windows lets the new key win — dropping all inherited
    // directories (git, npm, agent shims, etc.) from the child's search path.
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const existingPath = typeof env[pathKey] === 'string' ? (env[pathKey] as string) : '';
    const parts = existingPath.split(path.delimiter).filter((p) => p.length > 0);
    const normalize = (p: string) => p.replace(/[/\\]+$/, '');
    const normalizedDir = normalize(nodeBinDir);
    const alreadyIncluded = parts.some((p) => {
      const n = normalize(p);
      return process.platform === 'win32'
        ? n.toLowerCase() === normalizedDir.toLowerCase()
        : n === normalizedDir;
    });
    if (!alreadyIncluded) {
      env[pathKey] = [nodeBinDir, ...parts].join(path.delimiter);
    }
  }

  if (toolTokenGrant?.token) {
    env.OD_TOOL_TOKEN = toolTokenGrant.token;
  } else {
    delete env.OD_TOOL_TOKEN;
  }

  return env;
}

export function createAgentRuntimeToolPrompt(
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
  researchApiEnvNames: readonly string[] = [],
): string {
  const tokenLine = toolTokenGrant?.token
    ? '- `OD_TOOL_TOKEN` is available in your environment for this run. Use it only through project wrapper commands; do not print, persist, or override it.'
    : '- `OD_TOOL_TOKEN` is not available for this run, so `/api/tools/*` wrapper commands may be unavailable.';

  const lines = [
    '## Runtime tool environment',
    '',
    `- Daemon URL: \`${daemonUrl}\` (also available as \`OD_DAEMON_URL\`).`,
    '- `OD_NODE_BIN` is the absolute path to the Node-compatible runtime that started the daemon; packaged desktop installs provide this even when the user has no system `node` on PATH.',
    '- `OD_BIN` is the absolute path to the MatOS CLI script. On POSIX shells run wrappers with `"$OD_NODE_BIN" "$OD_BIN" tools ...`; do not call bare `od`, which may resolve to the system octal-dump command on Unix-like systems.',
    '- On PowerShell use `& $env:OD_NODE_BIN $env:OD_BIN tools ...`; on cmd.exe use `"%OD_NODE_BIN%" "%OD_BIN%" tools ...`.',
    tokenLine,
    '- Prefer project wrapper commands through `OD_NODE_BIN` + `OD_BIN` over raw HTTP. The wrappers read these environment values automatically.',
  ];

  // Disclose configured scientific-data API credentials by env-var NAME only
  // (never the value) so the model knows it can call e.g. Materials Project or
  // OpenAlex directly from its own code without asking the user for a key.
  if (researchApiEnvNames.length > 0) {
    const names = researchApiEnvNames.map((n) => `\`${n}\``).join(', ');
    lines.push(
      `- Scientific-data API credentials are available in your environment as ${names}. Read them from the environment (e.g. \`os.environ["MP_API_KEY"]\`) in your own code — never print, echo, or persist their values.`,
    );
  }

  return lines.join('\n');
}

const WORKSPACE_CONTEXT_KINDS = new Set([
  'design-files',
  'file',
  'folder',
  'project',
  'local-code',
  'terminal',
  'side-chat',
]);

function normalizeWorkspaceContextItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  const cleanString = (value, max = 500) => {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
  };
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const kind = cleanString(record.kind, 64);
    if (!WORKSPACE_CONTEXT_KINDS.has(kind)) continue;
    const id = cleanString(record.id, 240);
    const label = cleanString(record.label, 240);
    if (!id || !label) continue;
    const dedupeKey = `${kind}:${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const normalized: Record<string, string> = { id, kind, label };
    const tabId = cleanString(record.tabId, 240);
    const pathValue = cleanString(record.path, 500);
    const absolutePath = cleanString(record.absolutePath, 1000);
    const url = cleanString(record.url, 1000);
    const title = cleanString(record.title, 500);
    if (tabId) normalized.tabId = tabId;
    if (pathValue) normalized.path = pathValue;
    if (absolutePath) normalized.absolutePath = absolutePath;
    if (url) normalized.url = url;
    if (title) normalized.title = title;
    out.push(normalized);
  }
  return out;
}

function normalizeRunContextSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const stringList = (items) => {
    if (!Array.isArray(items)) return [];
    const out = [];
    const seen = new Set();
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  };
  return {
    skillIds: stringList(value.skillIds),
    mcpServerIds: stringList(value.mcpServerIds),
    workspaceItems: normalizeWorkspaceContextItems(value.workspaceItems),
  };
}

function mergeRunContextSelections(...contexts) {
  const merged = { skillIds: [], mcpServerIds: [], workspaceItems: [] };
  const listKeys = ['skillIds', 'mcpServerIds'];
  const workspaceSeen = new Set();
  for (const context of contexts) {
    const normalized = normalizeRunContextSelection(context);
    for (const key of listKeys) {
      const seen = new Set(merged[key]);
      for (const id of normalized[key] ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          merged[key].push(id);
        }
      }
    }
    for (const item of normalized.workspaceItems ?? []) {
      const key = `${item.kind}:${item.id}`;
      if (workspaceSeen.has(key)) continue;
      workspaceSeen.add(key);
      merged.workspaceItems.push(item);
    }
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, ids]) => ids.length > 0),
  );
}

function projectMetadataContextSelection(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  return {
    mcpServerIds: Array.isArray(metadata.contextMcpServers)
      ? metadata.contextMcpServers.map((item) => item?.id).filter((id) => typeof id === 'string')
      : [],
  };
}

function formatContextRefList(ids, refs, titleKey = 'title') {
  const byId = new Map();
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (ref && typeof ref.id === 'string') byId.set(ref.id, ref);
    }
  }
  return ids
    .map((id) => {
      const ref = byId.get(id);
      const label =
        typeof ref?.[titleKey] === 'string' && ref[titleKey].trim()
          ? ref[titleKey].trim()
          : typeof ref?.label === 'string' && ref.label.trim()
            ? ref.label.trim()
            : typeof ref?.name === 'string' && ref.name.trim()
              ? ref.name.trim()
              : id;
      const meta = [
        ref?.provider,
        ref?.transport,
        ref?.status,
        ref?.accountLabel,
      ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
      return `- ${label} (\`${id}\`)${meta ? ` — ${meta}` : ''}`;
    })
    .join('\n');
}

function formatWorkspaceContextList(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item, index) => {
      const details = [
        item.path ? `path: \`${item.path}\`` : null,
        item.absolutePath ? `absolute: \`${item.absolutePath}\`` : null,
        item.url ? `url: ${item.url}` : null,
        item.title ? `title: ${item.title}` : null,
        item.tabId ? `tab: \`${item.tabId}\`` : null,
      ].filter(Boolean).join(' | ');
      return `${index + 1}. ${item.kind}: ${item.label} (\`${item.id}\`)${details ? ` — ${details}` : ''}`;
    })
    .join('\n');
}

function renderWorkspaceContextToolHints(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const kinds = new Set(items.map((item) => item?.kind).filter(Boolean));
  const hints = [];
  if (kinds.has('browser')) {
    hints.push(
      '- Browser tabs: use the selected browser tab URL/title as the target for requests about logos, fonts, images, colors, motion code, element/page screenshots, accessibility, OG/meta tags, or page structure. Prefer mounted browser automation / browser-use style tools when available (DOM snapshot, page screenshot, element screenshot, accessibility tree, evaluated JavaScript). If only URL/title context is available and no inspection tool is mounted, say that explicitly and do not invent page internals.',
    );
  }
  if (kinds.has('terminal')) {
    hints.push(
      '- Terminal tabs: treat the selected terminal tab as the target shell/session. If the exact scrollback is not included in the prompt, run safe project-local read-only commands or ask for the terminal transcript instead of guessing hidden output.',
    );
  }
  if (kinds.has('file') || kinds.has('folder') || kinds.has('design-files')) {
    hints.push(
      '- File and Design Files tabs: use project-relative paths exactly as shown. Read before editing, and keep generated screenshots/briefs/assets in Design Files when the user asks to capture or extract references.',
    );
  }
  if (kinds.has('project')) {
    hints.push(
      '- Referenced projects: use the absolute path as a read-only reference project when present. Search and read relevant files before applying ideas to the current project; do not edit the referenced project unless the user explicitly asks.',
    );
  }
  if (kinds.has('local-code')) {
    hints.push(
      '- Local code folders: use the absolute path as read-only implementation context. Inspect files under that folder when useful, align with its conventions, and make edits only in the active MatOS project unless the user explicitly asks otherwise.',
    );
  }
  return hints.join('\n');
}

function renderRunContextPrompt(selection, metadata) {
  const context = mergeRunContextSelections(projectMetadataContextSelection(metadata), selection);
  const lines = [];
  if (Array.isArray(context.workspaceItems) && context.workspaceItems.length > 0) {
    lines.push('### Active workspace context');
    lines.push(
      'The user selected these workspace contexts or MatOS inferred the currently focused workspace tab. Use them as the default target for phrases like "this", "current", "the browser", "the terminal", "that file", or "the referenced code/project" unless the user says otherwise. Use project-relative paths exactly when reading or editing project files, and treat absolute local paths as reference context unless explicitly asked to edit them.',
    );
    lines.push(formatWorkspaceContextList(context.workspaceItems));
    const toolHints = renderWorkspaceContextToolHints(context.workspaceItems);
    if (toolHints) lines.push(toolHints);
  }
  if (Array.isArray(context.mcpServerIds) && context.mcpServerIds.length > 0) {
    lines.push('### Selected MCP servers');
    lines.push(
      'The user selected these MCP servers for this run. Prefer their tools when they are mounted and relevant before asking where data should come from.',
    );
    lines.push(formatContextRefList(context.mcpServerIds, metadata?.contextMcpServers ?? [], 'label'));
  }
  if (lines.length === 0) return '';
  return ['## Selected run context', ...lines].join('\n');
}

export function normalizeProjectDisplayStatus(status) {
  return status === 'starting' || status === 'queued' ? 'running' : status;
}

export function composeProjectDisplayStatus(
  baseStatus,
  awaitingInputProjects,
  projectId,
) {
  if (
    baseStatus.value === 'succeeded' &&
    awaitingInputProjects.has(projectId)
  ) {
    return { ...baseStatus, value: 'awaiting_input' };
  }
  return {
    ...baseStatus,
    value: normalizeProjectDisplayStatus(baseStatus.value),
  };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiError}
 */
function execFileBuffered(command, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        error,
      });
    });
  });
}

function quotePosixShellArg(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}


function buildCommandShellCommand(command, args) {
  return [command, ...args].map(quotePosixShellArg).join(' ');
}

function buildLoginShellCommand(innerCommand) {
  // Use a non-login shell and re-export PATH so test fakes and agent wrappers
  // remain visible; login shells often reset PATH from profile scripts.
  return `export PATH=${quotePosixShellArg(process.env.PATH ?? '')}; ${innerCommand}`;
}


function execCommandViaLoginShell(command, args, opts = {}) {
  if (process.platform === 'win32') return execFileBuffered(command, args, opts);
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : '/bin/zsh';
  return execFileBuffered(shell, ['-c', buildLoginShellCommand(buildCommandShellCommand(command, args))], {
    env: process.env,
    ...opts,
  });
}


// Scans run.events newest→oldest to extract usage token counts and the
// agent-reported model name. The scan must not short-circuit on usage
// before reaching the model signal: usage is a terminal event while
// status:initializing/model is emitted at the very start of the run, so
// in reverse iteration usage is seen first. The loop continues until both
// usage tokens are found AND (the caller already has a model from reqBody
// OR the agent-reported model has been found).
function scanRunEventsForRetrySideEffects(events) {
  const sideEffects = {
    userVisibleOutputSeen: false,
    toolCallSeen: false,
    artifactWriteSeen: false,
  };
  for (const rec of Array.isArray(events) ? events : []) {
    if (rec?.event === 'stdout') {
      const chunk = rec.data?.chunk;
      if (typeof chunk === 'string' ? chunk.length > 0 : chunk !== undefined) {
        sideEffects.userVisibleOutputSeen = true;
      }
    }
    const data = rec?.data;
    if (!data || typeof data !== 'object') continue;
    if (data.type === 'text_delta' || data.type === 'thinking_delta') {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (delta.length > 0) sideEffects.userVisibleOutputSeen = true;
    }
    if (data.type === 'tool_use') sideEffects.toolCallSeen = true;
    if (data.type === 'artifact') sideEffects.artifactWriteSeen = true;
  }
  if (countNewArtifacts(events) > 0) {
    sideEffects.artifactWriteSeen = true;
  }
  return sideEffects;
}

export function __forTestScanRunEventsForRetrySideEffects(events) {
  return scanRunEventsForRetrySideEffects(events);
}

function fileNameFromToolInputPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).at(-1) ?? trimmed;
}

function filesystemWriteFileNamesFromRunEvents(events) {
  const names = [];
  const seen = new Set();
  for (const rec of Array.isArray(events) ? events : []) {
    const data = rec?.data;
    if (!data || typeof data !== 'object') continue;
    if (data.type !== 'tool_use' && data.type !== 'artifact') continue;

    const toolName = typeof data.name === 'string' ? data.name : '';
    const isFileTool =
      data.type === 'artifact' ||
      /^(Write|Edit|MultiEdit|write_file|edit_file|replace_file)$/i.test(toolName);
    if (!isFileTool) continue;

    const input = data.input && typeof data.input === 'object' ? data.input : {};
    const candidate =
      fileNameFromToolInputPath(input.file_path) ||
      fileNameFromToolInputPath(input.filePath) ||
      fileNameFromToolInputPath(input.path) ||
      fileNameFromToolInputPath(input.filename) ||
      fileNameFromToolInputPath(data.path) ||
      fileNameFromToolInputPath(data.filePath) ||
      fileNameFromToolInputPath(data.name);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    names.push(candidate);
  }
  return names;
}

export function __forTestFilesystemWriteFileNamesFromRunEvents(events) {
  return filesystemWriteFileNamesFromRunEvents(events);
}

function filesystemEmptyAnswerFallbackText(fileNames) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return 'Wrote project files.';
  }
  const shown = fileNames.slice(0, 3);
  if (fileNames.length === 1) {
    return `Wrote ${shown[0]}.`;
  }
  if (fileNames.length <= 3) {
    const last = shown.at(-1);
    const first = shown.slice(0, -1).join(', ');
    return `Wrote ${first} and ${last}.`;
  }
  return `Wrote ${shown.join(', ')}, and ${fileNames.length} files total.`;
}

export function __forTestFilesystemEmptyAnswerFallbackText(fileNames) {
  return filesystemEmptyAnswerFallbackText(fileNames);
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function reconcileAssistantMessageOnRunEnd(db, runs, run) {
  if (!run.assistantMessageId) return;
  void runs
    .wait(run)
    .then((finalStatus) => {
      flushRunMessageEvents(run.assistantMessageId);
      // Daemon-side persistence sink: stamps the terminal run status, repairs
      // runs whose pinned message never received stream events (early
      // failures), and enqueues the native project-timeline delivery so
      // API-only clients (mobile app, MCP/SDK) get complete history without
      // the web's finalize PUT. Client writes always take priority — see the
      // client-PUT-priority rule on finalizeAssistantMessageFromRunEvents.
      finalizeAssistantMessageFromRunEvents({
        db,
        run,
        finalStatus: finalStatus.status,
      });
      // MatOS group chat: the daemon owns fan-out/auto-relay continuation, so
      // every terminal run in a group conversation flows through this hook —
      // including runs whose browser tab closed mid-run. The continuation is
      // idempotent with the PUT-finalize and durable-task callers.
      projectGroupDispatchHook.current?.({
        projectId: run.projectId ?? null,
        conversationId: run.conversationId ?? null,
        assistantMessageId: run.assistantMessageId,
        runId: run.id ?? null,
        finalStatus: finalStatus.status,
      });
    })
    .catch((err) => {
      console.warn('[runs] message reconciliation failed', err);
    });
}


const RUN_MESSAGE_EVENT_FLUSH_MS = 50;
const pendingRunMessageEvents = new Map();

function flushRunMessageEvents(messageId) {
  const pending = pendingRunMessageEvents.get(messageId);
  if (!pending) return;
  pendingRunMessageEvents.delete(messageId);
  if (pending.timer) clearTimeout(pending.timer);
  try {
    appendMessageAgentEvents(pending.db, messageId, pending.events);
  } catch (err) {
    console.warn('[runs] message event persistence failed', err);
  }
}

function queueRunMessageEvent(db, messageId, persisted, flushNow) {
  let pending = pendingRunMessageEvents.get(messageId);
  if (!pending) {
    pending = { db, events: [], timer: null };
    pendingRunMessageEvents.set(messageId, pending);
  }
  pending.events.push(persisted);
  if (flushNow) {
    flushRunMessageEvents(messageId);
    return;
  }
  if (pending.timer) return;
  pending.timer = setTimeout(() => flushRunMessageEvents(messageId), RUN_MESSAGE_EVENT_FLUSH_MS);
  pending.timer.unref?.();
}

function persistRunEventToAssistantMessage(db, run, event, data) {
  if (!run.assistantMessageId) return;
  const persisted = runSseEventToPersistedAgentEvent(event, data);
  if (!persisted) return;
  queueRunMessageEvent(
    db,
    run.assistantMessageId,
    persisted,
    event === 'error' || (persisted.kind !== 'text' && persisted.kind !== 'thinking'),
  );
}

// runSseEventToPersistedAgentEvent / daemonAgentPayloadToPersistedAgentEvent
// moved to ./runtimes/run-message-finalize.ts so live persistence (here) and
// the run-terminal reconcile share one projection. Imported above.

function pinAssistantMessageOnRunCreate(db, run) {
  if (!run.conversationId || !run.assistantMessageId) return;
  const userMessageId = typeof run.userMessageId === 'string' && run.userMessageId
    ? run.userMessageId
    : null;
  const existing = db
    .prepare(`SELECT id FROM messages WHERE id = ?`)
    .get(run.assistantMessageId);
  if (existing) {
    db.prepare(
      `UPDATE messages
          SET run_id = ?,
              run_status = CASE
                WHEN run_status IN ('succeeded', 'failed', 'canceled') THEN run_status
                ELSE ?
              END,
              started_at = COALESCE(started_at, ?),
              turn_user_message_id = COALESCE(turn_user_message_id, ?)
        WHERE id = ?`,
    ).run(run.id, run.status, run.createdAt, userMessageId, run.assistantMessageId);
    if (userMessageId) {
      reconcileMessageTurnOrder(db, run.conversationId, [{
        userMessageId,
        assistantMessageId: run.assistantMessageId,
      }]);
    }
    return;
  }
  upsertMessage(db, run.conversationId, {
    id: run.assistantMessageId,
    role: 'assistant',
    content: '',
    agentId: run.agentId ?? undefined,
    // MatOS roles project as models: stamp the member that answers this turn.
    roleRef: typeof run.model === 'string' && run.model.startsWith('role:')
      ? run.model
      : undefined,
    events: [],
    runId: run.id,
    runStatus: run.status,
    turnUserMessageId: userMessageId ?? undefined,
    startedAt: run.createdAt,
  });
}

const FORM_ANSWERS_HEADER_RE = /^\s*\[form answers\s+(?:\u2014|-)\s*([^\]\r\n]+)\]/i;

// Aggressive OVERRIDE for weak / medium-strength plain agents (e.g.
// GPT-OSS-120B Medium, Gemini 3.5 Flash) that otherwise echo RULE 1's
// fenced form example back at the user on follow-up turns even when
// they correctly understand the form is answered. Strong models
// (Claude Sonnet 4.6, Gemini 3.1 Pro) already handle a shorter
// OVERRIDE; enumerating the anti-patterns is a no-op for them and a
// strong suppressor for the weaker ones. RULE 1 itself stays in the
// system prompt so turn 1 can still emit a valid form.
//
// Exported so tests pin both the trigger condition and the literal
// anti-patterns we ask the model to skip \u2014 silently weakening the
// list (e.g. dropping the markdown-fence ban) would reintroduce the
// form-echo regression on GPT-OSS / Gemini Flash.
export const FORM_ANSWERED_SYSTEM_OVERRIDE = `## OVERRIDE \u2014 form already answered (this is turn 2 or later)

The user already submitted their form answers (see # User request below).
RULE 1 documents the turn-1 ask flow; that flow is finished. Treat RULE 1
as read-only documentation for this turn \u2014 do not execute any of it.

Forbidden output for this turn:
- A \`<question-form>\` tag of any id, including \`discovery\` or \`task-type\`.
- A markdown \`\`\`json fenced block echoing the form schema or example.
- Form-asking prose such as "Got it \u2014 tell me the following" or
  "\u8bf7\u544a\u8bc9\u6211\u4ee5\u4e0b\u4fe1\u606f".
- Narrating fake system events such as "subagents stopped" or
  "server restart".

Required output for this turn:
- Open with a brief prose confirmation of what the brief is.
- Then proceed to RULE 2 (pick the visual direction) and RULE 3
  (emit the \`<artifact>\` block with the full HTML document).

`;

// Smaller override for non-discovery / non-task-type form ids. These
// forms are not artifact-build transitions, so we only need to suppress
// the form re-ask without directing the model toward RULE 2 / RULE 3.
// Exported so tests can pin the literal content independently.
export const FORM_ANSWERED_GENERIC_OVERRIDE = `## OVERRIDE \u2014 form already answered (this is turn 2 or later)

The user already submitted their form answers (see # User request below).
Do not ask the same form again. Treat the submitted answers as the active
user instruction and respond accordingly.

`;

function formAnswerTransitionForCurrentPrompt(currentPrompt) {
  if (typeof currentPrompt !== 'string') return null;
  const trimmed = currentPrompt.trim();
  if (!trimmed) return null;
  const match = FORM_ANSWERS_HEADER_RE.exec(trimmed);
  if (!match) return null;
  const rawFormId = (match[1] || 'form').trim() || 'form';
  const formId = rawFormId.replace(/[^\w.-]/g, '') || 'form';
  const lines = [
    '## Latest user turn - form answers submitted',
    trimmed,
    '',
    // Keep the wording in lock-step with main — the stronger "do not
    // emit any `<question-form>`" suppression now lives in the
    // system-prompt `FORM_ANSWERED_SYSTEM_OVERRIDE` block, which
    // every plain / stream-json adapter sees. Diverging the
    // user-request transition string here breaks `chat-route.test
    // marks submitted discovery form answers ...` which asserts on
    // the exact main wording.
    `The user has answered the ${formId} form. Do not emit another ${formId} form.`,
  ];
  if (formId.toLowerCase() === 'discovery' || formId.toLowerCase() === 'task-type') {
    lines.push(
      'Continue with RULE 2 / RULE 3 now. For Branch B answers, build now instead of asking another brief.',
    );
  } else {
    lines.push(
      'Treat these form answers as the active user turn instead of replaying the transcript as a fresh request.',
    );
  }
  return lines.join('\n');
}

export function composeChatUserRequestForAgent(
  message,
  currentPrompt,
  options: { skipTranscript?: boolean } = {},
) {
  // When the adapter resumes its own session (today: `agy -c`), the
  // daemon-rendered `## user` / `## assistant` transcript is a duplicate
  // of what the upstream CLI already has in memory — and the embedded
  // copy carries the literal `<question-form>` markup the agent emitted
  // on turn 1, which the model then re-emits on turn 2. Send only the
  // latest user turn (`currentPrompt`) in that case; the upstream
  // session memory provides the rest. See
  // `RuntimeAgentDef.resumesSessionViaCli`.
  const skip = options.skipTranscript === true;
  const bodySource = skip ? currentPrompt : message;
  const body =
    typeof bodySource === 'string' && bodySource.trim()
      ? bodySource
      : '(No extra typed instruction.)';
  const transition = formAnswerTransitionForCurrentPrompt(currentPrompt);
  if (!transition) return body;
  if (skip) {
    return [transition, body].join('\n\n');
  }
  return [
    transition,
    '## Full conversation transcript',
    body,
  ].join('\n\n');
}

export function buildMatOSResumeDelta(
  messages: Array<Record<string, any>>,
  input: {
    afterMessageId: string;
    currentAssistantMessageId?: string | null;
    currentPrompt?: string | null;
    maxChars?: number;
    maxMessages?: number;
  },
): string {
  const cursor = messages.findIndex(message => message.id === input.afterMessageId);
  if (cursor < 0) return '';
  const currentPrompt = typeof input.currentPrompt === 'string'
    ? input.currentPrompt.trim()
    : '';
  let candidates = messages
    .slice(cursor + 1)
    .filter(message => message.id !== input.currentAssistantMessageId)
    .filter(message => message.role === 'user' || message.role === 'assistant');
  if (
    candidates.at(-1)?.role === 'user' &&
    String(candidates.at(-1)?.content ?? '').trim() === currentPrompt
  ) {
    candidates = candidates.slice(0, -1);
  }
  const maxChars = Math.max(4_000, input.maxChars ?? 48_000);
  const maxMessages = Math.min(100, Math.max(1, input.maxMessages ?? 24));
  const selected: string[] = [];
  let used = 0;
  for (const message of candidates.slice(-maxMessages).reverse()) {
    const content = String(message.content ?? '').trim();
    if (!content) continue;
    const roleLabel = message.role === 'assistant' && typeof message.roleRef === 'string'
      ? `assistant (${message.roleRef})`
      : message.role;
    let block = `### ${roleLabel}\n${content.slice(0, 8_000)}`;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      if (selected.length > 0) break;
      block = block.slice(0, remaining);
    }
    selected.push(block);
    used += block.length;
  }
  if (selected.length === 0) return '';
  return selected.reverse().join('\n\n');
}

// Filename slug for the Content-Disposition header on archive downloads.
// Browsers reject quotes and control bytes; we keep Unicode letters/digits
// so a project name with non-ASCII characters (e.g. "café-design")
// survives instead of becoming a row of underscores.
function sanitizeArchiveFilename(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned;
}

function normalizeLocalAuthority(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s/@]/.test(trimmed) || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(`http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

function isLoopbackPeerAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  if (normalized.startsWith('::ffff:')) return isLoopbackPeerAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

const PROJECT_PREVIEW_SCOPE_TTL_MS = 60 * 60 * 1000;
const PROJECT_PREVIEW_ASSET_PATH_RE = /^\/projects\/([^/]+)\/preview\/([^/]+)\/.+$/u;

function createProjectPreviewScopeRegistry() {
  const scopes = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [scope, entry] of scopes) {
      if (entry.expiresAt <= now) scopes.delete(scope);
    }
  }

  return {
    mint(projectId) {
      pruneExpired();
      const scope = randomUUID();
      scopes.set(scope, {
        projectId: String(projectId),
        expiresAt: Date.now() + PROJECT_PREVIEW_SCOPE_TTL_MS,
      });
      return scope;
    },
    validate(projectId, scope) {
      const key = String(scope || '');
      const entry = scopes.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= Date.now()) {
        scopes.delete(key);
        return false;
      }
      return entry.projectId === String(projectId);
    },
  };
}

function parseProjectPreviewAssetPath(pathname) {
  const match = PROJECT_PREVIEW_ASSET_PATH_RE.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]),
      scope: match[2],
    };
  } catch {
    return null;
  }
}

function localOriginFromHeader(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateLocalDaemonRequest(req) {
  if (!isLoopbackPeerAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      message: 'request peer must be a loopback address',
      details: { peer: 'remoteAddress' },
    };
  }

  // Reverse-proxy escape hatch (mirrors isLocalSameOrigin): behind the MatOS
  // gateway the daemon still sees a loopback peer, but Host/Origin carry the
  // browser-visible gateway origin. An Origin that exactly matches an
  // operator-allowlisted OD_ALLOWED_ORIGINS entry is trusted — the gateway
  // session is the security boundary there, and the daemon stays bound to
  // loopback so no other network path can present that header combination.
  const originHeader = req.get('origin');
  if (typeof originHeader === 'string' && originHeader) {
    try {
      if (configuredAllowedOrigins().includes(new URL(originHeader).origin)) {
        return { ok: true, origin: new URL(originHeader).origin };
      }
    } catch {
      // fall through to the strict loopback validation below
    }
  } else if (req.get('sec-fetch-site') === 'same-origin') {
    // Same-origin GETs omit Origin per the Fetch spec. Sec-Fetch-Site is
    // UA-controlled (a cross-site subresource would carry "cross-site"),
    // so pair it with an allowlisted Host to accept proxied same-origin
    // reads.
    const hostHeader = String(req.get('host') || '');
    if (configuredAllowedHosts().includes(hostHeader)) {
      return { ok: true, origin: null };
    }
  }

  const host = normalizeLocalAuthority(req.get('host'));
  if (!host || !isLoopbackHostname(host.hostname)) {
    return {
      ok: false,
      message: 'request host must be a loopback daemon address',
      details: { header: 'host' },
    };
  }

  if (originHeader !== undefined && !localOriginFromHeader(originHeader)) {
    return {
      ok: false,
      message: 'request origin must be a loopback daemon origin',
      details: { header: 'origin' },
    };
  }

  return { ok: true, origin: localOriginFromHeader(originHeader) };
}

function requireLocalDaemonRequest(req, res, next) {
  const validation = validateLocalDaemonRequest(req);
  if (!validation.ok) {
    return sendApiError(res, 403, 'FORBIDDEN', validation.message, validation.details ? { details: validation.details } : {});
  }

  res.setHeader('Vary', 'Origin');
  if (validation.origin) {
    res.setHeader('Access-Control-Allow-Origin', validation.origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  next();
}



function bearerTokenFromRequest(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function authorizeToolRequest(req, res, operation) {
  const endpoint = req.path;
  const validation = toolTokenRegistry.validate(bearerTokenFromRequest(req), { endpoint, operation });
  if (!validation.ok) {
    const status = validation.code === 'TOOL_ENDPOINT_DENIED' || validation.code === 'TOOL_OPERATION_DENIED' ? 403 : 401;
    sendApiError(res, status, validation.code, validation.message, {
      details: { endpoint, operation },
    });
    return null;
  }
  return validation.grant;
}

function optionalToolGrantFromRequest(req, options = {}) {
  const validation = toolTokenRegistry.validate(bearerTokenFromRequest(req), options);
  return validation.ok ? validation.grant : null;
}

function requestProjectOverride(projectId, tokenProjectId) {
  return typeof projectId === 'string' && projectId.length > 0 && projectId !== tokenProjectId;
}

function requestRunOverride(runId, tokenRunId) {
  return typeof runId === 'string' && runId.length > 0 && runId !== tokenRunId;
}

function openNativeFolderDialog() {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      // `choose folder` is handled specially by the system: it presents a fully
      // interactive standard navigation panel that reliably takes key focus
      // (unlike a JXA-driven NSOpenPanel from background-only osascript, which
      // renders but can't be clicked). That standard panel already includes a
      // "New Folder" button in the bottom-left, so users can create a folder
      // inline without any extra wiring.
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select a code folder to link")'],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim().replace(/\/$/, '');
          resolve(p || null);
        },
      );
    } else if (platform === 'linux') {
      execFile(
        'zenity',
        ['--file-selection', '--directory', '--title=Select a code folder to link'],
        { timeout: 120_000 },
        (err, stdout, stderr) => {
          try {
            resolve(parseLinuxFolderDialogResult(err, stdout, stderr));
          } catch (folderDialogError) {
            reject(folderDialogError);
          }
        },
      );
    } else if (platform === 'win32') {
      const command = buildWindowsFolderDialogCommand();
      execFile(command.command, command.args, { timeout: 120_000 }, (err, stdout) => {
        resolve(parseFolderDialogStdout(err, stdout));
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function createSseErrorPayload(code, message, init = {}) {
  return { message, error: createCompatApiError(code, message, init) };
}




fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Project-scoped multi-file upload. Lands files directly in the project
// folder (flat — same shape FileWorkspace expects), so the composer's
// pasted/dropped/picked images become referenceable filenames the agent
// can Read or @-mention without any cross-folder gymnastics.
// Bridge between the multer upload-storage destination (built at module
// init) and the per-process project DB (instantiated inside startServer).
// startServer() sets this so the upload destination can route attachments
// into the right project root, including folder-imported projects whose
// files live under metadata.baseDir.
let projectMetadataLookup: ((id: string) => Record<string, unknown> | null) | null = null;

const projectUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        // Route uploads into the project's actual root: for folder-imported
        // projects (metadata.baseDir set) attachments need to land alongside
        // the user's files so the agent can read them via the same path
        // it sees. projectMetadataLookup is populated at startServer() boot
        // and keyed by project id; null fallback gives the standard
        // .od/projects/<id>/ behavior for non-imported projects.
        const meta = projectMetadataLookup?.(req.params.id) ?? null;
        // Optional `dir` form field (sent BEFORE the file parts by the web
        // client) routes uploads into a subfolder, so files dropped/picked
        // while viewing a folder land there instead of the project root. The
        // sanitized relative dir is stashed on the request so the route can
        // report each file's true project-relative path.
        const subdir = typeof req.body?.dir === 'string' ? req.body.dir : '';
        const { absDir, relDir } = await ensureProjectSubdir(
          PROJECTS_DIR,
          req.params.id,
          subdir,
          meta,
        );
        (req as any)._uploadRelDir = relDir;
        (req as any)._uploadAbsDir = absDir;
        cb(null, absDir);
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (req, file, cb) => {
      // multer@1 hands us latin1-decoded multipart filenames; restore the
      // original UTF-8 so the response (and the on-disk name) preserves
      // non-ASCII characters instead of mangling them. Then run the shared
      // sanitiser and only add a suffix when that sanitized source name
      // would collide with an existing or same-batch upload.
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      const uploadDir = typeof (req as any)._uploadAbsDir === 'string' ? (req as any)._uploadAbsDir : '';
      const reserved = (req as any)._uploadReservedNames instanceof Set
        ? (req as any)._uploadReservedNames
        : ((req as any)._uploadReservedNames = new Set());
      cb(null, uniqueUploadFileName(uploadDir, safe, reserved));
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200MB — covers the largest design assets we expect (PPTX/PDF/raw images)
});

function uniqueUploadFileName(uploadDir, safeName, reserved) {
  const parsed = path.parse(safeName);
  const base = parsed.name || parsed.base || 'file';
  const ext = parsed.ext || '';
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? safeName : `${base}-${index}${ext}`;
    if (reserved.has(candidate)) continue;
    if (uploadDir && fs.existsSync(path.join(uploadDir, candidate))) continue;
    reserved.add(candidate);
    return candidate;
  }
  const fallback = `${base}-${Date.now().toString(36)}${ext}`;
  reserved.add(fallback);
  return fallback;
}

function handleProjectUpload(req, res, next) {
  projectUpload.array('files', 12)(req, res, (err) => {
    if (err) {
      return sendMulterError(res, err);
    }
    next();
  });
}

function sendMulterError(res, err) {
  if (err instanceof multer.MulterError) {
    const code = err.code || 'UPLOAD_ERROR';
    const statusByCode = {
      LIMIT_FILE_SIZE: 413,
      LIMIT_FILE_COUNT: 400,
      LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT: 400,
      LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 400,
      LIMIT_FIELD_COUNT: 400,
      MISSING_FIELD_NAME: 400,
    };
    const errorByCode = {
      LIMIT_FILE_SIZE: 'file too large',
      LIMIT_FILE_COUNT: 'too many files',
      LIMIT_UNEXPECTED_FILE: 'unexpected file field',
      LIMIT_PART_COUNT: 'too many form parts',
      LIMIT_FIELD_KEY: 'field name too long',
      LIMIT_FIELD_VALUE: 'field value too long',
      LIMIT_FIELD_COUNT: 'too many form fields',
      MISSING_FIELD_NAME: 'missing field name',
    };
    const status = statusByCode[code] ?? 400;
    const message = errorByCode[code] ?? 'upload failed';
    return sendApiError(
      res,
      status,
      code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message,
      { details: { legacyCode: code } },
    );
  }

  if (err) {
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
  }

  return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
}

export function createSseResponse(
  res,
  { keepAliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS } = {},
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const canWrite = () => !res.destroyed && !res.writableEnded;
  const writeKeepAlive = () => {
    if (canWrite()) {
      res.write(': keepalive\n\n');
      return true;
    }
    return false;
  };

  let heartbeat = null;
  if (keepAliveIntervalMs > 0) {
    heartbeat = setInterval(writeKeepAlive, keepAliveIntervalMs);
    heartbeat.unref?.();
  }

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return {
    /** @param {ChatSseEvent['event'] | ProxySseEvent['event'] | string} event */
    send(event, data, id: string | number | null | undefined = null) {
      if (!canWrite()) return false;
      // Assemble the full SSE event into a single write so id/event/data land
      // in one TCP chunk. Three separate writes would let `event: <type>` flush
      // ahead of the `data:` payload, which produces partial events for
      // consumers that read chunk-by-chunk (e.g. tests using a Response body
      // reader with a substring marker).
      const idLine = id !== null && id !== undefined ? `id: ${id}\n` : '';
      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    writeKeepAlive,
    cleanup,
    end() {
      cleanup();
      if (canWrite()) {
        res.end();
      }
    },
  };
}

export type DesktopPdfExporter = (input: DesktopExportPdfInput) => Promise<DesktopExportPdfResult>;
export type DesktopSlideRenderer = (input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult>;
export type DesktopArtifactExporter = (input: DesktopExportArtifactInput) => Promise<DesktopExportArtifactResult>;

// Loosely typed shape — we only access `namespace`, `base`, `mode`, and
// `source` from the runtime context when building the diagnostics export.
// Anything richer would force a dependency from server.ts into the sidecar
// package, which the boundary checks explicitly forbid.
export interface DaemonRuntimeContext {
  namespace: string;
  base: string;
  mode?: string;
  source?: string;
}

export interface StartServerOptions {
  desktopArtifactExporter?: DesktopArtifactExporter | null;
  desktopPdfExporter?: DesktopPdfExporter | null;
  desktopSlideRenderer?: DesktopSlideRenderer | null;
  host?: string;
  port?: number;
  returnServer?: boolean;
  runtime?: DaemonRuntimeContext | null;
}

export interface StartServerResult {
  url: string;
  server: import('node:http').Server;
  shutdown: () => Promise<void> | void;
  routeInventory: import('./route-registration-guard.js').RouteRegistration[];
}

export async function startServer({
  port = 7456,
  host = normalizeDaemonBindHost(process.env.OD_BIND_HOST),
  returnServer = false,
  desktopPdfExporter = null,
  desktopSlideRenderer = null,
  desktopArtifactExporter = null,
  runtime = null,
}: StartServerOptions = {}) {
  host = normalizeDaemonBindHost(host);
  let resolvedPort = port;
  let daemonShuttingDown = false;
  const extraAllowedOrigins = configuredAllowedOrigins();

  // Plan §3.K1 / spec §15.7 — bound-API-token guard.
  //
  // The daemon refuses to bind to a public interface unless an
  // OD_API_TOKEN is set. This is the spec §16 Phase 5 safety floor:
  // a hosted operator can no longer accidentally publish an unsecured
  // daemon by setting OD_BIND_HOST=0.0.0.0 without a token.
  //
  // Loopback hosts (127.0.0.1 / ::1 / localhost) are always allowed —
  // the desktop / dev flow remains unchanged. Setting OD_API_TOKEN is
  // purely additive: when present, every /api/* request must carry a
  // matching `Authorization: Bearer <token>` header (loopback origins
  // are exempted so the desktop UI keeps working).
  const apiToken = apiTokenFromEnv();
  const apiAuthDisabled = isApiAuthDisabled();
  if (!isLoopbackHostname(host) && apiToken.length === 0 && !apiAuthDisabled) {
    throw new Error(
      `OD_BIND_HOST=${host} requires OD_API_TOKEN to be set. ` +
      `Generate one with \`openssl rand -hex 32\` and re-launch. ` +
      `(Loopback hosts 127.0.0.1 / ::1 / localhost do not need a token.) ` +
      `Set OD_DISABLE_API_AUTH=1 only when a trusted reverse proxy already authenticates every request.`,
    );
  }

  const app = express();
  installRouteRegistrationGuard(app);
  registerApiCompression(app);
  // Clipper page captures are self-contained HTML with inlined images plus a
  // Figma IR, which for an image-heavy site (The Economist, news front pages)
  // runs to tens of MB — far past a normal JSON body. Give the ingest route a
  // dedicated generous limit so a full-page capture doesn't 413; the rest of the
  // Large project recovery baselines can exceed 4 MiB. Keep this exception
  // limited to individual message writes; all other JSON stays bounded below.
  app.use(createChatMessageBodyParser());
  app.use(express.json({ limit: '4mb' }));
  const projectPreviewScopes = createProjectPreviewScopeRegistry();

  // Plan §3.K1 — bearer-token middleware.
  //
  // Active only when OD_API_TOKEN is set and API auth is not disabled.
  // Loopback origins skip the
  // check (the desktop UI / local CLI never carry a bearer); every
  // other request must present `Authorization: Bearer <token>` with a
  // value matching `OD_API_TOKEN`. Health / readiness / version remain
  // open so monitoring probes don't need the token. Server-minted
  // project preview asset scopes are also accepted for GETs so sandboxed
  // browser iframes can load HTML/CSS/JS without privileged headers.
  // Rich daemon status stays authenticated because it includes local
  // runtime paths.
  if (isApiTokenMiddlewareEnabled()) {
    const openProbePaths = new Set([
      '/health',
      '/api/health',
      '/ready',
      '/api/ready',
      '/version',
      '/api/version',
    ]);
    app.use('/api', (req, res, next) => {
      if (openProbePaths.has(req.path)) return next();
      if (req.method === 'GET') {
        const previewAsset = parseProjectPreviewAssetPath(req.path);
        if (
          previewAsset &&
          projectPreviewScopes.validate(previewAsset.projectId, previewAsset.scope)
        ) {
          return next();
        }
      }
      // Loopback short-circuit. We ignore the proxied X-Forwarded-For
      // header here because a reverse proxy MUST always forward the
      // bearer; the loopback bypass exists for the localhost desktop
      // UI which has no proxy in the path.
      if (isLoopbackPeerAddress(req.socket?.remoteAddress)) return next();
      const auth = req.get('authorization') ?? '';
      const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      if (!match || match[1] !== apiToken) {
        return res.status(401).json({
          error: { code: 'API_TOKEN_REQUIRED', message: 'Authorization: Bearer <OD_API_TOKEN> required' },
        });
      }
      return next();
    });
  }

  async function listAllSkills() {
    return listSkills(SKILL_ROOTS);
  }

  async function listAllDesignTemplates() {
    return listSkills(DESIGN_TEMPLATE_ROOTS);
  }

  async function listAllSkillLikeEntries() {
    return listSkills(ALL_SKILL_LIKE_ROOTS);
  }

  async function validateProjectSkillId(id) {
    if (id === undefined || id === null || id === '') return { ok: true, id: null };
    if (typeof id !== 'string') {
      return {
        ok: false,
        code: 'INVALID_SKILL_ID',
        message: 'skillId must be a string or null',
      };
    }
    const allSkills = await listAllSkillLikeEntries();
    const resolved = findSkillById(allSkills, id);
    if (!resolved) {
      return {
        ok: false,
        code: 'SKILL_NOT_FOUND',
        message: 'skill not found',
      };
    }
    return { ok: true, id: resolved.id };
  }

  // Chrome may strip the port from the Origin header on same-origin GET
  // requests. Only use this as a fallback for safe, idempotent GET requests;
  // mutating routes always require an exact origin/host match.
  function isPortlessLoopbackOrigin(origin) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])$/.test(origin);
  }

  // Routes that serve content to sandboxed iframes (Origin: null) for
  // read-only purposes.  All other /api routes reject Origin: null.
  const _NULL_ORIGIN_SAFE_GET_RE =
    /^\/projects\/[^/]+\/(?:raw|preview)\/|^\/asset-cache$/;

  // Reject cross-origin requests to API endpoints.
  // Health/version remain open for monitoring probes.
  // Non-browser clients (no Origin header) are always allowed.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    // Non-browser client → allow.
    if (origin == null || origin === '') return next();

    // Origin: null (sandboxed iframes).  Only allowed for safe, read-only
    // routes that set their own CORS headers for canvas drawing.
    if (origin === 'null') {
      const isSafeReadOnly =
        req.method === 'GET' && _NULL_ORIGIN_SAFE_GET_RE.test(req.path);
      if (!isSafeReadOnly) {
        return res.status(403).json({ error: 'Origin: null not allowed for this route' });
      }
      return next();
    }

    // Fail-closed: block all browser origins until port is resolved.
    if (!resolvedPort) {
      return res.status(403).json({ error: 'Server initializing' });
    }

    const ports = allowedBrowserPorts(resolvedPort);
    if (!isAllowedBrowserOrigin(origin, req.headers.host, ports, host, extraAllowedOrigins)) {
      if (req.method !== 'GET' || !isPortlessLoopbackOrigin(String(origin))) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      }
    }
    next();
  });
  const db = openDatabase(PROJECT_ROOT, { dataDir: RUNTIME_DATA_DIR });
  // Wire the upload-destination bridge to this db so multer can route
  // file uploads into baseDir-rooted projects' actual folders.
  projectMetadataLookup = (id) => {
    try { return getProject(db, id)?.metadata ?? null; } catch { return null; }
  };

  // RoutineService persistence is a thin adapter over the SQLite helpers.
  // Routines are stored as DB rows; the service holds in-memory timers and
  // delegates "list me everything" / "record a run" back to SQLite.
  routineService = new RoutineService({
    list: () => listRoutines(db).map((row) => routineDbRowToContract(row, null)),
    insertRun: (run, options) => {
      const row = {
        id: run.id,
        routineId: run.routineId,
        trigger: run.trigger,
        status: run.status,
        projectId: run.projectId,
        conversationId: run.conversationId,
        agentRunId: run.agentRunId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        summary: run.summary,
        error: run.error,
        errorCode: run.errorCode,
      };
      if (options?.scheduledSlotAt != null) {
        return Boolean(insertScheduledRoutineRun(db, row, options.scheduledSlotAt));
      }
      insertRoutineRun(db, row);
      return true;
    },
    updateRun: (id, patch) => {
      updateRoutineRun(db, id, patch);
    },
    getLatestRun: (routineId) => getLatestRoutineRun(db, routineId),
  });
  let daemonUrl = `http://127.0.0.1:${port}`;

  // Warm agent detection so the first /api/chat hits a populated model cache
  // even if /api/agents hasn't been called yet. MatOS product mode exposes
  // only the native runtime, so apply that selection before startup probes
  // spawn rather than probing the complete upstream registry.
  const startupAgentDetectionOptions =
    process.env.MATOS_AGENT_ONLY !== '0' ? { agentIds: ['matos'] } : {};
  void readAppConfig(RUNTIME_DATA_DIR)
    .then((config) => {
      return detectAgents(config.agentCliEnv ?? {}, startupAgentDetectionOptions);
    })
    .catch(() => detectAgents({}, startupAgentDetectionOptions).catch(() => {}));

  if (fs.existsSync(STATIC_DIR)) {
    registerStaticDelivery(app, STATIC_DIR);
  }

  // ---- Projects (DB-backed) -------------------------------------------------


  registerAutomationRoutes(app, {
    paths: { RUNTIME_DATA_DIR },
  });

  // Reconcile follow-up — the inline POST /api/projects body that lived
  // on garnet (with baseDir privilege check, linkedDirs validation,
  // template snapshot seeding) is intentionally dropped here. main moved
  // project route registration into `./routes/project/index.js` via PR
  // #1043, so the simple project-create surface is wired through
  // `registerProjectRoutes` further down.
  // (legacy POST /api/projects body deleted — see registerProjectRoutes below.)

  const resolvePersistedChatRunMetadata = (runId) => {
    const row = db.prepare(
      `SELECT m.id AS assistantMessageId,
              m.conversation_id AS conversationId,
              m.agent_id AS agentId,
              m.role_ref AS roleRef,
              m.run_status AS persistedRunStatus,
              m.last_run_event_id AS lastRunEventId,
              m.created_at AS messageCreatedAt,
              m.started_at AS messageStartedAt,
              m.ended_at AS messageEndedAt,
              c.project_id AS projectId
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.run_id = ?
        ORDER BY m.position DESC
        LIMIT 1`,
    ).get(runId);
    if (!row) return null;
    const project = typeof row.projectId === 'string' && row.projectId
      ? getProject(db, row.projectId)
      : null;
    return {
      projectId: typeof row.projectId === 'string' ? row.projectId : null,
      conversationId: typeof row.conversationId === 'string' ? row.conversationId : null,
      assistantMessageId:
        typeof row.assistantMessageId === 'string' ? row.assistantMessageId : null,
      agentId: typeof row.agentId === 'string' ? row.agentId : null,
      model: typeof row.roleRef === 'string' ? row.roleRef : null,
      persistedRunStatus:
        typeof row.persistedRunStatus === 'string' ? row.persistedRunStatus : null,
      lastRunEventId:
        typeof row.lastRunEventId === 'string' ? row.lastRunEventId : null,
      messageCreatedAt:
        typeof row.messageCreatedAt === 'number' ? row.messageCreatedAt : null,
      messageStartedAt:
        typeof row.messageStartedAt === 'number' ? row.messageStartedAt : null,
      messageEndedAt:
        typeof row.messageEndedAt === 'number' ? row.messageEndedAt : null,
      projectMetadata: project?.metadata ?? null,
    };
  };
  const listPersistedActiveChatRunIds = ({ projectId, conversationId }) => {
    const clauses = [
      `m.run_id IS NOT NULL`,
      `m.run_status IN ('queued', 'running')`,
    ];
    const params = [];
    if (typeof projectId === 'string' && projectId) {
      clauses.push('c.project_id = ?');
      params.push(projectId);
    }
    if (typeof conversationId === 'string' && conversationId) {
      clauses.push('m.conversation_id = ?');
      params.push(conversationId);
    }
    return db.prepare(
      `SELECT DISTINCT m.run_id AS runId
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(m.started_at, m.created_at) DESC
        LIMIT 100`,
    ).all(...params)
      .map((row) => row.runId)
      .filter((runId) => typeof runId === 'string' && runId);
  };
  const recoverInterruptedChatRunSession = (run) => {
    const def = getAgentDef(run.agentId);
    if (!def || !runtimeResumesSessionById(def) || !run.conversationId) {
      return { resumable: false };
    }
    const sideEffects = scanRunEventsForRetrySideEffects(run.events);
    const committedWorkSeen = Boolean(
      sideEffects.toolCallSeen ||
      sideEffects.artifactWriteSeen,
    );
    if (!committedWorkSeen) return { resumable: false };
    let sessionId = null;
    for (let index = run.events.length - 1; index >= 0; index -= 1) {
      const data = run.events[index]?.data;
      if (data?.type === 'status' && typeof data.sessionId === 'string' && data.sessionId) {
        sessionId = data.sessionId;
        break;
      }
    }
    if (!sessionId) return { resumable: false };
    const startData = run.events.find((record) => record?.event === 'start')?.data ?? {};
    const model = typeof run.model === 'string' && run.model
      ? run.model
      : typeof startData.model === 'string' && startData.model
        ? startData.model
        : null;
    const cwd = typeof startData.cwd === 'string' && startData.cwd
      ? startData.cwd
      : null;
    const agentSessionId = model ? `matos:${model}` : def.id;
    const existingSession = db.prepare(
      `SELECT a.session_id AS sessionId,
              a.last_message_id AS lastMessageId,
              a.updated_at AS updatedAt,
              existing.position AS existingPosition,
              recovering.position AS recoveringPosition
         FROM agent_sessions a
         LEFT JOIN messages existing ON existing.id = a.last_message_id
         LEFT JOIN messages recovering ON recovering.id = ?
        WHERE a.conversation_id = ? AND a.agent_id = ?`,
    ).get(run.assistantMessageId ?? '', run.conversationId, agentSessionId);
    const existingIsNewer = shouldPreserveExistingAgentSession(existingSession, {
      assistantMessageId: run.assistantMessageId,
      updatedAt: run.updatedAt,
    });
    if (existingIsNewer) {
      // Lazy recovery can be triggered by opening an old failed turn long
      // after this conversation has continued. Never roll the active session
      // cursor back to an older upstream thread in that case.
      return { resumable: false };
    }
    const stored = safeUpsertAgentSession(db, {
      conversationId: run.conversationId,
      agentId: agentSessionId,
      sessionId,
      // A restarted daemon cannot recover the exact stable prompt digest from
      // memory. Null forces a safe full re-send on Continue while retaining the
      // upstream session and its committed tool state.
      stablePromptHash: null,
      model,
      cwd,
      lastMessageId: run.assistantMessageId ?? null,
    }, { runId: run.id, phase: 'daemon-restart-recovery' });
    return { resumable: stored === true };
  };
  const reconcileRecoveredChatRun = (run, recovery) => {
    if (!recovery?.interrupted || !run.assistantMessageId) return;
    finalizeAssistantMessageFromRunEvents({
      db,
      run,
      finalStatus: run.status,
    });
    const finalEventId = run.events.at(-1)?.id;
    if (Number.isInteger(finalEventId)) {
      db.prepare(
        `UPDATE messages
            SET last_run_event_id = ?
          WHERE id = ?`,
      ).run(String(finalEventId), run.assistantMessageId);
    }
  };
  const design = {
    runs: createChatRunService({
      createSseResponse,
      createSseErrorPayload,
      runsLogDir: path.join(RUNTIME_DATA_DIR, 'runs'),
      resolvePersistedRunMetadata: resolvePersistedChatRunMetadata,
      listPersistedRunIds: listPersistedActiveChatRunIds,
      recoverInterruptedRun: recoverInterruptedChatRunSession,
      onRecoveredRun: reconcileRecoveredChatRun,
    }),
  };

  // Interactive Terminal sessions (node-pty). In-memory, process-local, and
  // killed on daemon shutdown — see shutdownDaemonRuns below.
  const terminalService = createTerminalService();


  const resolvedPortRef = {
    get current() {
      return resolvedPort;
    },
  };
  const daemonUrlRef = {
    get current() {
      return daemonUrl;
    },
  };
  const httpDeps = {
    sendApiError,
    sendMulterError,
    createSseResponse,
    getPublicBaseUrl,
    requireLocalDaemonRequest,
    isLocalSameOrigin,
    resolvedPortRef,
  };
  const pathDeps = {
    PROJECT_ROOT,
    PROJECTS_DIR,
    ARTIFACTS_DIR,
    RUNTIME_DATA_DIR,
    RUNTIME_DATA_DIR_CANONICAL,
    DESIGN_TEMPLATES_DIR,
    USER_DESIGN_TEMPLATES_DIR,
    SKILLS_DIR,
    USER_SKILLS_DIR,
    OD_BIN,
  };

  app.get('/api/health', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({ ok: true, version: versionInfo.version });
  });

  app.get('/api/ready', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    const ready = !daemonShuttingDown;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      version: versionInfo.version,
    });
  });

  app.get('/api/version', async (_req, res) => {
    const version = await readCurrentAppVersionInfo();
    res.json({ version });
  });

  let invalidateAgentCatalog = () => {};
  registerDaemonRoutes(app, {
    db,
    paths: { PROJECT_ROOT, RESOURCE_ROOT: DAEMON_RESOURCE_ROOT ?? PROJECT_ROOT, RUNTIME_DATA_DIR },
    http: { requireLocalDaemonRequest, sendApiError },
    host,
    getResolvedPort: () => resolvedPort,
    getDaemonShuttingDown: () => daemonShuttingDown,
    onAgentCompanionInstalled: () => invalidateAgentCatalog(),
    sandboxRuntime: SANDBOX_RUNTIME,
    env: process.env,
  });


  // Gate the diagnostics export behind requireLocalDaemonRequest so it stays
  // unreachable when daemon binds to a non-loopback address (Tailscale,
  // 0.0.0.0, etc.). The bundle contains daemon/web/desktop logs, host
  // metadata, and crash reports — same threat tier as the other local-only
  // endpoints that use the same guard.
  app.get(
    DIAGNOSTICS_EXPORT_PATH,
    requireLocalDaemonRequest,
    createDiagnosticsExportHandler({
      runtime,
      projectRoot: PROJECT_ROOT,
      runsDir: path.join(RUNTIME_DATA_DIR, 'runs'),
      dataDir: RUNTIME_DATA_DIR,
    }),
  );

  const nodeDeps = { fs, path };
  const idDeps = { randomId, randomUUID };
  const uploadDeps = { upload, handleProjectUpload };
  const projectStoreDeps = {
    getProject,
    insertProject,
    updateProject,
    dbDeleteProject,
    removeProjectDir,
    filterValidLinkedDirs,
    validateLinkedDirs,
  };
  const projectFileDeps = {
    ensureProject,
    listFiles,
    listProjectFolders,
    createProjectFolder,
    deleteProjectFolder,
    renameProjectFolder,
    searchProjectFiles,
    readProjectFile,
    resolveProjectDir,
    resolveProjectFilePath,
    parseByteRange,
    renameProjectFile,
    deleteProjectFile,
    writeProjectFile,
    sanitizeName,
    sanitizePath,
    listTabs,
    setTabs,
  };
  const conversationDeps = {
    insertConversation,
    getConversation,
    listConversations,
    updateConversation,
    deleteConversation,
    listMessageIds,
    listMessages,
    listMessagesForChat,
    reconcileMessageTurnOrder,
    upsertMessage,
    listPreviewComments,
    upsertPreviewComment,
    updatePreviewCommentStatus,
    deletePreviewComment,
  };
  const templateDeps = { getTemplate, listTemplates, deleteTemplate, insertTemplate, findTemplateByNameAndProject, updateTemplate };
  const projectStatusDeps = {
    listLatestProjectRunStatuses,
    listProjectsAwaitingInput,
    normalizeProjectDisplayStatus,
    composeProjectDisplayStatus,
    listProjects,
  };
  const projectEventDeps = { subscribeFileEvents, activeProjectEventSinks };
  const importDeps = { detectEntryFile };
  const projectExportDeps = {
      buildBatchArchive,
    buildDesktopPdfExportInput,
    buildDesktopArtifactExportInput,
    desktopPdfExporter,
    desktopSlideRenderer,
    desktopArtifactExporter,
    daemonUrlRef,
    sanitizeArchiveFilename,
  };
  const artifactDeps = {
    sanitizeSlug,
    lintArtifact,
    renderFindingsForAgent,
    validateArtifactManifestInput,
  };
  const appConfigDeps = { readAppConfig, writeAppConfig };
  const nativeDialogDeps = { openBrowser, openNativeFolderDialog };
  const researchDeps = { searchResearch, ResearchError };
  const authDeps = {
    authorizeToolRequest,
    consumedImportNonces,
    desktopAuthSecret: getDesktopAuthSecret,
    isDesktopAuthGateActive,
    pruneExpiredImportNonces,
    optionalToolGrantFromRequest,
    requestProjectOverride,
    requestRunOverride,
    verifyDesktopImportToken,
  };
  const validationDeps = { isSafeId, validateProjectSkillId };
  const agentDeps = {
    testAgentConnection,
    getAgentDef,
    isKnownModel,
    sanitizeCustomModel,
  };

  // External services
  registerMcpRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
    mcp: { pendingAuth: mcpPendingAuth, daemonUrlRef },
  });
  // MatOS asset registry bridge (knowledges / tools+MCP / skills / roles /
  // workflows mapped onto the Assets workbench through the matos CLI).
  const matosProjectLocations = () =>
    listProjects(db).flatMap((project) => {
      try {
        return [{
          projectId: String(project.id),
          projectName: typeof project.name === 'string' ? project.name : null,
          cwd: projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir),
        }];
      } catch {
        return [];
      }
    });
  registerMatOSAssetRoutes(app, {
    resolveProjectCwd: (projectId) => {
      const project = getProject(db, projectId);
      return project
        ? projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir)
        : undefined;
    },
    listProjectCwds: () => matosProjectLocations().map((location) => location.cwd),
  });
  registerMatOSFeedbackRoutes(app, { dataDir: RUNTIME_DATA_DIR });
  registerMatOSUserStatsRoutes(app);
  registerMatOSFsRoutes(app);
  registerMatOSOpsRoutes(app);
  // BYOK: daemon-side matos CLI bridge calls (model catalog, /btw forks)
  // must run under the user's Settings-configured MatOS provider env, the
  // same env chat runs inject through the spawn path.
  setMatOSUserEnvLoader(async () => {
    const prefs = await readAppConfig(RUNTIME_DATA_DIR);
    return agentCliEnvForAgent(prefs.agentCliEnv, 'matos');
  });
  // Provider-model catalog for the web chat's model picker (`--model`).
  registerMatOSModelRoutes(app);
  // BYOK login bridge: store/validate the user's own provider (base URL +
  // key + model) as the native per-scope `matos login` profile — the
  // runtime's highest-priority provider source.
  registerMatOSLoginRoutes(app);
  warmMatOSModelsCache();
  // MatOS self-evolution "review panel" (自进化评审团) bridge: a read-only
  // projection of the hidden critic → refiner → editor → judge pipeline onto
  // a Design-Jury-shaped view via `matos evolve monitor list --json`.
  registerMatOSEvolutionRoutes(app, {
    resolveProjectCwd: (projectId) => {
      const project = getProject(db, projectId);
      return project ? projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir) : undefined;
    },
    listProjectLocations: matosProjectLocations,
    onAssetsChanged: invalidateMatOSAssetBridgeCaches,
  });
  // MatOS scheduled-tasks bridge (list / create / edit / run / delete cron
  // workflow triggers through the native `matos workbench workflows` CLI, plus
  // the resident tick loop that fires due schedules).
  registerMatOSScheduleRoutes(app);
  // MatOS Workflow Studio bridge (canvas validate / publish / run / status
  // through the native `matos workflow` CLI).
  registerMatOSWorkflowRoutes(app, {
    resolveProjectCwd: (projectId) => {
      const project = getProject(db, projectId);
      return project ? projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir) : undefined;
    },
  });
  // Project workspace
  registerActiveContextRoutes(app, {
    db,
    http: httpDeps,
    projectStore: projectStoreDeps,
  });
  registerHostToolsRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
  });
  registerTerminalRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    terminals: terminalService,
  });
  registerImportRoutes(app, {
    db,
    http: httpDeps,
    node: nodeDeps,
    ids: idDeps,
    paths: pathDeps,
    imports: importDeps,
    auth: authDeps,
    projectStore: projectStoreDeps,
    conversations: conversationDeps,
    projectFiles: projectFileDeps,
    validation: validationDeps,
  });

  // Resource catalog
  const resourceCatalog = registerStaticResourceRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
    resources: {
      listAllSkills,
      listAllDesignTemplates,
      listAllSkillLikeEntries,
      mimeFor,
    },
  });
  invalidateAgentCatalog = resourceCatalog.invalidateAgentCache;
  registerProjectArtifactRoutes(app, {
    http: httpDeps,
    uploads: uploadDeps,
    paths: pathDeps,
    node: nodeDeps,
    artifacts: artifactDeps,
  });
  app.use('/artifacts', express.static(ARTIFACTS_DIR));
  app.use('/frames', express.static(FRAMES_DIR));
  registerProjectExportRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    node: nodeDeps,
    ids: idDeps,
    projectStore: projectStoreDeps,
    exports: projectExportDeps,
    projectFiles: projectFileDeps,
    validation: validationDeps,
  });
  registerProjectFileRoutes(app, {
    db,
    http: httpDeps,
    paths: pathDeps,
    uploads: uploadDeps,
    node: nodeDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    documents: { buildDocumentPreview },
    artifacts: artifactDeps,
    projectPreviewScopes,
  });

  registerResearchRoutes(app, {
    http: httpDeps,
    paths: pathDeps,
    appConfig: appConfigDeps,
    nativeDialogs: nativeDialogDeps,
    research: researchDeps,
  });


  registerProjectUploadRoutes(app, { http: httpDeps, uploads: uploadDeps, node: nodeDeps });

  const composeDaemonSystemPrompt = async ({
    agentId,
    projectId,
    skillId,
    skillIds,
    streamFormat,
    locale,
    sessionMode,
    connectedExternalMcp,
  }) => {
    if (usesNativeMatOSPromptAuthority(agentId)) {
      return {
        prompt: '',
        activeSkillDir: null,
        activeSkillDirs: [],
      };
    }
    const project =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    let appConfigForPrompt = null;
    try {
      appConfigForPrompt = await readAppConfig(RUNTIME_DATA_DIR);
    } catch (err) {
      console.warn('[app-config] readAppConfig failed', err);
    }
    const effectiveSkillId =
      typeof skillId === 'string' && skillId ? skillId : project?.skillId;
    const metadata = project?.metadata;
    let allSkillsPromise: ReturnType<typeof listAllSkillLikeEntries> | null = null;
    const loadAllSkills = async () => {
      allSkillsPromise ??= listAllSkillLikeEntries();
      return await allSkillsPromise;
    };

    // Per-turn skills picked via the composer's @-mention popover. They
    // never persist on the project — we just append their bodies after the
    // primary skill so the agent sees one combined block this turn.
    const effectiveCanonicalSkillId =
      typeof effectiveSkillId === 'string' && effectiveSkillId
        ? resolveSkillId(effectiveSkillId)
        : null;
    const adHocSkillIds = Array.isArray(skillIds)
      ? skillIds
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean)
          .filter((id) => resolveSkillId(id) !== effectiveCanonicalSkillId)
      : [];

    let skillBody;
    let skillName;
    let skillMode;
    const skillModes = new Set<NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']>>();
    let activeSkillDir = null;
    const activeSkillDirs: string[] = [];
    const registerSkillMode = (
      mode: NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']> | null | undefined,
    ) => {
      if (!mode) return;
      skillModes.add(mode);
    };
    const registerPrimarySkillMode = (
      mode: NonNullable<Parameters<typeof composeSystemPrompt>[0]['skillMode']> | null | undefined,
    ) => {
      if (!mode) return;
      skillMode ??= mode;
      registerSkillMode(mode);
    };
    const registerSkillDir = (dir: string | null | undefined) => {
      if (typeof dir !== 'string' || dir.length === 0) return;
      if (!activeSkillDir) activeSkillDir = dir;
      if (!activeSkillDirs.includes(dir)) activeSkillDirs.push(dir);
    };
    if (effectiveSkillId) {
      // Span both functional skills and design templates so a project
      // saved against either surface keeps its system prompt after the
      // skills/design-templates split.
      const allSkills = await loadAllSkills();
      const skill = findSkillById(allSkills, effectiveSkillId);
      if (skill) {
        skillBody = skill.body;
        skillName = skill.name;
        registerPrimarySkillMode(skill.mode);
        registerSkillDir(skill.dir);
      }
    }
    let composedSkillBlocks = '';
    if (adHocSkillIds.length > 0) {
      const allSkills = await loadAllSkills();
      const seen = new Set(
        effectiveCanonicalSkillId ? [String(effectiveCanonicalSkillId)] : [],
      );
      const blocks = [];
      const baseBody = skillBody && skillBody.trim().length > 0 ? skillBody : '';
      for (const id of adHocSkillIds) {
        const canonicalId = resolveSkillId(id);
        if (typeof canonicalId !== 'string' || canonicalId.length === 0) continue;
        if (seen.has(canonicalId)) continue;
        seen.add(canonicalId);
        const extra = findSkillById(allSkills, id);
        if (!extra) continue;
        registerSkillDir(extra.dir);
        registerSkillMode(extra.mode);
        if (!effectiveCanonicalSkillId && adHocSkillIds.length === 1) {
          registerPrimarySkillMode(extra.mode);
        }
        blocks.push(
          `\n\n---\n\n## Composed skill — ${extra.name || id}\n\n${(extra.body || '').trim()}`,
        );
      }
      if (blocks.length > 0) {
        composedSkillBlocks = blocks.join('');
        skillBody = baseBody + composedSkillBlocks;
        if (!skillName) {
          skillName = adHocSkillIds.length === 1
            ? findSkillById(allSkills, adHocSkillIds[0])?.name ?? null
            : 'composed';
        }
      }
    }


    // User-level custom instructions from app-config.json.
    let userInstructions = '';
    if (appConfigForPrompt?.customInstructions) {
      userInstructions = appConfigForPrompt.customInstructions;
    }

    const template =
      metadata?.kind === 'template' && typeof metadata.templateId === 'string'
        ? (getTemplate(db, metadata.templateId) ?? undefined)
        : undefined;
    const prompt = composeSystemPrompt({
      agentId,
      skillBody,
      skillName,
      skillMode,
      skillModes: skillModes.size > 0 ? Array.from(skillModes) : undefined,
      metadata,
      template,
      locale: typeof locale === 'string' ? locale : undefined,
      sessionMode: normalizeConversationSessionMode(sessionMode),
      streamFormat,
      executionProfile: executionProfileFromStreamFormat(streamFormat),
      connectedExternalMcp: Array.isArray(connectedExternalMcp)
        ? connectedExternalMcp
        : undefined,
      userInstructions,
    });
    // The chat handler also needs to know where the active skill lives
    // on disk so it can stage a per-project copy of its side files
    // before spawning the agent. Returning that here avoids a second
    // `listSkills()` scan in `startChatRun`.
    return {
      prompt,
      activeSkillDir,
      activeSkillDirs,
    };
  };

  const startChatRunCore = async (chatBody, run) => {
    /** @type {Partial<ChatRequest> & { imagePaths?: string[] }} */
    chatBody = chatBody || {};
    const {
      agentId,
      message,
      currentPrompt,
      systemPrompt,
      imagePaths = [],
      projectId,
      conversationId,
      userMessageId,
      assistantMessageId,
      clientRequestId,
      skillId,
      skillIds,
      sessionMode,
      attachments = [],
      commentAttachments = [],
      model,
      providerModel,
      assetRefs,
      additionalAssetRefs,
      reasoning,
      locale,
      research,
      context,
      titleGeneration,
    } = chatBody;
    if (typeof projectId === 'string' && projectId) run.projectId = projectId;
    if (typeof conversationId === 'string' && conversationId)
      run.conversationId = conversationId;
    if (typeof userMessageId === 'string' && userMessageId)
      run.userMessageId = userMessageId;
    if (typeof assistantMessageId === 'string' && assistantMessageId)
      run.assistantMessageId = assistantMessageId;
    if (typeof clientRequestId === 'string' && clientRequestId)
      run.clientRequestId = clientRequestId;
    if (typeof agentId === 'string' && agentId) run.agentId = agentId;
    // Stash the per-turn config on the run so the close/finalize paths can
    // read it without reaching back into chatBody across the service boundary.
    // Each field is optional and only set when the chat body carried it.
    if (typeof model === 'string' && model) run.model = model;
    if (typeof reasoning === 'string' && reasoning) run.reasoning = reasoning;
    // Provider LLM override (web `/model`): validated against the model-id
    // pattern so arbitrary request strings can't become argv. Distinct from
    // `model`, which MatOS repurposes as the role ref.
    const safeProviderModel =
      typeof providerModel === 'string' &&
      /^[a-z0-9][a-z0-9._:[\]/+-]{0,127}$/i.test(providerModel.trim())
        ? providerModel.trim()
        : null;
    if (safeProviderModel) run.providerModel = safeProviderModel;
    const persistedAssetRefs = typeof projectId === 'string' && projectId
      ? getProject(db, projectId)?.metadata?.matosAssetRefs
      : undefined;
    const safeAssetRefs = Array.from(new Set([
      ...(Array.isArray(persistedAssetRefs) ? persistedAssetRefs : []),
      ...(Array.isArray(assetRefs) ? assetRefs : []),
    ]
      .filter((value): value is string =>
        typeof value === 'string' &&
        /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*(?:@[A-Za-z0-9.+-]+)?$/.test(value.trim()),
      )
      .map((value) => value.trim())))
      .slice(0, 64);
    if (typeof skillId === 'string' && skillId) run.skillId = skillId;
    const conversationSession =
      typeof conversationId === 'string' && conversationId
        ? getConversation(db, conversationId)
        : null;
    const runSessionMode =
      sessionMode === 'chat' || sessionMode === 'design' || sessionMode === 'plan'
        ? normalizeConversationSessionMode(sessionMode)
        : normalizeConversationSessionMode(conversationSession?.sessionMode);
    const def = getAgentDef(agentId);
    if (!def)
      return design.runs.fail(
        run,
        'AGENT_UNAVAILABLE',
        `unknown agent: ${agentId}`,
      );
    if (!def.bin)
      return design.runs.fail(run, 'AGENT_UNAVAILABLE', 'agent has no binary');
    const nativeMatOSPromptAuthority = usesNativeMatOSPromptAuthority(def.id);
    const openDesignRunPreparation = usesOpenDesignRunPreparation(def.id);
    // Validate the checked-in `inactivityTimeoutMs` hint immediately
    // after the runtime def is selected and before any side-effectful
    // setup (`.mcp.json` write/unlink,
    // composeSystemPrompt, prompt persistence). A bad def value would
    // otherwise abort the run only at watchdog-arm time, after that
    // setup has already mutated local state, leaving confusing partial
    // residue behind (issue #2467 review on PR #2579).
    //
    // Catch is intentionally narrowed to `RangeError`, the only kind
    // `assertValidRuntimeDefInactivityTimeoutMs` is allowed to throw
    // for invalid checked-in values. Anything else (a regression that
    // makes the helper throw on a valid value, an unrelated bug
    // introduced while touching this path) should bubble up to the
    // outer chat-run starter — which surfaces it as
    // `AGENT_EXECUTION_FAILED` — rather than being misreported as
    // "the runtime def is bad" and burying the real failure.
    try {
      assertValidRuntimeDefInactivityTimeoutMs(def.inactivityTimeoutMs);
    } catch (err) {
      if (err instanceof RangeError) {
        return design.runs.fail(run, 'AGENT_RUNTIME_DEF_INVALID', err.message);
      }
      throw err;
    }
    const safeCommentAttachments =
      normalizeCommentAttachments(commentAttachments);
    if (
      (typeof message !== 'string' || !message.trim()) &&
      safeCommentAttachments.length === 0
    ) {
      return design.runs.fail(run, 'BAD_REQUEST', 'message required');
    }
    const browserUseRunState = buildBrowserUseRunState({
      requested: isBrowserUseRequested(
        message,
        currentPrompt,
        nativeMatOSPromptAuthority ? '' : systemPrompt,
      ),
      agentId: def.id,
    });
    if (browserUseRunState) {
      run.browserUse = browserUseRunState;
      design.runs.emit(run, 'diagnostic', {
        type: 'browser_use_unavailable',
        ...browserUseRunState,
      });
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
    const runId = run.id;

    // Resolve the project working directory (creating the folder if it
    // doesn't exist yet). Without one we don't pass cwd to spawn — the
    // agent then runs in whatever inherited dir, which still lets API
    // mode work but loses file-tool addressability.
    // Project directory resolution lives in projects.ts so sandbox mode can
    // consistently reject imported-folder metadata that has no managed copy.
    let cwd = null;
    let existingProjectFiles = [];
    let existingProjectFolders = [];
    if (typeof projectId === 'string' && projectId) {
      try {
        const chatProject = getProject(db, projectId);
        const chatMeta = chatProject?.metadata;
        // ensureProject/resolveProjectDir now resolve external baseDir folders
        // internally (and assertSandboxProjectRootAvailable rejects imported
        // folders with no managed copy in sandbox mode), so we pass chatMeta
        // through instead of branching on baseDir here.
        assertSandboxProjectRootAvailable(chatMeta);
        cwd = await ensureProject(PROJECTS_DIR, projectId, chatMeta);
        if (openDesignRunPreparation) {
          existingProjectFiles = await listFiles(PROJECTS_DIR, projectId, { metadata: chatMeta });
          existingProjectFolders = await listProjectFolders(PROJECTS_DIR, projectId, { metadata: chatMeta });
        }
      } catch (err) {
        if (err instanceof SandboxImportedProjectError) {
          return design.runs.fail(run, 'BAD_REQUEST', err.message);
        }
        cwd = null;
        existingProjectFiles = [];
        existingProjectFolders = [];
      }
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    // Sanitise supplied image paths: must live under UPLOAD_DIR and stay
    // below the prompt-image safety cap.
    const { safeImages, oversizedImages, failedImages } =
      resolveSafePromptImagePaths(imagePaths);
    if (oversizedImages.length > 0) {
      return design.runs.fail(
        run,
        'BAD_REQUEST',
        'Image attachments must be 1 MB or smaller.',
      );
    }
    if (failedImages.length > 0) {
      return design.runs.fail(
        run,
        'INTERNAL_ERROR',
        'Failed to read one or more image attachments.',
      );
    }

    // Project-scoped attachments: project-relative paths inside cwd. Each
    // is run through the same path-traversal guard the file CRUD endpoints
    // use, then existence-checked. Whatever survives shows up as an
    // explicit list at the bottom of the user message so the agent knows
    // to Read it.
    const safeAttachments = cwd
      ? resolveSafeProjectAttachments(cwd, attachments)
      : [];
    run.projectAttachmentPaths = safeAttachments;

    // Local code agents don't accept a separate "system" channel the way the
    // Messages API does — we fold the skill prompt into the
    // user message. The <artifact> wrapping instruction comes from
    // systemPrompt. We also stitch in the cwd hint so the agent knows
    // where its file tools should write, and the attachment list so it
    // doesn't have to guess what the user just dropped in.
    const projectRecord =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    const runContextPrompt = nativeMatOSPromptAuthority
      ? ''
      : renderRunContextPrompt(context, projectRecord?.metadata);
    const linkedDirs = (() => {
      if (!Array.isArray(projectRecord?.metadata?.linkedDirs)) return [];
      const v = validateLinkedDirs(projectRecord.metadata.linkedDirs);
      return v.dirs ?? [];
    })();
    const cwdHint = !nativeMatOSPromptAuthority && cwd
      ? formatDesignFilesWorkspaceHint(cwd, existingProjectFiles, existingProjectFolders)
      : '';
    const linkedDirsHint = !nativeMatOSPromptAuthority && linkedDirs.length > 0
      ? `\n\nLinked code folders (read-only reference code the user wants you to see):\n${
          linkedDirs.map((d) => `- \`${d}\``).join('\n')
        }`
      : '';
    const attachmentHint = nativeMatOSPromptAuthority
      ? ''
      : formatProjectAttachmentHint(safeAttachments);
    const toolTokenGrant = openDesignRunPreparation && cwd && typeof projectId === 'string' && projectId
      ? toolTokenRegistry.mint({
          runId,
          projectId,
          allowedEndpoints: CHAT_TOOL_ENDPOINTS,
          allowedOperations: CHAT_TOOL_OPERATIONS,
        })
      : null;
    let toolTokenRevoked = false;
    const revokeToolToken = (reason) => {
      if (toolTokenRevoked || !toolTokenGrant) return;
      toolTokenRevoked = true;
      toolTokenRegistry.revokeToken(toolTokenGrant.token, reason);
    };
    const configuredResearchApiEnvNames = nativeMatOSPromptAuthority
      ? []
      : await listConfiguredResearchApiEnvNames(PROJECT_ROOT).catch(() => [] as string[]);
    const runtimeToolPrompt = nativeMatOSPromptAuthority
      ? ''
      : createAgentRuntimeToolPrompt(
          daemonUrl,
          toolTokenGrant,
          configuredResearchApiEnvNames,
        );
    const commentHint = nativeMatOSPromptAuthority
      ? ''
      : renderCommentAttachmentHint(safeCommentAttachments);

    // Resolve external MCP config + stored OAuth tokens up-front so the
    // system prompt can warn the model away from the runtime's synthetic
    // `*_authenticate` / `*_complete_authentication` tools for any
    // server the daemon already holds a valid Bearer for. We re-use both
    // values further down at .mcp.json write time — see the spawn block
    // below — instead of re-reading.
    let externalMcpConfig = { servers: [] };
    // Explicit user MCP connections are independent of OpenDesign prompt preparation.
    if (!SANDBOX_RUNTIME.enabled) {
      try {
        externalMcpConfig = await readMcpConfig(RUNTIME_DATA_DIR);
      } catch (err) {
        console.warn(
          '[mcp-config] read failed:',
          err && err.message ? err.message : err,
        );
      }
    }
    const runScopedMcpServers = Array.isArray(run?.toolBundle?.mcpServers)
      ? run.toolBundle.mcpServers
      : [];
    const {
      enabledServers: enabledExternalMcp,
      persistedTokenServerIds,
    } = resolveExternalMcpServersForRun({
      persistedServers: externalMcpConfig.servers,
      runScopedServers: runScopedMcpServers,
      sandboxMode: SANDBOX_RUNTIME.enabled,
    });
    const oauthTokensForSpawn = {};
    if (persistedTokenServerIds.size > 0) {
      try {
        const stored = await readAllTokens(RUNTIME_DATA_DIR);
        for (const [serverId, tok] of Object.entries(stored)) {
          if (!persistedTokenServerIds.has(serverId)) continue;
          // Default to the persisted access token; null it out if expired so
          // we never inject a stale `Authorization: Bearer …` header. The
          // model treats a server with a Bearer pinned as connected and
          // discourages re-auth, which is the worst possible UX when the
          // token is going to 401 every call.
          let access = isTokenExpired(tok) ? null : tok.accessToken;
          if (isTokenExpired(tok) && tok.refreshToken) {
            try {
              const refreshed = await refreshAndPersistToken(
                RUNTIME_DATA_DIR,
                serverId,
                tok,
              );
              if (refreshed) access = refreshed.accessToken;
            } catch (err) {
              console.warn(
                '[mcp-oauth] refresh failed for',
                serverId,
                err && err.message ? err.message : err,
              );
            }
          }
          if (access) {
            oauthTokensForSpawn[serverId] = access;
          } else {
            console.warn(
              '[mcp-oauth] skipping expired token for',
              serverId,
              '— reconnect required',
            );
          }
        }
      } catch (err) {
        console.warn(
          '[mcp-tokens] read failed:',
          err && err.message ? err.message : err,
        );
      }
    }
    const connectedExternalMcp = enabledExternalMcp
      .filter((s) => typeof oauthTokensForSpawn[s.id] === 'string')
      .map((s) => ({ id: s.id, label: s.label }));

    const {
      prompt: daemonSystemPrompt,
      activeSkillDirs,
    } = nativeMatOSPromptAuthority
      ? {
          prompt: '',
          activeSkillDirs: [],
        }
      : await composeDaemonSystemPrompt({
        agentId,
        projectId,
        skillId,
        skillIds,
        streamFormat: def?.streamFormat ?? 'plain',
        locale,
        sessionMode: runSessionMode,
        connectedExternalMcp,
      });

    // Make skill side files reachable through three layers, in order of
    // preference. The skill preamble emitted by `withSkillRootPreamble()`
    // advertises both the cwd-relative path (1) and the absolute path
    // (2/3) so the agent can pick whichever works.
    //
    //   1. CWD-relative copy. Stage every active/composed skill into
    //      `<cwd>/.od-skills/<folder>/` so any agent CLI — not just the
    //      ones that honour `--add-dir` — can reach those files via a
    //      path inside its working directory. We copy (not symlink) so
    //      each staged directory is a true write barrier — agents cannot
    //      mutate the shipped repo resource through their cwd.
    //   2. `--add-dir` allowlist. Pass `SKILLS_DIR`
    //      so the absolute fallback path in the preamble is reachable when
    //      staging fails (e.g. the project has
    //      no on-disk cwd, or fs.cp errored).
    //   3. PROJECT_ROOT cwd. When `cwd` is null, the agent runs with
    //      `cwd: PROJECT_ROOT` — there the absolute path is already an
    //      in-cwd path, so neither (1) nor (2) is required for it to
    //      resolve.
    if (cwd && activeSkillDirs.length > 0) {
      for (const skillDir of activeSkillDirs) {
        const result = await stageActiveSkill(
          cwd,
          skillCwdAliasSegment(skillDir),
          skillDir,
          (msg) => console.warn(msg),
        );
        if (!result.staged) {
          console.warn(
            `[od] skill-stage skipped: ${result.reason ?? 'unknown reason'}; falling back to absolute paths`,
          );
        }
      }
    }
    // Resolve the agent's effective working directory once and use it
    // everywhere the agent could read it (buildArgs runtimeContext, spawn
    // cwd). Falling back to PROJECT_ROOT — rather than
    // letting `spawn` inherit the daemon process cwd — is what makes the
    // absolute-path fallback in the skill preamble actually in-cwd for
    // no-project runs (packaged daemons / service launches do not start
    // their working directory from the workspace root).
    const effectiveCwd = cwd ?? PROJECT_ROOT;
    // Baseline the project's artifact files before the agent runs, so the
    // run-finished handler can diff against them and report `artifact_count`
    // for ANY agent (not just claude_code). Only for real project runs: a
    // null `cwd` means a no-project run rooted at PROJECT_ROOT, whose churn is
    // not the user's artifacts — those fall back to the tool-stream count.
    if (openDesignRunPreparation && run?.id && cwd) {
      try {
        runArtifactBaselines.remember(run.id, cwd, snapshotProjectArtifacts(cwd));
      } catch {
        // Snapshotting is best-effort; finish falls back to the tool-stream count.
      }
    }
    const latestRunPromptForHtmlVersionSnapshot = () => {
      if (run.conversationId) {
        try {
          const row = db.prepare(
            `SELECT content
               FROM messages
              WHERE conversation_id = ?
                AND role = 'user'
                AND LENGTH(TRIM(content)) > 0
              ORDER BY COALESCE(ended_at, started_at, created_at, 0) DESC,
                       position DESC
              LIMIT 1`,
          ).get(run.conversationId);
          if (typeof row?.content === 'string' && row.content.trim()) {
            return { prompt: row.content.trim(), promptSource: 'message' as const };
          }
        } catch {
          // Version prompt provenance is best-effort.
        }
      }
      const requestPrompt =
        typeof currentPrompt === 'string' && currentPrompt.trim()
          ? currentPrompt.trim()
          : typeof message === 'string' && message.trim()
            ? message.trim()
            : null;
      return requestPrompt ? { prompt: requestPrompt, promptSource: 'message' as const } : { prompt: null };
    };
    const snapshotAiHtmlVersionsBeforeSuccess = async () => {
      if (!run?.id || !run.projectId) return;
      const artifactBaseline = runArtifactBaselines.peek(run.id);
      if (!artifactBaseline || artifactBaseline.contended) return;
      let diff;
      try {
        diff = diffRunArtifacts(
          artifactBaseline.before,
          snapshotProjectArtifacts(artifactBaseline.cwd),
        );
      } catch {
        return;
      }
      const promptInfo = latestRunPromptForHtmlVersionSnapshot();
      await snapshotAiHtmlVersionsForRun({
        projectsRoot: PROJECTS_DIR,
        projectId: run.projectId,
        projectRoot: artifactBaseline.cwd,
        diff,
        prompt: promptInfo.prompt,
        ...(promptInfo.promptSource ? { promptSource: promptInfo.promptSource } : {}),
        metadata: projectRecord?.metadata,
      });
    };
    const extraAllowedDirs = resolveChatExtraAllowedDirs({
      agentId,
      skillsDir: SKILLS_DIR,
      linkedDirs,
    });
    const researchCommandContract = nativeMatOSPromptAuthority
      ? ''
      : resolveResearchCommandContract(research, message);
    // Resume-capable adapters continue their own upstream session so they
    // keep working memory across turns. Decide once per run; reuse for the
    // prompt-composition skipTranscript choice, the buildArgs flags, and the
    // create-turn persistence below.
    const agentSupportsSessionResume = runtimeResumesSessionById(def);
    // --- Model resolution hoisted above the resume-identity guard ---
    // The guard (and the persisted `agent_sessions.model`) must key off the
    // CONCRETE model actually launched, not the raw request token: a user who
    // picked `default` would otherwise store `default`/null, so changing the
    // effective default between turns would still pass the guard and resume the
    // old upstream session under the wrong model (#4704, reported by @nettee).
    // resolveModelForAgent is hoisted here so `safeModel` is final before the
    // guard. The preflight further down stays authoritative for
    // auth/availability and re-runs the (cached, idempotent) resolution.
    let configuredAgentEnv = {};
    try {
      const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
      configuredAgentEnv = agentCliEnvForAgent(appConfig.agentCliEnv, def.id);
    } catch {
      configuredAgentEnv = {};
    }
    let safeModel = resolveModelForAgent(
      def,
      typeof model === 'string'
        ? isKnownModel(def, model, null)
          ? model
          : sanitizeCustomModel(model)
        : null,
      process.env,
      null,
    );
    const reasoningOptions = def.reasoningOptions;
    const safeReasoning =
      typeof reasoning === 'string' && Array.isArray(reasoningOptions)
        ? (reasoningOptions.find((r) => r.id === reasoning)?.id ?? null)
        : null;
    const agentOptions = { model: safeModel, reasoning: safeReasoning };
    const agentLaunch = resolveAgentLaunch(def, configuredAgentEnv);
    const resolvedBin = agentLaunch.selectedPath;
    const agentSessionId = safeModel
      ? `${def.id}:${safeModel}`
      : def.id;
    const agentResumeCtx =
      agentSupportsSessionResume && run.conversationId
        ? resolveAgentResumeContext(db, {
            conversationId: run.conversationId,
            agentId: agentSessionId,
            currentModel: safeModel ?? null,
            currentCwd: effectiveCwd,
            currentAssistantMessageId: run.assistantMessageId ?? null,
            allowConversationAdvance:
              Array.isArray(conversationSession?.memberRefs) &&
              conversationSession.memberRefs.length > 1,
          })
        : { resumeSessionId: null as string | null, newSessionId: undefined as string | undefined, isResuming: false, storedStablePromptHash: null as string | null, storedLastMessageId: null as string | null, invalidationReason: null };
    const matosResumeDelta =
      agentResumeCtx.isResuming &&
      run.conversationId &&
      agentResumeCtx.storedLastMessageId
        ? buildMatOSResumeDelta(listMessages(db, run.conversationId), {
            afterMessageId: agentResumeCtx.storedLastMessageId,
            currentAssistantMessageId: run.assistantMessageId ?? null,
            currentPrompt,
          })
        : '';
    const resumedCurrentPrompt = matosResumeDelta
      ? `${matosResumeDelta}\n\n## Latest user request\n${currentPrompt}`
      : currentPrompt;
    const userRequestPrompt = nativeMatOSPromptAuthority
      ? composeNativeMatOSUserInput({
          transcript: message,
          currentPrompt,
          isResuming: agentResumeCtx.isResuming,
          resumeDelta: matosResumeDelta,
        })
      : composeChatUserRequestForAgent(
          message,
          resumedCurrentPrompt,
          // Only trim to the latest turn when we are actually resuming an
          // existing session. A create turn still sends the full transcript so
          // a brand-new session (incl. first turn after another agent)
          // is seeded with prior context.
          { skipTranscript: agentResumeCtx.isResuming },
        );
    // The stable instruction slice (daemon prompt + tool contract + system
    // prompt = skills) is identical across turns of
    // a conversation in the common case. A resumed Claude session already
    // holds it, so on resume turns we skip it unless it changed since the
    // session was seeded — keyed by a hash stored on agent_sessions. Create
    // turns and changed-hash turns send the full block (byte-identical to the
    // previous behavior); non-resume agents have isResuming === false and so
    // always send the full block.
    const stableInstructionFingerprint = [
      daemonSystemPrompt,
      runtimeToolPrompt,
      nativeMatOSPromptAuthority ? '' : systemPrompt,
    ]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .join('\n\n---\n\n');
    const currentStableHash = hashStableInstructions(stableInstructionFingerprint);
    // `runtimeToolPrompt` is part of the fingerprint and varies only when the
    // tool-token grant's presence flips between turns (rare cwd/projectId edge
    // cases); any such change correctly forces a full re-send that turn.
    const includeStableInstructions = computeIncludeStable(
      agentResumeCtx.isResuming,
      agentResumeCtx.storedStablePromptHash,
      currentStableHash,
    );
    run.promptCache = describeStablePromptCache({
      isResuming: agentResumeCtx.isResuming,
      storedStablePromptHash: agentResumeCtx.storedStablePromptHash,
      currentStableHash,
    });
    const browserUsePromptGuard = nativeMatOSPromptAuthority
      ? ''
      : renderBrowserUseUnavailablePrompt(run.browserUse ?? null);
    const titleGenerationRequested =
      !nativeMatOSPromptAuthority &&
      titleGeneration &&
      typeof titleGeneration === 'object' &&
      titleGeneration.enabled === true &&
      !agentResumeCtx.isResuming;
    const titleGenerationPrompt = titleGenerationRequested
      ? [
          'Internal title task:',
          'Before answering the user request, emit exactly one short title marker:',
          '<od-title>Title Here</od-title>',
          'Rules: 2-6 words, preserve the user request language, no quotes, no markdown, no punctuation unless necessary.',
          'Do not mention this title task to the user. Continue with the normal answer after the title marker.',
        ].join('\n')
      : '';
    const clientInstructionParts = nativeMatOSPromptAuthority
      ? []
      : includeStableInstructions
        ? [researchCommandContract, runContextPrompt, browserUsePromptGuard, titleGenerationPrompt, systemPrompt]
        : [researchCommandContract, runContextPrompt, browserUsePromptGuard, titleGenerationPrompt];
    const clientInstructionPrompt = clientInstructionParts
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n\n---\n\n');
    const instructionPrompt = nativeMatOSPromptAuthority
      ? ''
      : composeLiveInstructionPrompt({
          daemonSystemPrompt: includeStableInstructions ? daemonSystemPrompt : '',
          runtimeToolPrompt: includeStableInstructions ? runtimeToolPrompt : '',
          clientSystemPrompt: clientInstructionPrompt,
        });
    // Some models (notably claude-opus-4-7 with --include-partial-messages)
    // start their reply by echoing the top of the user message verbatim,
    // so the rendered chat shows a "# Instructions ..." block ahead of the
    // real answer. Closing every Instructions block with an explicit
    // "do not echo" line cuts the regression in practice without changing
    // the turn-shape every agent CLI expects (user message carrying both
    // instructions and request) — see server.ts:9920 composer notes.
    const ECHO_GUARD = nativeMatOSPromptAuthority
      ? ''
      : '\n\n(Do not quote, restate, or echo the # Instructions block above in your reply. Begin your response with the answer to the # User request below.)';
    const formAnswerMatch = nativeMatOSPromptAuthority
      ? null
      : FORM_ANSWERS_HEADER_RE.exec(
          typeof currentPrompt === 'string' ? currentPrompt : '',
        );
    const formIdForOverride = formAnswerMatch
      ? ((formAnswerMatch[1] || 'form').trim().replace(/[^\w.-]/g, '') || 'form').toLowerCase()
      : null;
    const formOverride =
      formIdForOverride === 'discovery' || formIdForOverride === 'task-type'
        ? FORM_ANSWERED_SYSTEM_OVERRIDE
        : formIdForOverride !== null
          ? FORM_ANSWERED_GENERIC_OVERRIDE
          : '';
    const promptImagePaths = safeImages;
    const composed = nativeMatOSPromptAuthority
      ? composeNativeMatOSUserInput({
          transcript: message,
          currentPrompt,
          isResuming: agentResumeCtx.isResuming,
          resumeDelta: matosResumeDelta,
          attachments: safeAttachments,
          imagePaths: promptImagePaths,
          commentAttachments: safeCommentAttachments,
        })
      : [
          instructionPrompt
            ? `# Instructions (read first)\n\n${formOverride}${instructionPrompt}${cwdHint}${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
            : cwdHint
              ? `# Instructions\n\n${formOverride}${cwdHint}${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
              : linkedDirsHint
                ? `# Instructions\n\n${formOverride}${linkedDirsHint}${ECHO_GUARD}\n\n---\n`
                : formOverride
                  ? `# Instructions\n\n${formOverride}${ECHO_GUARD}\n\n---\n`
                  : '',
          `# User request\n\n${userRequestPrompt}${attachmentHint}${commentHint}`,
          promptImagePaths.length
            ? `\n\n${promptImagePaths.map((p) => `@${p}`).join(' ')}`
            : '',
        ].join('');
    let streamJsonUserMessage = null;
    try {
      streamJsonUserMessage = buildStreamJsonUserMessage(
        composed,
        def.supportsImagePaths ? promptImagePaths : [],
      );
    } catch {
      return design.runs.fail(
        run,
        'INTERNAL_ERROR',
        'Failed to read one or more image attachments.',
      );
    }
    // (model resolution + AMR concretization hoisted above the resume guard)
    const executionProfile = executionProfileFromStreamFormat(def.streamFormat);
    // Accumulates the agent's visible text this run so the close handler can
    // tell whether the turn ended on a clarifying question form. We buffer
    // the streamed text rather than read the persisted message because the
    // assistant message row may not be wired up at close time. The buffer is
    // capped because a discovery form streams near the top of the turn; we
    // only need enough to validate the first complete form block (see
    // `emittedRenderableQuestionForm`).
    const CLARIFYING_QUESTION_BUFFER_CAP = 256 * 1024;
    let clarifyingQuestionText = '';
    let visibleAssistantText = '';
    const send = (event, data) => {
      if (shouldSuppressCanceledRunOutput(run.cancelRequested, event, data)) return;
      if (
        event === 'agent' &&
        data &&
        data.type === 'text_delta' &&
        typeof data.delta === 'string' &&
        clarifyingQuestionText.length < CLARIFYING_QUESTION_BUFFER_CAP
      ) {
        clarifyingQuestionText = (clarifyingQuestionText + data.delta).slice(
          0,
          CLARIFYING_QUESTION_BUFFER_CAP,
        );
      }
      if (
        event === 'agent' &&
        data &&
        data.type === 'text_delta' &&
        typeof data.delta === 'string'
      ) {
        visibleAssistantText += data.delta;
      }
      persistRunEventToAssistantMessage(db, run, event, data);
      design.runs.emit(run, event, data);
    };
    const destroyChildStdio = (child) => {
      // Best-effort cleanup of stdio streams on a child process we're about
      // to drop. The daemon-sidecar (apps/daemon) keeps listeners attached
      // to child.stdout / child.stderr / child.stdin across the run
      // lifecycle (line ~12890..~13500+ in this file). Those listeners hold
      // the Stream objects alive, and the Stream objects own the read side
      // of the OS pipes — so dropping the child reference via
      // `run.child = null` without destroying the streams leaks the pipe
      // file descriptors. After a few hundred retries the daemon
      // accumulates 10k+ FDs and posix_spawn returns EBADF.
      //
      // See: https://github.com/nexu-io/open-design/issues/4100
      if (!child) return;
      const destroyStream = (stream) => {
        if (!stream || stream.destroyed) return;
        try { stream.removeAllListeners(); } catch {}
        try { stream.destroy(); } catch {}
      };
      destroyStream(child.stdout);
      destroyStream(child.stderr);
      destroyStream(child.stdin);
    };
    // Synchronously detach the failed attempt: kill the old child and move the
    // run back to `queued` *now*, even when the re-spawn is delayed by backoff.
    // This must not be deferred — leaving the old child alive during the backoff
    // window lets a follow-on signal (e.g. the inactivity watchdog's SIGTERM)
    // drive a second close-handler pass that finalizes the run as failed before
    // the retry ever spawns.
    const tearDownAttemptForRetry = () => {
      // Release the previous child's stdio streams before letting the
      // reference drop — see destroyChildStdio for rationale.
      destroyChildStdio(run.child);
      if (
        run.child &&
        typeof run.child.kill === 'function' &&
        run.child.exitCode === null &&
        !run.child.killed
      ) {
        try { run.child.kill('SIGTERM'); } catch {}
      }
      run.status = 'queued';
      run.updatedAt = Date.now();
      run.child = null;
      run.exitCode = null;
      run.signal = null;
      run.error = null;
      run.errorCode = null;
      run.stdinOpen = false;
    };
    const spawnRetryAttempt = () => {
      void startChatRun(chatBody, run).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        design.runs.emit(
          run,
          'error',
          createSseErrorPayload('AGENT_EXECUTION_FAILED', message),
        );
        // Route the retried-start failure through the same finalizer as child
        // close/error. retryAttemptCount is already 1 here, so
        // decideSafeRunRetry suppresses with attempt_limit_reached and
        // cannot trigger another restart loop.
        finishWithRetryDecision('failed', 1, null);
      });
    };
    // Tear the failed attempt down now (moving the run to `queued`), then wait
    // out the policy's backoff before re-spawning. Stays cancel-aware: a cancel
    // or shutdown during the backoff window clears the timer (runtimes/runs.ts)
    // and finalizes the queued run, and the callback re-checks cancel/terminal
    // state in case it fires first.
    const scheduleRetryRestart = (delayMs) => {
      tearDownAttemptForRetry();
      const wait = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      if (wait <= 0) {
        spawnRetryAttempt();
        return;
      }
      run.retryRestartTimer = setTimeout(() => {
        run.retryRestartTimer = null;
        if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
        spawnRetryAttempt();
      }, wait);
    };
    let pendingRpcCloseReason = null;
    const markRpcCloseReason = (reason) => {
      pendingRpcCloseReason = reason;
    };
    const deriveRpcCloseReason = (status, code, signal) => {
      if (pendingRpcCloseReason) return pendingRpcCloseReason;
      if (run.cancelRequested || status === 'canceled') return 'cancel_requested';
      if (signal) return 'signal';
      if (typeof code === 'number') return code === 0 ? 'exit_0' : 'exit_nonzero';
      return 'unknown';
    };
    const finishWithRetryDecision = (status, code = null, signal = null) => {
      const result = runResultFromStatus(status);
      const errorCode = deriveRunErrorCode({
        status,
        error: run.error,
        errorCode: run.errorCode,
        exitCode: code,
        signal,
      });
      const failure = classifyRunFailure({
        result,
        status: {
          status,
          error: run.error,
          errorCode: run.errorCode,
          exitCode: code,
          signal,
        },
        ...(errorCode ? { errorCode } : {}),
        agentId: run.agentId,
        events: run.events,
      });
      const sideEffects = {
        ...scanRunEventsForRetrySideEffects(run.events),
        cancelRequested: !!run.cancelRequested,
      };
      const decision = decideSafeRunRetry({
        result,
        failure,
        attemptCount: run.retryAttemptCount ?? 0,
        sideEffects,
      });
      if (decision.shouldRetry && !design.runs.isTerminal(run.status)) {
        run.retryAttemptCount = decision.retryAttemptIndex;
        scheduleRetryRestart(decision.retryDelayMs);
        return true;
      }
      // Resume-on-failure: a terminal *resumable* failure (transient mid-stream
      // drop / inactivity) on a session-resuming runtime is not a dead end.
      // Persist the live CLI session so the next turn in this conversation
      // continues it (`--resume <id>`) instead of opening a fresh session, and
      // flag the run so the chat can surface a Continue affordance. The session
      // id is the one we actually drove this attempt with: the resumed id when
      // continuing, otherwise the freshly minted id we passed via --session-id.
      //
      // Gate on a real *committed* boundary this attempt, not merely on bytes
      // having reached the UI. A completed tool_use / artifact block
      // corresponds to a block the agent has committed to its session (Claude
      // commits a tool_use block before running the tool), so `--resume` has
      // something concrete to pick up. We deliberately EXCLUDE
      // `userVisibleOutputSeen`: it flips true on the first streamed text
      // delta, but a single-turn drop can stream a few tokens with
      // `output_tokens == 0` and never commit a text block — resuming that
      // continues from the prior user turn (nothing to pick up), which is
      // exactly the "resume something with nothing to continue" case this
      // feature is meant to avoid. A text-only turn that is cut therefore stays
      // a from-scratch restart (auto-retry above or a manual Retry).
      // NOTE: `userVisibleOutputSeen` cannot by itself distinguish "half a text
      // block, zero commit" from "a committed text block then more streaming";
      // until the stream exposes a committed-text signal, tool/artifact blocks
      // are the only reliable resume boundary.
      const committedWorkSeen = !!(
        sideEffects.toolCallSeen ||
        sideEffects.artifactWriteSeen
      );
      const liveSessionId = agentResumeCtx.isResuming
        ? agentResumeCtx.resumeSessionId
        : agentResumeCtx.newSessionId;
      const resumableFailure =
        result === 'failed' &&
        runtimeResumesSessionById(def) &&
        !!run.conversationId &&
        !!liveSessionId &&
        committedWorkSeen &&
        isResumableFailure(failure);
      run.resumable = resumableFailure;
      if (resumableFailure) {
        safeUpsertAgentSession(db, {
          conversationId: run.conversationId,
          agentId: agentSessionId,
          sessionId: liveSessionId,
          stablePromptHash: currentStableHash,
          model: safeModel ?? null,
          cwd: effectiveCwd,
          lastMessageId: run.assistantMessageId ?? null,
        }, { runId: run.id, phase: 'resumable-failure' });
      }
      const rpcCloseReason = deriveRpcCloseReason(status, code, signal);
      design.runs.emit(run, 'diagnostic', {
        type: 'runtime_close',
        rpc_close_reason: rpcCloseReason,
        status,
        ...(typeof code === 'number' ? { exit_code: code } : {}),
        ...(signal ? { signal } : {}),
      });
      if (executionProfile === 'filesystem' && result === 'success' && visibleAssistantText.trim().length === 0) {
        const fileNames = filesystemWriteFileNamesFromRunEvents(run.events);
        if (fileNames.length > 0) {
          send('agent', {
            type: 'diagnostic',
            name: 'filesystem_empty_answer_autofilled',
            source: 'daemon-run-finalize',
            fileCount: fileNames.length,
            files: fileNames.slice(0, 8),
          });
          send('agent', {
            type: 'text_delta',
            delta: filesystemEmptyAnswerFallbackText(fileNames),
          });
        }
      }
      pendingRpcCloseReason = null;
      design.runs.finish(run, status, code, signal);
      return false;
    };
    // External MCP servers configured by the user in Settings → External MCP.
    // MatOS relays them to the agent through a project `.mcp.json` so the model
    // can call those tools. Strict gating is essential here:
    //   - cwd must be set (no project → no `.mcp.json` write).
    //   - cwd must live UNDER PROJECTS_DIR. We never write to a git-linked
    //     baseDir (= the user's own repo), since that would silently overwrite
    //     a hand-crafted .mcp.json the user already keeps in their source tree.
    // We also unlink a stale `.mcp.json` we previously wrote when the user has
    // since disabled all servers, so removing a server actually takes effect
    // on the next run.
    if (
      isManagedProjectCwd(cwd, PROJECTS_DIR)
    ) {
      {
        const target = path.join(cwd, '.mcp.json');
        if (enabledExternalMcp.length > 0) {
          try {
            const claudeMcp = buildClaudeMcpJson(
              enabledExternalMcp,
              oauthTokensForSpawn,
            );
            if (claudeMcp) {
              await fs.promises.mkdir(path.dirname(target), { recursive: true });
              await fs.promises.writeFile(
                target,
                JSON.stringify(claudeMcp, null, 2),
                'utf8',
              );
            }
          } catch (err) {
            console.warn(
              '[mcp-config] failed to write project .mcp.json:',
              err && err.message ? err.message : err,
            );
          }
        } else {
          try {
            await fs.promises.unlink(target);
          } catch (err) {
            if ((err && err.code) !== 'ENOENT') {
              console.warn(
                '[mcp-config] failed to remove stale .mcp.json:',
                err && err.message ? err.message : err,
              );
            }
          }
        }
      }
    }
    // Pre-flight the composed prompt against any argv-byte budget the
    // adapter declared. Doing this
    // before bin resolution means the test harness pins the guard
    // independently of whether the adapter binary happens to be on PATH
    // in the CI environment, and the user gets the actionable
    // adapter-named error even if /api/agents hadn't refreshed yet.
    const promptBudgetError = checkPromptArgvBudget(def, composed);
    if (promptBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          promptBudgetError.code,
          promptBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }




    // Native MatOS composes its own system prompt, so the user's global
    // rules travel to the host as an appended prompt file for this attempt.
    let matosGlobalRulesFile = null;
    if (nativeMatOSPromptAuthority) {
      try {
        const prefs = await readAppConfig(RUNTIME_DATA_DIR);
        matosGlobalRulesFile = await writeMatOSGlobalRulesFile(RUNTIME_DATA_DIR, run.id, prefs?.customInstructions);
      } catch (err) {
        console.warn('[matos] global rules unavailable for this run', err);
      }
    }

    let args;
    try {
      args = def.buildArgs(
        composed,
        safeImages,
        extraAllowedDirs,
        agentOptions,
        {
          cwd: effectiveCwd,
          resumeSessionId: agentResumeCtx.resumeSessionId,
          newSessionId: agentResumeCtx.newSessionId,
          sessionMode: runSessionMode,
          ...(safeProviderModel ? { providerModel: safeProviderModel } : {}),
          ...(matosGlobalRulesFile ? { appendSystemPromptFile: matosGlobalRulesFile } : {}),
          assetRefs: (await matOSRunAdditionalAssetRefs({
            cwd: effectiveCwd,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            persistedRefs: persistedAssetRefs,
            requestedRefs: safeAssetRefs,
            additionalAssetRefs: Array.isArray(additionalAssetRefs)
              ? additionalAssetRefs.filter((ref): ref is string => typeof ref === 'string' && /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*(?:@[A-Za-z0-9.+-]+)?$/.test(ref)).slice(0, 64)
              : [],
          })),
        },
      );
    } catch (err) {
      throw err;
    }
    // Second-pass budget check that knows about the Windows `.cmd` shim
    // wrap. The pre-buildArgs `checkPromptArgvBudget` only looks at the
    // raw composed prompt; on Windows an npm-installed adapter resolves
    // to e.g. `deepseek.cmd`, the spawn path goes through `cmd.exe /d /s
    // /c "<inner>"`, and `quoteForWindowsCmdShim` doubles every embedded
    // `"` plus wraps any whitespace/special-char arg in outer quotes —
    // so a quote-heavy prompt that fit under `maxPromptArgBytes` can
    // still expand past CreateProcess's 32_767-char cap. Fail fast with
    // the same `AGENT_PROMPT_TOO_LARGE` shape so the SSE error path
    // doesn't have to special-case it.
    const cmdShimBudgetError = checkWindowsCmdShimCommandLineBudget(
      def,
      agentLaunch.launchPath ?? resolvedBin,
      args,
    );
    if (cmdShimBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          cmdShimBudgetError.code,
          cmdShimBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    // Companion guard for non-shim Windows installs (e.g. a cargo-built
    // `deepseek.exe` rather than the npm `.cmd` shim). Direct `.exe`
    // spawns skip the cmd.exe wrap above, but Node/libuv still composes
    // a CreateProcess `lpCommandLine` by walking each argv element
    // through `quote_cmd_arg`, which escapes every embedded `"` as `\"`
    // and doubles backslashes adjacent to quotes. A quote-heavy prompt
    // under `maxPromptArgBytes` can expand past the 32_767-char kernel
    // cap there too, so the cmd-shim early-return alone would let those
    // users hit a generic `spawn ENAMETOOLONG`.
    const directExeBudgetError = checkWindowsDirectExeCommandLineBudget(
      def,
      agentLaunch.launchPath ?? resolvedBin,
      args,
    );
    if (directExeBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          directExeBudgetError.code,
          directExeBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    let persistDeliveredAgentSessionState = () => {};
    if (runtimeResumesSessionById(def) && run.conversationId) {
      let persisted = false;
      persistDeliveredAgentSessionState = () => {
        if (persisted) return;
        persisted = true;
        // The id to persist for a create turn: capture-style adapters store the
        // session id the CLI minted and reported on the stream; specify-style
        // adapters store the daemon-minted id they passed to the CLI. A
        // capture-style run that never reported an id (CLI died before
        // `thread.started`) leaves nothing to resume — correct, the next turn
        // starts fresh and re-seeds the transcript.
        const createTurnSessionId = agentResumeCtx.newSessionId;
        if (!agentResumeCtx.isResuming && createTurnSessionId) {
          safeUpsertAgentSession(db, {
            conversationId: run.conversationId,
            agentId: agentSessionId,
            sessionId: createTurnSessionId,
            stablePromptHash: currentStableHash,
            model: safeModel ?? null,
            cwd: effectiveCwd,
            lastMessageId: run.assistantMessageId ?? null,
          }, { runId: run.id, phase: 'create-turn' });
          return;
        }
        if (agentResumeCtx.isResuming && agentResumeCtx.resumeSessionId) {
          // Advance the resume identity guard after a successful resume turn:
          // the conversation grew by this turn, so the cursor must move to the
          // new max position (otherwise the next turn sees `cursor + 4` and
          // falsely reseeds). model/cwd are unchanged (they matched on resume);
          // refresh the stable hash to what the session now holds.
          safeUpsertAgentSession(db, {
            conversationId: run.conversationId,
            agentId: agentSessionId,
            sessionId: agentResumeCtx.resumeSessionId,
            stablePromptHash: currentStableHash,
            model: safeModel ?? null,
            cwd: effectiveCwd,
            lastMessageId: run.assistantMessageId ?? null,
          }, { runId: run.id, phase: 'resume-turn' });
        }
      };
    }

    // `runStartTimeMs` is consumed by the run-end artifact-manifest
    // reconciler (#2893 / #3110) to skip artifacts whose mtime predates this
    // run.
    const runStartTimeMs = Date.now();
    const inactivityTimeoutMs = resolveChatRunInactivityTimeoutMs(def.inactivityTimeoutMs);
    const inactivityKillGraceMs = 3_000;
    let inactivityTimer = null;
    let childStdoutSeen = false;
    let lastAgentEventPhase = 'spawn pending';
    let lastToolResultChars = 0;
    // Set when the no-output inactivity watchdog routed this attempt through
    // the same-run retry finalizer AND that finalizer restarted the run on a
    // fresh child. The stalled child is then SIGTERM'd, so its later `close`
    // must NOT finalize the run a second time or unregister the new attempt's
    // event sink / run handle (both keyed by the shared runId). The close
    // handler bails early when this is true, revoking only this attempt's own
    // tool token.
    let watchdogRetryRestarted = false;
    const summarizeAgentEventForInactivity = (payload) => {
      const type = payload?.type ? String(payload.type) : 'unknown';
      if (type === 'tool_result') {
        const content = typeof payload.content === 'string' ? payload.content : '';
        lastToolResultChars = Math.max(lastToolResultChars, content.length);
        return `tool_result:${content.length} chars`;
      }
      if (type === 'tool_use') {
        const name = payload?.name ? String(payload.name) : 'unknown';
        return `tool_use:${name}`;
      }
      if (type === 'text_delta' || type === 'thinking_delta') {
        const text = typeof payload.delta === 'string'
          ? payload.delta
          : typeof payload.text === 'string'
            ? payload.text
            : '';
        return `${type}:${text.length} chars`;
      }
      if (type === 'status') {
        const label = payload?.label ? String(payload.label) : 'unknown';
        return `status:${label}`;
      }
      return type;
    };
    const clearInactivityWatchdog = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    let forcedChildShutdownTimers = [];
    const clearForcedChildShutdown = () => {
      for (const timer of forcedChildShutdownTimers) clearTimeout(timer);
      forcedChildShutdownTimers = [];
    };
    const scheduleForcedChildShutdown = () => {
      if (!child) return;
      clearForcedChildShutdown();
      forcedChildShutdownTimers = [
        setTimeout(() => {
          if (child) design.runs.signalChild(run, 'SIGTERM');
        }, inactivityKillGraceMs),
        setTimeout(() => {
          if (child) design.runs.signalChild(run, 'SIGKILL');
        }, inactivityKillGraceMs * 2),
      ];
    };
    const failForInactivity = () => {
      if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
      clearInactivityWatchdog();
      const message =
        `Agent stalled without emitting any new output for ${Math.round(inactivityTimeoutMs / 1000)}s. ` +
        'The model or CLI likely hung while generating. ' +
        `Phase details: spawned agent ${userFacingAgentLabel(agentId, resolvedBin)}; stdout arrived: ${childStdoutSeen ? 'yes' : 'no'}; ` +
        `last agent event: ${lastAgentEventPhase}; largest tool result observed: ${lastToolResultChars} chars. ` +
        'Retry the turn, pick a different model, or start a new conversation if the prior context is very large.';
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', message, { retryable: true }));
      // A silent first-token hang is one of the safe transient failure shapes
      // this run is allowed to recover: classifyRunFailure maps the stall text
      // to a retryable `timeout` at `first_token_wait`, and decideSafeRunRetry
      // permits the same-run retry when no output/tools/artifacts were seen.
      // Route through the shared finalizer (after surfacing stallPayload) so
      // the watchdog path follows the same retry policy as child close/error.
      const retried = finishWithRetryDecision('failed', 1, null);
      if (retried) {
        watchdogRetryRestarted = true;
      }
      if (child && !child.killed) design.runs.signalChild(run, 'SIGTERM');
      scheduleForcedChildShutdown();
    };
    const noteAgentActivity = () => {
      const delay = inactivityTimeoutMs;
      if (delay <= 0) return;
      clearInactivityWatchdog();
      inactivityTimer = setTimeout(failForInactivity, delay);
      inactivityTimer.unref?.();
    };
    const unregisterChatAgentEventSink = () => {
      const sinkRunId = toolTokenGrant?.runId ?? runId;
      activeChatAgentEventSinks.delete(sinkRunId);
    };
    if (toolTokenGrant?.runId) {
      activeChatAgentEventSinks.set(toolTokenGrant.runId, (payload) => {
        lastAgentEventPhase = summarizeAgentEventForInactivity(payload);
        noteAgentActivity();
        send('agent', payload);
      });
    }
    // If detection can't find the binary, surface a friendly SSE error
    // pointing at /api/agents instead of silently falling back to
    // spawn(def.bin) — that fallback re-introduces the exact ENOENT symptom
    // from issue #10.
    if (!resolvedBin || !agentLaunch.launchPath) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload(
        'AGENT_UNAVAILABLE',
        `Agent "${def.name}" (\`${def.bin}\`) is not installed or not on PATH. ` +
          'Install it and refresh the agent list (GET /api/agents) before retrying.',
        { retryable: true },
      ));
      return design.runs.finish(run, 'failed', 1, null);
    }
    const browserUseRuntimeEnv = run.browserUse
      ? {
          OD_BROWSER_USE_REQUESTED: run.browserUse.requested ? '1' : '0',
          OD_BROWSER_USE_AVAILABLE: run.browserUse.available ? '1' : '0',
          ...(run.browserUse.reason ? { OD_BROWSER_USE_UNAVAILABLE_REASON: run.browserUse.reason } : {}),
          OD_BROWSER_USE_REGISTRY_PATH: run.browserUse.diagnostics?.registryPath ?? '',
        }
      : {};
    const agentSpawnEnv = spawnEnvForAgent(
      def.id,
      {
        ...createAgentRuntimeEnv(process.env, daemonUrl, toolTokenGrant),
        ...(def.env || {}),
        ...browserUseRuntimeEnv,
      },
      configuredAgentEnv,
      undefined,
      { resolvedBin: agentLaunch.selectedPath },
    );
    const odAgentEnv = {
      OD_BIN,
      OD_NODE_BIN,
      OD_DAEMON_URL: daemonUrl,
      ...(typeof projectId === 'string' && projectId && cwd
        ? {
            OD_PROJECT_ID: projectId,
            OD_PROJECT_DIR: cwd,
          }
        : {}),
    };
    // Scientific-data API credentials (Materials Project, OpenAlex, ...) are
    // exported into the agent child-process env so agent-authored code can
    // read e.g. MP_API_KEY / PMG_MAPI_KEY directly. resolveProviderConfig lets
    // env-vars already present in the daemon process win, so this is
    // idempotent for users who exported them in their shell and additive for
    // users who only saved them in Settings. Best-effort: a failure here must
    // not block the run — the agent just won't see the credential.
    const researchApiEnv = await resolveResearchApiAgentEnv(PROJECT_ROOT).catch(
      () => ({} as Record<string, string>),
    );
    if (run.cancelRequested || design.runs.isTerminal(run.status)) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      return;
    }

    run.status = 'running';
    run.updatedAt = Date.now();
    try {
      // The placeholder is initially pinned while the run is queued. Keep the
      // durable chat projection aligned with the in-memory lifecycle so a
      // client reload does not remain stuck on "Preparing" during execution.
      pinAssistantMessageOnRunCreate(db, run);
    } catch (err) {
      console.warn('[runs] message running-state sync failed', err);
    }
    send('start', {
      runId,
      agentId,
      bin: userFacingAgentLabel(agentId, resolvedBin),
      streamFormat: def.streamFormat ?? 'plain',
      projectId: typeof projectId === 'string' ? projectId : null,
      cwd,
      model: safeModel,
      reasoning: safeReasoning,
      toolTokenExpiresAt: toolTokenGrant?.expiresAt ?? null,
    });
    noteAgentActivity();

    let child;
    let writePromptToChildStdin = false;
    let spawnedAgentEnv = null;
    let agentStdoutTail = '';
    let agentStderrTail = '';
    const emitVisibleAgentStderr = (chunk: unknown) => {
      const visibleChunk = chunk == null ? '' : String(chunk);
      if (!visibleChunk) return;
      agentStderrTail = `${agentStderrTail}${visibleChunk}`.slice(-2000);
      send('stderr', { chunk: visibleChunk });
    };
    try {
      // Prompt delivery via stdin is now the universal default. This bypasses
      // both the cmd.exe 8KB limit and the CreateProcess 32KB limit.
      const stdinMode =
        def.promptViaStdin || false
          ? 'pipe'
          : 'ignore';
      const env = applyAgentLaunchEnv({
        ...agentSpawnEnv,
        ...odAgentEnv,
        // Scientific-data API keys (MP_API_KEY, OPENALEX_*, ...). Layered after
        // agentSpawnEnv so a Settings-saved key is visible to agent code, but
        // resolveProviderConfig already prefers any inherited env value so a
        // shell-exported key is preserved rather than clobbered.
        ...researchApiEnv,
        ...({}),
        // MatOS trace inheritance: one OD conversation = one MatOS trace, so
        // the MatOS sessions behind every turn (and post-invalidation
        // session rebuilds) stitch together for `matos trace` / evolution
        // provenance instead of each minting an isolated trace id.
        ...openDesignMatOSTraceEnv({
          agentId: def.id,
          runId: run.id,
          conversationId: run.conversationId,
          projectId: run.projectId,
        }),
        ...(run.matosProjectWriteLockHeld
          ? {
              MATOS_PROJECT_WRITE_LOCK_HELD: String(run.matosProjectWriteLockHeld),
              MATOS_PROJECT_WRITE_LOCK_CWD: String(run.matosProjectWriteLockCwd ?? effectiveCwd),
            }
          : {}),
        // Task-aware role composition: MatOS ranks which knowledge/experience
        // assets to inject against the CURRENT task, but web prompts travel
        // over stdin after composition already happened. Pass the latest user
        // turn (bounded) so different tasks under the same role surface
        // different context. The CLI consumes and unsets it before tools run.
        ...(typeof currentPrompt === 'string' && currentPrompt.trim()
          ? { MATOS_TASK_TEXT: currentPrompt.trim().slice(0, 2000) }
          : {}),
      }, agentLaunch);
      spawnedAgentEnv = env;
      const invocation = createCommandInvocation({
        command: agentLaunch.launchPath,
        args,
        env,
      });
      child = spawn(invocation.command, invocation.args, {
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        cwd: effectiveCwd,
        shell: false,
        detached: process.platform !== 'win32',
        // Required when invocation wraps a Windows .cmd/.bat shim through
        // cmd.exe; without this, Node re-escapes the inner command line and
        // breaks paths containing spaces (issue #315).
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      run.child = child;
      run.childPid = typeof child.pid === 'number' ? child.pid : null;
      if (run.childPid && typeof run.onChildPid === 'function') {
        try {
          run.onChildPid(run.childPid);
        } catch (error) {
          console.warn('[run] child PID persistence hook failed', error);
        }
      }
      run.processGroupId =
        process.platform !== 'win32' && typeof child.pid === 'number'
          ? child.pid
          : null;
      if (def.promptViaStdin && child.stdin) {
        // EPIPE from a fast-exiting CLI (bad auth, missing model, exit on
        // launch) would otherwise surface as an unhandled stream error and
        // crash the daemon. Swallow it — the regular exit/close handlers
        // below already route the underlying failure to SSE via stderr.
        child.stdin.on('error', (err) => {
          // EPIPE = Unix broken-pipe when child closes its stdin read end
          // early. 'write EOF' (err.code 'EOF') = Windows equivalent of
          // the same condition via UV_EOF. Both mean the child exited before
          // reading stdin — the process exit/close handlers already route
          // the underlying failure to SSE via stderr, so swallow these here.
          if (err.code !== 'EPIPE' && err.code !== 'EOF' && err.message !== 'write EOF') {
            send(
              'error',
              createSseErrorPayload(
                'AGENT_EXECUTION_FAILED',
                `stdin: ${err.message}`,
              ),
            );
          }
        });
        writePromptToChildStdin = true;
      }
    } catch (err) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', `spawn failed: ${err.message}`));
      design.runs.finish(run, 'failed', 1, null);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Reset the inactivity watchdog on every raw stdout byte so that
    // structured adapters that buffer partial lines and models that spend a
    // long time in non-streamed reasoning still keep the run alive.
    child.stdout.on('data', (chunk) => {
      childStdoutSeen = true;
      noteAgentActivity();
      agentStdoutTail = `${agentStdoutTail}${chunk}`.slice(-2000);
    });

    // MatOS emits the stable stream-json protocol; decode it for the browser.
    let agentStreamError = null;
    // Tracks whether any stream the run is using actually emitted user-
    // visible content or a deliverable.
    let agentProducedOutput = false;
    const trackingSubstantiveOutput = true;
    // Event types that count as "the agent actually produced a response or a
    // deliverable." Lifecycle markers (`status`), meter readings (`usage`),
    // reasoning deltas, and tool activity deliberately do NOT count: a run can
    // think/read/call tools and still terminate before returning text/artifacts
    // to the user. Treat that as empty output instead of a silent success
    // (issues #691, #4814).
    const SUBSTANTIVE_AGENT_EVENT_TYPES = new Set([
      'text_delta',
      'artifact',
    ]);
    // First-token timing must reflect when the user actually starts seeing
    // model output, so only token-producing events qualify. `tool_use` is
    // deliberately excluded: a run that opens with a Read/Glob/MCP call would
    // otherwise stamp `firstTokenAt` before any `text_delta` streamed,
    // making `time_to_first_token_ms` / `spawn_to_first_token_ms` under-report
    // TTFT for tool-first runs. `thinking_delta` stays in because it is the
    // first visible model activity the user perceives.
    const FIRST_TOKEN_AGENT_EVENT_TYPES = new Set([
      'text_delta',
      'thinking_delta',
    ]);
    // Per-run role-marker guard for non-Claude structured streams (#3247).
    // Claude has its own per-message guards in claude-stream.ts.
    const runGuard = createRoleMarkerGuard('run');
    let runWarned = false;
    const titleMarkerStripper = createAgentTitleMarkerStripper({
      enabled: Boolean(titleGenerationRequested),
      emitTitle: (title) => send('agent', { type: 'conversation_title', title }),
    });

    function flushAgentTitleMarkerBuffer() {
      const visible = titleMarkerStripper.flush();
      if (visible) emitGuardedTextDelta(visible);
    }

    function guardTextDelta(delta) {
      return runGuard.feedText(delta);
    }

    // Shared helper for emitting guarded text deltas from the agent stream
    // handler.
    function emitGuardedTextDelta(delta: string) {
      const safe = guardTextDelta(delta);
      if (safe.length > 0) {
        emitAgentEvent({ type: 'text_delta', delta: safe });
      }
      if (runGuard.contaminated && !runWarned) {
        runWarned = true;
        const warn = runGuard.warningEvent();
        if (warn) {
          send('agent', warn);
          abortForRoleMarker(warn.marker);
        }
      }
    }


    // Detection-only is necessary but not sufficient: by the time we see
    // the role marker the model has already burned tokens, and the
    // subprocess will keep generating downstream tokens (including
    // `tool_use` blocks built on the fabricated context) until it exits
    // on its own. We terminate the child immediately so:
    //   1. Token billing stops at the detection point, not at the
    //      model's natural completion of the contaminated response.
    //   2. `tool_use` content blocks emitted AFTER the marker cannot
    //      reach the daemon's tool-call dispatcher. Blocks emitted
    //      BEFORE the marker have already been dispatched; this guard
    //      can't help with those — they're a separate hardening.
    //   3. The UI distinguishes "completed" from "killed by safety
    //      guard" through a structured SSE error rather than seeing a
    //      `fabricated_role_marker` warning followed by an eventual
    //      normal turn-end.
    // Idempotent — multiple guard paths (per-message Claude, run-scoped
    // non-Claude, plain stdout) can all call it.
    let roleMarkerAbortFired = false;
    function abortForRoleMarker(marker: string) {
      if (roleMarkerAbortFired) return;
      roleMarkerAbortFired = true;
      send(
        'error',
        createSseErrorPayload(
          'ROLE_MARKER_HALLUCINATION',
          `Run terminated: model emitted fabricated role marker (\`${marker}\`). ` +
            'No further tokens or tool calls accepted from this turn. ' +
            'See https://github.com/nexu-io/open-design/issues/3247.',
          { retryable: true },
        ),
      );
      if (child && !child.killed) design.runs.signalChild(run, 'SIGTERM');
      scheduleForcedChildShutdown();
    }

    // Per-run tool-loop guard. Agents sometimes fixate on a failing tool call
    // and grind through dozens of identical attempts (e.g. re-running an Edit
    // whose `old_string` never matches, or a shell assertion against an element
    // that does not exist). This guard observes the normalized
    // tool_use/tool_result events every agent path emits. It emits a
    // one-shot `tool_loop` warning, then (in halt mode) terminates the run
    // at a hard ceiling. Mode via OD_TOOL_LOOP_GUARD.
    const toolLoopGuard = createToolLoopGuard({ mode: resolveToolLoopMode() });
    let toolLoopAbortFired = false;

    // Idempotent — both agent-event paths (sendAgentEvent, the Claude
    // stream-json callback) can route a halt verdict here.
    function abortForToolLoop(verdict: ToolLoopVerdict) {
      if (toolLoopAbortFired) return;
      toolLoopAbortFired = true;
      send(
        'error',
        createSseErrorPayload(
          'TOOL_LOOP_DETECTED',
          `Run terminated: the agent repeated a failing ${verdict.toolName} call ` +
            `${verdict.count}× without progress (\`${verdict.signature}\`). Re-check the ` +
            'actual target — the file, the element, the command — before retrying ' +
            'instead of resubmitting the same turn.',
          { retryable: true },
        ),
      );
      // Route through signalChild (not a bare child.kill) so the halt escalates
      // to the whole process group when one exists, matching abortForRoleMarker,
      // cancel, and the inactivity watchdog. A bare child.kill leaves Bash/build
      // grandchildren alive to keep mutating the workspace until the forced
      // shutdown fires — exactly the loop class this guard is meant to stop.
      if (child && !child.killed) design.runs.signalChild(run, 'SIGTERM');
      scheduleForcedChildShutdown();
    }

    // Feed a normalized agent event into the loop guard and act on a verdict.
    // Safe to call for every event; non-tool events are ignored. Emit the
    // `tool_loop` warning to the UI/CLI, and on a halt verdict tear the run
    // down so it cannot keep grinding.
    function observeToolEventForLoop(ev: any) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool_use' && typeof ev.id === 'string') {
        toolLoopGuard.observeToolUse(ev.id, typeof ev.name === 'string' ? ev.name : 'tool', ev.input);
        return;
      }
      if (ev.type === 'tool_result' && typeof ev.toolUseId === 'string') {
        const verdict = toolLoopGuard.observeToolResult(
          ev.toolUseId,
          Boolean(ev.isError),
          typeof ev.content === 'string' ? ev.content : '',
        );
        if (verdict) {
          send('agent', verdict);
          if (verdict.action === 'halt') abortForToolLoop(verdict);
        }
      }
    }

    // Single choke point for emitting an agent event to the client. Every
    // stream handler emits through here, never via a bare send('agent', …), so
    // the tool-loop guard sees every runtime's tool activity and no handler can
    // drift out of coverage. observe runs AFTER the send so a `tool_loop`
    // warning/halt follows the result that triggered it in the stream.
    function emitAgentEvent(ev: any) {
      if (ev?.type && SUBSTANTIVE_AGENT_EVENT_TYPES.has(ev.type) &&
          (ev.type !== 'text_delta' || (typeof ev.delta === 'string' && ev.delta.trim().length > 0))) {
        agentProducedOutput = true;
      }
      send('agent', ev);
      observeToolEventForLoop(ev);
    }

    {
      const claude = createClaudeStreamHandler((ev) => {
        // First parsed claude-stream-json event = CLI ready (#3408 §4); the
        // init/system line arrives well before the model's first token.
        if (ev?.type === 'error') {
          if (agentStreamError) return;
          const message = String((ev as any).message || 'MatOS stream error');
          const failureText = [
            message,
            typeof (ev as any).code === 'string' ? (ev as any).code : '',
            agentStdoutTail,
            agentStderrTail,
          ].join('\n');
          clearInactivityWatchdog();
          const serviceCode = classifyAgentServiceFailure(failureText);
          agentStreamError = message;
          send('error', createSseErrorPayload(
            serviceCode ?? 'AGENT_EXECUTION_FAILED',
            agentStreamError,
            {
              retryable:
                serviceCode === 'AGENT_AUTH_REQUIRED' || serviceCode === 'RATE_LIMITED',
            },
          ));
          return;
        }
        lastAgentEventPhase = summarizeAgentEventForInactivity(ev);
        noteAgentActivity();
        if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
          const visibleDelta = titleMarkerStripper.strip(ev.delta);
          if (visibleDelta) {
            emitAgentEvent({ ...ev, delta: visibleDelta });
          }
          return;
        }
        emitAgentEvent(ev);
        // Claude uses per-message guards (claude-stream.ts) rather than the
        // run-scoped guard above, so its `fabricated_role_marker` events
        // surface here directly from the stream handler, not via
        // emitGuardedTextDelta. Same abort semantics apply.
        if (ev && (ev as any).type === 'fabricated_role_marker') {
          const m = (ev as any).marker;
          abortForRoleMarker(typeof m === 'string' ? m : 'role marker');
        }
        // Stream-json input mode keeps the child's stdin open across the
        // turn so the daemon can stream further user messages mid-turn. The
        // child has no other way to know the turn is over, though — without
        // an EOF it sits idle until the inactivity watchdog kills it.
        // Bookkeeping here closes stdin on a clean terminal turn:
        //   - turn_end (per-turn synthesized from `stop_reason`): fire on
        //     `end_turn` etc. but NOT on `tool_use` — that stop reason
        //     means the model paused mid-tool, not "turn complete".
        //   - usage (session result at EOF in single-shot mode).
        try {
          applyClaudeStreamJsonRunBookkeeping(run, ev);
        } catch {}
      }, { suppressHtmlArtifactsAfterFileWrite: true });
      child.stdout.on('data', (chunk) => claude.feed(chunk));
      child.on('close', () => claude.flush());
    }
    child.stderr.on('data', (chunk) => {
      noteAgentActivity();
      emitVisibleAgentStderr(chunk);
    });

    child.on('error', (err) => {
      clearInactivityWatchdog();
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
      finishWithRetryDecision('failed', 1, null);
    });
    child.on('close', async (code, signal) => {
      clearInactivityWatchdog();
      clearForcedChildShutdown();
      if (matosGlobalRulesFile) {
        void fs.promises.rm(matosGlobalRulesFile, { force: true }).catch(() => {});
      }
      if (watchdogRetryRestarted) {
        // The inactivity watchdog already failed this attempt and the same-run
        // retry restarted on a fresh child. Finalization and event-sink / run-
        // handle ownership (keyed by the shared runId) now belong to the new
        // attempt, so this stalled child's close must not re-run them — doing
        // so would re-finalize the run and delete the new attempt's sink.
        // Revoke only THIS attempt's tool token (idempotent, keyed by its own
        // token string) and bail; the `finally` block still cleans up logs.
        revokeToolToken('child_exit');
        return;
      }
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      // Resume-target-missing recovery runs BEFORE the generic fatal/stream-error
      // short-circuits. The signal can arrive as a stream `error` event, which
      // would otherwise be swallowed by the `stream_error` path below and leave
      // the dead session id stored — so every later turn would retry the same
      // broken resume (#4275 class). Clearing the stale handle here lets the
      // next turn start fresh + re-seed the full transcript: one cold turn,
      // never a broken conversation.
      if (
        !run.cancelRequested &&
        runtimeResumesSessionById(def) &&
        agentResumeCtx.isResuming &&
        run.conversationId &&
        isClaudeResumeFailure(agentStderrTail, agentStdoutTail)
      ) {
        // The resumed upstream session is gone (expired / pruned). Clear the dead
        // handle and TRANSPARENTLY re-run this same turn with a fresh session +
        // the full transcript rebuilt from the DB — exactly the pre-session-reuse
        // path. The user sees one (slightly slower) turn, never an error or a
        // "resend" prompt. Re-spawn reuses the same-run retry machinery; because
        // the session row is now cleared, the re-spawn resolves isResuming=false
        // (fresh session, full transcript), so it CANNOT resume-fail again — the
        // `resumeAutoReseeded` guard is belt-and-suspenders against any loop.
        clearAgentSession(db, run.conversationId, agentSessionId);
        if (!run.resumeAutoReseeded) {
          run.resumeAutoReseeded = true;
          run.resumeAutoReseededFrom = agentResumeCtx.resumeSessionId ?? null;
          // Persisted to the per-run events.jsonl that the help → diagnostics
          // export bundles, so the whole resume → fail → auto-reseed chain is
          // visible in a support bundle without any user-facing signal.
          design.runs.emit(run, 'diagnostic', {
            type: 'agent_resume_auto_reseed',
            agent_id: def.id,
            reason: 'resume_failed',
            previous_session_id: agentResumeCtx.resumeSessionId ?? null,
            stale_session_cleared: true,
          });
          scheduleRetryRestart(0);
          return;
        }
        // Unreachable in practice (the reseed runs fresh); if a second resume
        // failure ever surfaces in one run, fall back to the explicit affordance.
        send('error', createSseErrorPayload(
          'AGENT_EXECUTION_FAILED',
          'The previous session could not be resumed (it may have expired). Resend your message to continue with a fresh session.',
          { retryable: true },
        ));
        return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
      }
      flushAgentTitleMarkerBuffer();
      if (agentStreamError) {
        markRpcCloseReason('stream_error');
        return finishWithRetryDecision('failed', code === 0 ? 1 : (code ?? 1), signal ?? null);
      }
      // Empty-output guard: a clean `code === 0` exit with no visible
      // output means the run silently finished without producing anything.
      // Surface an explicit failure so the chat shows a clear reason.
      if (
        code === 0 &&
        !run.cancelRequested &&
        trackingSubstantiveOutput &&
        !agentProducedOutput
      ) {
        markRpcCloseReason('empty_output');
        send('error', createSseErrorPayload(
          'AGENT_EXECUTION_FAILED',
          'Agent completed without producing any output. The model or provider may have returned an empty response — check the agent logs for upstream errors.',
          { retryable: true },
        ));
        return finishWithRetryDecision('failed', code, signal);
      }
      const runArtifactSideEffects = scanRunEventsForRetrySideEffects(run.events);
      const status = classifyChatRunCloseStatus({
        cancelRequested: !!run.cancelRequested,
        code,
        signal,
        turnCompletedCleanly: !!run.turnCompletedCleanly,
        artifactProducedThisRun: runArtifactSideEffects.artifactWriteSeen,
      });
      // Skip the close-handler failure emit when the run is already
      // terminal: the inactivity watchdog (failForInactivity) finishes the
      // run — sending its error and clearing run.clients/eventsLogStream —
      // before SIGTERM, so re-emitting here would double-send the error and
      // reopen the closed events-log stream. The run is finalized below
      // regardless (finish() no-ops once terminal).
      if (status === 'failed' && !design.runs.isTerminal(run.status)) {
        const serviceCode = classifyAgentServiceFailure(
          `${agentStderrTail}\n${agentStdoutTail}`,
        );
        if (serviceCode) {
          const detail = (agentStderrTail || agentStdoutTail || '').trim();
          send('error', createSseErrorPayload(
            serviceCode,
            detail || 'The model service returned an error.',
            { retryable: true },
          ));
        }
      }
      // Reconcile any HTML artifacts that were written during this run
      // without a manifest sidecar (e.g. agent used write_file instead of
      // create_artifact, or the run terminated between HTML write and
      // sidecar write). Only files modified after the run started are
      // touched — pre-existing HTML in imported-folder projects must not
      // receive spurious manifests. Best-effort; must not block finalisation.
      // See issue #2893.
      if (run.projectId) {
        (async () => {
          try {
            const project = getProject(db, run.projectId);
            const files = await listFiles(PROJECTS_DIR, run.projectId, {
              metadata: project?.metadata,
            });
            const dir = resolveProjectDir(PROJECTS_DIR, run.projectId, project?.metadata);
            for (const f of files) {
              const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
              if (ext !== '.html' && ext !== '.htm') continue;
              try {
                const filePath = path.join(dir, f.name);
                const st = await fs.promises.stat(filePath);
                if (!isRunTouchedProjectFile(st.mtimeMs, runStartTimeMs)) continue;
                await reconcileHtmlArtifactManifest(
                  PROJECTS_DIR,
                  run.projectId,
                  f.name,
                  project?.metadata,
                );
              } catch { /* per-file best-effort */ }
            }
          } catch { /* project-level best-effort */ }
        })();
      }
      const flushedTitleMarkerText = titleMarkerStripper.flush();
      if (flushedTitleMarkerText) send('stdout', { chunk: flushedTitleMarkerText });
      if (status === 'succeeded') {
        try {
          await snapshotAiHtmlVersionsBeforeSuccess();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const details = err instanceof AiHtmlVersionSnapshotError
            ? { failures: err.failures }
            : undefined;
          send('error', createSseErrorPayload(
            'HTML_VERSION_SNAPSHOT_FAILED',
            message,
            {
              retryable: false,
              ...(details ? { details } : {}),
            },
          ));
          design.runs.finish(run, 'failed', 1, signal);
          return;
        }
        persistDeliveredAgentSessionState();
      }
      finishWithRetryDecision(status, code, signal);
    });
    if (writePromptToChildStdin && child.stdin) {
      const promptInputFormat = def.promptInputFormat ?? 'text';
      const markStdinWriteEnd = (err?: Error | null) => {
        if (err) return;
      };
      if (promptInputFormat === 'stream-json') {
        // Wrap the prompt as an Anthropic user message and write it as one
        // JSONL line. Do NOT close stdin: claude-code keeps reading further
        // messages until EOF, which is what lets the daemon stream more user
        // messages into the same turn. The stdin is closed on a clean terminal
        // turn (see applyClaudeStreamJsonRunBookkeeping) or when the child
        // exits (run terminates, user cancels).
        const userMessage = JSON.stringify(
          streamJsonUserMessage ?? buildStreamJsonUserMessage(composed, []),
        );
        try {
          child.stdin.write(`${userMessage}\n`, 'utf8', markStdinWriteEnd);
        } catch (err) {
          // Swallow EPIPE here for the same reason as the listener above —
          // a fast-exiting child has already routed its failure through
          // stderr / exit handlers.
          if (err && err.code !== 'EPIPE') throw err;
        }
        run.stdinOpen = true;
      } else {
        child.stdin.end(composed, 'utf8', markStdinWriteEnd);
      }
    }
  };

  const startChatRun = async (chatBody, run) => {
    const projectId = typeof chatBody?.projectId === 'string' ? chatBody.projectId : null;
    const agentId = typeof chatBody?.agentId === 'string'
      ? chatBody.agentId
      : typeof run?.agentId === 'string' ? run.agentId : null;
    if (!usesNativeMatOSPromptAuthority(agentId) || !projectId) {
      return startChatRunCore(chatBody, run);
    }
    if (run.matosProjectWriteLockHeld) {
      return startChatRunCore(chatBody, run);
    }
    const project = getProject(db, projectId);
    if (!project) {
      return startChatRunCore(chatBody, run);
    }
    const projectCwd = resolveProjectDir(PROJECTS_DIR, projectId, project.metadata);
    const release = await acquireProjectWriteLock({
      projectCwd,
      runId: run.id,
      // Owner-liveness callback: a lock whose owning run already reached a
      // terminal status (crash, cancellation race) must be reclaimable
      // instead of deadlocking every later run on the same project.
      ownerIsActive(owner) {
        const ownerRun = design.runs.get(owner.runId);
        return !!ownerRun && !design.runs.isTerminal(ownerRun.status);
      },
    });
    run.matosProjectWriteLockHeld = run.id;
    run.matosProjectWriteLockCwd = projectCwd;
    // Post-acquire hook: the lock is the point where every earlier project
    // run is guaranteed finished writing, so runs that diff project files
    // for producedFiles attribution (MatOS group tasks) re-baseline here.
    if (typeof run.onProjectWriteLockAcquired === 'function') {
      try {
        await run.onProjectWriteLockAcquired();
      } catch (hookError) {
        console.warn('[project-write-lock] post-acquire hook failed', hookError);
      }
    }
    let released = false;
    const releaseOnce = async () => {
      if (released) return;
      released = true;
      run.matosProjectWriteLockHeld = null;
      run.matosProjectWriteLockCwd = null;
      await release();
    };
    try {
      const result = await startChatRunCore(chatBody, run);
      void design.runs.wait(run)
        .finally(() => releaseOnce())
        .catch((error) => {
          console.warn('[project-write-lock] failed to release after run completion', error);
        });
      return result;
    } catch (error) {
      await releaseOnce().catch(() => {});
      throw error;
    }
  };

  registerRunRoutes(app, {
    db,
    design,
    http: httpDeps,
    paths: { PROJECTS_DIR, RUNTIME_DATA_DIR },
    agents: { detectAgents, getAgentDef },
    chat: { startChatRun },
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
    messages: {
      pinAssistantMessageOnRunCreate,
      reconcileAssistantMessageOnRunEnd,
    },
  });

  // Each routine fire resolves an agent, prepares project/conversation state,
  // and dispatches into the same chat runner used by manual runs.
  routineService.setRunHandler(async ({ routine, trigger, startedAt, runId }) => {
    const appConfig = await readAppConfig(RUNTIME_DATA_DIR);
    let agentId = routine.agentId
      || (typeof appConfig.agentId === 'string' && appConfig.agentId ? appConfig.agentId : null);
    if (!agentId) {
      const agents = await detectAgents(appConfig.agentCliEnv ?? {}).catch(() => []);
      agentId = agents.find((agent) => agent.available)?.id ?? null;
    }
    if (!agentId) {
      throw new Error('No available agent is configured. Choose an agent in Settings first.');
    }
    const nativeMatOSPromptAuthority = usesNativeMatOSPromptAuthority(agentId);

    const now = startedAt;
    const routineContext = normalizeRunContextSelection(routine.context);
    const routineSkillId = routine.skillId ?? routineContext.skillIds?.[0] ?? null;
    const contextMetadata = {
      ...(routineContext.mcpServerIds?.length
        ? { contextMcpServers: routineContext.mcpServerIds.map((id) => ({ id })) }
        : {}),
    };
    const stamp = formatLocalProjectTimestamp(new Date(now).toISOString());
    let projectId;
    let projectName;
    const scheduledPlaceholderProjectId = `routine-pending-project-${runId}`;
    const scheduledPlaceholderConversationId = `routine-pending-conv-${runId}`;
    let createdProjectId: string | null = null;
    let createdConversationId: string | null = null;
    const createRoutineProject = () => {
      if (createdProjectId) return;
      projectId = `routine-${randomUUID()}`;
      projectName = `${routine.name} · ${stamp}`;
      insertProject(db, {
        id: projectId,
        name: projectName,
        skillId: routineSkillId,
        pendingPrompt: null,
        metadata: {
          kind: 'other',
          intent: 'automation',
          automationId: routine.id,
          routineId: routine.id,
          trigger,
          ...contextMetadata,
        },
        createdAt: now,
        updatedAt: now,
      });
      createdProjectId = projectId;
    };
    if (routine.target.mode === 'reuse') {
      const project = getProject(db, routine.target.projectId);
      if (!project) throw new Error(`Routine target project ${routine.target.projectId} not found`);
      assertSandboxProjectRootAvailable(project.metadata);
      projectId = project.id;
      projectName = project.name;
    }

    let conversationId = `routine-conv-${randomUUID()}`;
    let conversationCreatedEvent: ProjectConversationCreatedSsePayload | null = null;
    const routineConversationTitle = () => routine.target.mode === 'reuse'
      ? `${routine.name} · ${stamp}`
      : projectName;
    const createRoutineConversation = () => {
      if (createdConversationId) return;
      if (!projectId) createRoutineProject();
      if (!projectId) throw new Error('Routine project could not be prepared');
      conversationId = `routine-conv-${randomUUID()}`;
      insertConversation(db, {
        id: conversationId,
        projectId,
        title: routineConversationTitle(),
        createdAt: now,
        updatedAt: now,
      });
      createdConversationId = conversationId;
      conversationCreatedEvent = {
        type: 'conversation-created',
        projectId,
        conversationId,
        title: routineConversationTitle(),
        createdAt: now,
      };
    };

    const assistantMessageId = `routine-assistant-${randomUUID()}`;
    const run = design.runs.create({
      projectId: projectId ?? scheduledPlaceholderProjectId,
      conversationId: createdConversationId ? conversationId : scheduledPlaceholderConversationId,
      assistantMessageId,
      clientRequestId: `routine-${trigger}-${randomUUID()}`,
      agentId,
    });
    const persistPreparedRun = async (routineRun = null) => {
      if (!projectId) {
        createRoutineProject();
      }
      if (projectId) {
        run.projectId = projectId;
        const preparedProject = getProject(db, projectId);
        run.projectMetadata =
          preparedProject?.metadata && typeof preparedProject.metadata === 'object'
            ? preparedProject.metadata
            : null;
        if (routineRun) {
          routineRun.projectId = projectId;
        }
      }
      createRoutineConversation();
      run.conversationId = conversationId;
      if (routineRun) {
        routineRun.conversationId = conversationId;
        routineRun.agentRunId = run.id;
      }
      upsertMessage(db, conversationId, {
        id: `routine-user-${run.id}`,
        role: 'user',
        content: routine.prompt,
      });
      upsertMessage(db, conversationId, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        agentId,
        agentName: getAgentDef(agentId)?.name ?? agentId,
        runId: run.id,
        runStatus: 'queued',
        startedAt: now,
      });
    };

    const modelPrefs = appConfig.agentModels?.[agentId] ?? {};
    const start = () => {
      // Notify any open `ProjectView` only after the routine run row has
      // been accepted and preparation has completed, so failed setup does not
      // surface phantom conversations (#1361).
      if (conversationCreatedEvent) emitProjectEvent(projectId, conversationCreatedEvent);
      design.runs.start(run, () => startChatRun({
        agentId,
        projectId,
        conversationId: run.conversationId,
        assistantMessageId: run.assistantMessageId,
        clientRequestId: run.clientRequestId,
        model: modelPrefs.model ?? null,
        reasoning: modelPrefs.reasoning ?? null,
        message: routine.prompt,
        ...(!nativeMatOSPromptAuthority
          ? {
              skillId: routineSkillId,
                    context: routineContext,
              systemPrompt: [
                `You are running an unattended scheduled routine named "${routine.name}".`,
                'Do not ask follow-up questions, do not emit <question-form>, and do not wait for user input. Pick reasonable defaults and finish the task.',
              ].join('\n'),
            }
          : {}),
      }, run));
    };

    // Tear-down for the case where the durable routine_run row was never
    // inserted (sibling daemon won the slot, or insertRun threw). The
    // in-memory chat run was created speculatively above, but the deferred
    // `persistPreparedRun()` has not run yet — so no project / conversation
    // / snapshot writes have to be rolled back. Dropping the run keeps it
    // off `/api/runs` instead of leaving a phantom canceled entry there.
    const discardUnstarted = () => {
      design.runs.drop(run);
    };

    const discard = () => {
      if (typeof run.projectId === 'string' && run.projectId.startsWith('routine-pending-')) {
        run.projectId = null;
      }
      if (typeof run.conversationId === 'string' && run.conversationId.startsWith('routine-pending-')) {
        run.conversationId = null;
      }
      design.runs.finish(run, 'canceled');
      if (createdConversationId) {
        deleteConversation(db, createdConversationId);
      }
      if (createdProjectId) {
        dbDeleteProject(db, createdProjectId);
      }
    };

    const completion = (async () => {
      const finalStatus = await design.runs.wait(run);
      const failureError = finalStatus.status === 'failed'
        ? (typeof finalStatus.error === 'string' && finalStatus.error.trim() ? finalStatus.error.trim() : null)
        : null;
      const failureErrorCode = finalStatus.status === 'failed'
        ? (typeof finalStatus.errorCode === 'string' && finalStatus.errorCode.trim() ? finalStatus.errorCode.trim() : null)
        : null;
      if (failureError) {
        appendMessageStatusEvent(db, assistantMessageId, {
          label: 'error',
          detail: failureError,
        });
      }
      db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`)
        .run(finalStatus.status, Date.now(), assistantMessageId);
      return {
        status: finalStatus.status,
        summary: failureError
          ? `Routine "${routine.name}" failed: ${failureError}`
          : `Routine "${routine.name}" ${finalStatus.status}.`,
        error: failureError ?? undefined,
        errorCode: failureErrorCode ?? undefined,
      };
    })();

    return {
      projectId: run.projectId,
      conversationId: run.conversationId,
      agentRunId: run.id,
      completion,
      prepare: persistPreparedRun,
      start,
      discard,
      discardUnstarted,
    };
  });
  routineService.start();

  assertServerContextSatisfiesRoutes({
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    ids: idDeps,
    uploads: uploadDeps,
    node: nodeDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    conversations: conversationDeps,
    templates: templateDeps,
    status: projectStatusDeps,
    events: projectEventDeps,
    imports: importDeps,
    exports: projectExportDeps,
    artifacts: artifactDeps,
    documents: { buildDocumentPreview },
    auth: authDeps,
    appConfig: appConfigDeps,
    nativeDialogs: nativeDialogDeps,
    research: researchDeps,
    mcp: { pendingAuth: mcpPendingAuth, daemonUrlRef },
    resources: {
      listAllSkills,
      listAllDesignTemplates,
      listAllSkillLikeEntries,
      mimeFor,
    },
    routines: { routineService },
    projectPreviewScopes,
    validation: validationDeps,
    chat: { startChatRun },
    messages: {
      pinAssistantMessageOnRunCreate,
      reconcileAssistantMessageOnRunEnd,
    },
    agents: agentDeps,
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
  });

  // Project group-task routes execute through the same native chat runner as
  // ordinary chat. Register them only after startChatRun is initialized; doing
  // this in the earlier project-route block hits the const temporal dead zone
  // during daemon startup.
  registerProjectRoutes(app, {
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    projectStore: projectStoreDeps,
    projectFiles: projectFileDeps,
    conversations: conversationDeps,
    templates: templateDeps,
    status: projectStatusDeps,
    events: projectEventDeps,
    ids: idDeps,
    appConfig: appConfigDeps,
    agents: agentDeps,
    validation: validationDeps,
    chat: { startChatRun },
    messages: {
      pinAssistantMessageOnRunCreate,
      reconcileAssistantMessageOnRunEnd,
    },
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
  });

  registerRoutineRoutes(app, {
    db,
    paths: { RUNTIME_DATA_DIR },
    routines: { routineService },
  });

  registerChatRoutes(app, {
    db,
    design,
    http: httpDeps,
    paths: pathDeps,
    chat: { startChatRun },
    agents: agentDeps,
    validation: validationDeps,
    lifecycle: { isDaemonShuttingDown: () => daemonShuttingDown },
  });

  registerStaticSpaFallback(app, STATIC_DIR);

  // Wait for `listen` to bind so callers always see the resolved URL —
  // critical when port=0 (ephemeral port) and when the embedding sidecar
  // needs to advertise the port to a parent process before any request
  // can flow. Three callers depend on this contract:
  //   - `apps/daemon/src/cli.ts`            → expects `{ url, server, shutdown }`
  //   - `apps/daemon/sidecar/server.ts`     → expects `{ url, server }`
  //   - `apps/daemon/tests/version-route.test.ts` → expects `{ url, server }`
  return await new Promise((resolve, reject) => {
    let daemonShutdownStarted = false;
    const cleanupDaemonBackgroundWork = () => {
      routineService?.stop();
    };
    const shutdownDaemonRuns = async () => {
      if (daemonShutdownStarted) return;
      daemonShutdownStarted = true;
      daemonShuttingDown = true;
      await design.runs.shutdownActive({ graceMs: resolveChatRunShutdownGraceMs() });
      await terminalService.shutdownActive();
    };
    let server;
    try {
      server = app.listen(port, host);
      server.once('listening', () => {
        // Widen the between-request idle window so kept-alive sockets
        // belonging to chat/SSE clients survive the gaps between bursts.
        //
        // Node's `keepAliveTimeout` (default 5s) only arms *after* a
        // response finishes writing, bounding the idle gap before the next
        // request on the same socket — it does not fire while an SSE
        // response is still streaming. A streaming `/api/runs/:id/events`
        // response stays open until the agent finishes, so middlebox idle
        // timers (nginx, socat/docker bridges, EC2 SG NAT) are typically
        // the proximate cause when an SSE stream drops; this listener-
        // side change cannot extend a connection past those middleboxes.
        //
        // What it *does* fix: chat clients that pipeline multiple requests
        // on the same TCP socket (status polls, run-status fetches, the
        // initial GET before the SSE upgrade). With the default 5s window
        // a sluggish client can lose the connection between two normal
        // calls and reconnect-storm. 120s aligns with the in-band
        // SSE_KEEPALIVE_INTERVAL_MS (25s) so kept-alive sockets used
        // around an SSE stream stay warm across reasonable client pauses.
        //
        // `headersTimeout` must exceed `keepAliveTimeout` per the Node
        // docs; otherwise a slow-loris client can stall request parsing.
        server.keepAliveTimeout = 120_000;
        server.headersTimeout = 125_000;
        const address = server.address();
        // `address()` can in theory return `string | AddressInfo | null`. For
        // a TCP listener it's always `AddressInfo` with a `.port` — the guard
        // is belt-and-braces so an unexpected null never silently produces a
        // `http://127.0.0.1:0` URL that callers would then try to fetch.
        const boundPort =
          address && typeof address === 'object' ? address.port : null;
        if (!boundPort) {
          reject(
            new Error(
              `[od] daemon failed to resolve listening port (address=${JSON.stringify(address)})`,
            ),
          );
          return;
        }
        resolvedPort = boundPort;
        // When binding to all interfaces report localhost for local callers;
        // when binding to a specific address (e.g. a Tailscale IP) report that
        // address so remote callers and the sidecar use the correct URL.
        const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
        const url = `http://${reportHost}:${resolvedPort}`;
        if (!returnServer) {
          console.log(`[od] daemon listening on ${url}`);
        }
        daemonUrl = url;
        resolve(returnServer ? {
          url,
          server,
          shutdown: shutdownDaemonRuns,
          routeInventory: getRouteRegistrationInventory(app),
        } : url);
      });
    } catch (error) {
      cleanupDaemonBackgroundWork();
      reject(error);
      return;
    }
    server.once('close', () => {
      void shutdownDaemonRuns().finally(cleanupDaemonBackgroundWork);
    });
    // `app.listen` throws synchronously when the port is already in use on
    // some Node versions, but emits an `error` event on others (and for
    // EACCES / EADDRNOTAVAIL even on the same Node). Wire the event so the
    // returned Promise always settles instead of hanging forever.
    server.on('error', (error) => {
      cleanupDaemonBackgroundWork();
      reject(error);
    });
  });
}

function randomId() {
  return randomUUID();
}

function sanitizeSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
