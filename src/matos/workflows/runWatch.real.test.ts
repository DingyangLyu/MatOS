import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'

const token = process.env.DEEPSEEK_API_KEY
const runReal = process.env.MATOS_RUN_REAL_LLM_TESTS === '1' && Boolean(token)

type JsonRecord = Record<string, any>

function jsonLines(text: string): JsonRecord[] {
  return text.split('\n').flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function stopGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch { /* The test process may have exited concurrently. */ }
}

for (const mode of ['mcp', 'cli'] as const) {
  test.skipIf(!runReal)('real Flash: ' + mode + ' detached workflow wakes its native owner after stdin EOF', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'workflow-real-owner-' })
    const repo = resolve(import.meta.dir, '../../..')
    const sessionId = randomUUID()
    const eventLog = join(root, 'dsh-events.jsonl')
    const asset = join(root, '.matos/assets/workflows/notify-proof')
    await mkdir(asset, { recursive: true })
    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, '.matos/matos.json'), JSON.stringify({
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [join(repo, 'distribution/benchmark-minimal/assets'), 'assets'],
      assetSources: [],
      execution: { runtimeDataDir: join(root, 'runtime') },
    }))
    await writeFile(join(asset, 'asset.json'), JSON.stringify({
      schemaVersion: 1, id: 'notify-proof', type: 'workflow',
      name: 'Native notification proof', version: '0.1.0', entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    }))
    await writeFile(join(asset, 'workflow.json'), JSON.stringify({
      schemaVersion: 1, name: 'notify-proof', parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' }, outputs: {},
      nodes: [{
        id: 'work', type: 'exec', dependsOn: [],
        command: 'python3 -c \'import os,json,time; time.sleep(12); json.dump({"mean":sum([1,2,3])/3,"owner":os.environ.get("MATOS_WORKFLOW_SESSION_ID")},open(os.path.join(os.environ["MATOS_PROJECT_CWD"],"computed.json"),"w"))\'',
      }],
    }))
    const launchCommand = JSON.stringify(join(repo, 'bin/matos')) + ' workflow run workflow:notify-proof --detach --json'
    const launcher = mode === 'mcp'
      ? 'Use the workflow_run MCP tool with {"action":"start","ref":"workflow:notify-proof","wait":false}. Do not launch through Bash.'
      : 'Use Bash to run exactly: ' + launchCommand + '. Do not use run_in_background; the CLI itself detaches. Do not launch through MCP.'
    const prompt = 'Execute the mounted workflow:notify-proof exactly once. ' + launcher + ' ' +
      'After successful launch, call no more tools in that waiting turn; reply only WORKFLOW_WAITING and rely on the automatic workflow notification. ' +
      'Do not call workflow wait/status/events, TaskOutput, sleep or poll while waiting. Do not delegate. ' +
      'Only after the completion notification, read ' + join(root, 'computed.json') + ' and write ' + join(root, 'report.md') + ' with the actual mean and WORKFLOW_OWNER_OK. ' +
      'Then reply with WORKFLOW_OWNER_OK and the mean. Do not modify the workflow or access other workspaces.'
    const log = await open(join(root, 'run.log'), 'w', 0o600)
    const child = spawn(join(repo, 'bin/matos'), [
      '--role', 'compute', '--asset', 'workflow:notify-proof', '-p',
      '--output-format', 'stream-json', '--verbose', prompt, '--session-id', sessionId, '--max-turns', '10',
    ], {
      cwd: root, stdio: ['ignore', log.fd, log.fd], detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH, HOME: join(root, 'home'),
        TMPDIR: process.env.TMPDIR, MATOS_TEST_TMPDIR: process.env.MATOS_TEST_TMPDIR,
        MATOS_AGENT_HOME: join(root, 'home/.matos'), MATOS_WORKSPACE_CACHE_ROOT: join(root, 'cache'),
        MATOS_RUNTIME_COMPILED: '0', MATOS_SCOPE_REF: 'user:local',
        MATOS_DEPLOY_ROOT: join(root, 'deploy'), MATOS_RUNTIME_DATA_DIR: join(root, 'runtime'),
        MATOS_DSH_HOME: join(root, 'dsh'), DSH_HOME: join(root, 'dsh'), MATOS_DSH_EVENT_LOG: eventLog,
        MATOS_GITEA_DISABLE_OPERATOR_ENV: '1', MATOS_DISABLE_EVOLUTION: '1',
        MATOS_DISABLE_EVOLUTION_WORKER: '1', MATOS_DISABLE_ALWAYS_ON_LEARNING: '1', MATOS_DISABLE_SELF_EVOLUTION: '1',
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
        DEEPSEEK_API_KEY: token, MATOS_DSH_MODEL: 'deepseek-flash',
        MATOS_NESTED_SANDBOX_AVAILABLE: '0', CUDA_VISIBLE_DEVICES: '', DO_NOT_TRACK: '1',
        MATOS_RUN_STREAM_STDOUT: '1', MATOS_RUN_STREAM_TOOL_EVENTS: '1',
      },
    })
    await log.close()
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      stopGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => stopGroup(child, 'SIGKILL'), 5_000)
      killTimer.unref()
    }, 180_000)
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject)
        child.once('exit', done)
      })
      expect(timedOut).toBe(false)
      expect(code).toBe(0)
      const computed = JSON.parse(await readFile(join(root, 'computed.json'), 'utf8'))
      expect(computed.mean).toBe(2)
      expect(computed.owner).toBe(sessionId)
      expect(await readFile(join(root, 'report.md'), 'utf8')).toContain('WORKFLOW_OWNER_OK')

      // Native DSH receipts retain input/message IDs even though deeply nested
      // message bodies are deliberately redacted from the event log.
      const events = jsonLines(await readFile(eventLog, 'utf8'))
        .filter(item => item.method === 'session.event' && item.params?.sessionId === sessionId)
        .map(item => item.params.event as JsonRecord)
      const inputs = events.filter(event => event.type === 'agent/inbox/spliced' &&
        event.data?.target === 'next-turn' && event.data?.inserted?.some((item: JsonRecord) => item.role === 'user'))
      // stdin is already EOF. The only second prompt can come from the native
      // owner watcher, and one completed run must produce only one such prompt.
      expect(inputs).toHaveLength(2)
      const turns = events.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
      expect(turns).toHaveLength(2)
      expect(inputs[1]!.seq).toBeGreaterThan(turns[0]!.seq)
      const records = jsonLines(await readFile(join(root, 'run.log'), 'utf8'))
        .filter(item => item.session_id === sessionId)
      const results = records.filter(item => item.type === 'result')
      expect(results).toHaveLength(2)
      expect(results.every(item => item.subtype === 'success')).toBe(true)
      expect(results[0]!.result).toContain('WORKFLOW_WAITING')
      // Streamed assistant messages have transport IDs, not persisted DSH
      // message IDs. Native result records delimit the two turns reliably.
      const boundary = records.findIndex(item => item.type === 'result')
      const assistantMessages = (items: JsonRecord[]) => items.filter(item =>
        item.type === 'assistant' && Array.isArray(item.message?.content))
      const callsOf = (items: JsonRecord[]) => assistantMessages(items).flatMap(item =>
        item.message.content.filter((part: JsonRecord) => part.type === 'tool_use')) as JsonRecord[]
      const isLaunch = (call: JsonRecord) => mode === 'mcp'
        ? /workflow_run$/.test(call.name) && call.input?.action === 'start' && call.input?.wait === false
        : call.name.toLowerCase() === 'bash' && call.input?.command?.includes('workflow run workflow:notify-proof --detach')
      expect(callsOf(records).filter(isLaunch)).toHaveLength(1)
      const beforeCalls = callsOf(records.slice(0, boundary))
      const launchIndex = beforeCalls.findIndex(isLaunch)
      expect(launchIndex).toBeGreaterThanOrEqual(0)
      expect(beforeCalls.slice(launchIndex + 1)).toHaveLength(0)
      expect(assistantMessages(records.slice(boundary + 1)).some(item =>
        JSON.stringify(item.message.content).includes('WORKFLOW_OWNER_OK'))).toBe(true)
      // A terminal notification is consumed once and removed from this scope.
      expect((await readdir(join(root, '.matos/runtime/workflow-run-watch'))).filter(name => name.endsWith('.json'))).toHaveLength(0)
      await writeFile(join(root, 'summary.json'), JSON.stringify({
        ok: true, mode, model: 'deepseek-flash', sessionId,
        stdinClosed: true, workflowLaunches: 1, automaticWakeups: 1,
        completedTurns: 2, noPolling: true, mean: computed.mean,
      }, null, 2) + '\n')
      console.log('Native DSH workflow wake evidence: ' + root + '/summary.json')
      if (process.env.MATOS_REAL_TEST_KEEP !== '1') await rm(root, { recursive: true, force: true })
    } catch (error) {
      throw new Error('Real workflow owner evidence retained at ' + root, { cause: error })
    } finally {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      stopGroup(child, 'SIGTERM')
    }
  }, 200_000)
}
