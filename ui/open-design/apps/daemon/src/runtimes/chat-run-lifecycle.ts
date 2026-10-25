const DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function assertValidRuntimeDefInactivityTimeoutMs(agentDefault?: number): void {
  if (agentDefault === undefined) return;
  if (!Number.isFinite(agentDefault) || agentDefault < 0 || !Number.isInteger(agentDefault)) {
    throw new RangeError(
      `RuntimeAgentDef.inactivityTimeoutMs must be a non-negative integer, got ${String(agentDefault)}. ` +
        'Fix the runtime def — invalid values used to silently disable the watchdog.',
    );
  }
}

export function resolveChatRunInactivityTimeoutMs(agentDefault?: number) {
  assertValidRuntimeDefInactivityTimeoutMs(agentDefault);
  const env = Number(process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  if (Number.isFinite(env)) {
    return Math.min(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS, Math.max(0, Math.floor(env)));
  }
  if (agentDefault !== undefined) {
    return Math.min(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS, agentDefault);
  }
  return DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
}

export function classifyChatRunCloseStatus(params: {
  cancelRequested: boolean;
  code: number | null;
  signal: NodeJS.Signals | string | null;
  turnCompletedCleanly: boolean;
  artifactProducedThisRun: boolean;
}): 'canceled' | 'succeeded' | 'failed' {
  if (params.cancelRequested) return 'canceled';
  if (params.code === 0) return 'succeeded';
  if (params.code != null && params.code !== 0 && params.artifactProducedThisRun) {
    return 'succeeded';
  }
  if (params.turnCompletedCleanly) return 'succeeded';
  return 'failed';
}

type ClaudeStreamJsonBookkeepingRun = {
  stdinOpen?: boolean;
  turnCompletedCleanly?: boolean;
  child?: {
    stdin?: {
      destroyed?: boolean;
      end: () => void;
    } | null;
  } | null;
};

export function applyClaudeStreamJsonRunBookkeeping(
  run: ClaudeStreamJsonBookkeepingRun,
  ev: unknown,
) {
  if (!ev || typeof ev !== 'object') return;
  const event = ev as {
    type?: unknown;
    name?: unknown;
    id?: unknown;
    stopReason?: unknown;
  };

  const cleanTerminalTurn =
    (event.type === 'turn_end' && event.stopReason !== 'tool_use') ||
    (event.type === 'usage' && event.stopReason !== 'tool_use');
  if (!cleanTerminalTurn) return;

  run.turnCompletedCleanly = true;
  if (run.stdinOpen) {
    if (run.child?.stdin && !run.child.stdin.destroyed) {
      try { run.child.stdin.end(); } catch {}
    }
    run.stdinOpen = false;
  }
}

export function resolveChatRunShutdownGraceMs() {
  const raw = Number(process.env.OD_CHAT_RUN_SHUTDOWN_GRACE_MS);
  if (!Number.isFinite(raw)) return 3_000;
  return Math.max(0, Math.floor(raw));
}
