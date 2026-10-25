import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSUsageCommand } from './usage.js'

describe('matos usage CLI', () => {
  test('prints JSON token usage for a scoped user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-usage-cli-'))
    const runtimeDataDir = join(root, 'runtime')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        assetRoots: [],
        execution: { runtimeDataDir },
      }, null, 2)}\n`,
      'utf8',
    )
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
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-05T00:00:00.000Z',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          model: 'deepseek-v4-pro',
          usage: { input_tokens: 13, output_tokens: 8 },
        },
      })}\n`,
      'utf8',
    )

    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runMatOSUsageCommand(
      [
        'tokens',
        '--scope',
        'user:alice',
        '--from',
        '2026-07-05',
        '--to',
        '2026-07-05',
        '--json',
      ],
      {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      },
    )

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      scopeRef: 'user:alice',
      bucket: 'day',
      totals: {
        inputTokens: 13,
        outputTokens: 8,
        totalTokens: 21,
      },
    })
  })
})
