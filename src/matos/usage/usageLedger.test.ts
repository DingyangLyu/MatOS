import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  collectMatOSUsageTokens,
  collectMatOSUsageProfile,
  parseUsageBucket,
  parseUsageSourceFilter,
} from './usageLedger.js'
import { openMatOSSqliteDatabase } from '../storage/sqlite.js'

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  )
}

async function createUsageFixture(): Promise<{
  root: string
  runtimeDataDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-usage-ledger-'))
  const runtimeDataDir = join(root, 'runtime')
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeFile(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: [],
        execution: { runtimeDataDir },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return { root, runtimeDataDir }
}

describe('MatOS usage ledger', () => {
  test('workspace queries use writable mounted sessions, not a host-only runtime cache path', async () => {
    const { root } = await createUsageFixture()
    await writeFile(join(root, '.matos/matos.json'), JSON.stringify({ version: 1, assetRoots: [], execution: { runtimeDataDir: '/proc/matos-profile-host-only' } }))
    const overrides = { MATOS_SCOPE_REF: 'user:mounted', MATOS_SESSION_DIR: join(root, 'mounted-sessions'),
      MATOS_AGENT_HOME: join(root, 'mounted-home'), MATOS_WORKSPACE_DIR: join(root, 'mounted-workspace') }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, overrides)
      await writeJsonl(join(overrides.MATOS_AGENT_HOME, 'projects/s.jsonl'), [{ type: 'assistant', timestamp: '2026-07-01', message: { id: 'r', model: 'm', usage: { input_tokens: 11 } } }])
      const result = await collectMatOSUsageTokens({ cwd: root, source: 'combined' })
      expect(result.totals.totalTokens).toBe(11)
      expect(result.cache.dbPath).toBe(join(overrides.MATOS_SESSION_DIR, 'usage/usage.sqlite'))
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })
  test('combined sources do not double bill session totals and explicit source queries stay order independent', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const scope = join(runtimeDataDir, 'scopes/users/alice')
    await writeJsonl(join(scope, 'home/projects/s.jsonl'), [
      {
        type: 'assistant',
        sessionId: 's',
        timestamp: '2026-07-01',
        message: { id: 'r', model: 'm', usage: { input_tokens: 10 } },
      },
    ])
    await writeJsonl(join(scope, 'sessions/s.jsonl'), [
      {
        type: 'matos.session.completed',
        sessionId: 's',
        timestamp: '2026-07-01',
        data: { modelUsage: { m: { inputTokens: 10 } } },
      },
    ])
    const query = { cwd: root, scopeRef: 'user:alice' }
    expect(
      (await collectMatOSUsageTokens({ ...query, source: 'session' })).totals
        .totalTokens,
    ).toBe(10)
    expect(
      (await collectMatOSUsageTokens({ ...query, source: 'all' })).totals
        .totalTokens,
    ).toBe(10)
    expect(
      (await collectMatOSUsageTokens({ ...query, source: 'session' })).totals
        .totalTokens,
    ).toBe(10)
  })
  test('profile uses native totals, durable evolution survives cache deletion, and hidden sessions stay private', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const scope = join(runtimeDataDir, 'scopes/users/alice')
    await writeJsonl(join(scope, 'home/projects/work/session.jsonl'), [
      {
        type: 'user',
        uuid: 'u',
        sessionId: 's',
        timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'private text' },
      },
      {
        type: 'assistant',
        sessionId: 's',
        timestamp: '2026-07-01T10:00:03Z',
        message: {
          id: 'a',
          model: 'deepseek-flash',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ])
    await writeJsonl(join(scope, 'home/projects/work/hidden.jsonl'), [
      {
        type: 'user',
        uuid: 'hidden-u',
        sessionId: 'hidden',
        timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'hidden' },
      },
      {
        type: 'assistant',
        sessionId: 'hidden',
        timestamp: '2026-07-01T10:00:03Z',
        message: {
          id: 'hidden-a',
          model: 'deepseek-flash',
          usage: { input_tokens: 20 },
        },
      },
    ])
    // Resolve the workspace path from the native runtime scope, not a guessed layout.
    const { resolveMatOSRuntimeScope } = await import('../runtime/scopes.js')
    const resolved = resolveMatOSRuntimeScope(root, {
      scopeRef: 'user:alice',
      runtimeDataDir,
      env: {},
    })
    const legacy = join(
      resolved.sharedWorkspaceDir,
      '.matos/evolution/role-run-cache/cache.json',
    )
    const journal = join(resolved.sessionsDir, 'usage/evolution/record.json')
    await mkdir(join(legacy, '..'), { recursive: true })
    await mkdir(join(journal, '..'), { recursive: true })
    await writeFile(
      legacy,
      JSON.stringify({
        createdAt: '2026-07-01T10:00:03Z',
        result: {
          roleReference: 'role:user-feedback-critic@1.0.0',
          upstreamSessionId: 'hidden',
          usage: { input_tokens: 20 },
          modelUsage: { 'deepseek-flash': {} },
        },
      }),
    )
    await writeFile(
      journal,
      JSON.stringify({
        schemaVersion: 1,
        id: 'paid',
        stage: 'user-feedback-critic',
        timestamp: '2026-07-01T10:00:03Z',
        sessionId: 'hidden',
        rows: [
          {
            model: 'deepseek-flash',
            usage: { input_tokens: 20 },
            unavailable: false,
          },
        ],
      }),
    )
    const query = {
      cwd: root,
      scopeRef: 'user:alice',
      from: '2026-07-01',
      to: '2026-07-01',
    }
    const profile = await collectMatOSUsageProfile(query)
    expect(profile).toMatchObject({
      totalTokens: 35,
      foregroundTokens: 15,
      backgroundTokens: 20,
      userMessageCount: 1,
      sessionCount: 1,
      longestTaskMs: 3000,
    })
    expect(JSON.stringify(profile)).not.toContain(root)
    expect(JSON.stringify(profile)).not.toContain('private text')
    expect(JSON.stringify(profile)).not.toContain('hidden')
    await rm(legacy)
    expect((await collectMatOSUsageProfile(query)).totalTokens).toBe(35)
  })

  test('rebuilds old derived caches even when source files have not changed', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    await writeJsonl(
      join(runtimeDataDir, 'scopes/users/alice/home/projects/s.jsonl'),
      [
        {
          type: 'assistant',
          timestamp: '2026-07-01',
          message: { id: 'r', model: 'm', usage: { input_tokens: 4 } },
        },
      ],
    )
    const query = { cwd: root, scopeRef: 'user:alice' }
    const first = await collectMatOSUsageTokens(query)
    const db = await openMatOSSqliteDatabase(first.cache.dbPath)
    db.exec(
      'UPDATE usage_cache_meta SET version = 1; UPDATE usage_rollup_daily SET total_tokens = 999',
    )
    db.close()
    const next = await collectMatOSUsageTokens(query)
    expect(next.totals.totalTokens).toBe(4)
    expect(next.cache.scannedFiles).toBe(1)
  })

  test('does not silently drop transcripts above 64 MiB or conceal malformed rows', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const file = join(
      runtimeDataDir,
      'scopes/users/alice/home/projects/large.jsonl',
    )
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({ type: 'progress', data: 'x'.repeat(65 * 1024 * 1024) }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-01',
          message: { id: 'r', model: 'm', usage: { input_tokens: 7 } },
        }) +
        '\n{truncated',
    )
    const result = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:alice',
    })
    expect(result.totals.totalTokens).toBe(7)
    expect(result.coverage.unavailableRecords).toBe(1)
  })

  test('does not inherit an ambient user home when an operator queries another scope', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const previous = {
      MATOS_SCOPE_REF: process.env.MATOS_SCOPE_REF,
      MATOS_AGENT_HOME: process.env.MATOS_AGENT_HOME,
    }
    try {
      process.env.MATOS_SCOPE_REF = 'user:alice'
      process.env.MATOS_AGENT_HOME = join(root, 'alice-private')
      await writeJsonl(join(root, 'alice-private/projects/private.jsonl'), [
        {
          type: 'assistant',
          timestamp: '2026-07-01',
          message: { model: 'm', usage: { input_tokens: 999 } },
        },
      ])
      const bob = join(runtimeDataDir, 'scopes/users/bob/home/projects')
      await mkdir(bob, { recursive: true })
      await symlink(
        join(root, 'alice-private/projects'),
        join(bob, 'forbidden-link'),
      )
      expect(
        (await collectMatOSUsageTokens({ cwd: root, scopeRef: 'user:bob' }))
          .totals.totalTokens,
      ).toBe(0)
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
  test('merges final streaming usage across copied compaction transcripts and midnight', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const dir = join(
      runtimeDataDir,
      'scopes/users/alice/home/projects/workspace',
    )
    const row = (output: number, timestamp: string) => ({
      type: 'assistant',
      timestamp,
      sessionId: 'session',
      message: {
        id: 'response',
        model: 'deepseek-flash',
        usage: {
          input_tokens: 10,
          output_tokens: output,
          cache_read_input_tokens: 20,
        },
      },
    })
    await writeJsonl(join(dir, 'session.jsonl'), [
      row(0, '2026-07-01T23:59:59Z'),
      row(8, '2026-07-02T00:00:01Z'),
    ])
    await writeJsonl(join(dir, 'session/subagents/agent-acompact-copy.jsonl'), [
      row(8, '2026-07-02T00:00:01Z'),
    ])
    const result = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:alice',
    })
    expect(result.totals).toMatchObject({
      totalTokens: 38,
      outputTokens: 8,
      eventCount: 1,
    })
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets[0]?.start).toBe('2026-07-01')
  })

  test('rejects invalid dates and inverted ranges instead of silently querying all history', async () => {
    const { root } = await createUsageFixture()
    await expect(
      collectMatOSUsageTokens({ cwd: root, from: '2026-02-30' }),
    ).rejects.toThrow()
    await expect(
      collectMatOSUsageTokens({
        cwd: root,
        from: '2026-09-02',
        to: '2026-09-01',
      }),
    ).rejects.toThrow()
  })

  test('aggregates transcript usage by day and model for one user scope', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const transcript = join(
      runtimeDataDir,
      'scopes',
      'users',
      'alice',
      'home',
      'projects',
      'workspace',
      'session-1.jsonl',
    )
    await writeJsonl(transcript, [
      {
        type: 'user',
        timestamp: '2026-07-01T00:00:00.000Z',
        sessionId: 'session-1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-01T00:00:01.000Z',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          model: 'deepseek-v4-pro',
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-02T03:00:00.000Z',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          model: 'glm-5.2',
          usage: {
            input_tokens: 5,
            output_tokens: 3,
          },
        },
      },
    ])

    const result = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:alice',
      from: '2026-07-01',
      to: '2026-07-07',
      bucket: 'day',
      source: 'transcript',
    })

    expect(result.scopeRef).toBe('user:alice')
    expect(result.cache.scannedFiles).toBe(1)
    expect(result.totals).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 2,
      totalTokens: 44,
      eventCount: 2,
    })
    expect(result.buckets).toEqual([
      expect.objectContaining({
        start: '2026-07-01',
        end: '2026-07-01',
        totalTokens: 36,
        models: {
          'deepseek-v4-pro': expect.objectContaining({ totalTokens: 36 }),
        },
      }),
      expect.objectContaining({
        start: '2026-07-02',
        end: '2026-07-02',
        totalTokens: 8,
        models: {
          'glm-5.2': expect.objectContaining({ totalTokens: 8 }),
        },
      }),
    ])
  })

  test('counts one API response once even when streaming splits it into one record per content block', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const transcript = join(
      runtimeDataDir,
      'scopes',
      'users',
      'dave',
      'home',
      'projects',
      'workspace',
      'session-1.jsonl',
    )
    const usage = {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 2,
    }
    await writeJsonl(transcript, [
      // Parallel tool calls: the streaming code emits a SEPARATE assistant
      // record per content block, all sharing message.id/requestId and
      // repeating the same usage object.
      {
        type: 'assistant',
        timestamp: '2026-07-05T00:00:01.000Z',
        sessionId: 'session-1',
        requestId: 'req_1',
        message: {
          id: 'msg_split',
          role: 'assistant',
          model: 'deepseek-v4-pro',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          ],
          usage,
        },
      },
      {
        type: 'user',
        timestamp: '2026-07-05T00:00:02.000Z',
        sessionId: 'session-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-05T00:00:03.000Z',
        sessionId: 'session-1',
        requestId: 'req_1',
        message: {
          id: 'msg_split',
          role: 'assistant',
          model: 'deepseek-v4-pro',
          content: [
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
          ],
          usage,
        },
      },
      // A different API response keeps counting normally.
      {
        type: 'assistant',
        timestamp: '2026-07-05T00:00:04.000Z',
        sessionId: 'session-1',
        requestId: 'req_2',
        message: {
          id: 'msg_next',
          role: 'assistant',
          model: 'deepseek-v4-pro',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ])

    const result = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:dave',
      from: '2026-07-05',
      to: '2026-07-05',
      source: 'transcript',
    })

    expect(result.totals).toMatchObject({
      inputTokens: 11,
      outputTokens: 5,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 2,
      totalTokens: 38,
      eventCount: 2,
    })
  })

  test('uses cached file metadata on unchanged follow-up queries', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const transcript = join(
      runtimeDataDir,
      'scopes',
      'users',
      'bob',
      'home',
      'projects',
      'workspace',
      'session-1.jsonl',
    )
    await writeJsonl(transcript, [
      {
        type: 'assistant',
        timestamp: '2026-07-03T00:00:00.000Z',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          model: 'deepseek-v4-pro',
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      },
    ])

    const first = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:bob',
      from: '2026-07-03',
      to: '2026-07-03',
      source: 'transcript',
    })
    const second = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:bob',
      from: '2026-07-03',
      to: '2026-07-03',
      source: 'transcript',
    })

    expect(first.cache.scannedFiles).toBe(1)
    expect(second.cache.scannedFiles).toBe(0)
    expect(second.cache.reusedFiles).toBe(1)
    expect(second.totals.totalTokens).toBe(9)
  })

  test('can include MatOS session completion usage as a separate source', async () => {
    const { root, runtimeDataDir } = await createUsageFixture()
    const sessionFile = join(
      runtimeDataDir,
      'scopes',
      'users',
      'carol',
      'sessions',
      'matos-session-1.jsonl',
    )
    await writeJsonl(sessionFile, [
      {
        id: 'event-1',
        sessionId: 'matos-session-1',
        traceId: 'trace-1',
        scopeRef: 'user:carol',
        userId: 'carol',
        roleRef: 'role:compute',
        timestamp: '2026-07-04T12:00:00.000Z',
        type: 'matos.session.completed',
        data: {
          modelUsage: {
            'deepseek-v4-pro': {
              inputTokens: 11,
              outputTokens: 6,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 0,
              costUSD: 0.012,
            },
          },
          totalCostUsd: 0.012,
        },
      },
    ])

    const result = await collectMatOSUsageTokens({
      cwd: root,
      scopeRef: 'user:carol',
      from: '2026-07-04',
      to: '2026-07-04',
      source: 'session',
    })

    expect(result.sources).toEqual(['matos-session'])
    expect(result.totals).toMatchObject({
      inputTokens: 11,
      outputTokens: 6,
      cacheReadInputTokens: 100,
      totalTokens: 117,
      totalCostUsd: 0.012,
    })
  })

  test('normalizes bucket and source query values', () => {
    expect(parseUsageBucket('week')).toBe('week')
    expect(parseUsageBucket('bogus')).toBe('day')
    expect(parseUsageSourceFilter('all')).toBe('all')
    expect(parseUsageSourceFilter('session')).toBe('session')
    expect(parseUsageSourceFilter('bogus')).toBe('transcript')
  })
})
