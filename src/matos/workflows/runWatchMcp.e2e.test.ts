import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeMcpRequest } from '../../../vendor/deepseek-harness/matos-plugin/nativeMcpRequest.js'
import { createWorkflowRunWatcher, listWorkflowRunWatches, waitForWorkflowRun } from './runPulse.js'

test('one real persistent MCP process registers detached native CLI runs for each calling chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-mcp-owner-'))
  const repo = resolve(import.meta.dir, '../../..')
  const asset = join(root, '.matos/assets/workflows/mcp-owner')
  await mkdir(asset, { recursive: true })
  await mkdir(join(root, 'home'), { recursive: true })
  await writeFile(join(root, '.matos/matos.json'), JSON.stringify({ version: 1,
    assetRoots: ['assets'], includeDefaultAssetRoots: false, assetSources: [],
    execution: { runtimeDataDir: join(root, 'runtime') },
  }))
  await writeFile(join(asset, 'asset.json'), JSON.stringify({ schemaVersion: 1, id: 'mcp-owner',
    type: 'workflow', name: 'MCP owner', version: '0.1.0', entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  }))
  await writeFile(join(asset, 'workflow.json'), JSON.stringify({ schemaVersion: 1, name: 'mcp-owner',
    parameters: {}, policy: { approvalMode: 'bypass', defaultRisk: 'low' }, outputs: {},
    nodes: [{ id: 'work', type: 'exec', dependsOn: [], command: 'printf "%s" "$MATOS_WORKFLOW_SESSION_ID" > "$MATOS_WORKFLOW_RUN_DIR/owner.txt"' }],
  }))
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repo, 'src/matos/tools/matosToolMcpServer.ts')], cwd: root, stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TMPDIR: tmpdir(),
      MATOS_AGENT_HOME: join(root, 'home/.matos'), MATOS_PROJECT_CWD: root,
      MATOS_WORKFLOW_TOOL_MODE: 'full', MATOS_WORKFLOW_ACCESS_MODE: 'unrestricted',
      MATOS_MODE: '1', MATOS_WORKFLOW_SESSION_ID: 'stale-spawn-chat',
      MATOS_DEPLOY_ROOT: join(root, 'deploy'),
      MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'), MATOS_GITEA_DISABLE_OPERATOR_ENV: '1',
      MATOS_DISABLE_EVOLUTION: '1', MATOS_DISABLE_EVOLUTION_WORKER: '1', DO_NOT_TRACK: '1',
    },
  })
  let diagnostics = ''
  transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000) })
  const client = new Client({ name: 'matos-owner-e2e', version: '1.0.0' })
  const runs: Array<{ runId: string; runDir: string }> = []
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.some(x => x.name === 'workflow_run')).toBe(true)
    for (const sessionId of ['chat-a', 'chat-b', undefined]) {
      const args = { action: 'start', ref: 'workflow:mcp-owner', wait: false, sessionId: 'spoofed-tool-argument' }
      // The DSH adapter supplies trusted per-execution metadata. A bare
      // external MCP call remains unowned, even with a stale server env.
      const request = sessionId
        ? nativeMcpRequest('workflow_run', args, { agent: { session: { id: sessionId } } })
        : { name: 'workflow_run', arguments: args }
      const result = await client.callTool(request)
      if (result.isError) throw new Error(JSON.stringify(result) + diagnostics)
      const body = result.structuredContent as { detached: boolean; run: { runId: string; runDir: string } }
      expect(body.detached).toBe(true)
      runs.push(body.run)
      const entry = (await listWorkflowRunWatches(root)).find(x => x.runId === body.run.runId)
      expect(entry?.sessionId).toBe(sessionId)
      const settled = await waitForWorkflowRun({ runDir: body.run.runDir, timeoutSeconds: 45, pollMs: 100 })
      if (settled.pulse.status !== 'completed') throw new Error(JSON.stringify(settled) + diagnostics + await readFile(join(body.run.runDir, 'detached-runner.log'), 'utf8'))
      expect(await readFile(join(body.run.runDir, 'owner.txt'), 'utf8')).toBe(sessionId ?? '')
    }
    const other = createWorkflowRunWatcher({ cwd: root, sessionId: 'stale-spawn-chat', onNotification: () => {} })
    expect(await other.tick()).toEqual([])
    for (const [index, sessionId] of ['chat-a', 'chat-b'].entries()) {
      const watcher = createWorkflowRunWatcher({ cwd: root, sessionId, onNotification: () => {} })
      expect((await watcher.tick()).map(x => x.runId)).toEqual([runs[index]!.runId])
    }
    expect((await listWorkflowRunWatches(root)).map(x => x.runId)).toEqual([runs[2]!.runId])
  } finally {
    // Wait for the real detached workers to finish their final record writes.
    for (const run of runs) {
      const heartbeat = JSON.parse(await readFile(join(run.runDir, 'heartbeat.json'), 'utf8').catch(() => '{}'))
      if (typeof heartbeat.pid !== 'number') continue
      for (let i = 0; i < 100; i++) {
        try { process.kill(heartbeat.pid, 0) } catch { break }
        if (i === 99) process.kill(heartbeat.pid, 'SIGTERM')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await client.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)

test('native DSH MCP ownership rejects missing identity and ignores model-supplied identity', () => {
  for (const execution of [{}, { agent: { session: { id: '' } } }, { agent: { session: { id: 12 } } }]) {
    expect(() => nativeMcpRequest('workflow_run', {}, execution)).toThrow('executing session')
  }
  const args = { sessionId: 'spoofed', _meta: { 'matos/nativeSessionId': 'spoofed' } }
  const requests = ['root', 'child', 'root'].map(id =>
    nativeMcpRequest('workflow_run', args, { agent: { session: { id } } }))
  expect(requests.map(request => request._meta['matos/nativeSessionId'])).toEqual(['root', 'child', 'root'])
})
