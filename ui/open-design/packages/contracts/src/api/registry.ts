export interface AgentModelOption {
  id: string;
  label: string;
  default?: boolean;
  reasoningOptions?: AgentModelOption[];
}

/**
 * A typed "what should the UI do to fix this" intent attached to an
 * {@link AgentDiagnostic}. The UI renders a button per intent and owns the
 * concrete handler (open a URL, re-run detection, write an env override,
 * launch the OAuth terminal flow). Keeping the intent typed — rather than a
 * pre-baked button label + URL — means the Settings card, the unavailable
 * grid, and (PR-B) the `od agent healthcheck` CLI / health-check panel all
 * render the same fix affordances from one source of truth instead of each
 * re-deriving copy and wiring.
 */
export type AgentFixIntent =
  /** Open the agent's configuration / auth docs (`AgentInfo.docsUrl`). */
  | { kind: 'openDocs' }
  /** Open the agent's install / download page (`AgentInfo.installUrl`). */
  | { kind: 'openInstall' }
  /** Re-run agent detection (the Settings "Rescan" affordance). */
  | { kind: 'rescan' }
  /**
   * Prompt the user to point Open Design at an explicit binary by writing
   * `envKey` (e.g. `CURSOR_AGENT_BIN`) into `agentCliEnv`. Used when the CLI
   * is installed somewhere PATH detection can't reach.
   */
  | { kind: 'setEnv'; envKey: string }
  /** Clear a previously-set binary override so detection falls back to PATH. */
  | { kind: 'clearEnv'; envKey: string }
  /**
   * Launch the agent's interactive sign-in in a system terminal (today only
   * Antigravity's `agy`, via POST /api/agents/:id/oauth-launch).
   */
  | { kind: 'launchOAuth'; agentId: string };

/**
 * Why a CLI agent is unavailable or only partially usable, in a shape the UI
 * can render as "one-line reason + fix button(s)" instead of a silent grey
 * card. Emitted by daemon detection (PATH / executable resolution + the auth
 * probe) and reused by the connection-test / health-check surfaces so a
 * failure is always actionable.
 */
export type AgentDiagnosticReason =
  /** The binary (and any fallback names) was not found on PATH. */
  | 'not-on-path'
  /** A file matched but is not executable (missing +x / wrong PATHEXT). */
  | 'not-executable'
  /** A wrapper/shim was found but its target is gone (exit 126/127). */
  | 'shim-broken'
  /** A user-set `*_BIN` override points at a missing/invalid file. */
  | 'configured-bin-invalid'
  | 'version-probe-failed'
  | 'untested-version'
  | 'runtime-profile-incompatible'
  /** Installed and invocable, but the CLI is not authenticated. */
  | 'auth-missing'
  /** Installed, but auth status could not be verified. */
  | 'auth-unknown';

export type AgentDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface AgentDiagnostic {
  reason: AgentDiagnosticReason;
  severity: AgentDiagnosticSeverity;
  /** Short, human-readable, single-sentence explanation. */
  message: string;
  /** Optional longer context (e.g. the probe's stderr tail). */
  detail?: string;
  /**
   * Directories PATH detection searched, surfaced verbatim for the
   * `not-on-path` case so the user can see where we looked before being
   * asked to set an explicit binary path. Sourced from the daemon resolver,
   * never recomputed in the client.
   */
  searchedDirs?: string[];
  /** Ordered fix affordances the UI should offer for this diagnostic. */
  fixActions?: AgentFixIntent[];
}

export interface AgentInfo {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  path?: string;
  version?: string | null;
  /**
   * Actionable reasons this agent is unavailable or only partially usable,
   * each carrying typed fix intents. Empty / omitted means "healthy"
   * (available and, where probed, authenticated).
   */
  diagnostics?: AgentDiagnostic[];
  models?: AgentModelOption[];
  /** Whether models came from the installed CLI or Open Design's static fallback. */
  modelsSource?: 'live' | 'fallback';
  reasoningOptions?: AgentModelOption[];
  /** HTTPS URL to install or download the CLI (vendor docs, GitHub README, npm). */
  installUrl?: string;
  /** Optional HTTPS URL for configuration / auth / usage docs. */
  docsUrl?: string;
  /**
   * How the daemon forwards the user's `.od/mcp-config.json` external MCP
   * servers to this runtime at spawn time. Mirrors the field on
   * `RuntimeAgentDef` in the daemon. Undefined means the runtime has no
   * native MCP transport wired yet, in which case the settings UI surfaces
   * a "configure MCP in the agent's own config file" hint instead of
   * silently dropping the servers (issue #2142).
   */
  externalMcpInjection?:
    | 'claude-mcp-json'
    | 'acp-merge'
    | 'opencode-env-content'
    | 'mimo-env-content';
  /**
   * When `false`, the Settings model picker hides the "Custom (fill below)"
   * option and the free-text input. Use this for agents whose CLI doesn't
   * accept a model id (e.g. Antigravity `agy` has no `--model` flag yet —
   * upstream issue #35) or rejects free-form ids (AMR validates against the
   * live Vela catalog). Undefined === allow, matching the historical UX.
   */
  supportsCustomModel?: boolean;
}

export type AmrModelsSource = 'preset' | 'remote';

export interface AmrModelsResponse {
  source: AmrModelsSource;
  models: AgentModelOption[];
  refreshing: boolean;
  stale?: boolean;
  remoteError?: string;
}

export type SkillSource = 'built-in' | 'user';

export interface SkillSummary {
  id: string;
  name: string;
  displayName?: Record<string, string>;
  description: string;
  descriptionI18n?: Record<string, string>;
  triggers: string[];
  mode:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'image'
    | 'video'
    | 'audio';
  surface?: 'web' | 'image' | 'video' | 'audio';
  platform?: 'desktop' | 'mobile' | null;
  scenario?: string | null;
  // Optional human-readable category (e.g. "image-generation", "video").
  // Surfaced as a filter pill in Settings → Skills so a
  // large pre-loaded catalogue stays scannable. Free-form lowercase slug;
  // not part of system-prompt composition.
  category?: string | null;
  // Origin of the skill: 'built-in' lives under the repo's `skills/`
  // directory and cannot be deleted from the UI; 'user' lives under
  // `<runtimeData>/user-skills/` and is fully owned by the user (delete
  // / re-import allowed). New `import` endpoint always tags `user`.
  source?: SkillSource;
  previewType: string;
  defaultFor: string[];
  upstream: string | null;
  featured?: number | null;
  fidelity?: 'wireframe' | 'high-fidelity' | null;
  speakerNotes?: boolean | null;
  animations?: boolean | null;
  hasBody: boolean;
  examplePrompt: string;
  examplePromptI18n?: Record<string, string>;
  // True when this skill exists only to group derived `<parent>:<child>`
  // example cards. The Examples gallery hides such cards because their
  // preview would duplicate one of the derived cards and add no extra
  // information, but the entry stays in the listing so `findSkillById`
  // resolves the parent for system-prompt composition and "Use this
  // prompt" fast-create on a derived card still composes the parent's
  // SKILL.md body.
  aggregatesExamples: boolean;
}

// Returned by GET /api/skills/:id/files — the on-disk file tree under
// the skill's directory, capped to a small number of entries to keep
// the payload bounded. Used by the Settings → Skills detail panel.
export interface SkillFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

export interface HealthResponse {
  ok: true;
  service?: 'daemon';
  version?: string;
}

export type InstallInput =
  | { source: 'github'; url: string }
  | { source: 'local'; path: string };

export interface InstallSkillResponse {
  skill: SkillSummary;
}

export interface UninstallResponse {
  ok: true;
}
