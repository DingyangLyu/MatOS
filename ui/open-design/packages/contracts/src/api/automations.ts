import type { JsonValue } from '../common.js';
import type { RunContextSelection } from './context.js';

export type AutomationTriggerKind =
  | 'manual'
  | 'schedule'
  | 'project-event';

export type AutomationSourceKind =
  | 'upload'
  | 'url'
  | 'repo'
  | 'artifact'
  | 'chat';

export type AutomationOutputSink =
  | 'skill'
  | 'automation-template'
  | 'artifact';

export type AutomationReviewPolicy =
  | 'always'
  | 'trusted-source'
  | 'auto-apply';

export type AutomationTokenCompressionMode =
  | 'off'
  | 'balanced'
  | 'aggressive';

export type AutomationTemplateStageKind =
  | 'ingest'
  | 'canonicalize'
  | 'redact'
  | 'compress'
  | 'classify'
  | 'propose'
  | 'agent-run'
  | 'apply'
  | 'notify';

export interface AutomationTemplateStage {
  id: string;
  kind: AutomationTemplateStageKind;
  title: string;
  description?: string;
  config?: JsonValue;
}

export interface AutomationTemplate {
  id: string;
  title: string;
  description: string;
  purpose: string;
  triggerKinds: AutomationTriggerKind[];
  sourceKinds: AutomationSourceKind[];
  stages: AutomationTemplateStage[];
  outputSinks: AutomationOutputSink[];
  reviewPolicy: AutomationReviewPolicy;
  tokenCompression: AutomationTokenCompressionMode;
  context?: RunContextSelection;
  tags?: string[];
}

export type AutomationProvenanceSourceKind =
  | AutomationSourceKind
  | 'automation-run'
  | 'skill';

export interface AutomationProvenanceRef {
  kind: AutomationProvenanceSourceKind;
  label: string;
  ref?: string;
  url?: string;
}

export type AutomationSensitivity =
  | 'public'
  | 'workspace'
  | 'private'
  | 'secret-adjacent';

export interface AutomationAttachmentRef {
  id: string;
  name: string;
  mimeType?: string;
  path?: string;
  sizeBytes?: number;
  tokenEstimate?: number;
}

export interface AutomationTokenStats {
  originalTokens: number;
  canonicalTokens?: number;
  compressedTokens?: number;
  compressionRatio?: number;
}

export interface AutomationContentPacket {
  id: string;
  sourceEventId: string;
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  title: string;
  capturedAt: string;
  bodyMarkdown: string;
  provenance: AutomationProvenanceRef[];
  attachments: AutomationAttachmentRef[];
  sensitivity: AutomationSensitivity;
  capabilityHints: string[];
  tokenStats: AutomationTokenStats;
  candidateSinks: AutomationOutputSink[];
  metadata?: JsonValue;
}

export type AutomationCompressionStatus =
  | 'not-run'
  | 'applied'
  | 'skipped'
  | 'failed';

export interface AutomationCompressionReport {
  mode: AutomationTokenCompressionMode;
  status: AutomationCompressionStatus;
  beforeTokens: number;
  afterTokens: number;
  summary: string;
  warnings?: string[];
  preservedSourcePacketId?: string;
}

export type AutomationProposalTargetKind =
  | 'skill'
  | 'automation-template';

export type AutomationProposalAction =
  | 'create'
  | 'update'
  | 'merge'
  | 'move'
  | 'delete'
  | 'promote';

export type AutomationProposalStatus =
  | 'draft'
  | 'pending-review'
  | 'applied'
  | 'rejected'
  | 'superseded'
  | 'failed';

export type AutomationProposalPatchFormat =
  | 'markdown'
  | 'json'
  | 'file-tree';

export interface AutomationProposalPatch {
  format: AutomationProposalPatchFormat;
  before?: string;
  after?: string;
  diffSummary?: string;
}

export interface AutomationEvolutionProposal {
  id: string;
  title: string;
  summary: string;
  targetKind: AutomationProposalTargetKind;
  action: AutomationProposalAction;
  status: AutomationProposalStatus;
  reviewPolicy: AutomationReviewPolicy;
  createdAt: string;
  updatedAt: string;
  sourcePacketIds: string[];
  automationRunId?: string;
  targetRef?: string;
  patch: AutomationProposalPatch;
  confidence?: number;
  compressionReport?: AutomationCompressionReport;
  metadata?: JsonValue;
}

export interface CreateAutomationEvolutionProposalRequest {
  title: string;
  summary: string;
  targetKind: AutomationProposalTargetKind;
  action: AutomationProposalAction;
  reviewPolicy?: AutomationReviewPolicy;
  sourcePacketIds?: string[];
  automationRunId?: string;
  targetRef?: string;
  patch: AutomationProposalPatch;
  confidence?: number;
  compressionReport?: AutomationCompressionReport;
  metadata?: JsonValue;
}

export interface AutomationTemplateListResponse {
  templates: AutomationTemplate[];
}

export interface CreateAutomationSourceIngestionRequest {
  templateId?: string;
  triggerKind?: AutomationTriggerKind;
  sourceKind: AutomationSourceKind;
  sourceRef?: string;
  title?: string;
  bodyMarkdown?: string;
  projectId?: string;
  artifactId?: string;
  conversationId?: string;
  sensitivity?: AutomationSensitivity;
  capabilityHints?: string[];
  candidateSinks?: AutomationOutputSink[];
  reviewPolicy?: AutomationReviewPolicy;
  tokenCompression?: AutomationTokenCompressionMode;
  metadata?: JsonValue;
}

export interface AutomationSourceIngestionResponse {
  packet: AutomationContentPacket;
  compressionReport: AutomationCompressionReport;
  proposals: AutomationEvolutionProposal[];
}

export interface AutomationEvolutionProposalListResponse {
  proposals: AutomationEvolutionProposal[];
}
