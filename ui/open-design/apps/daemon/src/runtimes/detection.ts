import { execAgentFile } from './invocation.js';
import { AGENT_DEFS } from './registry.js';
import {
  DEFAULT_MODEL_OPTION,
  rememberLiveModels,
} from './models.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from './launch.js';
import { spawnEnvForAgent } from './env.js';
import { probeAgentAuthStatus } from './auth.js';
import {
  buildAuthDiagnostic,
  buildCompatibilityDiagnostic,
  buildVersionDiagnostic,
  buildExecutableDiagnostic,
  buildNotInvocableDiagnostic,
  type NotInvocableCause,
} from './diagnostics.js';
import type {
  AgentDiagnostic,
  DetectedAgent,
  RuntimeAgentDef,
  RuntimeVersionPolicy,
} from './types.js';

export type DetectAgentsOptions = {
  /**
   * Restrict detection before any executable/version/model/auth probes start.
   * Product surfaces that expose only one runtime must use this instead of
   * probing the full registry and filtering the completed result.
   */
  agentIds?: readonly string[];
};

export function selectAgentDefsForDetection(
  defs: readonly RuntimeAgentDef[],
  options: DetectAgentsOptions = {},
): RuntimeAgentDef[] {
  const requested = options.agentIds;
  if (!requested || requested.length === 0) return [...defs];
  const ids = new Set(requested);
  return defs.filter((def) => ids.has(def.id));
}

function configuredEnvForAgent(
  configuredEnvByAgent: Record<string, Record<string, string>>,
  agentId: string,
): Record<string, string> {
  return configuredEnvByAgent?.[agentId] ?? {};
}

type VersionProbeOutcome =
  | { kind: 'not-invocable'; cause: NotInvocableCause }
  | { kind: 'spawned'; version: string | null };

/**
 * Run the agent's `--version` probe and classify the result. The probe
 * has two distinct failure modes the catch arm has to discriminate:
 *
 *   - **Not invocable.** The OS rejected the spawn outright, OR the
 *     wrapper script spawned but its underlying interpreter / target
 *     failed. We split permission failures (EACCES / exit 126) from
 *     missing-target failures (ENOENT / ENOTDIR / exit 127) so Settings can
 *     offer permission-specific copy instead of treating every failure as a
 *     broken shim. We still mark the agent unavailable so Settings does not
 *     advertise a ghost entry (issue #658, lefarcen review P2 on PR #1301).
 *
 *   - **Spawned but `--version` was unhappy.** The binary itself ran
 *     (any other rejection: timeout, generic non-zero exit, stderr
 *     noise) so the CLI is invocable; we just can't read a version
 *     string. Adapters whose `--version` flag is unsupported land
 *     here and must keep working with `version: null`.
 *
 * `child_process.execFile` reports OS-level rejections with a string
 * `err.code` (`'ENOENT'`, `'EACCES'`, `'ENOTDIR'`) and non-zero exit
 * codes with a *numeric* `err.code` equal to the exit status, so the
 * two arms below are unambiguous.
 */
async function probeVersionAtPath(
  def: RuntimeAgentDef,
  resolved: string,
  env: NodeJS.ProcessEnv,
): Promise<VersionProbeOutcome> {
  try {
    const { stdout } = await execAgentFile(resolved, def.versionArgs, {
      env,
      timeout: def.versionProbeTimeoutMs ?? 3000,
    });
    const rawVersion = String(stdout).trim().split('\n')[0]?.trim() || null;
    const version = rawVersion && def.versionPolicy?.parse
      ? def.versionPolicy.parse(rawVersion)
      : rawVersion;
    return { kind: 'spawned', version };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string') {
      if (code === 'EACCES') {
        return { kind: 'not-invocable', cause: 'not-executable' };
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'not-invocable', cause: 'missing-target' };
      }
    } else if (typeof code === 'number' && (code === 126 || code === 127)) {
      return {
        kind: 'not-invocable',
        cause: code === 126 ? 'not-executable' : 'missing-target',
      };
    }
    return { kind: 'spawned', version: null };
  }
}

function unavailableAgent(
  def: RuntimeAgentDef,
  diagnostics: AgentDiagnostic[] = [],
  detected?: { path?: string; version?: string | null },
): DetectedAgent {
  return {
    ...stripFns(def),
    models: def.fallbackModels ?? [DEFAULT_MODEL_OPTION],
    modelsSource: 'fallback',
    available: false,
    ...(detected?.path ? { path: detected.path } : {}),
    ...(detected && 'version' in detected ? { version: detected.version ?? null } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

async function probe(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): Promise<DetectedAgent> {
  // Detection must probe the exact path the runtime will spawn, not just the
  // PATH-visible shim. The resolved launch path is what chat/run actually
  // spawns, so probing it keeps detection honest about availability.
  const launch = resolveAgentLaunch(def, configuredEnv);
  if (!launch.selectedPath || !launch.launchPath) {
    return unavailableAgent(def, [buildExecutableDiagnostic(def, configuredEnv)]);
  }
  const probeEnv = applyAgentLaunchEnv(
    spawnEnvForAgent(
      def.id,
      {
        ...process.env,
        ...(def.env || {}),
      },
      configuredEnv,
      undefined,
      { resolvedBin: launch.selectedPath },
    ),
    launch,
  );
  const outcome = await probeVersionAtPath(def, launch.launchPath, probeEnv);
  if (outcome.kind === 'not-invocable') {
    return unavailableAgent(def, [
      buildNotInvocableDiagnostic(def, launch, outcome.cause),
    ]);
  }
  if (def.versionPolicy?.requireVersion && !outcome.version) {
    return unavailableAgent(def, [buildVersionDiagnostic(def, outcome.version)], {
      path: launch.selectedPath,
      version: outcome.version,
    });
  }
  if (def.compatibilityProbe) {
    try {
      if (def.compatibilityProbe.preflight && !def.compatibilityProbe.preflight(probeEnv)) {
        return unavailableAgent(def, [buildCompatibilityDiagnostic(def)], {
          path: launch.selectedPath,
          version: outcome.version,
        });
      }
      const { stdout } = await execAgentFile(
        launch.launchPath,
        def.compatibilityProbe.args,
        {
          env: probeEnv,
          timeout: def.compatibilityProbe.timeoutMs ?? 5000,
          maxBuffer: 1024 * 1024,
        },
      );
      def.compatibilityProbe.parse(String(stdout));
    } catch {
      return unavailableAgent(def, [buildCompatibilityDiagnostic(def)], {
        path: launch.selectedPath,
        version: outcome.version,
      });
    }
  }
  const versionDiagnostic =
    def.versionPolicy &&
    outcome.version &&
    !versionIsSupported(def.versionPolicy, outcome.version)
      ? buildVersionDiagnostic(def, outcome.version)
      : null;
  // The version probe must finish first (it gates availability); auth is the
  // remaining independent read.
  const auth = await probeAgentAuthStatus(def, launch.launchPath, probeEnv);
  const authDiagnostic = auth ? buildAuthDiagnostic(def, auth) : null;
  return {
    ...stripFns(def),
    models: def.fallbackModels ?? [DEFAULT_MODEL_OPTION],
    modelsSource: 'fallback',
    available: true,
    path: launch.selectedPath,
    version: outcome.version,
    ...(auth
      ? {
          authStatus: auth.status,
          ...(auth.message ? { authMessage: auth.message } : {}),
        }
      : {}),
    ...([versionDiagnostic, authDiagnostic].some(Boolean)
      ? { diagnostics: [versionDiagnostic, authDiagnostic].filter((item): item is AgentDiagnostic => item !== null) }
      : {}),
  };
}

function stripFns(
  def: RuntimeAgentDef,
): Omit<DetectedAgent, 'models' | 'modelsSource' | 'available' | 'path' | 'version'> {
  // Drop the buildArgs closure but keep declarative metadata
  // (reasoningOptions, streamFormat, name, bin, etc.). `models` is
  // applied below, so we strip the static `fallbackModels` slot here too.
  // `fallbackBins` / `maxPromptArgBytes` / `env` are probe-or-spawn-only
  // metadata and shouldn't bleed into the API response either.
  // `inactivityTimeoutMs` is a spawn-time hint for the chat-run watchdog
  // and is not part of the public AgentInfo contract — strip it here so
  // the runtime registry stays the only consumer.
  const {
    buildArgs,
    fallbackModels,
    fallbackBins,
    versionProbeTimeoutMs,
    versionPolicy,
    compatibilityProbe,
    maxPromptArgBytes,
    env,
    inactivityTimeoutMs,
    authProbe,
    ...rest
  } = def;
  return rest;
}

async function safeProbe(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): Promise<DetectedAgent> {
  try {
    return await probe(def, configuredEnv);
  } catch {
    // Fault isolation (issue #2297): one adapter's probe blowing up
    // — e.g. a synchronous filesystem throw during PATH walking on a
    // packaged Windows daemon, or an async rejection from one of the
    // post-launch probes — must not collapse the whole agent picker.
    // Without this guard the bare `Promise.all` rejected and the
    // `/api/agents` catch arm returned `[]`, so the UI silently lost
    // every CLI option.
    return unavailableAgent(def);
  }
}

function rememberDetectedLiveModels(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
  agent: DetectedAgent,
): void {
  rememberLiveModels(agent.id, agent.models, null);
}

export async function detectAgents(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectAgentsOptions = {},
) {
  const defs = selectAgentDefsForDetection(AGENT_DEFS, options);
  const results = await Promise.all(
    defs.map((def) => safeProbe(def, configuredEnvForAgent(configuredEnvByAgent, def.id))),
  );
  // Refresh the validation cache from whatever we just surfaced to the UI
  // so /api/chat can accept any model the user could have just picked,
  // including ones that only showed up after a CLI re-auth.
  for (const [index, agent] of results.entries()) {
    const def = defs[index];
    if (!def) continue;
    rememberDetectedLiveModels(def, configuredEnvForAgent(configuredEnvByAgent, def.id), agent);
  }
  return results;
}

// Streaming variant: yields each agent the moment its probe settles, in
// completion order rather than registry order, so the UI can paint a card
// as soon as it resolves instead of waiting for the slowest CLI. The model
// validation cache is refreshed per-agent (same effect as the batch path,
// just incrementally). `detectAgents` keeps the array contract for callers
// that don't care about incremental delivery (cache warm, chat).
export async function* detectAgentsStream(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectAgentsOptions = {},
): AsyncGenerator<DetectedAgent> {
  const defs = selectAgentDefsForDetection(AGENT_DEFS, options);
  const tagged = defs.map((def, index) =>
    safeProbe(def, configuredEnvForAgent(configuredEnvByAgent, def.id)).then((agent) => {
      rememberDetectedLiveModels(def, configuredEnvForAgent(configuredEnvByAgent, def.id), agent);
      return { index, agent };
    }),
  );
  const pending = new Set(tagged.keys());
  while (pending.size > 0) {
    const { index, agent } = await Promise.race(
      tagged.filter((_, i) => pending.has(i)),
    );
    pending.delete(index);
    yield agent;
  }
}

function versionIsSupported(policy: RuntimeVersionPolicy, version: string): boolean {
  if (policy.supportedVersions.includes(version)) return true;
  return policy.supportedVersionPattern?.test(version) ?? false;
}
