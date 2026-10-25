import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import {
  RUN_RESULT_PACKAGE_SCHEMA,
  type ArtifactManifest,
  type ChatRunStatus,
  type ChatRunStatusResponse,
  type ProjectMetadata as ContractProjectMetadata,
  type RunResultPackageResponse,
} from '@open-design/contracts';
import type { OdNativeEvent } from '@open-design/agui-adapter';
import { readAppConfig } from '../app-config.js';
import { getConversation, getProject, listConversations } from '../db.js';
import { isManagedProjectCwd } from '../mcp-config.js';
import {
  assertSandboxProjectRootAvailable,
  isSafeId,
  listFiles,
  resolveProjectDir,
  SandboxImportedProjectError,
} from '../projects.js';
import type { RunEventForFailureClassification } from '../run-failure-classification.js';
import { classifyRunFailure } from '../run-failure-classification.js';
import { deriveRunErrorCode, runResultFromStatus } from '../run-result.js';
import type { RunStatusSnapshot } from '../run-result.js';
import { scaffoldRunConversationMessages } from '../runtimes/run-message-finalize.js';
import {
  parseRunToolBundleForRequest,
  validateRunToolBundleForAgent,
} from '../run-tool-bundle.js';
import type { DetectedAgent, RuntimeAgentDef } from '../runtimes/types.js';
import {
  usesNativeMatOSProductMode,
  usesNativeMatOSPromptAuthority,
} from '../runtimes/matos-native-policy.js';

type SqliteDb = Database.Database;
type JsonRecord = Record<string, unknown>;
type ApiRequest = Request<Record<string, string>, unknown, JsonRecord>;
type ApiResponse = Response<unknown>;
type ProjectMetadata = (Partial<ContractProjectMetadata> & JsonRecord) | null | undefined;
type RunDeliveryTarget = 'managed-project' | 'external-project' | 'none';

interface ProjectRecord {
  id: string;
  name: string;
  metadata?: ProjectMetadata;
}

interface ConversationRecord {
  id: string;
  createdAt?: number;
}

interface RunEventRecord extends RunEventForFailureClassification {
  id: number;
  event: string;
  data: unknown;
  timestamp?: number;
}

interface SseClient {
  send(event: string, data: unknown, id?: number): void;
  end(): void;
  cleanup?(): void;
}

interface ChatRun {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  userMessageId?: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  model?: string | null;
  status: ChatRunStatus;
  createdAt: number;
  updatedAt: number;
  cancelRequested?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  errorCode?: string | null;
  projectMetadata?: ProjectMetadata;
  clientType?: 'desktop' | 'web';
  events: RunEventRecord[];
  clients: Set<SseClient>;
  retryAttemptCount?: number;
  promptCache?: {
    stablePromptHash?: string;
    hit?: boolean;
    missReason?: string | null;
  };
}

interface RunCreateMeta extends JsonRecord {
  projectId?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  agentId?: string;
  message?: string;
  currentPrompt?: string;
  projectMetadata?: ProjectMetadata;
}

interface RunListFilters {
  projectId?: unknown;
  conversationId?: unknown;
  status?: unknown;
}

interface ChatRunService {
  create(meta: RunCreateMeta): ChatRun;
  get(id: string): ChatRun | null;
  list(filters: RunListFilters): ChatRun[];
  statusBody(run: ChatRun): ChatRunStatusResponse;
  stream(run: ChatRun, req: Request, res: Response): void;
  start(run: ChatRun, starter: () => Promise<unknown>): ChatRun;
  wait(run: ChatRun): Promise<ChatRunStatusResponse>;
  cancel(run: ChatRun): Promise<ChatRunStatusResponse>;
  isTerminal(status: ChatRunStatus): boolean;
  emit?(run: ChatRun, event: string, data: unknown): RunEventRecord;
}

interface RunRoutesDesignService {
  runs: ChatRunService;
  getAppVersion(): string;
}

interface ProjectFileEntry {
  name: string;
  artifactKind?: string | null;
  artifactManifest?: ArtifactManifest | JsonRecord | null;
}

interface SseResponse {
  send(event: string, data: unknown, id?: number): void;
  end(): void;
  cleanup?(): void;
}

export interface RegisterRunRoutesDeps {
  db: SqliteDb;
  design: RunRoutesDesignService;
  http: {
    createSseResponse: (res: Response) => SseResponse;
    sendApiError: (
      res: Response,
      status: number,
      code: string,
      message: string,
    ) => Response<unknown> | void;
  };
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR: string;
  };
  agents: {
    detectAgents: (agentCliEnv?: Record<string, unknown>) => Promise<DetectedAgent[]>;
    getAgentDef: (agentId: string) => RuntimeAgentDef | null | undefined;
  };
  chat: {
    startChatRun: (meta: RunCreateMeta, run: ChatRun) => Promise<unknown>;
  };
  lifecycle: {
    isDaemonShuttingDown: () => boolean;
  };
  messages: {
    pinAssistantMessageOnRunCreate: (db: SqliteDb, run: ChatRun) => void;
    reconcileAssistantMessageOnRunEnd: (
      db: SqliteDb,
      runs: ChatRunService,
      run: ChatRun,
    ) => void;
  };
}

type TerminalRunStatus = RunStatusSnapshot & {
  status: string;
  error?: string | null;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
};

const AGUI_NATIVE_EVENT_KINDS: ReadonlySet<OdNativeEvent['kind']> = new Set([
  'message_chunk',
  'tool_call',
  'state_update',
  'end',
  'run_started',
]);

function toJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function toProjectRecord(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as JsonRecord;
  return typeof record.id === 'string'
    ? value as ProjectRecord
    : null;
}

function toConversationRecords(value: unknown): ConversationRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ConversationRecord =>
        Boolean(item && typeof item === 'object' && typeof (item as JsonRecord).id === 'string'),
      )
    : [];
}

function toProjectFiles(value: unknown): ProjectFileEntry[] {
  return Array.isArray(value)
    ? value.filter((item): item is ProjectFileEntry =>
        Boolean(item && typeof item === 'object' && typeof (item as JsonRecord).name === 'string'),
      )
    : [];
}

function toScenarioProjectMetadata(
  metadata: ProjectMetadata,
): Pick<ContractProjectMetadata, 'kind' | 'intent'> | null {
  if (!metadata || typeof metadata.kind !== 'string') return null;
  return {
    kind: metadata.kind as ContractProjectMetadata['kind'],
  };
}

function routeParamId(req: ApiRequest): string | null {
  return typeof req.params.id === 'string' && req.params.id.length > 0
    ? req.params.id
    : null;
}

function toOdNativeEvent(record: RunEventRecord): OdNativeEvent | null {
  if (!AGUI_NATIVE_EVENT_KINDS.has(record.event as OdNativeEvent['kind'])) return null;
  return { kind: record.event, ...toJsonRecord(record.data) } as OdNativeEvent;
}

export function registerRunRoutes(app: Express, ctx: RegisterRunRoutesDeps) {
  const { db, design } = ctx;
  const { createSseResponse, sendApiError } = ctx.http;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  const { detectAgents, getAgentDef } = ctx.agents;
  const { startChatRun } = ctx.chat;
  const {
    pinAssistantMessageOnRunCreate,
    reconcileAssistantMessageOnRunEnd,
  } = ctx.messages;

  function runToolBundleDeliveryTargetForProject(
    projectId: unknown,
    metadata: ProjectMetadata,
  ): RunDeliveryTarget {
    if (typeof projectId !== 'string' || !projectId || !isSafeId(projectId)) {
      return 'none';
    }
    try {
      const cwd = resolveProjectDir(PROJECTS_DIR, projectId, metadata, {
        allowUnavailableSandboxImportedProject: true,
      });
      return isManagedProjectCwd(cwd, PROJECTS_DIR) ? 'managed-project' : 'external-project';
    } catch {
      return 'none';
    }
  }

  app.post('/api/runs', async (req: ApiRequest, res: ApiResponse) => {
    if (ctx.lifecycle.isDaemonShuttingDown()) {
      return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'daemon is shutting down');
    }
    const requestBody = toJsonRecord(req.body);
    const toolBundle = parseRunToolBundleForRequest(requestBody.toolBundle);
    if (!toolBundle.ok) {
      return sendApiError(res, 400, 'BAD_REQUEST', toolBundle.message);
    }
    let effectiveAgentId =
      typeof requestBody.agentId === 'string' && requestBody.agentId
        ? requestBody.agentId
        : null;
    if (!effectiveAgentId) {
      try {
        const appCfg = await readAppConfig(RUNTIME_DATA_DIR);
        const cfgAgent = typeof appCfg.agentId === 'string' && appCfg.agentId
          ? appCfg.agentId
          : null;
        const agents = await detectAgents(
          toJsonRecord(appCfg.agentCliEnv),
        ).catch((): DetectedAgent[] => []);
        const cfgAgentAvailable = cfgAgent
          ? agents.some((agent) => agent.id === cfgAgent && agent.available)
          : false;
        effectiveAgentId = cfgAgentAvailable
          ? cfgAgent
          : agents.find((agent) => agent.available)?.id ?? null;
      } catch (err) {
        console.warn('[runs] agent id fallback failed', err);
      }
    }
    const nativeMatOSPromptAuthority =
      usesNativeMatOSProductMode() || usesNativeMatOSPromptAuthority(effectiveAgentId);
    const meta: RunCreateMeta = {
      ...requestBody,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      toolBundle: toolBundle.bundle,
    };
    let runProject: ProjectRecord | null = null;
    if (typeof meta.projectId === 'string' && meta.projectId) {
      try {
        runProject = toProjectRecord(getProject(db, meta.projectId));
        assertSandboxProjectRootAvailable(runProject?.metadata);
      } catch (err) {
        if (err instanceof SandboxImportedProjectError) {
          return sendApiError(res, 400, 'BAD_REQUEST', err.message);
        }
        throw err;
      }
    }
    if (nativeMatOSPromptAuthority) {
      // MatOS roles and assets are composed by the native runtime.
      delete meta.systemPrompt;
      if (typeof requestBody.message === 'string') meta.message = requestBody.message;
      else delete meta.message;
    }
    const toolBundleSupport = validateRunToolBundleForAgent(
      toolBundle.bundle,
      typeof meta.agentId === 'string' ? getAgentDef(meta.agentId) : null,
      {
        deliveryTarget: runToolBundleDeliveryTargetForProject(
          meta.projectId,
          runProject?.metadata,
        ),
      },
    );
    if (!toolBundleSupport.ok) {
      return sendApiError(res, 400, 'BAD_REQUEST', toolBundleSupport.message);
    }
    if (runProject?.metadata) {
      meta.projectMetadata = runProject.metadata;
    }
    if (
      typeof meta.projectId === 'string' &&
      meta.projectId &&
      (typeof meta.conversationId !== 'string' || !meta.conversationId)
    ) {
      // MCP/SDK callers that send only projectId: resolve the project's
      // default conversation, then let the daemon own the turn's message
      // rows (shared scaffold with the explicit-conversation branch below).
      try {
        const convs = toConversationRecords(listConversations(db, meta.projectId));
        const defaultConv = convs.length > 0
          ? [...convs].sort((a, b) => {
              const aCreated = Number(a?.createdAt);
              const bCreated = Number(b?.createdAt);
              if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
                return aCreated - bCreated;
              }
              return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
            })[0]
          : null;
        if (defaultConv && typeof defaultConv.id === 'string' && defaultConv.id) {
          meta.conversationId = defaultConv.id;
          const scaffold = scaffoldRunConversationMessages({
            db,
            conversationId: defaultConv.id,
            requestedAssistantMessageId: meta.assistantMessageId,
            message: meta.message,
            currentPrompt: meta.currentPrompt,
          });
          if (scaffold.userMessageId) {
            meta.userMessageId = scaffold.userMessageId;
          } else {
            delete meta.userMessageId;
          }
          meta.assistantMessageId = scaffold.assistantMessageId;
        }
      } catch (err) {
        console.warn('[runs] mcp conversation fallback failed', err);
      }
    } else if (
      typeof meta.projectId === 'string' &&
      meta.projectId &&
      typeof meta.conversationId === 'string' &&
      meta.conversationId &&
      (typeof meta.assistantMessageId !== 'string' || !meta.assistantMessageId)
    ) {
      // API-only clients (mobile app, SDK/smoke scripts) that address an
      // explicit conversation but send no assistantMessageId: the daemon
      // adopts the turn's message persistence. Without this, no assistant
      // row is ever pinned (pinAssistantMessageOnRunCreate is a no-op with a
      // null id), the run-terminal finalize sink has no row to complete, no
      // user row exists at all, and GET messages stays empty for the whole
      // turn even though the run succeeded.
      //
      // Double-write safety (authoritative rule): "no assistantMessageId in
      // the request" is the caller's opt-in to daemon-owned persistence.
      // Every web sender — useConversationChat.ts, ProjectView.tsx — must mint the
      // assistant id with randomUUID() BEFORE dispatch because that id is
      // what renders the streaming bubble, and always sends it (the
      // `assistantMessageId ?? null` in apps/web/src/providers/daemon.ts is
      // option normalization, not a reachable null path). Those requests
      // never enter this branch, keep writing their own user rows, and their
      // pin/finalize behavior is byte-identical to before this branch
      // existed. The conversation-ownership guard keeps bogus conversation
      // ids on today's behavior (no scaffold; the run still streams).
      try {
        const requestConversation = getConversation(db, meta.conversationId);
        if (requestConversation && requestConversation.projectId === meta.projectId) {
          const scaffold = scaffoldRunConversationMessages({
            db,
            conversationId: meta.conversationId,
            requestedAssistantMessageId: meta.assistantMessageId,
            message: meta.message,
            currentPrompt: meta.currentPrompt,
          });
          if (scaffold.userMessageId) {
            meta.userMessageId = scaffold.userMessageId;
          } else {
            delete meta.userMessageId;
          }
          meta.assistantMessageId = scaffold.assistantMessageId;
        }
      } catch (err) {
        console.warn('[runs] api-only conversation message scaffold failed', err);
      }
    }
    const run = design.runs.create(meta);
    try {
      pinAssistantMessageOnRunCreate(db, run);
    } catch (err) {
      console.warn('[runs] message create pin failed', err);
    }
    const declaredClient = String(req.get('x-od-client') ?? '').toLowerCase();
    if (declaredClient === 'desktop' || declaredClient === 'web') {
      run.clientType = declaredClient;
    } else {
      const ua = String(req.get('user-agent') ?? '');
      run.clientType = ua.includes('Electron/') ? 'desktop' : 'web';
    }
    const body = {
      runId: run.id,
      conversationId: run.conversationId ?? null,
      userMessageId: run.userMessageId ?? null,
      assistantMessageId: run.assistantMessageId ?? null,
    };
    res.status(202).json(body);
    reconcileAssistantMessageOnRunEnd(db, design.runs, run);
    design.runs.start(run, () => startChatRun(meta, run));

  });

  app.get('/api/runs', (req: ApiRequest, res: ApiResponse) => {
    const { projectId, conversationId, status } = req.query;
    const runs = design.runs.list({ projectId, conversationId, status });
    const body = { runs: runs.map(design.runs.statusBody) };
    res.json(body);
  });

  app.get('/api/runs/:id/result-package', async (req: ApiRequest, res: ApiResponse) => {
    const runId = routeParamId(req);
    if (!runId) return sendApiError(res, 400, 'BAD_REQUEST', 'run id missing');
    const run = design.runs.get(runId);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    const status = design.runs.statusBody(run);
    const project = run.projectId ? toProjectRecord(getProject(db, run.projectId)) : null;
    let files: ProjectFileEntry[] = [];
    if (project) {
      const packageMetadata = run.projectMetadata ?? null;
      try {
        if (status.workspace?.storage?.kind === 'folder-backed') {
          const projectRoot = resolveProjectDir(PROJECTS_DIR, project.id, packageMetadata);
          const projectRootStat = await fs.promises.stat(projectRoot);
          if (!projectRootStat.isDirectory()) {
            throw new Error('workspace root is not a directory');
          }
        }
        files = toProjectFiles(await listFiles(PROJECTS_DIR, project.id, { metadata: packageMetadata }));
      } catch (err) {
        return sendApiError(
          res,
          500,
          'WORKSPACE_ENUMERATION_FAILED',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const artifacts = files
      .filter((file): file is ProjectFileEntry & { artifactManifest: ArtifactManifest } =>
        Boolean(file.artifactManifest && typeof file.artifactManifest === 'object'),
      )
      .map((file) => ({
        file: file.name,
        kind: typeof file.artifactManifest.kind === 'string'
          ? file.artifactManifest.kind
          : file.artifactKind ?? null,
        renderer: typeof file.artifactManifest.renderer === 'string'
          ? file.artifactManifest.renderer
          : null,
        title: typeof file.artifactManifest.title === 'string'
          ? file.artifactManifest.title
          : file.name,
        status: typeof file.artifactManifest.status === 'string'
          ? file.artifactManifest.status
          : null,
        manifest: file.artifactManifest,
      }));
    const body: RunResultPackageResponse = {
      schema: RUN_RESULT_PACKAGE_SCHEMA,
      run: {
        id: status.id,
        status: status.status,
        projectId: status.projectId,
        conversationId: status.conversationId,
        assistantMessageId: status.assistantMessageId,
        agentId: status.agentId,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
        ...(status.cancelRequested !== undefined
          ? { cancelRequested: status.cancelRequested }
          : {}),
        ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
        ...(status.signal !== undefined ? { signal: status.signal } : {}),
        ...(status.error !== undefined ? { error: status.error } : {}),
        ...(status.errorCode !== undefined ? { errorCode: status.errorCode } : {}),
      },
      workspace: status.workspace ?? {
        storage: { kind: 'od-owned', baseDir: null },
        provenance: null,
      },
      events: {
        logPath: status.eventsLogPath ?? null,
      },
      project: project
        ? {
            id: project.id,
            name: project.name,
            fileCount: files.length,
          }
        : null,
      artifacts,
    };
    res.json(body);
  });

  app.get('/api/runs/:id', (req: ApiRequest, res: ApiResponse) => {
    const runId = routeParamId(req);
    if (!runId) return sendApiError(res, 400, 'BAD_REQUEST', 'run id missing');
    const run = design.runs.get(runId);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    res.json(design.runs.statusBody(run));
  });

  app.get('/api/runs/:id/events', (req: ApiRequest, res: ApiResponse) => {
    const runId = routeParamId(req);
    if (!runId) return sendApiError(res, 400, 'BAD_REQUEST', 'run id missing');
    const run = design.runs.get(runId);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.stream(run, req, res);
  });

  app.get('/api/runs/:id/agui', async (req: ApiRequest, res: ApiResponse) => {
    const runId = routeParamId(req);
    if (!runId) return sendApiError(res, 400, 'BAD_REQUEST', 'run id missing');
    const run = design.runs.get(runId);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    const { encodeOdEventForAgui } = await import('@open-design/agui-adapter');
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    const emitMapped = (record: RunEventRecord) => {
      const nativeEvent = toOdNativeEvent(record);
      if (!nativeEvent) return;
      const mapped = encodeOdEventForAgui(
        nativeEvent,
        { runId: run.id, seq: record.id, now: Date.now() },
      );
      if (mapped) sse.send(mapped.kind, mapped, record.id);
    };
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) emitMapped(record);
    }
    if (design.runs.isTerminal(run.status)) {
      sse.end();
      return;
    }
    const adapterClient = {
      send: (event: string, data: unknown, id?: number) => {
        const nativeEvent = toOdNativeEvent({
          id: id ?? 0,
          event,
          data,
          timestamp: Date.now(),
        });
        if (!nativeEvent) return;
        const ctx = id === undefined
          ? { runId: run.id, now: Date.now() }
          : { runId: run.id, seq: id, now: Date.now() };
        const mapped = encodeOdEventForAgui(nativeEvent, ctx);
        if (mapped) sse.send(mapped.kind, mapped, id);
      },
      end:     () => sse.end(),
      cleanup: () => sse.cleanup?.(),
    };
    run.clients.add(adapterClient);
    res.on('close', () => {
      run.clients.delete(adapterClient);
      sse.cleanup?.();
    });
  });

  app.post('/api/runs/:id/cancel', async (req: ApiRequest, res: ApiResponse) => {
    const runId = routeParamId(req);
    if (!runId) return sendApiError(res, 400, 'BAD_REQUEST', 'run id missing');
    const run = design.runs.get(runId);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    const status = await design.runs.cancel(run);
    const body = { ok: true, run: status };
    res.json(body);
  });

  app.post('/api/chat', (req: ApiRequest, res: ApiResponse) => {
    if (ctx.lifecycle.isDaemonShuttingDown()) {
      return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'daemon is shutting down');
    }
    const requestBody = toJsonRecord(req.body);
    const toolBundle = parseRunToolBundleForRequest(requestBody.toolBundle);
    if (!toolBundle.ok) {
      return sendApiError(res, 400, 'BAD_REQUEST', toolBundle.message);
    }
    let chatProject: ProjectRecord | null = null;
    if (typeof requestBody.projectId === 'string' && requestBody.projectId) {
      try {
        chatProject = toProjectRecord(getProject(db, requestBody.projectId));
        assertSandboxProjectRootAvailable(chatProject?.metadata);
      } catch (err) {
        if (err instanceof SandboxImportedProjectError) {
          return sendApiError(res, 400, 'BAD_REQUEST', err.message);
        }
        throw err;
      }
    }
    const toolBundleSupport = validateRunToolBundleForAgent(
      toolBundle.bundle,
      typeof requestBody.agentId === 'string' ? getAgentDef(requestBody.agentId) : null,
      {
        deliveryTarget: runToolBundleDeliveryTargetForProject(
          requestBody.projectId,
          chatProject?.metadata,
        ),
      },
    );
    if (!toolBundleSupport.ok) {
      return sendApiError(res, 400, 'BAD_REQUEST', toolBundleSupport.message);
    }
    const meta = {
      ...requestBody,
      toolBundle: toolBundle.bundle,
      ...(chatProject?.metadata ? { projectMetadata: chatProject.metadata } : {}),
    };
    const run = design.runs.create(meta);
    design.runs.stream(run, req, res);
    design.runs.start(run, () => startChatRun(meta, run));
  });
}
