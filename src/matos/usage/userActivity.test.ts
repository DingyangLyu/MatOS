import { expect, test } from 'bun:test'
import { parseUserActivity, summarizeUserActivity } from './userActivity.js'

test('activity ignores metadata and tool results, deduplicates copies, and measures turns instead of idle session age', () => {
  const user = (uuid: string, at: string, extra = {}) => ({
    type: 'user',
    uuid,
    sessionId: 's',
    timestamp: at,
    message: { content: 'text' },
    ...extra,
  })
  const assistant = (id: string, at: string) => ({
    type: 'assistant',
    sessionId: 's',
    timestamp: at,
    message: {
      id,
      model: 'm',
      content: [{ type: 'tool_use', id: 'tool', name: 'Bash' }],
    },
  })
  const raw = [
    user('u1', '2026-09-12T10:00:00Z'),
    assistant('a1', '2026-09-12T10:00:05Z'),
    user('u2', '2026-09-13T10:00:00Z'),
    assistant('a2', '2026-09-13T10:00:09Z'),
    user('meta', '2026-09-13T10:00:10Z', { isMeta: true }),
    user('summary', '2026-09-13T10:00:10Z', { isCompactSummary: true }),
    user('result', '2026-09-13T10:00:10Z', {
      message: { content: [{ type: 'tool_result' }] },
    }),
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')
  const points = [
    ...parseUserActivity(raw, 'main'),
    ...parseUserActivity(raw, 'archive'),
  ]
  expect(
    summarizeUserActivity(points, '2026-09-01', '2026-09-14', '2026-09-14'),
  ).toMatchObject({
    userMessageCount: 2,
    toolCallCount: 1,
    longestTaskMs: 9000,
    currentStreakDays: 2,
    longestStreakDays: 2,
    sessionCount: 1,
  })
  expect(
    summarizeUserActivity(points, '2026-09-13', '2026-09-13', '2026-09-14')
      .userMessageCount,
  ).toBe(1)
  expect(
    summarizeUserActivity(points, '2026-09-01', '2026-09-20', '2026-09-20')
      .currentStreakDays,
  ).toBe(0)
})
