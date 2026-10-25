export type MatOSBenchmarkCostRisk =
  | 'free'
  | 'cheap'
  | 'standard'
  | 'expensive'
  | 'restricted'

export type MatOSBenchmarkApprovalPolicy =
  | 'bypass-safe'
  | 'requires-user'
  | 'trusted-command'
  | 'restricted'

export type MatOSBenchmarkKind =
  | 'static-json'
  | 'command'
  | 'matos-run'
  | 'workflow-run'
  | 'tool-call'
  | 'artifact-check'
  | 'algo-compare'

export type MatOSBenchmarkTask = {
  role?: string
  prompt?: string
  maxTurns?: number
  workflowRef?: string
  toolRef?: string
  input?: unknown
  /**
   * Algorithm Layer selection env for end-to-end comparison cases. Only
   * MATOS_ALGO_* keys are accepted so a benchmark case can pick strategy
   * providers per run but can never override credentials, models, or other
   * runtime env through a case file.
   */
  env?: Record<string, string>
}

export type MatOSBenchmarkCheck =
  | { type: 'stdout-contains'; value: string }
  | { type: 'stderr-contains'; value: string }
  | { type: 'tool-call'; toolRef: string; required: boolean }
  | { type: 'artifact-json-path'; path: string; equals: unknown }
  | { type: 'secret-scan'; allow: false }

export type NormalizedMatOSBenchmarkCase = {
  schemaVersion: 1 | 2
  id: string
  kind: MatOSBenchmarkKind
  subjectRefs: string[]
  checks: MatOSBenchmarkCheck[]
  costRisk: MatOSBenchmarkCostRisk
  approvalPolicy: MatOSBenchmarkApprovalPolicy
  timeoutMs: number
  task?: MatOSBenchmarkTask
  raw: Record<string, unknown>
}

const SUPPORTED_KINDS = new Set<MatOSBenchmarkKind>([
  'static-json',
  'command',
  'matos-run',
  'workflow-run',
  'tool-call',
  'artifact-check',
  'algo-compare',
])

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].sort()
    : []
}

function normalizeCostRisk(value: unknown, kind: MatOSBenchmarkKind): MatOSBenchmarkCostRisk {
  return value === 'free' ||
    value === 'cheap' ||
    value === 'standard' ||
    value === 'expensive' ||
    value === 'restricted'
    ? value
    : kind === 'static-json' || kind === 'algo-compare'
      ? 'free'
      : 'cheap'
}

function normalizeApprovalPolicy(value: unknown): MatOSBenchmarkApprovalPolicy {
  return value === 'requires-user' ||
    value === 'trusted-command' ||
    value === 'restricted'
    ? value
    : 'bypass-safe'
}

function normalizeCheck(raw: unknown): MatOSBenchmarkCheck | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  if (record.type === 'stdout-contains') {
    const value = stringValue(record.value)
    return value ? { type: 'stdout-contains', value } : undefined
  }
  if (record.type === 'stderr-contains') {
    const value = stringValue(record.value)
    return value ? { type: 'stderr-contains', value } : undefined
  }
  if (record.type === 'tool-call') {
    const toolRef = stringValue(record.toolRef)
    return toolRef
      ? { type: 'tool-call', toolRef, required: record.required !== false }
      : undefined
  }
  if (record.type === 'artifact-json-path') {
    const path = stringValue(record.path)
    return path
      ? { type: 'artifact-json-path', path, equals: record.equals }
      : undefined
  }
  if (record.type === 'secret-scan') {
    return record.allow === false ? { type: 'secret-scan', allow: false } : undefined
  }
  return undefined
}

function normalizeChecks(value: unknown): MatOSBenchmarkCheck[] {
  return Array.isArray(value)
    ? value
        .map(normalizeCheck)
        .filter((check): check is MatOSBenchmarkCheck => Boolean(check))
    : []
}

const TASK_ENV_KEY_PATTERN = /^MATOS_ALGO_[A-Z0-9_]+$/

function normalizeTaskEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (TASK_ENV_KEY_PATTERN.test(key) && typeof raw === 'string') {
      env[key] = raw
    }
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function normalizeTask(value: unknown): MatOSBenchmarkTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const taskEnv = normalizeTaskEnv(record.env)
  return {
    ...(stringValue(record.role) ? { role: stringValue(record.role) } : {}),
    ...(stringValue(record.prompt) ? { prompt: stringValue(record.prompt) } : {}),
    ...(numberValue(record.maxTurns)
      ? { maxTurns: numberValue(record.maxTurns) }
      : {}),
    ...(stringValue(record.workflowRef)
      ? { workflowRef: stringValue(record.workflowRef) }
      : {}),
    ...(stringValue(record.toolRef) ? { toolRef: stringValue(record.toolRef) } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(taskEnv ? { env: taskEnv } : {}),
  }
}

export function normalizeMatOSBenchmarkCase(
  input: unknown,
): NormalizedMatOSBenchmarkCase {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MatOS benchmark case must be an object')
  }
  const raw = input as Record<string, unknown>
  const id = stringValue(raw.id) ?? ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid MatOS benchmark case id: ${id || '<empty>'}`)
  }
  const kindValue = stringValue(raw.kind) ?? 'static-json'
  if (!SUPPORTED_KINDS.has(kindValue as MatOSBenchmarkKind)) {
    throw new Error(`Unsupported MatOS benchmark kind: ${kindValue}`)
  }
  const kind = kindValue as MatOSBenchmarkKind
  const schemaVersion = raw.schemaVersion === 2 ? 2 : 1
  const approvalPolicy =
    schemaVersion === 1 && kind === 'command'
      ? 'trusted-command'
      : normalizeApprovalPolicy(raw.approvalPolicy)
  if (schemaVersion === 2 && kind === 'command' && approvalPolicy !== 'trusted-command') {
    throw new Error('Command benchmark requires trusted approval policy')
  }
  return {
    schemaVersion,
    id,
    kind,
    subjectRefs: stringArray(raw.subjectRefs),
    checks: normalizeChecks(raw.checks),
    costRisk: normalizeCostRisk(raw.costRisk, kind),
    approvalPolicy,
    timeoutMs:
      typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0
        ? raw.timeoutMs
        : 60_000,
    ...(normalizeTask(raw.task) ? { task: normalizeTask(raw.task) } : {}),
    raw,
  }
}
