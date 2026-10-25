import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowGuardCheck,
  MatOSWorkflowNode,
  MatOSWorkflowRuntimeNodeType,
  MatOSWorkflowValidationError,
  MatOSWorkflowValidationErrorCode,
  MatOSWorkflowValidationResult,
  MatOSWorkflowValidationWarning,
} from './types.js'
import { validateWorkflowOutputSchemaDefinition } from './outputContract.js'
import { compileWorkflowDefinition } from './workflowCompiler.js'
import {
  validateWorkflowNodeContractDefinition,
} from './workflowContracts.js'
import {
  validateWorkflowReferences,
  type WorkflowReferenceValidationOptions,
} from './workflowReferenceCheck.js'
import { validateStateMachineWorkflow } from './stateMachineCompile.js'
import { isStateMachineWorkflow } from './stateMachineTypes.js'

export type WorkflowDefinitionValidationOptions =
  WorkflowReferenceValidationOptions & {
    allowReviewedHighRiskBypass?: boolean
    assetResolver?: (reference: string) => { type: string } | undefined
  }

const SUPPORTED_NODE_TYPES = new Set<MatOSWorkflowRuntimeNodeType>([
  'agent',
  'exec',
  'guard',
  'human',
  'backend',
  'subworkflow',
  'map',
  'loop',
  'dynamic',
])

function isSupportedRuntimeNodeType(
  value: string,
): value is MatOSWorkflowRuntimeNodeType {
  return SUPPORTED_NODE_TYPES.has(value as MatOSWorkflowRuntimeNodeType)
}

const SUPPORTED_GUARD_CHECKS = new Set<MatOSWorkflowGuardCheck['type']>([
  'expression',
  'file_exists',
  'file_size',
  'grep',
  'regex',
  'numeric_range',
  'json_schema',
])

const SUPPORTED_EDGE_ROUTES = new Set(['success', 'failure', 'always'])

const VALIDATION_RECOMMENDATIONS = new Set([
  'continue',
  'retry',
  'reroute',
  'human_review',
  'fail',
])

const BUDGET_LIMIT_FIELDS = [
  'maxNodeAttempts',
  'maxAgentCalls',
  'maxToolCalls',
  'maxBackendJobs',
  'maxWallTimeMs',
  'maxElapsedWallTimeMs',
  'maxAgentTurns',
  'maxTotalTokens',
  'maxTotalCostUsd',
] as const

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function exactTemplateString(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\{\{\s*[^}]+?\s*\}\}$/.test(value.trim())
  )
}

function containsTemplate(value: unknown): boolean {
  return typeof value === 'string' && /\{\{\s*[^}]+?\s*\}\}/.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pushError(
  errors: MatOSWorkflowValidationError[],
  code: MatOSWorkflowValidationErrorCode,
  message: string,
  details: Pick<MatOSWorkflowValidationError, 'nodeId' | 'path'> = {},
): void {
  errors.push({ code, message, ...details })
}

function pushInvalidNodeConfig(
  errors: MatOSWorkflowValidationError[],
  node: MatOSWorkflowNode,
  field: string,
  message: string,
): void {
  pushError(errors, 'invalid_node_config', message, {
    nodeId: node.id,
    path: `nodes.${node.id}.${field}`,
  })
}

function checksFor(node: MatOSWorkflowNode): MatOSWorkflowGuardCheck[] {
  return Array.isArray(node.checks)
    ? node.checks.filter(
        (check): check is MatOSWorkflowGuardCheck =>
          isObject(check) && typeof check.type === 'string',
      )
    : []
}

function isPlainObjectOrExactTemplate(value: unknown): boolean {
  return (
    value === undefined ||
    exactTemplateString(value) ||
    (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  )
}

function validateRecordField(
  node: MatOSWorkflowNode,
  field: string,
  value: unknown,
  errors: MatOSWorkflowValidationError[],
): void {
  if (value === undefined || isPlainObjectOrExactTemplate(value)) {
    return
  }
  pushInvalidNodeConfig(
    errors,
    node,
    field,
    `${field} must be an object or an exact template expression`,
  )
}

function validateStringField(
  node: MatOSWorkflowNode,
  field: string,
  value: unknown,
  errors: MatOSWorkflowValidationError[],
): void {
  if (
    value === undefined ||
    typeof value === 'string' ||
    exactTemplateString(value)
  ) {
    return
  }
  pushInvalidNodeConfig(
    errors,
    node,
    field,
    `${field} must be a string or an exact template expression`,
  )
}

function validateStringListField(
  node: MatOSWorkflowNode,
  field: string,
  value: unknown,
  errors: MatOSWorkflowValidationError[],
  options: { allowString?: boolean } = {},
): void {
  if (value === undefined || exactTemplateString(value)) {
    return
  }
  if (options.allowString && typeof value === 'string') {
    return
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return
  }
  pushInvalidNodeConfig(
    errors,
    node,
    field,
    `${field} must be ${options.allowString ? 'a string, ' : ''}an array of strings, or an exact template expression`,
  )
}

function validateNumberField(
  node: MatOSWorkflowNode,
  field: string,
  value: unknown,
  errors: MatOSWorkflowValidationError[],
  options: { min?: number; integer?: boolean } = {},
): void {
  if (value === undefined || exactTemplateString(value)) {
    return
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.min !== undefined && value < options.min)
  ) {
    pushInvalidNodeConfig(
      errors,
      node,
      field,
      `${field} must be a finite ${options.integer ? 'integer' : 'number'}${
        options.min !== undefined ? ` greater than or equal to ${options.min}` : ''
      }`,
    )
  }
}

function validateJsonSchemaField(
  node: MatOSWorkflowNode,
  field: string,
  value: unknown,
  errors: MatOSWorkflowValidationError[],
): void {
  if (value === undefined || exactTemplateString(value)) {
    return
  }
  const schemaValidation = validateWorkflowOutputSchemaDefinition(value)
  if (!schemaValidation.ok) {
    pushInvalidNodeConfig(
      errors,
      node,
      field,
      `Invalid ${field}: ${schemaValidation.errors.join('; ')}`,
    )
  }
}

function normalizeOperation(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().replaceAll('_', '-').toLowerCase()
    : undefined
}

function staticAssetReference(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !containsTemplate(value)
    ? value.trim()
    : undefined
}

function backendToolRefForNode(node: MatOSWorkflowNode): string | undefined {
  const explicitTool = staticAssetReference(node.tool)
  if (explicitTool) {
    return explicitTool
  }
  return undefined
}

function validateAlgorithmDecisionDeclaration(
  node: MatOSWorkflowNode,
  errors: MatOSWorkflowValidationError[],
): void {
  if (node.algorithmDecision === undefined) return
  if (node.type !== 'backend') {
    pushInvalidNodeConfig(
      errors,
      node,
      'algorithmDecision',
      'algorithmDecision is supported only by the native backend/tool adapter',
    )
    return
  }
  const declaration = isObject(node.algorithmDecision)
    ? node.algorithmDecision
    : undefined
  if (!declaration) {
    pushInvalidNodeConfig(
      errors,
      node,
      'algorithmDecision',
      'algorithmDecision must be an object',
    )
    return
  }
  const componentRef = staticAssetReference(declaration.componentRef)
  const toolRef = staticAssetReference(node.tool)
  if (
    declaration.protocol !== 'json-v1' ||
    !componentRef ||
    !['policy', 'controller', 'optimizer'].includes(
      String(declaration.plane),
    ) ||
    !optionalString(declaration.providerId) ||
    containsTemplate(declaration.providerId) ||
    !optionalString(declaration.providerVersion) ||
    containsTemplate(declaration.providerVersion)
  ) {
    pushInvalidNodeConfig(
      errors,
      node,
      'algorithmDecision',
      'algorithmDecision must statically declare protocol=json-v1, componentRef, plane, providerId, and providerVersion',
    )
  }
  if (!toolRef || componentRef !== toolRef) {
    pushInvalidNodeConfig(
      errors,
      node,
      'algorithmDecision.componentRef',
      'algorithmDecision.componentRef must exactly match the backend node tool ref',
    )
  }
  if (declaration.config !== undefined) {
    if (!isObject(declaration.config)) {
      pushInvalidNodeConfig(
        errors,
        node,
        'algorithmDecision.config',
        'algorithmDecision.config must be a static JSON object',
      )
    } else {
      const issue = controllerConfigIssue(
        declaration.config,
        `nodes.${node.id}.algorithmDecision.config`,
      )
      if (issue) {
        pushInvalidNodeConfig(
          errors,
          node,
          'algorithmDecision.config',
          issue,
        )
      }
    }
  }
}

function validateStaticAssetReference(
  node: MatOSWorkflowNode,
  field: string,
  reference: unknown,
  expectedType: string,
  errors: MatOSWorkflowValidationError[],
  options: WorkflowDefinitionValidationOptions,
): void {
  const ref = staticAssetReference(reference)
  if (!ref || !options.assetResolver) {
    return
  }
  const asset = options.assetResolver(ref)
  if (!asset) {
    pushInvalidNodeConfig(
      errors,
      node,
      field,
      `${field} references missing MatOS ${expectedType} asset "${ref}"`,
    )
    return
  }
  if (asset.type !== expectedType) {
    pushInvalidNodeConfig(
      errors,
      node,
      field,
      `${field} references a ${asset.type} asset but expected ${expectedType}: "${ref}"`,
    )
  }
}

function validateBackendToolAllowlist(
  node: MatOSWorkflowNode,
  errors: MatOSWorkflowValidationError[],
  options: WorkflowDefinitionValidationOptions,
): string[] | undefined {
  const value = node.toolAllowlist
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item => !optionalString(item) || containsTemplate(item))
  ) {
    pushInvalidNodeConfig(
      errors,
      node,
      'toolAllowlist',
      'toolAllowlist must be a non-empty array of static tool asset references',
    )
    return undefined
  }
  const references = [...new Set(value.map(item => String(item).trim()))]
  for (const reference of references) {
    validateStaticAssetReference(
      node,
      'toolAllowlist',
      reference,
      'tool',
      errors,
      options,
    )
  }
  return references
}

function validateGuardCheckFields(
  node: MatOSWorkflowNode,
  check: MatOSWorkflowGuardCheck,
  index: number,
  errors: MatOSWorkflowValidationError[],
): void {
  const basePath = `nodes.${node.id}.checks[${index}]`
  const fieldError = (field: string, message: string) =>
    pushError(errors, 'invalid_node_config', message, {
      nodeId: node.id,
      path: `${basePath}.${field}`,
    })

  for (const [field, value] of [
    ['failureCode', check.failureCode],
    ['failureMessage', check.failureMessage],
    ['repairHint', check.repairHint],
    ['sourceNodeId', check.sourceNodeId],
  ] as const) {
    if (
      value !== undefined &&
      !optionalString(value) &&
      !exactTemplateString(value)
    ) {
      fieldError(field, `${field} must be a non-empty string`)
    }
  }
  if (check.retryable !== undefined && typeof check.retryable !== 'boolean') {
    fieldError('retryable', 'retryable must be boolean')
  }

  switch (check.type) {
    case 'file_exists':
      if (!optionalString(check.path) && !exactTemplateString(check.path)) {
        fieldError('path', 'file_exists check requires path')
      }
      break
    case 'file_size':
      if (!optionalString(check.path) && !exactTemplateString(check.path)) {
        fieldError('path', 'file_size check requires path')
      }
      for (const [field, value] of [
        ['minBytes', check.minBytes],
        ['maxBytes', check.maxBytes],
      ] as const) {
        if (
          value !== undefined &&
          !exactTemplateString(value) &&
          (typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0)
        ) {
          fieldError(field, `${field} must be a non-negative integer`)
        }
      }
      if (
        typeof check.minBytes === 'number' &&
        typeof check.maxBytes === 'number' &&
        check.minBytes > check.maxBytes
      ) {
        fieldError(
          'maxBytes',
          'file_size maxBytes must be greater than or equal to minBytes',
        )
      }
      break
    case 'grep':
      if (!optionalString(check.path) && !exactTemplateString(check.path)) {
        fieldError('path', 'grep check requires path')
      }
      if (!optionalString(check.pattern) && !exactTemplateString(check.pattern)) {
        fieldError('pattern', 'grep check requires pattern')
      }
      break
    case 'regex':
      if (
        !optionalString(check.path) &&
        !exactTemplateString(check.path) &&
        check.value === undefined
      ) {
        fieldError('path', 'regex check requires path or value')
      }
      if (!optionalString(check.pattern) && !exactTemplateString(check.pattern)) {
        fieldError('pattern', 'regex check requires pattern')
      }
      if (
        check.flags !== undefined &&
        typeof check.flags !== 'string'
      ) {
        fieldError('flags', 'regex flags must be a string')
      } else if (
        typeof check.pattern === 'string' &&
        !exactTemplateString(check.pattern) &&
        (check.flags === undefined ||
          (typeof check.flags === 'string' &&
            !exactTemplateString(check.flags)))
      ) {
        try {
          new RegExp(
            check.pattern,
            typeof check.flags === 'string' ? check.flags : '',
          )
        } catch (error) {
          fieldError(
            'pattern',
            `regex pattern or flags are invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (check.negate !== undefined && typeof check.negate !== 'boolean') {
        fieldError('negate', 'regex negate must be boolean')
      }
      break
    case 'expression':
      if (!optionalString(check.value) && !exactTemplateString(check.value)) {
        fieldError('value', 'expression check requires a string value')
      }
      break
    case 'numeric_range': {
      if (check.value === undefined) {
        fieldError('value', 'numeric_range check requires value')
      } else if (
        !exactTemplateString(check.value) &&
        (typeof check.value !== 'number' || !Number.isFinite(check.value))
      ) {
        fieldError('value', 'numeric_range value must be a finite number')
      }
      if (
        check.min !== undefined &&
        !exactTemplateString(check.min) &&
        (typeof check.min !== 'number' || !Number.isFinite(check.min))
      ) {
        fieldError('min', 'numeric_range min must be a finite number')
      }
      if (
        check.max !== undefined &&
        !exactTemplateString(check.max) &&
        (typeof check.max !== 'number' || !Number.isFinite(check.max))
      ) {
        fieldError('max', 'numeric_range max must be a finite number')
      }
      if (
        check.notEqual !== undefined &&
        !exactTemplateString(check.notEqual) &&
        (typeof check.notEqual !== 'number' || !Number.isFinite(check.notEqual))
      ) {
        fieldError('notEqual', 'numeric_range notEqual must be a finite number')
      }
      if (
        typeof check.min === 'number' &&
        typeof check.max === 'number' &&
        check.min > check.max
      ) {
        fieldError('max', 'numeric_range max must be greater than or equal to min')
      }
      break
    }
    case 'json_schema': {
      if (check.schema === undefined) {
        fieldError('schema', 'json_schema check requires schema')
      } else if (!exactTemplateString(check.schema)) {
        const schemaValidation = validateWorkflowOutputSchemaDefinition(check.schema)
        if (!schemaValidation.ok) {
          fieldError(
            'schema',
            `Invalid json_schema schema: ${schemaValidation.errors.join('; ')}`,
          )
        }
      }
      break
    }
  }
}

function stringArrayField(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validateComputeLifecycle(
  node: MatOSWorkflowNode,
  errors: MatOSWorkflowValidationError[],
): void {
  if (node.computeLifecycle === undefined) {
    return
  }
  if (!isObject(node.computeLifecycle) && !exactTemplateString(node.computeLifecycle)) {
    pushInvalidNodeConfig(
      errors,
      node,
      'computeLifecycle',
      'computeLifecycle must be an object or an exact template expression',
    )
    return
  }
  if (!isObject(node.computeLifecycle)) {
    return
  }
  const poll = node.computeLifecycle.poll
  if (poll === undefined) {
    return
  }
  if (!isObject(poll) && !exactTemplateString(poll)) {
    pushError(errors, 'invalid_node_config', 'computeLifecycle.poll must be an object', {
      nodeId: node.id,
      path: `nodes.${node.id}.computeLifecycle.poll`,
    })
    return
  }
  if (!isObject(poll)) {
    return
  }
  if (
    poll.intervalMs !== undefined &&
    !exactTemplateString(poll.intervalMs) &&
    (typeof poll.intervalMs !== 'number' ||
      !Number.isFinite(poll.intervalMs) ||
      poll.intervalMs < 1)
  ) {
    pushError(
      errors,
      'invalid_node_config',
      'computeLifecycle.poll.intervalMs must be a positive number',
      { nodeId: node.id, path: `nodes.${node.id}.computeLifecycle.poll.intervalMs` },
    )
  }
  if (
    poll.maxPolls !== undefined &&
    !exactTemplateString(poll.maxPolls) &&
    (!Number.isInteger(poll.maxPolls) || Number(poll.maxPolls) < 1)
  ) {
    pushError(
      errors,
      'invalid_node_config',
      'computeLifecycle.poll.maxPolls must be an integer greater than or equal to 1',
      { nodeId: node.id, path: `nodes.${node.id}.computeLifecycle.poll.maxPolls` },
    )
  }
  for (const field of ['terminalStatuses', 'failureStatuses'] as const) {
    const value = poll[field]
    if (
      value !== undefined &&
      !exactTemplateString(value) &&
      !stringArrayField(value)
    ) {
      pushError(
        errors,
        'invalid_node_config',
        `computeLifecycle.poll.${field} must be an array of strings`,
        { nodeId: node.id, path: `nodes.${node.id}.computeLifecycle.poll.${field}` },
      )
    }
  }
}

function validateNodePayload(
  node: MatOSWorkflowNode,
  errors: MatOSWorkflowValidationError[],
  options: WorkflowDefinitionValidationOptions,
): void {
  if (node.outputSchema !== undefined) {
    if (node.type !== 'agent') {
      pushError(
        errors,
        'invalid_output_schema',
        'outputSchema is currently supported only on agent nodes',
        {
          nodeId: node.id,
          path: `nodes.${node.id}.outputSchema`,
        },
      )
    } else {
      const schemaValidation = validateWorkflowOutputSchemaDefinition(
        node.outputSchema,
      )
      if (!schemaValidation.ok) {
        pushError(
          errors,
          'invalid_output_schema',
          `Invalid outputSchema: ${schemaValidation.errors.join('; ')}`,
          {
            nodeId: node.id,
            path: `nodes.${node.id}.outputSchema`,
          },
        )
      }
    }
  }

  validateAlgorithmDecisionDeclaration(node, errors)

  switch (node.type) {
    case 'agent':
      if (!optionalString(node.role)) {
        pushError(errors, 'missing_field', 'Agent node requires role', {
          nodeId: node.id,
          path: `nodes.${node.id}.role`,
        })
      }
      if (!optionalString(node.prompt) && !optionalString(node.systemPrompt)) {
        pushError(
          errors,
          'missing_field',
          'Agent node requires prompt or systemPrompt',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.prompt`,
          },
        )
      }
      validateStringListField(node, 'passthroughArgs', node.passthroughArgs, errors)
      validateStaticAssetReference(
        node,
        'role',
        node.role,
        'role',
        errors,
        options,
      )
      break
    case 'exec':
      if (!optionalString(node.command)) {
        pushError(errors, 'missing_field', 'Exec node requires command', {
          nodeId: node.id,
          path: `nodes.${node.id}.command`,
        })
      }
      if (
        node.args !== undefined &&
        (!Array.isArray(node.args) ||
          node.args.some(arg => typeof arg !== 'string'))
      ) {
        pushError(
          errors,
          'invalid_node_config',
          'Exec node args must be an array of strings',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.args`,
          },
        )
      }
      validateStringField(node, 'cwd', node.cwd, errors)
      validateRecordField(node, 'env', node.env, errors)
      if (node.env && isObject(node.env)) {
        for (const [key, value] of Object.entries(node.env)) {
          if (
            value !== undefined &&
            !exactTemplateString(value) &&
            typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean'
          ) {
            pushError(
              errors,
              'invalid_node_config',
              `Exec node env.${key} must be a string, number, boolean, or exact template expression`,
              { nodeId: node.id, path: `nodes.${node.id}.env.${key}` },
            )
          }
        }
      }
      validateNumberField(node, 'timeoutMs', node.timeoutMs, errors, { min: 1 })
      validateNumberField(node, 'timeoutSeconds', node.timeoutSeconds, errors, {
        min: 0.001,
      })
      if (
        node.detectKnownProcessFailures !== undefined &&
        typeof node.detectKnownProcessFailures !== 'boolean'
      ) {
        pushError(
          errors,
          'invalid_node_config',
          'Exec node detectKnownProcessFailures must be boolean',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.detectKnownProcessFailures`,
          },
        )
      }
      break
    case 'guard': {
      // Semantic `validate` nodes compile to runtime guards; keep the agent's
      // authored vocabulary in the message so the repair target is obvious.
      const guardLabel = node.targetType === 'validate' ? 'Validate' : 'Guard'
      const supportedGuardChecks = [...SUPPORTED_GUARD_CHECKS].join(', ')
      const rawChecks = Array.isArray(node.checks) ? node.checks : []
      const checks = checksFor(node)
      if (checks.length === 0) {
        pushError(
          errors,
          'missing_field',
          rawChecks.length > 0
            ? `${guardLabel} node checks must be objects with a string "type" (supported types: ${supportedGuardChecks})`
            : `${guardLabel} node requires checks (supported types: ${supportedGuardChecks})`,
          {
            nodeId: node.id,
            path: `nodes.${node.id}.checks`,
          },
        )
      } else if (rawChecks.length > checks.length) {
        pushError(
          errors,
          'missing_field',
          `${guardLabel} node has ${rawChecks.length - checks.length} check entr${rawChecks.length - checks.length === 1 ? 'y' : 'ies'} without a string "type" (supported types: ${supportedGuardChecks})`,
          { nodeId: node.id, path: `nodes.${node.id}.checks` },
        )
      }
      for (const [index, check] of checks.entries()) {
        if (!SUPPORTED_GUARD_CHECKS.has(check.type)) {
          pushError(
            errors,
            'missing_field',
            `Unsupported guard check type "${String(check.type)}" (supported types: ${supportedGuardChecks})`,
            { nodeId: node.id, path: `nodes.${node.id}.checks` },
          )
          continue
        }
        validateGuardCheckFields(node, check, index, errors)
      }
      break
    }
    case 'backend':
      const toolAllowlist = validateBackendToolAllowlist(
        node,
        errors,
        options,
      )
      const resolvedBackendTool = backendToolRefForNode(node)
      if (
        toolAllowlist &&
        resolvedBackendTool &&
        !toolAllowlist.includes(resolvedBackendTool)
      ) {
        pushInvalidNodeConfig(
          errors,
          node,
          'toolAllowlist',
          `Resolved backend tool "${resolvedBackendTool}" is not present in toolAllowlist`,
        )
      }
      if (node.targetType === 'instrument') {
        if (!optionalString(node.instrument)) {
          pushError(
            errors,
            'missing_field',
            'Instrument node requires instrument id',
            {
              nodeId: node.id,
              path: `nodes.${node.id}.instrument`,
            },
          )
        }
        // The adapter contract is explicit: an instrument node must name its
        // adapter tool asset instead of relying on backend defaults.
        if (!staticAssetReference(node.tool) && !containsTemplate(node.tool)) {
          pushError(
            errors,
            'missing_field',
            'Instrument node requires an explicit adapter tool asset ref (tool: "tool:<adapter-id>")',
            {
              nodeId: node.id,
              path: `nodes.${node.id}.tool`,
            },
          )
        }
      }
      if (!optionalString(node.backend)) {
        // Semantic `compute` nodes compile to runtime backend nodes; name the
        // authored type so the message points at what the agent actually wrote.
        pushError(
          errors,
          'missing_field',
          `${node.targetType === 'compute' ? 'Compute' : 'Backend'} node requires backend`,
          {
            nodeId: node.id,
            path: `nodes.${node.id}.backend`,
          },
        )
      }
      validateRecordField(node, 'input', node.input, errors)
      validateRecordField(node, 'inputs', node.inputs, errors)
      validateRecordField(node, 'toolInput', node.toolInput, errors)
      if (
        optionalString(node.backend) &&
        !containsTemplate(node.backend) &&
        backendToolRefForNode(node) === undefined &&
        !staticAssetReference(node.tool) &&
        !(containsTemplate(node.tool) && toolAllowlist)
      ) {
        pushInvalidNodeConfig(
          errors,
          node,
          'backend',
          `Backend node cannot resolve a tool for backend "${String(node.backend)}"${
            optionalString(node.operation) ? ` and operation "${String(node.operation)}"` : ''
          }; set a supported backend operation or explicit tool`,
        )
      }
      validateStaticAssetReference(
        node,
        'tool',
        resolvedBackendTool,
        'tool',
        errors,
        options,
      )
      validateComputeLifecycle(node, errors)
      break
    case 'subworkflow':
      if (!optionalString(node.workflow)) {
        pushError(
          errors,
          'missing_field',
          'Subworkflow node requires workflow',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.workflow`,
          },
        )
      }
      validateRecordField(node, 'parameters', node.parameters, errors)
      validateStringListField(node, 'outputKeys', node.outputKeys, errors, {
        allowString: true,
      })
      validateStaticAssetReference(
        node,
        'workflow',
        node.workflow,
        'workflow',
        errors,
        options,
      )
      break
    case 'map':
      if (!optionalString(node.workflow)) {
        pushError(
          errors,
          'missing_field',
          'Map node requires workflow: a published child workflow ref (e.g. "workflow:<id>") that runs once per item. Map does not accept an inline node template — publish the per-item work as its own workflow first (one-call: workflow_edit action=author), then reference it here.',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.workflow`,
          },
        )
      }
      if (node.items === undefined) {
        pushError(errors, 'missing_field', 'Map node requires items', {
          nodeId: node.id,
          path: `nodes.${node.id}.items`,
        })
      }
      if (
        node.items !== undefined &&
        !Array.isArray(node.items) &&
        !exactTemplateString(node.items)
      ) {
        pushInvalidNodeConfig(
          errors,
          node,
          'items',
          'Map node items must be an array or an exact template expression resolving to an array',
        )
      }
      if (
        node.maxParallel !== undefined &&
        !exactTemplateString(node.maxParallel) &&
        (!Number.isInteger(node.maxParallel) || Number(node.maxParallel) < 1)
      ) {
        pushError(
          errors,
          'invalid_policy',
          'Map node maxParallel must be an integer greater than or equal to 1',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.maxParallel`,
          },
        )
      }
      if (
        node.maxItems !== undefined &&
        !exactTemplateString(node.maxItems) &&
        (!Number.isInteger(node.maxItems) || Number(node.maxItems) < 1)
      ) {
        pushError(
          errors,
          'invalid_policy',
          'Map node maxItems must be an integer greater than or equal to 1',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.maxItems`,
          },
        )
      }
      validateRecordField(node, 'parameters', node.parameters, errors)
      validateStringField(node, 'itemParameter', node.itemParameter, errors)
      validateStringListField(node, 'outputKeys', node.outputKeys, errors, {
        allowString: true,
      })
      validateStringListField(node, 'outputs', node.outputs, errors, {
        allowString: true,
      })
      if (
        node.failureMode !== undefined &&
        node.failureMode !== 'aggregate' &&
        node.failureMode !== 'fail_fast'
      ) {
        pushInvalidNodeConfig(
          errors,
          node,
          'failureMode',
          'Map node failureMode must be "aggregate" or "fail_fast"',
        )
      }
      validateStaticAssetReference(
        node,
        'workflow',
        node.workflow,
        'workflow',
        errors,
        options,
      )
      break
    case 'loop':
      if (!optionalString(node.workflow)) {
        pushError(errors, 'missing_field', 'Loop node requires workflow', {
          nodeId: node.id,
          path: `nodes.${node.id}.workflow`,
        })
      }
      if (
        !exactTemplateString(node.maxIterations) &&
        (!Number.isInteger(node.maxIterations) ||
          Number(node.maxIterations) < 1)
      ) {
        pushError(
          errors,
          'missing_field',
          'Loop node requires maxIterations greater than or equal to 1 or an exact template expression',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.maxIterations`,
          },
        )
      }
      validateRecordField(node, 'parameters', node.parameters, errors)
      validateStringField(node, 'iterationParameter', node.iterationParameter, errors)
      validateStringField(node, 'stateParameter', node.stateParameter, errors)
      validateStringField(node, 'previousParameter', node.previousParameter, errors)
      validateStringListField(node, 'outputKeys', node.outputKeys, errors, {
        allowString: true,
      })
      validateStringListField(node, 'outputs', node.outputs, errors, {
        allowString: true,
      })
      validateRecordField(node, 'initialState', node.initialState, errors)
      validateRecordField(node, 'nextState', node.nextState, errors)
      validateRecordField(node, 'nextParameters', node.nextParameters, errors)
      validateStaticAssetReference(
        node,
        'workflow',
        node.workflow,
        'workflow',
        errors,
        options,
      )
      break
    case 'human':
      validateJsonSchemaField(node, 'responseSchema', node.responseSchema, errors)
      break
    case 'dynamic':
      if (
        node.candidate === undefined &&
        node.input === undefined &&
        (!optionalString(node.role) || !optionalString(node.prompt))
      ) {
        pushError(
          errors,
          'missing_field',
          'Dynamic node requires candidate or planner role+prompt',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.candidate`,
          },
        )
      }
      validateRecordField(node, 'input', node.input, errors)
      if (node.candidate !== undefined) {
        validateRecordField(node, 'candidate', node.candidate, errors)
      }
      validateStaticAssetReference(
        node,
        'role',
        node.role,
        'role',
        errors,
        options,
      )
      break
  }

  const contractErrors = validateWorkflowNodeContractDefinition(node)
  for (const error of contractErrors) {
    pushError(errors, 'invalid_output_schema', error, {
      nodeId: node.id,
      path: `nodes.${node.id}`,
    })
  }
}

const CONTROLLER_BOUND_KEYS = [
  'maxActions',
  'maxCandidates',
  'maxDepth',
  'maxWallTimeMs',
  'maxCostUsd',
] as const

const CONTROLLER_BUDGET_KEYS = [
  'actions',
  'candidates',
  'transitions',
  'evaluations',
  'maxDepth',
  'wallTimeMs',
  'costUsd',
] as const

const SECRET_LIKE_CONTROLLER_KEY =
  /(?:^|_)(secret|token|password|passwd|api_key|apikey|credential|private_key)(?:$|_)/i

function normalizedControllerConfigKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

function controllerConfigIssue(
  value: unknown,
  path = 'policy.controller.config',
  seen = new WeakSet<object>(),
): string | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return undefined
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return `${path} contains a cycle`
    seen.add(value)
    for (const [index, item] of value.entries()) {
      const issue = controllerConfigIssue(item, `${path}[${index}]`, seen)
      if (issue) return issue
    }
    seen.delete(value)
    return undefined
  }
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return `${path} must contain plain JSON values only`
  }
  if (seen.has(value)) return `${path} contains a cycle`
  seen.add(value)
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_LIKE_CONTROLLER_KEY.test(normalizedControllerConfigKey(key))) {
      return `${path}.${key} is secret-like and cannot be stored in a workflow asset`
    }
    if (item === undefined) return `${path}.${key} must not be undefined`
    const issue = controllerConfigIssue(item, `${path}.${key}`, seen)
    if (issue) return issue
  }
  seen.delete(value)
  return undefined
}

function validateControllerPolicy(
  definition: MatOSWorkflowDefinition,
  errors: MatOSWorkflowValidationError[],
): void {
  const controller = definition.policy.controller
  if (controller === undefined) return
  if (!isObject(controller)) {
    pushError(
      errors,
      'invalid_policy',
      'Workflow controller policy must be an object',
      { path: 'policy.controller' },
    )
    return
  }
  if (controller.enabled !== undefined && typeof controller.enabled !== 'boolean') {
    pushError(errors, 'invalid_policy', 'Controller enabled must be boolean', {
      path: 'policy.controller.enabled',
    })
  }
  if (controller.enabled !== false && !optionalString(controller.provider)) {
    pushError(errors, 'invalid_policy', 'Enabled controller requires provider', {
      path: 'policy.controller.provider',
    })
  }
  if (controller.version !== undefined && !optionalString(controller.version)) {
    pushError(errors, 'invalid_policy', 'Controller version must be non-empty', {
      path: 'policy.controller.version',
    })
  }
  if (
    controller.objectiveRef !== undefined &&
    !optionalString(controller.objectiveRef)
  ) {
    pushError(
      errors,
      'invalid_policy',
      'Controller objectiveRef must be a non-empty string',
      { path: 'policy.controller.objectiveRef' },
    )
  }
  if (
    controller.mode !== undefined &&
    controller.mode !== 'active' &&
    controller.mode !== 'shadow'
  ) {
    pushError(errors, 'invalid_policy', 'Controller mode must be active or shadow', {
      path: 'policy.controller.mode',
    })
  }
  if (
    controller.onFailure !== undefined &&
    controller.onFailure !== 'baseline' &&
    controller.onFailure !== 'pause' &&
    controller.onFailure !== 'fail'
  ) {
    pushError(
      errors,
      'invalid_policy',
      'Controller onFailure must be baseline, pause, or fail',
      { path: 'policy.controller.onFailure' },
    )
  }
  if (
    controller.seed !== undefined &&
    (!Number.isSafeInteger(controller.seed) || Number(controller.seed) < 0)
  ) {
    pushError(
      errors,
      'invalid_policy',
      'Controller seed must be a non-negative safe integer',
      { path: 'policy.controller.seed' },
    )
  }
  if (controller.bounds !== undefined) {
    if (!isObject(controller.bounds)) {
      pushError(errors, 'invalid_policy', 'Controller bounds must be an object', {
        path: 'policy.controller.bounds',
      })
    } else {
      for (const key of CONTROLLER_BOUND_KEYS) {
        const value = controller.bounds[key]
        const integer = key !== 'maxWallTimeMs' && key !== 'maxCostUsd'
        const minimumInvalid =
          key === 'maxCostUsd'
            ? typeof value === 'number' && value < 0
            : typeof value === 'number' && value <= 0
        if (
          value !== undefined &&
          (typeof value !== 'number' ||
            !Number.isFinite(value) ||
            minimumInvalid ||
            (integer && !Number.isSafeInteger(value)))
        ) {
          const requirement =
            key === 'maxCostUsd'
              ? 'a non-negative number'
              : `a positive ${integer ? 'integer' : 'number'}`
          pushError(
            errors,
            'invalid_policy',
            `Controller bound ${key} must be ${requirement}`,
            { path: `policy.controller.bounds.${key}` },
          )
        }
      }
    }
  }
  if (controller.budget !== undefined) {
    if (!isObject(controller.budget)) {
      pushError(errors, 'invalid_policy', 'Controller budget must be an object', {
        path: 'policy.controller.budget',
      })
    } else {
      for (const key of CONTROLLER_BUDGET_KEYS) {
        const value = controller.budget[key]
        const integer = !['wallTimeMs', 'costUsd'].includes(key)
        const minimumInvalid =
          key === 'actions' && controller.enabled !== false
            ? typeof value === 'number' && value < 1
            : typeof value === 'number' && value < 0
        if (
          value !== undefined &&
          (typeof value !== 'number' ||
            !Number.isFinite(value) ||
            minimumInvalid ||
            (integer && !Number.isSafeInteger(value)))
        ) {
          const requirement =
            key === 'actions' && controller.enabled !== false
              ? 'a positive integer'
              : `a non-negative ${integer ? 'integer' : 'number'}`
          pushError(
            errors,
            'invalid_policy',
            `Controller budget ${key} must be ${requirement}`,
            { path: `policy.controller.budget.${key}` },
          )
        }
      }
    }
  }
  if (controller.config !== undefined) {
    const issue = controllerConfigIssue(controller.config)
    if (issue) {
      pushError(errors, 'invalid_policy', issue, {
        path: 'policy.controller.config',
      })
    }
  }
}

function validatePolicy(
  definition: MatOSWorkflowDefinition,
  errors: MatOSWorkflowValidationError[],
  options: WorkflowDefinitionValidationOptions,
): void {
  validateControllerPolicy(definition, errors)
  const approvalMode = definition.policy.approvalMode
  if (
    approvalMode !== undefined &&
    approvalMode !== 'bypass' &&
    approvalMode !== 'ask' &&
    approvalMode !== 'strict'
  ) {
    pushError(
      errors,
      'invalid_policy',
      `Unsupported workflow approvalMode "${String(approvalMode)}"`,
      { path: 'policy.approvalMode' },
    )
  }

  if (!options.allowReviewedHighRiskBypass) {
    for (const node of definition.nodes) {
      if (node.policy?.reviewedHighRiskBypass === true) {
        pushError(
          errors,
          'invalid_policy',
          'reviewedHighRiskBypass is a trusted runtime/operator flag and cannot be supplied by workflow assets',
          {
            nodeId: node.id,
            path: `nodes.${node.id}.policy.reviewedHighRiskBypass`,
          },
        )
      }
    }
  }

  const budget = definition.policy.budget
  if (budget !== undefined) {
    if (!isObject(budget)) {
      pushError(
        errors,
        'invalid_policy',
        'Workflow budget policy must be an object',
        { path: 'policy.budget' },
      )
    } else {
      for (const limit of BUDGET_LIMIT_FIELDS) {
        const value = (budget as Record<string, unknown>)[limit]
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        ) {
          pushError(
            errors,
            'invalid_policy',
            `Workflow budget ${limit} must be a non-negative number`,
            { path: `policy.budget.${limit}` },
          )
        }
      }
      const onExceeded = (budget as Record<string, unknown>).onExceeded
      if (
        onExceeded !== undefined &&
        onExceeded !== 'fail' &&
        onExceeded !== 'pause'
      ) {
        pushError(
          errors,
          'invalid_policy',
          `Unsupported workflow budget onExceeded "${String(onExceeded)}"`,
          { path: 'policy.budget.onExceeded' },
        )
      }
    }
  }

  for (const node of definition.nodes) {
    const nodeBudget = node.budget
    if (nodeBudget === undefined) {
      continue
    }
    if (!isObject(nodeBudget)) {
      pushError(
        errors,
        'invalid_policy',
        'Node budget must be an object',
        { nodeId: node.id, path: `nodes.${node.id}.budget` },
      )
      continue
    }
    for (const limit of BUDGET_LIMIT_FIELDS) {
      const value = (nodeBudget as Record<string, unknown>)[limit]
      if (
        value !== undefined &&
        !exactTemplateString(value) &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      ) {
        pushError(
          errors,
          'invalid_policy',
          `Node budget ${limit} must be a non-negative number`,
          { nodeId: node.id, path: `nodes.${node.id}.budget.${limit}` },
        )
      }
    }
  }

  for (const node of definition.nodes) {
    const approval = node.policy?.approval
    if (
      approval !== undefined &&
      approval !== 'inherit' &&
      approval !== 'bypass' &&
      approval !== 'ask' &&
      approval !== 'require'
    ) {
      pushError(
        errors,
        'invalid_policy',
        `Unsupported node approval policy "${String(approval)}"`,
        { nodeId: node.id, path: `nodes.${node.id}.policy.approval` },
      )
    }

    const retry = node.policy?.retry
    if (retry === undefined) {
      continue
    }
    if (!isObject(retry)) {
      pushError(
        errors,
        'invalid_policy',
        'Node retry policy must be an object',
        { nodeId: node.id, path: `nodes.${node.id}.policy.retry` },
      )
      continue
    }

    const maxAttempts = retry.maxAttempts
    if (
      maxAttempts !== undefined &&
      (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    ) {
      pushError(
        errors,
        'invalid_policy',
        'Node retry maxAttempts must be an integer greater than or equal to 1',
        { nodeId: node.id, path: `nodes.${node.id}.policy.retry.maxAttempts` },
      )
    }

    const backoffMs = retry.backoffMs
    if (
      backoffMs !== undefined &&
      (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0)
    ) {
      pushError(
        errors,
        'invalid_policy',
        'Node retry backoffMs must be a non-negative number',
        { nodeId: node.id, path: `nodes.${node.id}.policy.retry.backoffMs` },
      )
    }

    const retryableExitCodes = retry.retryableExitCodes
    if (
      retryableExitCodes !== undefined &&
      (!Array.isArray(retryableExitCodes) ||
        retryableExitCodes.some(
          code => !Number.isInteger(code) || code < 0,
        ))
    ) {
      pushError(
        errors,
        'invalid_policy',
        'Node retry retryableExitCodes must be an array of non-negative integers',
        {
          nodeId: node.id,
          path: `nodes.${node.id}.policy.retry.retryableExitCodes`,
        },
      )
    }

    const retryableErrorPatterns = retry.retryableErrorPatterns
    if (
      retryableErrorPatterns !== undefined &&
      (!Array.isArray(retryableErrorPatterns) ||
        retryableErrorPatterns.some(pattern => typeof pattern !== 'string'))
    ) {
      pushError(
        errors,
        'invalid_policy',
        'Node retry retryableErrorPatterns must be an array of strings',
        {
          nodeId: node.id,
          path: `nodes.${node.id}.policy.retry.retryableErrorPatterns`,
        },
      )
    }
  }
}

function validateEdges(
  definition: MatOSWorkflowDefinition,
  ids: Set<string>,
  errors: MatOSWorkflowValidationError[],
): void {
  for (const edge of definition.edges ?? []) {
    if (!ids.has(edge.from)) {
      pushError(
        errors,
        'missing_node_dependency',
        `Workflow edge depends on missing source node "${edge.from}"`,
        { nodeId: edge.to, path: `edges.${edge.from}->${edge.to}.from` },
      )
    }
    if (!ids.has(edge.to)) {
      pushError(
        errors,
        'missing_node_dependency',
        `Workflow edge targets missing node "${edge.to}"`,
        { nodeId: edge.to, path: `edges.${edge.from}->${edge.to}.to` },
      )
    }
    if (
      edge.route !== undefined &&
      !SUPPORTED_EDGE_ROUTES.has(String(edge.route))
    ) {
      pushError(
        errors,
        'invalid_policy',
        `Unsupported workflow edge route "${String(edge.route)}"`,
        { nodeId: edge.to, path: `edges.${edge.from}->${edge.to}.route` },
      )
    }
  }
}

function validateAcyclic(
  definition: MatOSWorkflowDefinition,
  nodeById: Map<string, MatOSWorkflowNode>,
  errors: MatOSWorkflowValidationError[],
): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const reported = new Set<string>()

  function visit(node: MatOSWorkflowNode, path: string[]): void {
    if (visited.has(node.id)) {
      return
    }
    if (visiting.has(node.id)) {
      const cycleStart = path.indexOf(node.id)
      const cycle = [...path.slice(Math.max(0, cycleStart)), node.id]
      const signature = cycle.join(' -> ')
      if (!reported.has(signature)) {
        reported.add(signature)
        pushError(
          errors,
          'workflow_cycle',
          `Workflow dependency cycle: ${signature}`,
          { nodeId: node.id },
        )
      }
      return
    }

    visiting.add(node.id)
    for (const dependency of node.dependsOn) {
      const next = nodeById.get(dependency)
      if (next) {
        visit(next, [...path, node.id])
      }
    }
    visiting.delete(node.id)
    visited.add(node.id)
  }

  for (const node of definition.nodes) {
    visit(node, [])
  }
}

/**
 * Transitive upstream ancestors of `startId` over post-compile `dependsOn`.
 * `compileWorkflowDefinition` merges every edge source into the target node's
 * `dependsOn`, so this reachability is exactly the inverse of the scheduler's
 * `downstreamWorkflowNodeIds` reset closure (dependsOn + incomingEdges).
 * Missing dependency ids are reported elsewhere and skipped here; the visited
 * set keeps this terminating even on (separately reported) cyclic graphs.
 */
function transitiveAncestorNodeIds(
  nodeById: Map<string, MatOSWorkflowNode>,
  startId: string,
): Set<string> {
  const ancestors = new Set<string>()
  const queue = [...(nodeById.get(startId)?.dependsOn ?? [])]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (ancestors.has(id)) {
      continue
    }
    ancestors.add(id)
    for (const dependency of nodeById.get(id)?.dependsOn ?? []) {
      queue.push(dependency)
    }
  }
  return ancestors
}

/**
 * A validate/guard node's `retryNodeId` (alias `retryNode`) is consumed by the
 * runtime validation `retry` recommendation, which resets the target node plus
 * its transitive downstream closure so the validator re-runs against repaired
 * producer output. The reset only re-arms the validator when the validator is
 * inside that closure — i.e. the target is the validator itself or one of its
 * transitive upstream ancestors. Any other value (missing node, sibling,
 * downstream node) records a completed retry attempt but never resets the
 * validator, so the run idles forever. The runtime reads the field literally
 * (no template interpolation), so a static literal check here matches runtime
 * behavior exactly. Enforced for DAG workflows only: the reset closure is DAG
 * scheduler semantics, while state-machine runs advance via transitions.
 */
function validateValidationRetryTargets(
  definition: MatOSWorkflowDefinition,
  nodeById: Map<string, MatOSWorkflowNode>,
  errors: MatOSWorkflowValidationError[],
): void {
  for (const node of definition.nodes) {
    if (node.type !== 'guard' && node.targetType !== 'validate') {
      continue
    }
    // Mirror the runtime's field precedence (`retryNodeId ?? retryNode`).
    const direct = node.retryNodeId ?? node.retryNode
    if (direct === undefined || direct === null) {
      continue
    }
    const field = node.retryNodeId !== undefined && node.retryNodeId !== null
      ? 'retryNodeId'
      : 'retryNode'
    const label = node.targetType === 'validate' ? 'Validate' : 'Guard'
    if (typeof direct !== 'string' || direct.trim().length === 0) {
      pushInvalidNodeConfig(
        errors,
        node,
        field,
        `${label} node ${field} must be a non-empty string node id (the upstream producer to reset when validation recommends retry)`,
      )
      continue
    }
    const target = direct.trim()
    if (!nodeById.has(target)) {
      pushInvalidNodeConfig(
        errors,
        node,
        field,
        `${label} node ${field} references missing node "${target}"${
          containsTemplate(target)
            ? '; the runtime reads this field literally, so template expressions are not resolved here'
            : ''
        }`,
      )
      continue
    }
    // Self-reference is allowed: the runtime reset closure starts at the
    // target itself, so `retryNodeId: <validator id>` still re-runs the
    // validator.
    if (
      target !== node.id &&
      !transitiveAncestorNodeIds(nodeById, node.id).has(target)
    ) {
      pushInvalidNodeConfig(
        errors,
        node,
        field,
        `${label} node ${field} "${target}" must be a transitive upstream ancestor of "${node.id}" (via dependsOn or edges); resetting a non-ancestor never re-runs the validator, so the retry loop stalls the run`,
      )
    }
  }
}

const CHILD_WORKFLOW_NODE_TYPES = new Set<MatOSWorkflowRuntimeNodeType>([
  'subworkflow',
  'map',
  'loop',
])

/** Strip the `workflow:` asset-type prefix and any `@version` suffix. */
function workflowRefId(ref: string): string {
  const withoutType = ref.startsWith('workflow:')
    ? ref.slice('workflow:'.length)
    : ref
  const at = withoutType.indexOf('@')
  return (at >= 0 ? withoutType.slice(0, at) : withoutType).trim()
}

/**
 * Identity candidates for the workflow being validated. A definition carries
 * only its `name`; published asset ids are derived from it with the same
 * sanitization as workflowStore's `sanitizeId` (non `[A-Za-z0-9._-]` runs
 * become `-`), so compare against both the raw and the sanitized form.
 */
function selfWorkflowIdCandidates(definition: MatOSWorkflowDefinition): Set<string> {
  const name = typeof definition.name === 'string' ? definition.name.trim() : ''
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return new Set([name, sanitized].filter(value => value.length > 0))
}

/**
 * Static half of the cross-workflow recursion guard: a subworkflow/map/loop
 * node must not invoke the workflow it is defined in. Direct self-recursion
 * would spawn child runs of the same definition without bound — the intra-run
 * cycle check above cannot see it because the recursion crosses run
 * boundaries. Only statically resolvable refs are checked (template refs and
 * ids that differ from the definition name resolve at runtime); transitive
 * cycles (A -> B -> A) and a runtime recursion-depth cap belong to child-run
 * resolution in the workflow runtime.
 */
function validateNoDirectSelfRecursion(
  definition: MatOSWorkflowDefinition,
  errors: MatOSWorkflowValidationError[],
): void {
  const selfIds = selfWorkflowIdCandidates(definition)
  if (selfIds.size === 0) {
    return
  }
  for (const node of definition.nodes) {
    if (!CHILD_WORKFLOW_NODE_TYPES.has(node.type as MatOSWorkflowRuntimeNodeType)) {
      continue
    }
    const ref = staticAssetReference(node.workflow)
    if (!ref) {
      continue
    }
    if (selfIds.has(workflowRefId(ref))) {
      const label =
        node.type === 'map' ? 'Map' : node.type === 'loop' ? 'Loop' : 'Subworkflow'
      pushError(
        errors,
        'workflow_cycle',
        `${label} node "${node.id}" references its own workflow ("${ref}"); direct self-recursion is not allowed because every child run would re-enter this definition without bound`,
        { nodeId: node.id, path: `nodes.${node.id}.workflow` },
      )
    }
  }
}

export function validateWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
  options: WorkflowDefinitionValidationOptions = {},
): MatOSWorkflowValidationResult {
  definition = compileWorkflowDefinition(definition)
  const errors: MatOSWorkflowValidationError[] = []
  const ids = new Set<string>()
  const nodeById = new Map<string, MatOSWorkflowNode>()

  if (!optionalString(definition.name)) {
    pushError(errors, 'missing_field', 'Workflow requires name', {
      path: 'name',
    })
  }

  for (const node of definition.nodes) {
    if (!optionalString(node.id)) {
      pushError(errors, 'missing_field', 'Workflow node requires id', {
        path: 'nodes[].id',
      })
      continue
    }
    if (ids.has(node.id)) {
      pushError(errors, 'duplicate_node_id', `Duplicate node id "${node.id}"`, {
        nodeId: node.id,
      })
      continue
    }
    ids.add(node.id)
    nodeById.set(node.id, node)
  }

  for (const node of definition.nodes) {
    if (!isSupportedRuntimeNodeType(node.type)) {
      pushError(
        errors,
        'invalid_node_type',
        `Unsupported workflow node type "${String(node.type)}"`,
        { nodeId: node.id, path: `nodes.${node.id}.type` },
      )
      continue
    }

    validateNodePayload(node, errors, options)

    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        pushError(
          errors,
          'missing_node_dependency',
          `Node "${node.id}" depends on missing node "${dependency}"`,
          { nodeId: node.id, path: `nodes.${node.id}.dependsOn` },
        )
      }
    }
  }

  validatePolicy(definition, errors, options)
  validateEdges(definition, ids, errors)
  errors.push(...validateWorkflowReferences(definition, options))
  // Applies to both execution models: self-recursion crosses run boundaries,
  // so it is invisible to both the DAG cycle check and the state-machine
  // transition validation.
  validateNoDirectSelfRecursion(definition, errors)
  if (isStateMachineWorkflow(definition)) {
    errors.push(...validateStateMachineWorkflow(definition))
  } else {
    validateAcyclic(definition, nodeById, errors)
    validateValidationRetryTargets(definition, nodeById, errors)
  }

  const warnings = budgetEstimateWarnings(definition)

  return {
    ok: errors.length === 0,
    errors,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 1
    ? Number(value)
    : undefined
}

/**
 * Static worst-case attempt estimate for one node: retry attempts multiplied
 * by the statically known fan-out (map item count or loop maxIterations).
 * Unknown fan-out (template-driven map items) conservatively counts as 1, so
 * the estimate is a lower bound on the true worst case.
 */
function worstCaseNodeAttempts(node: MatOSWorkflowNode): number {
  const retryAttempts =
    positiveInteger(
      isObject(node.policy?.retry) ? node.policy.retry.maxAttempts : undefined,
    ) ?? 1
  let fanOut = 1
  if (node.type === 'map' && Array.isArray(node.items)) {
    fanOut = Math.max(1, node.items.length)
  } else if (node.type === 'loop') {
    fanOut = positiveInteger(node.maxIterations) ?? 1
  }
  return retryAttempts * fanOut
}

/**
 * Compile-time budget pre-check. Emits warnings (never errors) when the
 * statically estimated worst-case attempt count already exceeds the declared
 * `policy.budget.maxNodeAttempts`, or a node-level budget cannot cover that
 * node's own retry policy. Runs are still allowed; the scheduler-side budget
 * gate remains the enforcement point.
 */
export function budgetEstimateWarnings(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowValidationWarning[] {
  const warnings: MatOSWorkflowValidationWarning[] = []
  const budget = definition.policy?.budget
  const maxNodeAttempts =
    isObject(budget) && typeof budget.maxNodeAttempts === 'number'
      ? budget.maxNodeAttempts
      : undefined

  if (maxNodeAttempts !== undefined) {
    const stateMachinePolicy = definition.policy?.stateMachine
    const worstCase = isStateMachineWorkflow(definition)
      ? (positiveInteger(
          isObject(stateMachinePolicy) ? stateMachinePolicy.maxFrames : undefined,
        ) ?? definition.nodes.length)
      : definition.nodes.reduce(
          (total, node) => total + worstCaseNodeAttempts(node),
          0,
        )
    if (worstCase > maxNodeAttempts) {
      warnings.push({
        code: 'budget_worst_case_attempts',
        message:
          `Estimated worst-case node attempts (${worstCase}) exceed ` +
          `policy.budget.maxNodeAttempts (${maxNodeAttempts}); the run may stop early`,
        path: 'policy.budget.maxNodeAttempts',
      })
    }
  }

  for (const node of definition.nodes) {
    const nodeBudget = node.budget
    if (!isObject(nodeBudget)) {
      continue
    }
    const nodeMaxAttempts =
      typeof nodeBudget.maxNodeAttempts === 'number'
        ? nodeBudget.maxNodeAttempts
        : undefined
    if (nodeMaxAttempts === undefined) {
      continue
    }
    const worstCase = worstCaseNodeAttempts(node)
    if (worstCase > nodeMaxAttempts) {
      warnings.push({
        code: 'node_budget_below_retry',
        message:
          `Node "${node.id}" worst-case attempts (${worstCase}) exceed its ` +
          `budget.maxNodeAttempts (${nodeMaxAttempts}); retries may be cut short`,
        nodeId: node.id,
        path: `nodes.${node.id}.budget.maxNodeAttempts`,
      })
    }
  }
  return warnings
}
