// Result categories surfaced by the connection-test endpoint. The web UI
// translates each kind into user-facing copy; the daemon picks one per test
// and returns it inside a JSON envelope (always HTTP 200 — see notes in the
// daemon module for why).
import type { AgentCliEnvPrefs } from './app-config';

export type ConnectionTestKind =
  | 'success'
  | 'not_found_model'
  | 'invalid_model_id'
  | 'timeout'
  | 'agent_not_installed'
  | 'agent_auth_required'
  | 'agent_spawn_failed'
  | 'unknown';

// Phase markers describing how far the local agent connection test
// progressed before it produced its result. Used inside
// `ConnectionTestResponse.diagnostics.phase` and intended to be stable
// across daemon versions so Settings UI and CLI consumers can render
// phase-aware copy without re-deriving it from the free-form `detail`
// string. See issue #2248.
export type ConnectionTestPhase =
  | 'binary_resolution'
  | 'version_probe'
  | 'model_list'
  | 'spawn'
  | 'connection_smoke_test'
  | 'output_parse';

export interface ConnectionTestDiagnostics {
  // How far the test progressed before producing its result. Always
  // set on local agent test responses.
  phase: ConnectionTestPhase;
  // Absolute filesystem path of the executable the daemon actually
  // attempted to run, when resolution succeeded.
  binaryPath?: string;
  // Best-effort version string captured during `version_probe`. Null
  // when the CLI exposes no machine-parseable version output.
  binaryVersion?: string | null;
  // Child process exit metadata. Both fields keep the raw `code` /
  // `signal` shape from `child_process` so consumers can distinguish
  // a clean non-zero exit from a SIGTERM teardown. `signal` is typed as
  // `string | null` (not `NodeJS.Signals`) so the generated `.d.ts`
  // stays browser-safe — the daemon writes one of the
  // `NodeJS.Signals` literals here but consumers never need to import
  // ambient Node namespaces just to read an HTTP response shape.
  exitCode?: number | null;
  signal?: string | null;
  // Last ~400 bytes of the child's streams, already passed through
  // the daemon's secret redactor.
  stdoutTail?: string;
  stderrTail?: string;
}

export interface AgentTestRequest {
  agentId: string;
  model?: string;
  reasoning?: string;
  agentCliEnv?: AgentCliEnvPrefs;
}

export interface ConnectionTestResponse {
  ok: boolean;
  kind: ConnectionTestKind;
  latencyMs: number;
  // Model id or CLI default slot that this test exercised.
  model?: string;
  // Truncated assistant reply (≤ 120 chars) on success.
  sample?: string;
  // Display name of the resolved agent (CLI tests).
  agentName?: string;
  // Free-form, redacted detail line — surfaced in the `unknown`,
  // `agent_spawn_failed`, and `upstream_unavailable` copy.
  detail?: string;
  // Optional executable-path diagnostics for Local CLI tests. Used by
  // Settings to explain whether a saved custom path worked, was ignored,
  // or required a PATH fallback.
  configuredExecutablePath?: string;
  detectedExecutablePath?: string;
  usedExecutablePath?: string;
  usedExecutableSource?: 'configured' | 'path' | 'fallback_invalid' | 'fallback_failed';
  // Structured diagnostics for the local agent connection test path
  // (#2248). Optional and additive: existing consumers that only read
  // `kind` and `detail` keep working unchanged. Populated on local
  // agent test responses — including early failures that never reach
  // the spawn step (unknown agent id, unresolved binary, preflight
  // auth probe).
  diagnostics?: ConnectionTestDiagnostics;
}
