import type { ChatSessionMode } from '@open-design/contracts';
import type { OpenDesignHostProjectImportSuccess } from '@open-design/host';
import type {
  AgentInfo,
  AppConfig,
  AppTheme,
  Project,
  ProjectTemplate,
  SkillSummary,
} from '../types';
// `EntryShell` owns the redesigned home layout (left rail + centered
// hero + recent projects). Keeping the redesign in a sibling
// component lets future rebases against upstream `EntryView` (props,
// helper exports) stay close to a no-op here.
import { EntryShell } from './EntryShell';
import type { IntegrationTab } from './IntegrationsView';
import type { CreateInput } from './NewProjectPanel';
import { useRoute } from '../router';

type EntryCreateProjectInput = Omit<CreateInput, 'metadata'> & {
  metadata?: CreateInput['metadata'];
  // MatOS new-project form: explicit slug id (folder name under the chosen
  // project location) + the location to create the folder in.
  id?: string;
  projectLocationId?: string;
  pendingPrompt?: string;
  conversationMode?: ChatSessionMode;
  autoSendFirstMessage?: boolean;
  requestId?: string;
  pendingFiles?: File[];
  userWorkingDirToken?: string;
};

interface Props {
  // Union of functional skills + design templates — used for id-based
  // lookups (DesignsTab project chips, NewProjectPanel skill picker).
  // The Templates gallery itself reads `designTemplates` instead so it
  // doesn't accidentally show functional skills as renderable cards.
  skills: SkillSummary[];
  // Design templates only. Sourced from /api/design-templates.
  designTemplates: SkillSummary[];
  projects: Project[];
  templates: ProjectTemplate[];
  onDeleteTemplate: (id: string) => Promise<boolean>;
  agents: AgentInfo[];
  // Forwarded to EntryShell → OnboardingView so the AMR cloud card can show a
  // detecting/skeleton state while the cold-start agent stream is in flight.
  agentsLoading?: boolean;
  // Execution / model-switching context forwarded to the EntryShell so the
  // sticky top-bar can expose the active CLI/BYOK + model and persist
  // changes through the same channels as the project view.
  config: AppConfig;
  integrationInitialTab?: IntegrationTab;
  daemonLive: boolean;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
  onRefreshAgents: () => Promise<AgentInfo[]> | AgentInfo[];
  // Quick theme switch invoked from the avatar-popover dropdown so the
  // user can flip light/dark/system without opening the full Settings
  // dialog. Persistence happens in `App`; this component just forwards.
  onThemeChange: (theme: AppTheme) => void;
  // Per-resource loading flags. Each tab gates its own content on whichever
  // flag matches the data it renders, so a slow `/api/agents` probe does
  // not block tabs that don't need agents. Templates are not gated here —
  // the New project modal renders an empty state until they arrive (fast
  // fetch), which keeps the prop surface narrower.
  skillsLoading?: boolean;
  projectsLoading?: boolean;
  onCreateProject: (input: EntryCreateProjectInput) => Promise<boolean> | boolean | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
  onOpenProject: (id: string) => Promise<boolean> | boolean | void;
  onDeleteProject: (id: string) => void;
  onDuplicateProject?: (id: string) => Promise<void> | void;
  onRenameProject: (id: string, name: string) => void;
  onProjectsRefresh?: () => Promise<void> | void;
  onOpenSettings: (section?: 'execution' | 'media' | 'mcpClient' | 'language' | 'appearance' | 'notifications' | 'projectLocations' | 'library' | 'about') => void;
  onCompleteOnboarding: () => void;
}

export function EntryView({
  skills,
  designTemplates,
  projects,
  templates,
  onDeleteTemplate,
  agents,
  agentsLoading,
  config,
  integrationInitialTab,
  daemonLive,
  onAgentChange,
  onAgentModelChange,
  onConfigPersist,
  onSkillsRefresh,
  onSkillsChanged,
  onRefreshAgents,
  onThemeChange,
  skillsLoading = false,
  projectsLoading = false,
  onCreateProject,
  onImportFolder,
  onImportFolderResponse,
  onOpenProject,
  onDeleteProject,
  onDuplicateProject,
  onRenameProject,
  onProjectsRefresh,
  onOpenSettings,
  onCompleteOnboarding,
}: Props) {
  const route = useRoute();

  return (
    <EntryShell
      skills={skills}
      designTemplates={designTemplates}
      projects={projects}
      templates={templates}
      onDeleteTemplate={onDeleteTemplate}
      {...(integrationInitialTab ? { integrationInitialTab } : {})}
      skillsLoading={skillsLoading}
      projectsLoading={projectsLoading}
      config={config}
      agents={agents}
      {...(agentsLoading !== undefined ? { agentsLoading } : {})}
      daemonLive={daemonLive}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onConfigPersist={onConfigPersist}
      onSkillsRefresh={onSkillsRefresh}
      onSkillsChanged={onSkillsChanged}
      onRefreshAgents={onRefreshAgents}
      onThemeChange={onThemeChange}
      onCreateProject={onCreateProject}
      {...(onImportFolder ? { onImportFolder } : {})}
      {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
      onOpenProject={onOpenProject}
      onDeleteProject={onDeleteProject}
      onDuplicateProject={onDuplicateProject}
      onRenameProject={onRenameProject}
      onProjectsRefresh={onProjectsRefresh}
      onOpenSettings={onOpenSettings}
      onCompleteOnboarding={onCompleteOnboarding}
    />
  );
}
