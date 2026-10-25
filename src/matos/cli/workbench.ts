import {classifyMatOSWorkbenchExternalIntakeSource} from '../workbench/externalIntakeDraftPack.js'
import {saveMatOSWorkbenchWorkflowTrigger,deleteMatOSWorkbenchWorkflowTrigger,getMatOSWorkbenchWorkflowTrigger} from '../workbench/workflows.js'
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

import { listMatOSWorkbenchWorkflows, listMatOSWorkbenchWorkflowTriggers } from '../workbench/workflows.js'
import { tickMatOSWorkflowTriggerScheduler, fireMatOSWorkbenchWorkflowTrigger } from '../workbench/workflowTriggerScheduler.js'
import { applyMatOSWorkbenchExternalIntakeDraftPack, previewMatOSWorkbenchExternalIntakeDraftPack } from '../workbench/externalIntakeDraftPack.js'
import {
  backfillMatOSWorkbenchFeedbackFromGit,
  listMatOSWorkbenchFeedback,
  readMatOSWorkbenchFeedbackAttachment,
  submitMatOSWorkbenchFeedback,
  updateMatOSWorkbenchFeedbackStatus,
} from '../workbench/feedback.js'
import { listMatOSWorkbenchModels } from '../workbench/models.js'

import { projectsCommand } from './workbenchProjectsCommand.js'
import {
  WORKBENCH_USAGE,
  context,
  parseArgs,
  writeResult,
  type ParsedWorkbenchArgs,
  type WorkbenchIO,
} from './workbenchCliShared.js'
// Provider LLM catalog for web/agent model pickers. Distinct from `roles`:
// a role decides prompts/tools/skills composition, this decides the
// underlying provider model (`matos --model <id>`).
async function modelsCommand(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    return writeResult(parsed, io, await listMatOSWorkbenchModels())
  }
  io.stderr(`Unknown matos workbench models command: ${subcommand}\n`)
  return 1
}

async function workflowsCommand(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  const first = parsed.positionals[2]
  const ctx = context(parsed, io)
  if (subcommand === 'list') {
    return writeResult(parsed, io, await listMatOSWorkbenchWorkflows({
      ...ctx,
      query: parsed.query,
      limit: parsed.limit,
      offset: parsed.offset,
      includeHidden: parsed.includeHidden,
      lightweight: parsed.lightweight,
    }))
  }
  if (subcommand === 'triggers' || subcommand === 'list-triggers') {
    return writeResult(parsed, io, await listMatOSWorkbenchWorkflowTriggers({
      ...ctx,
      workflowRef: first ?? '',
    }))
  }
  if (subcommand === 'trigger-scheduler' && (first ?? 'tick') === 'tick') {
    return writeResult(parsed, io, await tickMatOSWorkflowTriggerScheduler({
      ...ctx,
      now: parsed.now,
    }))
  }
if (subcommand === 'save-trigger') {
    let request: unknown = {}
    if (parsed.payloadJson) {
      try {
        request = JSON.parse(parsed.payloadJson) as unknown
      } catch (error) {
        io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }
    // Coze operate_publish_trigger carries trigger_id without workflow_id;
    // an omitted workflow ref is resolved from the trigger stores.
    const requestTriggerId =
      request && typeof request === 'object' && !Array.isArray(request)
        ? (request as Record<string, unknown>).trigger_id ??
          (request as Record<string, unknown>).triggerId
        : undefined
    if (!first && !requestTriggerId) {
      io.stderr('Usage: matos workbench workflows save-trigger <workflow-ref> --payload-json <json> [--json]\n')
      return 1
    }
    return writeResult(parsed, io, await saveMatOSWorkbenchWorkflowTrigger({
      ...ctx,
      workflowRef: first ?? '',
      request,
    }))
  }
if (subcommand === 'delete-trigger') {
    if (!parsed.jobId) {
      io.stderr('Usage: matos workbench workflows delete-trigger [workflow-ref] --trigger-id <id> [--json]\n')
      return 1
    }
    return writeResult(parsed, io, await deleteMatOSWorkbenchWorkflowTrigger({
      ...ctx,
      workflowRef: first ?? '',
      triggerId: parsed.jobId,
    }))
  }
if (subcommand === 'fire-trigger') {
    const triggerId = parsed.jobId || first
    if (!triggerId) {
      io.stderr('Usage: matos workbench workflows fire-trigger <trigger-id> [--json]\n')
      return 1
    }
    const detail = await getMatOSWorkbenchWorkflowTrigger({
      ...ctx,
      workflowRef: parsed.jobId ? first ?? '' : '',
      triggerId,
    })
    if (!detail.trigger) {
      io.stderr(`Workflow trigger ${triggerId} was not found.\n`)
      return 1
    }
    return writeResult(parsed, io, await fireMatOSWorkbenchWorkflowTrigger({
      ...ctx,
      trigger: detail.trigger,
    }))
  }
  io.stderr('Usage: matos workbench workflows list|triggers|trigger-scheduler tick [--json]\n')
  return 1
}

async function searchCommand(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
): Promise<number> {
  const subcommand = parsed.positionals[1]
  const sourcePath = parsed.positionals[2]
  const options = {
    ...context(parsed, io),
    path: sourcePath ?? '',
    packId: parsed.packId,
    ...(parsed.withBenchmark ? { withBenchmark: true } : {}),
    ...(parsed.executable ? { executable: true } : {}),
    ...(parsed.llmAssist ? { llmAssist: true } : {}),
    ...(parsed.model ? { llmAssistModel: parsed.model } : {}),
  }
if (
    subcommand === 'intake-classify' ||
    subcommand === 'classify-intake' ||
    subcommand === 'intake-classification'
  ) {
    const sourcePath = parsed.positionals[2]
    if (!sourcePath) {
      io.stderr('matos workbench search intake-classify requires <source-path>\n')
      return 1
    }
    return writeResult(parsed, io, await classifyMatOSWorkbenchExternalIntakeSource({
      ...context(parsed, io),
      path: sourcePath,
      ...(parsed.llmAssist ? { llmAssist: true } : {}),
      ...(parsed.model ? { llmAssistModel: parsed.model } : {}),
    }))
  }
  if (subcommand === 'intake-draft-apply' || (subcommand === 'intake-draft' && parsed.apply)) {
    if (!sourcePath || !parsed.fingerprint) {
      io.stderr('matos workbench search intake-draft-apply requires <source-path> --fingerprint <sha256>\n')
      return 1
    }
    return writeResult(parsed, io, await applyMatOSWorkbenchExternalIntakeDraftPack({
      ...options,
      fingerprint: parsed.fingerprint,
      reason: parsed.reason,
    }))
  }
  if (subcommand === 'intake-draft') {
    if (!sourcePath) {
      io.stderr('matos workbench search intake-draft requires <source-path>\n')
      return 1
    }
    return writeResult(parsed, io, await previewMatOSWorkbenchExternalIntakeDraftPack(options))
  }
  io.stderr('Usage: matos workbench search intake-draft|intake-draft-apply <source> [--json]\n')
  return 1
}

async function feedbackCommand(
  parsed: ParsedWorkbenchArgs,
  io: WorkbenchIO,
): Promise<number> {
  const subcommand = parsed.positionals[1] ?? 'list'
  if (subcommand === 'list') {
    return writeResult(
      parsed,
      io,
      await listMatOSWorkbenchFeedback({
        ...context(parsed, io),
        limit: parsed.limit,
        offset: parsed.offset,
      }),
    )
  }
  if (subcommand === 'submit' || subcommand === 'create') {
    if (!parsed.payloadJson) {
      io.stderr('Usage: matos workbench feedback submit --payload-json <json> [--json]\n')
      return 1
    }
    let request: unknown = {}
    try {
      request = JSON.parse(parsed.payloadJson) as unknown
    } catch (error) {
      io.stderr(`Invalid --payload-json: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    return writeResult(
      parsed,
      io,
      await submitMatOSWorkbenchFeedback({
        ...context(parsed, io),
        request,
      }),
    )
  }
  if (subcommand === 'backfill-git') {
    return writeResult(
      parsed,
      io,
      await backfillMatOSWorkbenchFeedbackFromGit({
        ...context(parsed, io),
        repositoryDir: parsed.path,
      }),
    )
  }
  if (subcommand === 'status') {
    const reportId = parsed.positionals[2]
    const status = parsed.positionals[3] ?? parsed.status
    if (!reportId || !status) {
      io.stderr('Usage: matos workbench feedback status <report-id> <open|triaged|in_progress|resolved|closed|rejected> [--json]\n')
      return 1
    }
    return writeResult(
      parsed,
      io,
      await updateMatOSWorkbenchFeedbackStatus({
        ...context(parsed, io),
        reportId,
        status,
      }),
    )
  }
  if (subcommand === 'attachment') {
    const reportId = parsed.positionals[2]
    const attachmentId = parsed.positionals[3]
    if (!reportId || !attachmentId) {
      io.stderr('Usage: matos workbench feedback attachment <report-id> <attachment-id> --json\n')
      return 1
    }
    return writeResult(
      parsed,
      io,
      await readMatOSWorkbenchFeedbackAttachment({
        ...context(parsed, io),
        reportId,
        attachmentId,
      }),
    )
  }
  io.stderr(`Unknown matos workbench feedback command: ${subcommand}\n`)
  return 1
}

export async function runMatOSWorkbenchCommand(
  args: string[],
  io: WorkbenchIO,
): Promise<number> {
  const parsed = parseArgs(args)
  if (parsed.error) {
    io.stderr(`${parsed.error}\n`)
    return 1
  }
  const command = parsed.positionals[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') {
    io.stdout(WORKBENCH_USAGE)
    return 0
  }
  try {
    if (command === 'models' || command === 'model') {
      return await modelsCommand(parsed, io)
    }
    if (command === 'workflows') {
      return await workflowsCommand(parsed, io)
    }
    if (command === 'projects' || command === 'project') {
      return await projectsCommand(parsed, io)
    }
    if (command === 'search') {
      return await searchCommand(parsed, io)
    }
    if (command === 'feedback') {
      return await feedbackCommand(parsed, io)
    }
    io.stderr(`Unknown matos workbench command: ${command}\n`)
    return 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
