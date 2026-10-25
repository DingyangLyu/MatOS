import type { ExecFileOptions } from 'node:child_process';
import type { AgentDiagnostic } from '@open-design/contracts';

export type { AgentDiagnostic } from '@open-design/contracts';

export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string>;

export type RuntimeModelOption = {
  id: string;
  label: string;
  default?: boolean;
  reasoningOptions?: RuntimeModelOption[];
};

export type RuntimeModelSource = 'live' | 'fallback';

export type RuntimeReasoningOption = RuntimeModelOption;

export type RuntimeBuildOptions = {
  model?: string | null;
  reasoning?: string | null;
};

export type RuntimeContext = {
  cwd?: string;
  // Resume-capable adapters (resumesSessionViaCli) read these to decide
  // whether to continue the CLI's own session. `resumeSessionId` is the
  // stored id for this (conversation, agent) when a prior session exists;
  // the adapter passes it to the CLI's resume flag and the daemon sends
  // only the latest user turn. When it is null/absent the adapter starts
  // a new session using `newSessionId` (a freshly minted UUID the daemon
  // also persists) and the daemon seeds it with the full transcript.
  resumeSessionId?: string | null;
  newSessionId?: string;
  // The run's conversation session mode ('design' | 'chat' | 'plan').
  // Today only the matos adapter reads it: MatOS repurposes the three
  // modes as execution tiers. chat/plan bind the read-only `plan`
  // permission mode plus a cheaper reasoning-effort default (an explicit
  // reasoning pick still wins on effort), while design keeps the product
  // default bypassPermissions execution profile. Read-only `plan` and
  // approval-free `bypassPermissions` are the only headless-safe
  // permission modes — the web chat stream has no interactive approval
  // loop, so `default`/`acceptEdits` would surface as silent tool
  // denials. Adapters that only use sessionMode through the composed
  // system prompt ignore this field.
  sessionMode?: string;
  // Explicit provider LLM override for adapters whose `options.model`
  // channel is already occupied by a different concept. MatOS uses
  // `options.model` for the role ref (`--role`); this field carries the
  // user's per-conversation LLM pick (`--model <id>`). Validated by the
  // daemon against the model-id pattern before it reaches argv. Adapters
  // without a separate model flag ignore this field.
  providerModel?: string;
  /** Extra system prompt file for the native MatOS host (user global rules). */
  appendSystemPromptFile?: string;
  // Native MatOS asset refs selected in the project UI. Only the MatOS
  // adapter consumes them, as repeatable `--asset` flags; the CLI performs
  // the authoritative scoped-registry resolution.
  assetRefs?: string[];
};

export type RuntimePromptBudgetError = {
  code: 'AGENT_PROMPT_TOO_LARGE';
  message: string;
  bytes?: number;
  commandLineLength?: number;
  limit: number;
};

export type RuntimeVersionPolicy = {
  /** Exact version strings exercised by this OpenDesign build. */
  supportedVersions: string[];
  /**
   * Optional shape of versions this build accepts without having exercised
   * each one. Some agent CLIs ship as a stream of release candidates that
   * moves faster than our releases do, so naming individual ones warns every
   * user who followed our own install instructions the week after we bump
   * them. Matching the line keeps the check meaningful instead of removing
   * it — a version off that line still warns.
   *
   * Must not carry the `g` flag: `RegExp.test` is stateful with it, so the
   * same version would alternate between supported and untested.
   */
  supportedVersionPattern?: RegExp;
  /** Fail closed when the version probe fails or returns no usable version. */
  requireVersion: true;
  /** Normalize and validate the first output line; null means unusable. */
  parse?: (raw: string) => string | null;
};

export type RuntimeCompatibilityProbe = {
  /** Arguments for a side-effect-free runtime/profile handshake. */
  args: string[];
  timeoutMs?: number;
  /** Optional read-only gate used when invoking the probe would create state. */
  preflight?: (env: NodeJS.ProcessEnv) => boolean;
  /** Returns the companion/profile version when the output is compatible. */
  parse: (stdout: string) => string;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  fallbackModels: RuntimeModelOption[];
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];
  streamFormat: string;
  fallbackBins?: string[];
  versionProbeTimeoutMs?: number;
  versionPolicy?: RuntimeVersionPolicy;
  compatibilityProbe?: RuntimeCompatibilityProbe;
  promptViaStdin?: boolean;
  // Format for the user prompt fed via stdin. Default is plain text (the
  // entire prompt buffer goes in raw, then stdin is closed). When set to
  // 'stream-json' the daemon writes a single JSONL line wrapping the prompt
  // as an Anthropic user message (so tool_result blocks can later be
  // injected into the same stdin without re-spawning the child). Only
  // honored for adapters that also set `promptViaStdin: true`.
  promptInputFormat?: 'text' | 'stream-json';
  env?: Record<string, string>;
  reasoningOptions?: RuntimeReasoningOption[];
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;
  mcpDiscovery?: string;
  // MatOS auto-loads `.mcp.json` from the managed project cwd, so the daemon
  // writes the user's external MCP servers there before spawn.
  externalMcpInjection?: 'claude-mcp-json';
  installUrl?: string;
  docsUrl?: string;
  supportsCustomModel?: boolean;
  // When `true`, the daemon trusts this adapter's CLI to carry its own
  // multi-turn conversation memory across spawn invocations. The chat composer
  // skips the rendered web transcript on follow-up turns and sends just the
  // latest user message.
  resumesSessionViaCli?: boolean;
  // Agent-recommended override for the chat-run inactivity watchdog.
  // The watchdog observes child stdout/stderr/SSE activity, not real
  // CPU progress, so a runtime whose tools legitimately go silent for long
  // stretches needs a longer ceiling than the 10-minute global default.
  // Operators can still override per-process via
  // `OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS` — that env wins.
  inactivityTimeoutMs?: number;
  // Declarative authentication probe. When set, detection spawns
  // `<bin> <args>` after the version check and classifies the combined
  // stdout/stderr to derive `authStatus`. Adapters WITHOUT this field are
  // never actively probed for auth — their auth status is only inferred later
  // from a real chat failure's error text (see classifyAgentServiceFailure).
  authProbe?: {
    args: string[];
    timeoutMs?: number;
  };
};

export type DetectedAgent = Omit<
  RuntimeAgentDef,
  | 'buildArgs'
  | 'fallbackModels'
  | 'fallbackBins'
  | 'versionProbeTimeoutMs'
  | 'versionPolicy'
  | 'compatibilityProbe'
  | 'maxPromptArgBytes'
  | 'env'
  // `inactivityTimeoutMs` is a spawn-time-only hint consumed by the
  // chat-run watchdog. It is not part of the public `/api/agents`
  // contract (`packages/contracts/src/api/registry.ts#AgentInfo`), so
  // omitting it here keeps the daemon response aligned with that
  // shared web/CLI shape — agents pick it up by reading the runtime
  // def directly, the registry payload stays unchanged.
  | 'inactivityTimeoutMs'
  | 'authProbe'
> & {
  models: RuntimeModelOption[];
  modelsSource: RuntimeModelSource;
  available: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  path?: string;
  version?: string | null;
  diagnostics?: AgentDiagnostic[];
};

export type RuntimeExecOptions = ExecFileOptions & {
  env?: NodeJS.ProcessEnv;
};

export function runtimeResumesSessionById(
  def: Pick<RuntimeAgentDef, 'resumesSessionViaCli'>,
): boolean {
  return def.resumesSessionViaCli === true;
}
