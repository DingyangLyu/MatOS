/**
 * MatOS owns its complete role and system-prompt composition.
 *
 * Open Design is only the UI and transport adapter for these runs. Keep this
 * predicate centralized so no Open Design prompt, title task,
 * critique pass, or other hidden instruction can be reintroduced for a MatOS
 * agent through an isolated call site.
 */
export function usesNativeMatOSPromptAuthority(
  agentId: string | null | undefined,
): boolean {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  return normalized === 'matos' || normalized.startsWith('matos-');
}

/**
 * Product-mode boundary for the Open Design adapter embedded in MatOS.
 *
 * This is deliberately independent of the selected agent id. A fresh or
 * migrated app-config can briefly have no agent selected, but the daemon must
 * still reject every hidden Open Design prompt layer during that
 * bootstrap window.
 */
export function usesNativeMatOSProductMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MATOS_OPEN_DESIGN_ENABLED === '1';
}

/**
 * Open Design project indexing, MCP assembly, tool grants, and artifact
 * snapshots support Open Design agents only. Native MatOS resolves the same
 * concerns inside its own role/runtime graph, so repeating them in the adapter
 * adds I/O and can leak upstream configuration into a MatOS run.
 */
export function usesOpenDesignRunPreparation(
  agentId: string | null | undefined,
): boolean {
  return !usesNativeMatOSPromptAuthority(agentId);
}

/** Upstream catalogues are not product assets when this daemon is a MatOS adapter. */
export function usesOpenDesignCatalogs(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !usesNativeMatOSProductMode(env);
}
