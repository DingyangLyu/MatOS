import { realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { MatOSWorkflowRunSnapshot } from "../../workflows/types.js";
import { redactTraceValue } from "../../sessions/traceContext.js";
import type { MatOSTraceContext } from "../../sessions/traceContext.js";
import { withKeyedMutex } from "../../workflows/asyncMutex.js";
import {
  matOSAlgorithmRunManifestDigest,
  type MatOSAlgorithmRunManifest,
} from "../manifest.js";
import {
  flushMatOSAlgorithmRunDecisionReferences,
  type MatOSAlgorithmRunDecisionReference,
} from "../runDecisionRefs.js";
import { appendMatOSAlgorithmOutcome } from "./ledger.js";
import { attributeMatOSAlgorithmReward } from "./attribution.js";
import {
  assertRealOutcomeStoreDirectory,
  ensureContainedOutcomeStoreDirectory,
  isMissingOutcomeStorePath,
  readOutcomeStoreFile,
  withOutcomeStoreFileLock,
  writeOutcomeStoreFileAtomic,
} from "./storeIo.js";
import type {
  MatOSAlgorithmOutcomeRecord,
  MatOSAlgorithmOutcomeStatus,
} from "./types.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const OUTCOME_INDEX_MAX_BYTES = 1024 * 1024;
const RUN_OUTCOME_MAX_BYTES = 4 * 1024 * 1024;
const RUN_MANIFEST_MAX_BYTES = 1024 * 1024;
const RUN_DECISIONS_MAX_BYTES = 4 * 1024 * 1024;
const RUN_BUDGET_MAX_BYTES = 1024 * 1024;
const RUN_ARTIFACTS_MAX_BYTES = 4 * 1024 * 1024;
const RUN_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
const RUN_GRAPH_MAX_BYTES = 8 * 1024 * 1024;
const RUN_NODE_ATTEMPT_MAX_BYTES = 1024 * 1024;
const RUN_CONTROLLER_FINALIZE_MAX_BYTES = 1024 * 1024;
const MAX_DECISION_REFS = 512;
const MAX_ARTIFACT_REFS = 512;
const MAX_EVENT_REFS = 1024;
const MAX_METRICS = 128;
const MAX_REFERENCE_LENGTH = 1024;
const MAX_ARTIFACT_PATH_LENGTH = 4096;
const OUTCOME_FILE_PATTERN = /^(\d+)-(completed|failed|cancelled)\.json$/;

type OutcomeIndex = {
  schemaVersion: 1;
  generation: number;
  lastStatus: string;
  lastRunUpdatedAt?: string;
  outcomeRefs: string[];
};

type StoredOutcome = {
  ref: string;
  record: MatOSAlgorithmOutcomeRecord;
};

type EvidenceRead<T> = {
  state: "present" | "missing" | "corrupt";
  value?: T;
  truncated?: boolean;
};

type ReferenceEvidence = {
  refs: string[];
  corrupt: boolean;
  truncated: boolean;
};

type WorkflowEventReference = {
  id: string;
  type: string;
};

function safeOutcomeReference(value: unknown): string | undefined {
  const ref = boundedString(value, MAX_REFERENCE_LENGTH);
  if (
    !ref ||
    ref !== value ||
    /[\0\r\n]/u.test(ref) ||
    isAbsolute(ref) ||
    /^[a-z]:[\\/]|^\\\\/iu.test(ref)
  ) {
    return undefined;
  }
  return ref;
}

function safeLocalOutcomeReference(value: unknown): string | undefined {
  const ref = safeOutcomeReference(value);
  return ref && !ref.split(/[\\/]+/u).some((segment) => segment === "..")
    ? ref
    : undefined;
}

function mergeReferenceEvidence(
  ...items: readonly ReferenceEvidence[]
): ReferenceEvidence {
  const refs: string[] = [];
  let truncated = items.some((item) => item.truncated);
  for (const item of items) {
    for (const ref of item.refs) {
      if (refs.includes(ref)) continue;
      if (refs.length >= MAX_EVENT_REFS) {
        truncated = true;
        continue;
      }
      refs.push(ref);
    }
  }
  return {
    refs,
    corrupt: items.some((item) => item.corrupt),
    truncated,
  };
}

function explicitReferenceEvidence(
  values: readonly unknown[],
  field: string,
): ReferenceEvidence {
  const refs: string[] = [];
  let corrupt = false;
  let truncated = false;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = (value as Record<string, unknown>)[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      corrupt = true;
      continue;
    }
    for (const item of raw) {
      const ref = safeOutcomeReference(item);
      if (!ref) {
        corrupt = true;
        continue;
      }
      if (refs.includes(ref)) continue;
      if (refs.length >= MAX_EVENT_REFS) truncated = true;
      else refs.push(ref);
    }
  }
  return { refs, corrupt, truncated };
}

function boundedString(
  value: unknown,
  maxLength = MAX_REFERENCE_LENGTH,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length <= maxLength ? value : undefined;
}

function requiredReference(value: unknown, label: string): string {
  const normalized = boundedString(value);
  if (!normalized || normalized !== value) {
    throw new Error(`Workflow outcome ${label} is invalid or too long`);
  }
  return normalized;
}

async function readRunFileEvidence(input: {
  runDir: string;
  name: string;
  maxBytes: number;
}): Promise<EvidenceRead<string>> {
  try {
    const candidate = resolve(input.runDir, input.name);
    if (
      isAbsolute(input.name) ||
      /^[a-z]:[\\/]|^\\\\/iu.test(input.name) ||
      !pathIsWithin(resolve(input.runDir), candidate)
    ) {
      return { state: "corrupt" };
    }
    const parent = dirname(candidate);
    await assertRealOutcomeStoreDirectory(parent, input.runDir);
    return {
      state: "present",
      value: await readOutcomeStoreFile({
        rootDir: parent,
        path: candidate,
        maxBytes: input.maxBytes,
      }),
    };
  } catch (error) {
    return isMissingOutcomeStorePath(error)
      ? { state: "missing" }
      : { state: "corrupt" };
  }
}

async function readJsonEvidence(input: {
  runDir: string;
  name: string;
  maxBytes: number;
}): Promise<EvidenceRead<unknown>> {
  const content = await readRunFileEvidence(input);
  if (content.state !== "present") return content;
  try {
    return {
      state: "present",
      value: JSON.parse(content.value!) as unknown,
    };
  } catch {
    return { state: "corrupt" };
  }
}

async function readBoundWorkflowEvents(input: {
  runDir: string;
}): Promise<EvidenceRead<WorkflowEventReference[]>> {
  const content = await readRunFileEvidence({
    runDir: input.runDir,
    name: "events.jsonl",
    maxBytes: RUN_EVENTS_MAX_BYTES,
  });
  if (content.state !== "present") return { state: content.state };
  const events: WorkflowEventReference[] = [];
  let corrupt = false;
  let truncated = false;
  for (const line of content.value!.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = safeOutcomeReference(parsed?.id);
      const type = safeOutcomeReference(parsed?.type);
      if (!id || !type || typeof parsed?.timestamp !== "string") {
        corrupt = true;
        continue;
      }
      if (events.length >= MAX_EVENT_REFS) truncated = true;
      else events.push({ id, type });
    } catch {
      corrupt = true;
    }
  }
  return {
    state: corrupt ? "corrupt" : "present",
    value: events,
    ...(truncated ? { truncated: true } : {}),
  };
}

function eventReferenceEvidence(
  events: readonly WorkflowEventReference[],
  predicate: (type: string) => boolean,
): ReferenceEvidence {
  return {
    refs: events
      .filter((event) => predicate(event.type.toLowerCase()))
      .map((event) => `events.jsonl#${event.id}`),
    corrupt: false,
    truncated: false,
  };
}

function safeNodePathSegment(value: unknown): string | undefined {
  const id = boundedString(value, 256);
  return id && id !== "." && id !== ".." && /^[A-Za-z0-9_.:-]+$/u.test(id)
    ? id
    : undefined;
}

function validationNodeIdsFromGraph(value: unknown): {
  nodeIds: string[];
  corrupt: boolean;
  truncated: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { nodeIds: [], corrupt: true, truncated: false };
  }
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) {
    return { nodeIds: [], corrupt: true, truncated: false };
  }
  const nodeIds: string[] = [];
  let corrupt = false;
  let truncated = false;
  for (const value of nodes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      corrupt = true;
      continue;
    }
    const node = value as Record<string, unknown>;
    if (node.type !== "validate" && node.targetType !== "validate") continue;
    const nodeId = safeNodePathSegment(node.id);
    if (!nodeId) {
      corrupt = true;
      continue;
    }
    if (nodeIds.includes(nodeId)) continue;
    if (nodeIds.length >= MAX_ARTIFACT_REFS) truncated = true;
    else nodeIds.push(nodeId);
  }
  return { nodeIds, corrupt, truncated };
}

async function validationAttemptEvidence(input: {
  runDir: string;
  nodeIds: readonly string[];
}): Promise<{
  evidence: ReferenceEvidence;
  missingRefs: string[];
  corruptRefs: string[];
}> {
  const refs: string[] = [];
  const missingRefs: string[] = [];
  const corruptRefs: string[] = [];
  let corrupt = false;
  let truncated = false;
  for (const nodeId of input.nodeIds) {
    const nodeRunName = `node-runs/${nodeId}/node-run.json`;
    const nodeRun = await readJsonEvidence({
      runDir: input.runDir,
      name: nodeRunName,
      maxBytes: RUN_NODE_ATTEMPT_MAX_BYTES,
    });
    if (nodeRun.state === "missing") {
      missingRefs.push(nodeRunName);
      continue;
    }
    if (
      nodeRun.state !== "present" ||
      !nodeRun.value ||
      typeof nodeRun.value !== "object" ||
      Array.isArray(nodeRun.value)
    ) {
      corrupt = true;
      corruptRefs.push(nodeRunName);
      continue;
    }
    const snapshot = nodeRun.value as Record<string, unknown>;
    const attempts = Number(snapshot.attempts);
    if (
      snapshot.nodeId !== nodeId ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0
    ) {
      corrupt = true;
      corruptRefs.push(nodeRunName);
      continue;
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptRef = `node-runs/${nodeId}/attempts/${attempt}/attempt.json`;
      const attemptRead = await readJsonEvidence({
        runDir: input.runDir,
        name: attemptRef,
        maxBytes: RUN_NODE_ATTEMPT_MAX_BYTES,
      });
      if (attemptRead.state === "missing") {
        missingRefs.push(attemptRef);
        continue;
      }
      if (
        attemptRead.state !== "present" ||
        !attemptRead.value ||
        typeof attemptRead.value !== "object" ||
        Array.isArray(attemptRead.value)
      ) {
        corrupt = true;
        corruptRefs.push(attemptRef);
        continue;
      }
      const attemptRecord = attemptRead.value as Record<string, unknown>;
      if (
        attemptRecord.nodeId !== nodeId ||
        attemptRecord.attempt !== attempt ||
        typeof attemptRecord.status !== "string"
      ) {
        corrupt = true;
        corruptRefs.push(attemptRef);
        continue;
      }
      if (refs.length >= MAX_ARTIFACT_REFS) truncated = true;
      else refs.push(attemptRef);
    }
  }
  return {
    evidence: { refs, corrupt, truncated },
    missingRefs,
    corruptRefs,
  };
}

function controllerFinalizeEvidence(
  value: unknown,
  manifest: MatOSAlgorithmRunManifest | undefined,
): ReferenceEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { refs: [], corrupt: true, truncated: false };
  }
  const record = value as Record<string, unknown>;
  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : undefined;
  if (
    record.schemaVersion !== 1 ||
    typeof record.providerId !== "string" ||
    typeof record.providerVersion !== "string" ||
    !result ||
    !Array.isArray(result.outcomeRefs) ||
    (manifest?.controller &&
      (record.providerId !== manifest.controller.providerId ||
        record.providerVersion !== manifest.controller.providerVersion))
  ) {
    return { refs: [], corrupt: true, truncated: false };
  }
  return explicitReferenceEvidence([result], "outcomeRefs");
}

function scientificMetricsEvidence(
  values: readonly unknown[],
): { metrics: Record<string, number | string | boolean | null>; corrupt: boolean; truncated: boolean } {
  const metrics: Record<string, number | string | boolean | null> = {};
  let corrupt = false;
  let truncated = false;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = (value as Record<string, unknown>).scientificMetrics;
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      corrupt = true;
      continue;
    }
    for (const [key, metric] of Object.entries(raw as Record<string, unknown>)) {
      if (!boundedString(key, 128)) {
        corrupt = true;
        continue;
      }
      if (
        metric !== null &&
        typeof metric !== "number" &&
        typeof metric !== "string" &&
        typeof metric !== "boolean"
      ) {
        corrupt = true;
        continue;
      }
      if (typeof metric === "number" && !Number.isFinite(metric)) {
        corrupt = true;
        continue;
      }
      if (typeof metric === "string" && metric.length > MAX_REFERENCE_LENGTH) {
        corrupt = true;
        continue;
      }
      if (Object.keys(metrics).length >= MAX_METRICS && !(key in metrics)) {
        truncated = true;
      } else {
        metrics[key] = metric as number | string | boolean | null;
      }
    }
  }
  return { metrics, corrupt, truncated };
}

async function readBoundRunManifest(input: {
  runDir: string;
  snapshot: MatOSWorkflowRunSnapshot;
}): Promise<EvidenceRead<MatOSAlgorithmRunManifest>> {
  const content = await readRunFileEvidence({
    runDir: input.runDir,
    name: "algorithm-manifest.json",
    maxBytes: RUN_MANIFEST_MAX_BYTES,
  });
  if (content.state !== "present") return { state: content.state };
  try {
    const parsed = JSON.parse(content.value!) as MatOSAlgorithmRunManifest;
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.runId !== input.snapshot.runId ||
      parsed.workflowRef !== input.snapshot.workflowRef ||
      !Array.isArray(parsed.components) ||
      typeof parsed.configurationDigest !== "string" ||
      typeof parsed.manifestDigest !== "string"
    ) {
      return { state: "corrupt" };
    }
    const { manifestDigest, ...body } = parsed;
    const expected = matOSAlgorithmRunManifestDigest(body);
    if (manifestDigest !== expected) {
      return { state: "corrupt" };
    }
    return {
      state: "present",
      value: parsed,
    };
  } catch {
    return { state: "corrupt" };
  }
}

function isDecisionReference(
  value: unknown,
): value is MatOSAlgorithmRunDecisionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.decisionId === "string" &&
    typeof record.runId === "string" &&
    typeof record.providerId === "string" &&
    typeof record.source === "string" &&
    (record.providerDecisionId === undefined ||
      Boolean(safeOutcomeReference(record.providerDecisionId))) &&
    (typeof record.surfaceId === "string" ||
      (record.source === "asset-tool" &&
        typeof record.nodeId === "string" &&
        typeof record.assetRef === "string" &&
        ["policy", "controller", "optimizer"].includes(
          String(record.algorithmPlane),
        )))
  );
}

async function readBoundRunDecisions(input: {
  runDir: string;
  snapshot: MatOSWorkflowRunSnapshot;
}): Promise<EvidenceRead<MatOSAlgorithmRunDecisionReference[]>> {
  await flushMatOSAlgorithmRunDecisionReferences(input.runDir);
  const content = await readRunFileEvidence({
    runDir: input.runDir,
    name: "algorithm-decisions.jsonl",
    maxBytes: RUN_DECISIONS_MAX_BYTES,
  });
  if (content.state !== "present") return { state: content.state };
  const decisions: MatOSAlgorithmRunDecisionReference[] = [];
  let corrupt = false;
  let truncated = false;
  let productionCount = 0;
  let counterfactualCount = 0;
  for (const line of content.value!.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        !isDecisionReference(parsed) ||
        parsed.runId !== input.snapshot.runId
      ) {
        corrupt = true;
        continue;
      }
      const workflowRef = (parsed as unknown as Record<string, unknown>)
        .workflowRef;
      if (
        typeof workflowRef === "string" &&
        workflowRef !== input.snapshot.workflowRef
      ) {
        corrupt = true;
        continue;
      }
      const counterfactual =
        (parsed as unknown as { applied?: unknown }).applied === false;
      if (counterfactual) {
        if (counterfactualCount < MAX_DECISION_REFS) {
          decisions.push(parsed);
          counterfactualCount += 1;
        } else truncated = true;
      } else if (productionCount < MAX_DECISION_REFS) {
        decisions.push(parsed);
        productionCount += 1;
      } else truncated = true;
    } catch {
      corrupt = true;
    }
  }
  return {
    state: corrupt ? "corrupt" : "present",
    value: decisions,
    ...(truncated ? { truncated: true } : {}),
  };
}

function numberMetrics(budget: unknown): {
  metrics?: Record<string, number>;
  corrupt: boolean;
  truncated: boolean;
} {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    return { corrupt: true, truncated: false };
  }
  const totals = (budget as Record<string, unknown>).totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) {
    return { corrupt: true, truncated: false };
  }
  const metrics: Record<string, number> = {};
  let corrupt = false;
  let truncated = false;
  for (const [key, value] of Object.entries(
    totals as Record<string, unknown>,
  )) {
    const safeKey = boundedString(key, 128);
    if (
      safeKey === key &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      if (Object.keys(metrics).length < MAX_METRICS) metrics[key] = value;
      else truncated = true;
    } else corrupt = true;
  }
  return {
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    corrupt,
    truncated,
  };
}

function pathIsWithin(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Artifact references may name a not-yet-created file under a workspace
// alias. Resolve existing ancestors so aliases agree with the canonical run
// directory, without exposing a link that leads outside it.
function canonicalArtifactPath(candidate: string): string | undefined {
  let current = candidate;
  let suffix = "";
  while (true) {
    try {
      return resolve(realpathSync.native(current), suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix = join(relative(parent, current), suffix);
      current = parent;
    }
  }
}

function safeArtifactPath(
  runDir: string,
  value: unknown,
): { path?: string; redacted?: true } {
  const raw = boundedString(value, MAX_ARTIFACT_PATH_LENGTH);
  if (!raw || raw.includes("\0")) return {};
  const windowsAbsolute = /^[a-z]:[\\/]|^\\\\/i.test(raw);
  const candidate = canonicalArtifactPath(resolve(runDir, raw));
  if (windowsAbsolute || !candidate || !pathIsWithin(runDir, candidate)) {
    return { path: "[redacted]", redacted: true };
  }
  const runRelative = relative(runDir, candidate).replaceAll("\\", "/");
  return runRelative ? { path: runRelative } : {};
}

function sanitizedArtifacts(
  runDir: string,
  artifacts: unknown,
): {
  refs: NonNullable<MatOSAlgorithmOutcomeRecord["artifactRefs"]>;
  corrupt: boolean;
  truncated: boolean;
} {
  if (!Array.isArray(artifacts)) {
    return { refs: [], corrupt: true, truncated: false };
  }
  const refs: NonNullable<MatOSAlgorithmOutcomeRecord["artifactRefs"]> = [];
  let corrupt = false;
  let truncated = false;
  for (const value of artifacts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      corrupt = true;
      continue;
    }
    const artifact = value as Record<string, unknown>;
    const path = safeArtifactPath(runDir, artifact.path);
    const ref = {
      ...(boundedString(artifact.id) ? { id: boundedString(artifact.id) } : {}),
      ...path,
      ...(boundedString(artifact.sha256, 128)
        ? { sha256: boundedString(artifact.sha256, 128) }
        : {}),
      ...(boundedString(artifact.nodeId)
        ? { nodeId: boundedString(artifact.nodeId) }
        : {}),
      ...(boundedString(artifact.source)
        ? { source: boundedString(artifact.source) }
        : {}),
      ...(artifact.redacted === true || path.redacted
        ? { redacted: true as const }
        : {}),
    };
    if (Object.keys(ref).length > 0) {
      if (refs.length < MAX_ARTIFACT_REFS) refs.push(ref);
      else truncated = true;
    } else corrupt = true;
  }
  return { refs, corrupt, truncated };
}

function sanitizedTrace(value: unknown): MatOSTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const trace = value as Record<string, unknown>;
  const traceId = boundedString(trace.traceId);
  if (trace.schemaVersion !== 1 || !traceId) return undefined;
  const sessionId = boundedString(trace.sessionId);
  const parentSessionId = boundedString(trace.parentSessionId);
  const turnId = boundedString(trace.turnId);
  const userId = boundedString(trace.userId);
  const scopeRef = boundedString(trace.scopeRef);
  const workspaceId = boundedString(trace.workspaceId);
  const runtimeRef = boundedString(trace.runtimeRef);
  const execution = boundedString(trace.execution);
  const roleRef = boundedString(trace.roleRef);
  return {
    schemaVersion: 1,
    traceId,
    ...(sessionId ? { sessionId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(userId ? { userId } : {}),
    ...(scopeRef ? { scopeRef } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(runtimeRef ? { runtimeRef } : {}),
    ...(execution ? { execution } : {}),
    ...(roleRef ? { roleRef } : {}),
  };
}

function validOutcomeIndex(value: unknown): value is OutcomeIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.generation) &&
    Number(record.generation) > 0 &&
    typeof record.lastStatus === "string" &&
    (record.lastRunUpdatedAt === undefined ||
      typeof record.lastRunUpdatedAt === "string") &&
    Array.isArray(record.outcomeRefs) &&
    record.outcomeRefs.every(
      (ref) => typeof ref === "string" && OUTCOME_FILE_PATTERN.test(ref),
    )
  );
}

function validStoredOutcome(input: {
  value: unknown;
  generation: number;
  status: MatOSAlgorithmOutcomeStatus;
  runId: string;
  workflowRef: string;
}): boolean {
  if (
    !input.value ||
    typeof input.value !== "object" ||
    Array.isArray(input.value)
  ) {
    return false;
  }
  const record = input.value as Partial<MatOSAlgorithmOutcomeRecord>;
  return (
    record.schemaVersion === 1 &&
    record.redacted === true &&
    record.kind === "workflow-run" &&
    record.generation === input.generation &&
    record.status === input.status &&
    record.outcomeId ===
      `workflow:${input.runId}:${input.generation}:${input.status}` &&
    record.subject?.runId === input.runId &&
    record.subject?.workflowRef === input.workflowRef &&
    typeof record.recordedAt === "string" &&
    typeof record.success === "boolean" &&
    Array.isArray(record.decisionRefs) &&
    record.decisionRefs.every((item) => typeof item === "string") &&
    Array.isArray(record.provenanceRefs) &&
    record.provenanceRefs.every((item) => typeof item === "string")
  );
}

async function readOutcomeIndex(
  outcomesDir: string,
): Promise<OutcomeIndex | undefined> {
  const indexPath = join(outcomesDir, "index.json");
  try {
    const info = await lstat(indexPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(
        `Workflow outcome index must be a regular file: ${indexPath}`,
      );
    }
    if (info.size > OUTCOME_INDEX_MAX_BYTES) return undefined;
    const content = await readOutcomeStoreFile({
      rootDir: outcomesDir,
      path: indexPath,
      maxBytes: OUTCOME_INDEX_MAX_BYTES,
    });
    const parsed = JSON.parse(content) as unknown;
    return validOutcomeIndex(parsed) ? parsed : undefined;
  } catch (error) {
    if (isMissingOutcomeStorePath(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function scanStoredOutcomes(input: {
  outcomesDir: string;
  runId: string;
  workflowRef: string;
}): Promise<{ outcomes: StoredOutcome[]; maxObservedGeneration: number }> {
  const entries = await readdir(input.outcomesDir, { withFileTypes: true });
  const outcomes: StoredOutcome[] = [];
  let maxObservedGeneration = 0;
  for (const entry of entries) {
    const match = OUTCOME_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(
        `Unsafe workflow outcome generation filename: ${entry.name}`,
      );
    }
    const path = join(input.outcomesDir, entry.name);
    const info = await lstat(path);
    if (entry.isSymbolicLink() || info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Workflow outcome path must be a regular file: ${path}`);
    }
    if (info.size > RUN_OUTCOME_MAX_BYTES) continue;
    const content = await readOutcomeStoreFile({
      rootDir: input.outcomesDir,
      path,
      maxBytes: RUN_OUTCOME_MAX_BYTES,
    });
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      continue;
    }
    const status = match[2] as MatOSAlgorithmOutcomeStatus;
    if (
      validStoredOutcome({
        value,
        generation,
        status,
        runId: input.runId,
        workflowRef: input.workflowRef,
      })
    ) {
      maxObservedGeneration = Math.max(maxObservedGeneration, generation);
      outcomes.push({
        ref: entry.name,
        record: value as MatOSAlgorithmOutcomeRecord,
      });
    }
  }
  outcomes.sort(
    (left, right) => left.record.generation - right.record.generation,
  );
  for (let index = 1; index < outcomes.length; index += 1) {
    if (
      outcomes[index - 1]?.record.generation ===
      outcomes[index]?.record.generation
    ) {
      throw new Error("Workflow outcome generations are ambiguous");
    }
  }
  return { outcomes, maxObservedGeneration };
}

function reconstructedIndex(
  outcomes: readonly StoredOutcome[],
): OutcomeIndex | undefined {
  const latest = outcomes.at(-1);
  if (!latest) return undefined;
  return {
    schemaVersion: 1,
    generation: latest.record.generation,
    lastStatus: latest.record.status,
    ...(latest.record.runUpdatedAt
      ? { lastRunUpdatedAt: latest.record.runUpdatedAt }
      : {}),
    outcomeRefs: outcomes.map((item) => item.ref),
  };
}

function sameIndex(
  left: OutcomeIndex | undefined,
  right: OutcomeIndex | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeOutcomeIndex(
  outcomesDir: string,
  index: OutcomeIndex,
): Promise<void> {
  await writeOutcomeStoreFileAtomic({
    rootDir: outcomesDir,
    path: join(outcomesDir, "index.json"),
    content: `${JSON.stringify(index, null, 2)}\n`,
  });
}

export async function recordWorkflowAlgorithmOutcome(input: {
  runDir: string;
  snapshot: MatOSWorkflowRunSnapshot;
}): Promise<MatOSAlgorithmOutcomeRecord | undefined> {
  const { snapshot, runDir } = input;
  if (!TERMINAL.has(snapshot.status)) return undefined;
  return withKeyedMutex(`workflow-algorithm-outcome:${runDir}`, async () => {
    try {
      const canonicalRunDir = await assertRealOutcomeStoreDirectory(runDir);
      const outcomesDir = await ensureContainedOutcomeStoreDirectory({
        rootDir: canonicalRunDir,
        path: join(canonicalRunDir, "algorithm-outcomes"),
      });
      return await withOutcomeStoreFileLock({
        rootDir: outcomesDir,
        name: ".outcomes-write",
        run: (canonicalOutcomesDir) =>
          recordWorkflowAlgorithmOutcomeLocked({
            runDir: canonicalRunDir,
            outcomesDir: canonicalOutcomesDir,
            snapshot,
          }),
      });
    } catch {
      return undefined;
    }
  });
}

async function recordWorkflowAlgorithmOutcomeLocked(input: {
  runDir: string;
  outcomesDir: string;
  snapshot: MatOSWorkflowRunSnapshot;
}): Promise<MatOSAlgorithmOutcomeRecord | undefined> {
  const { snapshot, runDir, outcomesDir } = input;
  const runId = requiredReference(snapshot.runId, "runId");
  const workflowRef = requiredReference(snapshot.workflowRef, "workflowRef");
  const runUpdatedAt = requiredReference(snapshot.updatedAt, "updatedAt");
  const currentIndex = await readOutcomeIndex(outcomesDir);
  const scanned = await scanStoredOutcomes({
    outcomesDir,
    runId,
    workflowRef,
  });
  const rebuiltIndex = reconstructedIndex(scanned.outcomes);
  const existing = [...scanned.outcomes]
    .reverse()
    .find(
      (item) =>
        item.record.status === snapshot.status &&
        item.record.runUpdatedAt === snapshot.updatedAt,
    );
  const cwd = snapshot.projectCwd ?? snapshot.workspaceDir ?? process.cwd();
  if (existing) {
    if (rebuiltIndex && !sameIndex(currentIndex, rebuiltIndex)) {
      await writeOutcomeIndex(outcomesDir, rebuiltIndex);
    }
    // Also repair a missing scope-ledger index after a process crash between
    // the run-local atomic commit and the scope-ledger append.
    await appendMatOSAlgorithmOutcome(cwd, existing.record);
    return existing.record;
  }

  const generation = scanned.maxObservedGeneration + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new Error("Workflow outcome generation exhausted");
  }
  const graphSnapshotRef = safeLocalOutcomeReference(
    snapshot.graphSnapshotPath,
  );
  const [
    manifestRead,
    budgetRead,
    artifactsRead,
    decisionsRead,
    eventsRead,
    graphRead,
    controllerFinalizeRead,
  ] =
    await Promise.all([
    readBoundRunManifest({ runDir, snapshot }),
    readJsonEvidence({
      runDir,
      name: "budget.json",
      maxBytes: RUN_BUDGET_MAX_BYTES,
    }),
    readJsonEvidence({
      runDir,
      name: "artifacts.json",
      maxBytes: RUN_ARTIFACTS_MAX_BYTES,
    }),
    readBoundRunDecisions({ runDir, snapshot }),
    readBoundWorkflowEvents({ runDir }),
    graphSnapshotRef
      ? readJsonEvidence({
          runDir,
          name: graphSnapshotRef,
          maxBytes: RUN_GRAPH_MAX_BYTES,
        })
      : Promise.resolve({ state: "corrupt" as const }),
    readJsonEvidence({
      runDir,
      name: "controllers/finalize.json",
      maxBytes: RUN_CONTROLLER_FINALIZE_MAX_BYTES,
    }),
  ]);
  const status = snapshot.status as MatOSAlgorithmOutcomeStatus;
  const manifest = manifestRead.value;
  const decisions = decisionsRead.value ?? [];
  const productionDecisions = decisions.filter(
    (item) =>
      (item as unknown as { applied?: unknown }).applied !== false,
  );
  const counterfactualDecisionRefs = [
    ...new Set(
      decisions
        .filter(
          (item) =>
            (item as unknown as { applied?: unknown }).applied === false,
        )
        .map((item) => boundedString(item.decisionId))
        .filter((item): item is string => Boolean(item)),
    ),
  ].slice(0, MAX_DECISION_REFS);
  const componentNodeEvidence = new Map(
    await Promise.all(
      (manifest?.components ?? []).map(async (component) => {
        const ref = `node-runs/${component.nodeId}/node-run.json`;
        return [
          component.nodeId,
          {
            ref,
            read: await readJsonEvidence({
              runDir,
              name: ref,
              maxBytes: RUN_NODE_ATTEMPT_MAX_BYTES,
            }),
          },
        ] as const;
      }),
    ),
  );
  const metricEvidence =
    budgetRead.state === "present"
      ? numberMetrics(budgetRead.value)
      : { corrupt: false, truncated: false };
  const artifactEvidence =
    artifactsRead.state === "present"
      ? sanitizedArtifacts(runDir, artifactsRead.value)
      : { refs: [], corrupt: false, truncated: false };
  const artifactRefs = artifactEvidence.refs;
  const graphValidationNodes =
    graphRead.state === "present"
      ? validationNodeIdsFromGraph(graphRead.value)
      : { nodeIds: [], corrupt: false, truncated: false };
  const validationAttempts = await validationAttemptEvidence({
    runDir,
    nodeIds: graphValidationNodes.nodeIds,
  });
  const events = eventsRead.value ?? [];
  const validationEventEvidence = eventReferenceEvidence(
    events,
    (type) => type.includes("validation"),
  );
  const evaluationEventEvidence = eventReferenceEvidence(
    events,
    (type) => type.includes("evaluation") || type.includes("benchmark"),
  );
  const feedbackEventEvidence = eventReferenceEvidence(
    events,
    (type) => type.includes("feedback"),
  );
  const explicitEvidenceValues = [
    snapshot.outputs,
    snapshot.provenance?.metadata,
  ];
  const explicitValidationEvidence = explicitReferenceEvidence(
    explicitEvidenceValues,
    "validationRefs",
  );
  const explicitEvaluationEvidence = explicitReferenceEvidence(
    explicitEvidenceValues,
    "evaluationRefs",
  );
  const componentValidationEvidence = explicitReferenceEvidence(
    productionDecisions,
    "validationRefs",
  );
  const componentEvaluationEvidence = explicitReferenceEvidence(
    productionDecisions,
    "evaluationRefs",
  );
  const explicitFeedbackEvidence = mergeReferenceEvidence(
    explicitReferenceEvidence(explicitEvidenceValues, "userFeedbackRefs"),
    explicitReferenceEvidence(explicitEvidenceValues, "feedbackRefs"),
  );
  const validationArtifactEvidence: ReferenceEvidence = {
    refs: artifactRefs
      .filter((artifact) => artifact.source === "validation")
      .map((artifact) => artifact.path ?? artifact.id)
      .filter((item): item is string => Boolean(item)),
    corrupt: false,
    truncated: false,
  };
  const evaluationArtifactEvidence: ReferenceEvidence = {
    refs: artifactRefs
      .filter(
        (artifact) =>
          artifact.source === "evaluation" || artifact.source === "benchmark",
      )
      .map((artifact) => artifact.path ?? artifact.id)
      .filter((item): item is string => Boolean(item)),
    corrupt: false,
    truncated: false,
  };
  const validationEvidence = mergeReferenceEvidence(
    validationArtifactEvidence,
    validationEventEvidence,
    validationAttempts.evidence,
    explicitValidationEvidence,
    componentValidationEvidence,
  );
  const evaluationEvidence = mergeReferenceEvidence(
    evaluationArtifactEvidence,
    evaluationEventEvidence,
    explicitEvaluationEvidence,
    componentEvaluationEvidence,
  );
  const userFeedbackEvidence = mergeReferenceEvidence(
    feedbackEventEvidence,
    explicitFeedbackEvidence,
  );
  const controllerOutcomeEvidence =
    controllerFinalizeRead.state === "present"
      ? controllerFinalizeEvidence(controllerFinalizeRead.value, manifest)
      : { refs: [], corrupt: false, truncated: false };
  const scientificEvidence = scientificMetricsEvidence(explicitEvidenceValues);
  const metrics = {
    ...(metricEvidence.metrics ?? {}),
    ...scientificEvidence.metrics,
  };
  const decisionRefs = [
    ...new Set(
      productionDecisions
        .map((item) => boundedString(item.decisionId))
        .filter((item): item is string => Boolean(item)),
    ),
  ].slice(0, MAX_DECISION_REFS);
  const componentDecisions = productionDecisions.filter(
    (item) => item.source === "asset-tool",
  );
  const pinnedComponentForDecision = (
    item: MatOSAlgorithmRunDecisionReference,
  ) =>
    manifest?.components.find(
      (component) =>
        component.nodeId === item.nodeId &&
        component.plane === item.algorithmPlane &&
        component.providerId === item.providerId &&
        component.providerVersion === item.providerVersion &&
        component.assetRef === item.assetRef &&
        component.configDigest === item.configDigest &&
        component.implementationDigest === item.implementationDigest &&
        manifest.manifestDigest === item.manifestDigest,
    );
  const invalidComponentDecisionCount = componentDecisions.filter(
    (item) => !pinnedComponentForDecision(item),
  ).length;
  const componentRefs: NonNullable<
    MatOSAlgorithmOutcomeRecord["componentRefs"]
  > = (manifest?.components ?? []).map((component) => {
    const matching = componentDecisions.filter(
      (item) => pinnedComponentForDecision(item)?.nodeId === component.nodeId,
    );
    const refsFor = (
      field: "evaluationRefs" | "validationRefs" | "metricRefs",
    ): string[] => [
      ...new Set(
        matching.flatMap((item) => {
          const raw = item[field];
          return Array.isArray(raw)
            ? raw
                .map((value) => safeOutcomeReference(value))
                .filter((value): value is string => Boolean(value))
            : [];
        }),
      ),
    ].slice(0, MAX_EVENT_REFS);
    return {
      nodeId: component.nodeId,
      plane: component.plane,
      providerId: component.providerId,
      providerVersion: component.providerVersion,
      assetRef: component.assetRef,
      configDigest: component.configDigest,
      implementationDigest: component.implementationDigest,
      assetManifestDigest: component.assetManifestDigest,
      entryDigest: component.entryDigest,
      providerDecisionRefs: [
        ...new Set(
          matching
            .map(item => safeOutcomeReference(item.providerDecisionId))
            .filter((item): item is string => Boolean(item)),
        ),
      ].slice(0, MAX_DECISION_REFS),
      decisionRefs: matching
        .map((item) => item.decisionId)
        .filter((item): item is string => Boolean(safeOutcomeReference(item)))
        .slice(0, MAX_DECISION_REFS),
      evaluationRefs: refsFor("evaluationRefs"),
      validationRefs: refsFor("validationRefs"),
      metricRefs: refsFor("metricRefs"),
      ...(component.runtimeRefs.length > 0
        ? { runtimeRefs: [...component.runtimeRefs] }
        : {}),
    };
  });
  const providerRefs = productionDecisions
    .map((item) => {
      if (item.source === "asset-tool") {
        const pinnedComponent = pinnedComponentForDecision(item);
        if (!pinnedComponent) return undefined;
        return {
          componentRef: pinnedComponent.assetRef,
          nodeId: pinnedComponent.nodeId,
          algorithmPlane: pinnedComponent.plane,
          providerId: pinnedComponent.providerId,
          source: item.source,
          providerVersion: pinnedComponent.providerVersion,
          configDigest: pinnedComponent.configDigest,
          implementationDigest: pinnedComponent.implementationDigest,
          assetRef: pinnedComponent.assetRef,
        };
      }
      const surfaceId = boundedString(item.surfaceId);
      const providerId = boundedString(item.providerId);
      const source = boundedString(item.source);
      if (!surfaceId || !providerId || !source) return undefined;
      const pinnedSurface = manifest?.surfaces.find(
        (surface) =>
          surface.surfaceId === surfaceId && surface.providerId === providerId,
      );
      const pinnedController =
        surfaceId === "run-controller" &&
        manifest?.controller?.providerId === providerId
          ? manifest.controller
          : undefined;
      return {
        surfaceId,
        providerId,
        source,
        ...(boundedString(item.fallback)
          ? { fallback: boundedString(item.fallback) }
          : {}),
        ...(boundedString(pinnedSurface?.version ?? pinnedController?.providerVersion)
          ? {
              providerVersion: boundedString(
                pinnedSurface?.version ?? pinnedController?.providerVersion,
              ),
            }
          : {}),
        ...(boundedString(pinnedSurface?.configDigest ?? pinnedController?.configDigest)
          ? {
              configDigest: boundedString(
                pinnedSurface?.configDigest ?? pinnedController?.configDigest,
              ),
            }
          : {}),
        ...(boundedString(
          pinnedSurface?.implementationDigest ??
            pinnedController?.implementationDigest,
        )
          ? {
              implementationDigest: boundedString(
                pinnedSurface?.implementationDigest ??
                  pinnedController?.implementationDigest,
              ),
            }
          : {}),
        ...(boundedString(pinnedSurface?.assetRef ?? pinnedController?.assetRef)
          ? {
              assetRef: boundedString(
                pinnedSurface?.assetRef ?? pinnedController?.assetRef,
              ),
            }
          : {}),
        ...(boundedString(manifest?.modelRefs?.[0])
          ? { modelId: boundedString(manifest?.modelRefs?.[0]) }
          : {}),
      };
    })
    .filter((item) => item !== undefined)
    .slice(0, MAX_DECISION_REFS) as NonNullable<
      MatOSAlgorithmOutcomeRecord["providerRefs"]
    >;
  const trace = sanitizedTrace(snapshot.trace);
  const terminalDecision = productionDecisions.at(-1);
  const terminalDecisionValue = terminalDecision as unknown as
    | Record<string, unknown>
    | undefined;
  const parentDecisionIds = Array.isArray(
    terminalDecisionValue?.parentDecisionIds,
  )
    ? [
        ...new Set(
          terminalDecisionValue.parentDecisionIds
            .map((item) => boundedString(item))
            .filter((item): item is string => Boolean(item)),
        ),
      ].slice(0, MAX_DECISION_REFS)
    : [];
  const missingRefs = new Set<string>();
  const corruptRefs = new Set<string>();
  const truncatedRefs = new Set<string>();
  if (manifestRead.state === "missing") {
    missingRefs.add("algorithm-manifest.json");
  } else if (manifestRead.state === "corrupt") {
    corruptRefs.add("algorithm-manifest.json");
  }
  if (decisionsRead.state === "missing") {
    missingRefs.add("algorithm-decisions.jsonl");
  } else if (decisionsRead.state === "corrupt") {
    corruptRefs.add("algorithm-decisions.jsonl");
  }
  if (decisionsRead.truncated) {
    truncatedRefs.add("algorithm-decisions.jsonl");
  }
  if (invalidComponentDecisionCount > 0) {
    corruptRefs.add("algorithm-decisions.jsonl#component-pin-mismatch");
  }
  for (const component of componentRefs) {
    const evidence = componentNodeEvidence.get(component.nodeId);
    if (!evidence || evidence.read.state === "missing") continue;
    if (
      evidence.read.state !== "present" ||
      !evidence.read.value ||
      typeof evidence.read.value !== "object" ||
      Array.isArray(evidence.read.value)
    ) {
      corruptRefs.add(evidence.ref);
      continue;
    }
    const nodeRun = evidence.read.value as Record<string, unknown>;
    if (
      nodeRun.nodeId !== component.nodeId ||
      typeof nodeRun.status !== "string"
    ) {
      corruptRefs.add(evidence.ref);
      continue;
    }
    if (nodeRun.status === "completed" && component.decisionRefs.length === 0) {
      missingRefs.add(
        `algorithm-decisions.jsonl#component:${component.nodeId}`,
      );
    }
  }
  if (budgetRead.state === "missing") {
    missingRefs.add("budget.json");
  } else if (budgetRead.state === "corrupt" || metricEvidence.corrupt) {
    corruptRefs.add("budget.json");
  }
  if (metricEvidence.truncated) truncatedRefs.add("budget.json");
  if (artifactsRead.state === "corrupt" || artifactEvidence.corrupt) {
    corruptRefs.add("artifacts.json");
  }
  if (artifactEvidence.truncated) truncatedRefs.add("artifacts.json");
  if (eventsRead.state === "missing") {
    missingRefs.add("events.jsonl");
  } else if (eventsRead.state === "corrupt") {
    corruptRefs.add("events.jsonl");
  }
  if (eventsRead.truncated) truncatedRefs.add("events.jsonl");
  if (graphRead.state === "missing") {
    missingRefs.add(graphSnapshotRef ?? "graph-snapshot");
  } else if (graphRead.state === "corrupt" || graphValidationNodes.corrupt) {
    corruptRefs.add(graphSnapshotRef ?? "graph-snapshot");
  }
  if (graphValidationNodes.truncated) {
    truncatedRefs.add(graphSnapshotRef ?? "graph-snapshot");
  }
  for (const ref of validationAttempts.missingRefs) missingRefs.add(ref);
  for (const ref of validationAttempts.corruptRefs) corruptRefs.add(ref);
  if (validationEvidence.corrupt) corruptRefs.add("validation-evidence");
  if (validationEvidence.truncated) truncatedRefs.add("validation-evidence");
  if (evaluationEvidence.corrupt) corruptRefs.add("evaluation-evidence");
  if (evaluationEvidence.truncated) truncatedRefs.add("evaluation-evidence");
  if (userFeedbackEvidence.corrupt) corruptRefs.add("user-feedback-evidence");
  if (userFeedbackEvidence.truncated) {
    truncatedRefs.add("user-feedback-evidence");
  }
  if (scientificEvidence.corrupt) corruptRefs.add("scientific-metrics");
  if (scientificEvidence.truncated) truncatedRefs.add("scientific-metrics");
  if (manifest?.controller && controllerFinalizeRead.state === "missing") {
    missingRefs.add("controllers/finalize.json");
  } else if (
    controllerFinalizeRead.state === "corrupt" ||
    controllerOutcomeEvidence.corrupt
  ) {
    corruptRefs.add("controllers/finalize.json");
  }
  if (controllerOutcomeEvidence.truncated) {
    truncatedRefs.add("controllers/finalize.json");
  }
  const evidenceReasons = [
    ...[...missingRefs].map((ref) => `missing:${ref}`),
    ...[...corruptRefs].map((ref) => `corrupt:${ref}`),
    ...[...truncatedRefs].map((ref) => `truncated:${ref}`),
  ].sort((left, right) => left.localeCompare(right));
  const evidenceComplete = evidenceReasons.length === 0;
  const evidenceCompleteness = {
    status: evidenceComplete ? ("complete" as const) : ("incomplete" as const),
    reasons: evidenceReasons,
    ...(missingRefs.size > 0
      ? { missingRefs: [...missingRefs].sort() }
      : {}),
    ...(truncatedRefs.size > 0
      ? { truncatedRefs: [...truncatedRefs].sort() }
      : {}),
    ...(corruptRefs.size > 0
      ? { corruptRefs: [...corruptRefs].sort() }
      : {}),
  };
  const attribution = attributeMatOSAlgorithmReward({
    decisionIds: decisionRefs,
    rewardValue: status === "completed" ? 1 : 0,
    objectiveRef: "evaluation:workflow-terminal-success@1",
    method: "terminal",
    confidence: evidenceComplete ? 1 : 0,
  });
  const uniqueProviderIds = [...new Set(providerRefs.map((item) => item.providerId))];
  const uniqueProviderVersions = [
    ...new Set(
      providerRefs
        .map((item) => item.providerVersion)
        .filter((item): item is string => Boolean(item)),
    ),
  ];
  const terminalPinnedComponent = [...componentDecisions]
    .reverse()
    .map((item) => pinnedComponentForDecision(item))
    .find((item) => Boolean(item));
  const algorithmIdentity = manifest
    ? terminalPinnedComponent
      ? {
          algorithmPlane: terminalPinnedComponent.plane,
          algorithmId: terminalPinnedComponent.providerId,
          algorithmVersion: terminalPinnedComponent.providerVersion,
          providerId: terminalPinnedComponent.providerId,
          providerVersion: terminalPinnedComponent.providerVersion,
          configDigest: terminalPinnedComponent.configDigest,
        }
      : manifest.controller
      ? {
          algorithmPlane: "controller" as const,
          algorithmId: manifest.controller.providerId,
          algorithmVersion: manifest.controller.providerVersion,
          providerId: manifest.controller.providerId,
          providerVersion: manifest.controller.providerVersion,
          configDigest: manifest.controller.configDigest,
        }
      : {
          algorithmPlane: "policy" as const,
          algorithmId:
            uniqueProviderIds.length === 1
              ? uniqueProviderIds[0]!
              : uniqueProviderIds.length > 1
                ? "workflow-policy-set"
                : "static-workflow-baseline",
          algorithmVersion:
            uniqueProviderIds.length === 1 && uniqueProviderVersions.length === 1
              ? uniqueProviderVersions[0]!
              : "1",
          ...(uniqueProviderIds.length === 1
            ? {
                providerId: uniqueProviderIds[0]!,
                ...(uniqueProviderVersions.length === 1
                  ? { providerVersion: uniqueProviderVersions[0]! }
                  : {}),
              }
            : {}),
          configDigest: manifest.configurationDigest,
        }
    : undefined;
  const trainingEligible =
    evidenceComplete &&
    Boolean(manifest) &&
    decisionRefs.length > 0 &&
    Boolean(algorithmIdentity);
  const manifestRuntimeRefs = manifest
    ? [manifest.runtimeRef, ...(manifest.runtimeRefs ?? [])]
        .map((item) => boundedString(item))
        .filter((item): item is string => Boolean(item))
    : [];
  const record: MatOSAlgorithmOutcomeRecord = {
    schemaVersion: 1,
    redacted: true,
    outcomeId: `workflow:${runId}:${generation}:${status}`,
    generation,
    runUpdatedAt,
    recordedAt: new Date().toISOString(),
    kind: "workflow-run",
    subject: {
      runId,
      workflowRef,
    },
    status,
    success: status === "completed",
    workflowRunId: runId,
    ...(terminalDecision
      ? {
          decisionId: terminalDecision.decisionId,
          ...(boundedString(terminalDecision.nodeId)
            ? { nodeId: boundedString(terminalDecision.nodeId) }
            : {}),
          ...(Number.isSafeInteger(terminalDecision.attempt) &&
          Number(terminalDecision.attempt) > 0
            ? { attempt: terminalDecision.attempt }
            : {}),
        }
      : {}),
    ...(parentDecisionIds.length > 0 ? { parentDecisionIds } : {}),
    decisionRefs,
    ...(counterfactualDecisionRefs.length > 0
      ? { counterfactualDecisionRefs }
      : {}),
    ...(algorithmIdentity ?? {}),
    ...(manifest
      ? {
          assetRefs: [
            ...new Set([
              workflowRef,
              ...manifest.surfaces
                .map((surface) => boundedString(surface.assetRef))
                .filter((item): item is string => Boolean(item)),
              ...(manifest.controller?.assetRefs ?? [])
                .map((item) => boundedString(item))
                .filter((item): item is string => Boolean(item)),
              ...manifest.components
                .map((component) => boundedString(component.assetRef))
                .filter((item): item is string => Boolean(item)),
            ]),
          ],
        }
      : {}),
    ...(manifestRuntimeRefs.length > 0
      ? {
          runtimeRefs: [...new Set(manifestRuntimeRefs)],
        }
      : {}),
    ...(manifest?.modelRefs && manifest.modelRefs.length > 0
      ? {
          modelId: manifest.modelRefs[0],
          modelRefs: [...manifest.modelRefs],
        }
      : {}),
    ...(providerRefs.length > 0 ? { providerRefs } : {}),
    ...(componentRefs.length > 0 ? { componentRefs } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    ...(budgetRead.state === "present" && !metricEvidence.corrupt
      ? { budgetRef: "budget.json" }
      : {}),
    ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
    ...(trace ? { trace } : {}),
    ...(trace?.scopeRef ?? manifest?.scopeRef
      ? { scopeRef: trace?.scopeRef ?? manifest?.scopeRef }
      : {}),
    ...(manifest ? { manifestPath: "algorithm-manifest.json" } : {}),
    ...(manifest
      ? {
          objective: {
            id: "workflow-terminal-success",
            version: "1",
            digest: manifest.configurationDigest,
          },
        }
      : {}),
    validationRefs: validationEvidence.refs,
    evaluationRefs: evaluationEvidence.refs,
    ...(controllerOutcomeEvidence.refs.length > 0
      ? { controllerOutcomeRefs: controllerOutcomeEvidence.refs }
      : {}),
    userFeedbackRefs: [...userFeedbackEvidence.refs],
    feedbackRefs: [...userFeedbackEvidence.refs],
    reward: attribution.reward,
    decisionAttributions: attribution.decisionAttributions,
    evidenceCompleteness,
    trainingEligible,
    provenanceRefs: [
      "run.json",
      "events.jsonl",
      graphSnapshotRef ?? "[redacted]",
      ...(controllerFinalizeRead.state === "present"
        ? ["controllers/finalize.json"]
        : []),
    ],
  };
  const redacted = redactTraceValue(record) as MatOSAlgorithmOutcomeRecord;
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > RUN_OUTCOME_MAX_BYTES) {
    throw new Error("Workflow outcome record exceeds its storage limit");
  }
  const ref = `${generation}-${status}.json`;
  await writeOutcomeStoreFileAtomic({
    rootDir: outcomesDir,
    path: join(outcomesDir, ref),
    content: serialized,
    exclusive: true,
  });
  const nextIndex = reconstructedIndex([
    ...scanned.outcomes,
    { ref, record: redacted },
  ]);
  if (!nextIndex) {
    throw new Error("Workflow outcome index reconstruction failed");
  }
  await writeOutcomeIndex(outcomesDir, nextIndex);
  // The run-local record is the durable causal evidence. The scope ledger is
  // an index and may be full or temporarily unavailable; indexing failure
  // must not erase a valid per-run outcome or affect workflow completion.
  await appendMatOSAlgorithmOutcome(cwd, redacted);
  return redacted;
}
