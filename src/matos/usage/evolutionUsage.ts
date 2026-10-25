import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  lstat,
  realpath,
} from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { getMatOSDir } from '../project.js'

type ObjectValue = Record<string, unknown>
const object = (v: unknown): ObjectValue =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectValue) : {}
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0

export function numericUsage(value: unknown): Record<string, number> {
  const v = object(value)
  return {
    input_tokens: count(v.input_tokens ?? v.inputTokens),
    output_tokens: count(v.output_tokens ?? v.outputTokens),
    cache_read_input_tokens: count(
      v.cache_read_input_tokens ?? v.cacheReadInputTokens,
    ),
    cache_creation_input_tokens: count(
      v.cache_creation_input_tokens ?? v.cacheCreationInputTokens,
    ),
  }
}

export type EvolutionUsageEntry = {
  id: string
  timestamp: string
  stage: string
  sessionId?: string
  model: string
  usage: Record<string, number>
  unavailable: boolean
  journal: boolean
}

/** Minimal durable accounting, independent of strategy/cache retention. No
 * prompt, result text, credentials, private asset refs, or raw env is stored. */
export async function recordEvolutionUsage(input: {
  cwd: string
  stage: string
  result: {
    cache?: { hit?: boolean }
    usage?: unknown
    modelUsage?: unknown
    upstreamSessionId?: string
  }
  env?: Record<string, string | undefined>
}): Promise<void> {
  if (input.result.cache?.hit) return
  const env = input.env ?? process.env
  const dir = join(
    env.MATOS_SESSION_DIR || join(getMatOSDir(input.cwd), 'sessions'),
    'usage',
    'evolution',
  )
  const id = randomUUID()
  const rows = usageRows(input.result)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id,
      timestamp: new Date().toISOString(),
      stage: normalizeStage(input.stage),
      sessionId: input.result.upstreamSessionId,
      rows,
      costStatus: 'unverified-estimate',
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
}

const normalizeStage = (stage: string) =>
  stage.replace(/^role:/, '').replace(/@[^@]+$/, '')

/** Accounting failure must not erase a successful run, but must be diagnosable. */
export async function accountEvolutionResult<
  T extends {
    cache?: { hit?: boolean }
    usage?: unknown
    modelUsage?: unknown
    upstreamSessionId?: string
    stderr: string
  },
>(
  cwd: string,
  stage: string,
  result: T,
  env?: Record<string, string | undefined>,
): Promise<T> {
  try {
    await recordEvolutionUsage({ cwd, stage, result, env })
  } catch {
    result.stderr +=
      '\nMATOS_USAGE_RECORD_FAILED: numeric usage could not be persisted'
  }
  return result
}

/** SDK modelUsage and cost are process cumulative; usage itself is local to one agent turn. */
export function incrementalEvolutionResult<
  T extends {
    modelUsage?: Record<string, Record<string, unknown>>
    totalCostUsd?: number
  },
>(
  result: T,
  previous: {
    modelUsage?: Record<string, Record<string, unknown>>
    totalCostUsd?: number
  },
): T {
  const delta: Record<string, Record<string, unknown>> = {}
  for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
    const old = previous.modelUsage?.[model] ?? {}
    delta[model] = { ...usage }
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'costUSD',
    ]) {
      if (typeof usage[key] === 'number')
        delta[model]![key] = Math.max(
          0,
          (usage[key] as number) -
            (typeof old[key] === 'number' ? (old[key] as number) : 0),
        )
    }
  }
  return {
    ...result,
    ...(result.modelUsage ? { modelUsage: delta } : {}),
    ...(result.totalCostUsd !== undefined
      ? {
          totalCostUsd: Math.max(
            0,
            result.totalCostUsd - (previous.totalCostUsd ?? 0),
          ),
        }
      : {}),
  }
}

function usageRows(
  r: ObjectValue | { usage?: unknown; modelUsage?: unknown },
): Array<{
  model: string
  usage: Record<string, number>
  unavailable: boolean
}> {
  const models = Object.entries(object(r.modelUsage))
  // SDK aggregate usage is per-turn; modelUsage can be session-cumulative.
  // Prefer the former. Only use modelUsage as a fallback for legacy records.
  const u = numericUsage(r.usage)
  const raw = object(r.usage)
  const reported = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ].some(
    (k) =>
      typeof raw[k] === 'number' &&
      Number.isSafeInteger(raw[k]) &&
      Number(raw[k]) >= 0,
  )
  if (Object.values(u).some(Boolean) || reported)
    return [
      {
        model: models.length === 1 ? models[0]![0] : 'unknown',
        usage: u,
        unavailable: false,
      },
    ]
  const rows = models
    .map(([model, usage]) => ({
      model,
      usage: numericUsage(usage),
      unavailable: false,
    }))
    .filter((row) => Object.values(row.usage).some(Boolean))
  return rows.length
    ? rows
    : [{ model: 'unknown', usage: u, unavailable: true }]
}

async function entries(dir: string, boundary: string) {
  try {
    if (!(await lstat(dir)).isDirectory()) return []
    const rel = relative(await realpath(boundary), await realpath(dir))
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return []
    return await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** Known native stores only, never source-cache, backups or arbitrary symlinks. */
export async function listEvolutionUsageFiles(
  workspace: string,
  sessions: string,
): Promise<string[]> {
  const files: string[] = []
  const journal = join(sessions, 'usage/evolution')
  for (const e of await entries(journal, sessions))
    if (e.isFile() && e.name.endsWith('.json'))
      files.push(join(journal, e.name))
  const roots = [workspace]
  for (const e of await entries(join(workspace, 'projects'), workspace))
    if (e.isDirectory()) roots.push(join(workspace, 'projects', e.name))
  for (const root of roots) {
    const dir = join(root, '.matos/evolution')
    for (const e of await entries(join(dir, 'role-run-cache'), root))
      if (e.isFile() && e.name.endsWith('.json'))
        files.push(join(dir, 'role-run-cache', e.name))
    for (const e of await entries(join(dir, 'direct-editor/runs'), root))
      if (e.isDirectory())
        files.push(join(dir, 'direct-editor/runs', e.name, 'run.json'))
  }
  return files
}

export function parseEvolutionUsageFile(
  file: string,
  raw: string,
): EvolutionUsageEntry[] {
  const r = object(JSON.parse(raw))
  if (
    r.schemaVersion === 1 &&
    Array.isArray(r.rows) &&
    typeof r.id === 'string'
  ) {
    return r.rows.map((row, i) => {
      const v = object(row)
      return {
        id: `${r.id}:${i}`,
        timestamp: String(r.timestamp),
        stage: String(r.stage),
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
        model: String(v.model ?? 'unknown'),
        usage: numericUsage(v.usage),
        unavailable: v.unavailable === true,
        journal: true,
      }
    })
  }
  const out: EvolutionUsageEntry[] = []
  function add(value: unknown, stage: string, time: unknown, id: string, knownInvocation = false) {
    const v = object(value)
    if (!value || object(v.cache).hit === true) return
    // Rejected/blocked editor plans with no invocation are not missing LLM usage.
    if (!knownInvocation && !v.upstreamSessionId && v.usage === undefined && v.modelUsage === undefined && v.totalCostUsd === undefined) return
    for (const [i, row] of usageRows(v).entries())
      out.push({
        ...row,
        id: `${id}:${i}`,
        timestamp: String(time),
        stage: normalizeStage(stage),
        sessionId:
          typeof v.upstreamSessionId === 'string'
            ? v.upstreamSessionId
            : undefined,
        journal: false,
      })
  }
  if (file.includes('/role-run-cache/')) {
    const result = object(r.result)
    add(
      result,
      String(result.roleReference ?? 'unknown').replace(/^role:/, ''),
      r.createdAt,
      String(object(r.cache).key ?? file),
      true,
    )
  } else {
    add(r, 'direct-asset-editor', r.createdAt, String(r.runId ?? file))
    const judge = object(r.semanticAcceptance)
    if (r.semanticAcceptance)
      add(
        judge,
        'semantic-acceptance-judge',
        judge.createdAt ?? r.createdAt,
        `${r.runId ?? file}:judge`,
      )
  }
  return out
}

export async function readEvolutionUsageEntries(
  file: string,
): Promise<EvolutionUsageEntry[]> {
  return parseEvolutionUsageFile(file, await readFile(file, 'utf8'))
}
