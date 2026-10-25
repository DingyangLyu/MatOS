export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;
export type AgentCliEnvIntentPrefs = Record<string, { apiKeyOverride?: boolean }>;

export interface ProjectLocationPrefs {
  id: string;
  name: string;
  path: string;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  agentCliEnvIntent?: AgentCliEnvIntentPrefs;
  skillId?: string | null;
  disabledSkills?: string[];
  customInstructions?: string | null;
  /** External project library roots. The daemon adds its built-in .od/projects location at read time. */
  projectLocations?: ProjectLocationPrefs[];
  /** Project location id used for new projects when the create request does not choose one explicitly. */
  defaultProjectLocationId?: string | null;
  /**
   * Most-recently-used local working directories the user granted the agent
   * read access to (via the Home composer's working-directory picker). These
   * become a new project's `metadata.linkedDirs` — the agent perceives them
   * through `--add-dir`; they are NOT imported into Design Files. Stored
   * most-recent-first and capped by the daemon.
   */
  recentLinkedDirs?: string[];
}

/** Response body for `GET /api/recent-dirs` — recent working directories
 *  pruned to those that still exist on disk, most-recent-first. */
export interface RecentLinkedDirsResponse {
  dirs: string[];
}
