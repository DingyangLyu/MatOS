/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  ComputeJobReceipt,
  ComputeJobSpec,
  ComputeJobStatusTimelineEntry,
  MatOSWorkflowNode,
  ScientificDataSourceRef,
  ScientificPotentialProvenanceRef,
  WorkflowArtifactBundleRef,
  WorkflowArtifactRef,
} from '../types.js'

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalNumber(value: unknown): number | null | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordArray<T extends object>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value.filter(
    (item): item is T => item && typeof item === 'object' && !Array.isArray(item),
  )
  return items.length > 0 ? items.map(item => ({ ...item })) : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function logsFromPayload(payload: Record<string, unknown>): Record<string, string> | undefined {
  const explicit = stringRecord(payload.logs)
  if (explicit) {
    return explicit
  }
  const log = optionalString(payload.log)
  if (log) {
    return { scheduler: log }
  }
  return undefined
}

function artifactsFromPayload(value: unknown): WorkflowArtifactRef[] {
  const payload = metadataObject(value)
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  return artifacts
    .filter(
      (artifact): artifact is WorkflowArtifactRef =>
        artifact && typeof artifact === 'object' && !Array.isArray(artifact),
    )
    .map(artifact => ({ ...artifact }))
}

function artifactBundlesFromPayload(value: unknown): WorkflowArtifactBundleRef[] | undefined {
  const payload = metadataObject(value)
  return recordArray<WorkflowArtifactBundleRef>(
    payload.artifactBundles ?? payload.artifact_bundles ?? payload.resultBundles ?? payload.bundles,
  )
}

function scientificPotentialRefsFromPayload(
  value: unknown,
): ScientificPotentialProvenanceRef[] | undefined {
  const payload = metadataObject(value)
  return recordArray<ScientificPotentialProvenanceRef>(
    payload.pseudopotentialRefs ??
      payload.pseudopotential_refs ??
      payload.potentialRefs ??
      payload.potential_refs,
  )
}

function scientificDatasetRefsFromPayload(value: unknown): ScientificDataSourceRef[] | undefined {
  const payload = metadataObject(value)
  return recordArray<ScientificDataSourceRef>(
    payload.datasetRefs ?? payload.dataset_refs ?? payload.dataSourceRefs ?? payload.data_source_refs,
  )
}

function sourceForOperation(operation: string | undefined): ComputeJobStatusTimelineEntry['source'] {
  if (operation === 'submit' || operation === 'status' || operation === 'logs' || operation === 'cancel') {
    return operation
  }
  return 'runtime'
}

function statusTimelineFromPayload(input: {
  payload: Record<string, unknown>
  backendOutput: Record<string, unknown>
  source: ComputeJobStatusTimelineEntry['source']
  status?: string
  phase?: string
}): ComputeJobStatusTimelineEntry[] | undefined {
  const explicit = recordArray<ComputeJobStatusTimelineEntry>(
    input.payload.statusTimeline ??
      input.payload.status_timeline ??
      input.backendOutput.statusTimeline,
  )
  if (explicit) {
    return explicit
  }
  if (!input.status && !input.phase) {
    return undefined
  }
  return [{
    at: new Date().toISOString(),
    source: input.source,
    ...(input.status ? { status: input.status } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
  }]
}

function validationFromPayload(value: unknown): ComputeJobReceipt['validation'] | undefined {
  const validation = metadataObject(metadataObject(value).validation)
  return typeof validation.ok === 'boolean'
    ? validation as ComputeJobReceipt['validation']
    : undefined
}

export function normalizeComputeOperation(
  operation: string | undefined,
): string | undefined {
  return operation?.trim().replaceAll('_', '-').toLowerCase() || undefined
}

export function computeToolRefForSpec(_spec: ComputeJobSpec): string | undefined {
  // Adapters are selected explicitly by node.tool; no vendor is implicit.
  return undefined
}

export function computeJobSpecForNode(node: MatOSWorkflowNode): ComputeJobSpec {
  const input = metadataObject(node.input ?? node.toolInput ?? node.inputs)
  const backend = optionalString(node.backend) ?? 'unknown'
  const operation = normalizeComputeOperation(optionalString(node.operation))
  const metadata = metadataObject(node.metadata)

  return {
    backend,
    ...(operation ? { operation } : {}),
    ...(optionalString(node.codeFamily) ?? optionalString(input.codeFamily)
      ? { codeFamily: optionalString(node.codeFamily) ?? optionalString(input.codeFamily) }
      : {}),
    ...(optionalString(node.taskKind) ?? optionalString(input.taskKind)
      ? { taskKind: optionalString(node.taskKind) ?? optionalString(input.taskKind) }
      : {}),
    ...(optionalString(node.workdir) ?? optionalString(input.workdir)
      ? {
          workdir:
            optionalString(node.workdir) ?? optionalString(input.workdir),
        }
      : {}),
    ...(optionalString(node.remoteWorkdir) ??
    optionalString(input.remoteWorkdir) ??
    optionalString(input.remoteMountCodePath)
      ? {
          remoteWorkdir:
            optionalString(node.remoteWorkdir) ??
            optionalString(input.remoteWorkdir) ??
            optionalString(input.remoteMountCodePath),
        }
      : {}),
    ...(optionalString(node.image) ?? optionalString(input.image)
      ? { image: optionalString(node.image) ?? optionalString(input.image) }
      : {}),
    ...(optionalString(node.queue) ??
    optionalString(node.resourceQueueName) ??
    optionalString(input.resourceQueueName)
      ? {
          queue:
            optionalString(node.queue) ??
            optionalString(node.resourceQueueName) ??
            optionalString(input.resourceQueueName),
        }
      : {}),
    ...(optionalString(node.flavor) ?? optionalString(input.flavor)
      ? { flavor: optionalString(node.flavor) ?? optionalString(input.flavor) }
      : {}),
    ...(optionalString(node.command) ?? optionalString(input.entrypoint)
      ? {
          command:
            optionalString(node.command) ?? optionalString(input.entrypoint),
        }
      : {}),
    ...(optionalString(node.inputManifestDigest) ?? optionalString(input.inputManifestDigest)
      ? {
          inputManifestDigest:
            optionalString(node.inputManifestDigest) ?? optionalString(input.inputManifestDigest),
        }
      : {}),
    ...(optionalString(node.idempotencyKey) ?? optionalString(input.idempotencyKey)
      ? {
          idempotencyKey:
            optionalString(node.idempotencyKey) ?? optionalString(input.idempotencyKey),
        }
      : {}),
    ...(scientificPotentialRefsFromPayload(input)
      ? { pseudopotentialRefs: scientificPotentialRefsFromPayload(input) }
      : {}),
    ...(scientificDatasetRefsFromPayload(input)
      ? { datasetRefs: scientificDatasetRefsFromPayload(input) }
      : {}),
    inputs: input,
    metadata,
  }
}

export function computeJobReceiptFromBackendOutput(
  spec: ComputeJobSpec,
  backendOutput: Record<string, unknown>,
): ComputeJobReceipt {
  const payload = metadataObject(backendOutput.payload)
  const workdir =
    optionalString(payload.visibleWorkdir) ??
    optionalString(payload.workdir) ??
    spec.workdir
  const remoteWorkdir =
    optionalString(payload.remoteWorkdir) ?? spec.remoteWorkdir
  const jobId =
    optionalString(payload.jobId) ??
    optionalString(payload.jobID) ??
    optionalString(payload.job_id)
  const taskId =
    optionalString(payload.taskId) ??
    optionalString(payload.taskID) ??
    optionalString(payload.task_id) ??
    optionalString(payload.id)
  const status =
    optionalString(payload.status) ??
    optionalString(payload.state) ??
    optionalString(payload.phase) ??
    optionalString(backendOutput.status)
  const phase =
    optionalString(payload.phase) ??
    optionalString(payload.taskPhase) ??
    optionalString(payload.phaseHint) ??
    optionalString(backendOutput.phase)
  const logs = logsFromPayload(payload)
  const artifactBundles = artifactBundlesFromPayload(backendOutput.payload)
  const potentialRefs =
    scientificPotentialRefsFromPayload(backendOutput.payload) ??
    spec.pseudopotentialRefs ??
    spec.potentialRefs
  const datasetRefs =
    scientificDatasetRefsFromPayload(backendOutput.payload) ?? spec.datasetRefs
  const statusTimeline = statusTimelineFromPayload({
    payload,
    backendOutput,
    source: sourceForOperation(spec.operation),
    status,
    phase,
  })

  return {
    ok: backendOutput.ok === true,
    backend: optionalString(backendOutput.backend) ?? spec.backend,
    ...(spec.operation ? { operation: spec.operation } : {}),
    ...(optionalString(backendOutput.toolRef)
      ? { toolRef: optionalString(backendOutput.toolRef) }
      : {}),
    ...(optionalString(backendOutput.toolId)
      ? { toolId: optionalString(backendOutput.toolId) }
      : {}),
    ...(optionalNumber(backendOutput.exitCode) !== undefined
      ? { exitCode: optionalNumber(backendOutput.exitCode) }
      : {}),
    ...(optionalString(payload.taskDigest) ??
    optionalString(payload.expectedTaskDigest) ??
    optionalString(backendOutput.taskDigest)
      ? {
          taskDigest:
            optionalString(payload.taskDigest) ??
            optionalString(payload.expectedTaskDigest) ??
            optionalString(backendOutput.taskDigest),
        }
      : {}),
    ...(optionalString(payload.attemptId) ?? optionalString(backendOutput.attemptId)
      ? { attemptId: optionalString(payload.attemptId) ?? optionalString(backendOutput.attemptId) }
      : {}),
    ...(optionalString(payload.idempotencyKey) ??
    optionalString(backendOutput.idempotencyKey) ??
    spec.idempotencyKey
      ? {
          idempotencyKey:
            optionalString(payload.idempotencyKey) ??
            optionalString(backendOutput.idempotencyKey) ??
            spec.idempotencyKey,
        }
      : {}),
    ...(jobId ? { jobId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(workdir ? { workdir } : {}),
    ...(remoteWorkdir ? { remoteWorkdir } : {}),
    ...(status ? { status } : {}),
    ...(phase ? { phase } : {}),
    ...(statusTimeline ? { statusTimeline } : {}),
    ...(logs ? { logs } : {}),
    ...(optionalString(payload.artifactBundleRef) ?? optionalString(payload.resultBundleRef)
      ? {
          artifactBundleRef:
            optionalString(payload.artifactBundleRef) ?? optionalString(payload.resultBundleRef),
        }
      : {}),
    ...(artifactBundles ? { artifactBundles } : {}),
    ...(optionalString(payload.validationResultRef) ?? optionalString(payload.validation_ref)
      ? {
          validationResultRef:
            optionalString(payload.validationResultRef) ?? optionalString(payload.validation_ref),
        }
      : {}),
    ...(validationFromPayload(backendOutput.payload)
      ? { validation: validationFromPayload(backendOutput.payload) }
      : {}),
    cancelState: 'not_requested',
    reconcileState: 'not_needed',
    ...(metadataObject(payload.costSummary) && Object.keys(metadataObject(payload.costSummary)).length
      ? { costSummary: metadataObject(payload.costSummary) }
      : {}),
    ...(potentialRefs ? { pseudopotentialRefs: potentialRefs, potentialRefs } : {}),
    ...(datasetRefs ? { datasetRefs } : {}),
    artifacts: artifactsFromPayload(backendOutput.payload),
    diagnostics: metadataObject(backendOutput.diagnostics),
    payload: backendOutput.payload,
  }
}
