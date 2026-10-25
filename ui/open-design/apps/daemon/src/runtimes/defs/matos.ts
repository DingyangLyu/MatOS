import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

// MatOS owns scientific asset composition and runs agents through DeepSeek
// Harness. This adapter retains the stable stream-json and session/resume
// protocol used by the browser; compatibility field names do not select a
// different execution engine.
//
// Role selection is the MatOS-native per-conversation choice. The web product
// gets the live role catalog from the daemon's cached `/api/matos/roles`
// bridge; agent detection deliberately keeps the small static fallback below
// instead of spawning a second `matos workbench roles list --json` cold Bun
// process on every agent refresh. A picked `role:<id>` is forwarded as
// `--role`, not `--model`; custom refs remain supported for roles newer than
// the fallback. The underlying LLM stays whatever the MatOS deployment env
// configures (MATOS_DSH_MODEL / MatOS provider profile).

// Hidden/internal MatOS roles (self-evolution pipeline workers, judges,
// asset editors) must not appear as user-selectable conversation roles.
const HIDDEN_ROLE_IDS = new Set([
  'direct-asset-editor',
  'experience-refiner',
  'self-evolution-worker',
  'semantic-acceptance-judge',
  'turn-feedback-classifier',
  'user-feedback-critic',
]);

const DEFAULT_ROLE_OPTION: RuntimeModelOption = {
  id: 'default',
  label: 'Default role (MatOS env)',
};

// Concrete roles and their versions come only from the native asset catalog.
// Agent detection can offer the environment default without inventing assets.
const MATOS_FALLBACK_ROLES: RuntimeModelOption[] = [DEFAULT_ROLE_OPTION];

// Shared with the `/api/matos/roles` bridge so the Home role picker and the
// model-picker projection hide the same internal roles.
export function isHiddenMatOSRoleId(id: string): boolean {
  id = id.replace(/^role:/, '').split('@')[0] ?? '';
  if (HIDDEN_ROLE_IDS.has(id)) return true;
  // Deployment-preflight/admin roles are operator tooling, not chat roles.
  return id.startsWith('admin-');
}

// Reasoning-effort levels the MatOS runtime accepts (`--effort`, mirrored
// by the MATOS_DSH_EFFORT env default of `max`). Surfacing them as
// reasoningOptions lights up the standard per-agent reasoning picker in
// Settings and lets the spawn layer validate the persisted choice.
const MATOS_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);

const MATOS_REASONING_OPTIONS: RuntimeModelOption[] = [
  { id: 'default', label: 'Default (mode-based)' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

// MatOS repurposes the three conversation session modes as execution tiers.
// Each tier binds a real effort default and a permission mode, so the mode
// picker's cost meter is a genuine contract instead of copy:
//   - chat  (提问): quick Q&A — low effort, read-only workspace.
//   - plan  (规划): produce a plan — medium effort, read-only workspace.
//   - design (执行): full execution — max effort, MatOS product default
//     bypassPermissions (approval-free runs, per product policy).
// An explicit reasoning pick (Settings per-agent reasoning) overrides the
// tier's effort default; permission stays tier-bound because the web chat
// stream has no interactive approval round-trip (read-only `plan` and
// approval-free `bypassPermissions` are the only headless-safe modes).
export function matosEffortForRun(
  reasoning: string | null | undefined,
  sessionMode: string | undefined,
): string | null {
  if (typeof reasoning === 'string' && MATOS_EFFORT_LEVELS.has(reasoning)) {
    return reasoning;
  }
  if (sessionMode === 'chat') return 'low';
  if (sessionMode === 'plan') return 'medium';
  // design (and unknown modes) keep the deployment default (env `max`).
  return null;
}

export function matosPermissionModeForRun(sessionMode: string | undefined): string {
  if (sessionMode === 'chat' || sessionMode === 'plan') return 'plan';
  return 'bypassPermissions';
}

export function parseMatOSRoleList(stdout: string): RuntimeModelOption[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  const resources =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { resources?: unknown }).resources
      : null;
  if (!Array.isArray(resources)) return null;
  const out: RuntimeModelOption[] = [DEFAULT_ROLE_OPTION];
  const seen = new Set(['default']);
  for (const item of resources) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || isHiddenMatOSRoleId(id)) continue;
    const canonicalKey = typeof record.canonicalKey === 'string'
      ? record.canonicalKey.trim()
      : '';
    const listedRef = typeof record.ref === 'string' ? record.ref.trim() : '';
    const version = typeof record.version === 'string' ? record.version.trim() : '';
    const rawRef = canonicalKey || listedRef || `role:${id}`;
    const ref = rawRef.includes('@') || !version ? rawRef : `${rawRef}@${version}`;
    if (seen.has(ref)) continue;
    const status = typeof record.status === 'string' ? record.status : 'enabled';
    if (status !== 'enabled') continue;
    seen.add(ref);
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : id;
    out.push({ id: ref, label: name });
  }
  return out.length > 1 ? out : null;
}

export const matosAgentDef = {
    id: 'matos',
    name: 'MatOS',
    bin: 'matos',
    versionArgs: ['--version'],
    fallbackModels: MATOS_FALLBACK_ROLES,
    reasoningOptions: MATOS_REASONING_OPTIONS,
    // `matos --role <ref> <args...>` composes the role asset graph
    // (prompt, skills, tools, MCP configs, knowledge paths) and runs it on
    // DeepSeek Harness through the MatOS host, which speaks the stream-json
    // protocol this daemon parses.
    buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}, runtimeContext = {}) => {
      const args: string[] = [];
      if (options.model && options.model !== 'default') {
        args.push('--role', options.model);
      }
      // Per-conversation provider LLM override (web `/model` picker). Kept
      // separate from `options.model`, which MatOS repurposes as the role
      // ref; `matos` accepts a standard `--model` flag.
      if (
        typeof runtimeContext.providerModel === 'string' &&
        runtimeContext.providerModel
      ) {
        args.push('--model', runtimeContext.providerModel);
      }
      // UI selections follow scoped accepted identities. Legacy browsers and
      // cached project metadata carry display-version pins; never forward those
      // as explicit CLI pins. Native project policy/dependencies remain strict.
      for (const assetRef of new Set((runtimeContext.assetRefs ?? []).map(ref => ref.trim().replace(/@[^@]+$/, '')))) {
        args.push('--asset', assetRef);
      }
      // User global rules from Settings → Instructions, appended after the
      // role's own prompt by the native host.
      if (typeof runtimeContext.appendSystemPromptFile === 'string' && runtimeContext.appendSystemPromptFile) {
        args.push('--append-system-prompt-file', runtimeContext.appendSystemPromptFile);
      }
      args.push(
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        // The MatOS host always supports partial messages, so no capability
        // probe is needed.
        '--include-partial-messages',
      );
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && d.length > 0,
      );
      if (dirs.length > 0) {
        args.push('--add-dir', ...dirs);
      }
      // Session resume: continue the MatOS session so the role keeps its
      // working memory across turns instead of replaying the transcript.
      if (typeof runtimeContext.resumeSessionId === 'string' && runtimeContext.resumeSessionId) {
        args.push('--resume', runtimeContext.resumeSessionId);
      } else if (typeof runtimeContext.newSessionId === 'string' && runtimeContext.newSessionId) {
        args.push('--session-id', runtimeContext.newSessionId);
      }
      // Reasoning effort: an explicit per-agent reasoning pick wins; else
      // the session-mode tier default (chat=low / plan=medium); else omit
      // so the deployment env default (MATOS_DSH_EFFORT=max) and
      // any role-level `runtime.effort` apply. `matos` passes `--effort`
      // on to DeepSeek Harness.
      const effort = matosEffortForRun(options.reasoning, runtimeContext.sessionMode);
      if (effort) {
        args.push('--effort', effort);
      }
      // Permission tier: chat/plan run read-only (`plan` mode — the only
      // approval-free restricted mode that works headless), design keeps
      // the MatOS product default of bypassPermissions.
      args.push('--permission-mode', matosPermissionModeForRun(runtimeContext.sessionMode));
      return args;
    },
    promptViaStdin: true,
    promptInputFormat: 'stream-json',
    // The MatOS host accepts Anthropic-style image content blocks in
    // stream-json input and passes them to DSH. The daemon also keeps each
    // @path in the text for the Gemini vision tool.
    supportsImagePaths: true,
    streamFormat: 'claude-stream-json',
    // The MatOS host loads `.mcp.json` from the project cwd (the file format
    // Claude Code also uses), so user-configured external MCP servers inject
    // through it.
    externalMcpInjection: 'claude-mcp-json',
    resumesSessionViaCli: true,
    // Do not let a cosmetic version lookup run a full Bun/asset cold-start:
    // the workspace wrapper can spend tens of seconds in environment setup
    // before printing it. A timeout still marks a successfully spawned,
    // bundled executable as invocable; actual runs remain authoritative.
    versionProbeTimeoutMs: 1_000,
    // Free-typed refs (e.g. `role:my-user-role@0.1.0` from a user scope)
    // are legitimate; sanitizeCustomModel already admits `:@./-`.
    supportsCustomModel: true,
    // MatOS turns legitimately go quiet for long stretches: a single
    // mcp__matos_asset__workflow_run / compute tool call can sit inside a
    // DFT/HPC step with no stdout while the CLI waits on the tool result.
    // The 10-minute global default watchdog killed such runs as "Agent
    // stalled" mid-workflow; 30 minutes bounds real hangs while giving
    // synchronous compute tool calls room. Long workflows should still
    // prefer workflow_run wait=false (detached start + status polling).
    // Operators can tighten via OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS.
    inactivityTimeoutMs: 30 * 60 * 1000,
} satisfies RuntimeAgentDef;
