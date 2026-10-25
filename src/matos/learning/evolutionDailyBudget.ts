import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMatOSDir } from '../project.js'
import type { MatOSSelfEvolutionTriggerKind } from './evolutionMonitor.js'

export const DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT = 12
const MAX_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT = 10_000

export type MatOSEvolutionDailyBudgetClaim = {
  allowed: boolean
  limit: number
  used: number
  reason: 'claimed' | 'unlimited' | 'manual' | 'exhausted' | 'storage-error'
}

/**
 * Returns the daily automatic hidden-run limit. `0` means ZERO runs (a spend
 * kill-switch must never mean "unlimited"); `off`/`unlimited`/`-1` disable
 * the cap explicitly; invalid values fall back to the default.
 */
export function resolveEvolutionDailyHiddenRunLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT?.trim()
  if (!raw) {
    return DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT
  }
  const lowered = raw.toLowerCase()
  if (lowered === 'off' || lowered === 'unlimited' || lowered === '-1') {
    return -1
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT
  }
  return Math.min(parsed, MAX_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT)
}

function safeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 180) || 'local'
  )
}

function budgetRoot(
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  const configured = env.MATOS_EVOLUTION_BUDGET_DIR?.trim()
  if (configured) {
    return configured
  }
  const sessionDir = env.MATOS_SESSION_DIR?.trim()
  return sessionDir
    ? join(sessionDir, 'evolution-budget')
    : join(getMatOSDir(cwd), 'evolution', 'budget')
}

function budgetOwner(env: Record<string, string | undefined>): string {
  return env.MATOS_SCOPE_ID?.trim() || env.MATOS_USER_ID?.trim() || 'local'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

const BUDGET_CLAIM_RETENTION_DAYS = 7
const BUDGET_CLAIM_PRUNE_MAX_DIRS = 40
const DAY_MS = 24 * 60 * 60 * 1000

// Day-claim directories were never pruned, so an active deployment grew one
// `<owner>/<YYYY-MM-DD>/` directory (plus up to `limit` claim files) per day
// forever. Nothing reads a day's claims after that UTC day ends; keep a short
// operator-debugging window and drop the rest. Only strictly date-named
// sibling directories older than the cutoff are touched, so today's claims
// and any foreign files are safe even with clock skew.
async function pruneExpiredBudgetDayDirs(input: {
  ownerDir: string
  now: Date
}): Promise<void> {
  try {
    const cutoffDay = new Date(
      input.now.getTime() - BUDGET_CLAIM_RETENTION_DAYS * DAY_MS,
    )
      .toISOString()
      .slice(0, 10)
    const names = await readdir(input.ownerDir)
    let removed = 0
    for (const name of names) {
      if (removed >= BUDGET_CLAIM_PRUNE_MAX_DIRS) {
        return
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoffDay) {
        continue
      }
      await rm(join(input.ownerDir, name), { recursive: true, force: true })
      removed += 1
    }
  } catch {
    // Retention is best-effort; claiming the budget slot is the real work.
  }
}

export async function claimMatOSEvolutionDailyBudget(input: {
  cwd: string
  sessionId: string
  triggerKey: string
  triggerKind: MatOSSelfEvolutionTriggerKind
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<MatOSEvolutionDailyBudgetClaim> {
  const env = input.env ?? process.env
  const limit = resolveEvolutionDailyHiddenRunLimit(env)
  if (input.triggerKind === 'manual-evolve') {
    return { allowed: true, limit, used: 0, reason: 'manual' }
  }
  if (limit < 0) {
    return { allowed: true, limit, used: 0, reason: 'unlimited' }
  }
  if (limit === 0) {
    // Operator kill-switch: zero means no automatic hidden runs at all.
    return { allowed: false, limit, used: 0, reason: 'exhausted' }
  }

  const now = input.now ?? new Date()
  const day = now.toISOString().slice(0, 10)
  const dir = join(budgetRoot(input.cwd, env), safeSegment(budgetOwner(env)), day)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    for (let slot = 1; slot <= limit; slot += 1) {
      const path = join(dir, `${String(slot).padStart(5, '0')}.claim`)
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(
            `${JSON.stringify({
              schemaVersion: 1,
              createdAt: now.toISOString(),
              sessionId: input.sessionId,
              triggerKey: input.triggerKey,
            })}\n`,
            'utf8',
          )
        } finally {
          await handle.close()
        }
        if (slot === 1) {
          // First automatic run of this owner's UTC day: piggyback the
          // bounded day-dir retention sweep exactly once per day instead of
          // paying a readdir on every claim.
          await pruneExpiredBudgetDayDirs({ ownerDir: dirname(dir), now })
        }
        return { allowed: true, limit, used: slot, reason: 'claimed' }
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          continue
        }
        return {
          allowed: false,
          limit,
          used: slot - 1,
          reason: 'storage-error',
        }
      }
    }
  } catch {
    return { allowed: false, limit, used: 0, reason: 'storage-error' }
  }
  return { allowed: false, limit, used: limit, reason: 'exhausted' }
}
