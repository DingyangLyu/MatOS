import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeProxyAwareEnv, resolveSystemProxyEnv } from '@open-design/platform';
import { resolveProjectRelativePath } from '../home-expansion.js';
import { expandConfiguredEnv } from './paths.js';
import { resolveProjectRootFromNestedModule } from '../project-root.js';
import {
  applySandboxRuntimeEnv,
  isSandboxModeEnabled,
  resolveSandboxRuntimeConfig,
  type SandboxRuntimeConfig,
} from '../sandbox-mode.js';

type RuntimeEnvMap = NodeJS.ProcessEnv | Record<string, string>;
type SpawnEnvOptions = {
  resolvedBin?: string | null;
};

const RUNTIME_MODULE_PROJECT_ROOT = resolveProjectRootFromNestedModule(
  path.dirname(fileURLToPath(import.meta.url)),
);

function workspaceRuntimeBaseEnv(baseEnv: RuntimeEnvMap): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const runtimePath = env.MATOS_WORKSPACE_RUNTIME_PATH?.trim();
  if (runtimePath) {
    // The workspace entrypoint deliberately keeps Conda/compute tools out of
    // the OpenVSCode control-plane PATH, while preserving the intended agent
    // PATH here. Restore it only for spawned agent jobs so stdio MCP commands
    // such as `uvx mcp-science ...` can resolve without destabilizing the IDE
    // or daemon process itself. Explicit configuredEnv.PATH still wins below.
    env.PATH = runtimePath;
  }
  return env;
}


export function spawnEnvForAgent(
  agentId: string,
  baseEnv: RuntimeEnvMap,
  configuredEnv: unknown = {},
  systemProxyEnv: RuntimeEnvMap = resolveSystemProxyEnv(),
  _options: SpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const sandboxRuntime = sandboxRuntimeConfigForBaseEnv(baseEnv);
  const expandedConfiguredEnv = expandConfiguredEnv(configuredEnv);
  const env = mergeProxyAwareEnv(
    process.platform,
    systemProxyEnv,
    workspaceRuntimeBaseEnv(baseEnv),
    expandedConfiguredEnv,
  );
  if (agentId === 'matos') {
    // The daemon itself may be running inside a MatOS workspace (started by a
    // parent `matos` run or the user daemon), so its own environment can
    // carry that parent run's trace/session variables. Left in place they
    // would leak into every OD chat turn: MATOS_SESSION_ID would pin ALL
    // turns' MatOS event recorders onto one wrong session JSONL, and stale
    // trace/turn ids would corrupt the per-conversation identity that
    // openDesignMatOSTraceEnv layers on afterwards (it is spread later in
    // the spawn env assembly, so its explicit values win over anything here).
    stripKeysCaseInsensitive(env, [
      'MATOS_SESSION_ID',
      'MATOS_TRACE_ID',
      'MATOS_PARENT_SESSION_ID',
      'MATOS_TURN_ID',
    ]);
    return reapplySandboxRuntimeEnv(env, sandboxRuntime);
  }
  return reapplySandboxRuntimeEnv(env, sandboxRuntime);
}

// MatOS trace-context inheritance for daemon-spawned `matos` runs: MatOS CLI
// commands inherit trace context through MATOS_TRACE_ID /
// MATOS_PARENT_SESSION_ID. Without this, every OD chat
// turn's MatOS session mints an isolated traceId equal to its own session
// id, so multi-turn OD conversations (and resume-invalidation session
// rebuilds) cannot be stitched into one trace on the MatOS side.
//
// Identity mapping:
//   MATOS_TRACE_ID         od-chat-<conversationId>   stable per OD chat, so
//                          every turn/resume of one conversation shares one
//                          trace; runs outside a conversation fall back to
//                          od-run-<runId>.
//   MATOS_PARENT_SESSION_ID od-conversation-<id>      names the OD
//                          conversation as the parent container of the
//                          MatOS session.
//   MATOS_PROJECT_ID       OD project id -> MatOS workspaceId, so per-user
//                          trace queries can group by OD project.
// MATOS_TURN_ID / MATOS_EXECUTION are deliberately not set: the MatOS run
// entrypoint owns per-turn ids and passes execution through recorder
// metadata, which takes precedence over env anyway.
export function openDesignMatOSTraceEnv(input: {
  agentId: string;
  runId: string;
  conversationId?: string | null;
  projectId?: string | null;
}): NodeJS.ProcessEnv {
  if (input.agentId !== 'matos') return {};

  const runId = input.runId.trim();
  if (!runId) {
    throw new Error('MATOS_TRACE_ID requires a non-empty run id for matos runs');
  }
  const conversationId = input.conversationId?.trim();
  const projectId = input.projectId?.trim();
  return {
    MATOS_TRACE_ID: conversationId ? `od-chat-${conversationId}` : `od-run-${runId}`,
    ...(conversationId
      ? { MATOS_PARENT_SESSION_ID: `od-conversation-${conversationId}` }
      : {}),
    ...(projectId ? { MATOS_PROJECT_ID: projectId } : {}),
  };
}

function sandboxRuntimeConfigForBaseEnv(
  baseEnv: RuntimeEnvMap,
): SandboxRuntimeConfig | null {
  if (!isSandboxModeEnabled(baseEnv)) return null;
  const dataDir = baseEnv.OD_DATA_DIR?.trim();
  if (!dataDir) return null;
  const resolvedDataDir = resolveProjectRelativePath(
    dataDir,
    RUNTIME_MODULE_PROJECT_ROOT,
  );
  return resolveSandboxRuntimeConfig(true, resolvedDataDir);
}

function reapplySandboxRuntimeEnv(
  env: NodeJS.ProcessEnv,
  sandboxRuntime: SandboxRuntimeConfig | null,
): NodeJS.ProcessEnv {
  if (!sandboxRuntime) return env;
  return applySandboxRuntimeEnv(env, sandboxRuntime);
}

function stripKeysCaseInsensitive(
  env: NodeJS.ProcessEnv,
  keysToStrip: readonly string[],
): void {
  const keysUpper = new Set(keysToStrip.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (keysUpper.has(key.toUpperCase())) delete env[key];
  }
}
