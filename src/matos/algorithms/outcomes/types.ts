import type { MatOSTraceContext } from "../../sessions/traceContext.js";

export type MatOSAlgorithmOutcomeStatus = "completed" | "failed" | "cancelled";

export type MatOSAlgorithmPlane = "policy" | "controller" | "optimizer";

export type MatOSAlgorithmAttributionMethod =
  | "terminal"
  | "uniform"
  | "step"
  | "counterfactual"
  | "human"
  | (string & {});

export type MatOSAlgorithmReward = {
  value: number;
  objectiveRef: string;
  attributionMethod: MatOSAlgorithmAttributionMethod;
  /** Attribution implementations are data-producing algorithms and are pinned. */
  attributionVersion: string;
  confidence?: number;
};

export type MatOSAlgorithmDecisionAttribution = {
  decisionId: string;
  /** Fraction of the aggregate reward assigned to this decision. */
  credit: number;
  attributedValue: number;
};

export type MatOSAlgorithmEvidenceCompleteness = {
  status: "complete" | "incomplete";
  reasons: string[];
  missingRefs?: string[];
  truncatedRefs?: string[];
  corruptRefs?: string[];
};

export type MatOSAlgorithmOutcomeRecord = {
  schemaVersion: 1;
  redacted: true;
  outcomeId: string;
  generation: number;
  runUpdatedAt?: string;
  recordedAt: string;
  kind: "workflow-run" | "optimizer-run" | "evaluation" | "experiment" | "evolution-run";
  subject: {
    runId?: string;
    workflowRef?: string;
    optimizerRunId?: string;
    candidateRef?: string;
    evaluationRef?: string;
    experimentId?: string;
  };
  status: MatOSAlgorithmOutcomeStatus;
  success: boolean;
  decisionId?: string;
  parentDecisionIds?: string[];
  workflowRunId?: string;
  nodeId?: string;
  attempt?: number;
  decisionRefs: string[];
  /** Shadow/counterfactual decisions are evidence, never production reward targets. */
  counterfactualDecisionRefs?: string[];
  algorithmPlane?: MatOSAlgorithmPlane;
  algorithmId?: string;
  algorithmVersion?: string;
  providerId?: string;
  providerVersion?: string;
  assetRefs?: string[];
  runtimeRefs?: string[];
  configDigest?: string;
  modelId?: string;
  modelRefs?: string[];
  providerRefs?: Array<{
    surfaceId?: string;
    componentRef?: string;
    nodeId?: string;
    algorithmPlane?: MatOSAlgorithmPlane;
    providerId: string;
    source: string;
    fallback?: string;
    providerVersion?: string;
    configDigest?: string;
    implementationDigest?: string;
    assetRef?: string;
    modelId?: string;
  }>;
  /** Manifest-pinned ordinary tool components and their bounded evidence refs. */
  componentRefs?: Array<{
    nodeId: string;
    plane: MatOSAlgorithmPlane;
    providerId: string;
    providerVersion: string;
    assetRef: string;
    configDigest: string;
    implementationDigest: string;
    assetManifestDigest: string;
    entryDigest: string;
    /** Provider-local ids, never used as the authoritative runtime decision id. */
    providerDecisionRefs?: string[];
    decisionRefs: string[];
    evaluationRefs: string[];
    validationRefs: string[];
    metricRefs: string[];
    runtimeRefs?: string[];
  }>;
  objective?: {
    id: string;
    version: string;
    digest?: string;
  };
  metrics?: Record<string, number | string | boolean | null>;
  budgetRef?: string;
  artifactRefs?: Array<{
    id?: string;
    path?: string;
    sha256?: string;
    nodeId?: string;
    source?: string;
    redacted?: boolean;
  }>;
  validationRefs?: string[];
  evaluationRefs?: string[];
  /** Outcome/evidence refs returned by the manifest-pinned run controller. */
  controllerOutcomeRefs?: string[];
  userFeedbackRefs?: string[];
  /** @deprecated Use userFeedbackRefs. Retained for schema-v1 readers. */
  feedbackRefs?: string[];
  reward?: MatOSAlgorithmReward;
  decisionAttributions?: MatOSAlgorithmDecisionAttribution[];
  evidenceCompleteness?: MatOSAlgorithmEvidenceCompleteness;
  /** Incomplete evidence is never eligible for optimizer/training ingestion. */
  trainingEligible?: boolean;
  trace?: MatOSTraceContext;
  scopeRef?: string;
  manifestPath?: string;
  provenanceRefs: string[];
};

export type MatOSAlgorithmOutcomeFilter = {
  outcomeId?: string;
  runId?: string;
  optimizerRunId?: string;
  workflowRef?: string;
  traceId?: string;
  algorithmPlane?: MatOSAlgorithmPlane;
  algorithmId?: string;
  trainingEligible?: boolean;
  status?: MatOSAlgorithmOutcomeStatus;
  limit?: number;
};

export type MatOSAlgorithmOutcomeExport = {
  schemaVersion: 1;
  ledgerRef: "algorithms/outcomes.jsonl";
  format: "matos-algorithm-outcomes-v1";
  count: number;
  outcomes: MatOSAlgorithmOutcomeRecord[];
};
