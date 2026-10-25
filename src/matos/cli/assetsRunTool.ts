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

// `matos assets run-tool <tool-ref>` — invoke one external tool asset with a
// JSON input document, outside of a model conversation.
//
// This is the CLI face of the exact executor the asset MCP server uses:
// the tool ref resolves through the normal asset registry, and execution
// goes through `loadMatOSToolDefinitions` + `callMatOSTool` (the
// stdin-JSON/stdout-JSON contract in tools/matosToolRunner.ts) — no second
// resolution or spawning path. UIs use it through a thin daemon proxy (the
// lab sandbox "decompose on server" backfill is the first consumer); agents
// and scripts can call it directly with `--json`.

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { readMatOSProjectMetadata } from '../projectMetadata.js'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
  type MatOSToolCallResult,
  type MatOSToolDefinition,
} from '../tools/matosToolRunner.js'
import { writeJson, type MatOSAssetsIO, type ParsedArgs } from './assetsCliShared.js'

const USAGE =
  'Usage: matos assets run-tool <tool-ref> ' +
  '[--input-file <path|->] [--timeout-ms <ms>] [--json]\n'

const STDERR_TAIL_CHARS = 4000

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

async function readInputContent(
  io: MatOSAssetsIO,
  inputFile: string | undefined,
): Promise<string> {
  if (!inputFile) return '{}'
  if (inputFile === '-') {
    return io.stdin ? await io.stdin() : await readProcessStdin()
  }
  const path = isAbsolute(inputFile) ? inputFile : join(io.cwd, inputFile)
  return readFile(path, 'utf8')
}

/** Mirror of the MCP server's result interpretation: parse stdout as JSON
 * when possible; a non-zero exit or a structured `ok: false` payload is a
 * tool failure. */
export function interpretToolCallResult(result: MatOSToolCallResult): {
  ok: boolean
  timedOut: boolean
  structured: Record<string, unknown> | undefined
} {
  let structured: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(result.stdout || '{}') as unknown
    structured =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
  } catch {
    structured = undefined
  }
  const timedOut = result.exitCode === null
  const ok =
    result.exitCode === 0 && !(structured && structured.ok === false)
  return { ok, timedOut, structured }
}

export async function runToolAssetCommand(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const reference = options.positionals[0]?.trim()
  if (!reference) {
    io.stderr(USAGE)
    return 1
  }

  let inputRaw: string
  try {
    inputRaw = await readInputContent(io, options.inputFile?.trim())
  } catch (error) {
    io.stderr(
      `run-tool: cannot read --input-file ${options.inputFile}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return 1
  }
  let input: unknown
  try {
    input = JSON.parse(inputRaw.trim() || '{}')
  } catch (error) {
    io.stderr(
      `run-tool: input is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })\n`,
    )
    return 1
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    io.stderr('run-tool: input must be a JSON object\n')
    return 1
  }

  // Resolve through the runtime-active registry: disabled/deprecated tools
  // are not executable, exactly like the asset MCP path never mounts them.
  const metadata = await readMatOSProjectMetadata(io.cwd, { allowMissing: true })
  const assets = await loadMatOSAssets(io.cwd, {
    runtimeSnapshot: true,
    // A version supplied directly to the CLI is an intentional pin, unlike
    // legacy project-picker display refs. Never silently replace that input.
    followAcceptedUpdates: !reference.includes('@') && metadata.assetVersionPolicy !== 'pinned',
  })
  const registry = buildMatOSAssetRegistry(assets)
  const asset = registry.resolve(reference)
  if (!asset) {
    io.stderr(`run-tool: MatOS tool asset not found or not enabled: ${reference}\n`)
    return 1
  }
  if (asset.type !== 'tool') {
    io.stderr(`run-tool: ${asset.canonicalKey} is a ${asset.type} asset, not a tool\n`)
    return 1
  }

  // REUSE the asset MCP executor's definition loader on the resolved asset
  // directory — same manifest/entry/schema/runtime handling, including the
  // builtin-pack skip (those tools have no external executor entry).
  let definitions: MatOSToolDefinition[]
  try {
    definitions = await loadMatOSToolDefinitions([asset.absolutePath])
  } catch (error) {
    io.stderr(
      `run-tool: ${asset.canonicalKey} has no loadable executor definition (${
        error instanceof Error ? error.message : String(error)
      })\n`,
    )
    return 1
  }
  const definition = definitions[0]
  if (!definition) {
    io.stderr(
      `run-tool: ${asset.canonicalKey} is not an executable external tool ` +
        '(builtin-pack tools run only inside the asset MCP server)\n',
    )
    return 1
  }
  if (
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  ) {
    definition.timeoutMs = options.timeoutMs
  }

  const callResult = await callMatOSTool(definition, input)
  const { ok, timedOut, structured } = interpretToolCallResult(callResult)
  const stderrTail = callResult.stderr.slice(-STDERR_TAIL_CHARS)

  if (options.json) {
    writeJson(io, {
      ok,
      tool: asset.canonicalKey,
      mcpName: definition.mcpName,
      exitCode: callResult.exitCode,
      timedOut,
      ...(structured !== undefined
        ? { result: structured }
        : { stdout: callResult.stdout }),
      ...(stderrTail ? { stderr: stderrTail } : {}),
    })
    return ok ? 0 : 1
  }

  if (callResult.stdout) io.stdout(callResult.stdout.endsWith('\n') ? callResult.stdout : `${callResult.stdout}\n`)
  if (stderrTail) io.stderr(stderrTail.endsWith('\n') ? stderrTail : `${stderrTail}\n`)
  if (timedOut) io.stderr(`run-tool: timed out after ${definition.timeoutMs}ms\n`)
  return ok ? 0 : 1
}
