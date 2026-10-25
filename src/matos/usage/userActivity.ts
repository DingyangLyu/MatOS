/** Compact metadata over native transcripts. Never persist message text or tool inputs. */
export type ActivityPoint = {
  id: string
  session: string
  at: string
  kind: 'user' | 'assistant' | 'tool'
  name?: string
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}

export function parseUserActivity(
  raw: string,
  source: string,
  offset = 0,
): ActivityPoint[] {
  const points: ActivityPoint[] = []
  for (const [index, line] of raw.split('\n').entries()) {
    let row: Record<string, unknown>
    try {
      row = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (row.isMeta || row.isSidechain || row.isCompactSummary) continue
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const m = obj(row.message)
    if (m.model === '<synthetic>') continue
    const ts =
      typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(ts)) continue
    const at = new Date(ts).toISOString()
    const session = typeof row.sessionId === 'string' ? row.sessionId : source
    const content = Array.isArray(m.content) ? m.content.map(obj) : []
    if (row.type === 'user' && content.some((v) => v.type === 'tool_result'))
      continue
    const id = `${session}:${row.uuid ?? (row.type === 'assistant' ? m.id : undefined) ?? `${source}:${offset + index}`}`
    points.push({ id, session, at, kind: row.type })
    if (row.type === 'assistant')
      for (const [i, item] of content.entries()) {
        if (item.type === 'tool_use' && typeof item.name === 'string')
          points.push({
            id: `${session}:tool:${item.id ?? `${id}:${i}`}`,
            session,
            at,
            kind: 'tool',
            name: item.name,
          })
      }
  }
  return points
}

export function summarizeUserActivity(
  points: Iterable<ActivityPoint>,
  from: string,
  to: string,
  today: string,
) {
  const unique = new Map<string, ActivityPoint>()
  for (const point of points) {
    const old = unique.get(point.id)
    // The final block determines turn end; user/tool timestamps use first occurrence.
    if (
      !old ||
      (point.kind === 'assistant' ? point.at > old.at : point.at < old.at)
    )
      unique.set(point.id, point)
  }
  const sorted = [...unique.values()].sort((a, b) => a.at.localeCompare(b.at))
  const sessions = new Set<string>(),
    days = new Set<string>(),
    tools = new Map<string, number>()
  const turns = new Map<string, { start: string; end?: string }>()
  let longestTaskMs = 0,
    userMessageCount = 0,
    toolCallCount = 0
  let firstActivityAt: string | null = null,
    lastActivityAt: string | null = null
  const inRange = (at: string) =>
    at.slice(0, 10) >= from && at.slice(0, 10) <= to
  const finish = (turn: { start: string; end?: string }) => {
    if (turn.end && inRange(turn.start))
      longestTaskMs = Math.max(
        longestTaskMs,
        Date.parse(turn.end) - Date.parse(turn.start),
      )
  }
  for (const point of sorted) {
    if (point.kind === 'user') {
      const old = turns.get(point.session)
      if (old) finish(old)
      turns.set(point.session, { start: point.at })
    } else if (point.kind === 'assistant') {
      const turn = turns.get(point.session)
      if (turn) turn.end = point.at
    }
    if (!inRange(point.at)) continue
    sessions.add(point.session)
    days.add(point.at.slice(0, 10))
    firstActivityAt ??= point.at
    lastActivityAt = point.at
    if (point.kind === 'user') userMessageCount++
    if (point.kind === 'tool') {
      toolCallCount++
      const name = point.name!.replace(/^mcp__matos[_-]asset__/, 'asset:')
      tools.set(name, (tools.get(name) ?? 0) + 1)
    }
  }
  for (const turn of turns.values()) finish(turn)
  let longestStreakDays = 0,
    run = 0,
    previous = 0
  for (const day of [...days].sort()) {
    const ts = Date.parse(`${day}T00:00:00Z`)
    run = ts - previous === 86400000 ? run + 1 : 1
    longestStreakDays = Math.max(longestStreakDays, run)
    previous = ts
  }
  let currentStreakDays = 0,
    cursor = Date.parse(`${today}T00:00:00Z`)
  if (!days.has(today)) cursor -= 86400000
  while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
    currentStreakDays++
    cursor -= 86400000
  }
  return {
    sessionCount: sessions.size,
    activeDays: days.size,
    userMessageCount,
    toolCallCount,
    longestTaskMs,
    firstActivityAt,
    lastActivityAt,
    currentStreakDays,
    longestStreakDays,
    topTools: [...tools]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 8),
  }
}
