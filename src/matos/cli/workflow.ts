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

import { decideMatOSWorkflowOptimize } from '../algorithms/surfaces/workflowOptimize.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from '../workflows/types.js'
import { matOSWorkflowService } from '../workflows/workflowService.js'
import {
  approveWorkflowNode,
  cancelWorkflowRun,
  denyWorkflowNode,
  inspectWorkflowApprovalStatus,
  inspectWorkflowRun,
  pauseWorkflowRun,
  respondToWorkflowNode,
  resumeWorkflowRun,
  retryWorkflowNode,
  skipWorkflowNode,
  startWorkflowRun,
} from '../workflows/workflowRuntime.js'
import {
  readWorkflowRunEvents,
} from '../workflows/workflowStore.js'
import { spawnDetachedWorkflowAdvance } from '../workflows/detachedRunner.js'
import { installMatOSCrashCapture } from '../support/crashCapture.js'
import {
  listWorkflowNodeTemplates,
  workflowNodeTemplateById,
} from '../workflows/nodeTemplates.js'
import { registerWorkflowRunWatch } from '../workflows/runPulse.js'
import { buildWorkflowPreflight } from '../workflows/workflowPreflight.js'
import {
  CONTAINER_WORKFLOW_LIFECYCLE_COMMANDS,
  containerLifecycleArgv,
  draftMutationStatus,
  isHelpSubcommand,
  jsonPayload,
  parseArgs,
  parseMessage,
  printWorkflowDraftHelp,
  printWorkflowHelp,
  runDirForRunId,
  runWorkflowCommandInContainer,
  workflowDraftUsage,
  workflowServiceContext,
  writeJson,
  type MatOSWorkflowIO,
  type MatOSWorkflowTaskRunner,
  type ParsedArgs,
} from './workflowCliShared.js'
import {
  compileWorkflow,
  listWorkflows,
  showWorkflow,
  validateWorkflow,
} from './workflowDefinitionCommands.js'

async function compileInspectWorkflow(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow compile-inspect <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.compileInspect({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, result)
      return result.ok ? 0 : 1
    }
    io.stdout(
      `${result.workflowRef ?? runId}\t${result.ok ? 'compiled' : 'invalid'}\t${result.metadata.nodeCount} nodes\t${result.metadata.risk} risk\n`,
    )
    for (const diagnostic of result.diagnostics) {
      io.stderr(
        `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}${diagnostic.nodeId ? ` (${diagnostic.nodeId})` : ''}\n`,
      )
    }
    return result.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function contractWorkflow(
  io: MatOSWorkflowIO,
  target: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!target) {
    io.stderr('Usage: matos workflow contract <workflow-ref|runId|draft:draftId>\n')
    return 1
  }

  try {
    const input =
      target.startsWith('draft:')
        ? {
            ...workflowServiceContext(io, parsed.scope),
            draftId: target.slice('draft:'.length),
          }
        : target.startsWith('workflow:')
          ? {
              ...workflowServiceContext(io, parsed.scope),
              ref: target,
            }
          : {
              ...workflowServiceContext(io, parsed.scope),
              runId: target,
            }
    const result = await matOSWorkflowService.contracts(input)
    if (parsed.json) {
      writeJson(io, result)
      return 0
    }
    const artifactSummary = result.artifacts.reduce<Record<string, number>>(
      (counts, artifact) => {
        counts[artifact.status] = (counts[artifact.status] ?? 0) + 1
        return counts
      },
      {},
    )
    io.stdout(
      `${result.workflowRef ?? result.runId ?? result.draftId ?? target}\t${result.source}\t${Object.keys(result.contracts.nodes).length} nodes\t${result.artifacts.length} artifact contracts\n`,
    )
    for (const [status, count] of Object.entries(artifactSummary)) {
      io.stdout(`${status}\t${count}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runWorkflow(
  io: MatOSWorkflowIO,
  reference: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos workflow run <workflow-ref>\n')
    return 1
  }

  if (parsed.execution === 'container') {
    const argv = [
      '/app/bin/matos',
      'workflow',
      'run',
      reference,
      ...(parsed.scope ? ['--scope', parsed.scope] : []),
      ...parsed.paramArgs.flatMap(param => ['--param', param]),
      ...(parsed.detach ? ['--detach'] : []),
      ...(parsed.json ? ['--json'] : []),
    ]
    return runWorkflowCommandInContainer(io, parsed, argv)
  }

  try {
    const validation = await matOSWorkflowService.validate({
      ...workflowServiceContext(io, parsed.scope),
      ref: reference,
    })
    if (!validation.ok) {
      if (parsed.json) {
        writeJson(io, validation)
      } else {
        for (const error of validation.errors) {
          io.stderr(`${error.code}: ${error.message}\n`)
        }
      }
      return 1
    }

    // --detach: create the run in `created` state, hand execution to a
    // detached `matos workflow resume` worker, and return the runId right
    // away. Same deferred-start path the agent-facing workflow_run tool uses
    // with wait=false, so daemon/UI callers can poll instead of blocking.
    if (parsed.detach) {
      const { run } = await matOSWorkflowService.run({
        ...workflowServiceContext(io, parsed.scope),
        ref: reference,
        parameters: parsed.params,
        recordSession: false,
        advance: false,
      })
      const detach = spawnDetachedWorkflowAdvance({
        cwd: io.cwd,
        scopeRef: parsed.scope,
        sessionId: (io.env ?? process.env).MATOS_WORKFLOW_SESSION_ID,
        run,
      })
      // Same push-notification registration as the agent tool path, so an
      // interactive session in this cwd is told when the run settles.
      await registerWorkflowRunWatch({
        cwd: io.cwd,
        sessionId: (io.env ?? process.env).MATOS_WORKFLOW_SESSION_ID,
        runId: run.runId,
        runDir: run.runDir,
        workflowRef: reference,
      })
      if (parsed.json) {
        writeJson(io, {
          run,
          detached: detach.ok,
          ...(detach.ok === false ? { detachError: detach.error } : {}),
        })
      } else {
        io.stdout(`${run.runId}\t${run.status}\tdetached=${detach.ok}\n`)
        if (detach.ok === false) {
          io.stderr(
            `Background worker failed to start: ${detach.error}. Advance with \`matos workflow resume ${run.runId}\`.\n`,
          )
        }
      }
      return detach.ok ? 0 : 1
    }

    const { run } = await matOSWorkflowService.run({
      ...workflowServiceContext(io, parsed.scope),
      ref: reference,
      parameters: parsed.params,
    })

    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function templatesWorkflowCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): number {
  const templateId = parsed.id ?? parsed.positionals[0]
  if (templateId) {
    const template = workflowNodeTemplateById(templateId)
    if (!template) {
      io.stderr(
        `Unknown workflow node template: ${templateId}\nAvailable: ${listWorkflowNodeTemplates()
          .map(item => item.id)
          .join(', ')}\n`,
      )
      return 1
    }
    if (parsed.json) {
      writeJson(io, { template })
    } else {
      io.stdout(`${template.id}\t${template.nodeType}\t${template.title}\n`)
      io.stdout(`${template.usage}\n`)
      io.stdout(`${JSON.stringify(template.node, null, 2)}\n`)
    }
    return 0
  }
  const templates = listWorkflowNodeTemplates()
  if (parsed.json) {
    writeJson(io, {
      templates: templates.map(template => ({
        id: template.id,
        title: template.title,
        nodeType: template.nodeType,
        tags: template.tags,
        description: template.description,
        parameterKeys: Object.keys(template.parameters),
      })),
    })
  } else {
    for (const template of templates) {
      io.stdout(
        `${template.id}\t${template.nodeType}\t[${template.tags.join(',')}]\t${template.title}\n`,
      )
    }
  }
  return 0
}

async function authorWorkflowCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  const id = parsed.id ?? parsed.positionals[0]
  if (
    !id ||
    (parsed.definitionJson === undefined && parsed.definitionFile === undefined)
  ) {
    io.stderr(
      'Usage: matos workflow author --id <workflow-id> (--definition-json <json> | --definition-file <path|->) [--name <name>] [--version <version>] [--description <text>] [--no-publish] [--scope <scope-ref>] [--json]\n',
    )
    return 1
  }

  try {
    const definition = (await jsonPayload(
      parsed.definitionJson,
      parsed.definitionFile,
      io.cwd,
      io.stdin,
    )) as MatOSWorkflowDefinition
    const result = await matOSWorkflowService.author({
      ...workflowServiceContext(io, parsed.scope),
      id,
      definition,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      publish: parsed.noPublish ? false : undefined,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.workflowRef ?? `draft:${result.draftId}`}\t${
          result.validation.ok ? (result.published ? 'published' : 'validated') : 'invalid'
        }\n`,
      )
      for (const error of result.validation.errors) {
        io.stderr(`${error.code}: ${error.message}\n`)
      }
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Invalid workflow draft mutation:')) {
      io.stderr(
        `Invalid workflow definition: ${message
          .slice('Invalid workflow draft mutation:'.length)
          .trim()}\n`,
      )
    } else {
      io.stderr(`${message}\n`)
    }
    return 1
  }
}

async function waitWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr(
      'Usage: matos workflow wait <runId> [--timeout-seconds <n>] [--since-event <eventId>] [--json]\n',
    )
    return 1
  }

  try {
    const timeoutRaw = Number(parsed.timeoutSeconds)
    const result = await matOSWorkflowService.wait({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      timeoutSeconds: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
      sinceEventId: parsed.sinceEvent,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      const { pulse } = result
      io.stdout(
        `${pulse.runId}\t${pulse.stalled ? 'stalled' : pulse.status}\t${pulse.progress.settledNodes}/${pulse.progress.totalNodes} nodes\t${result.timedOut ? 'timed-out' : 'settled'}\n`,
      )
      for (const line of pulse.guidance) {
        io.stdout(`${line}\n`)
      }
    }
    // Timed-out is not a failure: the run is simply still executing.
    return result.pulse.status === 'failed' || result.pulse.stalled ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function preflightWorkflow(
  io: MatOSWorkflowIO,
  reference: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos workflow preflight <workflow-ref> [--param key=value]\n')
    return 1
  }

  if (parsed.execution === 'container') {
    const argv = [
      '/app/bin/matos',
      'workflow',
      'preflight',
      reference,
      ...(parsed.scope ? ['--scope', parsed.scope] : []),
      ...parsed.paramArgs.flatMap(param => ['--param', param]),
      ...(parsed.json ? ['--json'] : []),
    ]
    return runWorkflowCommandInContainer(io, parsed, argv)
  }

  try {
    const result = await buildWorkflowPreflight({
      ...workflowServiceContext(io, parsed.scope),
      ref: reference,
      parameters: parsed.params,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.workflowRef ?? reference}\t${result.runnable ? 'runnable' : 'blocked'}\t${result.summary.errorCount} errors\t${result.summary.warningCount} warnings\n`,
      )
      for (const issue of result.issues) {
        const write = issue.severity === 'error' ? io.stderr : io.stdout
        write(`${issue.severity}:${issue.code}: ${issue.message}\n`)
      }
    }
    return result.runnable ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// Recent run rows (summary detail: snapshot projection only, no per-row
// inspect/event reads). Serves the Studio run picker and quick CLI checks;
// use status/inspect on one runId for live progress and node detail.
async function listWorkflowRunsCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  try {
    const list = await matOSWorkflowService.listRuns({
      ...workflowServiceContext(io, parsed.scope),
      query: parsed.positionals[0],
      limit: 50,
      offset: 0,
      detail: 'summary',
    })
    const rows = list.runs.map(item => ({
      runId: item.snapshot.runId,
      workflowRef: item.snapshot.workflowRef,
      status: item.snapshot.status,
      createdAt: item.snapshot.createdAt,
      updatedAt: item.snapshot.updatedAt,
      ...(item.snapshot.waitingNodeId
        ? { waitingNodeId: item.snapshot.waitingNodeId }
        : {}),
    }))
    if (parsed.json) {
      writeJson(io, { runs: rows, summary: list.summary })
    } else {
      for (const row of rows) {
        io.stdout(`${row.runId}\t${row.status}\t${row.workflowRef}\t${row.updatedAt}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function statusWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow status <runId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.status({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function inspectWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow inspect <runId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.inspect({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
      for (const node of run.nodes ?? []) {
        io.stdout(`${node.nodeId}\t${node.status}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function eventsWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow events <runId>\n')
    return 1
  }

  try {
    const { events } = await matOSWorkflowService.events({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      ...(parsed.tail !== undefined ? { tail: Number(parsed.tail) } : {}),
    })
    if (parsed.json) {
      writeJson(io, { events })
    } else {
      for (const event of events) {
        io.stdout(`${event.timestamp}\t${event.type}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function recoverWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow recover <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.recover({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.recovery.runId}\t${result.recovery.classification}\t${result.recovery.recommendedAction}\n`,
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function recoverApplyWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow recover-apply <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.recoverApply({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.recovery.runId}\t${result.recovery.classification}\t${result.appliedAction}\t${result.run.status}\n`,
      )
    }
    return result.run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function recoverQueueWorkflowCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  try {
    const result = await matOSWorkflowService.recoverQueue({
      ...workflowServiceContext(io, parsed.scope),
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      if (result.jobs.length === 0) {
        io.stdout('No workflow remote recovery jobs found\n')
      } else {
        for (const job of result.jobs) {
          io.stdout(
            `${job.jobId}\t${job.runId}\t${job.status}\t${job.recommendedAction}\n`,
          )
        }
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function recoverDrainWorkflowCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  try {
    const result = await matOSWorkflowService.recoverDrain({
      ...workflowServiceContext(io, parsed.scope),
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      for (const job of result.ran) {
        io.stdout(`${job.jobId}\t${job.status}\t${job.attempts} attempts\n`)
      }
      if (result.ran.length === 0) {
        io.stdout('No due workflow remote recovery jobs found\n')
      }
    }
    return result.ran.some(job => job.status === 'failed') ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function reconcileWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow reconcile <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.reconcile({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.run.runId}\t${result.run.status}\t${result.reconciled.length} reconciled\n`,
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function listWorkflowPatchesCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow patches <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.patches({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      for (const patch of result.patches) {
        io.stdout(`${patch.patchId}\t${patch.decision?.status ?? 'unknown'}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function inspectWorkflowPatchCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.patch) {
    io.stderr('Usage: matos workflow patch-inspect <runId> --patch <patchId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.patchInspect({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      patchId: parsed.patch,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.patch.patchId}\t${result.patch.decision?.status ?? 'unknown'}\n`,
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function decideWorkflowPatchCommand(
  io: MatOSWorkflowIO,
  subcommand: 'patch-approve' | 'patch-reject' | 'patch-apply',
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.patch) {
    io.stderr(`Usage: matos workflow ${subcommand} <runId> --patch <patchId>\n`)
    return 1
  }

  try {
    const input = {
      ...workflowServiceContext(io, parsed.scope),
      runId,
      patchId: parsed.patch,
      reason: parsed.reason,
    }
    const result =
      subcommand === 'patch-approve'
        ? await matOSWorkflowService.patchApprove(input)
        : subcommand === 'patch-reject'
          ? await matOSWorkflowService.patchReject(input)
          : await matOSWorkflowService.patchApply(input)
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.patch.patchId}\t${result.patch.decision?.status ?? 'unknown'}\t${result.run.status}\n`,
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function defaultWorkflowTaskRunner(
  args: string[],
  options: {
    cwd: string
    stdout: (text: string) => void
    stderr: (text: string) => void
  },
): Promise<number> {
  const { runMatOSAgentTask } = await import('./run.js')
  return runMatOSAgentTask(args, options)
}

function workflowTaskRunner(io: MatOSWorkflowIO): MatOSWorkflowTaskRunner {
  return io.runTask ?? defaultWorkflowTaskRunner
}

function collectFailedWorkflowNodes(
  run: unknown,
): { id: string; status?: string; error?: string }[] {
  const record =
    run && typeof run === 'object' ? (run as Record<string, unknown>) : {}
  const nodes = Array.isArray(record.nodes) ? record.nodes : []
  const failed: { id: string; status?: string; error?: string }[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue
    }
    const entry = node as Record<string, unknown>
    const status = typeof entry.status === 'string' ? entry.status : undefined
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const errorObject =
        entry.error && typeof entry.error === 'object'
          ? (entry.error as Record<string, unknown>)
          : undefined
      const errorMessage =
        typeof entry.error === 'string'
          ? entry.error
          : typeof errorObject?.message === 'string'
            ? errorObject.message
            : undefined
      failed.push({
        id: typeof entry.id === 'string' ? entry.id : 'unknown',
        ...(status ? { status } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
      })
    }
  }
  return failed
}

// Directive text and default-role routing for optimize/repair/draft-from-task
// live in the Algorithm Layer workflow-optimize surface
// (src/matos/algorithms/surfaces/workflowOptimize.ts). The baseline provider
// preserves the exact directives that previously lived inline here.

async function proposeWorkflowPatchCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (
    !runId ||
    (parsed.operationsJson === undefined && parsed.operationsFile === undefined)
  ) {
    io.stderr(
      'Usage: matos workflow patch-propose <runId> --operations <json-array>|--operations-file <path> [--reason <reason>] [--risk low|medium|high] [--source-node <nodeId>] [--json]\n',
    )
    return 1
  }

  try {
    const operationsPayload = await jsonPayload(
      parsed.operationsJson,
      parsed.operationsFile,
      io.cwd,
    )
    if (!Array.isArray(operationsPayload)) {
      io.stderr(
        'workflow patch-propose --operations must be a JSON array of patch operations\n',
      )
      return 1
    }
    const result = await matOSWorkflowService.patchPropose({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      operations: operationsPayload,
      reason: parsed.reason,
      ...(parsed.risk ? { risk: parsed.risk } : {}),
      sourceNodeId: parsed.sourceNode,
    })
    if (!result.ok) {
      if (parsed.json) {
        writeJson(io, result)
      } else {
        io.stderr(
          `patch-propose validation failed:\n${result.errors
            .map(
              error =>
                `  ${error.code}: ${error.message}${error.path ? ` (${error.path})` : ''}`,
            )
            .join('\n')}\n`,
        )
      }
      return 1
    }
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(
        `${result.patch?.patchId ?? 'patch'}\t${result.patch?.decision?.status ?? 'proposed'}\n`,
      )
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function repairWorkflowCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr(
      'Usage: matos workflow repair <runId> [--role <role-ref>] [--evidence <text>] [--plan] [--json]\n',
    )
    return 1
  }
  let failedNodes: { id: string; status?: string; error?: string }[] = []
  try {
    const { run } = await matOSWorkflowService.inspect({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    failedNodes = collectFailedWorkflowNodes(run)
  } catch {
    failedNodes = []
  }
  const { decision } = decideMatOSWorkflowOptimize({
    intent: 'repair',
    runId,
    failedNodes,
    evidence: parsed.evidence,
    defaultRole: 'role:workflow-repair',
    cwd: io.cwd,
  })
  // An explicit --role always wins over the decided role.
  const role = parsed.role ?? decision.role
  const directive = decision.directive
  if (parsed.plan) {
    if (parsed.json) {
      writeJson(io, { command: 'workflow repair', runId, role, failedNodes, directive })
    } else {
      io.stdout(`${role}\n${directive}\n`)
    }
    return 0
  }
  return workflowTaskRunner(io)(['--role', role, directive], {
    cwd: io.cwd,
    stdout: io.stdout,
    stderr: io.stderr,
  })
}

async function draftFromTaskCommand(
  io: MatOSWorkflowIO,
  task: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!task) {
    io.stderr(
      'Usage: matos workflow draft from-task "<task>" [--role <role-ref>] [--plan] [--json]\n',
    )
    return 1
  }
  const { decision } = decideMatOSWorkflowOptimize({
    intent: 'draft-from-task',
    task,
    defaultRole: 'role:workflow-planner',
    cwd: io.cwd,
  })
  const role = parsed.role ?? decision.role
  const directive = decision.directive
  if (parsed.plan) {
    if (parsed.json) {
      writeJson(io, { command: 'workflow draft from-task', task, role, directive })
    } else {
      io.stdout(`${role}\n${directive}\n`)
    }
    return 0
  }
  return workflowTaskRunner(io)(['--role', role, directive], {
    cwd: io.cwd,
    stdout: io.stdout,
    stderr: io.stderr,
  })
}

async function optimizeWorkflowCommand(
  io: MatOSWorkflowIO,
  workflowRef: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!workflowRef) {
    io.stderr(
      'Usage: matos workflow optimize <workflow-ref> [--evidence <text>] [--role <role-ref>] [--plan] [--json]\n',
    )
    return 1
  }
  const { decision } = decideMatOSWorkflowOptimize({
    intent: 'optimize',
    workflowRef,
    evidence: parsed.evidence,
    defaultRole: 'role:workflow-optimizer',
    cwd: io.cwd,
  })
  const role = parsed.role ?? decision.role
  const directive = decision.directive
  if (parsed.plan) {
    if (parsed.json) {
      writeJson(io, { command: 'workflow optimize', workflowRef, role, directive })
    } else {
      io.stdout(`${role}\n${directive}\n`)
    }
    return 0
  }
  return workflowTaskRunner(io)(['--role', role, directive], {
    cwd: io.cwd,
    stdout: io.stdout,
    stderr: io.stderr,
  })
}

async function artifactsWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow artifacts <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.artifacts({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    const artifacts = result.artifacts
    if (parsed.json) {
      writeJson(io, result)
    } else {
      for (const artifact of artifacts) {
        io.stdout(
          `${artifact.nodeId ?? ''}\t${artifact.kind ?? ''}\t${artifact.path ?? ''}\n`,
        )
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function approvalStatusWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow approval-status <runId>\n')
    return 1
  }

  try {
    const status = (await matOSWorkflowService.approvalStatus({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })) as Awaited<ReturnType<typeof inspectWorkflowApprovalStatus>>
    if (parsed.json) {
      writeJson(io, status)
    } else {
      if (status.pendingApprovals.length === 0) {
        io.stdout(`${status.run.runId}\tno-pending-approvals\n`)
        return 0
      }
      for (const approval of status.pendingApprovals) {
        io.stdout(
          `${approval.nodeId}\t${approval.status}\t${approval.actionFingerprint}\t${approval.toolRef ?? ''}\n`,
        )
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function respondWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.node) {
    io.stderr('Usage: matos workflow respond <runId> --node <nodeId> --message <message>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.respond({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      nodeId: parsed.node,
      response: parseMessage(parsed.message),
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function approveWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.node) {
    io.stderr(
      'Usage: matos workflow approve <runId> --node <nodeId> [--fingerprint <sha256>] [--message <message>]\n',
    )
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.approve({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      nodeId: parsed.node,
      fingerprint: parsed.fingerprint,
      response: parseMessage(parsed.message),
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function denyWorkflowRun(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.node) {
    io.stderr(
      'Usage: matos workflow deny <runId> --node <nodeId> [--reason <reason>]\n',
    )
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.deny({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      nodeId: parsed.node,
      reason: parsed.reason,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function cancelWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow cancel <runId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.cancel({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function pauseWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow pause <runId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.pause({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function resumeWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow resume <runId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.resume({
      ...workflowServiceContext(io, parsed.scope),
      runId,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function retryWorkflowNodeCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.node) {
    io.stderr('Usage: matos workflow retry-node <runId> --node <nodeId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.retryNode({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      nodeId: parsed.node,
      failedChildrenOnly: parsed.failedChildrenOnly,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function skipWorkflowNodeCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId || !parsed.node) {
    io.stderr('Usage: matos workflow skip-node <runId> --node <nodeId>\n')
    return 1
  }

  try {
    const { run } = await matOSWorkflowService.skipNode({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      nodeId: parsed.node,
      reason: parsed.reason,
    })
    if (parsed.json) {
      writeJson(io, { run })
    } else {
      io.stdout(`${run.runId}\t${run.status}\n`)
    }
    return run.status === 'failed' ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function createWorkflowDraftCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  try {
    const result = await matOSWorkflowService.createDraft({
      ...workflowServiceContext(io, parsed.scope),
      id: parsed.id,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
    })
    if (parsed.json) {
      writeJson(io, { draft: result.draft })
    } else {
      io.stdout(`${result.draft.draftId}\t${result.draft.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function showWorkflowDraftCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId) {
    io.stderr('Usage: matos workflow draft show <draftId>\n')
    return 1
  }
  try {
    const result = await matOSWorkflowService.showDraft({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(`${result.draft.draftId}\t${result.draft.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function compileWorkflowDraftCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId) {
    io.stderr('Usage: matos workflow draft compile <draftId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.compileDraft({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
    })
    if (parsed.json) {
      writeJson(io, result)
      return result.ok ? 0 : 1
    }
    io.stdout(
      `${result.workflowRef ?? `draft:${draftId}`}\t${result.ok ? 'compiled' : 'invalid'}\t${result.metadata.nodeCount} nodes\t${result.metadata.risk} risk\n`,
    )
    for (const diagnostic of result.diagnostics) {
      io.stderr(
        `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}${diagnostic.nodeId ? ` (${diagnostic.nodeId})` : ''}\n`,
      )
    }
    return result.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function importWorkflowComponentCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  componentRef: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !componentRef) {
    io.stderr(
      'Usage: matos workflow draft import-component <draftId> <workflow-ref>\n',
    )
    return 1
  }
  try {
    const result = await matOSWorkflowService.importComponent({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      ref: componentRef,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(`${result.draft.draftId}\t${result.definition.nodes.length} nodes\n`)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function publishWorkflowDraftCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.id) {
    io.stderr(`${workflowDraftUsage('publish')}\n`)
    return 1
  }
  try {
    const result = await matOSWorkflowService.publishDraft({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      id: parsed.id,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      expectedDefinition: parsed.expectedDefinition,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(`${result.published.assetKey}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function draftListCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  try {
    const result = await matOSWorkflowService.drafts(
      workflowServiceContext(io, parsed.scope),
    )
    if (parsed.json) {
      writeJson(io, result)
    } else {
      for (const draft of result.drafts) {
        io.stdout(`${draft.draftId}\t${draft.status}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function addWorkflowDraftNodeCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId) {
    io.stderr(
      'Usage: matos workflow draft add-node <draftId> --node-json <json>\n',
    )
    return 1
  }

  try {
    const node = (await jsonPayload(
      parsed.nodeJson,
      parsed.nodeFile,
      io.cwd,
    )) as MatOSWorkflowNode
    const result = await matOSWorkflowService.addDraftNode({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      node,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'add-node', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function updateWorkflowDraftNodeCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.node) {
    io.stderr(
      'Usage: matos workflow draft update-node <draftId> --node <nodeId> --patch-json <json>\n',
    )
    return 1
  }

  try {
    const patch = (await jsonPayload(
      parsed.patchJson,
      parsed.patchFile,
      io.cwd,
    )) as Partial<MatOSWorkflowNode>
    const result = await matOSWorkflowService.updateDraftNode({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      nodeId: parsed.node,
      patch,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'update-node', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function deleteWorkflowDraftNodeCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.node) {
    io.stderr('Usage: matos workflow draft delete-node <draftId> --node <nodeId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.deleteDraftNode({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      nodeId: parsed.node,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'delete-node', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function connectWorkflowDraftNodesCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.from || !parsed.to) {
    io.stderr(
      'Usage: matos workflow draft connect <draftId> --from <nodeId> --to <nodeId>\n',
    )
    return 1
  }

  try {
    const result = await matOSWorkflowService.connectDraftNodes({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      from: parsed.from,
      to: parsed.to,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'connect', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function connectWorkflowDraftTransitionCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.from || !parsed.to) {
    io.stderr(
      'Usage: matos workflow draft connect-transition <draftId> --from <nodeId> --to <nodeId> [--route success|failure|always] [--guard <expr>] [--reducer-json <json>] [--max-traversals <n>] [--transition-id <id>]\n',
    )
    return 1
  }
  if (
    parsed.route !== undefined &&
    parsed.route !== 'success' &&
    parsed.route !== 'failure' &&
    parsed.route !== 'always'
  ) {
    io.stderr('Workflow draft transition --route must be success, failure, or always\n')
    return 1
  }
  let reducer: Record<string, unknown> | undefined
  if (parsed.reducerJson) {
    try {
      const parsedReducer = JSON.parse(parsed.reducerJson) as unknown
      if (!parsedReducer || typeof parsedReducer !== 'object' || Array.isArray(parsedReducer)) {
        throw new Error('reducer must be a JSON object')
      }
      reducer = parsedReducer as Record<string, unknown>
    } catch (error) {
      io.stderr(
        `Invalid --reducer-json: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
  }
  if (
    parsed.maxTraversals !== undefined &&
    (!Number.isInteger(parsed.maxTraversals) || parsed.maxTraversals < 1)
  ) {
    io.stderr('Workflow draft transition --max-traversals must be an integer >= 1\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.connectDraftTransition({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      transition: {
        from: parsed.from,
        to: parsed.to,
        ...(parsed.transitionId ? { id: parsed.transitionId } : {}),
        ...(parsed.route
          ? { route: parsed.route as 'success' | 'failure' | 'always' }
          : {}),
        ...(parsed.guard ? { guard: parsed.guard } : {}),
        ...(reducer ? { reducer } : {}),
        ...(parsed.maxTraversals !== undefined
          ? { maxTraversals: parsed.maxTraversals }
          : {}),
      },
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'connect-transition', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function disconnectWorkflowDraftTransitionCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || (!parsed.transitionId && !parsed.from && !parsed.to)) {
    io.stderr(
      'Usage: matos workflow draft disconnect-transition <draftId> [--transition-id <id>] [--from <nodeId>] [--to <nodeId>]\n',
    )
    return 1
  }

  try {
    const result = await matOSWorkflowService.disconnectDraftTransition({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      ...(parsed.transitionId ? { id: parsed.transitionId } : {}),
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'disconnect-transition', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function setWorkflowDraftStateMachineCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || (!parsed.disable && !parsed.initialNode && parsed.maxTransitions === undefined)) {
    io.stderr(
      'Usage: matos workflow draft set-state-machine <draftId> --initial-node <nodeId> --max-transitions <n> [--max-frames <n>] | --disable\n',
    )
    return 1
  }
  if (
    parsed.maxTransitions !== undefined &&
    (!Number.isInteger(parsed.maxTransitions) || parsed.maxTransitions < 1)
  ) {
    io.stderr('Workflow draft state machine --max-transitions must be an integer >= 1\n')
    return 1
  }
  if (
    parsed.maxFrames !== undefined &&
    (!Number.isInteger(parsed.maxFrames) || parsed.maxFrames < 1)
  ) {
    io.stderr('Workflow draft state machine --max-frames must be an integer >= 1\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.setDraftStateMachine({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      ...(parsed.disable ? { disable: true } : {}),
      ...(parsed.initialNode ? { initialNodeId: parsed.initialNode } : {}),
      ...(parsed.maxTransitions !== undefined
        ? { maxTransitions: parsed.maxTransitions }
        : {}),
      ...(parsed.maxFrames !== undefined ? { maxFrames: parsed.maxFrames } : {}),
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'set-state-machine', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function disconnectWorkflowDraftNodesCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId || !parsed.from || !parsed.to) {
    io.stderr(
      'Usage: matos workflow draft disconnect <draftId> --from <nodeId> --to <nodeId>\n',
    )
    return 1
  }

  try {
    const result = await matOSWorkflowService.disconnectDraftNodes({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      from: parsed.from,
      to: parsed.to,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'disconnect', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function setWorkflowDraftOutputsCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!draftId) {
    io.stderr(
      'Usage: matos workflow draft set-outputs <draftId> --outputs-json <json>\n',
    )
    return 1
  }

  try {
    const outputs = (await jsonPayload(
      parsed.outputsJson,
      parsed.outputsFile,
      io.cwd,
    )) as MatOSWorkflowDefinition['outputs']
    const result = await matOSWorkflowService.setDraftOutputs({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      outputs,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'set-outputs', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function replaceWorkflowDraftDefinitionCommand(
  io: MatOSWorkflowIO,
  draftId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (
    !draftId ||
    (parsed.definitionJson === undefined && parsed.definitionFile === undefined)
  ) {
    io.stderr(`${workflowDraftUsage('replace-definition')}\n`)
    return 1
  }
  if (
    parsed.definitionJson !== undefined &&
    parsed.definitionFile !== undefined
  ) {
    io.stderr(
      `Choose exactly one of --definition-json or --definition-file.\n${workflowDraftUsage('replace-definition')}\n`,
    )
    return 1
  }

  try {
    const definition = (await jsonPayload(
      parsed.definitionJson,
      parsed.definitionFile,
      io.cwd,
      io.stdin,
    )) as MatOSWorkflowDefinition
    const result = await matOSWorkflowService.replaceDraftDefinition({
      ...workflowServiceContext(io, parsed.scope),
      draftId,
      definition,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      draftMutationStatus(io, draftId, 'replace-definition', result.validation)
    }
    return result.validation.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Invalid workflow draft mutation:')) {
      io.stderr(
        `Invalid workflow draft definition: ${message
          .slice('Invalid workflow draft mutation:'.length)
          .trim()}\n`,
      )
    } else {
      io.stderr(`${message}\n`)
    }
    return 1
  }
}

async function workflowDraftCommand(
  io: MatOSWorkflowIO,
  parsed: ParsedArgs,
): Promise<number> {
  const requestedSubcommand = parsed.positionals[0]
  if (parsed.help) {
    return printWorkflowDraftHelp(io, requestedSubcommand)
  }
  if (requestedSubcommand === 'help') {
    return printWorkflowDraftHelp(io, parsed.positionals[1])
  }
  const draftSubcommand = requestedSubcommand ?? 'show'

  if (draftSubcommand === 'from-task') {
    return draftFromTaskCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'list') {
    return draftListCommand(io, parsed)
  }

  if (draftSubcommand === 'create') {
    return createWorkflowDraftCommand(io, parsed)
  }

  if (draftSubcommand === 'show') {
    return showWorkflowDraftCommand(io, parsed.positionals[1], parsed)
  }

  // `validate` aliases `compile`: agents guess `draft validate` first (the
  // tool surface calls it validate_draft), and compile already returns the
  // full ok/diagnostics/metadata validation verdict for the stored draft.
  if (draftSubcommand === 'compile' || draftSubcommand === 'validate') {
    return compileWorkflowDraftCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'add-node') {
    return addWorkflowDraftNodeCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'update-node') {
    return updateWorkflowDraftNodeCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'delete-node') {
    return deleteWorkflowDraftNodeCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'connect') {
    return connectWorkflowDraftNodesCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'disconnect') {
    return disconnectWorkflowDraftNodesCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'connect-transition') {
    return connectWorkflowDraftTransitionCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'disconnect-transition') {
    return disconnectWorkflowDraftTransitionCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'set-state-machine') {
    return setWorkflowDraftStateMachineCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'set-outputs') {
    return setWorkflowDraftOutputsCommand(io, parsed.positionals[1], parsed)
  }

  if (draftSubcommand === 'replace-definition') {
    return replaceWorkflowDraftDefinitionCommand(
      io,
      parsed.positionals[1],
      parsed,
    )
  }

  if (draftSubcommand === 'import-component') {
    return importWorkflowComponentCommand(
      io,
      parsed.positionals[1],
      parsed.positionals[2],
      parsed,
    )
  }

  if (draftSubcommand === 'publish') {
    return publishWorkflowDraftCommand(io, parsed.positionals[1], parsed)
  }

  io.stderr(
    `Unknown matos workflow draft command: ${draftSubcommand}\n` +
      'Available: from-task, list, create, show, validate, compile, add-node, update-node, delete-node, connect, disconnect, connect-transition, disconnect-transition, set-state-machine, set-outputs, replace-definition, import-component, publish\n',
  )
  return 1
}

async function forkWorkflowRunCommand(
  io: MatOSWorkflowIO,
  runId: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  if (!runId) {
    io.stderr('Usage: matos workflow fork <runId>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.forkRun({
      ...workflowServiceContext(io, parsed.scope),
      runId,
      id: parsed.id,
      name: parsed.name,
    })
    if (parsed.json) {
      writeJson(io, result)
    } else {
      io.stdout(`${result.draft.draftId}\t${result.draft.status}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function runMatOSWorkflowCommand(
  args: string[],
  io: MatOSWorkflowIO,
): Promise<number> {
  // Workflow runner entry (also reached by detached `workflow resume`
  // workers): a runner death must leave a crash record, not a silent gap in
  // run.json/events.jsonl.
  installMatOSCrashCapture({ component: 'workflow-runner' })
  const subcommand = args[0] ?? 'list'
  if (isHelpSubcommand(subcommand)) {
    return printWorkflowHelp(io)
  }
  const parsed = parseArgs(args.slice(1))

  if (subcommand === 'list') {
    return listWorkflows(io, parsed.json)
  }

  if (subcommand === 'runs') {
    return listWorkflowRunsCommand(io, parsed)
  }

  if (subcommand === 'show') {
    return showWorkflow(io, parsed.positionals[0], parsed.json)
  }

  if (subcommand === 'validate') {
    return validateWorkflow(io, parsed.positionals[0], parsed.json)
  }

  if (subcommand === 'compile') {
    return compileWorkflow(io, parsed.positionals[0], parsed.json)
  }

  if (
    parsed.execution === 'container' &&
    CONTAINER_WORKFLOW_LIFECYCLE_COMMANDS.has(subcommand)
  ) {
    return runWorkflowCommandInContainer(
      io,
      parsed,
      containerLifecycleArgv(subcommand, parsed),
    )
  }

  if (subcommand === 'compile-inspect') {
    return compileInspectWorkflow(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'contract') {
    return contractWorkflow(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'preflight') {
    return preflightWorkflow(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'run') {
    return runWorkflow(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'status') {
    return statusWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'wait') {
    return waitWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'author') {
    return authorWorkflowCommand(io, parsed)
  }

  if (subcommand === 'templates') {
    return templatesWorkflowCommand(io, parsed)
  }

  if (subcommand === 'inspect') {
    return inspectWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'recover') {
    return recoverWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'recover-apply') {
    return recoverApplyWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'recover-queue') {
    return recoverQueueWorkflowCommand(io, parsed)
  }

  if (subcommand === 'recover-drain') {
    return recoverDrainWorkflowCommand(io, parsed)
  }

  if (subcommand === 'reconcile') {
    return reconcileWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'patches') {
    return listWorkflowPatchesCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'patch-inspect') {
    return inspectWorkflowPatchCommand(io, parsed.positionals[0], parsed)
  }

  if (
    subcommand === 'patch-approve' ||
    subcommand === 'patch-reject' ||
    subcommand === 'patch-apply'
  ) {
    return decideWorkflowPatchCommand(io, subcommand, parsed.positionals[0], parsed)
  }

  if (subcommand === 'patch-propose') {
    return proposeWorkflowPatchCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'events') {
    return eventsWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'artifacts') {
    return artifactsWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'approval-status') {
    return approvalStatusWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'respond') {
    return respondWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'approve') {
    return approveWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'deny') {
    return denyWorkflowRun(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'cancel') {
    return cancelWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'pause') {
    return pauseWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'resume') {
    return resumeWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'retry-node') {
    return retryWorkflowNodeCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'skip-node') {
    return skipWorkflowNodeCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'repair') {
    return repairWorkflowCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'optimize') {
    return optimizeWorkflowCommand(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'draft') {
    return workflowDraftCommand(io, parsed)
  }

  if (subcommand === 'fork') {
    return forkWorkflowRunCommand(io, parsed.positionals[0], parsed)
  }

  io.stderr(
    `Unknown matos workflow command: ${subcommand}\n` +
      'Available: list, show, validate, compile, compile-inspect, contract, preflight, templates, author, run, wait, status, inspect, events, artifacts, approval-status, respond, approve, deny, cancel, pause, resume, retry-node, skip-node, recover, recover-apply, recover-queue, recover-drain, reconcile, patches, patch-inspect, patch-propose, patch-approve, patch-reject, patch-apply, repair, optimize, draft, fork\n',
  )
  return 1
}
