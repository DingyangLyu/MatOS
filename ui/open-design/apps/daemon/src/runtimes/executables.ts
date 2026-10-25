import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { wellKnownUserToolchainBins } from '@open-design/platform';
import { resolveSandboxRuntimeConfigFromEnv } from '../sandbox-mode.js';
import { expandHomePath } from './paths.js';
import type { RuntimeAgentDef } from './types.js';

const RUNTIME_PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

const AGENT_BIN_ENV_KEYS = new Map<string, string>([
  ['matos', 'MATOS_BIN'],
]);

const TOOLCHAIN_DIR_CACHE_TTL_MS = 5000;
let cachedToolchainHome: string | null = null;
let cachedToolchainDirs: string[] | null = null;
let cachedToolchainDirsAt = 0;

// Resolve the home directory detection should search, honoring the sandbox /
// `OD_AGENT_HOME` override. `hasOverride` lets callers scope strictly to the
// override home (skipping real-machine system locations) so sandboxed
// detection runs and tests stay deterministic instead of reaching the host.
function resolveDetectionHome(): { home: string; hasOverride: boolean } {
  const sandboxRuntime = resolveSandboxRuntimeConfigFromEnv(
    process.env,
    RUNTIME_PROJECT_ROOT,
  );
  const homeOverride =
    sandboxRuntime?.roots.agentHomeDir ?? process.env.OD_AGENT_HOME;
  return { home: homeOverride || homedir(), hasOverride: Boolean(homeOverride) };
}

function userToolchainDirs() {
  const { home, hasOverride } = resolveDetectionHome();
  const homeOverride = hasOverride ? home : undefined;
  const now = Date.now();
  if (
    cachedToolchainHome === home &&
    cachedToolchainDirs &&
    now - cachedToolchainDirsAt < TOOLCHAIN_DIR_CACHE_TTL_MS
  ) {
    return cachedToolchainDirs;
  }
  cachedToolchainHome = home;
  cachedToolchainDirsAt = now;
  // When OD_AGENT_HOME is set, scope the search strictly to the override
  // home: skip Homebrew / /usr/local *and* pass an empty env so that a
  // developer or CI runner with NPM_CONFIG_PREFIX / npm_config_prefix
  // exported can't leak the real machine's <prefix>/bin into a sandboxed
  // detection run. Without this the agents.test.ts cases that build a
  // tmp home would be machine-environment-dependent.
  cachedToolchainDirs = wellKnownUserToolchainBins({
    home,
    includeSystemBins: process.platform !== 'win32' && !homeOverride,
    env: homeOverride ? {} : process.env,
  });
  return cachedToolchainDirs;
}

// The user-level toolchain bin directories (Homebrew, ~/.local/bin, ~/.bun/bin,
// version-manager node dirs, npm prefixes, …) that binary *resolution* searches
// beyond process.env.PATH. Exposed so the spawn env can append the same dirs:
// a binary can resolve here yet fail to *execute* if its shebang interpreter
// (e.g. `#!/usr/bin/env bun`) lives in one of these dirs and the spawn PATH
// doesn't include it. Keeping resolution and spawn PATH symmetric fixes that.
export function userToolchainBinDirs(): string[] {
  return userToolchainDirs();
}

function resolvePathDirs() {
  const seen = new Set();
  const dirs = [
    ...(process.env.PATH || '').split(delimiter),
    // GUI launchers (macOS .app bundles, Linux .desktop files) often start
    // with a minimal PATH. Include common user-level CLI install locations
    // so agent detection matches the user's shell-installed tools,
    // especially Node version managers.
    ...userToolchainDirs(),
  ];
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

// The exact, de-duplicated directory list `resolveOnPath` walks. Surfaced so
// detection can attach it to a `not-on-path` diagnostic verbatim — the UI
// shows the user where we actually looked before asking them to set an
// explicit binary path, instead of recomputing PATH client-side.
export function agentSearchDirs(): string[] {
  return resolvePathDirs();
}

// The `*_BIN` environment variable that overrides PATH detection for a given
// agent id (e.g. `matos` → `MATOS_BIN`), or null when the agent has no
// override key. Drives the `setEnv` / `clearEnv` fix intents.
export function agentBinEnvKey(agentId: string | undefined): string | null {
  if (!agentId) return null;
  return AGENT_BIN_ENV_KEYS.get(agentId) ?? null;
}

export function resolveOnPath(bin: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : [''];
  const dirs = resolvePathDirs();
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (full && existsSync(full)) return full;
    }
  }
  return null;
}

function looksExecutableOnWindows(filePath: string): boolean {
  const ext = path.extname(filePath).trim().toUpperCase();
  if (!ext) return false;
  const executableExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return executableExts.includes(ext);
}

function executableFilePath(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const expanded = expandHomePath(raw.trim());
  if (!path.isAbsolute(expanded)) return null;
  try {
    if (!statSync(expanded).isFile()) return null;
    if (process.platform === 'win32') {
      if (!looksExecutableOnWindows(expanded)) return null;
    } else {
      accessSync(expanded, constants.X_OK);
    }
    return expanded;
  } catch {
    return null;
  }
}

// Resolve the first available binary for an agent definition. Tries
// `def.bin` first, then walks `def.fallbackBins` in order. Used for runtimes
// whose forks ship under a different binary name but speak the exact same CLI.
// Returns null when no candidate is on PATH.
function configuredExecutableOverride(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): string | null {
  const envKey = AGENT_BIN_ENV_KEYS.get(def?.id);
  if (!envKey) return null;
  return executableFilePath(
    configuredEnv?.[envKey] ?? undefined,
  );
}


export function resolveAgentExecutable(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): string | null {
  return inspectAgentExecutableResolution(def, configuredEnv).selectedPath;
}

export function inspectAgentExecutableResolution(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): {
  configuredOverridePath: string | null;
  pathResolvedPath: string | null;
  selectedPath: string | null;
} {
  if (!def?.bin) {
    return {
      configuredOverridePath: null,
      pathResolvedPath: null,
      selectedPath: null,
    };
  }
  const configuredOverridePath = configuredExecutableOverride(def, configuredEnv);
  const candidates = [
    def.bin,
    ...(Array.isArray(def.fallbackBins) ? def.fallbackBins : []),
  ];
  let pathResolvedPath: string | null = null;
  for (const bin of candidates) {
    const resolved = resolveOnPath(bin);
    if (resolved) {
      pathResolvedPath = resolved;
      break;
    }
  }
  return {
    configuredOverridePath,
    pathResolvedPath,
    selectedPath:
      configuredOverridePath || pathResolvedPath,
  };
}
