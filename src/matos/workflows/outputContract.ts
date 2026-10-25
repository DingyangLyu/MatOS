import { Ajv, type ValidateFunction } from 'ajv'
import type { MatOSWorkflowNode } from './types.js'
import { normalizeWorkflowNodeContract } from './workflowContracts.js'
import { valueAtPath } from './workflowExpressions.js'

export type WorkflowOutputContractValidation = {
  ok: boolean
  errors: string[]
}

const ajv = new Ajv({ allErrors: true, strict: false })

// Cache compiled validators by serialized schema so repeated validation of the
// same node output schema does not recompile (and accumulate validators) on
// every call in a long-lived process. The set of distinct workflow output
// schemas is small and bounded, so the cache stays small.
const validatorCache = new Map<string, ValidateFunction>()

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema)
  let validate = validatorCache.get(key)
  if (!validate) {
    validate = ajv.compile(schema)
    validatorCache.set(key, validate)
  }
  return validate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function extractJsonFence(value: string): string | undefined {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return match?.[1]?.trim()
}

function extractBalancedJson(value: string): string | undefined {
  const start = value.search(/[\[{]/)
  if (start < 0) {
    return undefined
  }

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop()
      if (expected !== char) {
        return undefined
      }
      if (stack.length === 0) {
        return value.slice(start, index + 1)
      }
    }
  }
  return undefined
}

function repairTrailingJsonClosers(value: string): string | undefined {
  const start = value.search(/[\[{]/)
  if (start < 0) {
    return undefined
  }

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined
      }
    }
  }

  // Model responses occasionally omit only the final structural delimiter.
  // Repair that narrow case; JSON.parse and the node output schema remain the
  // authorities for syntax and shape. Never infer truncated strings or a large
  // missing tail.
  if (inString || stack.length === 0 || stack.length > 4) {
    return undefined
  }
  return `${value.slice(start).trimEnd()}${stack.reverse().join('')}`
}

export function parseStructuredWorkflowResult(result: string | undefined): unknown {
  if (!result) {
    return undefined
  }

  const trimmed = result.trim()
  for (const candidate of [
    trimmed,
    extractJsonFence(trimmed),
    extractBalancedJson(trimmed),
    repairTrailingJsonClosers(trimmed),
  ]) {
    if (!candidate) {
      continue
    }
    const parsed = tryParseJson(candidate)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

export function outputSchemaForNode(
  node: MatOSWorkflowNode,
): Record<string, unknown> | undefined {
  return isRecord(node.outputSchema) ? node.outputSchema : undefined
}

export function validateWorkflowOutputSchemaDefinition(
  schema: unknown,
): WorkflowOutputContractValidation {
  if (!isRecord(schema)) {
    return { ok: false, errors: ['outputSchema must be a JSON schema object'] }
  }
  const ok = ajv.validateSchema(schema)
  if (!ok) {
    return {
      ok: false,
      errors: [ajv.errorsText(ajv.errors)],
    }
  }
  return { ok: true, errors: [] }
}

export function validateValueAgainstJsonSchema(
  value: unknown,
  schema: unknown,
): WorkflowOutputContractValidation {
  const schemaValidation = validateWorkflowOutputSchemaDefinition(schema)
  if (!schemaValidation.ok) {
    return schemaValidation
  }
  if (!isRecord(schema)) {
    return { ok: false, errors: ['json schema must be an object'] }
  }
  const validate = compileSchema(schema)
  if (validate(value)) {
    return { ok: true, errors: [] }
  }
  const errors =
    validate.errors?.map(error => {
      const instancePath = error.instancePath || 'root'
      return `${instancePath}: ${error.message ?? 'schema mismatch'}`
    }) ?? ['schema mismatch']
  return { ok: false, errors }
}

export function validateWorkflowNodeOutputContract(
  node: MatOSWorkflowNode,
  output: unknown,
): WorkflowOutputContractValidation {
  const errors: string[] = []
  const contract = normalizeWorkflowNodeContract(node)
  const outputs = contract.outputs ?? {}

  for (const [path, valueContract] of Object.entries(outputs)) {
    const observed = valueAtPath(output, path)
    if (observed === undefined) {
      if (valueContract.required) {
        errors.push(`Node ${node.id} outputContract failed: ${path} is required`)
      }
      continue
    }
    const type = valueContract.type
    if (
      type === 'array' ? !Array.isArray(observed) :
      type === 'object' ? !isRecord(observed) :
      type === 'string' ? typeof observed !== 'string' :
      type === 'number' ? typeof observed !== 'number' || !Number.isFinite(observed) :
      type === 'boolean' ? typeof observed !== 'boolean' :
      type === 'null' ? observed !== null :
      false
    ) {
      errors.push(
        `Node ${node.id} outputContract failed: ${path} expected ${type}`,
      )
      continue
    }
    if (valueContract.schema !== undefined) {
      const schema = valueContract.schema
      const schemaValidation = validateWorkflowOutputSchemaDefinition(
        schema,
      )
      if (!schemaValidation.ok) {
        errors.push(
          ...schemaValidation.errors.map(
            error => `Node ${node.id} outputContract ${path} has invalid schema: ${error}`,
          ),
        )
        continue
      }
      if (!isRecord(schema)) {
        continue
      }
      const validate = compileSchema(schema)
      if (!validate(observed)) {
        const schemaErrors =
          validate.errors?.map(error => {
            const instancePath = error.instancePath || 'root'
            return `${instancePath}: ${error.message ?? 'schema mismatch'}`
          }) ?? ['schema mismatch']
        errors.push(
          ...schemaErrors.map(
            error => `Node ${node.id} outputContract ${path} failed: ${error}`,
          ),
        )
      }
    }
  }

  const schema = outputSchemaForNode(node)
  if (!schema) {
    return { ok: errors.length === 0, errors }
  }

  if (!isRecord(output) || output.structured === undefined) {
    errors.push(`Agent node ${node.id} outputSchema requires structured JSON output`)
    return { ok: false, errors }
  }

  const schemaValidation = validateWorkflowOutputSchemaDefinition(schema)
  if (!schemaValidation.ok) {
    return {
      ok: false,
      errors: [
        ...errors,
        ...schemaValidation.errors.map(
        error => `Agent node ${node.id} has invalid outputSchema: ${error}`,
        ),
      ],
    }
  }

  const validate = compileSchema(schema)
  if (validate(output.structured)) {
    return { ok: errors.length === 0, errors }
  }

  const schemaErrors =
    validate.errors?.map(error => {
      const path = error.instancePath || 'root'
      return `${path}: ${error.message ?? 'schema mismatch'}`
    }) ?? ['schema mismatch']
  return {
    ok: false,
    errors: [
      ...errors,
      ...schemaErrors.map(
        error => `Agent node ${node.id} outputSchema failed: ${error}`,
      ),
    ],
  }
}
