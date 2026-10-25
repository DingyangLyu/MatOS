import type { ChatRunStatusResponse } from './api/chat';
import type {
  AutomationCompressionReport,
  AutomationContentPacket,
  AutomationEvolutionProposal,
  AutomationSourceIngestionResponse,
  AutomationTemplate,
} from './api/automations';
import {
  buildProjectRawFileUrl,
  type ProjectFile,
} from './api/files';
import type { HealthResponse } from './api/registry';
import type { ApiErrorResponse, ApiValidationErrorDetails } from './errors';

export const exampleProjectFile: ProjectFile = {
  name: 'index.html',
  path: 'index.html',
  type: 'file',
  size: 1024,
  mtime: 1_713_000_000,
  kind: 'html',
  mime: 'text/html',
};

export const exampleChatRunStatusResponse: ChatRunStatusResponse = {
  id: 'run_1',
  projectId: 'project_1',
  conversationId: 'conversation_1',
  assistantMessageId: 'assistant_1',
  agentId: 'codex',
  status: 'succeeded',
  createdAt: 1_717_200_000_000,
  updatedAt: 1_717_200_030_000,
  exitCode: 0,
  signal: null,
  error: null,
  errorCode: null,
  eventsLogPath: null,
  toolBundle: { mcpServers: [] },
  promptCache: {
    stablePromptHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    hit: false,
    missReason: 'new-session',
  },
};

export const exampleProjectRawPreviewUrl = buildProjectRawFileUrl(
  'http://127.0.0.1:17456',
  'project_1',
  'screens/main page.html',
) ?? '';

export const exampleHealthResponse: HealthResponse = { ok: true, service: 'daemon' };

export const exampleAutomationTemplate: AutomationTemplate = {
  id: 'extract-skill',
  title: 'Extract skill',
  description: 'Turn a trusted source into a reviewable skill proposal.',
  purpose: 'Self-evolve project capabilities from source material and strong artifacts.',
  triggerKinds: ['manual', 'project-event'],
  sourceKinds: ['upload', 'url', 'repo', 'artifact'],
  stages: [
    { id: 'ingest', kind: 'ingest', title: 'Ingest source' },
    { id: 'canonicalize', kind: 'canonicalize', title: 'Canonicalize to Markdown' },
    { id: 'compress', kind: 'compress', title: 'Compact source context' },
    { id: 'propose', kind: 'propose', title: 'Draft skill proposal' },
  ],
  outputSinks: ['skill'],
  reviewPolicy: 'always',
  tokenCompression: 'balanced',
  tags: ['self-evolution', 'skill'],
};

export const exampleAutomationContentPacket: AutomationContentPacket = {
  id: 'packet_design_source_1',
  sourceEventId: 'source_event_1',
  sourceKind: 'repo',
  sourceRef: 'https://github.com/acme/notes',
  title: 'Acme source README',
  capturedAt: '2026-05-18T02:00:00.000Z',
  bodyMarkdown: '# Acme Notes\n\nKeep source decisions and constraints attached to the project.',
  capabilityHints: [],
  provenance: [
    {
      kind: 'repo',
      label: 'acme/notes README',
      ref: 'README.md',
      url: 'https://github.com/acme/notes/blob/main/README.md',
    },
  ],
  attachments: [],
  sensitivity: 'workspace',
  tokenStats: {
    originalTokens: 1800,
    canonicalTokens: 1800,
    compressedTokens: 720,
    compressionRatio: 0.4,
  },
  candidateSinks: ['skill'],
};

export const exampleAutomationCompressionReport: AutomationCompressionReport = {
  mode: 'balanced',
  status: 'applied',
  beforeTokens: 1800,
  afterTokens: 720,
  summary: 'Removed boilerplate and kept source decisions and links.',
  preservedSourcePacketId: 'packet_design_source_1',
};

export const exampleAutomationEvolutionProposal: AutomationEvolutionProposal = {
  id: 'proposal_acme_skill_1',
  title: 'Create Acme skill',
  summary: 'Draft a reusable skill from the Acme repo source packet.',
  targetKind: 'skill',
  action: 'create',
  status: 'pending-review',
  reviewPolicy: 'always',
  createdAt: '2026-05-18T02:02:00.000Z',
  updatedAt: '2026-05-18T02:02:00.000Z',
  sourcePacketIds: ['packet_design_source_1'],
  automationRunId: 'automation_run_1',
  targetRef: 'skills/acme/SKILL.md',
  patch: {
    format: 'markdown',
    after: '# Acme Skill\n\nReusable project procedure extracted from source material.',
    diffSummary: 'Creates a new skill proposal from the ingested source packet.',
  },
  confidence: 0.82,
  compressionReport: exampleAutomationCompressionReport,
};

export const exampleAutomationSourceIngestionResponse: AutomationSourceIngestionResponse = {
  packet: exampleAutomationContentPacket,
  compressionReport: exampleAutomationCompressionReport,
  proposals: [exampleAutomationEvolutionProposal],
};
