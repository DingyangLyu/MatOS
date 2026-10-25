import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSSessionsDir } from '../project.js'
import type { MatOSEvent } from '../sessions/eventTypes.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import { readEvolutionEvidenceFile } from './evolutionEvidenceRead.js'

export type MatOSEvolutionExposureWindow = {
  projectedTurns: number
  completedTurns: number
  failedTurns: number
  toolCalls: number
  failedToolCalls: number
  reportedCostUsd: number
}
export type MatOSEvolutionExposure = {
  before: MatOSEvolutionExposureWindow
  after: MatOSEvolutionExposureWindow
  revisionConfirmedCompletedTurns: number
  unversionedProjectedTurns: number
}
const emptyWindow = (): MatOSEvolutionExposureWindow => ({
  projectedTurns: 0,
  completedTurns: 0,
  failedTurns: 0,
  toolCalls: 0,
  failedToolCalls: 0,
  reportedCostUsd: 0,
})
const alias = (ref: string) => ref.replace(/@[^@]+$/, '')

/** Bounded observations over existing native session JSONL, not a new telemetry store. */
export async function observeMatOSEvolutionExposure(input: {
  cwd: string
  runs: MatOSDirectAssetEditorRunRecord[]
  env: Record<string, string | undefined>
  now: Date
  sessionCap: number
}) {
  const byRun = new Map(
    input.runs.map((run) => [
      run.runId,
      {
        before: emptyWindow(),
        after: emptyWindow(),
        revisionConfirmedCompletedTurns: 0,
        unversionedProjectedTurns: 0,
      },
    ]),
  )
  const scan = {
    sessionsScanned: 0,
    sessionsSkippedByCap: 0,
    unreadable: 0,
    oversized: 0,
    corrupt: 0,
    capped: 0,
  }
  if (!input.runs.length) return { byRun, scan, complete: true }
  const root =
    input.env.MATOS_SESSION_DIR?.trim() || getMatOSSessionsDir(input.cwd)
  const files = (
    await readdir(root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') scan.unreadable++
      return [] as string[]
    })
  ).filter((name) => name.endsWith('.jsonl'))
  const candidates: Array<{ path: string; mtime: number; size: number }> = []
  for (const file of files) {
    const path = join(root, file)
    const info = await lstat(path).catch(() => {
      scan.unreadable++
      return undefined
    })
    if (info?.isSymbolicLink()) scan.unreadable++
    if (info?.isFile())
      candidates.push({ path, mtime: info.mtimeMs, size: info.size })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  scan.sessionsSkippedByCap = Math.max(0, candidates.length - input.sessionCap)
  const seen = new Set<string>()
  for (const candidate of candidates.slice(0, input.sessionCap)) {
    if (candidate.size > 8 * 1024 * 1024) {
      scan.oversized++
      continue
    }
    const raw = await readEvolutionEvidenceFile(candidate.path).catch(() => {
      scan.unreadable++
      return undefined
    })
    if (!raw) continue
    scan.sessionsScanned++
    const events: MatOSEvent[] = []
    for (const line of raw.split('\n').filter((line) => line.trim())) {
      try {
        const event = JSON.parse(line)
        if (
          event &&
          typeof event === 'object' &&
          typeof event.type === 'string' &&
          typeof event.sessionId === 'string' &&
          Number.isFinite(Date.parse(event.timestamp)) &&
          event.data &&
          typeof event.data === 'object' &&
          !Array.isArray(event.data)
        )
          events.push(event)
        else scan.corrupt++
      } catch {
        scan.corrupt++
      }
    }
    if (events.some((event) => event.data?.hidden === true)) continue
    if (events.some((event) => event.type === 'matos.session.storage.capped'))
      scan.capped++
    const turns = new Map<string, MatOSEvent[]>()
    for (const event of events) {
      if (!event?.data || !event.sessionId || !event.timestamp) continue
      if (Date.parse(event.timestamp) > input.now.getTime()) continue
      const key = `${event.sessionId}:${event.turnId ?? event.data.turnId ?? 'legacy'}`
      const turn = turns.get(key) ?? []
      turn.push(event)
      turns.set(key, turn)
    }
    for (const [key, turn] of turns) {
      if (seen.has(key)) continue
      seen.add(key)
      const contexts = turn.filter(
        (event) => event.type === 'matos.turn.context.assembled',
      )
      const completion = turn.find(
        (event) => event.type === 'matos.turn.completed',
      )
      const calls = turn.filter(
        (event) => event.type === 'matos.tool.call.completed',
      )
      for (const run of input.runs) {
        const refs = new Set(
          (
            run.acceptanceEvidence?.observedChanges?.actualRefs ?? [
              ...run.updatedAssets,
              ...run.createdAssets,
            ]
          ).map(alias),
        )
        if (!refs.size) continue
        const relevant = contexts.filter((event) => {
          if (run.input.scopeRef && event.scopeRef !== run.input.scopeRef)
            return false
          const projected = Array.isArray(event.data.projectedAssets)
            ? event.data.projectedAssets
            : []
          return projected.some(
            (item) =>
              typeof item?.assetRef === 'string' &&
              refs.has(alias(item.assetRef)),
          )
        })
        if (!relevant.length) continue
        const at = Math.min(
          ...relevant.map((event) => Date.parse(event.timestamp)),
        )
        const boundary = Date.parse(run.updatedAt || run.createdAt)
        if (
          !Number.isFinite(at) ||
          !Number.isFinite(boundary) ||
          at > input.now.getTime() ||
          Math.abs(at - boundary) > 7 * 86400_000
        )
          continue
        const exposure = byRun.get(run.runId)!
        const after = at > boundary
        const window = after ? exposure.after : exposure.before
        window.projectedTurns++
        const withinWindow = (event: MatOSEvent) =>
          Date.parse(event.timestamp) >= at &&
          Math.abs(Date.parse(event.timestamp) - boundary) <= 7 * 86400_000
        const observedCalls = calls.filter(withinWindow)
        const observedCompletion =
          completion && withinWindow(completion) ? completion : undefined
        window.toolCalls += observedCalls.length
        window.failedToolCalls += observedCalls.filter(
          (event) =>
            event.data.isError === true ||
            event.data.success === false ||
            (typeof event.data.exitCode === 'number' &&
              event.data.exitCode !== 0),
        ).length
        if (observedCompletion) {
          window.completedTurns++
          if (
            observedCompletion.data.isError === true ||
            (typeof observedCompletion.data.exitCode === 'number' &&
              observedCompletion.data.exitCode !== 0)
          )
            window.failedTurns++
          const cost = observedCompletion.data.totalCostUsd
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
            window.reportedCostUsd += cost
        }
        if (after) {
          const confirmed = relevant.some((event) =>
            (
              event.data.projectedAssets as Array<{
                assetRef?: string
                sourceId?: string
                sourceCommit?: string
              }>
            ).some(
              (item) =>
                item.assetRef &&
                refs.has(alias(item.assetRef)) &&
                run.sourceAcceptance?.some(
                  (source) =>
                    source.ok &&
                    source.sourceId === item.sourceId &&
                    source.commit === item.sourceCommit,
                ),
            ),
          )
          if (confirmed && observedCompletion && !key.endsWith(':legacy'))
            exposure.revisionConfirmedCompletedTurns++
          if (!confirmed) exposure.unversionedProjectedTurns++
        }
      }
    }
  }
  return {
    byRun,
    scan,
    complete: Object.entries(scan).every(
      ([key, count]) => key === 'sessionsScanned' || count === 0,
    ),
  }
}
