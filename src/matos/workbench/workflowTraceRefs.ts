function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function addTraceRef(refs: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    refs.add(trimmed.startsWith('trace:') ? trimmed : `trace:${trimmed}`)
  }
}

function addTraceRefs(refs: Set<string>, value: unknown): void {
  const record = objectRecord(value)
  addTraceRef(refs, record.traceId)
  addTraceRef(refs, record.sessionId)
  addTraceRef(refs, record.parentSessionId)
}

export function workflowTraceRefsFromRunAndEvents(
  run: unknown,
  events: unknown[],
  snapshot?: unknown,
): string[] {
  const refs = new Set<string>()
  const runRecord = objectRecord(run)
  const snapshotRecord = objectRecord(snapshot)

  addTraceRefs(refs, runRecord)
  addTraceRefs(refs, snapshotRecord)
  addTraceRefs(refs, runRecord.trace)
  addTraceRefs(refs, snapshotRecord.trace)

  for (const event of events) {
    const eventRecord = objectRecord(event)
    addTraceRefs(refs, eventRecord)
    addTraceRefs(refs, eventRecord.trace)
  }

  return [...refs].sort()
}
