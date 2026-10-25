import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMatOSWorkflowTools } from '../workflows/tools/workflowTools.js'
import {
  filterWorkflowToolsForMode,
  isStructuredToolPayloadError,
  loadServerTools,
  loadServerToolsCached,
  resetServerToolsCacheForTest,
  workflowToolModeFromEnv,
} from './matosToolMcpServer.js'

describe('MatOS tool MCP server workflow mode', () => {
  test.skipIf(process.platform === 'win32')('coalesces an in-flight load after its TTL and starts TTL at completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mcp-slow-list-'))
    const schema = join(root, 'schema.json')
    await writeFile(join(root, 'asset.json'), JSON.stringify({ id: 'slow', type: 'tool', name: 'Slow', version: '1.0.0',
      metadata: { kind: 'external-tool', inputSchemaPath: 'schema.json', executor: { entry: 'tool.py', runtime: 'python3' } } }))
    await writeFile(join(root, 'tool.py'), 'print("{}")\n')
    await promisify(execFile)('mkfifo', [schema])
    const oldTtl = process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS
    process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = '1'
    resetServerToolsCacheForTest()
    const input = { enableAssetDiscoveryTools: false, workflowToolMode: 'none' as const, toolDirs: [root] }
    const first = loadServerToolsCached(input)
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = loadServerToolsCached(input)
    try {
      expect(second).toBe(first)
    } finally {
      // Real filesystem backpressure, not a mocked loader or provider.
      await writeFile(schema, '{"type":"object"}')
      await Promise.all([first, second])
      if (oldTtl === undefined) delete process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS
      else process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS = oldTtl
      resetServerToolsCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('treats structured ok:false tool payloads as MCP tool errors', () => {
    expect(isStructuredToolPayloadError({ ok: false, error: 'backend down' })).toBe(
      true,
    )
    expect(isStructuredToolPayloadError({ ok: true })).toBe(false)
    expect(isStructuredToolPayloadError({ status: 'ok' })).toBe(false)
    expect(isStructuredToolPayloadError(null)).toBe(false)
  })

  test('filters workflow tools to facade mode for normal agents', () => {
    const tools = createMatOSWorkflowTools({ cwd: process.cwd() })
    const facadeTools = filterWorkflowToolsForMode(tools, 'facade').map(
      tool => tool.name,
    )

    expect(facadeTools).toEqual([
      'workflow_query',
      'workflow_run',
      'workflow_edit',
    ])
  })

  test('keeps specialist workflow tools in full mode and none in none mode', () => {
    const tools = createMatOSWorkflowTools({ cwd: process.cwd() })

    expect(filterWorkflowToolsForMode(tools, 'full').map(tool => tool.name)).toContain(
      'workflow_add_node',
    )
    expect(filterWorkflowToolsForMode(tools, 'none')).toEqual([])
  })

  test('derives workflow mode from explicit env before legacy boolean', () => {
    expect(
      workflowToolModeFromEnv({
        MATOS_WORKFLOW_TOOL_MODE: 'facade',
        MATOS_ENABLE_WORKFLOW_TOOLS: '1',
      }),
    ).toBe('facade')
    expect(
      workflowToolModeFromEnv({
        MATOS_ENABLE_WORKFLOW_TOOLS: '0',
      }),
    ).toBe('none')
    expect(workflowToolModeFromEnv({ MATOS_ENABLE_WORKFLOW_TOOLS: '1' })).toBe(
      'full',
    )
  })

  test('tolerates a malformed MATOS_TOOL_ASSET_DIRS env without throwing', async () => {
    const originalDirs = process.env.MATOS_TOOL_ASSET_DIRS
    const originalKeys = process.env.MATOS_SELECTED_ASSET_KEYS
    process.env.MATOS_TOOL_ASSET_DIRS = '{not-json'
    process.env.MATOS_SELECTED_ASSET_KEYS = 'also-not-json['
    try {
      // A garbled internal env var must degrade gracefully instead of throwing
      // out of loadServerTools and disabling every asset tool.
      const tools = await loadServerTools({
        enableAssetDiscoveryTools: false,
        workflowToolMode: 'none',
      })
      const names = tools.map(tool => tool.name)
      expect(names).toContain('asset_edit')
    } finally {
      if (originalDirs === undefined) delete process.env.MATOS_TOOL_ASSET_DIRS
      else process.env.MATOS_TOOL_ASSET_DIRS = originalDirs
      if (originalKeys === undefined) delete process.env.MATOS_SELECTED_ASSET_KEYS
      else process.env.MATOS_SELECTED_ASSET_KEYS = originalKeys
    }
  })

  test('publishes scoped asset edits from MATOS_ASSETS_CWD in nested project chats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mcp-asset-governance-'))
    const projectCwd = join(root, 'projects', 'nested-project')
    const assetCwd = join(root, 'scope-workspace')
    await mkdir(projectCwd, { recursive: true })
    await mkdir(assetCwd, { recursive: true })

    const envKeys = [
      'MATOS_PROJECT_CWD',
      'MATOS_ASSETS_CWD',
      'MATOS_SCOPE_REF',
      'MATOS_SCOPE_ID',
    ] as const
    const previousEnv = Object.fromEntries(
      envKeys.map(key => [key, process.env[key]]),
    )
    process.env.MATOS_PROJECT_CWD = projectCwd
    process.env.MATOS_ASSETS_CWD = assetCwd
    process.env.MATOS_SCOPE_REF = 'user:alice'
    delete process.env.MATOS_SCOPE_ID

    try {
      const tools = await loadServerTools({
        enableAssetDiscoveryTools: false,
        workflowToolMode: 'none',
      })
      const assetEdit = tools.find(tool => tool.name === 'asset_edit')
      expect(assetEdit).toBeDefined()

      const result = await assetEdit!.call({
        action: 'preview_create',
        type: 'tool',
        id: 'scope-root-probe',
        version: '1.0.0',
        name: 'Scope Root Probe',
      })
      const parsed = JSON.parse(result.text) as {
        ok?: boolean
        plan?: { target?: { generatedDir?: string } }
      }

      expect(parsed.ok).toBe(true)
      expect(parsed.plan?.target?.generatedDir).toBe(
        join(
          assetCwd,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'tool',
          'scope-root-probe',
        ),
      )
      expect(parsed.plan?.target?.generatedDir?.startsWith(projectCwd)).toBe(
        false,
      )
    } finally {
      for (const key of envKeys) {
        const value = previousEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a broken external tool reports a tool error instead of throwing on call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mcp-tool-badruntime-'))
    try {
      const dir = join(root, 'unrunnable-tool')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'asset.json'),
        JSON.stringify({
          id: 'unrunnable-tool',
          type: 'tool',
          name: 'Unrunnable Tool',
          version: '0.1.0',
          metadata: {
            kind: 'external-tool',
            executor: {
              entry: 'tool.py',
              mcpName: 'unrunnable_tool',
              // A runtime binary that does not exist makes spawn emit ENOENT,
              // which callMatOSTool surfaces as a rejected promise.
              runtime: 'matos-nonexistent-runtime-xyz',
              timeoutMs: 5000,
            },
          },
        }),
        'utf8',
      )
      await writeFile(join(dir, 'tool.py'), 'print("{}")\n', 'utf8')

      const tools = await loadServerTools({
        enableAssetDiscoveryTools: false,
        workflowToolMode: 'none',
        toolDirs: [dir],
        reportExternalToolDiagnostic: () => {},
      })
      const tool = tools.find(candidate => candidate.name === 'unrunnable_tool')
      expect(tool).toBeDefined()

      const result = await tool!.call({})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('unrunnable_tool')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps native and valid external tools visible when one external asset is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mcp-tool-isolation-'))
    const badDir = join(root, 'broken-private-token-should-not-leak')
    const goodDir = join(root, 'healthy-tool')
    const diagnostics: string[] = []
    try {
      await mkdir(badDir, { recursive: true })
      await mkdir(goodDir, { recursive: true })
      await writeFile(
        join(badDir, 'asset.json'),
        JSON.stringify({
          id: 'broken-tool',
          type: 'tool',
          name: 'Broken Tool',
          version: '0.1.0',
          metadata: {
            kind: 'external-tool',
            inputSchemaPath: 'secret-api-key-missing.schema.json',
            executor: { entry: 'tool.py', mcpName: 'broken_tool' },
          },
        }),
        'utf8',
      )
      await writeFile(
        join(goodDir, 'asset.json'),
        JSON.stringify({
          id: 'healthy-tool',
          type: 'tool',
          name: 'Healthy Tool',
          version: '0.1.0',
          metadata: {
            kind: 'external-tool',
            executor: { entry: 'tool.py', mcpName: 'healthy_tool' },
          },
        }),
        'utf8',
      )

      const tools = await loadServerTools({
        enableAssetDiscoveryTools: false,
        workflowToolMode: 'facade',
        toolDirs: [badDir, goodDir],
        reportExternalToolDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })
      const names = tools.map(tool => tool.name)

      expect(names).toContain('workflow_query')
      expect(names).toContain('workflow_edit')
      expect(names).toContain('workflow_run')
      expect(names).toContain('healthy_tool')
      expect(names).not.toContain('broken_tool')
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toContain('broken-tool')
      expect(diagnostics[0]).toContain('missing-file')
      expect(diagnostics[0]).not.toContain(root)
      expect(diagnostics[0]).not.toContain('secret-api-key')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
