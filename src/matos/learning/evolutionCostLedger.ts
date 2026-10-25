import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import type { MatOSEvolutionUsage } from './evolutionRoleRunner.js'

export type MatOSEvolutionCostRecord = {
  source: 'role-run-cache' | 'direct-editor-run' | 'semantic-acceptance'
  stage: string
  createdAt?: string
  runId?: string
  cacheKey?: string
  upstreamSessionId?: string
  usage: MatOSEvolutionUsage
  totalTokens: number
  totalCostUsd?: number
  path: string
}

export type MatOSEvolutionCostSummary = {
  recordCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalCostUsd: number
}

export type MatOSEvolutionCostReport = {
  generatedAt: string
  matosDir: string
  totals: MatOSEvolutionCostSummary
  byStage: Record<string, MatOSEvolutionCostSummary>
  records: MatOSEvolutionCostRecord[]
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeUsage(value: unknown): MatOSEvolutionUsage | undefined {
  const raw = recordValue(value)
  if (!raw) {
    return undefined
  }
  const inputTokens = numberValue(raw.input_tokens)
  const outputTokens = numberValue(raw.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined
  }
  return {
    ...raw,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens:
      numberValue(raw.cache_creation_input_tokens) ?? 0,
    cache_read_input_tokens: numberValue(raw.cache_read_input_tokens) ?? 0,
  }
}

function usageTotal(usage: MatOSEvolutionUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

function emptySummary(): MatOSEvolutionCostSummary {
  return {
    recordCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
  }
}

function addToSummary(
  summary: MatOSEvolutionCostSummary,
  record: MatOSEvolutionCostRecord,
): void {
  summary.recordCount += 1
  summary.totalTokens += record.totalTokens
  summary.inputTokens += record.usage.input_tokens
  summary.outputTokens += record.usage.output_tokens
  summary.cacheCreationInputTokens += record.usage.cache_creation_input_tokens
  summary.cacheReadInputTokens += record.usage.cache_read_input_tokens
  summary.totalCostUsd = roundCost(
    summary.totalCostUsd + (record.totalCostUsd ?? 0),
  )
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

function roleCacheCostRecord(path: string, value: unknown): MatOSEvolutionCostRecord | undefined {
  const root = recordValue(value)
  const cache = recordValue(root?.cache)
  const result = recordValue(root?.result)
  const usage = normalizeUsage(result?.usage)
  if (!usage) {
    return undefined
  }
  return {
    source: 'role-run-cache',
    stage:
      typeof result?.roleReference === 'string'
        ? result.roleReference
        : typeof cache?.roleReference === 'string'
          ? cache.roleReference
          : 'role:unknown',
    ...(typeof root?.createdAt === 'string' ? { createdAt: root.createdAt } : {}),
    ...(typeof cache?.key === 'string' ? { cacheKey: cache.key } : {}),
    ...(typeof result?.upstreamSessionId === 'string'
      ? { upstreamSessionId: result.upstreamSessionId }
      : {}),
    usage,
    totalTokens: usageTotal(usage),
    ...(numberValue(result?.totalCostUsd) !== undefined
      ? { totalCostUsd: numberValue(result?.totalCostUsd) }
      : {}),
    path,
  }
}

function directEditorCostRecords(
  path: string,
  value: unknown,
): MatOSEvolutionCostRecord[] {
  const run = recordValue(value)
  const runId = typeof run?.runId === 'string' ? run.runId : undefined
  const createdAt = typeof run?.createdAt === 'string' ? run.createdAt : undefined
  const output: MatOSEvolutionCostRecord[] = []
  const editorUsage = normalizeUsage(run?.usage)
  if (editorUsage) {
    output.push({
      source: 'direct-editor-run',
      stage: 'direct-asset-editor',
      ...(createdAt ? { createdAt } : {}),
      ...(runId ? { runId } : {}),
      ...(typeof run?.upstreamSessionId === 'string'
        ? { upstreamSessionId: run.upstreamSessionId }
        : {}),
      usage: editorUsage,
      totalTokens: usageTotal(editorUsage),
      ...(numberValue(run?.totalCostUsd) !== undefined
        ? { totalCostUsd: numberValue(run?.totalCostUsd) }
        : {}),
      path,
    })
  }
  const semanticAcceptance = recordValue(run?.semanticAcceptance)
  const judgeCache = recordValue(semanticAcceptance?.cache)
  const judgeUsage = normalizeUsage(semanticAcceptance?.usage)
  // Cache-hit verdicts replay the original judge run's usage numbers; the
  // tokens were already charged by the run that produced the cache entry, so
  // counting them again would double-bill every replayed verdict.
  if (judgeUsage && judgeCache?.hit !== true) {
    output.push({
      source: 'semantic-acceptance',
      stage: 'semantic-acceptance-judge',
      ...(typeof semanticAcceptance?.createdAt === 'string'
        ? { createdAt: semanticAcceptance.createdAt }
        : createdAt
          ? { createdAt }
          : {}),
      ...(runId ? { runId } : {}),
      ...(typeof semanticAcceptance?.upstreamSessionId === 'string'
        ? { upstreamSessionId: semanticAcceptance.upstreamSessionId }
        : {}),
      usage: judgeUsage,
      totalTokens: usageTotal(judgeUsage),
      ...(numberValue(semanticAcceptance?.totalCostUsd) !== undefined
        ? { totalCostUsd: numberValue(semanticAcceptance?.totalCostUsd) }
        : {}),
      path,
    })
  }
  return output
}

export async function buildMatOSEvolutionCostReport(input: {
  cwd: string
}): Promise<MatOSEvolutionCostReport> {
  const matosDir = getMatOSDir(input.cwd)
  const records: MatOSEvolutionCostRecord[] = []

  for (const path of await listFiles(
    join(matosDir, 'evolution', 'role-run-cache'),
  )) {
    const record = roleCacheCostRecord(path, await readJson(path))
    if (record) {
      records.push(record)
    }
  }

  for (const dir of await listDirs(
    join(matosDir, 'evolution', 'direct-editor', 'runs'),
  )) {
    const path = join(dir, 'run.json')
    records.push(...directEditorCostRecords(path, await readJson(path)))
  }

  const totals = emptySummary()
  const byStage: Record<string, MatOSEvolutionCostSummary> = {}
  for (const record of records) {
    addToSummary(totals, record)
    byStage[record.stage] ??= emptySummary()
    addToSummary(byStage[record.stage]!, record)
  }

  return {
    generatedAt: new Date().toISOString(),
    matosDir,
    totals,
    byStage,
    records: records.sort((a, b) =>
      `${a.createdAt ?? ''}:${a.stage}:${a.path}`.localeCompare(
        `${b.createdAt ?? ''}:${b.stage}:${b.path}`,
      ),
    ),
  }
}
