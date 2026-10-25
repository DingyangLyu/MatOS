import type { SkillInfo } from './skills.js';
import type { RoutineRoutesService } from './routes/routine.js';

export interface HttpDeps {
  createSseResponse: (...args: any[]) => any;
  getPublicBaseUrl?: (...args: any[]) => string;
  isLocalSameOrigin: (...args: any[]) => boolean;
  requireLocalDaemonRequest: (...args: any[]) => any;
  resolvedPortRef: { current: number };
  sendApiError: (...args: any[]) => any;
  sendMulterError: (...args: any[]) => any;
}

export interface PathDeps {
  ARTIFACTS_DIR: string;
  // Bundled rendering catalogue.
  // Distinct from SKILLS_DIR so the EntryView Templates surface and the
  // Settings → Skills surface stay decoupled.
  DESIGN_TEMPLATES_DIR: string;
  // Global OD Library data root for owned, content-addressed assets
  // (derived from RUNTIME_DATA_DIR). See apps/daemon/src/library.ts.
  OD_BIN: string;
  PROJECT_ROOT: string;
  PROJECTS_DIR: string;
  RUNTIME_DATA_DIR: string;
  RUNTIME_DATA_DIR_CANONICAL: string;
  SKILLS_DIR: string;
  // Mirror of USER_SKILLS_DIR rooted at DESIGN_TEMPLATES_DIR so user
  // imports of templates do not collide with imports of functional skills.
  USER_DESIGN_TEMPLATES_DIR: string;
  USER_SKILLS_DIR: string;
}

export interface ResourceDeps {
  listAllSkills: () => Promise<Array<SkillInfo & { source?: string }>>;
  // Mirrors listAllSkills but scans DESIGN_TEMPLATE_ROOTS so the Templates
  // surface only sees rendering-catalogue entries.
  listAllDesignTemplates: () => Promise<Array<SkillInfo & { source?: string }>>;
  // Spans both functional skills and design templates so cross-surface
  // resolvers (chat run system prompt,
  // /api/skills/:id/example, /api/skills/:id/assets/*) keep working when
  // a stored project.skillId points at either root.
  listAllSkillLikeEntries: () => Promise<Array<SkillInfo & { source?: string }>>;
  mimeFor: (filePath: string) => string;
}

export interface RoutineDeps {
  routineService: RoutineRoutesService;
}

export interface ProjectPreviewScopeDeps {
  mint: (projectId: string) => string;
  validate: (projectId: string, scope: string) => boolean;
}

export interface ServerContext {
  db: any;
  design: any;
  http: HttpDeps;
  paths: PathDeps;
  ids: any;
  uploads: any;
  node: any;
  projectStore: any;
  projectFiles: any;
  conversations: any;
  templates: any;
  status: any;
  events: any;
  imports: any;
  exports: any;
  artifacts: any;
  documents: any;
  auth: any;
  media: any;
  appConfig: any;
  nativeDialogs: any;
  research: any;
  mcp: any;
  resources: ResourceDeps;
  routines: RoutineDeps;
  projectPreviewScopes: ProjectPreviewScopeDeps;
  validation: any;
  chat: any;
  messages: any;
  agents: any;
  lifecycle: {
    isDaemonShuttingDown: () => boolean;
  };
}

export type RouteDeps<K extends keyof ServerContext> = Pick<ServerContext, K>;
