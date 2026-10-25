/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// `matos assets run-tool` — real end-to-end checks: a project-local tool
// asset resolves through the normal registry and executes through the SAME
// executor the asset MCP server uses (real python3 child process, stdin
// JSON in, stdout JSON out). No mocked runners.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMatOSAssetsCommand } from './assets.js'
import { interpretToolCallResult } from './assetsRunTool.js'

const AMBIENT_DEPLOYMENT_ENV_KEYS = [
  'MATOS_DEPLOY_ROOT',
  'MATOS_DATA_DIR',
  'MATOS_SHARED_ASSET_ROOT',
  'MATOS_GLOBAL_ASSET_ROOT',
  'MATOS_BUNDLED_ASSET_ROOT',
  'MATOS_ASSET_ROOTS',
  'MATOS_INCLUDE_LEGACY_ASSETS',
  'MATOS_EDITABLE_CORE_ASSET_ROOT',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of AMBIENT_DEPLOYMENT_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.MATOS_BUNDLED_ASSET_ROOT = '/nonexistent-matos-bundled-assets'
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

type Io = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  stdin?: () => Promise<string> | string
}

function makeIo(
  cwd: string,
  stdin?: () => Promise<string> | string,
): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      ...(stdin ? { stdin } : {}),
    },
    out,
    err,
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Project workspace with one executable external tool asset. The tool is a
 * real python3 program speaking the stdin-JSON contract (the exact shape
 * `callMatOSTool` sends: `{"input": {...}}`). */
async function makeToolProject(options?: {
  toolBody?: string
  disabled?: boolean
}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-run-tool-'))
  const packRoot = join(cwd, '.matos', 'assets', 'packs', 'run-tool-fixture')
  const toolDir = join(packRoot, 'tools', 'echo-tool')
  await mkdir(toolDir, { recursive: true })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: 'run-tool-fixture',
    name: 'Run Tool Fixture Pack',
    version: '0.1.0',
  })
  await writeJson(join(toolDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'echo-tool',
    type: 'tool',
    name: 'Echo Tool',
    version: '0.1.0',
    description: 'Echoes the JSON input back (run-tool executor fixture).',
    entry: './tool.py',
    ...(options?.disabled
      ? { lifecycle: { status: 'disabled', reason: 'test' } }
      : {}),
    metadata: {
      kind: 'external-tool',
      executor: {
        type: 'matos-python',
        runtime: 'python3',
        entry: './tool.py',
        timeoutMs: 30000,
        mcpName: 'echo_tool',
      },
    },
  })
  await writeFile(
    join(toolDir, 'tool.py'),
    options?.toolBody ??
      [
        '#!/usr/bin/env python3',
        'import json, sys',
        'payload = json.load(sys.stdin)',
        'inner = payload.get("input", payload)',
        'print(json.dumps({"ok": True, "echoed": inner}))',
        '',
      ].join('\n'),
    'utf8',
  )
  return cwd
}

describe('matos assets run-tool', () => {
  test('resolves the tool asset and round-trips JSON through the real executor', async () => {
    const cwd = await makeToolProject()
    const input = { action: 'decompose', positionsB64: 'QUJD', maxHulls: 16 }
    const inputPath = join(cwd, 'input.json')
    await writeFile(inputPath, JSON.stringify(input), 'utf8')

    const { io, out } = makeIo(cwd)
    const code = await runMatOSAssetsCommand(
      ['run-tool', 'tool:echo-tool', '--input-file', inputPath, '--json'],
      io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as {
      ok: boolean
      tool: string
      mcpName: string
      exitCode: number
      result: { ok: boolean; echoed: Record<string, unknown> }
    }
    expect(result.ok).toBe(true)
    expect(result.tool).toBe('tool:echo-tool@0.1.0')
    expect(result.mcpName).toBe('echo_tool')
    expect(result.exitCode).toBe(0)
    // The executor wraps input as {"input": ...} and the tool unwrapped it —
    // proving the exact stdin contract the asset MCP server uses.
    expect(result.result.echoed).toEqual(input)
  })

  test('reads the input document from stdin with --input-file -', async () => {
    const cwd = await makeToolProject()
    const { io, out } = makeIo(cwd, () => JSON.stringify({ from: 'stdin' }))
    const code = await runMatOSAssetsCommand(
      ['run-tool', 'tool:echo-tool', '--input-file', '-', '--json'],
      io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as {
      result: { echoed: Record<string, unknown> }
    }
    expect(result.result.echoed).toEqual({ from: 'stdin' })
  })

  test('a structured ok:false payload exits 1 with the payload preserved', async () => {
    const cwd = await makeToolProject({
      toolBody: [
        '#!/usr/bin/env python3',
        'import json',
        'print(json.dumps({"ok": False, "error": "venv missing"}))',
        '',
      ].join('\n'),
    })
    const { io, out } = makeIo(cwd)
    const code = await runMatOSAssetsCommand(
      ['run-tool', 'tool:echo-tool', '--json'],
      io,
    )
    expect(code).toBe(1)
    const result = JSON.parse(out.join('')) as {
      ok: boolean
      result: { ok: boolean; error: string }
    }
    expect(result.ok).toBe(false)
    expect(result.result.error).toBe('venv missing')
  })

  test('refuses unknown refs, non-tool assets, disabled tools, and bad input', async () => {
    const cwd = await makeToolProject()

    const missing = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(['run-tool', 'tool:no-such-tool', '--json'], missing.io),
    ).toBe(1)
    expect(missing.err.join('')).toContain('not found')

    const badJson = makeIo(cwd, () => 'not json {')
    expect(
      await runMatOSAssetsCommand(
        ['run-tool', 'tool:echo-tool', '--input-file', '-', '--json'],
        badJson.io,
      ),
    ).toBe(1)
    expect(badJson.err.join('')).toContain('not valid JSON')

    const disabledCwd = await makeToolProject({ disabled: true })
    const disabled = makeIo(disabledCwd)
    expect(
      await runMatOSAssetsCommand(['run-tool', 'tool:echo-tool', '--json'], disabled.io),
    ).toBe(1)
    expect(disabled.err.join('')).toContain('not found or not enabled')
  })

  test('interpretToolCallResult mirrors the MCP server error semantics', () => {
    expect(
      interpretToolCallResult({ exitCode: 0, stdout: '{"ok": true}', stderr: '' }),
    ).toEqual({ ok: true, timedOut: false, structured: { ok: true } })
    expect(
      interpretToolCallResult({ exitCode: 0, stdout: '{"ok": false}', stderr: '' }).ok,
    ).toBe(false)
    expect(
      interpretToolCallResult({ exitCode: 65, stdout: '{"ok": true}', stderr: '' }).ok,
    ).toBe(false)
    expect(interpretToolCallResult({ exitCode: null, stdout: '', stderr: '' })).toEqual({
      ok: false,
      timedOut: true,
      structured: {},
    })
    expect(
      interpretToolCallResult({ exitCode: 0, stdout: 'plain text', stderr: '' }),
    ).toEqual({ ok: true, timedOut: false, structured: undefined })
  })
})
