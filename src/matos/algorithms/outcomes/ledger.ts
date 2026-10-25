import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { redactTraceValue } from "../../sessions/traceContext.js";
import { resolveMatOSRuntimeScope } from "../../runtime/scopes.js";
import { withKeyedMutex } from "../../workflows/asyncMutex.js";
import {
  ensureContainedOutcomeStoreDirectory,
  ensureRealOutcomeStoreRoot,
  isMissingOutcomeStorePath,
  readOutcomeStoreFile,
  withOutcomeStoreFileLock,
} from "./storeIo.js";
import type {
  MatOSAlgorithmOutcomeExport,
  MatOSAlgorithmOutcomeFilter,
  MatOSAlgorithmOutcomeRecord,
} from "./types.js";
import { matOSAlgorithmAttributionVersion } from "./attribution.js";

const OUTCOME_LEDGER_MAX_BYTES = 64 * 1024 * 1024;
const OUTCOME_RECORD_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_LENGTH = 4096;
const MAX_REFERENCE_COUNT = 4096;
const MAX_METRIC_COUNT = 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type MatOSAlgorithmOutcomeAccessOptions = {
  scopeRef?: string;
  env?: NodeJS.ProcessEnv;
  /** Set only after the caller has passed the gateway/operator admin check. */
  isAdmin?: boolean;
};

type OutcomeLocation = {
  scopeRef: string;
  storageBoundary: string;
  rootDir: string;
  algorithmsDir: string;
  path: string;
};

function ambientUserScopeRef(env: NodeJS.ProcessEnv): string {
  const explicit = env.MATOS_SCOPE_ID?.trim() || env.MATOS_SCOPE_REF?.trim();
  if (explicit && (!explicit.includes(":") || explicit.startsWith("user:"))) {
    return explicit;
  }
  return `user:${env.MATOS_USER_ID?.trim() || "local"}`;
}

function outcomeLocation(
  cwd: string,
  options: MatOSAlgorithmOutcomeAccessOptions,
): OutcomeLocation {
  const env = options.env ?? process.env;
  const ambient = resolveMatOSRuntimeScope(cwd, {
    scopeRef: ambientUserScopeRef(env),
    env,
  });
  const requested = options.scopeRef?.trim()
    ? resolveMatOSRuntimeScope(cwd, { scopeRef: options.scopeRef.trim(), env })
    : ambient;
  if (requested.ref !== ambient.ref && options.isAdmin !== true) {
    const error = new Error(
      `Algorithm outcome scope '${requested.ref}' is not the ambient runtime scope '${ambient.ref}'`,
    ) as Error & { code?: string };
    error.code = "MATOS_OUTCOME_SCOPE_FORBIDDEN";
    throw error;
  }
  const algorithmsDir = join(requested.rootDir, "algorithms");
  return {
    scopeRef: requested.ref,
    storageBoundary: dirname(dirname(dirname(requested.rootDir))),
    rootDir: requested.rootDir,
    algorithmsDir,
    path: join(algorithmsDir, "outcomes.jsonl"),
  };
}

export function matOSAlgorithmOutcomeLedgerPath(
  cwd: string,
  options: MatOSAlgorithmOutcomeAccessOptions = {},
): string {
  return outcomeLocation(cwd, options).path;
}

function outcomeReadError(
  code: string,
  message: string,
  cause?: unknown,
): Error & { code: string } {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as Error & {
    code: string;
  };
  error.code = code;
  return error;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validReference(value: unknown, maxLength = MAX_REFERENCE_LENGTH): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\0\r\n]/u.test(value) &&
    !isAbsolute(value) &&
    !/^[a-z]:[\\/]|^\\\\/iu.test(value)
  );
}

function validReferenceList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_REFERENCE_COUNT &&
    value.every((item) => validReference(item)) &&
    new Set(value).size === value.length
  );
}

function validOptionalReferenceList(value: unknown): boolean {
  return value === undefined || validReferenceList(value);
}

function validLocalRef(value: unknown): boolean {
  if (!validReference(value)) return false;
  const path = String(value);
  if (path === "[redacted]") return true;
  if (isAbsolute(path) || /^[a-z]:[\\/]|^\\\\/iu.test(path)) return false;
  return !path.split(/[\\/]+/u).some((segment) => segment === "..");
}

function validMetrics(value: unknown): boolean {
  if (value === undefined) return true;
  const metrics = recordValue(value);
  if (!metrics || Object.keys(metrics).length > MAX_METRIC_COUNT) return false;
  return Object.entries(metrics).every(([key, item]) => {
    if (!validReference(key, 128)) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    return typeof item === "string" && item.length <= MAX_REFERENCE_LENGTH;
  });
}

function validEvidenceCompleteness(value: unknown): boolean {
  if (value === undefined) return true;
  const evidence = recordValue(value);
  if (!evidence || !["complete", "incomplete"].includes(String(evidence.status))) {
    return false;
  }
  if (!validReferenceList(evidence.reasons)) return false;
  for (const key of ["missingRefs", "truncatedRefs", "corruptRefs"] as const) {
    if (!validOptionalReferenceList(evidence[key])) return false;
  }
  const issueCount =
    (evidence.missingRefs as unknown[] | undefined)?.length ?? 0;
  const truncatedCount =
    (evidence.truncatedRefs as unknown[] | undefined)?.length ?? 0;
  const corruptCount =
    (evidence.corruptRefs as unknown[] | undefined)?.length ?? 0;
  return evidence.status === "complete"
    ? (evidence.reasons as unknown[]).length === 0 &&
        issueCount + truncatedCount + corruptCount === 0
    : (evidence.reasons as unknown[]).length > 0;
}

function validRewardAndAttribution(record: Record<string, unknown>): boolean {
  if (record.reward === undefined) {
    return record.decisionAttributions === undefined;
  }
  const reward = recordValue(record.reward);
  if (
    !reward ||
    typeof reward.value !== "number" ||
    !Number.isFinite(reward.value) ||
    !validReference(reward.objectiveRef) ||
    !validReference(reward.attributionMethod, 128) ||
    !validReference(reward.attributionVersion, 128) ||
    (reward.confidence !== undefined &&
      (typeof reward.confidence !== "number" ||
        !Number.isFinite(reward.confidence) ||
        reward.confidence < 0 ||
        reward.confidence > 1))
  ) {
    return false;
  }
  const attributions = record.decisionAttributions;
  if (attributions === undefined) return true;
  if (!Array.isArray(attributions) || attributions.length > MAX_REFERENCE_COUNT) {
    return false;
  }
  const decisionRefs = Array.isArray(record.decisionRefs)
    ? (record.decisionRefs as unknown[])
    : [];
  const seen = new Set<string>();
  let totalCredit = 0;
  let totalValue = 0;
  for (const value of attributions) {
    const item = recordValue(value);
    if (
      !item ||
      !validReference(item.decisionId) ||
      seen.has(String(item.decisionId)) ||
      !decisionRefs.includes(item.decisionId) ||
      typeof item.credit !== "number" ||
      !Number.isFinite(item.credit) ||
      item.credit < 0 ||
      item.credit > 1 ||
      typeof item.attributedValue !== "number" ||
      !Number.isFinite(item.attributedValue)
    ) {
      return false;
    }
    seen.add(String(item.decisionId));
    totalCredit += item.credit;
    totalValue += item.attributedValue;
  }
  if (attributions.length === 0) return decisionRefs.length === 0;
  const epsilon = 1e-9;
  if (
    Math.abs(totalCredit - 1) > epsilon ||
    Math.abs(totalValue - Number(reward.value)) > epsilon
  ) {
    return false;
  }
  if (reward.attributionMethod === "terminal") {
    if (
      reward.attributionVersion !== matOSAlgorithmAttributionVersion("terminal") ||
      attributions.filter((item) => recordValue(item)?.credit === 1).length !== 1 ||
      attributions.some((item) => {
        const credit = Number(recordValue(item)?.credit);
        return credit !== 0 && credit !== 1;
      })
    ) {
      return false;
    }
  }
  if (reward.attributionMethod === "uniform") {
    if (
      reward.attributionVersion !== matOSAlgorithmAttributionVersion("uniform") ||
      attributions.some(
        (item) =>
          Math.abs(
            Number(recordValue(item)?.credit) - 1 / attributions.length,
          ) > epsilon,
      )
    ) {
      return false;
    }
  }
  return true;
}

function validProviderRefs(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= MAX_REFERENCE_COUNT &&
    value.every((item) => {
      const provider = recordValue(item);
      return (
        Boolean(provider) &&
        (provider?.surfaceId === undefined ||
          validReference(provider.surfaceId)) &&
        (provider?.componentRef === undefined ||
          validReference(provider.componentRef)) &&
        (provider?.nodeId === undefined || validReference(provider.nodeId)) &&
        (provider?.algorithmPlane === undefined ||
          ["policy", "controller", "optimizer"].includes(
            String(provider.algorithmPlane),
          )) &&
        (validReference(provider?.surfaceId) ||
          validReference(provider?.componentRef)) &&
        validReference(provider?.providerId) &&
        validReference(provider?.source) &&
        (provider?.fallback === undefined || validReference(provider.fallback)) &&
        (provider?.providerVersion === undefined ||
          validReference(provider.providerVersion)) &&
        (provider?.configDigest === undefined ||
          validReference(provider.configDigest)) &&
        (provider?.implementationDigest === undefined ||
          validReference(provider.implementationDigest)) &&
        (provider?.assetRef === undefined ||
          validReference(provider.assetRef)) &&
        (provider?.modelId === undefined || validReference(provider.modelId))
      );
    })
  );
}

function validComponentRefs(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= MAX_REFERENCE_COUNT &&
    value.every((item) => {
      const component = recordValue(item);
      return (
        Boolean(component) &&
        validReference(component?.nodeId) &&
        ["policy", "controller", "optimizer"].includes(
          String(component?.plane),
        ) &&
        validReference(component?.providerId) &&
        validReference(component?.providerVersion) &&
        validReference(component?.assetRef) &&
        validReference(component?.configDigest) &&
        validReference(component?.implementationDigest) &&
        validReference(component?.assetManifestDigest) &&
        validReference(component?.entryDigest) &&
        validOptionalReferenceList(component?.providerDecisionRefs) &&
        validReferenceList(component?.decisionRefs) &&
        validReferenceList(component?.evaluationRefs) &&
        validReferenceList(component?.validationRefs) &&
        validReferenceList(component?.metricRefs) &&
        validOptionalReferenceList(component?.runtimeRefs)
      );
    })
  );
}

function validArtifactRefs(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= MAX_REFERENCE_COUNT &&
    value.every((item) => {
      const artifact = recordValue(item);
      if (!artifact) return false;
      const known = [
        artifact.id,
        artifact.path,
        artifact.sha256,
        artifact.nodeId,
        artifact.source,
      ].filter((field) => field !== undefined);
      return (
        known.length > 0 &&
        (artifact.id === undefined || validReference(artifact.id)) &&
        (artifact.path === undefined || validLocalRef(artifact.path)) &&
        (artifact.sha256 === undefined || validReference(artifact.sha256, 256)) &&
        (artifact.nodeId === undefined || validReference(artifact.nodeId)) &&
        (artifact.source === undefined || validReference(artifact.source)) &&
        (artifact.redacted === undefined || artifact.redacted === true)
      );
    })
  );
}

export function validMatOSAlgorithmOutcomeRecord(
  value: unknown,
): value is MatOSAlgorithmOutcomeRecord {
  const record = recordValue(value);
  if (!record) return false;
  const subject = recordValue(record.subject);
  if (
    record.schemaVersion !== 1 ||
    record.redacted !== true ||
    !validReference(record.outcomeId) ||
    !Number.isSafeInteger(record.generation) ||
    Number(record.generation) <= 0 ||
    !validReference(record.recordedAt) ||
    !Number.isFinite(Date.parse(String(record.recordedAt))) ||
    !["workflow-run", "optimizer-run", "evaluation", "experiment", "evolution-run"].includes(
      String(record.kind),
    ) ||
    !subject ||
    !["completed", "failed", "cancelled"].includes(String(record.status)) ||
    typeof record.success !== "boolean" ||
    (record.success === true && record.status !== "completed") ||
    !validReferenceList(record.decisionRefs) ||
    !validReferenceList(record.provenanceRefs) ||
    !validMetrics(record.metrics) ||
    !validProviderRefs(record.providerRefs) ||
    !validComponentRefs(record.componentRefs) ||
    !validArtifactRefs(record.artifactRefs) ||
    !validEvidenceCompleteness(record.evidenceCompleteness) ||
    !validRewardAndAttribution(record)
  ) {
    return false;
  }
  if (
    (record.kind === "evolution-run" && !validReference(subject.runId)) ||
    (record.kind === "workflow-run" &&
      (!validReference(subject.runId) || !validReference(subject.workflowRef))) ||
    (record.kind === "optimizer-run" &&
      !validReference(subject.optimizerRunId ?? subject.runId)) ||
    (record.kind === "evaluation" && !validReference(subject.evaluationRef)) ||
    (record.kind === "experiment" && !validReference(subject.experimentId))
  ) {
    return false;
  }
  for (const field of [
    "parentDecisionIds",
    "counterfactualDecisionRefs",
    "assetRefs",
    "runtimeRefs",
    "modelRefs",
    "validationRefs",
    "evaluationRefs",
    "controllerOutcomeRefs",
    "userFeedbackRefs",
    "feedbackRefs",
  ] as const) {
    if (!validOptionalReferenceList(record[field])) return false;
  }
  for (const field of [
    "runUpdatedAt",
    "decisionId",
    "workflowRunId",
    "nodeId",
    "algorithmId",
    "algorithmVersion",
    "providerId",
    "providerVersion",
    "configDigest",
    "modelId",
    "scopeRef",
  ] as const) {
    if (record[field] !== undefined && !validReference(record[field])) return false;
  }
  if (
    record.decisionId !== undefined &&
    !(record.decisionRefs as string[]).includes(String(record.decisionId))
  ) {
    return false;
  }
  if (
    Array.isArray(record.counterfactualDecisionRefs) &&
    record.counterfactualDecisionRefs.some((decisionId) =>
      (record.decisionRefs as string[]).includes(String(decisionId)),
    )
  ) {
    return false;
  }
  if (
    record.workflowRunId !== undefined &&
    subject.runId !== undefined &&
    record.workflowRunId !== subject.runId
  ) {
    return false;
  }
  if (
    record.attempt !== undefined &&
    (!Number.isSafeInteger(record.attempt) || Number(record.attempt) <= 0)
  ) {
    return false;
  }
  if (
    record.algorithmPlane !== undefined &&
    !["policy", "controller", "optimizer"].includes(
      String(record.algorithmPlane),
    )
  ) {
    return false;
  }
  if (
    (record.algorithmPlane === undefined) !== (record.algorithmId === undefined)
  ) {
    return false;
  }
  if (
    record.manifestPath !== undefined &&
    !validLocalRef(record.manifestPath)
  ) {
    return false;
  }
  if (record.budgetRef !== undefined && !validLocalRef(record.budgetRef)) {
    return false;
  }
  if (record.trainingEligible !== undefined && typeof record.trainingEligible !== "boolean") {
    return false;
  }
  if (record.trainingEligible === true) {
    const evidence = recordValue(record.evidenceCompleteness);
    if (
      evidence?.status !== "complete" ||
      record.algorithmPlane === undefined ||
      !validReference(record.algorithmId) ||
      !validReference(record.algorithmVersion) ||
      !validReference(record.configDigest) ||
      record.reward === undefined
    ) {
      return false;
    }
  }
  try {
    return (
      Buffer.byteLength(JSON.stringify(record), "utf8") <=
      OUTCOME_RECORD_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function parsedOutcomeRecords(
  content: string,
  ledgerScopeRef: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    strict: boolean;
  },
): MatOSAlgorithmOutcomeRecord[] {
  const records: MatOSAlgorithmOutcomeRecord[] = [];
  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!validMatOSAlgorithmOutcomeRecord(value)) {
        if (options.strict) {
          throw outcomeReadError(
            "MATOS_OUTCOME_LEDGER_CORRUPT",
            `Algorithm outcome ledger contains an invalid record at line ${lineNumber}`,
          );
        }
        continue;
      }
      const record = value;
      if (record.scopeRef) {
        const normalized = resolveMatOSRuntimeScope(options.cwd, {
          scopeRef: record.scopeRef,
          env: options.env,
        }).ref;
        if (normalized !== ledgerScopeRef) {
          if (options.strict) {
            throw outcomeReadError(
              "MATOS_OUTCOME_LEDGER_CORRUPT",
              `Algorithm outcome ledger contains a cross-scope record at line ${lineNumber}`,
            );
          }
          continue;
        }
      }
      records.push(record);
    } catch (error) {
      if (
        options.strict &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "MATOS_OUTCOME_LEDGER_CORRUPT"
      ) {
        throw error;
      }
      if (options.strict) {
        throw outcomeReadError(
          "MATOS_OUTCOME_LEDGER_CORRUPT",
          `Algorithm outcome ledger contains malformed JSON at line ${lineNumber}`,
          error,
        );
      }
      // Skip corrupt/truncated rows and retain all readable outcome evidence.
    }
  }
  return records;
}

async function prepareOutcomeLocationForWrite(
  location: OutcomeLocation,
): Promise<OutcomeLocation> {
  const rootDir = await ensureRealOutcomeStoreRoot(
    location.rootDir,
    location.storageBoundary,
  );
  const algorithmsDir = await ensureContainedOutcomeStoreDirectory({
    rootDir,
    path: join(rootDir, "algorithms"),
  });
  return {
    ...location,
    rootDir,
    algorithmsDir,
    path: join(algorithmsDir, "outcomes.jsonl"),
  };
}

async function prepareOutcomeLocationForRead(
  location: OutcomeLocation,
): Promise<OutcomeLocation> {
  const rootDir = await ensureRealOutcomeStoreRoot(
    location.rootDir,
    location.storageBoundary,
  );
  const algorithmsDir = await ensureContainedOutcomeStoreDirectory({
    rootDir,
    path: join(rootDir, "algorithms"),
    create: false,
  });
  return {
    ...location,
    rootDir,
    algorithmsDir,
    path: join(algorithmsDir, "outcomes.jsonl"),
  };
}

async function readLedgerContent(location: OutcomeLocation): Promise<string> {
  try {
    return await readOutcomeStoreFile({
      rootDir: location.algorithmsDir,
      path: location.path,
      maxBytes: OUTCOME_LEDGER_MAX_BYTES,
    });
  } catch (error) {
    if (isMissingOutcomeStorePath(error)) return "";
    throw error;
  }
}

export async function appendMatOSAlgorithmOutcome(
  cwd: string,
  record: MatOSAlgorithmOutcomeRecord,
  options: Omit<MatOSAlgorithmOutcomeAccessOptions, "scopeRef"> = {},
): Promise<boolean> {
  try {
    if (!validMatOSAlgorithmOutcomeRecord(record)) return false;
    const location = await prepareOutcomeLocationForWrite(
      outcomeLocation(cwd, {
        scopeRef: record.scopeRef,
        env: options.env,
        isAdmin: options.isAdmin,
      }),
    );
    const redacted = redactTraceValue(record) as MatOSAlgorithmOutcomeRecord;
    if (record.scopeRef) redacted.scopeRef = location.scopeRef;
    if (!validMatOSAlgorithmOutcomeRecord(redacted)) return false;
    const line = `${JSON.stringify(redacted)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > OUTCOME_LEDGER_MAX_BYTES) return false;
    return await withKeyedMutex(`algorithm-outcomes:${location.path}`, () =>
      withOutcomeStoreFileLock({
        rootDir: location.algorithmsDir,
        name: ".outcomes-write",
        run: async (algorithmsDir) => {
          const lockedLocation = {
            ...location,
            algorithmsDir,
            path: join(algorithmsDir, "outcomes.jsonl"),
          };
          const content = await readLedgerContent(lockedLocation);
          if (
            parsedOutcomeRecords(content, location.scopeRef, {
              cwd,
              env: options.env ?? process.env,
              strict: false,
            }).some((item) => item.outcomeId === redacted.outcomeId)
          ) {
            return true;
          }
          if (
            Buffer.byteLength(content, "utf8") + lineBytes >
            OUTCOME_LEDGER_MAX_BYTES
          ) {
            return false;
          }
          const handle = await open(
            lockedLocation.path,
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_CREAT |
              O_NOFOLLOW,
            0o600,
          );
          try {
            const info = await handle.stat();
            if (
              !info.isFile() ||
              info.size + lineBytes > OUTCOME_LEDGER_MAX_BYTES
            ) {
              return false;
            }
            const written = await handle.write(line);
            if (written.bytesWritten !== lineBytes) {
              throw new Error("Algorithm outcome ledger append was incomplete");
            }
            await handle.sync();
            return true;
          } finally {
            await handle.close();
          }
        },
      }),
    );
  } catch {
    return false;
  }
}

async function readMatOSAlgorithmOutcomesInternal(
  cwd: string,
  filter: MatOSAlgorithmOutcomeFilter = {},
  options: MatOSAlgorithmOutcomeAccessOptions = {},
  strict: boolean,
): Promise<MatOSAlgorithmOutcomeRecord[]> {
  let content: string;
  let scopeRef: string;
  try {
    const location = await prepareOutcomeLocationForRead(
      outcomeLocation(cwd, options),
    );
    scopeRef = location.scopeRef;
    content = await withKeyedMutex(`algorithm-outcomes:${location.path}`, () =>
      withOutcomeStoreFileLock({
        rootDir: location.algorithmsDir,
        name: ".outcomes-write",
        run: (algorithmsDir) =>
          readLedgerContent({
            ...location,
            algorithmsDir,
            path: join(algorithmsDir, "outcomes.jsonl"),
          }),
      }),
    );
  } catch (error) {
    if (isMissingOutcomeStorePath(error)) return [];
    if (strict) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "MATOS_OUTCOME_SCOPE_FORBIDDEN"
      ) {
        throw error;
      }
      throw outcomeReadError(
        "MATOS_OUTCOME_LEDGER_INACCESSIBLE",
        "Algorithm outcome ledger could not be read safely",
        error,
      );
    }
    return [];
  }
  const records = parsedOutcomeRecords(content, scopeRef, {
    cwd,
    env: options.env ?? process.env,
    strict,
  }).filter((record) => {
    if (filter.outcomeId && record.outcomeId !== filter.outcomeId) return false;
    if (filter.runId && record.subject.runId !== filter.runId) return false;
    if (
      filter.optimizerRunId &&
      (record.subject.optimizerRunId ?? record.subject.runId) !==
        filter.optimizerRunId
    ) {
      return false;
    }
    if (
      filter.workflowRef &&
      record.subject.workflowRef !== filter.workflowRef
    ) {
      return false;
    }
    if (filter.traceId && record.trace?.traceId !== filter.traceId)
      return false;
    if (
      filter.algorithmPlane &&
      record.algorithmPlane !== filter.algorithmPlane
    ) {
      return false;
    }
    if (filter.algorithmId && record.algorithmId !== filter.algorithmId) {
      return false;
    }
    if (
      filter.trainingEligible !== undefined &&
      record.trainingEligible !== filter.trainingEligible
    ) {
      return false;
    }
    if (filter.status && record.status !== filter.status) return false;
    return true;
  });
  const limit = filter.limit ?? records.length;
  return limit > 0 ? records.slice(-limit) : [];
}

export async function readMatOSAlgorithmOutcomes(
  cwd: string,
  filter: MatOSAlgorithmOutcomeFilter = {},
  options: MatOSAlgorithmOutcomeAccessOptions = {},
): Promise<MatOSAlgorithmOutcomeRecord[]> {
  return readMatOSAlgorithmOutcomesInternal(cwd, filter, options, false);
}

/**
 * Operator/CLI read surface that distinguishes an empty ledger from a ledger
 * that is inaccessible, unsafe, or corrupt. Runtime attribution should retain
 * the fail-soft read API above so evidence indexing cannot fail a workflow.
 */
export async function readMatOSAlgorithmOutcomesStrict(
  cwd: string,
  filter: MatOSAlgorithmOutcomeFilter = {},
  options: MatOSAlgorithmOutcomeAccessOptions = {},
): Promise<MatOSAlgorithmOutcomeRecord[]> {
  return readMatOSAlgorithmOutcomesInternal(cwd, filter, options, true);
}

export async function exportMatOSAlgorithmOutcomes(
  cwd: string,
  filter: MatOSAlgorithmOutcomeFilter = {},
  options: MatOSAlgorithmOutcomeAccessOptions = {},
): Promise<MatOSAlgorithmOutcomeExport> {
  const outcomes = await readMatOSAlgorithmOutcomesStrict(
    cwd,
    filter,
    options,
  );
  return {
    schemaVersion: 1,
    ledgerRef: "algorithms/outcomes.jsonl",
    format: "matos-algorithm-outcomes-v1",
    count: outcomes.length,
    outcomes,
  };
}
