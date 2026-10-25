import { describe, expect, test } from 'bun:test'
import { workflowTraceRefsFromRunAndEvents } from './workflowTraceRefs.js'

describe('workflow trace references', () => {
  test('reads nested workflow event trace context as trace refs', () => {
    expect(
      workflowTraceRefsFromRunAndEvents(
        { runId: 'run-1', traceId: 'legacy-run-trace' },
        [
          {
            runId: 'event-run-1',
            trace: {
              traceId: 'trace-nested',
              sessionId: 'session-nested',
              parentSessionId: 'session-parent',
            },
          },
          {
            traceId: 'legacy-event-trace',
            sessionId: 'legacy-event-session',
          },
        ],
      ),
    ).toEqual([
      'trace:legacy-event-session',
      'trace:legacy-event-trace',
      'trace:legacy-run-trace',
      'trace:session-nested',
      'trace:session-parent',
      'trace:trace-nested',
    ])
  })
})
