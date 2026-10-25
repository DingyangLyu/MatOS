import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  MatOSWorkflowGuardCheck,
  ValidationResult,
  WorkflowArtifactRef,
} from './types.js'
import { evaluateWorkflowConditionDetail } from './workflowConditions.js'
import { validateValueAgainstJsonSchema } from './outputContract.js'
import type { WorkflowExpressionContext } from './workflowExpressions.js'
import {
  decideMatOSVerificationPolicy,
} from '../algorithms/surfaces/verificationPolicy.js'
import type { MatOSAlgorithmProviderOverrides } from '../algorithms/surface.js'

export type WorkflowValidationCheckResult =
  ValidationResult['checks'][number]

export type WorkflowValidationEngineOptions = {
  workspaceDir: string
  expressionContext?: WorkflowExpressionContext
  algorithm?: {
    candidateChecks?: MatOSWorkflowGuardCheck[]
    maxAdditionalChecks?: number
    roleAlgorithms?: unknown
    providerOverrides?: MatOSAlgorithmProviderOverrides
    cwd?: string
    workflowRunId?: string
    workflowNodeId?: string
    attempt?: number
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function evidenceList(value: unknown): WorkflowArtifactRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const evidence = value.filter(
    (item): item is WorkflowArtifactRef =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  )
  return evidence.length > 0 ? evidence : undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function checkId(check: MatOSWorkflowGuardCheck, index: number): string {
  return optionalString(check.id) ?? `${check.type}_${index + 1}`
}

function checkPath(
  check: MatOSWorkflowGuardCheck,
  workspaceDir: string,
): string {
  if (typeof check.path !== 'string' || check.path.trim().length === 0) {
    throw new Error(`Validation check requires path: ${check.type}`)
  }
  return isAbsolute(check.path) ? check.path : join(workspaceDir, check.path)
}

function checkEvidence(
  check: MatOSWorkflowGuardCheck,
): WorkflowArtifactRef[] | undefined {
  return evidenceList(check.evidence)
}

function withEvidence(
  result: WorkflowValidationCheckResult,
  check: MatOSWorkflowGuardCheck,
): WorkflowValidationCheckResult {
  const evidence = checkEvidence(check)
  const failureMetadata = !result.ok
    ? {
        ...(optionalString(check.failureCode)
          ? { code: optionalString(check.failureCode) }
          : {}),
        ...(optionalString(check.failureMessage)
          ? { message: optionalString(check.failureMessage) }
          : {}),
        ...(optionalString(check.repairHint)
          ? { hint: optionalString(check.repairHint) }
          : {}),
        ...(typeof check.retryable === 'boolean'
          ? { retryable: check.retryable }
          : {}),
        ...(optionalString(check.sourceNodeId)
          ? { sourceNodeId: optionalString(check.sourceNodeId) }
          : {}),
      }
    : {}
  return {
    ...result,
    ...failureMetadata,
    ...(evidence ? { evidence } : {}),
  }
}

async function evaluateOneCheck(
  check: MatOSWorkflowGuardCheck,
  index: number,
  options: WorkflowValidationEngineOptions,
): Promise<WorkflowValidationCheckResult> {
  const id = checkId(check, index)
  if (check.type === 'file_exists') {
    const path = checkPath(check, options.workspaceDir)
    const ok = await exists(path)
    return withEvidence(
      {
        id,
        type: check.type,
        ok,
        observed: path,
        expected: true,
      },
      check,
    )
  }

  if (check.type === 'file_size') {
    const path = checkPath(check, options.workspaceDir)
    const file = await stat(path)
    const minBytes =
      typeof check.minBytes === 'number' ? check.minBytes : 1
    const maxBytes =
      typeof check.maxBytes === 'number' ? check.maxBytes : Infinity
    const ok = file.isFile() && file.size >= minBytes && file.size <= maxBytes
    return withEvidence(
      {
        id,
        type: check.type,
        ok,
        observed: { path, bytes: file.size, kind: file.isFile() ? 'file' : 'other' },
        expected: {
          minBytes,
          ...(typeof check.maxBytes === 'number' ? { maxBytes } : {}),
        },
      },
      check,
    )
  }

  if (check.type === 'grep') {
    const path = checkPath(check, options.workspaceDir)
    const pattern = typeof check.pattern === 'string' ? check.pattern : ''
    const content = await readFile(path, 'utf8')
    const ok = content.includes(pattern)
    return withEvidence(
      {
        id,
        type: check.type,
        ok,
        observed: pattern ? content.includes(pattern) : false,
        expected: pattern,
      },
      check,
    )
  }

  if (check.type === 'regex') {
    const pattern = typeof check.pattern === 'string' ? check.pattern : ''
    const flags = typeof check.flags === 'string' ? check.flags : ''
    const sourcePath = optionalString(check.path)
    const content = sourcePath
      ? await readFile(checkPath(check, options.workspaceDir), 'utf8')
      : typeof check.value === 'string'
        ? check.value
        : JSON.stringify(check.value) ?? String(check.value ?? '')
    const expression = new RegExp(pattern, flags)
    const match = expression.exec(content)
    const negate = check.negate === true
    const ok = negate ? match === null : match !== null
    return withEvidence(
      {
        id,
        type: check.type,
        ok,
        observed: {
          matched: match !== null,
          ...(match ? { match: match[0].slice(0, 500) } : {}),
          ...(sourcePath ? { path: checkPath(check, options.workspaceDir) } : {}),
        },
        expected: { pattern, flags, negate },
      },
      check,
    )
  }

  if (check.type === 'expression') {
    if (typeof check.value !== 'string') {
      return withEvidence(
        {
          id,
          type: check.type,
          ok: false,
          observed: check.value,
          expected: true,
        },
        check,
      )
    }
    const detail = evaluateWorkflowConditionDetail(
      check.value,
      options.expressionContext ?? { nodeRuns: new Map(), parameters: {} },
    )
    return withEvidence(
      {
        id,
        type: check.type,
        ok: detail.ok,
        ...(detail.observed !== undefined ? { observed: detail.observed } : {}),
        ...(detail.expected !== undefined ? { expected: detail.expected } : {}),
      },
      check,
    )
  }

  if (check.type === 'numeric_range') {
    const value = typeof check.value === 'number' ? check.value : Number.NaN
    const min = typeof check.min === 'number' ? check.min : -Infinity
    const max = typeof check.max === 'number' ? check.max : Infinity
    const notEqual =
      typeof check.notEqual === 'number' ? check.notEqual : undefined
    return withEvidence(
      {
        id,
        type: check.type,
        ok:
          Number.isFinite(value) &&
          value >= min &&
          value <= max &&
          (notEqual === undefined || value !== notEqual),
        observed: value,
        expected: {
          ...(typeof check.min === 'number' ? { min } : {}),
          ...(typeof check.max === 'number' ? { max } : {}),
          ...(notEqual !== undefined ? { notEqual } : {}),
        },
      },
      check,
    )
  }

  if (check.type === 'json_schema') {
    if (check.schema === undefined) {
      return withEvidence(
        {
          id,
          type: check.type,
          ok: false,
          observed: check.value,
          expected: 'json schema',
          error: 'json_schema check requires a schema',
        },
        check,
      )
    }
    let value = check.value
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown
      } catch {
        // Keep the raw string when it is not JSON-encoded.
      }
    }
    const validation = validateValueAgainstJsonSchema(value, check.schema)
    return withEvidence(
      {
        id,
        type: check.type,
        ok: validation.ok,
        observed: validation.ok ? value : validation.errors,
        expected: check.schema,
        ...(validation.ok ? {} : { error: validation.errors.join('; ') }),
      },
      check,
    )
  }

  return withEvidence(
    {
      id,
      type: String(check.type),
      ok: false,
      observed: check.type,
      expected: 'supported validation check',
    },
    check,
  )
}

export async function evaluateWorkflowValidationChecks(
  checks: MatOSWorkflowGuardCheck[],
  options: WorkflowValidationEngineOptions,
): Promise<ValidationResult> {
  const selectedChecks = decideMatOSVerificationPolicy({
    requiredChecks: checks,
    candidateChecks: options.algorithm?.candidateChecks,
    maxAdditionalChecks: options.algorithm?.maxAdditionalChecks,
    roleAlgorithms: options.algorithm?.roleAlgorithms,
    providerOverrides: options.algorithm?.providerOverrides,
    cwd: options.algorithm?.cwd,
    workflowRunId: options.algorithm?.workflowRunId,
    workflowNodeId: options.algorithm?.workflowNodeId,
    attempt: options.algorithm?.attempt,
  }).decision.checks
  const results: WorkflowValidationCheckResult[] = []
  for (const [index, check] of selectedChecks.entries()) {
    try {
      results.push(await evaluateOneCheck(check, index, options))
    } catch (error) {
      results.push(
        withEvidence(
          {
            id: checkId(check, index),
            type: check.type,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          check,
        ),
      )
    }
  }

  const ok = results.every(result => result.ok)
  return {
    ok,
    severity: ok ? 'info' : 'error',
    recommendation: ok ? 'continue' : 'fail',
    checks: results,
  }
}
