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

// The matos_asset MCP server reloaded every tool definition (tool-dir scans,
// prompt/schema reads, tool-factory rebuilds) on every tools/list AND every
// tools/call. The short-TTL cache collapses that burst cost while preserving
// the dynamic-assets policy: edits become visible after the TTL without
// restarting the server.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  loadServerToolsCached,
  resetServerToolsCacheForTest,
} from './matosToolMcpServer.js'

const ORIGINAL_TTL = process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS

afterEach(() => {
  if (ORIGINAL_TTL === undefined) {
    delete process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS
  } else {
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = ORIGINAL_TTL
  }
  resetServerToolsCacheForTest()
})

async function writeToolAsset(root: string, id: string, description = `Probe tool ${id}.`): Promise<void> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'asset.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      type: 'tool',
      name: id,
      version: '1.0.0',
      description,
      metadata: {
        kind: 'external-tool',
        executor: { entry: 'run.py', runtime: 'python3' },
      },
    }),
    'utf8',
  )
  await writeFile(join(dir, 'run.py'), 'print("{}")\n', 'utf8')
}

async function setupToolRoot(): Promise<{
  root: string
  toolDirs: () => Promise<string[]>
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-mcp-tool-cache-'))
  await writeToolAsset(root, 'alpha')
  return {
    root,
    toolDirs: async () => [join(root, 'alpha'), join(root, 'beta')],
  }
}

function baseInput(toolDirs: string[]) {
  return {
    enableAssetDiscoveryTools: false,
    workflowToolMode: 'none' as const,
    toolDirs,
    reportExternalToolDiagnostic: () => {},
  }
}

describe('matos_asset server tool cache', () => {
  test('reuses the loaded tool set within the TTL and refreshes after it', async () => {
    const { root } = await setupToolRoot()
    const dirs = [join(root, 'alpha')]
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = '60000'
    resetServerToolsCacheForTest()

    const first = await loadServerToolsCached(baseInput(dirs))
    expect(first.some(tool => tool.name === 'alpha')).toBe(true)
    expect(first.some(tool => tool.name === 'beta')).toBe(false)

    // A complete successful list is reusable. Partial lists with missing
    // expected directories are covered separately and must never be cached.
    await writeToolAsset(root, 'alpha', 'Updated description')
    const second = await loadServerToolsCached(baseInput(dirs))
    expect(second).toBe(first)

    // After the TTL expires the next load sees the new asset.
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = '20'
    await new Promise(resolve => setTimeout(resolve, 40))
    const third = await loadServerToolsCached(baseInput(dirs))
    expect(third).not.toBe(first)
    expect(third.find(tool => tool.name === 'alpha')?.description).toBe('Updated description')
  })

  test('TTL of zero disables caching entirely', async () => {
    const { root } = await setupToolRoot()
    const dirs = [join(root, 'alpha'), join(root, 'beta')]
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = '0'
    resetServerToolsCacheForTest()

    const first = await loadServerToolsCached(baseInput(dirs))
    await writeToolAsset(root, 'beta')
    const second = await loadServerToolsCached(baseInput(dirs))
    expect(second).not.toBe(first)
    expect(second.some(tool => tool.name === 'beta')).toBe(true)
  })

  test('input changes bypass the cached entry', async () => {
    const { root } = await setupToolRoot()
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = '60000'
    resetServerToolsCacheForTest()

    const first = await loadServerToolsCached(
      baseInput([join(root, 'alpha')]),
    )
    await writeToolAsset(root, 'beta')
    const second = await loadServerToolsCached(
      baseInput([join(root, 'alpha'), join(root, 'beta')]),
    )
    expect(second).not.toBe(first)
    expect(second.some(tool => tool.name === 'beta')).toBe(true)
  })
})
