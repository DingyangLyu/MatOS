import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import type { MatOSAsset } from '../assets/types.js'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
} from '../tools/matosToolRunner.js'
import { matOSWorkflowService } from '../workflows/workflowService.js'
import {
  normalizeMatOSBenchmarkCase,
  type MatOSBenchmarkCheck,
  type NormalizedMatOSBenchmarkCase,
} from './benchmarkSchema.js'
import { runEvolutionRole } from './evolutionRoleRunner.js'
import { getMatOSDir } from '../project.js'

export type MatOSBenchmarkCaseRunInput = {
  cwd: string
  benchmarkRef: string
  casePath: string
  timeoutMs?: number
}

export type MatOSBenchmarkCaseRunResult = {
  resultId: string
  resultPath: string
  benchmarkRef: string
  caseId: string
  kind: string
  status: 'succeeded' | 'failed' | 'blocked'
  ok: boolean
  exitCode?: number
  evidence: {
    stdoutPreview?: string
    stderrPreview?: string
    message?: string
  }
  createdAt: string
}

type CommandCase = {
  schemaVersion?: unknown
  id?: unknown
  kind?: unknown
  command?: unknown
  args?: unknown
  expect?: unknown
}

type WorkflowCase = CommandCase & {
  workflowRef?: unknown
  params?: unknown
}

type CommandRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const PREVIEW_LIMIT = 4000

function now(): string {
  return new Date().toISOString()
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16)
}

function resultIdFor(input: {
  benchmarkRef: string
  caseId: string
  kind: string
}): string {
  return `benchmark-result-${hash({ ...input, createdAt: now() })}`
}

function resultsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'benchmarks', 'results')
}

export async function listMatOSBenchmarkResults(
  cwd: string,
): Promise<MatOSBenchmarkCaseRunResult[]> {
  let entries: string[]
  try {
    entries = await readdir(resultsDir(cwd))
  } catch {
    return []
  }
  const results: MatOSBenchmarkCaseRunResult[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const path = join(resultsDir(cwd), entry)
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Omit<
        MatOSBenchmarkCaseRunResult,
        'resultPath'
      >
      results.push({ ...parsed, resultPath: path })
    } catch {
      continue
    }
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function refWithoutVersion(ref: string): string {
  return ref.replace(/@[^@]+$/, '')
}

function assetMatchesRef(asset: MatOSAsset, ref: string): boolean {
  return (
    asset.canonicalKey === ref ||
    refWithoutVersion(asset.canonicalKey) === refWithoutVersion(ref)
  )
}

function preview(value: string): string | undefined {
  return value ? value.slice(0, PREVIEW_LIMIT) : undefined
}

function redactedText(value: string): string {
  return value
    .replace(
      /((?:\\)?["']?)(authorization)\1\s*([:=])\s*((?:\\)?["']?)(bearer|basic)\s+([^\\"'\s`,}]+)\4/gi,
      (
        _match,
        keyQuote: string,
        key: string,
        separator: string,
        valueQuote: string,
        scheme: string,
      ) =>
        `${keyQuote}${key}${keyQuote}${separator} ${valueQuote}${scheme} [redacted]${valueQuote}`,
    )
    .replace(
      /((?:\\)?["']?)([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASS|API[-_]?KEY|AUTH|CREDENTIAL)[A-Z0-9_-]*)\1\s*([:=])\s*((?:\\?["'][^"']*\\?["'])|[^\s"'`,}\\]+)/gi,
      (_match, keyQuote: string, key: string, separator: string) =>
        `${keyQuote}${key}${keyQuote}${separator}[redacted]`,
    )
}

function redactedPreview(value: string): string | undefined {
  return preview(redactedText(value))
}

function expectedOutputMatches(
  outputs: Record<string, unknown>,
  expectation: unknown,
): boolean {
  const expectedOutputs = objectValue(objectValue(expectation).outputs)
  return Object.entries(expectedOutputs).every(
    ([key, expected]) => outputs[key] === expected,
  )
}

function jsonPathParts(path: string): Array<string | number> {
  const trimmed = path.trim()
  const withoutRoot = trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed
  if (!withoutRoot || withoutRoot === '$') {
    return []
  }
  return withoutRoot.split('.').flatMap(segment => {
    const parts: Array<string | number> = []
    const name = segment.replace(/\[[0-9]+\]/g, '')
    if (name) {
      parts.push(name)
    }
    const indices = segment.matchAll(/\[([0-9]+)\]/g)
    for (const match of indices) {
      parts.push(Number(match[1]))
    }
    return parts
  })
}

function jsonPathValue(value: unknown, path: string): unknown {
  let current = value
  for (const part of jsonPathParts(path)) {
    if (typeof part === 'number') {
      current = Array.isArray(current) ? current[part] : undefined
    } else {
      current = objectValue(current)[part]
    }
    if (current === undefined) {
      return undefined
    }
  }
  return current
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function writeResult(
  cwd: string,
  result: Omit<MatOSBenchmarkCaseRunResult, 'resultPath'>,
): Promise<MatOSBenchmarkCaseRunResult> {
  const path = join(resultsDir(cwd), `${result.resultId}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return { ...result, resultPath: path }
}

function expectStringContains(
  value: string,
  expected: unknown,
): boolean {
  if (typeof expected === 'string') {
    return value.includes(expected)
  }
  if (Array.isArray(expected)) {
    return expected.every(item => typeof item === 'string' && value.includes(item))
  }
  return true
}

function expectedExitCode(expectation: unknown): number | undefined {
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
    return undefined
  }
  const exitCode = (expectation as { exitCode?: unknown }).exitCode
  return typeof exitCode === 'number' && Number.isInteger(exitCode)
    ? exitCode
    : undefined
}

function expectedField(
  expectation: unknown,
  field: 'stdoutContains' | 'stderrContains',
): unknown {
  return expectation && typeof expectation === 'object' && !Array.isArray(expectation)
    ? (expectation as Record<string, unknown>)[field]
    : undefined
}

function realBenchmarkBlockedMessage(kind: string): string | undefined {
  if (process.env.MATOS_RUN_REAL_BENCHMARKS !== '1') {
    return `${kind} benchmark execution requires MATOS_RUN_REAL_BENCHMARKS=1.`
  }
  return undefined
}

function expensiveBenchmarkBlockedMessage(
  caseData: NormalizedMatOSBenchmarkCase,
): string | undefined {
  return (caseData.costRisk === 'expensive' ||
    caseData.costRisk === 'restricted') &&
    process.env.MATOS_RUN_EXPENSIVE_BENCHMARKS !== '1'
    ? 'expensive or restricted benchmark execution requires MATOS_RUN_EXPENSIVE_BENCHMARKS=1.'
    : undefined
}

function benchmarkCheckFailures(input: {
  checks: MatOSBenchmarkCheck[]
  stdout: string
  stderr: string
  artifact?: unknown
  toolRef?: string
}): string[] {
  const failures: string[] = []
  for (const check of input.checks) {
    if (check.type === 'stdout-contains' && !input.stdout.includes(check.value)) {
      failures.push(`stdout missing ${check.value}`)
    }
    if (check.type === 'stderr-contains' && !input.stderr.includes(check.value)) {
      failures.push(`stderr missing ${check.value}`)
    }
    if (check.type === 'secret-scan') {
      const hasSecret = /(token|secret|password|api[-_]?key|auth|authorization|credential)\s*[:=]/i.test(
        `${input.stdout}\n${input.stderr}`,
      )
      if (hasSecret) {
        failures.push('secret scan failed')
      }
    }
    if (check.type === 'artifact-json-path') {
      const value = jsonPathValue(input.artifact, check.path)
      if (!jsonEquals(value, check.equals)) {
        failures.push(`artifact ${check.path} did not equal expected value`)
      }
    }
    if (check.type === 'tool-call' && check.required && !input.toolRef) {
      failures.push(`tool call ${check.toolRef} was not observed`)
    }
    if (
      check.type === 'tool-call' &&
      check.required &&
      input.toolRef &&
      input.toolRef !== check.toolRef &&
      refWithoutVersion(input.toolRef) !== refWithoutVersion(check.toolRef)
    ) {
      failures.push(`tool call ${check.toolRef} was not observed`)
    }
  }
  return failures
}

const DEFAULT_BENCHMARK_KILL_GRACE_MS = 5_000

function benchmarkKillGraceMs(): number {
  const parsed = Number(process.env.MATOS_BENCHMARK_KILL_GRACE_MS)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_BENCHMARK_KILL_GRACE_MS
}

function runCommand(input: {
  cwd: string
  command: string
  args: string[]
  timeoutMs: number
}): Promise<CommandRunResult> {
  return new Promise(resolve => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      // Own process group so the timeout kill reaches the whole command
      // subtree (mirrors matosToolRunner): signalling only the direct child
      // left grandchildren running and leaked SIGTERM-ignoring commands
      // forever.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined
    const killProcessTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal)
          return
        }
      } catch {
        // Fall through to the direct-child kill below.
      }
      try {
        child.kill(signal)
      } catch {
        // The command may have exited between checks.
      }
    }
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      killProcessTree('SIGTERM')
      killEscalationTimer = setTimeout(() => {
        killProcessTree('SIGKILL')
      }, benchmarkKillGraceMs())
      killEscalationTimer.unref?.()
      resolve({ exitCode: 124, stdout, stderr, timedOut: true })
    }, input.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', code => {
      // Note: the escalation timer is deliberately NOT cleared here. The
      // leader closing does not mean the group is clean — TERM-ignoring
      // grandchildren still need the delayed group SIGKILL (it is unref'd and
      // a dead group id makes it a swallowed no-op).
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false })
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ exitCode: 1, stdout, stderr: stderr || error.message, timedOut: false })
    })
  })
}

async function runCommandBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseId: string
  kind: string
  parsed: CommandCase
  timeoutMs: number
}): Promise<Omit<MatOSBenchmarkCaseRunResult, 'resultPath'>> {
  const command = stringValue(input.parsed.command)
  if (!command) {
    return {
      resultId: resultIdFor(input),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseId,
      kind: input.kind,
      status: 'blocked',
      ok: false,
      evidence: { message: 'Command benchmark requires command.' },
      createdAt: now(),
    }
  }
  const result = await runCommand({
    cwd: input.cwd,
    command,
    args: stringArray(input.parsed.args),
    timeoutMs: input.timeoutMs,
  })
  const expectedCode = expectedExitCode(input.parsed.expect)
  const codeOk = expectedCode === undefined || result.exitCode === expectedCode
  const stdoutOk = expectStringContains(
    result.stdout,
    expectedField(input.parsed.expect, 'stdoutContains'),
  )
  const stderrOk = expectStringContains(
    result.stderr,
    expectedField(input.parsed.expect, 'stderrContains'),
  )
  const ok = !result.timedOut && codeOk && stdoutOk && stderrOk
  return {
    resultId: resultIdFor(input),
    benchmarkRef: input.benchmarkRef,
    caseId: input.caseId,
    kind: input.kind,
    status: ok ? 'succeeded' : 'failed',
    ok,
    exitCode: result.exitCode,
    evidence: {
      ...(preview(result.stdout) ? { stdoutPreview: preview(result.stdout) } : {}),
      ...(preview(result.stderr) ? { stderrPreview: preview(result.stderr) } : {}),
      ...(result.timedOut ? { message: 'Benchmark command timed out.' } : {}),
    },
    createdAt: now(),
  }
}

async function runStaticJsonBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseId: string
  kind: string
  parsed: CommandCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const expected = input.parsed.expect
  const serialized = JSON.stringify(input.parsed)
  const contains =
    expected && typeof expected === 'object' && !Array.isArray(expected)
      ? (expected as Record<string, unknown>).contains
      : undefined
  const ok = expectStringContains(serialized, contains)
  return writeResult(input.cwd, {
    resultId: resultIdFor(input),
    benchmarkRef: input.benchmarkRef,
    caseId: input.caseId,
    kind: input.kind,
    status: ok ? 'succeeded' : 'failed',
    ok,
    evidence: {
      message: ok ? 'Static JSON expectation matched.' : 'Static JSON expectation failed.',
    },
    createdAt: now(),
  })
}

async function runWorkflowBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseId: string
  kind: string
  parsed: WorkflowCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const workflowRef = stringValue(input.parsed.workflowRef)
  if (!workflowRef) {
    return writeResult(input.cwd, {
      resultId: resultIdFor(input),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseId,
      kind: input.kind,
      status: 'blocked',
      ok: false,
      evidence: { message: 'matos-workflow benchmark requires workflowRef.' },
      createdAt: now(),
    })
  }
  try {
    const { run } = await matOSWorkflowService.run({
      cwd: input.cwd,
      ref: workflowRef,
      parameters: objectValue(input.parsed.params),
      recordSession: false,
    })
    const expectedStatus =
      stringValue(objectValue(input.parsed.expect).status) ?? 'completed'
    const outputs = objectValue(run.outputs)
    const ok =
      run.status === expectedStatus &&
      expectedOutputMatches(outputs, input.parsed.expect)
    return writeResult(input.cwd, {
      resultId: resultIdFor(input),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseId,
      kind: input.kind,
      status: ok ? 'succeeded' : 'failed',
      ok,
      evidence: {
        message: `workflow ${workflowRef} finished with ${run.status}`,
        stdoutPreview: redactedText(
          JSON.stringify({
            runId: run.runId,
            status: run.status,
            outputs,
          }),
        ).slice(0, PREVIEW_LIMIT),
      },
      createdAt: now(),
    })
  } catch (error) {
    return writeResult(input.cwd, {
      resultId: resultIdFor(input),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseId,
      kind: input.kind,
      status: 'failed',
      ok: false,
      evidence: {
        message: error instanceof Error ? error.message : String(error),
      },
      createdAt: now(),
    })
  }
}

async function runWorkflowRunBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseData: NormalizedMatOSBenchmarkCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const blocked =
    realBenchmarkBlockedMessage(input.caseData.kind) ??
    expensiveBenchmarkBlockedMessage(input.caseData)
  if (blocked) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: blocked,
    })
  }
  const workflowRef =
    input.caseData.task?.workflowRef ?? stringValue(input.caseData.raw.workflowRef)
  if (!workflowRef) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: 'workflow-run benchmark requires task.workflowRef.',
    })
  }
  try {
    const { run } = await matOSWorkflowService.run({
      cwd: input.cwd,
      ref: workflowRef,
      parameters: objectValue(input.caseData.task?.input),
      recordSession: false,
    })
    const artifact = {
      runId: run.runId,
      status: run.status,
      outputs: objectValue(run.outputs),
    }
    const stdout = JSON.stringify(artifact)
    const failures = benchmarkCheckFailures({
      checks: input.caseData.checks,
      stdout,
      stderr: '',
      artifact,
    })
    const ok = run.status === 'completed' && failures.length === 0
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: ok ? 'succeeded' : 'failed',
      ok,
      evidence: {
        stdoutPreview: redactedPreview(stdout),
        ...(ok ? {} : { message: failures.join('; ') || `workflow ${workflowRef} ended ${run.status}` }),
      },
      createdAt: now(),
    })
  } catch (error) {
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: 'failed',
      ok: false,
      evidence: {
        message: error instanceof Error ? error.message : String(error),
      },
      createdAt: now(),
    })
  }
}

async function runToolCallBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseData: NormalizedMatOSBenchmarkCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const blocked =
    realBenchmarkBlockedMessage(input.caseData.kind) ??
    expensiveBenchmarkBlockedMessage(input.caseData)
  if (blocked) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: blocked,
    })
  }
  const toolRef = input.caseData.task?.toolRef ?? stringValue(input.caseData.raw.toolRef)
  if (!toolRef) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: 'tool-call benchmark requires task.toolRef.',
    })
  }
  const assets = await loadMatOSAssets(input.cwd)
  const asset = assets.find(
    candidate => candidate.type === 'tool' && assetMatchesRef(candidate, toolRef),
  )
  if (!asset) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: `tool asset not found: ${toolRef}`,
    })
  }
  try {
    const tools = await loadMatOSToolDefinitions([asset.manifestDir])
    const tool = tools[0]
    if (!tool) {
      throw new Error(`No native tool definition loaded for ${toolRef}`)
    }
    const result = await callMatOSTool(tool, input.caseData.task?.input)
    let artifact: unknown
    try {
      artifact = JSON.parse(result.stdout)
    } catch {
      artifact = undefined
    }
    const failures = benchmarkCheckFailures({
      checks: input.caseData.checks,
      stdout: result.stdout,
      stderr: result.stderr,
      artifact,
      toolRef: asset.canonicalKey,
    })
    const ok = result.exitCode === 0 && failures.length === 0
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: ok ? 'succeeded' : 'failed',
      ok,
      exitCode: result.exitCode ?? undefined,
      evidence: {
        ...(redactedPreview(result.stdout)
          ? { stdoutPreview: redactedPreview(result.stdout) }
          : {}),
        ...(redactedPreview(result.stderr)
          ? { stderrPreview: redactedPreview(result.stderr) }
          : {}),
        ...(ok ? {} : { message: failures.join('; ') || 'tool-call benchmark failed' }),
      },
      createdAt: now(),
    })
  } catch (error) {
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: 'failed',
      ok: false,
      evidence: {
        message: error instanceof Error ? error.message : String(error),
      },
      createdAt: now(),
    })
  }
}

async function runArtifactCheckBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseData: NormalizedMatOSBenchmarkCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const sourcePath = stringValue(objectValue(input.caseData.task?.input).path)
  if (!sourcePath) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: 'artifact-check benchmark requires task.input.path.',
    })
  }
  const filePath = isAbsolute(sourcePath)
    ? sourcePath
    : resolve(input.cwd, sourcePath)
  try {
    const content = await readFile(filePath, 'utf8')
    let artifact: unknown
    try {
      artifact = JSON.parse(content)
    } catch {
      artifact = undefined
    }
    const failures = benchmarkCheckFailures({
      checks: input.caseData.checks,
      stdout: content,
      stderr: '',
      artifact,
    })
    const ok = failures.length === 0
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: ok ? 'succeeded' : 'failed',
      ok,
      evidence: {
        stdoutPreview: redactedPreview(content),
        ...(ok ? {} : { message: failures.join('; ') || 'artifact check failed' }),
      },
      createdAt: now(),
    })
  } catch (error) {
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: 'failed',
      ok: false,
      evidence: {
        message: error instanceof Error ? error.message : String(error),
      },
      createdAt: now(),
    })
  }
}

type AlgoCompareThresholds = {
  minAgreementWithBaseline?: number
  minTop1AgreementWithBaseline?: number
  minMeanRankedOverlapWithBaseline?: number
  minTop1ExpectedAccuracy?: number
  minMeanExpectedReciprocalRank?: number
  minMeanExpectedRecall?: number
  maxFallbackCount?: number
  maxMeanLatencyMs?: number
}

function algoCompareThresholds(value: unknown): AlgoCompareThresholds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const record = value as Record<string, unknown>
  const out: AlgoCompareThresholds = {}
  for (const key of [
    'minAgreementWithBaseline',
    'minTop1AgreementWithBaseline',
    'minMeanRankedOverlapWithBaseline',
    'minTop1ExpectedAccuracy',
    'minMeanExpectedReciprocalRank',
    'minMeanExpectedRecall',
    'maxFallbackCount',
    'maxMeanLatencyMs',
  ] as const) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw
    }
  }
  return out
}

/**
 * Runs an Algorithm Layer provider comparison as a benchmark case. The case
 * declares `algo: { dataset, providers, thresholds? }` where `dataset` is a
 * frozen replay dataset path resolved relative to the case file (bundleable
 * inside the benchmark asset) or the project cwd. Thresholds are asserted for
 * every non-baseline provider. Offline replays through built-in providers are
 * free; strategy tool assets (`asset:` providers) execute local processes and
 * therefore require MATOS_RUN_REAL_BENCHMARKS=1 like other executing kinds.
 */
async function runAlgoCompareBenchmark(input: {
  cwd: string
  benchmarkRef: string
  casePath: string
  caseData: NormalizedMatOSBenchmarkCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  const blocked = (message: string): Promise<MatOSBenchmarkCaseRunResult> =>
    blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message,
    })
  const algoRaw = input.caseData.raw.algo
  const algo =
    algoRaw && typeof algoRaw === 'object' && !Array.isArray(algoRaw)
      ? (algoRaw as Record<string, unknown>)
      : undefined
  const datasetRef = typeof algo?.dataset === 'string' ? algo.dataset.trim() : ''
  const providerIds = Array.isArray(algo?.providers)
    ? algo.providers.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : []
  if (!datasetRef || providerIds.length === 0) {
    return blocked('algo-compare benchmark requires algo.dataset and algo.providers.')
  }
  if (
    providerIds.some(providerId => providerId.startsWith('asset:')) &&
    process.env.MATOS_RUN_REAL_BENCHMARKS !== '1'
  ) {
    return blocked(
      'algo-compare with strategy tool asset providers requires MATOS_RUN_REAL_BENCHMARKS=1.',
    )
  }

  try {
    const [{ compareMatOSAlgorithmProviders }, { registerMatOSAssetExecProviders }] =
      await Promise.all([
        import('../algorithms/datasets.js'),
        import('../algorithms/assetExecProvider.js'),
      ])
    // Register strategy tool assets so asset: provider ids resolve.
    try {
      const { buildMatOSAssetRegistry } = await import('../assets/registry.js')
      registerMatOSAssetExecProviders(
        buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd)),
      )
    } catch {
      // Asset discovery failures surface later as unknown-provider errors.
    }
    const datasetPath = [
      resolve(dirname(input.casePath), datasetRef),
      resolve(input.cwd, datasetRef),
    ].find(candidate => existsSync(candidate))
    if (!datasetPath) {
      return blocked(`algo-compare dataset not found: ${datasetRef}`)
    }
    const { comparison, recordPath } = await compareMatOSAlgorithmProviders({
      cwd: input.cwd,
      datasetPath,
      providerIds,
    })
    const thresholds = algoCompareThresholds(algo?.thresholds)
    const failures: string[] = []
    for (const provider of comparison.providers) {
      if (provider.providerId === comparison.baselineProviderId) {
        continue
      }
      if (
        thresholds.minAgreementWithBaseline !== undefined &&
        provider.agreementWithBaseline < thresholds.minAgreementWithBaseline
      ) {
        failures.push(
          `${provider.providerId} agreement ${provider.agreementWithBaseline} < ${thresholds.minAgreementWithBaseline}`,
        )
      }
      if (
        thresholds.minTop1AgreementWithBaseline !== undefined &&
        (provider.top1AgreementWithBaseline ?? 0) <
          thresholds.minTop1AgreementWithBaseline
      ) {
        failures.push(
          `${provider.providerId} top1 ${provider.top1AgreementWithBaseline ?? 0} < ${thresholds.minTop1AgreementWithBaseline}`,
        )
      }
      if (
        thresholds.minMeanRankedOverlapWithBaseline !== undefined &&
        (provider.meanRankedOverlapWithBaseline ?? 0) <
          thresholds.minMeanRankedOverlapWithBaseline
      ) {
        failures.push(
          `${provider.providerId} overlap ${provider.meanRankedOverlapWithBaseline ?? 0} < ${thresholds.minMeanRankedOverlapWithBaseline}`,
        )
      }
      if (
        thresholds.minTop1ExpectedAccuracy !== undefined &&
        (provider.top1ExpectedAccuracy ?? 0) <
          thresholds.minTop1ExpectedAccuracy
      ) {
        failures.push(
          `${provider.providerId} expected top1 ${provider.top1ExpectedAccuracy ?? 0} < ${thresholds.minTop1ExpectedAccuracy}`,
        )
      }
      if (
        thresholds.minMeanExpectedReciprocalRank !== undefined &&
        (provider.meanExpectedReciprocalRank ?? 0) <
          thresholds.minMeanExpectedReciprocalRank
      ) {
        failures.push(
          `${provider.providerId} expected MRR ${provider.meanExpectedReciprocalRank ?? 0} < ${thresholds.minMeanExpectedReciprocalRank}`,
        )
      }
      if (
        thresholds.minMeanExpectedRecall !== undefined &&
        (provider.meanExpectedRecall ?? 0) <
          thresholds.minMeanExpectedRecall
      ) {
        failures.push(
          `${provider.providerId} expected recall ${provider.meanExpectedRecall ?? 0} < ${thresholds.minMeanExpectedRecall}`,
        )
      }
      if (
        thresholds.maxFallbackCount !== undefined &&
        provider.fallbackCount > thresholds.maxFallbackCount
      ) {
        failures.push(
          `${provider.providerId} fallbacks ${provider.fallbackCount} > ${thresholds.maxFallbackCount}`,
        )
      }
      if (
        thresholds.maxMeanLatencyMs !== undefined &&
        provider.meanLatencyMs > thresholds.maxMeanLatencyMs
      ) {
        failures.push(
          `${provider.providerId} latency ${provider.meanLatencyMs}ms > ${thresholds.maxMeanLatencyMs}ms`,
        )
      }
    }
    const ok = failures.length === 0
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: ok ? 'succeeded' : 'failed',
      ok,
      evidence: {
        message: ok
          ? `Compared ${comparison.providers.length} providers on ${comparison.dataset.caseCount} cases; evaluation record ${recordPath}`
          : failures.join('; '),
      },
      createdAt: now(),
    })
  } catch (error) {
    return writeResult(input.cwd, {
      resultId: resultIdFor({
        benchmarkRef: input.benchmarkRef,
        caseId: input.caseData.id,
        kind: input.caseData.kind,
      }),
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      status: 'failed',
      ok: false,
      evidence: {
        message: `algo-compare failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      createdAt: now(),
    })
  }
}

function blockedV2Benchmark(input: {
  cwd: string
  benchmarkRef: string
  caseId: string
  kind: string
  message: string
}): Promise<MatOSBenchmarkCaseRunResult> {
  return writeResult(input.cwd, {
    resultId: resultIdFor(input),
    benchmarkRef: input.benchmarkRef,
    caseId: input.caseId,
    kind: input.kind,
    status: 'blocked',
    ok: false,
    evidence: { message: input.message },
    createdAt: now(),
  })
}

function unsupportedV2Message(caseData: NormalizedMatOSBenchmarkCase): string {
  if (
    caseData.kind === 'matos-run' ||
    caseData.kind === 'workflow-run' ||
    caseData.kind === 'tool-call' ||
    caseData.kind === 'artifact-check'
  ) {
    return `${caseData.kind} benchmark execution requires MATOS_RUN_REAL_BENCHMARKS=1.`
  }
  return `Unsupported benchmark kind: ${caseData.kind}`
}

function stringIncludesCheck(
  output: { stdout: string; stderr: string },
  check: MatOSBenchmarkCheck,
): boolean {
  if (check.type === 'stdout-contains') {
    return output.stdout.includes(check.value)
  }
  if (check.type === 'stderr-contains') {
    return output.stderr.includes(check.value)
  }
  if (check.type === 'secret-scan') {
    return !/(token|secret|password|api[-_]?key|auth|authorization|credential)\s*[:=]/i.test(
      `${output.stdout}\n${output.stderr}`,
    )
  }
  return true
}

async function runMatOSRunBenchmark(input: {
  cwd: string
  benchmarkRef: string
  caseData: NormalizedMatOSBenchmarkCase
}): Promise<MatOSBenchmarkCaseRunResult> {
  if (process.env.MATOS_RUN_REAL_BENCHMARKS !== '1') {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: 'matos-run benchmark execution requires MATOS_RUN_REAL_BENCHMARKS=1.',
    })
  }
  if (
    (input.caseData.costRisk === 'expensive' ||
      input.caseData.costRisk === 'restricted') &&
    process.env.MATOS_RUN_EXPENSIVE_BENCHMARKS !== '1'
  ) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message:
        'expensive or restricted benchmark execution requires MATOS_RUN_EXPENSIVE_BENCHMARKS=1.',
    })
  }
  const role = input.caseData.task?.role
  const prompt = input.caseData.task?.prompt
  if (!role || !prompt) {
    return blockedV2Benchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
      message: 'matos-run benchmark requires task.role and task.prompt.',
    })
  }

  // Schema-normalized task env is restricted to MATOS_ALGO_* keys, so an
  // end-to-end case can select Algorithm Layer providers per run without
  // being able to override credentials or model env through a case file.
  // Role composition (where context-ranking/tool-selection decide) runs in
  // this parent process, so the selection env must be applied here for the
  // duration of the run and restored afterwards; traceEnv alone would only
  // reach the child process after composition already happened.
  const taskEnv = input.caseData.task?.env ?? {}
  const previousEnv = new Map<string, string | undefined>(
    Object.keys(taskEnv).map(key => [key, process.env[key]]),
  )
  for (const [key, value] of Object.entries(taskEnv)) {
    process.env[key] = value
  }
  let result: Awaited<ReturnType<typeof runEvolutionRole>>
  try {
    result = await runEvolutionRole({
      cwd: input.cwd,
      role,
      prompt,
      jobId: `benchmark-${input.caseData.id}`,
      maxTurns: input.caseData.task?.maxTurns,
      traceEnv: {
        MATOS_TRACE_ID: `benchmark-${input.caseData.id}`,
        ...taskEnv,
      },
      hidden: true,
    })
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
  const stdout = result.resultText ?? result.stdout
  const stderr = result.stderr
  const checksOk = input.caseData.checks.every(check =>
    stringIncludesCheck({ stdout, stderr }, check),
  )
  const ok = result.exitCode === 0 && checksOk
  return writeResult(input.cwd, {
    resultId: resultIdFor({
      benchmarkRef: input.benchmarkRef,
      caseId: input.caseData.id,
      kind: input.caseData.kind,
    }),
    benchmarkRef: input.benchmarkRef,
    caseId: input.caseData.id,
    kind: input.caseData.kind,
    status: ok ? 'succeeded' : 'failed',
    ok,
    exitCode: result.exitCode,
    evidence: {
      ...(redactedPreview(stdout) ? { stdoutPreview: redactedPreview(stdout) } : {}),
      ...(redactedPreview(stderr) ? { stderrPreview: redactedPreview(stderr) } : {}),
      ...(ok ? {} : { message: 'MatOS run benchmark checks failed.' }),
    },
    createdAt: now(),
  })
}

export async function runMatOSBenchmarkCase(
  input: MatOSBenchmarkCaseRunInput,
): Promise<MatOSBenchmarkCaseRunResult> {
  const parsed = JSON.parse(await readFile(input.casePath, 'utf8')) as CommandCase
  if (parsed.kind === 'matos-workflow') {
    const caseId = stringValue(parsed.id) ?? ''
    if (!/^[a-z0-9][a-z0-9-]*$/.test(caseId)) {
      throw new Error(`Invalid MatOS benchmark case id: ${caseId || '<empty>'}`)
    }
    return runWorkflowBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId,
      kind: 'matos-workflow',
      parsed,
    })
  }
  const caseData = normalizeMatOSBenchmarkCase(parsed)
  const caseId = caseData.id
  const kind = caseData.kind

  if (kind === 'command') {
    return writeResult(
      input.cwd,
      await runCommandBenchmark({
        cwd: input.cwd,
        benchmarkRef: input.benchmarkRef,
        caseId,
        kind,
        parsed: caseData.raw,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    )
  }
  if (kind === 'static-json') {
    return runStaticJsonBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseId,
      kind,
      parsed: caseData.raw,
    })
  }
  if (kind === 'matos-run') {
    return runMatOSRunBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseData,
    })
  }
  if (kind === 'workflow-run') {
    return runWorkflowRunBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseData,
    })
  }
  if (kind === 'tool-call') {
    return runToolCallBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseData,
    })
  }
  if (kind === 'artifact-check') {
    return runArtifactCheckBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      caseData,
    })
  }
  if (kind === 'algo-compare') {
    return runAlgoCompareBenchmark({
      cwd: input.cwd,
      benchmarkRef: input.benchmarkRef,
      casePath: input.casePath,
      caseData,
    })
  }

  return blockedV2Benchmark({
    cwd: input.cwd,
    benchmarkRef: input.benchmarkRef,
    caseId,
    kind,
    message: unsupportedV2Message(caseData),
  })
}
