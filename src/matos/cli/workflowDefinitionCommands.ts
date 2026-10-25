import { matOSWorkflowService } from '../workflows/workflowService.js'
import {
  workflowServiceContext,
  writeJson,
  type MatOSWorkflowIO,
} from './workflowCliShared.js'

export async function listWorkflows(
  io: MatOSWorkflowIO,
  json: boolean,
): Promise<number> {
  const { workflows } = await matOSWorkflowService.list(workflowServiceContext(io))

  if (json) {
    writeJson(io, { workflows })
    return 0
  }

  if (workflows.length === 0) {
    io.stdout('No MatOS workflow assets found\n')
    return 0
  }

  for (const workflow of workflows) {
    const value = workflow as {
      type?: string
      id?: string
      version?: string
      name?: string
      kind?: string
    }
    const version = value.version ? `@${value.version}` : ''
    io.stdout(
      `${value.type ?? 'workflow'}:${value.id ?? ''}${version}\t${value.name ?? ''}\t${value.kind ?? 'executable'}\n`,
    )
  }
  return 0
}

export async function showWorkflow(
  io: MatOSWorkflowIO,
  reference: string | undefined,
  json: boolean,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos workflow show <workflow-ref>\n')
    return 1
  }

  try {
    const shown = await matOSWorkflowService.show({
      ...workflowServiceContext(io),
      ref: reference,
    })

    if (json) {
      writeJson(io, shown)
      return 0
    }

    const workflow = shown.workflow as {
      canonicalKey?: string
      name?: string
      description?: string
    }
    io.stdout(`${workflow.canonicalKey ?? reference}\t${workflow.name ?? ''}\t${shown.kind}\n`)
    if (workflow.description) {
      io.stdout(`${workflow.description}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function validateWorkflow(
  io: MatOSWorkflowIO,
  reference: string | undefined,
  json: boolean,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos workflow validate <workflow-ref>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.validate({
      ...workflowServiceContext(io),
      ref: reference,
    })
    if (json) {
      writeJson(io, result)
      return result.ok ? 0 : 1
    }

    if (result.ok) {
      io.stdout(`MatOS workflow valid: ${result.workflow}\n`)
      return 0
    }

    for (const error of result.errors) {
      io.stderr(
        `${error.code}: ${error.message}${error.nodeId ? ` (${error.nodeId})` : ''}\n`,
      )
    }
    return 1
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function compileWorkflow(
  io: MatOSWorkflowIO,
  reference: string | undefined,
  json: boolean,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos workflow compile <workflow-ref>\n')
    return 1
  }

  try {
    const result = await matOSWorkflowService.compile({
      ...workflowServiceContext(io),
      ref: reference,
    })
    if (json) {
      writeJson(io, result)
      return result.ok ? 0 : 1
    }

    io.stdout(
      `${result.workflowRef ?? reference}\t${result.ok ? 'compiled' : 'invalid'}\t${result.metadata.nodeCount} nodes\t${result.metadata.risk} risk\n`,
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
