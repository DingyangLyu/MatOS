import type { ServerContext } from './server-context.js';
import type { RegisterActiveContextRoutesDeps } from './routes/active-context.js';
import type { RegisterAutomationRoutesDeps } from './routes/automation.js';
import type { RegisterChatRoutesDeps } from './routes/chat.js';
import type { RegisterImportRoutesDeps, RegisterProjectExportRoutesDeps } from './import-export-routes.js';
import type { RegisterHostToolsRoutesDeps } from './routes/host-tools.js';
import type { RegisterMcpRoutesDeps } from './mcp-routes.js';
import type { RegisterProjectArtifactRoutesDeps, RegisterProjectFileRoutesDeps, RegisterProjectRoutesDeps, RegisterProjectUploadRoutesDeps } from './routes/project/index.js';
import type { RegisterRoutineRoutesDeps } from './routes/routine.js';
import type { RegisterRunRoutesDeps } from './routes/runs.js';
import type { RegisterStaticResourceRoutesDeps } from './routes/static-resource.js';

type AllRegisteredRouteDeps =
  & RegisterActiveContextRoutesDeps
  & RegisterAutomationRoutesDeps
  & RegisterChatRoutesDeps
  & RegisterHostToolsRoutesDeps
  & RegisterImportRoutesDeps
  & RegisterMcpRoutesDeps
  & RegisterProjectArtifactRoutesDeps
  & RegisterProjectExportRoutesDeps
  & RegisterProjectFileRoutesDeps
  & RegisterProjectRoutesDeps
  & RegisterProjectUploadRoutesDeps
  & RegisterRoutineRoutesDeps
  & RegisterRunRoutesDeps
  & RegisterStaticResourceRoutesDeps;

type Assert<T extends true> = T;
type ServerContextCoversRouteDeps = Assert<ServerContext extends AllRegisteredRouteDeps ? true : false>;

export function assertServerContextSatisfiesRoutes(ctx: ServerContextCoversRouteDeps extends true ? ServerContext : never): void {
  void ctx;
}
