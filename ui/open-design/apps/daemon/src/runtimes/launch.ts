import path, { delimiter } from 'node:path';
import { inspectAgentExecutableResolution, userToolchainBinDirs } from './executables.js';
import type { RuntimeAgentDef } from './types.js';

export type AgentLaunchKind = 'selected';

export type AgentLaunchResolution = ReturnType<typeof inspectAgentExecutableResolution> & {
  launchPath: string | null;
  launchKind: AgentLaunchKind;
  childPathPrepend: string[];
  diagnostic: string | null;
};

export function resolveAgentLaunch(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): AgentLaunchResolution {
  const resolution = inspectAgentExecutableResolution(def, configuredEnv);
  if (!resolution.selectedPath) {
    return { ...resolution, launchPath: null, launchKind: 'selected', childPathPrepend: [], diagnostic: null };
  }
  const childPathPrepend = path.isAbsolute(resolution.selectedPath)
    ? [path.dirname(resolution.selectedPath)]
    : [];
  return { ...resolution, launchPath: resolution.selectedPath, launchKind: 'selected', childPathPrepend, diagnostic: null };
}

export function applyAgentLaunchEnv(
  env: NodeJS.ProcessEnv,
  launch: Pick<AgentLaunchResolution, 'childPathPrepend'>,
  nodeBinDir: string = path.dirname(process.execPath),
  appendPathDirs: string[] = userToolchainBinDirs(),
): NodeJS.ProcessEnv {
  // Build the ordered list of directories to guarantee are at the front of
  // PATH: the running Node binary directory first (so npm .cmd shims on
  // Windows that invoke bare "node" find the correct binary even when the
  // daemon was GUI-launched without a nodejs entry on PATH), then the agent
  // wrapper/shim directory. Using process.execPath as the default means
  // every call site — detectAgents, connection tests, and chat runs —
  // consistently reaches the correct Node binary without each caller having
  // to duplicate the dirname(process.execPath) prepend independently.
  //
  // `appendPathDirs` adds the user toolchain bin dirs (Homebrew, ~/.bun/bin,
  // version-manager dirs, …) to the END of PATH so a resolved binary's shebang
  // interpreter is findable at spawn time even when the daemon's own PATH is
  // minimal (GUI launch). Without this, a `#!/usr/bin/env bun` wrapper can
  // resolve but fail to spawn with exit 127 ("env: bun: No such file or
  // directory"). Defaults to the real toolchain dirs; tests pass [] for
  // determinism.
  const toPrepend = [...(nodeBinDir ? [nodeBinDir] : []), ...launch.childPathPrepend];
  if (toPrepend.length === 0 && appendPathDirs.length === 0) return env;
  // Case-insensitive key lookup — Windows uses 'Path', not 'PATH'.
  // Using env.PATH directly would be undefined on Windows, yielding a
  // one-entry PATH that contains only toPrepend and discards all system
  // paths.  Find the actual key name so we update in place rather than
  // adding a conflicting duplicate key.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const existing = typeof env[pathKey] === 'string' ? (env[pathKey] as string) : '';
  const normalize = (p: string) => {
    const trimmed = p.replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const existingParts = existing.split(delimiter).filter((e) => e.length > 0);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...toPrepend, ...existingParts, ...appendPathDirs]) {
    const n = normalize(entry);
    if (!seen.has(n)) {
      seen.add(n);
      merged.push(entry);
    }
  }
  return { ...env, [pathKey]: merged.join(delimiter) };
}









