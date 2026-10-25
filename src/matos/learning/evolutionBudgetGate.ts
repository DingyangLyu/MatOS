import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MatOSSelfEvolutionTrigger } from './evolutionMonitor.js'
import {
  appendMonitorRecord,
  type MatOSSelfEvolutionMonitorRecord,
  type MatOSSelfEvolutionMonitorStatus,
} from './evolutionMonitorRecords.js'
import {
  matOSEvolutionOpsLedgerDir,
  readMatOSEvolutionOpsLedgerFile,
  updateMatOSEvolutionOpsLedgerFile,
} from './evolutionOpsLedger.js'

// Global evolution budget gate.
//
// Hidden self-evolution LLM stages need a spend limit, since much of their
// cost can go to runs that produce no accepted change. This
// module keeps a small per-cwd daily spend ledger fed from the costs that flow
// through monitor pipeline results (critic llmDiagnostics, direct-editor run
// usage, semantic-acceptance judge usage) and gates the hidden pipeline before
// any LLM stage runs once today's accumulated spend reaches
// MATOS_EVOLUTION_DAILY_BUDGET_USD (default 25 USD; '0'/'off'/'unlimited'
// disables the gate). Manual `/evolve` triggers are never blocked; they pass
// with a warning record instead.

// Like 'skipped-repeated-failure', this status is intentionally NOT added to
// the shared MatOSSelfEvolutionMonitorStatus union so the exhaustive UI maps
// in evolutionMonitorLiveNotification.ts (another workstream's file) keep
// typechecking. Records with this status are never surfaced there, and every
// other reader treats statuses as opaque strings.
export const MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS =
  'skipped-budget-exhausted' as unknown as MatOSSelfEvolutionMonitorStatus

export const MATOS_EVOLUTION_DAILY_BUDGET_DEFAULT_USD = 25

const SPEND_LEDGER_MAX_DAYS = 35

export type MatOSEvolutionSpendItem = {
  id?: string
  stage: string
  costUsd: number
  tokens: number
}

export type MatOSEvolutionSpendLedgerStage = {
  costUsd: number
  tokens: number
  records: number
}

export type MatOSEvolutionSpendLedgerDay = {
  accounted?: Record<string, { costUsd: number; tokens: number }>
  totalCostUsd: number
  totalTokens: number
  recordCount: number
  byStage: Record<string, MatOSEvolutionSpendLedgerStage>
  updatedAt: string
}

export type MatOSEvolutionSpendLedger = {
  schemaVersion: 1
  updatedAt: string
  // Keyed by UTC date (YYYY-MM-DD), bounded to the newest SPEND_LEDGER_MAX_DAYS.
  days: Record<string, MatOSEvolutionSpendLedgerDay>
}

export function matOSEvolutionSpendLedgerPath(cwd: string): string {
  return join(matOSEvolutionOpsLedgerDir(cwd), 'spend-ledger.json')
}

export function matOSEvolutionSpendLedgerDateKey(
  now: Date = new Date(),
): string {
  return now.toISOString().slice(0, 10)
}

function envValue(
  env: Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  const raw = env?.[key] ?? process.env[key]
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

export type MatOSEvolutionDailyBudget = {
  disabled: boolean
  budgetUsd: number
}

// unset => default 25 USD; explicit '0'/'off'/'unlimited' (and other
// disable-words or non-positive numbers) => gate disabled entirely; a positive
// number => that budget; unparseable garbage => default.
export function resolveMatOSEvolutionDailyBudgetUsd(
  env?: Record<string, string | undefined>,
): MatOSEvolutionDailyBudget {
  const raw = envValue(env, 'MATOS_EVOLUTION_DAILY_BUDGET_USD')
  if (raw === undefined) {
    return {
      disabled: false,
      budgetUsd: MATOS_EVOLUTION_DAILY_BUDGET_DEFAULT_USD,
    }
  }
  if (
    ['off', 'unlimited', 'disabled', 'none', 'false'].includes(
      raw.toLowerCase(),
    )
  ) {
    return { disabled: true, budgetUsd: Number.POSITIVE_INFINITY }
  }
  const parsed = Number(raw)
  if (Number.isFinite(parsed)) {
    return parsed > 0
      ? { disabled: false, budgetUsd: parsed }
      : { disabled: true, budgetUsd: Number.POSITIVE_INFINITY }
  }
  return {
    disabled: false,
    budgetUsd: MATOS_EVOLUTION_DAILY_BUDGET_DEFAULT_USD,
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function usageTokens(value: unknown): number {
  const usage = recordValue(value)
  if (!usage) {
    return 0
  }
  return (
    (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.output_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0)
  )
}

function cacheHit(value: unknown): boolean {
  return recordValue(value)?.hit === true
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

// Extract the hidden-LLM spend a monitor record carries. Cache-hit stages are
// excluded because their usage replays the run that originally paid for the
// tokens (same rule as evolutionCostLedger).
export function matOSEvolutionSpendItemsFromMonitorRecord(
  record: MatOSSelfEvolutionMonitorRecord,
): MatOSEvolutionSpendItem[] {
  const items: MatOSEvolutionSpendItem[] = []
  for (const [index, diagnostic] of (record.llmDiagnostics ?? []).entries()) {
    if (diagnostic.cache?.hit === true) {
      continue
    }
    const costUsd = numberValue(diagnostic.totalCostUsd) ?? 0
    const tokens = usageTokens(diagnostic.usage)
    if (costUsd > 0 || tokens > 0) {
      items.push({
        stage: diagnostic.stage ?? 'user-feedback-critic',
        id: `${diagnostic.stage ?? 'user-feedback-critic'}:${diagnostic.upstreamSessionId ?? `${record.recordId}:${index}`}`,
        costUsd,
        tokens,
      })
    }
  }
  const run = record.directEditorRun
  if (run) {
    const editorCostUsd = numberValue(run.totalCostUsd) ?? 0
    const editorTokens = usageTokens(run.usage)
    if (editorCostUsd > 0 || editorTokens > 0) {
      items.push({
        stage: 'direct-asset-editor',
        id: `direct-asset-editor:${run.upstreamSessionId ?? run.runId}`,
        costUsd: editorCostUsd,
        tokens: editorTokens,
      })
    }
    const judge = recordValue(run.semanticAcceptance)
    if (judge && !cacheHit(judge.cache)) {
      const judgeCostUsd = numberValue(judge.totalCostUsd) ?? 0
      const judgeTokens = usageTokens(judge.usage)
      if (judgeCostUsd > 0 || judgeTokens > 0) {
        items.push({
          stage: 'semantic-acceptance-judge',
          id: `semantic-acceptance-judge:${judge.upstreamSessionId ?? run.runId}`,
          costUsd: judgeCostUsd,
          tokens: judgeTokens,
        })
      }
    }
  }
  // Monitor updates often carry earlier stage diagnostics again. Identity is
  // the paid upstream session/stage, not the append/update timestamp.
  return items
}

function emptySpendDay(nowIso: string): MatOSEvolutionSpendLedgerDay {
  return {
    totalCostUsd: 0,
    totalTokens: 0,
    recordCount: 0,
    byStage: {},
    updatedAt: nowIso,
  }
}

function normalizeSpendLedger(
  current: MatOSEvolutionSpendLedger | undefined,
  nowIso: string,
): MatOSEvolutionSpendLedger {
  if (current && typeof current === 'object' && current.days) {
    return { schemaVersion: 1, updatedAt: nowIso, days: { ...current.days } }
  }
  return { schemaVersion: 1, updatedAt: nowIso, days: {} }
}

function pruneSpendLedgerDays(ledger: MatOSEvolutionSpendLedger): void {
  const keys = Object.keys(ledger.days).sort()
  for (const key of keys.slice(
    0,
    Math.max(0, keys.length - SPEND_LEDGER_MAX_DAYS),
  )) {
    delete ledger.days[key]
  }
}

export async function accumulateMatOSEvolutionSpendItems(input: {
  cwd: string
  items: MatOSEvolutionSpendItem[]
  now?: Date
}): Promise<void> {
  const items = input.items.filter(
    (item) => item.costUsd > 0 || item.tokens > 0,
  )
  if (items.length === 0) {
    return
  }
  try {
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()
    const dateKey = matOSEvolutionSpendLedgerDateKey(now)
    await updateMatOSEvolutionOpsLedgerFile<MatOSEvolutionSpendLedger>(
      matOSEvolutionSpendLedgerPath(input.cwd),
      (current) => {
        const ledger = normalizeSpendLedger(current, nowIso)
        const day = ledger.days[dateKey]
          ? {
              ...ledger.days[dateKey]!,
              byStage: { ...ledger.days[dateKey]!.byStage },
              accounted: { ...ledger.days[dateKey]!.accounted },
            }
          : emptySpendDay(nowIso)
        for (const item of items) {
          const prior = item.id
            ? Object.values(ledger.days)
                .map((d) => d.accounted?.[item.id!])
                .filter((v): v is { costUsd: number; tokens: number } => !!v)
                .reduce<{ costUsd: number; tokens: number } | undefined>(
                  (max, v) => ({
                    costUsd: Math.max(max?.costUsd ?? 0, v.costUsd),
                    tokens: Math.max(max?.tokens ?? 0, v.tokens),
                  }),
                  undefined,
                )
            : undefined
          const current = item.id
            ? (day.accounted?.[item.id] ?? prior)
            : undefined
          const costDelta = Math.max(0, item.costUsd - (current?.costUsd ?? 0))
          const tokenDelta = Math.max(0, item.tokens - (current?.tokens ?? 0))
          if (!costDelta && !tokenDelta) continue
          const recordDelta = current ? 0 : 1
          if (item.id)
            (day.accounted ??= {})[item.id] = {
              costUsd: Math.max(item.costUsd, current?.costUsd ?? 0),
              tokens: Math.max(item.tokens, current?.tokens ?? 0),
            }
          day.totalCostUsd = roundCost(day.totalCostUsd + costDelta)
          day.totalTokens += tokenDelta
          day.recordCount += recordDelta
          const stage = day.byStage[item.stage] ?? {
            costUsd: 0,
            tokens: 0,
            records: 0,
          }
          day.byStage[item.stage] = {
            costUsd: roundCost(stage.costUsd + costDelta),
            tokens: stage.tokens + tokenDelta,
            records: stage.records + recordDelta,
          }
        }
        day.updatedAt = nowIso
        ledger.days[dateKey] = day
        pruneSpendLedgerDays(ledger)
        return ledger
      },
    )
  } catch {
    // Spend accounting must never break the pipeline or the append path.
  }
}

/** Execution-layer accounting also covers classifiers, prefix warm-up and
 * failed attempts that never make it into a completed monitor record. */
export async function accountEvolutionRoleSpend(
  cwd: string,
  stage: string,
  result: {
    cache?: { hit?: boolean }
    upstreamSessionId?: string
    totalCostUsd?: number
    usage?: unknown
  },
): Promise<void> {
  if (result.cache?.hit) return
  const normalized = stage.replace(/^role:/, '').replace(/@[^@]+$/, '')
  await accumulateMatOSEvolutionSpendItems({
    cwd,
    items: [
      {
        stage: normalized,
        id: `${normalized}:${result.upstreamSessionId ?? randomUUID()}`,
        costUsd: Math.max(0, numberValue(result.totalCostUsd) ?? 0),
        tokens: usageTokens(result.usage),
      },
    ],
  })
}

export async function accumulateMatOSEvolutionSpendFromMonitorRecord(input: {
  cwd: string
  record: MatOSSelfEvolutionMonitorRecord
  now?: Date
}): Promise<void> {
  await accumulateMatOSEvolutionSpendItems({
    cwd: input.cwd,
    items: matOSEvolutionSpendItemsFromMonitorRecord(input.record),
    ...(input.now ? { now: input.now } : {}),
  })
}

export async function readMatOSEvolutionDailySpend(input: {
  cwd: string
  now?: Date
}): Promise<{
  dateKey: string
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}> {
  const dateKey = matOSEvolutionSpendLedgerDateKey(input.now ?? new Date())
  const ledger =
    await readMatOSEvolutionOpsLedgerFile<MatOSEvolutionSpendLedger>(
      matOSEvolutionSpendLedgerPath(input.cwd),
    )
  const day = ledger?.days?.[dateKey]
  return {
    dateKey,
    totalCostUsd: numberValue(day?.totalCostUsd) ?? 0,
    totalTokens: numberValue(day?.totalTokens) ?? 0,
    recordCount: numberValue(day?.recordCount) ?? 0,
  }
}

export type MatOSEvolutionBudgetGateStage = 'pipeline-entry' | 'direct-editor'

export type MatOSEvolutionBudgetGateResult = {
  blocked: boolean
  disabled?: boolean
  budgetUsd?: number
  spentUsd?: number
  skipRecord?: MatOSSelfEvolutionMonitorRecord
  warningRecord?: MatOSSelfEvolutionMonitorRecord
}

function formatUsd(value: number): string {
  return value.toFixed(2)
}

function budgetSkipRecord(input: {
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  stage: MatOSEvolutionBudgetGateStage
  spentUsd: number
  budgetUsd: number
  nowIso: string
}): MatOSSelfEvolutionMonitorRecord {
  const stageLabel =
    input.stage === 'pipeline-entry'
      ? 'hidden evolution pipeline'
      : 'direct asset editor stage'
  return {
    recordId: `monitor-${randomUUID()}`,
    sessionId: input.sessionId,
    triggerKind: input.trigger.kind,
    triggerKey: input.trigger.key,
    status: MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    summary:
      `Self-evolution skipped the ${stageLabel} because today's hidden LLM spend ` +
      `($${formatUsd(input.spentUsd)} of the $${formatUsd(input.budgetUsd)} USD daily budget) ` +
      `is exhausted; no LLM stages were run for this trigger. Adjust ` +
      `MATOS_EVOLUTION_DAILY_BUDGET_USD to raise the budget or set it to '0'/'off' to disable the gate.`,
    ...(input.trigger.eventId ? { eventId: input.trigger.eventId } : {}),
  }
}

function manualBudgetWarningRecord(input: {
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  spentUsd: number
  budgetUsd: number
  nowIso: string
}): MatOSSelfEvolutionMonitorRecord {
  return {
    recordId: `monitor-${randomUUID()}`,
    sessionId: input.sessionId,
    triggerKind: input.trigger.kind,
    triggerKey: input.trigger.key,
    status: 'detected',
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    summary:
      `Manual /evolve proceeded although today's hidden evolution spend ` +
      `($${formatUsd(input.spentUsd)} of $${formatUsd(input.budgetUsd)} USD) already reached the daily ` +
      `budget; operator-invoked triggers bypass the budget gate.`,
    budgetWarning: `daily-budget-exceeded: spent $${formatUsd(input.spentUsd)} of $${formatUsd(input.budgetUsd)} USD`,
    ...(input.trigger.eventId ? { eventId: input.trigger.eventId } : {}),
  }
}

// Budget gate for the hidden pipeline. Stage 'pipeline-entry' runs after the
// suppression checks and before the semantic turn classifier or the
// critic/shared-prefix stage; stage 'direct-editor' re-checks right before the
// expensive editor/judge stage because earlier stages (including concurrent
// sessions) may have exhausted the budget since pipeline entry. Blocking
// appends a `skipped-budget-exhausted` monitor record (at most one per trigger
// key per UTC day at pipeline entry); manual `manual-evolve` triggers are
// never blocked and instead surface a warning record at pipeline entry.
export async function gateMatOSEvolutionDailyBudget(input: {
  cwd: string
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  stage: MatOSEvolutionBudgetGateStage
  priorRecords?: MatOSSelfEvolutionMonitorRecord[]
  env?: Record<string, string | undefined>
  append?: (record: MatOSSelfEvolutionMonitorRecord) => Promise<void>
  now?: Date
}): Promise<MatOSEvolutionBudgetGateResult> {
  let spentUsd: number | undefined
  let budgetUsd: number | undefined
  try {
    const budget = resolveMatOSEvolutionDailyBudgetUsd(input.env)
    if (budget.disabled) {
      return { blocked: false, disabled: true }
    }
    budgetUsd = budget.budgetUsd
    const now = input.now ?? new Date()
    const spend = await readMatOSEvolutionDailySpend({ cwd: input.cwd, now })
    spentUsd = spend.totalCostUsd
    if (spend.totalCostUsd < budget.budgetUsd) {
      return { blocked: false, budgetUsd, spentUsd }
    }
    const nowIso = now.toISOString()
    const append =
      input.append ??
      (async (record: MatOSSelfEvolutionMonitorRecord) =>
        appendMonitorRecord(input.cwd, record))
    if (input.trigger.kind === 'manual-evolve') {
      if (input.stage !== 'pipeline-entry') {
        return { blocked: false, budgetUsd, spentUsd }
      }
      const warningRecord = manualBudgetWarningRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        spentUsd: spend.totalCostUsd,
        budgetUsd: budget.budgetUsd,
        nowIso,
      })
      await append(warningRecord).catch(() => undefined)
      return { blocked: false, budgetUsd, spentUsd, warningRecord }
    }
    // Keep record noise bounded: one budget-skip record per exact trigger key
    // per UTC day at pipeline entry (noisy families are additionally spaced by
    // the existing family cooldown scan, which counts these records).
    const dateKey = matOSEvolutionSpendLedgerDateKey(now)
    const alreadyRecordedToday = (input.priorRecords ?? []).some(
      (record) =>
        record.triggerKey === input.trigger.key &&
        record.status === MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS &&
        record.createdAt.slice(0, 10) === dateKey,
    )
    if (input.stage === 'pipeline-entry' && alreadyRecordedToday) {
      return { blocked: true, budgetUsd, spentUsd }
    }
    const skipRecord = budgetSkipRecord({
      sessionId: input.sessionId,
      trigger: input.trigger,
      stage: input.stage,
      spentUsd: spend.totalCostUsd,
      budgetUsd: budget.budgetUsd,
      nowIso,
    })
    await append(skipRecord).catch(() => undefined)
    return { blocked: true, budgetUsd, spentUsd, skipRecord }
  } catch {
    // Fail open: a broken ledger must not silence learning, and the gate must
    // never break the pipeline entry.
    return { blocked: false, budgetUsd, spentUsd }
  }
}
